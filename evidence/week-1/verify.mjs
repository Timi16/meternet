// Checks the week-1 evidence in this folder. Node 20+, no dependencies.
//   node evidence/week-1/verify.mjs
// 1. every logged preimage hashes (sha256) to its payment hash
// 2. every channel funding tx is committed on CKB testnet
// 3. recomputes the keysend-vs-invoice trial summary from the raw lines
// Set CKB_RPC to use a different testnet RPC endpoint. The checks live in
// ../verify.mjs, shared by every week.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.EVIDENCE_DIR = dirname(fileURLToPath(import.meta.url));
await import("../verify.mjs");
