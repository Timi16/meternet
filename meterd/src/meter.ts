// Pure per-device meter state machine. No I/O: callers feed events in and
// act on the returned session (e.g. close the gate when state is "cut").

export const CHUNK_BYTES = 2 * 1024 * 1024;
export const GRACE_MS = 15000;
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
  // Cumulative bytes used by the device this session.
  | { type: "USAGE_UPDATE"; bytes: number }
  | { type: "TICK"; nowMs: number };

export interface MeterSession {
  readonly state: MeterState;
  readonly allowanceBytes: number;
  readonly usedBytes: number;
  readonly pendingInvoices: readonly string[];
  // Last time seen via TICK; used to stamp the start of grace.
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
      if (s.state === "paid" && usedBytes >= s.allowanceBytes) {
        return { ...s, usedBytes, state: "grace", graceStartedAtMs: s.nowMs };
      }
      return { ...s, usedBytes };
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
