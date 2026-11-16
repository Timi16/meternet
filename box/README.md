# The MeterNet hotspot box

A Linux laptop (or Raspberry Pi) that broadcasts **MeterNet-demo** and sells
its internet 2 MB at a time, paid with Fiber on CKB testnet. A phone that
hasn't paid reaches only the box: its portal, its Fiber node and a CKB
testnet RPC proxy. Once a payment lands, openNDS lets the phone through.
When payments stop, the box cuts it off within 15 s of its paid data running out.

| Piece | Where | What it does |
|---|---|---|
| openNDS v11.0.0 | `linux/Dockerfile` (built from the pinned release, sha256-checked) | Captive portal and per-phone firewall; `ndsctl auth/deauth/json` |
| dnsmasq | same container | DHCP and DNS for the hotspot; answers the box's name with its own address |
| meterd (hotspot mode) | same container, `127.0.0.1:8400` | One meter per phone, keyed by MAC; invoices, payment polling, usage, cuts |
| FNN v0.9.1 | `linux/fnn.Dockerfile` (pinned release, unpatched) | The box's Fiber node; RPC on localhost, wss for phones on 8443 |
| Caddy 2.10.0 | `linux/caddy.Dockerfile`, `linux/Caddyfile` | HTTPS portal (443), wss (8443), `/ckb-rpc` proxy, openNDS's redirect (8080) |
| hostapd + NAT | `linux/wifi.sh` (compose profile `wifi`) | The access point on the laptop's Wi-Fi card |

The phone's side is `web/public/portal.html`: the same in-browser wallet as the
public Meter (official fiber-js), pointed at the box's node at runtime.

## Run it on a Linux laptop

You need Docker with the compose plugin, a Wi-Fi card that can run as an
access point (`iw list` shows `AP` under "Supported interface modes"), and a
second connection for the uplink (Ethernet, or USB tethering from a phone).

1. **Name and certificate** (once). The phone's wallet needs HTTPS. Make a free
   DuckDNS name pointing at the hotspot address, then get a certificate:

       cp box/.env.example box/.env        # DUCKDNS_DOMAIN, DUCKDNS_TOKEN, BOX_LAN_IP
       LE_ACCEPT_TOS=yes box/certs.sh       # writes box/certs/ (needs lego)

2. **Settings.**

       cp box/box.env.example box/box.env  # BOX_FQDN, GATEWAY_IFACE, BOX_LAN_IP, DEVICE_SALT

3. **Free the Wi-Fi card** from the desktop's network manager:

       nmcli device set wlan0 managed no

4. **Start.**

       docker compose --profile wifi up --build

   The box's FNN makes a testnet key in `box/data/fnn` on first start. Phones
   open the channel to it, so the box itself needs no CKB.

5. **Join** "MeterNet-demo" with a phone and open `https://<BOX_FQDN>`. The
   wallet needs testnet CKB before the first payment, and an unpaid phone
   can't reach the faucet through the hotspot, so fund it beforehand on mobile
   data (or have the host send some).

Logs (append-only JSON lines, hashed device IDs) are in `box/data/box/logs`.

## Test it without Wi-Fi hardware: the simulated phone

`sim/` puts a "phone" in a Linux network namespace on a virtual cable to the
box's hotspot interface. openNDS guards that cable exactly as it would a Wi-Fi
interface; the phone gets its address from the box's DHCP and pays from a
second FNN (`sim/payer.sh`) standing in for its browser wallet.

    sudo box/sim/phone-net.sh up                 # the phone and mn-gw (auto-teardown in 60 min)
    sudo box/sim/payer.sh start                  # the phone's wallet; fund it and open a channel to the box
    sudo docker run -d --name mn-box --network host --cap-add NET_ADMIN --cap-add NET_RAW \
      --env-file <box settings with GATEWAY_IFACE=mn-gw, LISTEN_HOST=10.42.0.1, EXTRA_ROUTER_PORTS=8400 8237> \
      -v /var/lib/meternet-box:/data -v /dev/log:/dev/log meternet-box:dev
    sudo ip netns exec phone node box/sim/phone.mjs stop --mb 6    # one run
    sudo node box/sim/lab.mjs /var/lib/meternet-lab/w3             # the failure lab: 6 scenarios x 3 runs

`lab.mjs` drives the phone, does the box-side failures itself (uplink drop,
reboot, channel run dry), and checks every run against H2 from both sides:
the box's own log (`t_gate_closed_ms - t_exhausted_ms`) and the phone's
network interface (when data last arrived). It writes `lab.md` and `lab.json`.

## What has been verified, and what hasn't

- **Verified** (simulated phone, real openNDS + meterd + FNN on CKB testnet):
  blocked before paying, online after the first payment, metered from
  openNDS's counters, cut within 15 s, and all six failure scenarios.
  Results: `evidence/week3/`.
- **Not yet:** a real phone on real Wi-Fi (`wifi` profile, hostapd), and the
  portal page in a phone's browser on the box. These need a Linux laptop with
  a Wi-Fi card that supports AP mode.

## openNDS on a generic Linux box: what it took

openNDS v11 targets OpenWrt. On Debian in a container, six things needed
handling (details in ARCHITECTURE.md, "openNDS facts"):

1. It only admits clients whose IP is in a DHCP lease file, so the box runs
   DHCP itself (dnsmasq) and points openNDS at its lease file.
2. It offloads authenticated connections to nftables flowtables, which
   bypass its own byte counters and keep offloaded connections alive after a
   deauth. The image removes the three `flow offload` rules at build time.
3. `sessiontimeout 0` logs a phone out at the next check when it's
   authenticated with `ndsctl auth`; the box uses 30 days and meterd re-opens
   a paid phone if openNDS ever drops it.
4. Its preemptive `ndsctl auth <mac>` takes the first neighbour entry for that
   MAC, which can be an old address; meterd authenticates by current IP.
5. It logs only to syslog (the container mounts `/dev/log`), and a container
   restart within 15 s finds its old heartbeat and refuses to start (the
   entrypoint clears its runtime files first).
6. Its watchdog checks its own web server with `wget` every 15 s. Without
   `wget` the check times out and `ndsctl` stalls ~4 s, enough to push a cut
   past 15 s (seen once in the lab: 15.4 s). The image installs `wget`.
