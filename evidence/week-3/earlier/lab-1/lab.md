| # | Scenario | Run | Result | Payments (ok / failed) | Exhausted → gate closed (ms) | Phone's last byte after exhausted (ms) | Payment hashes |
|---|---|---|---|---|---|---|---|
| 1 | tab closed | 1 | pass | 5 / 0 | 12882 | 12209 | 0x3d348feb… 0x4b2da9e0… 0xd97a44a2… 0xf5155348… 0x4162a5b1… |
| 1 | tab closed | 2 | pass | 5 / 0 | 13075 | 12426 | 0x07552d72… 0x99cb3bdc… 0x19935c93… 0xa8deef47… 0xf672bebf… |
| 1 | tab closed | 3 | pass | 5 / 0 | 12797 | 12654 | 0xf46aa3c1… 0x743666e0… 0xc0381942… 0xa5b28e83… 0xb07ffd65… |
| 2 | screen locked | 1 | pass | 6 / 0 | 13074, 12991 | 11999 | 0xa77484d7… 0x681ad1c4… 0xddb743f6… 0xb24705e9… 0xce189486… 0x74d49819… |
| 2 | screen locked | 2 | **FAIL** | 8 / 0 | 12907 | 12662 | 0x213f0a9e… 0x6d03e45a… 0x7ab84203… 0x7c2d2da0… 0x4e23ce78… 0xf4795b62… 0x3b093b52… 0xe7918455… |
| 2 | screen locked | 3 | **FAIL** | 5 / 0 | 13119 | 32710 | 0x8aebde92… 0xbc731b84… 0x5458a29d… 0x9b54c899… 0x8b63e303… |
| 3 | uplink dropped | 1 | **FAIL** | 9 / 0 | 12925 | 12355 | 0xce8785bb… 0x0937cf41… 0xce548627… 0x189859be… 0x3bda8873… 0xd7835ef1… 0xe5f2eb91… 0x17cc9d0d… 0x43fa78f3… |
| 3 | uplink dropped | 2 | pass | 5 / 0 | 13082 | 12611 | 0x7c1624cf… 0xc4a7a088… 0x75ae4013… 0xee02a0d3… 0x396cfe06… |
| 3 | uplink dropped | 3 | pass | 5 / 0 | 13613 | 12477 | 0x1ad9d43a… 0xb2fbc13c… 0xb403914a… 0xe64009ef… 0x1f5f0523… |
| 4 | box rebooted | 1 | pass | 3 / 0 | 13092 | 12710 | 0x44442dbc… 0x68d02d72… 0xd7609854… |
| 4 | box rebooted | 2 | pass | 5 / 0 | 13212 | 12448 | 0x946aeebc… 0x0b338892… 0x85ec39d1… 0x1367214d… 0x0d6a79af… |
| 4 | box rebooted | 3 | pass | 4 / 0 | 13077 | 12235 | 0x9b2db05f… 0xb0145c76… 0x08f9b432… 0xd3b3bf89… |
| 5 | user stops paying | 1 | pass | 7 / 0 | 12872 | 11513 | 0xfd749f0b… 0xc02004d4… 0xf16d8d30… 0x3bb15779… 0xbc3016f8… 0x1646b48a… 0xd0e7b986… |
| 5 | user stops paying | 2 | pass | 4 / 0 | 12990 | 12603 | 0x13aa4971… 0x2e23578f… 0x62f0d369… 0x2a5e27ed… |
| 5 | user stops paying | 3 | pass | 4 / 0 | 12944 | 12253 | 0x5c45eed9… 0x61188e58… 0x08660b2e… 0xb04f7f96… |
| 6 | user channel empty | 1 | pass | 2 / 3 | 12975 | 12687 | 0x94bcac35… 0xe11dd93f… |
| 6 | user channel empty | 2 | pass | 2 / 3 | 13432 | 12246 | 0xbc99f4ff… 0xc074c28f… |
| 6 | user channel empty | 3 | pass | 2 / 3 | 13118 | 12182 | 0x2a423a56… 0xb8071c3a… |

15 of 18 runs passed. Full data, including every payment hash and box log line: lab.json.
