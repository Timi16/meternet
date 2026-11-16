| # | Scenario | Run | Result | Payments (ok / failed) | Exhausted → gate closed (ms) | Phone's last byte after exhausted (ms) | Payment hashes |
|---|---|---|---|---|---|---|---|
| 1 | tab closed | 1 | pass | 5 / 0 | 13021 | 12759 | 0xb8fa7d82… 0xe132baec… 0x5c242ef6… 0x784b5dac… 0x988fcd3e… |
| 1 | tab closed | 2 | pass | 5 / 0 | 12881 | 11961 | 0x43f24108… 0xccd72a42… 0x3f6ea134… 0xe46a906e… 0xa3fc0bca… |
| 1 | tab closed | 3 | pass | 5 / 0 | 12933 | 12306 | 0x81e0fabf… 0xc42cfc6d… 0x19f0dfdc… 0xa96e556f… 0x5d4279a5… |
| 2 | screen locked | 1 | pass | 6 / 0 | 12950, 12920 | 11477 | 0x525d9e05… 0x5248946f… 0x2e107993… 0x150ee515… 0x768e7c80… 0x4d9f821e… |
| 2 | screen locked | 2 | pass | 6 / 0 | 12860, 12811 | 11917 | 0xd302cbe9… 0xa6e50be9… 0x40b5e8c4… 0x3c816113… 0x23208d72… 0x33560444… |
| 2 | screen locked | 3 | pass | 6 / 0 | 12891, 12996 | 12824 | 0xc7988eef… 0xc59def13… 0x966c32a6… 0xc72513f9… 0xb47d9873… 0xd3ebd313… |
| 3 | uplink dropped | 1 | pass | 6 / 0 | 13457 | 12741 | 0x41f8c7ca… 0xf572f4b5… 0x7d397b85… 0xc7db2315… 0x4c68aaa5… 0x68439a6c… |
| 3 | uplink dropped | 2 | pass | 6 / 0 | 12948 | 12268 | 0x3e33181e… 0xc2c65f17… 0xffeae049… 0x5fd0ff5c… 0x32042607… 0x657287c7… |
| 3 | uplink dropped | 3 | pass | 8 / 0 | 12860 | 12579 | 0xdfd90cd1… 0x0a34a8eb… 0x23664392… 0xc90e12da… 0xfa34d0c9… 0x70a14c3c… 0x2c77df7b… 0xa1b74e9a… |
| 4 | box rebooted | 1 | pass | 7 / 0 | 12872 | 12157 | 0xe35c7941… 0x18c8364a… 0x609178a8… 0x97418cec… 0x83a5a987… 0xc0926ee9… 0x26f7043a… |
| 4 | box rebooted | 2 | pass | 4 / 0 | 13560 | 12465 | 0x1701c6f3… 0x3e9abea2… 0xc0b6065e… 0x321ec830… |
| 4 | box rebooted | 3 | pass | 5 / 0 | 12879 | 11818 | 0x6d73c380… 0xd7167339… 0x86e0193a… 0x5efd47f2… 0x00ecfd2b… |
| 5 | user stops paying | 1 | pass | 5 / 0 | 12879 | 12150 | 0x4fd957b9… 0xfbf4d61f… 0x5542bf75… 0x111c44ea… 0xf01426a5… |
| 5 | user stops paying | 2 | pass | 6 / 0 | 12883 | 12319 | 0x29868936… 0xd902182b… 0xb13f5274… 0xae203ce1… 0x3f3736e4… 0xbd34d22a… |
| 5 | user stops paying | 3 | pass | 5 / 0 | 13062 | 12536 | 0x3a6fa79f… 0x610e1bab… 0x42581695… 0xbc664587… 0x36e7097b… |
| 6 | user channel empty | 1 | pass | 2 / 2 | 12984 | 12847 | 0x99cb5e1b… 0xbcef2f93… |
| 6 | user channel empty | 2 | pass | 2 / 2 | 13259 | 12729 | 0x4b05118f… 0xae15a014… |
| 6 | user channel empty | 3 | **FAIL** | 1 / 0 | – | – | 0xa7a16e60… |

17 of 18 runs passed. Full data, including every payment hash and box log line: lab.json.
