import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  CUTOFF_DEADLINE_MS,
  cutDueAtMs,
  GRACE_MS,
  initialSession,
  needsInvoice,
  step,
  type MeterEvent,
  type MeterSession,
} from "../src/meter";

const H1 = "0x01";
const H2 = "0x02";

function run(s: MeterSession, ...events: MeterEvent[]): MeterSession {
  return events.reduce(step, s);
}

// A device that has paid for one chunk at t=1000.
function paidSession(): MeterSession {
  return run(
    initialSession(0),
    { type: "TICK", nowMs: 1_000 },
    { type: "INVOICE_ISSUED", paymentHash: H1 },
    { type: "PAYMENT_CONFIRMED", paymentHash: H1 },
  );
}

describe("meter", () => {
  it("starts idle", () => {
    const s = initialSession();
    expect(s.state).toBe("idle");
    expect(s.allowanceBytes).toBe(0);
    expect(needsInvoice(s)).toBe(true);
  });

  it("moves to awaiting_payment when the first invoice is issued", () => {
    const s = step(initialSession(), { type: "INVOICE_ISSUED", paymentHash: H1 });
    expect(s.state).toBe("awaiting_payment");
    expect(s.pendingInvoices).toEqual([H1]);
    expect(needsInvoice(s)).toBe(false);
  });

  it("returns to idle if the only pending invoice closes unpaid", () => {
    const s = run(
      initialSession(),
      { type: "INVOICE_ISSUED", paymentHash: H1 },
      { type: "INVOICE_CLOSED", paymentHash: H1 },
    );
    expect(s.state).toBe("idle");
    expect(s.pendingInvoices).toEqual([]);
  });

  it("is paid with a 2 MB allowance once an issued invoice is paid", () => {
    const s = paidSession();
    expect(s.state).toBe("paid");
    expect(s.allowanceBytes).toBe(CHUNK_BYTES);
    expect(s.pendingInvoices).toEqual([]);
  });

  it("ignores a payment for an invoice it did not issue", () => {
    const s = step(initialSession(), { type: "PAYMENT_CONFIRMED", paymentHash: H1 });
    expect(s.state).toBe("idle");
    expect(s.allowanceBytes).toBe(0);
  });

  it("asks for the next invoice once half a chunk remains", () => {
    let s = paidSession();
    s = step(s, { type: "USAGE_UPDATE", bytes: CHUNK_BYTES / 2 - 1, nowMs: 1_000 });
    expect(needsInvoice(s)).toBe(false);
    s = step(s, { type: "USAGE_UPDATE", bytes: CHUNK_BYTES / 2, nowMs: 1_000 });
    expect(needsInvoice(s)).toBe(true);
    s = step(s, { type: "INVOICE_ISSUED", paymentHash: H2 });
    expect(s.state).toBe("paid");
    expect(needsInvoice(s)).toBe(false);
  });

  it("enters grace when usage reaches the allowance", () => {
    const s = step(paidSession(), { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_000 });
    expect(s.state).toBe("grace");
    expect(s.graceStartedAtMs).toBe(1_000);
  });

  it("returns to paid if a payment lands during grace", () => {
    const s = run(
      paidSession(),
      { type: "INVOICE_ISSUED", paymentHash: H2 },
      { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_000 },
      { type: "TICK", nowMs: 1_000 + GRACE_MS - 1 },
      { type: "PAYMENT_CONFIRMED", paymentHash: H2 },
      { type: "TICK", nowMs: 1_000 + GRACE_MS },
    );
    expect(s.state).toBe("paid");
    expect(s.allowanceBytes).toBe(2 * CHUNK_BYTES);
    expect(s.graceStartedAtMs).toBeNull();
  });

  it("cuts an unpaid session within 15s after the allowance is used", () => {
    let s = run(paidSession(), { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_000 });
    expect(s.state).toBe("grace");

    s = step(s, { type: "TICK", nowMs: 1_000 + GRACE_MS - 1 });
    expect(s.state).toBe("grace");

    s = step(s, { type: "TICK", nowMs: 1_000 + GRACE_MS });
    expect(s.state).toBe("cut");
    expect(s.cutReason).toBe("grace_expired");
  });

  it("stays cut, even if a late payment lands", () => {
    const s = run(
      paidSession(),
      { type: "INVOICE_ISSUED", paymentHash: H2 },
      { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_000 },
      { type: "TICK", nowMs: 1_000 + GRACE_MS },
      { type: "PAYMENT_CONFIRMED", paymentHash: H2 },
    );
    expect(s.state).toBe("cut");
    expect(needsInvoice(s)).toBe(false);
  });

  it("starts grace at the time of the usage reading, not the last tick", () => {
    const s = step(paidSession(), { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_900 });
    expect(s.graceStartedAtMs).toBe(1_900);
    expect(step(s, { type: "TICK", nowMs: 1_000 + GRACE_MS }).state).toBe("grace");
    expect(step(s, { type: "TICK", nowMs: 1_900 + GRACE_MS }).state).toBe("cut");
  });

  it("budgets grace inside the 15 s cutoff deadline, leaving room to detect and close", () => {
    expect(CUTOFF_DEADLINE_MS).toBe(15_000);
    expect(GRACE_MS + 3_000).toBeLessThanOrEqual(CUTOFF_DEADLINE_MS);
  });

  it("reports when the cut is due, only while in grace", () => {
    const paid = paidSession();
    expect(cutDueAtMs(paid)).toBeNull();
    const grace = step(paid, { type: "USAGE_UPDATE", bytes: CHUNK_BYTES, nowMs: 1_900 });
    expect(cutDueAtMs(grace)).toBe(1_900 + GRACE_MS);
  });

  it("never lets usage counters go backwards", () => {
    const s = run(
      paidSession(),
      { type: "USAGE_UPDATE", bytes: 1_000, nowMs: 1_000 },
      { type: "USAGE_UPDATE", bytes: 10, nowMs: 1_000 },
    );
    expect(s.usedBytes).toBe(1_000);
  });
});
