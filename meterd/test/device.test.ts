import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceMeter, GATE_RETRY_FIRST_MS, GATE_RETRY_MAX_MS } from "../src/device";
import { FnnRpcClient } from "../src/fnn";
import type { Gate } from "../src/gate";
import { DailyJsonlLog, JsonlLog, MemoryLog } from "../src/log";
import { CHUNK_BYTES, CUTOFF_DEADLINE_MS, GRACE_MS } from "../src/meter";
import { MockFnn } from "./mock-fnn";

const MAC = "aa:bb:cc:dd:ee:ff";
const PRICE = 10_000_000n; // 0.1 CKB per chunk

class FakeGate implements Gate {
  readonly calls: string[] = [];
  async open(key: string) {
    this.calls.push(`open ${key}`);
  }
  async close(key: string) {
    this.calls.push(`close ${key}`);
  }
}

// Stands in for setTimeout so tests control when the cut deadline fires.
class FakeScheduler {
  timers: { at: number; fn: () => void; live: boolean }[] = [];
  schedule = (delayMs: number, fn: () => void) => {
    const t = { at: nowMs + delayMs, fn, live: true };
    this.timers.push(t);
    return () => void (t.live = false);
  };
  get armed() {
    return this.timers.filter((t) => t.live);
  }
  // Moves the clock to the next live timer and runs it.
  async fireNext() {
    const t = this.armed.sort((a, b) => a.at - b.at)[0]!;
    t.live = false;
    nowMs = Math.max(nowMs, t.at);
    t.fn();
    await new Promise((r) => setImmediate(r));
  }
}

let mock: MockFnn;
let timers: FakeScheduler;
let gate: FakeGate;
let log: MemoryLog;
let nowMs: number;
let meter: DeviceMeter;

beforeEach(async () => {
  mock = await new MockFnn().start();
  gate = new FakeGate();
  log = new MemoryLog();
  nowMs = 1_000;
  timers = new FakeScheduler();
  meter = new DeviceMeter(
    {
      fnn: new FnnRpcClient(mock.url),
      gate,
      log,
      now: () => nowMs,
      chunkPriceShannons: PRICE,
      deviceSalt: "test-salt",
      schedule: timers.schedule,
    },
    MAC,
  );
});
afterEach(() => mock.stop());

// Pays every invoice the mock has open, then lets meterd see it.
async function payOpenInvoices() {
  for (const [hash, inv] of mock.invoices) if (inv.status === "Open") mock.setStatus(hash, "Paid");
  await meter.poll();
}

describe("DeviceMeter", () => {
  it("issues the first invoice and keeps the gate closed until it is paid", async () => {
    const address = await meter.requestChunk();
    expect(address).toMatch(/^fibtmock/);
    expect(meter.state).toBe("awaiting_payment");
    expect(gate.calls).toEqual([]);

    const created = log.lines.find((l) => l.event === "invoice_created")!;
    expect(created.amount_shannons).toBe("10000000");
    expect(created.preimage).toBeNull();
    expect(mock.requests[0]!.params).toEqual([
      expect.objectContaining({ currency: "Fibt", amount: "0x989680", hash_algorithm: "sha256" }),
    ]);
  });

  it("opens the gate on Paid and logs a preimage that hashes to the payment hash", async () => {
    await meter.requestChunk();
    nowMs = 3_500;
    await payOpenInvoices();

    expect(meter.state).toBe("paid");
    expect(gate.calls).toEqual([`open ${MAC}`]);
    const paid = log.lines.find((l) => l.event === "invoice_paid")!;
    const digest = createHash("sha256").update(Buffer.from(paid.preimage!.slice(2), "hex")).digest("hex");
    expect(paid.payment_hash).toBe("0x" + digest);
    expect(paid.t_invoice_created_ms).toBe(1_000);
    expect(paid.t_paid_seen_ms).toBe(3_500);
    expect(paid.allowance_bytes).toBe(CHUNK_BYTES);
  });

  it("returns the same invoice if asked again before it is paid", async () => {
    const a = await meter.requestChunk();
    const b = await meter.requestChunk();
    expect(b).toBe(a);
    expect(mock.invoices.size).toBe(1);
  });

  it("never reaches grace while the device keeps paying", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    for (let chunk = 1; chunk <= 5; chunk++) {
      meter.usage(chunk * CHUNK_BYTES - CHUNK_BYTES / 2);
      await meter.requestChunk();
      await payOpenInvoices();
      meter.usage(chunk * CHUNK_BYTES);
      expect(meter.state).toBe("paid");
    }
    expect(log.lines.filter((l) => l.event === "invoice_paid")).toHaveLength(6);
    expect(gate.calls).toEqual([`open ${MAC}`]);
  });

  it("cuts the device within 15s of using its allowance, and logs why", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    await meter.tick();
    meter.usage(CHUNK_BYTES);
    expect(meter.state).toBe("grace");

    nowMs += GRACE_MS - 1;
    await meter.tick();
    expect(gate.calls).toEqual([`open ${MAC}`]);

    nowMs += 1;
    await meter.tick();
    expect(meter.state).toBe("cut");
    expect(gate.calls).toEqual([`open ${MAC}`, `close ${MAC}`]);
    const grace = log.lines.find((l) => l.event === "grace_started")!;
    const cut = log.lines.find((l) => l.event === "cut")!;
    expect(cut.cutoff_reason).toBe("grace_expired");
    expect(Date.parse(cut.ts) - Date.parse(grace.ts)).toBeLessThanOrEqual(GRACE_MS);
  });

  it("starts grace when usage is read, even if the last tick was earlier", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    await meter.tick();
    nowMs += 900; // counters arrive between ticks
    meter.usage(CHUNK_BYTES);
    nowMs += GRACE_MS - 1;
    await meter.tick();
    expect(meter.state).toBe("grace");
    nowMs += 1;
    await meter.tick();
    expect(meter.state).toBe("cut");
  });

  it("issues one invoice when the device asks twice at once", async () => {
    const [a, b] = await Promise.all([meter.requestChunk(), meter.requestChunk()]);
    expect(b).toBe(a);
    expect(mock.invoices.size).toBe(1);
  });

  it("credits a payment once when polls overlap", async () => {
    await meter.requestChunk();
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Paid");
    await Promise.all([meter.poll(), meter.poll()]);
    expect(log.lines.filter((l) => l.event === "invoice_paid")).toHaveLength(1);
    expect(gate.calls).toEqual([`open ${MAC}`]);
  });

  it("closes the gate at the grace deadline without waiting for a tick", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    nowMs = 5_000;
    meter.usage(CHUNK_BYTES);
    expect(timers.armed.map((t) => t.at)).toEqual([5_000 + GRACE_MS]);

    await timers.fireNext();
    expect(meter.state).toBe("cut");
    expect(gate.calls).toEqual([`open ${MAC}`, `close ${MAC}`]);
    expect(timers.armed).toEqual([]);
  });

  it("logs exhaustion and gate-closed times, and they are within the 15 s deadline", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    nowMs = 5_000;
    meter.usage(CHUNK_BYTES);
    await timers.fireNext();

    const grace = log.lines.find((l) => l.event === "grace_started")!;
    const cut = log.lines.find((l) => l.event === "cut")!;
    expect(grace.t_exhausted_ms).toBe(5_000);
    expect(cut.t_exhausted_ms).toBe(5_000);
    expect(cut.t_gate_closed_ms).toBe(5_000 + GRACE_MS);
    expect(cut.t_gate_closed_ms! - cut.t_exhausted_ms!).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("writes the cut line only after the gate has actually closed", async () => {
    gate.close = async (key) => {
      nowMs += 700; // e.g. ndsctl deauth takes 700 ms
      gate.calls.push(`close ${key}`);
    };
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    await timers.fireNext();
    const cut = log.lines.find((l) => l.event === "cut")!;
    expect(cut.t_gate_closed_ms! - cut.t_exhausted_ms!).toBe(GRACE_MS + 700);
  });

  it("keeps retrying a failed gate close with backoff, logging each failure", async () => {
    let failures = 2;
    gate.close = async (key) => {
      if (failures-- > 0) throw new Error("ndsctl deauth failed");
      gate.calls.push(`close ${key}`);
    };
    await meter.requestChunk();
    await payOpenInvoices();
    nowMs = 5_000;
    meter.usage(CHUNK_BYTES);
    nowMs += GRACE_MS;
    const cutting = meter.tick();
    await new Promise((r) => setImmediate(r));

    const failed = () => log.lines.filter((l) => l.event === "gate_close_failed");
    expect(failed()).toHaveLength(1);
    expect(failed()[0]!.error).toContain("ndsctl deauth failed");
    expect(log.lines.some((l) => l.event === "cut")).toBe(false);
    expect(timers.armed.map((t) => t.at - nowMs)).toEqual([GATE_RETRY_FIRST_MS]);

    await timers.fireNext(); // 2nd attempt fails, backoff doubles
    expect(failed()).toHaveLength(2);
    expect(timers.armed.map((t) => t.at - nowMs)).toEqual([2 * GATE_RETRY_FIRST_MS]);

    await timers.fireNext(); // 3rd attempt closes
    await cutting;
    expect(gate.calls.at(-1)).toBe(`close ${MAC}`);
    const cut = log.lines.find((l) => l.event === "cut")!;
    expect(cut.t_exhausted_ms).toBe(5_000);
    expect(cut.t_gate_closed_ms).toBe(5_000 + GRACE_MS + 3 * GATE_RETRY_FIRST_MS);
    expect(cut.error).toBeNull();
  });

  it("caps the retry backoff", async () => {
    gate.close = async () => {
      throw new Error("down");
    };
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    nowMs += GRACE_MS;
    void meter.tick();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 12; i++) await timers.fireNext();
    expect(timers.armed.map((t) => t.at - nowMs)).toEqual([GATE_RETRY_MAX_MS]);
  });

  it("disarms the deadline when a payment lands during grace", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    await meter.requestChunk();
    expect(timers.armed).toHaveLength(1);
    await payOpenInvoices();
    expect(meter.state).toBe("paid");
    expect(timers.armed).toEqual([]);
  });

  it("re-arms if the timer fires a little early", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    const [t] = timers.armed;
    t!.live = false;
    nowMs = t!.at - 1; // timer ran 1 ms early
    t!.fn();
    await new Promise((r) => setImmediate(r));
    expect(meter.state).toBe("grace");
    expect(timers.armed.map((x) => x.at)).toEqual([t!.at]);
  });

  it("cuts on time even while an FNN poll is hung", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    await meter.requestChunk();
    mock.hang = true;
    const hungPoll = meter.poll();
    await timers.fireNext();
    expect(meter.state).toBe("cut");
    expect(gate.calls.at(-1)).toBe(`close ${MAC}`);
    mock.hang = false;
    mock.releaseHung();
    await hungPoll;
  });

  it("drops an expired invoice and issues a fresh one", async () => {
    const first = await meter.requestChunk();
    const [hash] = mock.invoices.keys();
    mock.setStatus(hash!, "Expired");
    await meter.poll();
    expect(meter.state).toBe("idle");
    expect(log.lines.some((l) => l.event === "invoice_expired")).toBe(true);
    expect(await meter.requestChunk()).not.toBe(first);
  });

  it("does not open the gate for Received, only for Paid", async () => {
    await meter.requestChunk();
    const [hash] = mock.invoices.keys();
    mock.setStatus(hash!, "Received");
    await meter.poll();
    expect(meter.state).toBe("awaiting_payment");
    expect(gate.calls).toEqual([]);
  });

  it("never writes the raw MAC to the log", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    const text = JSON.stringify(log.lines);
    expect(text).not.toContain(MAC);
    expect(log.lines[0]!.device_id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DeviceMeter, web sessions", () => {
  it("can use a separate gate key while hashing the device ID from the device key", async () => {
    const a = new DeviceMeter(
      { fnn: new FnnRpcClient(mock.url), gate, log, now: () => nowMs, chunkPriceShannons: PRICE, deviceSalt: "test-salt" },
      "web:pubkey",
      "session-a",
    );
    const b = new DeviceMeter(
      { fnn: new FnnRpcClient(mock.url), gate, log, now: () => nowMs, chunkPriceShannons: PRICE, deviceSalt: "test-salt" },
      "web:pubkey",
      "session-b",
    );
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.sessionId).not.toBe(b.sessionId);
    await a.requestChunk();
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Paid");
    await a.poll();
    expect(gate.calls).toEqual(["open session-a"]);
  });

  it("can keep a whole chunk prepaid ahead (prefetchRemainingBytes)", async () => {
    const ahead = new DeviceMeter(
      {
        fnn: new FnnRpcClient(mock.url),
        gate,
        log,
        now: () => nowMs,
        chunkPriceShannons: PRICE,
        deviceSalt: "test-salt",
        prefetchRemainingBytes: CHUNK_BYTES,
      },
      MAC,
    );
    await ahead.requestChunk();
    for (const [hash] of mock.invoices) mock.setStatus(hash, "Paid");
    await ahead.poll();
    // Nothing used yet, but the next invoice is already due.
    expect(await ahead.requestChunk()).not.toBeNull();
    expect(mock.invoices.size).toBe(2);
    // With the default (1 MB left), the same point issues nothing.
    await meter.requestChunk();
    await payOpenInvoices();
    expect(meter.snapshot.pendingInvoices).toHaveLength(0);
    await meter.requestChunk();
    expect(meter.snapshot.pendingInvoices).toHaveLength(0);
  });

  it("exposes a read-only snapshot of the session", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(1234);
    expect(meter.snapshot).toMatchObject({ state: "paid", allowanceBytes: CHUNK_BYTES, usedBytes: 1234 });
  });

  it("end() closes an open gate, disarms the deadline, logs it, and stops the meter", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    expect(timers.armed).toHaveLength(1);

    await meter.end("idle");
    expect(gate.calls).toEqual([`open ${MAC}`, `close ${MAC}`]);
    expect(timers.armed).toHaveLength(0);
    expect(log.lines.at(-1)).toMatchObject({ event: "session_ended", cutoff_reason: "idle" });
    expect(await meter.requestChunk()).toBeNull();
    nowMs += GRACE_MS;
    await meter.tick();
    expect(log.lines.filter((l) => l.event === "cut")).toHaveLength(0);
  });

  it("end() on a cut session logs nothing more", async () => {
    await meter.requestChunk();
    await payOpenInvoices();
    meter.usage(CHUNK_BYTES);
    await timers.fireNext();
    expect(meter.state).toBe("cut");
    const before = log.lines.length;
    await meter.end("idle");
    expect(log.lines.length).toBe(before);
  });
});

describe("JsonlLog", () => {
  it("appends one JSON object per line", () => {
    const file = join(mkdtempSync(join(tmpdir(), "meterd-")), "meterd.jsonl");
    const jsonl = new JsonlLog(file);
    const base = new MemoryLog();
    base.write({ event: "cut", device_id: "d", session_id: "s", bytes_used: 1, allowance_bytes: 0, cutoff_reason: "grace_expired" });
    jsonl.write(base.lines[0]!);
    jsonl.write(base.lines[0]!);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).event).toBe("cut");
  });
});

describe("DailyJsonlLog", () => {
  it("writes each line to the file for its own UTC day", () => {
    const dir = mkdtempSync(join(tmpdir(), "meterd-"));
    const daily = new DailyJsonlLog(dir, "web");
    const line = { event: "gate_opened" as const, device_id: "d", session_id: "s", bytes_used: 0, allowance_bytes: 0 };
    daily.write({ ...line, ts: "2026-11-10T23:59:59.000Z" });
    daily.write({ ...line, ts: "2026-11-11T00:00:00.000Z" });
    daily.write({ ...line, ts: "2026-11-11T08:00:00.000Z" });
    expect(readFileSync(join(dir, "web-2026-11-10.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(1);
    expect(readFileSync(join(dir, "web-2026-11-11.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });
});
