# meternet

MeterNet is an open-source hotspot box, a Linux laptop or Raspberry Pi, that sells Wi-Fi by the megabyte over the [Fiber Network](https://github.com/nervosnetwork/fiber) on Nervos CKB **testnet**. A phone joins the hotspot, opens a captive-portal page that runs a Fiber node in the browser, opens a private one-way channel to the box, and pays for data in 2 MB chunks. The phone stays online only while those small payments keep arriving. If they stop, the box cuts the phone off within 15 seconds. The box runs openNDS (captive portal) with a forwarding auth service (FAS), a native Fiber Network Node (FNN), and `meterd`, a small TypeScript daemon that turns paid invoices into byte allowances.

**Status: Weeks 2 and 3 built. The public demo is up at https://162-35-126-18.sslip.io. The hotspot box runs on Linux and passed the failure lab (6 scenarios × 3 runs) with a simulated phone; a real phone on real Wi-Fi, and the `v0.1` tag, are next.**

`meterd` has its state machine, an FNN JSON-RPC client and a per-device meter loop, all tested against a mocked FNN. FNN v0.9.1 and meterd run on the public server, installed with [deploy/server/install-fnn.sh](deploy/server/install-fnn.sh) and [deploy/server/sync-meterd.sh](deploy/server/sync-meterd.sh). Real testnet chunk payments have gone through it end to end, from a payer node in Lagos. The server moved from AWS (eu-north-1, arm64) to an InterServer VPS (x86_64) on 2026-11-08, and the payment was repeated there. Week 2 is in progress. The public wss endpoint is live at `wss://fiber.162-35-126-18.sslip.io` (Caddy TLS in front of FNN, [deploy/server/install-caddy.sh](deploy/server/install-caddy.sh)), and the official fiber-js 0.9.1 browser node has used it to open a channel and pay. The web MVP's server side runs on the public server: meterd's sessions API, the metered HTTP gateway (MeterNet's own test files and a test video in ~2 MB HLS segments, paced per session, never past the paid allowance) and the dashboard's data feed ([ARCHITECTURE.md, "Public web MVP"](ARCHITECTURE.md#public-web-mvp)). In test runs through the public URL, a browser node paid as it downloaded, stopped paying, and was cut 12 s after its allowance ran out, with no unpaid bytes ([evidence/week-2/](evidence/week-2/)). The pages are up too: [the Meter](https://162-35-126-18.sslip.io/) (board, ride, stop paying, see the cut, leave feedback) and [the Board](https://162-35-126-18.sslip.io/dashboard.html) (every session's payment hashes and cut times, live). Week 3, the hotspot box, is in [box/](box/README.md): openNDS v11 (captive portal and per-phone firewall), dnsmasq, meterd in hotspot mode, the box's own FNN and an HTTPS portal behind Caddy, all from `docker compose up` ([docker-compose.yml](docker-compose.yml)). With a simulated phone (a Linux network namespace on the box's hotspot interface, paying from its own FNN), every one of the six failure scenarios was run three times on CKB testnet, and every unpaid phone was cut 12.8–13.6 s after its paid data ran out ([evidence/week-3/](evidence/week-3/)). All six are also in `npm test` against the mocked FNN.

## How it works (planned)

### User flow

1. **Join.** The phone joins the MeterNet Wi-Fi. openNDS holds it in the walled garden and redirects it to the portal page, served through the FAS.
2. **Open a channel.** The portal page loads the official Fiber WASM / fiber-js node, calls `connect_peer` to the box's FNN, then `open_channel` with `public: false, one_way: true`, funded from the user's testnet CKB.
3. **Pay for the first chunk.** The page asks `meterd` for 2 MB, pays the returned invoice with `send_payment`, and `meterd` grants access with `ndsctl auth <mac>` once the invoice shows `Paid`.
4. **Keep paying or get cut.** While the user browses, the page pays for each next 2 MB chunk. If payments stop, the box closes the session.

### Meter loop (per device)

1. The device asks for the next 2 MB. `meterd` calls FNN `new_invoice` and returns the invoice.
2. The browser pays with `send_payment`. `meterd` polls `get_invoice` until `status` is `Paid`. The possible statuses are `Open`, `Cancelled`, `Expired`, `Received`, and `Paid`.
3. On `Paid`, that device's allowance rises by 2 MB.
4. If usage reaches the allowance and no payment lands within the grace window, `meterd` runs `ndsctl deauth <mac>`. Grace is 12 s, so that detecting and closing fit inside the 15 s cutoff ([ARCHITECTURE.md, "Cutoff budget"](ARCHITECTURE.md#cutoff-budget)).

Per-client traffic comes from `ndsctl json`. If that doesn't expose byte counters, per-device iptables counters are the fallback.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the components, sequence diagram, failure scenarios and logging schema. See [FIBER_NOTES.md](FIBER_NOTES.md) for the Fiber bug/gap log.

## Hypotheses

These are what the grant work sets out to test. None of them has been measured yet.

| ID | Hypothesis | Pass criterion |
|----|------------|----------------|
| H1 | Per-chunk Fiber payments are fast enough to meter Wi-Fi. | ≥95% of 2 MB chunk payments settle in <5 s. |
| H2 | The box reliably cuts off devices that stop paying. | 100% of unpaid sessions are closed within 15 s, across 6 failure scenarios × 3 runs. |
| H3 | A box can run unattended with manageable liquidity. | An outside host runs the box for 14 days, with ≥500 payments and ≤2 manual liquidity actions. |
| H4 | Users reuse channels, so channel-open cost is amortized. | The median user reuses one channel for ≥3 sessions. If not, vouchers beat channels and we say so. |

## Out of scope

- Mainnet
- Real money
- Stablecoins
- Public resale of data
- Router firmware

## Project layout

```
README.md            this file
ARCHITECTURE.md      components, sequence diagram, failure scenarios, logging schema
FIBER_NOTES.md       log of FNN / Fiber WASM bugs and gaps
meterd/              TypeScript meter daemon (state machine, FNN client, meter loop + vitest)
web/                 browser client: the official fiber-js node, bundled with esbuild
deploy/server/       public server setup: FNN, Caddy (TLS + wss), meterd and web sync
evidence/            raw logs and checks behind each weekly update
docker-compose.yml   placeholder, not runnable yet
```

```sh
cd meterd
npm install
npm test
```

## Links

- Spark grant proposal thread: https://talk.nervos.org/t/spark-program-meternet-pay-per-mb-wi-fi-hotspots-metered-by-fiber-payments/11041

## License

MIT. See [LICENSE](LICENSE).
