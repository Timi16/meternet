// Pure per-device meter state machine. No I/O: callers feed events in and
// act on the returned session (e.g. run `ndsctl deauth` when state is "cut").

export const CHUNK_BYTES = 2 * 1024 * 1024;
export const GRACE_MS = 15000;

export type MeterState = "unpaid" | "active" | "grace" | "cut";

export type MeterEvent =
  | { type: "PAYMENT_CONFIRMED" }
  // Cumulative bytes used by the device this session (ndsctl json or iptables).
  | { type: "USAGE_UPDATE"; bytes: number }
  | { type: "TICK"; nowMs: number };

export interface MeterSession {
  readonly state: MeterState;
  readonly allowanceBytes: number;
  readonly usedBytes: number;
  // Last time seen via TICK; used to stamp the start of grace.
  readonly nowMs: number;
  readonly graceStartedAtMs: number | null;
}

export function initialSession(nowMs = 0): MeterSession {
  return {
    state: "unpaid",
    allowanceBytes: 0,
    usedBytes: 0,
    nowMs,
    graceStartedAtMs: null,
  };
}

export function step(s: MeterSession, e: MeterEvent): MeterSession {
  // TODO week 1: decide whether a cut device can pay its way back in.
  if (s.state === "cut") return s;

  switch (e.type) {
    case "PAYMENT_CONFIRMED": {
      const allowanceBytes = s.allowanceBytes + CHUNK_BYTES;
      if (s.usedBytes < allowanceBytes) {
        return { ...s, allowanceBytes, state: "active", graceStartedAtMs: null };
      }
      return { ...s, allowanceBytes };
    }

    case "USAGE_UPDATE": {
      const usedBytes = Math.max(s.usedBytes, e.bytes);
      if (s.state === "active" && usedBytes >= s.allowanceBytes) {
        return { ...s, usedBytes, state: "grace", graceStartedAtMs: s.nowMs };
      }
      return { ...s, usedBytes };
    }

    case "TICK": {
      // TODO week 1: grace -> cut once nowMs - graceStartedAtMs >= GRACE_MS.
      // Deliberately missing at week 0; test/meter.test.ts fails until it lands.
      return { ...s, nowMs: e.nowMs };
    }
  }
}
