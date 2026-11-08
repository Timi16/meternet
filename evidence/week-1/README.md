# Week 1 evidence

Everything here can be checked without trusting the author:

```sh
node evidence/week-1/verify.mjs      # Node 20+, no install
cd meterd && npm ci && npm test      # 40 tests against a mocked FNN RPC
```

`verify.mjs` checks that every logged preimage hashes to its payment hash, that every channel funding transaction are committed on CKB testnet, and recomputes the keysend-vs-invoice summary from the raw lines.

## Week 1 deliverables (from the locked proposal)

| Deliverable | Where |
|---|---|
| meterd tests pass against a mocked FNN RPC | `meterd/test/`; the mock is `meterd/test/mock-fnn.ts` |
| Keysend-vs-invoice decision | [FIBER_NOTES.md](../../FIBER_NOTES.md), "Keysend (Trickle pattern) vs invoices" |
| FNN + meterd on the public server | [deploy/server/install-fnn.sh](../../deploy/server/install-fnn.sh), FNN v0.9.1 pinned by sha256 |

## Files

| File | What it is |
|---|---|
| `server-e2e.jsonl` | meterd on the public server (AWS eu-north-1, FNN v0.9.1) issues an invoice; a payer node in Lagos pays it; meterd sees `Paid` and opens the gate. |
| `vps-server-e2e.jsonl` | The same flow after the public server moved to an InterServer VPS (x86_64, FNN v0.9.1) on 2026-11-08. |
| `local-e2e.jsonl` | The same flow with both nodes on one laptop. |
| `keysend-vs-invoice-trial.jsonl` | 20 invoice and 20 keysend payments, alternating, over one channel. Invoice-mode preimages were checked against their hashes during the run, but not logged. |
| `funding-txs.json` | The channel funding transactions, one per run. |

## Limits, stated up front

- In both server runs, the payer reached the server's FNN through an SSH tunnel, because the P2P port is firewalled. The public wss endpoint for browsers is week-2 work.
- The trial ran with both nodes on one laptop and a 100 ms poll interval. Its timings are for comparing the two modes, not H1 measurements.
- Fiber payments are off-chain, so payment hashes don't appear on the explorer. The preimage check is the proof that each invoice was paid. Channel funding transactions are on-chain.
