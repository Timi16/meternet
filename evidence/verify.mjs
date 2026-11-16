// Checks one week's evidence folder. Node 20+, no dependencies.
//   node evidence/verify.mjs evidence/week-2
// (each week's own verify.mjs runs this on its folder)
// 1. every logged preimage hashes (sha256) to its payment hash
// 2. every channel funding tx in funding-txs.json is committed on CKB testnet
// 3. if the folder has keysend-vs-invoice-trial.jsonl, recomputes its summary
// 4. if the folder has failure-lab runs (lab-*/lab.json), recomputes each
//    run's cutoffs from the box's own log lines (H2: <= 15 s)
// Set CKB_RPC to use a different testnet RPC endpoint.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? process.env.EVIDENCE_DIR ?? ".");
const rpc = process.env.CKB_RPC ?? "https://testnet.ckbapp.dev/";
let failures = 0;
const fail = (msg) => (failures++, console.log(`  FAIL ${msg}`));

const lines = (f) =>
  readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));

console.log("1. preimage -> payment hash");
for (const f of readdirSync(dir).filter((f) => f.endsWith("e2e.jsonl"))) {
  for (const l of lines(f).filter((l) => l.preimage)) {
    const h = "0x" + createHash("sha256").update(Buffer.from(l.preimage.slice(2), "hex")).digest("hex");
    if (l.hash_algorithm !== "sha256") fail(`${f}: unexpected hash_algorithm ${l.hash_algorithm}`);
    else if (h !== l.payment_hash) fail(`${f}: ${l.payment_hash} does not match its preimage`);
    else
      console.log(`  ok   ${f}: ${l.payment_hash} (paid ${l.t_paid_seen_ms - l.t_invoice_created_ms} ms after invoice)`);
  }
}

console.log(`2. funding txs on CKB testnet (${rpc})`);
for (const { channel, tx_hash } of JSON.parse(readFileSync(join(dir, "funding-txs.json"), "utf8"))) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_transaction", params: [tx_hash] }),
  }).then((r) => r.json());
  const status = res.result?.tx_status?.status;
  const cell = res.result?.transaction?.outputs?.[0]?.capacity;
  if (status !== "committed") fail(`${tx_hash}: status ${status}`);
  else console.log(`  ok   ${tx_hash} committed, funding cell ${Number(BigInt(cell)) / 1e8} CKB (${channel})`);
}

if (existsSync(join(dir, "keysend-vs-invoice-trial.jsonl"))) {
  console.log("3. keysend-vs-invoice trial (recomputed)");
  const trial = lines("keysend-vs-invoice-trial.jsonl");
  for (const mode of ["invoice", "keysend"]) {
    const rs = trial.filter((r) => r.mode === mode);
    const ms = rs.filter((r) => r.ok).map((r) => r.ms_box_credit).sort((a, b) => a - b);
    const pct = (p) => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)];
    console.log(
      `  ${mode.padEnd(7)} ok ${ms.length}/${rs.length}, p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${ms.at(-1)} ms, <5s ${ms.filter((x) => x < 5000).length}/${rs.length}`,
    );
  }
}

const labs = readdirSync(dir).filter((d) => /^lab-/.test(d) && existsSync(join(dir, d, "lab.json")));
if (labs.length) {
  console.log("4. failure lab: cutoffs recomputed from the box's log (H2: gate closed <= 15 s after the paid data ran out)");
  for (const d of labs) {
    for (const r of JSON.parse(readFileSync(join(dir, d, "lab.json"), "utf8"))) {
      const cuts = (r.box_log ?? []).filter((l) => l.event === "cut");
      const ms = cuts.map((c) => c.t_gate_closed_ms - c.t_exhausted_ms);
      const tag = `${d} scenario ${r.scenario} (${r.name}) run ${r.run}`;
      const ranOut = (r.box_log ?? []).some((l) => l.event === "grace_started");
      // H2 is about sessions whose paid data ran out; one that never ran out
      // had nothing to cut, and is reported, not counted.
      if (!cuts.length && !ranOut) console.log(`  n/a  ${tag}: paid data never ran out, so no cut was due`);
      else if (!cuts.length) fail(`${tag}: paid data ran out but no cut line`);
      else if (ms.some((x) => x > 15_000)) fail(`${tag}: cutoff ${ms.join(", ")} ms`);
      else console.log(`  ok   ${tag}: ${ms.join(", ")} ms${r.pass ? "" : " (run marked FAIL by the lab: see its checks)"}`);
    }
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
