# Week 3 evidence: the hotspot box and the failure lab

```sh
node evidence/week-3/verify.mjs      # Node 20+, no install
```

`verify.mjs` checks that every logged preimage hashes to its payment hash
(94 paid chunks in `box-lab-e2e.jsonl`), that both channel funding
transactions are committed on CKB testnet, and, for every failure-lab run,
recomputes the cut time from the box's own log lines: gate closed ≤ 15 s
after the paid data ran out (H2).

## Result

**18 of 18 runs passed: 6 scenarios × 3 runs, on CKB testnet.** Every phone
whose paid data ran out was cut **12.8–13.6 s** later (21 cuts, median
12.9 s), and data stopped arriving at the phone's network interface
11.5–12.8 s after it ran out.

| # | Scenario | Runs | Exhausted → gate closed | What the run did |
|---|---|---|---|---|
| 1 | Tab closed | 3/3 | 12.9–13.0 s | At 6 MB the page stops: no payments, no portal calls. The phone's other traffic carries on until the cut. |
| 2 | Screen locked | 3/3 | 12.8–13.0 s | At 6 MB the page freezes for 40 s while traffic carries on: cut while locked. On unlock it pays, is back online, then stops and is cut again. |
| 3 | Uplink dropped | 3/3 | 12.9–13.5 s | The box's uplink is cut for 20 s mid-session (both directions, open connections too). The phone, holding paid data it couldn't use, was never cut for it; it was cut only after it stopped paying. |
| 4 | Box rebooted | 3/3 | 12.9–13.6 s | The box container restarts mid-session (openNDS starts with no clients). The phone's paid-but-unused data is given back when it reappears, with no new payment, and it is online again. |
| 5 | User stops paying | 3/3 | 12.9–13.1 s | At 6 MB the page stops paying but stays open. |
| 6 | User channel empty | 3/3 | 12.9–13.2 s | Two chunks paid, then FNN refuses the third: `Insufficient balance: max outbound liquidity … is insufficient`. |

Payments: 89 chunk payments in these runs, settled in a median of 213 ms
(max 257 ms) from `send_payment` to `Success` on the phone's wallet. All 89
were under 5 s. This is one machine with a local channel, not an H1
measurement.

## What ran

- **The box:** the image from `box/linux/Dockerfile`, i.e. openNDS v11.0.0
  built from the pinned release, dnsmasq, and meterd in hotspot mode, against
  the box's FNN v0.9.1 (unpatched) on CKB testnet. It ran on the public test
  server, with openNDS guarding a virtual interface (`mn-gw`) instead of Wi-Fi.
- **The phone:** a Linux network namespace on the other end of that
  interface, getting its address from the box's DHCP (`box/sim/phone-net.sh`).
  It pays every invoice the portal hands out from its own FNN
  (`box/sim/payer.sh`), standing in for the browser wallet, over a private
  one-way channel to the box. It browses by downloading a public speed-test
  file at 256 KiB/s (`box/sim/phone.mjs`).
- **The lab:** `box/sim/lab.mjs` drives the phone, does the box-side failure
  itself, then reads the box's log for that run. "Data stopped" on the phone
  side is measured on its network interface (`rx_bytes`), not by the app,
  whose reads lag behind what is already in the TCP buffer.

## Files

| File | What it is |
|---|---|
| `lab-final/` | The full lab on the final box image: `lab.md` (table) and `lab.json` (every run: checks, the phone's view, the host's actions, and the box log lines). |
| `lab-final-s6/` | Scenario 6 again, 3 runs (see "Limits"). |
| `box-lab-e2e.jsonl` | The box's log lines for all of the above, unedited: invoices, payment hashes, preimages, grace starts, cuts, restores. Device IDs are salted hashes of the MAC. |
| `funding-txs.json` | The two channels the phone's wallet opened to the box. |
| `earlier/` | Earlier lab runs, kept because each found a problem (below). Not checked by `verify.mjs`. |

## Earlier runs, and what each one fixed

- **`earlier/lab-1/`: 15/18, on the first box image.** Every run cut within
  15 s (12.8–13.6 s). The 3 failures were the test phone's fault: after
  unlocking, it ended its run without waiting for the second cut, so it kept
  paid data, and the next two runs started already online.
- **`earlier/rerun-2-3/`: one cut took 15.4 s.** openNDS's watchdog checks its
  own web server with `wget` every 15 s; the image had no `wget`, so every
  check timed out after ~4 s, openNDS restarted that server, and `ndsctl`
  stalled. A cut due during a stall closed 3.4 s late. Fixed by installing
  `wget`; the check now takes 0.27 s. The whole lab was then rerun on the
  fixed image (`lab-final/`).
- **`earlier/s6-probe-bug/`:** the phone's "is the internet up?" probe used a
  request the test server refuses, so "online after paying" read false. The
  cuts in it were 12.9–13.0 s.

Building the box also turned up five openNDS behaviours on generic Linux
(flowtable offload hiding traffic from its counters, DHCP-only clients,
`sessiontimeout 0`, stale neighbour entries, restart heartbeat). They are in
ARCHITECTURE.md, "openNDS facts"; draft upstream issues are in
`box/opennds-upstream-drafts.md`.

## Limits, stated up front

- **Simulated phone, not a real one.** No Wi-Fi radio, no phone browser: the
  wallet is a native FNN, not fiber-js in a phone's browser. openNDS, meterd,
  FNN, the payments and the cut are the real ones. Runs with a real phone on
  real Wi-Fi need a Linux laptop with an AP-capable Wi-Fi card.
- **Unpaid data at the cut.** The box counts usage from openNDS once a
  second, and the 12 s grace window lets data through after the paid
  allowance runs out, so each cut came 2.7–3.1 MB past it at the phone's
  256 KiB/s pace (the web MVP's gateway, which stops at the allowance, sends
  none). In the screen-locked runs the test phone caught up at full line
  speed after unlocking, and the second cut came 6.1–10.4 MB past it. H2
  measures cut time and passes; the overage is a real property of the
  hotspot design (grace × link speed), to be reported with H2.
- **`lab-final/` scenario 6 run 3** shows no cut: the speed-test server
  (speed.cloudflare.com) had started answering HTTP 429, so the phone paid
  one chunk and then downloaded nothing; with paid data unused, no cut was
  due. `verify.mjs` reports it as n/a. The phone now downloads from another
  server, and logs download errors; scenario 6 was rerun (`lab-final-s6/`).
- **Scenario 6 chunk price.** To make the channel run dry after two chunks,
  each run set the chunk price to 2/5 of what was left in the phone's
  channels; FNN's refusal is the real one for an empty channel.
- One machine, one phone at a time, 3 runs per scenario: checks of the
  mechanism, not the pilot's H2 measurement.

## How it was run (2026-11-16, UTC)

1. `sudo box/sim/phone-net.sh up`, `sudo box/sim/payer.sh start`; the payer
   was funded from the testnet faucet and opened a private one-way channel to
   the box's FNN.
2. The box image was built (`docker build -f box/linux/Dockerfile`) and run
   with host networking on `mn-gw`.
3. `sudo node box/sim/lab.mjs /var/lib/meternet-lab/w3-final` (09:36–10:01),
   then `… lab.mjs /var/lib/meternet-lab/w3-s6c 6` (10:20–10:23).
