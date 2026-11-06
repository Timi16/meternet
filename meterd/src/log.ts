// Append-only JSON-lines log. Schema: ARCHITECTURE.md, "Logging schema".

import { appendFileSync } from "node:fs";
import type { CutReason } from "./meter";

export type LogEvent =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_expired"
  | "invoice_cancelled"
  | "gate_opened"
  | "grace_started"
  | "cut";

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
  bytes_used: number;
  allowance_bytes: number;
  cutoff_reason: CutReason | null;
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
    cutoff_reason: null,
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

export class MemoryLog implements MeterLog {
  readonly lines: LogLine[] = [];

  write(entry: LogEntry): void {
    this.lines.push(toLine(entry));
  }
}
