# Fiber notes

A running log of bugs, gaps and surprises in FNN (the native Fiber Network Node) and the Fiber WASM / fiber-js node, found while building MeterNet. Each entry should be reproducible and, where it makes sense, linked to an upstream issue.

## Bug and gap log

Pinned at kickoff: **FNN v0.9.1** (`9a561b3`, release binaries `fnn_v0.9.1-aarch64-darwin-portable` sha256 `4a330134…f63d` on the laptop and `fnn_v0.9.1-aarch64-linux-portable` sha256 `c52c99b0…3f0c` and `fnn_v0.9.1-x86_64-linux-portable` sha256 `6425bc90…6d0d` on the public server) and **`@nervosnetwork/fiber-js@0.9.1`**. Unpatched.

| # | Date | FNN / fiber-js version | What broke or is missing | Upstream issue |
|---|------|------------------------|--------------------------|----------------|
| F-001 | 2026-11-06 | FNN v0.9.1 | `open_channel` right after `connect_peer` fails: peer "feature not found, waiting for peer to send Init message" | not filed yet (draft below) |
| F-002 | 2026-11-06 | FNN v0.9.1 | A one-way channel locks ~99 CKB from each side that neither can spend; the auto-accepting box adds 99 CKB it can never send | question, not filed yet (draft below) |
| F-003 | 2026-11-10 | FNN v0.9.1 (native) | `connect_peer` to a `/wss` address returns success, then never connects and logs nothing; the native build can't dial wss | not filed yet (draft below) |
| F-004 | 2026-11-10 | fiber-js 0.9.1 | The README example's `config.setIn([...], false)` throws `Tag not resolved for Boolean value` | docs fix, not filed yet (draft below) |
| F-005 | 2026-11-10 | fiber-js 0.9.1 ↔ FNN v0.9.1 | A payment sent as the channel is re-established takes ~90 s to settle; meanwhile a second one fails with `WaitingTlcAck`. Also: FNN logs `Remove TLCs … HoldTlcTimeout` at `ERROR` for every successful payment | not filed yet (draft below) |
| F-006 | 2026-11-11 | fiber-js 0.9.1 | The TypeScript types lack `one_way` (`OpenChannelParams`) and `is_one_way` (`Channel`), which the RPC has | not filed yet (draft below) |
| F-007 | 2026-11-11 | fiber-js 0.9.1 | Needs `SharedArrayBuffer`, so only runs on HTTPS (or localhost) pages: a plain-HTTP captive portal can't start it | question, not filed yet (draft below) |

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
- **Reproduced:** same result on the public server, on Ubuntu arm64 (AWS) and on Ubuntu x86_64 (VPS, funding tx [`0x268db601…7a62`](https://pudge.explorer.nervos.org/transaction/0x268db601ecdb7a3a0b5f2349c207bd4c5a987b13300ded96f80e7afb525f7a62), also 299 CKB). Funding tx [`0x8e296263…1c7e`](https://pudge.explorer.nervos.org/transaction/0x8e29626363e3181825d1d2046ac4e88db6946f4471584ae4f8bf4499aff91c7e) also has a 299 CKB funding cell for a 200 CKB open. The same happens when the opener is the browser node (fiber-js 0.9.1, 2026-11-10): funding tx [`0x5df1bc86…305a`](https://pudge.explorer.nervos.org/transaction/0x5df1bc868210e16da8cedf388e3923242233b3de187bb8d852742e6cab87305a), 299 CKB cell, payer local 101 CKB.
- **Why it matters:** for H3, the box ties up 99 CKB per user channel even though it can't send on a one-way channel. For users, a phone needs more than 100 CKB just to open a channel. `TODO(verify)`: that the ~99 CKB per side is the reserved occupied capacity for each party's settlement cell. I'm inferring this from the balances; I haven't found it in the docs.
- **Workaround:** none needed for week 1. Budget it: box liquidity ≈ 99 CKB × channels. Check whether the box can accept one-way channels without contributing funds.
- **Draft upstream question:**
  > **How much capacity does a one-way channel lock, and must the acceptor contribute?**
  > On v0.9.1 with the default testnet config, a 200 CKB `one_way: true` channel produced a 299 CKB funding cell. The auto-accepting peer added 99 CKB, and the funder can spend only ~101 CKB. Is ~99 CKB per side the reserved settlement-cell capacity? Since the acceptor can never send on a one-way channel, can it accept without contributing?

### F-003: native `connect_peer` to a wss address fails silently

- **Setup:** the public server's FNN v0.9.1 sits behind Caddy at `wss://fiber.162-35-126-18.sslip.io` (TLS proxy to port 8228, as in FNN's `docs/fiber-node-wss.md`). The laptop's native FNN v0.9.1 (macOS arm64) calls `connect_peer {address: "/dns4/fiber.162-35-126-18.sslip.io/tcp/443/wss/p2p/QmSzv8g9…"}`.
- **What happened:** the call returned `null` (success). The server never appeared in `list_peers`, and neither node logged anything about the dial. The same address works from the browser node (fiber-js 0.9.1), so the endpoint is fine.
- **Why:** `crates/fiber-lib/Cargo.toml` builds native tentacle with the `ws` feature, and `Cargo.lock` at v0.9.1 shows tentacle 0.7.7 pulling `tokio-tungstenite` 0.28.0 with no TLS backend (its dependencies are only futures-util, log, tokio and tungstenite). So native FNN can dial `ws` but not `wss`. `errors.rs` names native's supported transport as `tcp`.
- **Workaround:** native nodes use TCP (or an SSH tunnel to 8228), and wss is for browsers only. The outside host's box will need its P2P port reachable over TCP, or a tunnel.
- **Draft upstream issue:**
  > **Native `connect_peer` accepts a `/wss` address, returns success, then does nothing**
  > On v0.9.1 (native, macOS arm64), `connect_peer` with a `/dns4/<host>/tcp/443/wss/p2p/<id>` address returns `null`, but no connection is made and nothing is logged at `info`. The same address works from fiber-js. Since the native build has no wss support, could `connect_peer` return an error such as `NoSupportedAddress`?

### F-004: fiber-js README example throws on a boolean config value

- **Setup:** fiber-js 0.9.1 README example, with `yaml` 2.9.0: `parseDocument(fiber.getDefaultConfig("testnet", url), { schema: "failsafe" })`, then `config.setIn(["fiber", "announce_listening_addr"], false)`.
- **What happened:** `config.toString()` throws `Tag not resolved for Boolean value`. The failsafe schema has no boolean type.
- **Workaround:** set the string `"false"`. The failsafe schema writes it unquoted (`announce_listening_addr: false`), which FNN reads as a boolean (`web/src/spike.ts`).
- **Draft upstream issue (docs):**
  > **fiber-js README example throws: `Tag not resolved for Boolean value`**
  > The example parses the default config with `{ schema: "failsafe" }` and then sets `announce_listening_addr` to `false`. With yaml 2.9.0, `toString()` throws, because failsafe has no boolean tag. Setting the string `"false"` works. Could the example use `"false"`, or parse with the default schema?

### F-005: a payment caught by a reconnect takes ~90 s

- **Setup:** the browser node (fiber-js 0.9.1, headless Chrome) pays meterd invoices over a private one-way channel to the server FNN v0.9.1 through `wss://fiber.162-35-126-18.sslip.io`. Each payment is 0.1 CKB. The browser stayed open between test runs.
- **What happened (2026-11-10):**
  - Between runs, the channel was re-established twice: at 08:08:11 and 08:13:21 UTC, the server logged `channel.rs:9044` (the `ReestablishChannel` handler) and `Channel … is now ready`. Neither node logged a disconnect at `info`, so I don't know what dropped the connection. `TODO(verify)`: the cause.
  - At the second reestablish, the browser reported `waiting_ack: true` and the server `waiting_ack: false`. The browser had just sent payment `0x321c14e3…7779` (08:13:20).
  - That TLC reached the server only at 08:14:47. The invoice was `Paid` at 08:14:48, 90,188 ms after meterd created it. meterd credited it and opened the gate, but the test script had given up after 60 s. Raw lines: [evidence/week-2/gateway-e2e.jsonl](evidence/week-2/gateway-e2e.jsonl), session `38fe5fa8`.
  - While it was pending, the browser's `get_payment` returned `Inflight`, and the server's `get_invoice` returned `Open`.
- **Also seen:**
  - The browser logged `Generating TlcErr from error WaitingTlcAck to error_code TemporaryChannelFailure` when a payment was sent before the previous TLC was acknowledged. One unacknowledged TLC at a time on this channel.
  - The server logs `Remove TLCs for payment hash … because of error HoldTlcTimeout` (`settle_tlc_set_command.rs:320`) at `ERROR` once for **every** successful payment. All 81 invoices meterd saw `Paid` that day have exactly one. In `leave_just_fulfilled_tlcs_for_non_mpp_invoice` the line is written even when the rejected set is empty. I first misread this line as the delayed payment being rejected.
- **Why it matters:** for those ~90 s the user's allowance runs out, and the meter cuts them 12 s later: cut off by a Fiber delay, not by stopping paying. A replacement invoice wouldn't help, since a second payment fails with `WaitingTlcAck` while the first is unacknowledged. This is the browser-recovery case the proposal says needs product-level testing; it goes into the week-3 failure lab.
- **Workaround:**
  - The client sends one payment at a time and waits for it to settle before the next. That avoids the `WaitingTlcAck` failures.
  - A `Failed` payment is retried on the same invoice, which stays `Open`.
  - Nothing on our side shortens the delay itself. A cut user's next session reuses the same channel.
- **Draft upstream issue:**
  > **Payment sent around a channel reestablish takes ~90 s to settle**
  > fiber-js 0.9.1 paying FNN v0.9.1 over wss, one private one-way channel, 0.1 CKB invoice payments. A reconnect happened (no disconnect logged at `info` on either side). On reestablish the sender reported `waiting_ack: true` and the receiver `waiting_ack: false`. The TLC of the payment sent just before arrived ~88 s later and then settled normally. Meanwhile `get_payment` returned `Inflight`, and a second payment would fail with `WaitingTlcAck`. Expected: the pending TLC is re-sent promptly after reestablish. Separately, `Remove TLCs … HoldTlcTimeout` is logged at `ERROR` for every successful payment (empty rejected set), which looks like a failure in the logs.

### F-006: fiber-js types are missing `one_way`

- **What:** `crates/fiber-lib/src/rpc/README.md` at v0.9.1 documents `one_way` on `open_channel` and `is_one_way` on `Channel`. `fiber-js/src/types/channel.ts` has neither, so `fiber.openChannel({..., one_way: true})` doesn't type-check in TypeScript. The WASM node accepts the field: the browser opened a one-way channel with it on 2026-11-10.
- **Workaround:** call `fiber.invokeCommand("open_channel", [...])` and `invokeCommand("list_channels", ...)` with our own type (`web/src/wallet.ts`).
- **Draft upstream issue:**
  > **fiber-js types: add `one_way` to `OpenChannelParams` and `is_one_way` to `Channel`**
  > The RPC (README at v0.9.1) supports both, and the WASM node accepts `one_way: true`, but the TypeScript definitions in `fiber-js/src/types/channel.ts` don't include them.

### F-007: fiber-js needs a secure context, so a plain-HTTP portal can't run it

- **What:** fiber-js 0.9.1 creates a `SharedArrayBuffer` in the `Fiber` constructor (`fiber-js/src/index.ts`). Browsers only provide it on cross-origin-isolated pages, and only in a secure context. Tested 2026-11-11 in Chrome, same page and same COOP/COEP headers:
  - `http://10.126.130.32` (a LAN address, as a captive portal would be): `isSecureContext` false, `crossOriginIsolated` false, `SharedArrayBuffer` undefined;
  - `http://127.0.0.1`: all true;
  - `https://162-35-126-18.sslip.io`: all true.
- **Why it matters:** the hotspot portal is normally plain HTTP on the box's LAN address. The browser node can't start there. An HTTPS page also can't open `ws://`, so the box's FNN needs wss with a trusted certificate as well.
- **Workaround (week 3):** give each box a hostname with a publicly trusted certificate (DNS-01 challenge, so the box needn't be reachable from the internet). The box's own DNS answers that name with its LAN address. The portal and the box's wss endpoint are both served over HTTPS under it. `TODO(verify)`: how captive-portal mini-browsers (iOS/Android) handle cross-origin isolation; the proposal already moves users to a real browser tab.
- **Draft upstream question:**
  > **Can fiber-js run without SharedArrayBuffer (or document the secure-context requirement)?**
  > fiber-js 0.9.1 needs `SharedArrayBuffer`, so pages must be cross-origin isolated and served over HTTPS. That rules out plain-HTTP captive portals and local-network pages, a natural home for in-browser payment channels. Is a fallback without SharedArrayBuffer possible? If not, could the README state the requirement (COOP/COEP headers, secure context)?

## Public wss endpoint (week 2, 2026-11-10)

- **Setup:** Caddy 2.6.2 (Ubuntu archive) terminates TLS for `fiber.<host>` and reverse-proxies the WebSocket upgrade to `127.0.0.1:8228`. FNN accepts WebSocket on its P2P port by default (`fiber-reuse-port-for-websocket`, default true), and logs `Started listening tentacle on [".../tcp/8228/p2p/...", ".../tcp/8228/ws/p2p/..."]`. That gives the same result as the nginx setup in `docs/fiber-node-wss.md`, without its stream block, which only exists to share 443 with raw TCP P2P. Installer: [deploy/server/install-caddy.sh](deploy/server/install-caddy.sh).
- **Browser requirements found:** fiber-js uses `SharedArrayBuffer`, so the page must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). The CKB testnet RPC `https://testnet.ckbapp.dev/` sends `Access-Control-Allow-Origin: *`, so the browser node can reach it from that page. The bundle is 14.5 MB (7.4 MB compressed), almost all WASM.
- **Result:** in headless Chrome with a fresh profile, fiber-js 0.9.1 started in 4.4 s and reached the MeterNet FNN over wss 1.5 s after `connect_peer` (`web/scripts/browser-spike.mjs`). It then opened a private one-way channel and paid a meterd invoice ([evidence/week-2/](evidence/week-2/)).

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
