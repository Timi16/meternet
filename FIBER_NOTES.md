# Fiber notes

A running log of bugs, gaps and surprises in FNN (the native Fiber Network Node) and the Fiber WASM / fiber-js node, found while building MeterNet. Each entry should be reproducible and, where it makes sense, linked to an upstream issue.

## Bug and gap log

| Date | FNN / fiber-js version | What broke or is missing | Upstream issue |
|------|------------------------|--------------------------|----------------|
|      |                        |                          |                |

_No entries yet._

## Keysend (Trickle pattern) vs invoices: decision pending, week 1

The current design uses **one invoice per 2 MB chunk**. `meterd` calls `new_invoice`, the phone pays it with `send_payment`, and `meterd` polls `get_invoice` until `Paid`. Every chunk has a `payment_hash` that `meterd` created, so it is clear which device paid for what.

The alternative is a **keysend / Trickle pattern**: the phone pushes payments to the box without first asking for an invoice. That would cut one round trip per chunk.

Open questions to answer in week 1, before choosing:

- Does `send_payment` support keysend in the FNN and fiber-js versions we target, and what parameter enables it? `TODO(verify)`
- How would `meterd` see an incoming keysend payment and link it to a device, using only the RPC methods listed in ARCHITECTURE.md? If that isn't possible, keysend would need a method outside that list, and we would have to verify one first.
- What is the measured latency difference against H1 (≥95% settle in <5 s)?

Decision: **pending**.
