# Fiber notes

A running log of bugs, gaps and surprises in FNN (the native Fiber Network Node) and the Fiber WASM / fiber-js node, found while building MeterNet. Each entry should be reproducible and, where it makes sense, linked to an upstream issue.

## Bug and gap log

Pinned at kickoff: **FNN v0.9.1** (`9a561b3`, release binary `fnn_v0.9.1-aarch64-darwin-portable`, sha256 `4a330134…f63d`) and **`@nervosnetwork/fiber-js@0.9.1`**. Unpatched.

| # | Date | FNN / fiber-js version | What broke or is missing | Upstream issue |
|---|------|------------------------|--------------------------|----------------|
| F-001 | 2026-11-06 | FNN v0.9.1 | `open_channel` right after `connect_peer` fails: peer "feature not found, waiting for peer to send Init message" | not filed yet (draft below) |

### F-001: `connect_peer` returns before the peer is ready for `open_channel`

- **Setup:** two local FNN v0.9.1 nodes on testnet (macOS arm64). The payer calls `connect_peer {address: "/ip4/127.0.0.1/tcp/8228/p2p/<box peer id>"}`, which returns success, then immediately calls `open_channel {pubkey: <box>, funding_amount: 200 CKB, public: false, one_way: true}`.
- **What happened:** `open_channel` returned JSON-RPC error `-32000`: `Invalid parameter: Peer Pubkey(0205d0d9…142a)'s feature not found, waiting for peer to send Init message`.
- **Workaround:** retry `open_channel` every 500 ms while the error says "waiting for peer to send Init message", for up to 30 s (`meterd/scripts/testnet-e2e.ts`). The browser client will need the same retry.
- **Draft upstream issue:**
  > **`connect_peer` resolves before the Init exchange, so an immediate `open_channel` fails**
  > On v0.9.1, `connect_peer` returns `null` as soon as the connection is dialed. Calling `open_channel` on that peer straight away fails with `feature not found, waiting for peer to send Init message`. Clients have to poll or retry blindly. Could `connect_peer` wait for Init (or take an option to), or could the docs say that callers should wait, for example via `list_peers`, before `open_channel`?

## Keysend (Trickle pattern) vs invoices: decision pending, week 1

The current design uses **one invoice per 2 MB chunk**. `meterd` calls `new_invoice`, the phone pays it with `send_payment`, and `meterd` polls `get_invoice` until `Paid`. Every chunk has a `payment_hash` that `meterd` created, so it is clear which device paid for what.

The alternative is a **keysend / Trickle pattern**: the phone pushes payments to the box without first asking for an invoice. That would cut one round trip per chunk.

Open questions to answer in week 1, before choosing:

- Does `send_payment` support keysend in the FNN and fiber-js versions we target, and what parameter enables it? `TODO(verify)`
- How would `meterd` see an incoming keysend payment and link it to a device, using only the RPC methods listed in ARCHITECTURE.md? If that isn't possible, keysend would need a method outside that list, and we would have to verify one first.
- What is the measured latency difference against H1 (≥95% settle in <5 s)?

Decision: **pending**.
