// The week-3 failure lab, on the real box (openNDS + meterd + FNN, testnet)
// with the simulated phone: 6 scenarios x 3 runs. For each run it drives the
// phone (box/sim/phone.mjs), does the box-side failure itself (uplink drop,
// reboot, channel run dry), then reads the box's own log for that run and
// checks the H2 rule from both sides: the box closed the gate within 15 s of
// the paid data running out, and the phone's last byte arrived within 15 s.
//
//   sudo node box/sim/lab.mjs <out-dir> [scenario numbers, default 1-6] [--runs 3]
//
// Needs: phone-net.sh up, payer.sh start with a ready channel to the box, and
// the box image built (meternet-box:dev). Writes <out-dir>/lab.json and
// <out-dir>/lab.md. Restarts the box container (mn-box) as it goes.

import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX_DATA = process.env.BOX_DATA ?? "/var/lib/meternet-box";
const BOX_ENV = join(BOX_DATA, "box.env");
const IMAGE = process.env.BOX_IMAGE ?? "meternet-box:dev";
const PAYER_RPC = "http://10.42.0.1:8237";
const CUTOFF_DEADLINE_MS = 15_000;

const argv = process.argv.slice(2);
const outDir = argv[0];
if (!outDir) {
  console.error("usage: sudo node box/sim/lab.mjs <out-dir> [1 2 ...] [--runs 3]");
  process.exit(2);
}
const runsIdx = argv.indexOf("--runs");
const RUNS = runsIdx < 0 ? 3 : Number(argv[runsIdx + 1]);
const picked = argv.slice(1).filter((a, i, all) => /^[1-6]$/.test(a) && all[i - 1] !== "--runs").map(Number);
const SCENARIOS = picked.length ? picked : [1, 2, 3, 4, 5, 6];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[lab ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// --- the box ---------------------------------------------------------------

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://10.42.0.1:8400/api/health", { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("box did not come up");
}

async function startBox(extraEnv = {}) {
  try {
    sh("docker", ["rm", "-f", "mn-box"]);
  } catch {}
  const env = Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  sh("docker", [
    "run", "-d", "--name", "mn-box", "--restart", "unless-stopped", "--network", "host",
    "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW", "--env-file", BOX_ENV, ...env,
    "-v", `${BOX_DATA}:/data`, "-v", "/dev/log:/dev/log", IMAGE,
  ]);
  await waitHealthy();
  await sleep(3000); // openNDS's first checks
}

function boxLines(sinceMs, deviceId) {
  const dir = join(BOX_DATA, "logs");
  const lines = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith("box-") && n.endsWith(".jsonl"))) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l) continue;
      const d = JSON.parse(l);
      if (Date.parse(d.ts) >= sinceMs && (!deviceId || d.device_id === deviceId)) lines.push(d);
    }
  }
  return lines.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

async function payerBalanceShannons() {
  const r = await fetch(PAYER_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "list_channels", params: [{}] }),
  });
  const ready = (await r.json()).result.channels.filter((c) => c.state.state_name === "ChannelReady");
  if (!ready.length) throw new Error("payer has no ready channel to the box");
  // All of them: then two chunks at 2/5 of the total fit and a third can't,
  // however the payments are spread across channels.
  return ready.reduce((sum, c) => sum + BigInt(c.local_balance), 0n);
}

// --- the phone ---------------------------------------------------------------

function runPhone(mode, extra, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn("ip", ["netns", "exec", "phone", "node", join(HERE, "phone.mjs"), mode, ...extra], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let buf = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        console.log(`    phone ${line}`);
        onLine?.(line);
      }
    });
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch {
        reject(new Error(`phone exited ${code} without a result`));
      }
    });
  });
}

// --- the scenarios -------------------------------------------------------------

const SIM = join(HERE, "phone-net.sh");
const NAMES = {
  1: "tab closed",
  2: "screen locked",
  3: "uplink dropped",
  4: "box rebooted",
  5: "user stops paying",
  6: "user channel empty",
};

async function scenario(n) {
  const host = {};
  const once = (pattern, fn) => {
    let done = false;
    return (line) => {
      if (!done && pattern.test(line)) {
        done = true;
        fn().catch((e) => (host.error = e.message));
      }
    };
  };
  switch (n) {
    case 1:
      return { phone: await runPhone("tab-closed", ["--mb", "6"]), host };
    case 2:
      return { phone: await runPhone("lock", ["--mb", "6", "--lock-s", "40"]), host };
    case 3: {
      const hook = once(/internet after paying: open/, async () => {
        await sleep(6000);
        sh(SIM, ["uplink", "down"]);
        host.uplink_down_epoch_ms = Date.now();
        say("uplink down for 20 s");
        await sleep(20_000);
        sh(SIM, ["uplink", "up"]);
        host.uplink_up_epoch_ms = Date.now();
        say("uplink up");
      });
      return { phone: await runPhone("steady", ["--mb", "9"], hook), host };
    }
    case 4: {
      const hook = once(/internet after paying: open/, async () => {
        await sleep(6000);
        host.reboot_epoch_ms = Date.now();
        say("rebooting the box");
        sh("docker", ["restart", "mn-box"]);
        await waitHealthy();
        host.back_epoch_ms = Date.now();
        say(`box back after ${host.back_epoch_ms - host.reboot_epoch_ms} ms`);
      });
      return { phone: await runPhone("steady", ["--mb", "8"], hook), host };
    }
    case 5:
      return { phone: await runPhone("stop", ["--mb", "6"]), host };
    case 6: {
      // The channel runs dry mid-session: the chunk price is set so what is
      // left in the phone's channel covers two chunks and not a third. The
      // third payment then fails in FNN for lack of balance, exactly as on a
      // drained channel. Each run leaves a fifth of the balance for the next.
      // (The phone's channels to the box, all of them.)
      const balance = await payerBalanceShannons();
      const price = (balance * 2n) / 5n;
      host.channel_balance_shannons = balance.toString();
      host.chunk_price_shannons = price.toString();
      say(`channel ${Number(balance) / 1e8} CKB; chunk price ${Number(price) / 1e8} CKB for this run`);
      await startBox({ CHUNK_PRICE_SHANNONS: price.toString() });
      return { phone: await runPhone("dry", []), host };
    }
  }
}

function judge(n, phone, host, lines) {
  const cuts = lines.filter((l) => l.event === "cut");
  const paid = lines.filter((l) => l.event === "invoice_paid");
  const cutoffs = cuts.map((c) => c.t_gate_closed_ms - c.t_exhausted_ms);
  const last = cuts.at(-1);
  // When data last crossed the phone's interface, against the box's clock.
  const phoneAfterExhausted = last ? phone.last_wire_byte_epoch_ms - last.t_exhausted_ms : null;
  const checks = {
    blocked_before_paying: phone.blocked_before_paying === true,
    online_after_paying: phone.online_after_paying === true,
    cut: cuts.length > 0,
    box_cut_within_15s: cuts.length > 0 && cutoffs.every((ms) => ms <= CUTOFF_DEADLINE_MS),
    phone_data_stopped_within_15s: phoneAfterExhausted !== null && phoneAfterExhausted <= CUTOFF_DEADLINE_MS,
    blocked_at_end: phone.blocked_at_end === true,
    every_paid_chunk_has_a_preimage: paid.every((l) => typeof l.preimage === "string" && l.preimage.length === 66),
  };
  const stoppedAt = phone.stopped_paying_epoch_ms;
  if (n === 1 || n === 5) checks.not_cut_before_stopping = cuts.every((c) => c.t_gate_closed_ms > stoppedAt);
  if (n === 2) {
    checks.cut_while_locked = cuts.some((c) => c.t_gate_closed_ms > stoppedAt && c.t_gate_closed_ms < (phone.stopped_again_epoch_ms ?? Infinity));
    checks.online_again_after_unlock = phone.online_after_unlock === true;
  }
  if (n === 3) {
    checks.uplink_was_dropped = Boolean(host.uplink_down_epoch_ms && host.uplink_up_epoch_ms);
    checks.not_cut_for_the_uplink = cuts.every((c) => c.t_gate_closed_ms > stoppedAt);
  }
  if (n === 4) {
    checks.box_rebooted = Boolean(host.reboot_epoch_ms && host.back_epoch_ms);
    checks.credit_restored = lines.some((l) => l.event === "session_resumed" && Date.parse(l.ts) > host.reboot_epoch_ms);
    checks.not_cut_for_the_reboot = cuts.every((c) => c.t_gate_closed_ms > stoppedAt);
  }
  if (n === 6) {
    const failed = phone.payments.find((p) => p.status === "Failed");
    checks.a_payment_failed = Boolean(failed);
    checks.cut_after_the_channel_ran_dry = Boolean(failed) && cuts.every((c) => c.t_gate_closed_ms > failed.sent_epoch_ms);
  }
  if (host.error) checks.host_actions_ok = false;
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    payments_ok: phone.payments.filter((p) => p.status === "Success").length,
    payments_failed: phone.payments.filter((p) => p.status === "Failed").length,
    payment_hashes: paid.map((l) => l.payment_hash),
    payment_failures: phone.payments.filter((p) => p.status === "Failed").map((p) => p.error),
    settle_ms: phone.payments.filter((p) => p.status === "Success").map((p) => p.settled_ms),
    cutoffs_ms: cutoffs,
    cutoff_reasons: cuts.map((c) => c.cutoff_reason),
    phone_last_byte_after_exhausted_ms: phoneAfterExhausted,
    phone_app_last_read_after_exhausted_ms: last ? phone.last_byte_epoch_ms - last.t_exhausted_ms : null,
    bytes_used_at_cut: last?.bytes_used ?? null,
    allowance_at_cut: last?.allowance_bytes ?? null,
  };
}

// --- run -------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
sh(SIM, ["renew"]);
const results = [];
await startBox();
for (const n of SCENARIOS) {
  for (let run = 1; run <= RUNS; run++) {
    say(`scenario ${n} (${NAMES[n]}), run ${run}/${RUNS}`);
    const since = Date.now();
    let row;
    try {
      const { phone, host } = await scenario(n);
      await sleep(1500); // the cut line is written just after the close
      const lines = boxLines(since, phone.device_id);
      row = { scenario: n, name: NAMES[n], run, started: new Date(since).toISOString(), ...judge(n, phone, host, lines), host, phone, box_log: lines };
    } catch (e) {
      row = { scenario: n, name: NAMES[n], run, started: new Date(since).toISOString(), pass: false, error: e.message };
    }
    results.push(row);
    say(`  -> ${row.pass ? "PASS" : "FAIL"} ${row.error ?? JSON.stringify(row.checks)} cutoffs ${JSON.stringify(row.cutoffs_ms ?? [])}`);
    writeFileSync(join(outDir, "lab.json"), JSON.stringify(results, null, 2) + "\n");
    await sleep(3000);
  }
  if (n === 6) await startBox(); // back to the normal price
}

const short = (h) => `${h.slice(0, 10)}…`;
const md = [
  "| # | Scenario | Run | Result | Payments (ok / failed) | Exhausted → gate closed (ms) | Phone's last byte after exhausted (ms) | Payment hashes |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map((r) =>
    `| ${r.scenario} | ${r.name} | ${r.run} | ${r.pass ? "pass" : "**FAIL**"}${r.error ? ` (${r.error})` : ""} | ${r.payments_ok ?? "–"} / ${r.payments_failed ?? "–"} | ${(r.cutoffs_ms ?? []).join(", ") || "–"} | ${r.phone_last_byte_after_exhausted_ms ?? "–"} | ${(r.payment_hashes ?? []).map(short).join(" ") || "–"} |`,
  ),
  "",
  `${results.filter((r) => r.pass).length} of ${results.length} runs passed. Full data, including every payment hash and box log line: lab.json.`,
];
writeFileSync(join(outDir, "lab.md"), md.join("\n") + "\n");
say(`done: ${results.filter((r) => r.pass).length}/${results.length} passed; ${join(outDir, "lab.md")}`);
