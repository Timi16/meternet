// End-to-end check of the public web MVP's promise: data flows only while
// payments land, and stops within 15 s of the last payment. A browser node
// (through browser-bridge.mjs) plays the user: it downloads a test file from
// the metered gateway, pays every 2 MB invoice meterd issues, stops paying
// after STOP_AFTER_MB, and the script records when the download is cut.
//
//   npm run bridge &          # browser node with a ready channel to the server
//   node scripts/gateway-e2e.mjs
//
// Writes a JSON summary to stdout; meterd's own log on the server is the
// evidence (payment hashes, preimages, t_exhausted_ms, t_gate_closed_ms).

const BASE = process.env.BASE ?? "https://162-35-126-18.sslip.io";
const PAYER_RPC = process.env.PAYER_RPC ?? "http://127.0.0.1:8247";
const FILE = process.env.FILE ?? "files/test-10MB.bin";
const STOP_AFTER_MB = Number(process.env.STOP_AFTER_MB ?? 6);
const MB = 1024 * 1024;

let rpcId = 1;
async function payer(method, params) {
  const res = await fetch(PAYER_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params === undefined ? [] : [params] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function api(path, init) {
  const res = await fetch(BASE + path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const t0 = Date.now();
const at = () => Date.now() - t0;
const { pubkey } = await payer("node_info");
const session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ pubkey }) });
const token = session.token;
console.error(`session ${session.session_id} device ${session.device_id.slice(0, 16)}…`);

// Payer loop, as the demo page will do it: one payment in flight at a time
// (the browser channel takes one unacknowledged TLC at a time, and a second
// fails with WaitingTlcAck). A Failed payment is retried on the same invoice,
// which stays Open. A slow one is waited out: after a reconnect a payment can
// take ~90 s (FIBER_NOTES F-005), and meanwhile the meter's grace and cut run
// as they should.
const SETTLE_WAIT_MS = Number(process.env.SETTLE_WAIT_MS ?? 120_000);
const payments = [];
let stopPaying = false;
let lastPaymentAt = null;
const paid = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settled(hash) {
  const until = Date.now() + SETTLE_WAIT_MS;
  while (Date.now() < until) {
    const { status } = await payer("get_payment", { payment_hash: hash });
    if (status === "Success" || status === "Failed") return status;
    await sleep(200);
  }
  return "still Inflight";
}
const payLoop = (async () => {
  while (!stopPaying) {
    const s = await api(`/api/sessions/${token}/chunk`, { method: "POST" });
    if (s.state === "cut") return;
    if (s.invoice && !paid.has(s.invoice)) {
      paid.add(s.invoice);
      const tSend = Date.now();
      const sentAt = at();
      const p = await payer("send_payment", { invoice: s.invoice });
      const outcome = await settled(p.payment_hash);
      payments.push({ payment_hash: p.payment_hash, sent_at_ms: sentAt, outcome, settle_ms: Date.now() - tSend });
      if (outcome === "Success") lastPaymentAt = sentAt;
      else if (outcome === "Failed") paid.delete(s.invoice); // retry the same invoice
      console.error(`${(at() / 1000).toFixed(1)}s payment ${payments.length} ${p.payment_hash.slice(0, 18)}… ${outcome} in ${Date.now() - tSend} ms`);
      continue;
    }
    await sleep(300);
  }
})();

// Wait until the first payment opens the gate.
for (;;) {
  const s = await api(`/api/sessions/${token}`);
  if (s.gate_open) break;
  if (at() > 60_000) throw new Error("gate never opened");
  await new Promise((r) => setTimeout(r, 200));
}
const gateOpenedAt = at();
console.error(`${(gateOpenedAt / 1000).toFixed(1)}s gate open, downloading ${FILE}`);

// Download, stopping payments once STOP_AFTER_MB have arrived.
let received = 0;
let lastByteAt = null;
let stoppedPayingAt = null;
let outcome;
try {
  const res = await fetch(`${BASE}/gw/${token}/${FILE}`);
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      outcome = "completed";
      break;
    }
    received += value.byteLength;
    lastByteAt = at();
    if (!stopPaying && received >= STOP_AFTER_MB * MB) {
      stopPaying = true;
      stoppedPayingAt = at();
      console.error(`${(at() / 1000).toFixed(1)}s stopped paying at ${(received / MB).toFixed(1)} MB`);
    }
  }
} catch (e) {
  outcome = `cut (${e.cause?.code ?? e.message})`;
}
const endedAt = at();
stopPaying = true;
await payLoop;
console.error(`${(endedAt / 1000).toFixed(1)}s download ${outcome} after ${(received / MB).toFixed(2)} MB`);

// meterd's view: the cut line's t_exhausted_ms -> t_gate_closed_ms.
let mine;
for (let i = 0; i < 40; i++) {
  const dash = await api("/api/dashboard");
  mine = dash.sessions.find((s) => s.session_id === session.session_id);
  if (mine?.status === "cut") break;
  await new Promise((r) => setTimeout(r, 500));
}
const after = await fetch(`${BASE}/gw/${token}/${FILE}`);
await after.body?.cancel();

console.log(
  JSON.stringify(
    {
      session_id: session.session_id,
      file: FILE,
      outcome,
      received_bytes: received,
      payments,
      gate_opened_at_ms: gateOpenedAt,
      stopped_paying_at_ms: stoppedPayingAt,
      last_payment_sent_at_ms: lastPaymentAt,
      last_byte_at_ms: lastByteAt,
      download_ended_at_ms: endedAt,
      data_stopped_after_last_payment_ms: lastPaymentAt === null ? null : lastByteAt - lastPaymentAt,
      ended_after_last_payment_ms: lastPaymentAt === null ? null : endedAt - lastPaymentAt,
      meterd: mine && { status: mine.status, bytes_used: mine.bytes_used, allowance_bytes: mine.allowance_bytes, cut: mine.cut },
      paid_bytes: (mine?.allowance_bytes ?? null),
      unpaid_bytes_received: mine ? Math.max(0, received - mine.allowance_bytes) : null,
      gateway_after_cut_status: after.status,
    },
    null,
    2,
  ),
);
