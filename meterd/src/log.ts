// Append-only JSON-lines log. Schema: ARCHITECTURE.md, "Logging schema".

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { CutReason } from "./meter";

export type LogEvent =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_expired"
  | "invoice_cancelled"
  | "gate_opened"
  | "grace_started"
  | "gate_close_failed"
  | "cut"
  | "session_ended";

// Why a session that was not cut ended (session_ended lines). Unpaid
// sessions are always "cut" lines; these are sessions closed for other reasons.
export type EndReason = "idle" | "shutdown";

export interface LogLine {
  ts: string;
  event: LogEvent;
  device_id: string;
  session_id: string;
  invoice: string | null;
  payment_hash: string | null;
  preimage: string | null;
  hash_algorithm: "sha256" | null;
  amount_shannons: string | null;
  t_invoice_created_ms: number | null;
  t_paid_seen_ms: number | null;
  // H2: on grace_started and cut lines, when usage reached the allowance and
  // (cut only) when the gate close returned.
  t_exhausted_ms: number | null;
  t_gate_closed_ms: number | null;
  bytes_used: number;
  allowance_bytes: number;
  // cut lines: why the device was cut. session_ended lines: an EndReason.
  cutoff_reason: CutReason | EndReason | null;
  // On gate_close_failed lines: what the gate reported.
  error: string | null;
}

// Fields every line must carry; the rest default to null.
export type LogEntry = Pick<LogLine, "event" | "device_id" | "session_id" | "bytes_used" | "allowance_bytes"> &
  Partial<Omit<LogLine, "event" | "device_id" | "session_id" | "bytes_used" | "allowance_bytes">>;

export interface MeterLog {
  write(entry: LogEntry): void;
}

export function toLine(entry: LogEntry): LogLine {
  return {
    invoice: null,
    payment_hash: null,
    preimage: null,
    hash_algorithm: null,
    amount_shannons: null,
    t_invoice_created_ms: null,
    t_paid_seen_ms: null,
    t_exhausted_ms: null,
    t_gate_closed_ms: null,
    cutoff_reason: null,
    error: null,
    ...entry,
    ts: entry.ts ?? new Date().toISOString(),
  };
}

export class JsonlLog implements MeterLog {
  constructor(readonly path: string) {}

  write(entry: LogEntry): void {
    appendFileSync(this.path, JSON.stringify(toLine(entry)) + "\n", { flag: "a" });
  }
}

// One JSONL file per UTC day, <dir>/<prefix>-YYYY-MM-DD.jsonl, chosen by each
// line's own timestamp, so the daily export is just the day's file.
export class DailyJsonlLog implements MeterLog {
  constructor(
    readonly dir: string,
    readonly prefix: string,
  ) {}

  pathFor(ts: string): string {
    return join(this.dir, `${this.prefix}-${ts.slice(0, 10)}.jsonl`);
  }

  write(entry: LogEntry): void {
    const line = toLine(entry);
    appendFileSync(this.pathFor(line.ts), JSON.stringify(line) + "\n", { flag: "a" });
  }
}

// Writes every line to each log in turn, e.g. the JSONL file and the dashboard.
export class TeeLog implements MeterLog {
  private readonly logs: MeterLog[];

  constructor(...logs: MeterLog[]) {
    this.logs = logs;
  }

  write(entry: LogEntry): void {
    for (const log of this.logs) log.write(entry);
  }
}

export class MemoryLog implements MeterLog {
  readonly lines: LogLine[] = [];

  write(entry: LogEntry): void {
    this.lines.push(toLine(entry));
  }
}
