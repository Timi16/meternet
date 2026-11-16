// The week-3 failure lab's six scenarios (locked proposal, section 6), as the
// meter sees them on the hotspot box, against the mocked FNN. The same six
// are then run 3 times each on real hardware with a phone; this file is the
// "all 6 scenarios covered in npm test" part.
//
// The pass rule for every unpaid case is H2: access closes within 15 s of the
// paid allowance running out (t_gate_closed_ms - t_exhausted_ms <= 15000),
// and the box never cuts someone off for its own failure.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceMeter } from "../src/device";
import { FnnRpcClient } from "../src/fnn";
import type { Gate } from "../src/gate";
import { MemoryLog } from "../src/log";
import { CHUNK_BYTES, CUTOFF_DEADLINE_MS, GRACE_MS } from "../src/meter";
import type { Firewall } from "../src/firewall";
import { Hotspot, MemoryCreditStore } from "../src/hotspot";
import { MockFnn } from "./mock-fnn";

const PHONE_IP = "10.42.0.10";

// The box's firewall in scenario 4: one phone, which can be absent (before
// it rejoins the Wi-Fi after the reboot).
class RebootFirewall implements Firewall {
  present = true;
  readonly opened: string[] = [];
  readonly counters = new Map<string, number>();
  async open(key: string) {
    this.opened.push(key);
  }
  async close() {}
  // Like openNDS and pf: every authenticated client is listed, at 0 until it
  // has used something.
  async usage() {
    return new Map(this.opened.map((k) => [k, this.counters.get(k) ?? 0]));
  }
  async identify(ip: string) {
    return this.present && ip === PHONE_IP ? { key: MAC, mac: MAC } : null;
  }
  async clients() {
    return this.present ? [{ key: MAC, mac: MAC }] : [];
  }
}

function rebootHotspot(firewall: Firewall, credits: MemoryCreditStore) {
  return new Hotspot({
    meter: { fnn: new FnnRpcClient(mock.url), log, now: () => nowMs, chunkPriceShannons: PRICE, deviceSalt: "test-salt" },
    firewall,
    credits,
    now: () => nowMs,
  });
}

const MAC = "aa:bb:cc:dd:ee:01";
const PRICE = 10_000_000n;

class FakeGate implements Gate {
  readonly calls: string[] = [];
  async open(key: string) {
    this.calls.push(`open ${key}`);
  }
  async close(key: string) {
    this.calls.push(`close ${key}`);
  }
  get isOpen() {
    return this.calls.at(-1)?.startsWith("open") ?? false;
  }
}

let nowMs: number;
let timers: { at: number; fn: () => void; live: boolean }[];
let mock: MockFnn;
let gate: FakeGate;
let log: MemoryLog;
let meter: DeviceMeter;

// Runs every armed timer that is due by `untilMs`, advancing the clock.
async function advanceTo(untilMs: number) {
  for (;;) {
    const due = timers.filter((t) => t.live && t.at <= untilMs).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.live = false;
    nowMs = Math.max(nowMs, due.at);
    due.fn();
    await new Promise((r) => setImmediate(r));
  }
  nowMs = Math.max(nowMs, untilMs);
  await meter.tick();
}

// The phone pays every invoice meterd has open, and meterd sees it.
async function phonePays() {
  await meter.requestChunk();
  for (const [hash, inv] of mock.invoices) if (inv.status === "Open") mock.setStatus(hash, "Paid");
  await meter.poll();
}

// The phone browses: its usage counter (from `ndsctl json`) rises.
let used = 0;
function phoneUses(bytes: number) {
  used += bytes;
  meter.usage(used);
}

// H2 for the session: from exhaustion to the gate actually closing.
function cutLine() {
  const cut = log.lines.find((l) => l.event === "cut");
  return cut && { ...cut, cutoffMs: cut.t_gate_closed_ms! - cut.t_exhausted_ms! };
}

beforeEach(async () => {
  nowMs = 1_000_000;
  used = 0;
  timers = [];
  mock = await new MockFnn().start();
  gate = new FakeGate();
  log = new MemoryLog();
  meter = new DeviceMeter(
    {
      fnn: new FnnRpcClient(mock.url),
      gate,
      log,
      now: () => nowMs,
      chunkPriceShannons: PRICE,
      deviceSalt: "test-salt",
      schedule: (delayMs, fn) => {
        const t = { at: nowMs + delayMs, fn, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    },
    MAC,
  );
});
afterEach(() => mock.stop());

describe("failure lab: the six scenarios", () => {
  it("1. tab closed: payments stop while the phone keeps browsing, and it is cut within 15 s", async () => {
    await phonePays(); // first 2 MB
    await phonePays(); // prefetched next chunk, then the tab closes
    expect(gate.isOpen).toBe(true);

    // The tab is gone: no more payments. The phone's apps keep using data.
    phoneUses(2 * CHUNK_BYTES);
    expect(meter.state).toBe("grace");
    await advanceTo(nowMs + GRACE_MS);

    expect(meter.state).toBe("cut");
    expect(gate.isOpen).toBe(false);
    expect(cutLine()!.cutoffMs).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
    expect(cutLine()!.cutoff_reason).toBe("grace_expired");
  });

  it("2a. screen locked past grace: the paused page stops paying and the phone is cut within 15 s", async () => {
    await phonePays();
    // Locked: the browser suspends the page's timers, so nothing is paid.
    // Background traffic (sync, push) keeps counting.
    phoneUses(CHUNK_BYTES);
    await advanceTo(nowMs + 60_000);
    expect(meter.state).toBe("cut");
    expect(cutLine()!.cutoffMs).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("2b. screen unlocked within grace: the next payment lands and the phone stays online", async () => {
    await phonePays();
    phoneUses(CHUNK_BYTES);
    expect(meter.state).toBe("grace");
    await advanceTo(nowMs + GRACE_MS - 2_000);
    await phonePays(); // unlocked: the page catches up
    expect(meter.state).toBe("paid");
    await advanceTo(nowMs + 60_000);
    expect(meter.state).toBe("paid");
    expect(gate.calls).toEqual([`open ${MAC}`]);
  });

  it("3. uplink dropped: no data flows, so a paid phone is never cut for the box's failure", async () => {
    await phonePays();
    phoneUses(CHUNK_BYTES * 0.6); // past the prefetch point: the next invoice is out
    expect(await meter.requestChunk()).not.toBeNull();
    // The box's 4G drops: the phone can't use data, its counter freezes, and
    // FNN can't be reached while things recover. Polls fail loudly...
    mock.down = true;
    await expect(meter.poll()).rejects.toThrow();
    // ...but nothing is cut: the phone still has paid data it can't use.
    await advanceTo(nowMs + 10 * 60_000);
    expect(meter.state).toBe("paid");
    expect(gate.isOpen).toBe(true);
    expect(log.lines.some((l) => l.event === "cut")).toBe(false);

    // The uplink comes back; the outstanding invoice is paid and metering
    // carries on where it was.
    mock.down = false;
    await phonePays();
    expect(meter.state).toBe("paid");
    expect(meter.snapshot.allowanceBytes).toBe(2 * CHUNK_BYTES);
  });

  it("3b. an unreachable FNN never delays a cut that is due", async () => {
    await phonePays();
    phoneUses(CHUNK_BYTES);
    expect(await meter.requestChunk()).not.toBeNull(); // next invoice is out
    mock.down = true;
    await expect(meter.poll()).rejects.toThrow();
    await advanceTo(nowMs + GRACE_MS);
    expect(meter.state).toBe("cut");
    expect(cutLine()!.cutoffMs).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("4. box rebooted: a paid-but-unused allowance survives the restart and the phone is let back in", async () => {
    // Before the reboot: the phone paid for 2 MB and used 0.5 MB of it.
    const credits = new MemoryCreditStore();
    const fw = new RebootFirewall();
    const box1 = rebootHotspot(fw, credits);
    await box1.nextInvoice(PHONE_IP);
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Paid");
    await box1.pollInvoices();
    fw.counters.set(MAC, CHUNK_BYTES / 4);
    await box1.pollUsage();

    // Reboot: meterd and the firewall start empty; nobody is authenticated.
    const fw2 = new RebootFirewall();
    fw2.present = false; // the phone hasn't rejoined yet
    const box2 = rebootHotspot(fw2, credits);
    await box2.start();
    expect(fw2.opened).toEqual([]);

    // The phone rejoins the Wi-Fi: it is let back in without paying again,
    // with the same credit, and metering carries on from where it was.
    fw2.present = true;
    await box2.pollUsage();
    expect(fw2.opened).toEqual([MAC]);
    fw2.counters.set(MAC, CHUNK_BYTES / 4); // the new counter starts at 0
    await box2.pollUsage();
    const st = await box2.status(PHONE_IP);
    expect(st.ok && st.view).toMatchObject({ state: "paid", allowance_bytes: CHUNK_BYTES, used_bytes: CHUNK_BYTES / 2 });
    expect(log.lines.some((l) => l.event === "session_resumed")).toBe(true);
    expect(log.lines.filter((l) => l.event === "invoice_paid")).toHaveLength(1);
  });

  it("4b. box rebooted, and the page asks for its next chunk before the box has seen the phone: no double charge", async () => {
    const credits = new MemoryCreditStore();
    const fw = new RebootFirewall();
    const box1 = rebootHotspot(fw, credits);
    await box1.nextInvoice(PHONE_IP);
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Paid");
    await box1.pollInvoices();
    fw.counters.set(MAC, CHUNK_BYTES / 4);
    await box1.pollUsage();

    const fw2 = new RebootFirewall();
    const box2 = rebootHotspot(fw2, credits);
    await box2.start();
    const r = await box2.nextInvoice(PHONE_IP); // the page retries first
    expect(r.ok && r.view).toMatchObject({ state: "paid", allowance_bytes: CHUNK_BYTES, invoice: null });
    expect(fw2.opened).toEqual([MAC]);
    expect(mock.invoices.size).toBe(1);
  });

  it("5. user stops paying: cut within 15 s of the paid data running out, never earlier", async () => {
    await phonePays();
    phoneUses(CHUNK_BYTES - 1);
    await advanceTo(nowMs + 5 * 60_000);
    expect(meter.state).toBe("paid"); // 1 byte left: not cut, however long it waits

    phoneUses(1);
    const exhaustedAt = nowMs;
    await advanceTo(nowMs + GRACE_MS - 1);
    expect(meter.state).toBe("grace");
    await advanceTo(nowMs + 1);
    expect(meter.state).toBe("cut");
    expect(cutLine()!.t_exhausted_ms).toBe(exhaustedAt);
    expect(cutLine()!.cutoffMs).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("6a. user channel empty from the start: the invoice is never paid and the phone never gets online", async () => {
    await meter.requestChunk();
    // send_payment fails on the phone (no balance); the invoice stays Open
    // until it expires.
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Expired");
    await meter.poll();
    await advanceTo(nowMs + 10 * 60_000);
    expect(meter.state).toBe("idle");
    expect(gate.calls).toEqual([]);
    expect(log.lines.filter((l) => l.event === "invoice_paid")).toHaveLength(0);
  });

  it("6b. user channel runs dry mid-session: the next payment can't be made and the phone is cut within 15 s", async () => {
    await phonePays();
    await meter.requestChunk(); // next invoice is issued, but the channel is empty
    phoneUses(CHUNK_BYTES);
    await meter.poll(); // still Open
    await advanceTo(nowMs + GRACE_MS);
    expect(meter.state).toBe("cut");
    expect(cutLine()!.cutoffMs).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
    expect(log.lines.filter((l) => l.event === "invoice_paid")).toHaveLength(1);
  });
});
