// Pure per-device meter state machine. No I/O: callers feed events in and
// act on the returned session (e.g. close the gate when state is "cut").

export const CHUNK_BYTES = 2 * 1024 * 1024;
// The proposal's promise: access closes within 15 s of the allowance running
// out. Measured from t_exhausted_ms to t_gate_closed_ms on the cut log line.
export const CUTOFF_DEADLINE_MS = 15_000;
// What the user gets to land a payment. The remaining 3 s of the deadline
// cover detecting expiry and closing the gate (ARCHITECTURE.md, "Cutoff
// budget"); retune from the week-3 failure lab measurements.
export const GRACE_MS = 12_000;
// Ask for the next invoice once this much allowance is left, so a device
// that keeps paying never reaches grace.
export const PREFETCH_REMAINING_BYTES = CHUNK_BYTES / 2;

// idle:             no allowance, no invoice outstanding
// awaiting_payment: first invoice issued, not paid yet (still walled off)
// paid:             usage below the paid allowance
// grace:            allowance used up; a payment has GRACE_MS to land
// cut:              terminal; the gate must be closed
export type MeterState = "idle" | "awaiting_payment" | "paid" | "grace" | "cut";

export type CutReason = "grace_expired";

export type MeterEvent =
  | { type: "INVOICE_ISSUED"; paymentHash: string }
  | { type: "PAYMENT_CONFIRMED"; paymentHash: string }
  // Invoice reached Expired or Cancelled without being paid.
  | { type: "INVOICE_CLOSED"; paymentHash: string }
  // Cumulative bytes used by the device this session, read at nowMs.
  | { type: "USAGE_UPDATE"; bytes: number; nowMs: number }
  | { type: "TICK"; nowMs: number };

export interface MeterSession {
  readonly state: MeterState;
  readonly allowanceBytes: number;
  readonly usedBytes: number;
  readonly pendingInvoices: readonly string[];
  // Last time seen via TICK or USAGE_UPDATE.
  readonly nowMs: number;
  readonly graceStartedAtMs: number | null;
  readonly cutReason: CutReason | null;
}

export function initialSession(nowMs = 0): MeterSession {
  return {
    state: "idle",
    allowanceBytes: 0,
    usedBytes: 0,
    pendingInvoices: [],
    nowMs,
    graceStartedAtMs: null,
    cutReason: null,
  };
}

export function needsInvoice(s: MeterSession): boolean {
  if (s.state === "cut" || s.pendingInvoices.length > 0) return false;
  return s.state === "idle" || s.allowanceBytes - s.usedBytes <= PREFETCH_REMAINING_BYTES;
}

// When grace runs out, so the caller can schedule the cut exactly; null
// unless the session is in grace.
export function cutDueAtMs(s: MeterSession): number | null {
  return s.state === "grace" && s.graceStartedAtMs !== null ? s.graceStartedAtMs + GRACE_MS : null;
}

export function step(s: MeterSession, e: MeterEvent): MeterSession {
  // A cut device stays cut; reconnecting means a new session.
  if (s.state === "cut") return s;

  switch (e.type) {
    case "INVOICE_ISSUED": {
      const pendingInvoices = [...s.pendingInvoices, e.paymentHash];
      const state = s.state === "idle" ? "awaiting_payment" : s.state;
      return { ...s, pendingInvoices, state };
    }

    case "PAYMENT_CONFIRMED": {
      if (!s.pendingInvoices.includes(e.paymentHash)) return s;
      const pendingInvoices = s.pendingInvoices.filter((h) => h !== e.paymentHash);
      const allowanceBytes = s.allowanceBytes + CHUNK_BYTES;
      if (s.usedBytes < allowanceBytes) {
        return { ...s, pendingInvoices, allowanceBytes, state: "paid", graceStartedAtMs: null };
      }
      return { ...s, pendingInvoices, allowanceBytes };
    }

    case "INVOICE_CLOSED": {
      const pendingInvoices = s.pendingInvoices.filter((h) => h !== e.paymentHash);
      const state =
        s.state === "awaiting_payment" && pendingInvoices.length === 0 ? "idle" : s.state;
      return { ...s, pendingInvoices, state };
    }

    case "USAGE_UPDATE": {
      const usedBytes = Math.max(s.usedBytes, e.bytes);
      const nowMs = Math.max(s.nowMs, e.nowMs);
      // Grace starts when the counter shows the allowance used up, not at the
      // last TICK, which could be up to one tick interval earlier.
      if (s.state === "paid" && usedBytes >= s.allowanceBytes) {
        return { ...s, usedBytes, nowMs, state: "grace", graceStartedAtMs: nowMs };
      }
      return { ...s, usedBytes, nowMs };
    }

    case "TICK": {
      const next = { ...s, nowMs: e.nowMs };
      if (
        s.state === "grace" &&
        s.graceStartedAtMs !== null &&
        e.nowMs - s.graceStartedAtMs >= GRACE_MS
      ) {
        return { ...next, state: "cut", cutReason: "grace_expired" };
      }
      return next;
    }
  }
}
