// The Board: public, live view of every session (meterd's /api/dashboard and
// its server-sent events). No wallet, no fiber-js: it loads instantly.

import { mbText, seconds, shortHash } from "./format";
import { showLed } from "./segments";

interface PaymentView {
  payment_hash: string;
  paid_at: string;
  invoice_to_paid_ms: number | null;
}
interface SessionView {
  session_id: string;
  device_id: string;
  started_at: string;
  updated_at: string;
  status: string;
  bytes_used: number;
  allowance_bytes: number;
  payments: PaymentView[];
  cut: { cutoff_ms: number | null; within_deadline: boolean | null } | null;
  ended_reason: string | null;
}
interface View {
  totals: { sessions: number; payments: number; bytes_used: number; cuts: number; cuts_within_deadline: number };
  sessions: SessionView[];
}
interface PublicEvent {
  ts: string;
  event: string;
  device_id: string;
  session_id: string;
  payment_hash: string | null;
  bytes_used: number;
  cutoff_ms: number | null;
}

const $ = (id: string) => document.getElementById(id)!;
const MAX_FEED = 60;
const seen = new Set<string>();

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

function cell(text: string, cls = ""): HTMLTableCellElement {
  return Object.assign(document.createElement("td"), { textContent: text, className: cls });
}

function render(v: View) {
  const t = v.totals;
  showLed($("t-sessions") as HTMLElement, String(t.sessions).padStart(4, " "));
  showLed($("t-payments") as HTMLElement, String(t.payments).padStart(4, " "));
  showLed($("t-mb") as HTMLElement, (t.bytes_used / 1024 / 1024).toFixed(0).padStart(4, " "));
  showLed($("t-cuts") as HTMLElement, `${t.cuts_within_deadline}`.padStart(4, " "));
  $("t-cuts-label").replaceChildren(`Cuts within 15 s · of ${t.cuts}`, Object.assign(document.createElement("span"), { className: "zh", textContent: "15秒内切断" }));
  $("updated").textContent = `Updated ${time(new Date().toISOString())}`;

  const rows = document.createDocumentFragment();
  for (const s of v.sessions) {
    const tr = document.createElement("tr");
    if (!seen.has(s.session_id + s.status)) tr.className = "fresh";
    seen.add(s.session_id + s.status);
    tr.title = `session ${s.session_id}`;
    tr.appendChild(cell(`${day(s.started_at)} ${time(s.started_at)}`));
    tr.appendChild(cell(`#${s.device_id.slice(0, 8)}`));
    const status = document.createElement("td");
    status.appendChild(
      Object.assign(document.createElement("span"), {
        className: `chip ${s.status}`,
        textContent: s.status === "awaiting_payment" ? "waiting" : s.status === "ended" ? (s.ended_reason ?? "ended") : s.status,
      }),
    );
    tr.appendChild(status);
    tr.appendChild(cell((s.bytes_used / 1024 / 1024).toFixed(1), "num"));
    const pays = cell(String(s.payments.length), "num");
    pays.title = s.payments.map((p) => p.payment_hash).join("\n");
    tr.appendChild(pays);
    const m = median(s.payments.map((p) => p.invoice_to_paid_ms).filter((x): x is number => x !== null));
    tr.appendChild(cell(m === null ? "–" : seconds(m, 2), "num"));
    if (s.cut?.cutoff_ms != null) {
      tr.appendChild(cell(`${s.cut.within_deadline ? "✓" : "✗"} ${seconds(s.cut.cutoff_ms)}`, s.cut.within_deadline ? "ok num" : "bad num"));
    } else {
      tr.appendChild(cell("–", "num"));
    }
    rows.appendChild(tr);
  }
  $("rows").replaceChildren(rows);
}

const EVENT_TEXT: Record<string, (e: PublicEvent) => string> = {
  invoice_paid: (e) => `paid 2 MB · ${shortHash(e.payment_hash ?? "")}`,
  gate_opened: () => "data flowing",
  grace_started: (e) => `paid data used up at ${mbText(e.bytes_used)}`,
  cut: (e) => `CUT${e.cutoff_ms !== null ? ` · ${seconds(e.cutoff_ms)} after paid data ran out` : ""}`,
  session_ended: () => "session ended",
};

function feed(e: PublicEvent) {
  const text = EVENT_TEXT[e.event];
  if (!text) return;
  const li = document.createElement("li");
  li.append(
    Object.assign(document.createElement("span"), { className: "when", textContent: `${time(e.ts)} #${e.device_id.slice(0, 6)} ` }),
    Object.assign(document.createElement("span"), { className: `what ${e.event}`, textContent: text(e) }),
  );
  const list = $("feed");
  list.querySelector(".waiting")?.remove();
  list.prepend(li);
  while (list.children.length > MAX_FEED) list.lastChild!.remove();
}

let pending = false;
async function refresh() {
  if (pending) return;
  pending = true;
  try {
    const res = await fetch("/api/dashboard", { cache: "no-store" });
    if (res.ok) render((await res.json()) as View);
  } catch {
    $("updated").textContent = "Offline. Retrying…";
  } finally {
    pending = false;
  }
}

let soon: ReturnType<typeof setTimeout> | null = null;
const events = new EventSource("/api/dashboard/events");
events.onmessage = (m) => {
  feed(JSON.parse(m.data as string) as PublicEvent);
  if (!soon) soon = setTimeout(() => ((soon = null), void refresh()), 400);
};

void refresh();
setInterval(() => void refresh(), 5000);
