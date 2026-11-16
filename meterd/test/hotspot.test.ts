// The hotspot box's sessions: one meter per device on the Wi-Fi, usage read
// from the firewall (openNDS or pf), and paid credit kept across restarts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Firewall } from "../src/firewall";
import { FnnRpcClient } from "../src/fnn";
import { Hotspot, MemoryCreditStore } from "../src/hotspot";
import { MemoryLog } from "../src/log";
import { CHUNK_BYTES, CUTOFF_DEADLINE_MS, GRACE_MS } from "../src/meter";
import { MockFnn } from "./mock-fnn";

const PHONE = { ip: "10.42.0.10", mac: "aa:bb:cc:00:00:01" };
const OTHER = { ip: "10.42.0.11", mac: "aa:bb:cc:00:00:02" };

// Keys by MAC like openNDS. Usage counters are set by the test.
class FakeFirewall implements Firewall {
  readonly present = new Map<string, string>(); // ip -> mac
  readonly open_ = new Set<string>();
  readonly calls: string[] = [];
  counters = new Map<string, number>();
  refuse = new Set<string>(); // keys whose open fails, like ndsctl auth exit 1
  async open(key: string) {
    this.calls.push(`open ${key}`);
    if (this.refuse.has(key)) throw new Error(`ndsctl auth exited 1: Failed to authenticate client ${key}.`);
    this.open_.add(key);
  }
  async close(key: string) {
    this.calls.push(`close ${key}`);
    this.open_.delete(key);
    this.counters.delete(key);
  }
  // Like openNDS and pf: every authenticated client is listed, at 0 until it
  // has used something.
  async usage() {
    return new Map([...this.open_].map((k) => [k, this.counters.get(k) ?? 0]));
  }
  async identify(ip: string) {
    const mac = this.present.get(ip);
    return mac ? { key: mac, mac } : null;
  }
  async clients() {
    return [...this.present.values()].map((mac) => ({ key: mac, mac }));
  }
}

let mock: MockFnn;
let fw: FakeFirewall;
let log: MemoryLog;
let credits: MemoryCreditStore;
let nowMs: number;
let timers: { at: number; fn: () => void; live: boolean }[];

function newHotspot(firewall: Firewall = fw) {
  return new Hotspot({
    meter: {
      fnn: new FnnRpcClient(mock.url),
      log,
      now: () => nowMs,
      chunkPriceShannons: 10_000_000n,
      deviceSalt: "test-salt",
      schedule: (delayMs, fn) => {
        const t = { at: nowMs + delayMs, fn, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    },
    firewall,
    credits,
    now: () => nowMs,
  });
}

async function payAll(h: Hotspot) {
  for (const [hash, inv] of mock.invoices) if (inv.status === "Open") mock.setStatus(hash, "Paid");
  await h.pollInvoices();
}

async function advanceTo(h: Hotspot, untilMs: number) {
  for (;;) {
    const due = timers.filter((t) => t.live && t.at <= untilMs).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.live = false;
    nowMs = Math.max(nowMs, due.at);
    due.fn();
    await new Promise((r) => setImmediate(r));
  }
  nowMs = Math.max(nowMs, untilMs);
  await h.tickAll();
}

beforeEach(async () => {
  mock = await new MockFnn().start();
  fw = new FakeFirewall();
  fw.present.set(PHONE.ip, PHONE.mac);
  fw.present.set(OTHER.ip, OTHER.mac);
  log = new MemoryLog();
  credits = new MemoryCreditStore();
  nowMs = 1_000_000;
  timers = [];
});
afterEach(() => mock.stop());

describe("Hotspot", () => {
  it("lets a phone online only once it has paid", async () => {
    const h = newHotspot();
    const s = await h.nextInvoice(PHONE.ip);
    expect(s.ok && s.view.invoice).toMatch(/^fibtmock/);
    expect(fw.calls).toEqual([]);
    await payAll(h);
    expect(fw.calls).toEqual([`open ${PHONE.mac}`]);
    expect((await h.status(PHONE.ip)).ok && (await h.status(PHONE.ip))).toMatchObject({ view: { state: "paid", gate_open: true } });
  });

  it("refuses an address that isn't a device on the hotspot", async () => {
    const h = newHotspot();
    const r = await h.nextInvoice("203.0.113.9");
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("keeps one session per device: a page reload gets the same one", async () => {
    const h = newHotspot();
    const a = await h.nextInvoice(PHONE.ip);
    const b = await h.nextInvoice(PHONE.ip);
    expect(a.ok && b.ok && a.view.session_id).toBe(b.ok && b.view.session_id);
    expect(mock.invoices.size).toBe(1);
  });

  it("meters from the firewall's counters and cuts within 15 s once paid data runs out", async () => {
    const h = newHotspot();
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    fw.counters.set(PHONE.mac, CHUNK_BYTES);
    await h.pollUsage();
    expect((await h.status(PHONE.ip)).ok && (await h.status(PHONE.ip))).toMatchObject({ view: { state: "grace" } });
    await advanceTo(h, nowMs + GRACE_MS);
    expect(fw.calls.at(-1)).toBe(`close ${PHONE.mac}`);
    const cut = log.lines.find((l) => l.event === "cut")!;
    expect(cut.t_gate_closed_ms! - cut.t_exhausted_ms!).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("doesn't lose usage when the firewall's counter restarts", async () => {
    const h = newHotspot();
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    fw.counters.set(PHONE.mac, 1_000_000);
    await h.pollUsage();
    fw.counters.set(PHONE.mac, 50_000); // e.g. openNDS re-authenticated the client
    await h.pollUsage();
    expect((await h.status(PHONE.ip)).ok && (await h.status(PHONE.ip))).toMatchObject({
      view: { used_bytes: 1_050_000 },
    });
  });

  it("saves each device's unused paid credit, and forgets it once used up", async () => {
    const h = newHotspot();
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    fw.counters.set(PHONE.mac, 500_000);
    await h.pollUsage();
    expect(await credits.load()).toEqual({
      [PHONE.mac]: expect.objectContaining({ allowanceBytes: CHUNK_BYTES, usedBytes: 500_000 }),
    });
    fw.counters.set(PHONE.mac, CHUNK_BYTES);
    await h.pollUsage();
    expect(await credits.load()).toEqual({});
  });

  it("lets a paid phone back in if the firewall logged it out behind the meter's back", async () => {
    const h = newHotspot();
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    fw.counters.set(PHONE.mac, 300_000);
    await h.pollUsage();
    // openNDS idle timeout or restart: the phone is no longer authenticated.
    fw.open_.delete(PHONE.mac);
    fw.counters.set(PHONE.mac, 0);
    await h.pollUsage();
    expect(fw.calls.filter((c) => c === `open ${PHONE.mac}`)).toHaveLength(2);
    // Usage carries on from where it was.
    fw.counters.set(PHONE.mac, 100_000);
    await h.pollUsage();
    const st = await h.status(PHONE.ip);
    expect(st.ok && st.view.used_bytes).toBe(400_000);
  });

  // Seen on the test box: openNDS refused the auth, and the portal still said
  // the gate was open.
  it("never reports a gate open that the firewall refused, keeps metering others, and retries", async () => {
    const h = newHotspot();
    fw.refuse.add(PHONE.mac);
    await h.nextInvoice(PHONE.ip);
    await h.nextInvoice(OTHER.ip);
    await payAll(h);
    const st = await h.status(PHONE.ip);
    expect(st.ok && st.view).toMatchObject({ state: "paid", gate_open: false });
    expect(log.lines.filter((l) => l.event === "gate_open_failed")).toHaveLength(1);
    expect(log.lines.find((l) => l.event === "gate_open_failed")!.error).toMatch(/Failed to authenticate/);

    // The other phone is still metered while this one's open keeps failing.
    fw.counters.set(OTHER.mac, 700_000);
    await h.pollUsage();
    const other = await h.status(OTHER.ip);
    expect(other.ok && other.view.used_bytes).toBe(700_000);
    const tries = () => fw.calls.filter((c) => c === `open ${PHONE.mac}`).length;
    expect(tries()).toBe(2); // the payment's open, then one retry

    await h.pollUsage(); // within 5 s: no retry hammering ndsctl
    expect(tries()).toBe(2);

    fw.refuse.delete(PHONE.mac);
    nowMs += 5_000;
    await h.pollUsage();
    expect(tries()).toBe(3);
    const ok = await h.status(PHONE.ip);
    expect(ok.ok && ok.view.gate_open).toBe(true);
  });

  it("doesn't re-open twice when usage polls overlap (slow ndsctl)", async () => {
    const h = newHotspot();
    fw.refuse.add(PHONE.mac);
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    await Promise.all([h.pollUsage(), h.pollUsage(), h.pollUsage()]);
    expect(fw.calls.filter((c) => c === `open ${PHONE.mac}`)).toHaveLength(2); // payment's open + one retry
  });

  it("closes again if a re-open lands after the cut", async () => {
    const h = newHotspot();
    await h.nextInvoice(PHONE.ip);
    await payAll(h);
    fw.counters.set(PHONE.mac, CHUNK_BYTES);
    await h.pollUsage(); // grace
    fw.open_.delete(PHONE.mac); // firewall dropped it during grace
    let release!: () => void;
    const slowOpen = fw.open.bind(fw);
    fw.open = (key: string) => new Promise<void>((r) => (release = r)).then(() => slowOpen(key));
    const reopening = h.pollUsage(); // re-open in flight
    await new Promise((r) => setImmediate(r));
    await advanceTo(h, nowMs + GRACE_MS); // the cut lands first
    release();
    await reopening;
    expect(fw.open_.has(PHONE.mac)).toBe(false);
    expect(fw.calls.at(-1)).toBe(`close ${PHONE.mac}`);
  });
});
