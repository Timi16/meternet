# Fiber notes

A running log of bugs, gaps and surprises in FNN (the native Fiber Network Node) and the Fiber WASM / fiber-js node, found while building MeterNet. Each entry should be reproducible and, where it makes sense, linked to an upstream issue.

## Bug and gap log

Pinned at kickoff: **FNN v0.9.1** (`9a561b3`, release binaries `fnn_v0.9.1-aarch64-darwin-portable` sha256 `4a330134…f63d` on the laptop and `fnn_v0.9.1-aarch64-linux-portable` sha256 `c52c99b0…3f0c` on the public server) and **`@nervosnetwork/fiber-js@0.9.1`**. Unpatched.

| # | Date | FNN / fiber-js version | What broke or is missing | Upstream issue |
|---|------|------------------------|--------------------------|----------------|
| F-001 | 2026-11-06 | FNN v0.9.1 | `open_channel` right after `connect_peer` fails: peer "feature not found, waiting for peer to send Init message" | not filed yet (draft below) |
| F-002 | 2026-11-06 | FNN v0.9.1 | A one-way channel locks ~99 CKB from each side that neither can spend; the auto-accepting box adds 99 CKB it can never send | question, not filed yet (draft below) |

### F-001: `connect_peer` returns before the peer is ready for `open_channel`

- **Setup:** two local FNN v0.9.1 nodes on testnet (macOS arm64). The payer calls `connect_peer {address: "/ip4/127.0.0.1/tcp/8228/p2p/<box peer id>"}`, which returns success, then immediately calls `open_channel {pubkey: <box>, funding_amount: 200 CKB, public: false, one_way: true}`.
- **What happened:** `open_channel` returned JSON-RPC error `-32000`: `Invalid parameter: Peer Pubkey(0205d0d9…142a)'s feature not found, waiting for peer to send Init message`.
- **Workaround:** retry `open_channel` every 500 ms while the error says "waiting for peer to send Init message", for up to 30 s (`meterd/scripts/testnet-e2e.ts`). The browser client will need the same retry.
- **Draft upstream issue:**
  > **`connect_peer` resolves before the Init exchange, so an immediate `open_channel` fails**
  > On v0.9.1, `connect_peer` returns `null` as soon as the connection is dialed. Calling `open_channel` on that peer straight away fails with `feature not found, waiting for peer to send Init message`. Clients have to poll or retry blindly. Could `connect_peer` wait for Init (or take an option to), or could the docs say that callers should wait, for example via `list_peers`, before `open_channel`?

### F-002: Capacity locked by a one-way channel

- **Setup:** the payer runs `open_channel {funding_amount: 200 CKB, public: false, one_way: true}` to the box. The box uses the default testnet config (`open_channel_auto_accept_min_ckb_funding_amount` 100 CKB, `auto_accept_channel_ckb_funding_amount` 99 CKB).
- **What happened:** funding tx [`0x9eb622c3…be9e8`](https://pudge.explorer.nervos.org/transaction/0x9eb622c394fb75019ff830de3a3a8c7cc9fb1b8537f8f34251d1597ff04be9e8) has a **299 CKB** funding cell (200 from the payer, 99 from the box). After one 0.1 CKB payment, `list_channels` shows payer local 100.9 / box local 0.1. So about 99 CKB per side is held back, and the payer could only ever spend 101 of its 200 CKB.
- **Reproduced:** same result on the public server (FNN v0.9.1, Ubuntu arm64). Funding tx [`0x8e296263…1c7e`](https://pudge.explorer.nervos.org/transaction/0x8e29626363e3181825d1d2046ac4e88db6946f4471584ae4f8bf4499aff91c7e) also has a 299 CKB funding cell for a 200 CKB open.
- **Why it matters:** for H3, the box ties up 99 CKB per user channel even though it can't send on a one-way channel. For users, a phone needs more than 100 CKB just to open a channel. `TODO(verify)`: that the ~99 CKB per side is the reserved occupied capacity for each party's settlement cell. I'm inferring this from the balances; I haven't found it in the docs.
- **Workaround:** none needed for week 1. Budget it: box liquidity ≈ 99 CKB × channels. Check whether the box can accept one-way channels without contributing funds.
- **Draft upstream question:**
  > **How much capacity does a one-way channel lock, and must the acceptor contribute?**
  > On v0.9.1 with the default testnet config, a 200 CKB `one_way: true` channel produced a 299 CKB funding cell. The auto-accepting peer added 99 CKB, and the funder can spend only ~101 CKB. Is ~99 CKB per side the reserved settlement-cell capacity? Since the acceptor can never send on a one-way channel, can it accept without contributing?

## Keysend (Trickle pattern) vs invoices: decided week 1 (2026-11-06)

**Decision: keep one invoice per 2 MB chunk.** Keysend works on FNN v0.9.1, but it is no faster in our test, and it would weaken the per-device attribution and the preimage evidence the report depends on.

### What was compared

The trial used Trickle's pattern (one keysend `send_payment` per tick) on plain FNN, without Trickle's library.

- **Invoice:** meterd calls `new_invoice` with `hash_algorithm: "sha256"` and its own random preimage. The payer calls `send_payment {invoice}`. The box polls `get_invoice` until `Paid`.
- **Keysend:** the payer calls `send_payment {target_pubkey: <box>, amount, keysend: true}`. The box has no RPC that reports an incoming keysend payment, so it polls `list_channels` until that channel's `local_balance` rises by the chunk price.

### Result

`meterd/scripts/payment-trial.ts`, 2026-11-06. Two local FNN v0.9.1 nodes on testnet (macOS arm64), one private one-way channel, 0.1 CKB per chunk, 20 runs per mode, alternating, polling every 100 ms. Latency is measured from `send_payment` to the box being able to credit the chunk.

| Mode | OK | p50 | p95 | max | < 5 s |
|------|----|-----|-----|-----|-------|
| invoice | 20/20 | 107 ms | 117 ms | 118 ms | 20/20 |
| keysend | 20/20 | 106 ms | 109 ms | 111 ms | 20/20 |

Raw lines: [`evidence/week-1/keysend-vs-invoice-trial.jsonl`](evidence/week-1/keysend-vs-invoice-trial.jsonl); `node evidence/week-1/verify.mjs` recomputes this table from them. **These are not H1 numbers.** Both nodes ran on one laptop over localhost, and the 100 ms poll interval dominates the figures. Real phone and 4G latency is measured from week 2.

### Why invoices

1. **Same speed.** The two modes are within the poll resolution. Keysend's real saving is the invoice round trip, and meterd already hides that by fetching the next invoice when 1 MB of allowance is left.
2. **Evidence.** With invoices, meterd creates the preimage, so every log line carries a preimage with `sha256(preimage) == payment_hash`, which `meternet verify logs/` can check. With keysend, only the payer learns the preimage (`send_payment` / `get_payment` return it to the sender). The box would have to trust the phone to report it.
3. **Attribution.** An invoice's `payment_hash` belongs to exactly one device and chunk. Keysend is only visible as a balance change on a channel, so it needs exactly one channel per device and still can't say which payment arrived. Trickle's README notes the same limitation: the receiver has no view of incoming keysend.
4. **Allowed methods only.** The invoice path needs `new_invoice` and `get_invoice`. Detecting keysend works through `list_channels`, but only as a balance heuristic.

**Revisit if:** field latency in weeks 2–5 shows that fetching the next invoice measurably hurts H1, or a later FNN release adds a receiver-side view of keysend payments.
