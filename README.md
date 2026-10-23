# meternet

MeterNet is an open-source hotspot box, a Linux laptop or Raspberry Pi, that sells Wi-Fi by the megabyte over the [Fiber Network](https://github.com/nervosnetwork/fiber) on Nervos CKB **testnet**. A phone joins the hotspot, opens a captive-portal page that runs a Fiber node in the browser, opens a private one-way channel to the box, and pays for data in 2 MB chunks. The phone stays online only while those small payments keep arriving. If they stop, the box cuts the phone off within a 15-second grace window. The box runs openNDS (captive portal) with a forwarding auth service (FAS), a native Fiber Network Node (FNN), and `meterd`, a small TypeScript daemon that turns paid invoices into byte allowances.

**Status: Week 0: skeleton only. Nothing works yet.**

This repo currently has documentation and a state-machine skeleton for `meterd` with two tests. One of them fails on purpose, because the grace-to-cut transition isn't written yet. There is no portal, no FNN integration, and no openNDS integration yet.

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
4. If usage reaches the allowance and no payment lands within a 15 s grace window, `meterd` runs `ndsctl deauth <mac>`.

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
meterd/              TypeScript meter daemon (state-machine skeleton + vitest)
docker-compose.yml   placeholder, not runnable yet
```

```sh
cd meterd
npm install
npm test   # expected at week 0: 1 passed, 1 failed
```

## Links

- Spark grant proposal thread: `<Talk thread link>`

## License

MIT. See [LICENSE](LICENSE).
