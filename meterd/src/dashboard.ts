// The public dashboard's data: per-session summaries built from the same log
// lines meterd writes to disk, so the dashboard and the published logs can't
// disagree. Device IDs are already hashed; no IPs, tokens, invoices or
// preimages leave this module (preimages are in the published logs).

import { toLine, type LogEntry, type LogLine, type MeterLog } from "./log";
import { CUTOFF_DEADLINE_MS } from "./meter";

export interface PaymentView {
  payment_hash: string;
  paid_at: string;
  invoice_to_paid_ms: number | null;
}

export interface CutView {
  reason: string | null;
  t_exhausted_ms: number | null;
  t_gate_closed_ms: number | null;
  cutoff_ms: number | null;
  within_deadline: boolean | null;
}

export interface SessionView {
  session_id: string;
  device_id: string;
  started_at: string;
  updated_at: string;
  status: "awaiting_payment" | "paid" | "grace" | "cut" | "ended";
  bytes_used: number;
  allowance_bytes: number;
  payments: PaymentView[];
  cut: CutView | null;
  ended_reason: string | null;
}

export interface Totals {
  sessions: number;
  payments: number;
  bytes_used: number;
  cuts: number;
  cuts_within_deadline: number;
}

export interface PublicEvent {
  ts: string;
  event: LogLine["event"];
  device_id: string;
  session_id: string;
  payment_hash: string | null;
  bytes_used: number;
  allowance_bytes: number;
  cutoff_reason: string | null;
  cutoff_ms: number | null;
}

// Live numbers for a session meterd still holds, which move between log lines.
export type LiveLookup = (sessionId: string) => { bytes_used: number; allowance_bytes: number } | undefined;

export class Dashboard implements MeterLog {
  private readonly sessions = new Map<string, SessionView>();
  private readonly listeners = new Set<(e: PublicEvent) => void>();
  private readonly totals: Totals = { sessions: 0, payments: 0, bytes_used: 0, cuts: 0, cuts_within_deadline: 0 };
  live: LiveLookup = () => undefined;

  constructor(private readonly keepSessions = 200) {}

  write(entry: LogEntry): void {
    const l = toLine(entry);
    let s = this.sessions.get(l.session_id);
    if (!s) {
      s = {
        session_id: l.session_id,
        device_id: l.device_id,
        started_at: l.ts,
        updated_at: l.ts,
        status: "awaiting_payment",
        bytes_used: 0,
        allowance_bytes: 0,
        payments: [],
        cut: null,
        ended_reason: null,
      };
      this.sessions.set(l.session_id, s);
      this.totals.sessions++;
      this.evict();
    }
    s.updated_at = l.ts;
    if (l.bytes_used > s.bytes_used) {
      this.totals.bytes_used += l.bytes_used - s.bytes_used;
      s.bytes_used = l.bytes_used;
    }
    s.allowance_bytes = Math.max(s.allowance_bytes, l.allowance_bytes);

    let cutoffMs: number | null = null;
    switch (l.event) {
      case "invoice_paid":
        this.totals.payments++;
        s.payments.push({
          payment_hash: l.payment_hash ?? "",
          paid_at: l.ts,
          invoice_to_paid_ms:
            l.t_paid_seen_ms !== null && l.t_invoice_created_ms !== null
              ? l.t_paid_seen_ms - l.t_invoice_created_ms
              : null,
        });
        if (s.status !== "cut" && s.status !== "ended") s.status = "paid";
        break;
      case "grace_started":
        s.status = "grace";
        break;
      case "cut":
        cutoffMs =
          l.t_gate_closed_ms !== null && l.t_exhausted_ms !== null ? l.t_gate_closed_ms - l.t_exhausted_ms : null;
        s.status = "cut";
        s.cut = {
          reason: l.cutoff_reason,
          t_exhausted_ms: l.t_exhausted_ms,
          t_gate_closed_ms: l.t_gate_closed_ms,
          cutoff_ms: cutoffMs,
          within_deadline: cutoffMs === null ? null : cutoffMs <= CUTOFF_DEADLINE_MS,
        };
        this.totals.cuts++;
        if (cutoffMs !== null && cutoffMs <= CUTOFF_DEADLINE_MS) this.totals.cuts_within_deadline++;
        break;
      case "session_ended":
        s.status = "ended";
        s.ended_reason = l.cutoff_reason;
        break;
    }

    const event: PublicEvent = {
      ts: l.ts,
      event: l.event,
      device_id: l.device_id,
      session_id: l.session_id,
      payment_hash: l.payment_hash,
      bytes_used: l.bytes_used,
      allowance_bytes: l.allowance_bytes,
      cutoff_reason: l.cutoff_reason,
      cutoff_ms: cutoffMs,
    };
    for (const fn of this.listeners) fn(event);
  }

  // Newest session first, with live byte counts for sessions still running.
  view(): { totals: Totals; sessions: SessionView[] } {
    const sessions = [...this.sessions.values()].reverse().map((s) => {
      const live = s.status === "cut" || s.status === "ended" ? undefined : this.live(s.session_id);
      return live ? { ...s, ...live } : { ...s };
    });
    return { totals: { ...this.totals }, sessions };
  }

  // One session's summary, if it is still among the kept ones.
  session(sessionId: string): SessionView | undefined {
    const s = this.sessions.get(sessionId);
    return s && { ...s };
  }

  subscribe(fn: (e: PublicEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private evict(): void {
    while (this.sessions.size > this.keepSessions) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
  }
}
