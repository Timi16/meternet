| # | Scenario | Run | Result | Payments (ok / failed) | Exhausted → gate closed (ms) | Phone's last byte after exhausted (ms) | Payment hashes |
|---|---|---|---|---|---|---|---|
| 2 | screen locked | 1 | pass | 7 / 0 | 12968, 13090 | 12806 | 0xd85764a3… 0xd766d1ea… 0x79e39ba4… 0x1761a375… 0x70c91f6a… 0x604ada10… 0x87fa1d46… |
| 2 | screen locked | 2 | pass | 8 / 0 | 13024, 12759 | 12982 | 0x44068cd1… 0x8f911994… 0xc51942ff… 0x0bee1340… 0x130c0b30… 0xa06dc222… 0xed49107b… 0x3b45c061… |
| 2 | screen locked | 3 | pass | 6 / 0 | 13195, 12854 | 12121 | 0xf597096d… 0x01a17d28… 0xe7482698… 0x8d6666b9… 0x0fb085b6… 0x645dba9a… |
| 3 | uplink dropped | 1 | **FAIL** | 8 / 0 | 15413 | 14626 | 0x81e1344b… 0x274a83a2… 0x496c23fe… 0x102c38b1… 0x5f005aa8… 0x80d3b11d… 0x4bbb9dc6… 0x38be56d8… |
| 3 | uplink dropped | 2 | pass | 6 / 0 | 12956 | 11729 | 0x79b1f89b… 0xda370d7e… 0x7746c81f… 0xbba729c0… 0xd3e9b73a… 0x947d283d… |
| 3 | uplink dropped | 3 | pass | 8 / 0 | 13014 | 12397 | 0xf24b4999… 0x9fe07e33… 0x485be225… 0xec8fd3a7… 0xbc10ed75… 0x79ec51df… 0xcf9a2d15… 0x6a72072e… |

5 of 6 runs passed. Full data, including every payment hash and box log line: lab.json.
