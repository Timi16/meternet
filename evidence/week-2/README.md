# Week 2 evidence

```sh
node evidence/week-2/verify.mjs      # Node 20+, no install
```

`verify.mjs` checks that every logged preimage hashes to its payment hash (82 payments in this folder) and that every channel funding transaction is committed on CKB testnet.

## Files

| File | What it is |
|---|---|
| `browser-e2e.jsonl` | meterd on the public server issues an invoice; the **official browser node** (`@nervosnetwork/fiber-js@0.9.1`, headless Chrome, fresh profile) pays it over `wss://fiber.162-35-126-18.sslip.io`; meterd sees `Paid` 1,185 ms after creating the invoice and opens the gate. |
| `funding-txs.json` | The browser node's private one-way channel (200 CKB, `public: false`, `one_way: true`), opened over wss. Every gateway run below reused this channel. |
| `gateway-e2e.jsonl` | meterd's own web log for 2026-11-10, unedited: every gateway session, invoice, payment hash, preimage, grace start and cut. |
| `gateway-runs.json` | One summary per gateway run, from the client side, grouped by phase (see below). |

## Gateway runs: "data flows only while payments land"

`web/scripts/gateway-e2e.mjs` plays a user through the public URL: the browser node (via `web/scripts/browser-bridge.mjs`) opens a session, downloads a test file from the metered gateway, pays every invoice meterd issues, stops paying after 6 MB, and records when data stops. meterd's `cut` line gives `t_exhausted_ms` and `t_gate_closed_ms`.

**Final configuration (phase D, three runs, 50 MB file):**

| Run | Paid / received | Unpaid bytes | Stalls while paying | Data stopped after the last payment | Cut after allowance ran out | Gateway after the cut |
|---|---|---|---|---|---|---|
| 1 | 8.0 / 8.0 MiB | 0 | none | 10.8 s | 12.0 s | 402 |
| 2 | 8.0 / 8.0 MiB | 0 | none | 10.8 s | 12.0 s | 402 |
| 3 | 8.0 / 8.0 MiB | 0 | none | 10.4 s | 12.0 s | 402 |

**Earlier phases, kept because each found a problem that is now fixed:**

- **A.** The gateway kept serving during the 12 s grace: 3.1 MiB was sent unpaid (11.1 MiB used, 8 MiB paid). Fix: never send past the paid allowance.
- **B.** At 1 MiB/s with the 1 MB prefetch, paying sessions stalled 0.4–1.0 s at almost every chunk. Fix: prefetch from the pacing rate.
- **C.** At 1 MiB/s on a link that delivered 0.31 MiB/s, up to ~10 MiB of already-paid data sat in buffers and kept arriving up to 35 s after payments stopped. Fix: pace at 256 KiB/s.
- **C2.** One payment, sent as the browser's channel was re-established, took ~90 s to settle (FIBER_NOTES F-005).

## How it was run (2026-11-10)

1. `deploy/server/install-caddy.sh` put Caddy (TLS) in front of the server FNN. `deploy/server/install-meterd.sh` runs meterd as a service. `deploy/server/sync-content.sh` made and uploaded the test content. `deploy/server/sync-web.sh` deployed the browser page.
2. `web/scripts/browser-bridge.mjs` opened that page in headless Chrome. The page started fiber-js and connected to the server over wss. The bridge exposes the browser node as JSON-RPC on the laptop.
3. The browser node's address was funded with 10,000 testnet CKB from the faucet.
4. For `browser-e2e.jsonl`, meterd's unchanged `npm run e2e` on the server sent its commands to the browser node through an SSH reverse tunnel. The tunnel carried only those commands. The channel and the payment ran between the browser node and the server FNN over wss.
5. For the gateway runs, `gateway-e2e.mjs` ran on the laptop against the public URL.

## Limits, stated up front

- A test script drove the browser node, not a person, from the laptop in Lagos. Phone and 4G runs come with the demo page.
- These are checks of the mechanism, not H1/H2 measurements: one machine, one channel, a few runs.
- "Data stopped after the last payment" includes the data already paid for. It depends on the visitor's link speed.
- `open_channel` succeeded on its first try, because the page had connected to the server a few seconds earlier. So the F-001 retry, and the format of fiber-js's error message for it, weren't exercised from the browser yet.
- The demo page and the dashboard page are not built yet. The dashboard's data (`/api/dashboard`) is live.
