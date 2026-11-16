# Draft upstream issues for openNDS (not filed yet)

Found while running openNDS v11.0.0 on generic Linux (Debian bookworm in a
container, nftables) for the MeterNet hotspot box. Each has a workaround in
this repo; these drafts are for github.com/openNDS/openNDS.

---

## 1. Flowtable offload bypasses per-client counters (and quotas), and outlives deauth

**Version:** v11.0.0, generic Linux, nftables, software flowtables.

**What happens.** `libopennds.sh gatewaycheck` always adds
`meta l4proto { tcp, udp } flow offload @ndsftOUT` (nds_filter, nds_ft_OUT)
and the same for `@ndsftINC` (nds_mangle, nds_ft_INC). Once a connection is
offloaded, its packets skip the forward and mangle chains, so:

- the per-client counters behind `ndsctl json` (`download_this_session`,
  `upload_this_session`) stop counting: a client downloading 60 MB showed
  about 7.7 MB;
- `downloadquota` / `uploadquota` are enforced against those counters, so
  they can't trigger;
- after `ndsctl deauth`, connections already offloaded keep flowing until
  the flow times out.

**Expected.** Counters and quotas that match the traffic, and deauth that
stops it, or an option to turn offload off when they matter.

**Workaround.** Delete the three `nft add rule … flow offload …` lines from
`libopennds.sh` at install time (`box/linux/Dockerfile`). Counters, quotas and
deauth then behave.

**Suggestion.** A config option (e.g. `option flowoffload '0'`), or skip
offload when quotas or rate limits are set.

---

## 2. `sessiontimeout 0` logs clients out at once when they are authenticated with `ndsctl auth`

**Version:** v11.0.0.

**What happens.** With `option sessiontimeout '0'` (documented as no
limit), a client authenticated with `ndsctl auth <ip|mac>` is deauthenticated
at the next `checkinterval`: "Session end time reached, deauthenticating …
connected: 17". In `auth.c`, `auth_change_state` sets
`client->session_end = now + sessionseconds_config` when no BinAuth value is
given, so 0 gives `session_end = now`. `ndsctl_auth` itself handles 0 as
"no end" (`session_end = 0`), but `auth_change_state` then overwrites it.

**Expected.** 0 means no session limit on every authentication path.

**Workaround.** A large `sessiontimeout` (we use 43200 minutes).

---

## Smaller things worth a docs line

- `client_list_add_client` refuses clients whose IP isn't in the DHCP lease
  file (`dhcp_check`). Static-IP clients get 403 on captive probes and can't
  be authenticated, with only a NOTICE in syslog ("IP not allocated by dhcp").
- Preemptive `ndsctl auth <mac>` takes the first `ip neigh` line for that MAC;
  with a stale neighbour entry from an earlier address it picks the wrong IP
  (which then fails the DHCP check). Authenticating by IP avoids it.
- `ndsctl auth` prints "No" for an already-authenticated client, the same as
  for an unknown one.
- `opennds -f` refuses to start for `checkinterval` seconds after a previous
  instance's last heartbeat (`/tmp/ndscids/heartbeat`), e.g. on a quick
  container restart.
- Logs go only to syslog (`debug.c`), so without `/dev/log` nothing is logged
  at all.
- The MHD watchdog needs `wget` or `uclient-fetch`; with neither, every check
  fails after a timeout and openNDS restarts its web server each
  `checkinterval`, blocking `ndsctl` for ~4 s. A startup check (or a clear
  error) for the missing tool would help on generic Linux.
