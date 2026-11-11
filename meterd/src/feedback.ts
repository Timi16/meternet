// Optional feedback from public web MVP visitors, for the report's user
// feedback summary (the grant's condition). Three answers and an optional
// comment; no IP address, pubkey or token is stored. One JSONL file per UTC
// day, <dir>/feedback-YYYY-MM-DD.jsonl.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

export interface FeedbackEntry {
  ts: string;
  session_id: string | null;
  // 1-5: how clear it was what you were paying for.
  clear: number;
  // 1-5: how smoothly the video or download ran while paying.
  smooth: number;
  would_use: "yes" | "maybe" | "no";
  comment: string | null;
}

export interface FeedbackSink {
  write(entry: FeedbackEntry): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_COMMENT = 500;

// Validates a submitted form; returns the entry to store or an error message.
export function parseFeedback(body: unknown, ts: string): FeedbackEntry | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const score = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? (v as number) : null);
  const clear = score(b.clear);
  const smooth = score(b.smooth);
  if (clear === null || smooth === null) return "clear and smooth must be whole numbers from 1 to 5";
  if (b.would_use !== "yes" && b.would_use !== "maybe" && b.would_use !== "no") return "would_use must be yes, maybe or no";
  let sessionId: string | null = null;
  if (b.session_id !== undefined && b.session_id !== null) {
    if (typeof b.session_id !== "string" || !UUID.test(b.session_id)) return "session_id must be a session UUID";
    sessionId = b.session_id;
  }
  let comment: string | null = null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== "string") return "comment must be text";
    if (b.comment.length > MAX_COMMENT) return `comment must be at most ${MAX_COMMENT} characters`;
    comment = b.comment.trim() || null;
  }
  return { ts, session_id: sessionId, clear, smooth, would_use: b.would_use, comment };
}

export class DailyFeedbackLog implements FeedbackSink {
  constructor(readonly dir: string) {}

  write(entry: FeedbackEntry): void {
    appendFileSync(join(this.dir, `feedback-${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n");
  }
}

export class MemoryFeedbackLog implements FeedbackSink {
  readonly entries: FeedbackEntry[] = [];

  write(entry: FeedbackEntry): void {
    this.entries.push(entry);
  }
}
