// Plays a phone on the hotspot, from inside the "phone" network namespace
// (box/sim/phone-net.sh), against the real box: openNDS + meterd + FNN.
// Its wallet is box/sim/payer.sh's FNN, standing in for the browser node:
// it pays each invoice the portal hands out, the way the page does.
//
//   sudo ip netns exec phone node box/sim/phone.mjs <mode> [--mb 6] [--lock-s 40]
//
// Modes (the failure lab's scenarios, as the phone lives them):
//   stop        pay while browsing; at --mb MB stop paying, page still open   (5)
//   tab-closed  at --mb MB the tab closes: no payments, no portal calls;
//               the phone's other apps keep using data                        (1)
//   lock        at --mb MB the screen locks for --lock-s s (page frozen, data
//               keeps flowing); then it unlocks, pays again, and stops        (2)
//   steady      pay while browsing until --mb MB, then stop; for the box-side
//               scenarios (uplink dropped, box rebooted) the lab runs         (3, 4)
//   dry         pay until the wallet can't: the channel runs out             (6)
//
// Browsing is one long download at a phone-like rate, restarted after any
// error, like an app retrying. Prints one JSON line with epoch timestamps
// (same clock as the box's log on this machine); progress on stderr.
// "Data stopped" is measured on the phone's interface (rx_bytes), not by the
// app's reads, which lag behind what is already in the TCP buffer.

import { readFileSync } from "node:fs";

const BOX = process.env.BOX ?? "http://10.42.0.1:8400";
const WALLET = process.env.WALLET ?? "http://10.42.0.1:8237";
// A public speed-test file. (speed.cloudflare.com answered 429 after a day of
// lab runs, so the phone never downloaded anything.)
const TARGET = process.env.TARGET ?? "https://ash-speed.hetzner.com/100MB.bin";
const RATE = Number(process.env.RATE_BYTES_PER_SEC ?? 256 * 1024); // a phone on 4G, roughly
const QUIET_END_MS = 10_000; // data has stopped once nothing arrived for this long
const MAX_RUN_MS = 240_000;

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : Number(args[i + 1]);
};
const MB = 1024 * 1024;
const STOP_AT = flag("--mb", 6) * MB;
const LOCK_MS = flag("--lock-s", 40) * 1000;
if (!["stop", "tab-closed", "lock", "steady", "dry"].includes(mode)) {
  console.error("usage: phone.mjs stop|tab-closed|lock|steady|dry [--mb N] [--lock-s S]");
  process.exit(2);
}

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.error(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const out = { mode, started_epoch_ms: t0, payments: [], events: [] };
const mark = (what) => {
  out.events.push({ what, epoch_ms: Date.now() });
  say(what);
};

let boxState = null; // the box's last word on this phone's session
async function box(path, method = "GET") {
  try {
    const res = await fetch(BOX + path, { method, signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    if (body.device_id) out.device_id = body.device_id;
    if (body.state) boxState = body.state;
    // After a cut the page's next request starts a fresh session, so the
    // box's state moves on; remember that the cut was seen.
    if (body.state === "cut") out.cut_seen = true;
    return { status: res.status, body };
  } catch {
    return { status: 0, body: {} }; // box restarting, say
  }
}

let rpcId = 1;
async function wallet(method, params) {
  const res = await fetch(WALLET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: [params] }),
    signal: AbortSignal.timeout(10_000),
  });
  const b = await res.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}

// Any HTTP answer from outside means the phone is online (a 429 from a busy
// server is still the internet); a cut phone gets no answer at all.
async function internetWorks() {
  try {
    const r = await fetch(TARGET, { headers: { range: "bytes=0-999" }, signal: AbortSignal.timeout(6000) });
    await r.arrayBuffer();
    return r.status > 0;
  } catch {
    return false;
  }
}

// --- the page: pays each invoice it's given, while `paying` -----------------
let paying = true;
let pageAlive = true; // false once the tab is closed
let frozen = false; // screen locked: the page's timers don't run
const settled = new Set();
const failedOnce = new Set();
const page = (async () => {
  while (pageAlive) {
    if (!paying || frozen) {
      await sleep(250);
      continue;
    }
    const { status, body } = await box("/api/hotspot/chunk", "POST");
    if (status !== 200 || !body.invoice || settled.has(body.invoice)) {
      await sleep(status === 200 ? 300 : 1000);
      continue;
    }
    const sentAt = Date.now();
    let hash = null;
    let st = "Failed";
    let error = null;
    try {
      hash = (await wallet("send_payment", { invoice: body.invoice })).payment_hash;
      for (let i = 0; i < 300; i++) {
        await sleep(200);
        const p = await wallet("get_payment", { payment_hash: hash });
        st = p.status;
        if (st === "Success" || st === "Failed") {
          error = p.failed_error ?? null;
          break;
        }
      }
    } catch (e) {
      error = e.message;
    }
    if (st === "Success") {
      settled.add(body.invoice);
      out.payments.push({ payment_hash: hash, sent_epoch_ms: sentAt, settled_ms: Date.now() - sentAt, status: st });
      say(`paid chunk ${out.payments.filter((p) => p.status === "Success").length} in ${Date.now() - sentAt} ms`);
    } else {
      // Record each invoice's first failure; the page keeps retrying.
      if (!failedOnce.has(body.invoice)) {
        failedOnce.add(body.invoice);
        out.payments.push({ payment_hash: hash ?? body.payment_hash, sent_epoch_ms: sentAt, status: "Failed", error });
        mark(`payment failed: ${error}`);
      }
      await sleep(2000);
    }
  }
})();

// --- the phone's apps: one download at a phone-like rate, retried -----------
let received = 0;
let lastByteAt = Date.now();
let browsing = true;
let lastDownloadError = null;
const apps = (async () => {
  const start = Date.now();
  while (browsing) {
    // A read that waits 5 s means the connection is dead (cut, or uplink
    // down): start again. Pausing to keep the phone's rate doesn't count.
    const ctl = new AbortController();
    let waitingSince = Date.now();
    const stall = setInterval(() => waitingSince && Date.now() - waitingSince > 5000 && ctl.abort(), 1000);
    try {
      const r = await fetch(TARGET, { signal: ctl.signal });
      if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
      const reader = r.body.getReader();
      while (browsing) {
        waitingSince = Date.now();
        const { done, value } = await reader.read();
        waitingSince = 0;
        if (done) break;
        received += value.byteLength;
        lastByteAt = Date.now();
        onProgress();
        const ahead = received / RATE - (Date.now() - start) / 1000;
        if (ahead > 0) await sleep(ahead * 1000);
      }
    } catch (e) {
      // Cut off, or the uplink is down: try again. Logged once per kind.
      const why = e.message === "This operation was aborted" ? "stalled" : String(e.cause?.code ?? e.message);
      if (why !== lastDownloadError) say(`download: ${why}; retrying`);
      lastDownloadError = why;
      await sleep(1000);
    } finally {
      clearInterval(stall);
    }
  }
})();

// When data last crossed the phone's network interface. The app's own last
// read can be seconds later: bytes that arrived before a cut wait in the TCP
// receive buffer while the phone paces itself. A second with more than
// 32 KiB received counts as data flowing (portal polls are far smaller).
const RX = "/sys/class/net/mn-phone/statistics/rx_bytes";
let lastWireAt = Date.now();
let rxPrev = Number(readFileSync(RX, "utf8"));
const wire = setInterval(() => {
  const rx = Number(readFileSync(RX, "utf8"));
  if (rx - rxPrev > 32 * 1024) lastWireAt = Date.now();
  rxPrev = rx;
}, 1000);

let stage = "paying";
function onProgress() {
  if (stage !== "paying" || received < STOP_AT || mode === "dry") return;
  if (mode === "stop" || mode === "steady") {
    paying = false;
    stage = "stopped";
    out.stopped_paying_epoch_ms = Date.now();
    mark(`stopped paying at ${(received / MB).toFixed(1)} MB`);
  } else if (mode === "tab-closed") {
    paying = false;
    pageAlive = false;
    stage = "stopped";
    out.stopped_paying_epoch_ms = Date.now();
    mark(`tab closed at ${(received / MB).toFixed(1)} MB`);
  } else if (mode === "lock") {
    frozen = true;
    stage = "locked";
    out.stopped_paying_epoch_ms = Date.now();
    mark(`screen locked at ${(received / MB).toFixed(1)} MB`);
    setTimeout(async () => {
      frozen = false;
      mark("screen unlocked");
      for (let i = 0; i < 20 && !(await box("/api/hotspot/status")).body.gate_open; i++) await sleep(1000);
      out.online_after_unlock = await internetWorks();
      mark(`online after unlock: ${out.online_after_unlock}`);
      paying = false;
      stage = "stopped";
      lastWireAt = Date.now(); // wait for this second stretch of data to end too
      out.stopped_again_epoch_ms = Date.now();
      mark("stopped paying");
    }, LOCK_MS);
  }
}

// --- the run -------------------------------------------------------------------
out.blocked_before_paying = !(await internetWorks());
mark(`internet before paying: ${out.blocked_before_paying ? "blocked" : "OPEN"}`);
for (let i = 0; i < 60 && !(await box("/api/hotspot/status")).body.gate_open; i++) await sleep(500);
out.online_after_paying = await internetWorks();
mark(`internet after paying: ${out.online_after_paying ? "open" : "BLOCKED"}`);

const firstFailure = () => out.payments.find((p) => p.status === "Failed");
while (Date.now() - t0 < MAX_RUN_MS) {
  await sleep(500);
  if (pageAlive && (stage === "stopped" || mode === "dry")) await box("/api/hotspot/status"); // the open page polls
  const ended = stage === "stopped" || (mode === "dry" && firstFailure());
  // An open page waits for the box's cut; a closed tab can only watch the wire.
  const cutSeen = !pageAlive || out.cut_seen === true;
  if (ended && cutSeen && Date.now() - lastWireAt > QUIET_END_MS) break;
}
browsing = false;
paying = false;
pageAlive = false;
await Promise.race([apps, sleep(3000)]);
await page;
clearInterval(wire);
out.received_bytes = received;
out.last_byte_epoch_ms = lastByteAt; // the app's last read
out.last_wire_byte_epoch_ms = lastWireAt; // data last crossing the interface
out.blocked_at_end = !(await internetWorks());
out.box_state_at_end = (await box("/api/hotspot/status")).body.state ?? null;
mark(`internet at the end: ${out.blocked_at_end ? "blocked" : "OPEN"} (box: ${out.box_state_at_end})`);
console.log(JSON.stringify(out));
process.exit(0);
