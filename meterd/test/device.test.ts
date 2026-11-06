import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceMeter } from "../src/device";
import { FnnRpcClient } from "../src/fnn";
import type { Gate } from "../src/gate";
import { JsonlLog, MemoryLog } from "../src/log";
import { CHUNK_BYTES, GRACE_MS } from "../src/meter";
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

let mock: MockFnn;
let gate: FakeGate;
let log: MemoryLog;
let nowMs: number;
let meter: DeviceMeter;

beforeEach(async () => {
  mock = await new MockFnn().start();
  gate = new FakeGate();
  log = new MemoryLog();
  nowMs = 1_000;
  meter = new DeviceMeter(
    {
      fnn: new FnnRpcClient(mock.url),
      gate,
      log,
      now: () => nowMs,
      chunkPriceShannons: PRICE,
      deviceSalt: "test-salt",
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
