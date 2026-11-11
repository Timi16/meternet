// meterd's HTTP API (meterd/src/server.ts), same origin.

export interface SessionStatus {
  session_id: string;
  device_id: string;
  state: "idle" | "awaiting_payment" | "paid" | "grace" | "cut";
  allowance_bytes: number;
  used_bytes: number;
  chunk_bytes: number;
  price_shannons: string;
  max_bytes: number;
  capped: boolean;
  gate_open: boolean;
  cut_due_in_ms: number | null;
  cut: { cutoff_ms: number | null; within_deadline: boolean | null } | null;
}

export interface Chunk extends SessionStatus {
  invoice: string | null;
  payment_hash: string | null;
}

export interface NewSession extends SessionStatus {
  token: string;
}

export interface Content {
  files: { path: string; bytes: number }[];
  video: { playlist: string; bytes: number; segments: number } | null;
}

export interface Feedback {
  session_id: string | null;
  clear: number;
  smooth: number;
  would_use: "yes" | "maybe" | "no";
  comment: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  createSession: (pubkey: string) => call<NewSession>("/api/sessions", { method: "POST", body: JSON.stringify({ pubkey }) }),
  status: (token: string) => call<SessionStatus>(`/api/sessions/${token}`),
  chunk: (token: string) => call<Chunk>(`/api/sessions/${token}/chunk`, { method: "POST" }),
  content: () => call<Content>("/api/content"),
  feedback: (f: Feedback) => call<{ ok: true }>("/api/feedback", { method: "POST", body: JSON.stringify(f) }),
};
