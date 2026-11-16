#!/usr/bin/env bash
# Gets or renews the box's free Let's Encrypt certificate for
# <DUCKDNS_DOMAIN>.duckdns.org with a DNS-01 challenge through DuckDNS, so the
# box needs no public address. Phones need HTTPS for the browser wallet
# (FIBER_NOTES F-007). Works on macOS and Linux; needs lego v5.
#
#   LE_ACCEPT_TOS=yes box/certs.sh            # real certificate
#   LE_ACCEPT_TOS=yes STAGING=1 box/certs.sh  # Let's Encrypt staging (test only; phones won't trust it)
#
# LE_ACCEPT_TOS=yes means you accept the Let's Encrypt Subscriber Agreement
# (https://letsencrypt.org/repository/). No email address is sent.
# Reads DUCKDNS_TOKEN and DUCKDNS_DOMAIN from box/.env. Writes into box/certs/
# (git-ignored). Run it again to renew; lego decides when renewal is due.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/.env" ] || { echo "Missing box/.env: copy box/.env.example and fill it in." >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. "$HERE/.env"
set +a
: "${DUCKDNS_TOKEN:?set DUCKDNS_TOKEN in box/.env}" "${DUCKDNS_DOMAIN:?set DUCKDNS_DOMAIN in box/.env}"
[ "${LE_ACCEPT_TOS:-}" = "yes" ] || { echo "Set LE_ACCEPT_TOS=yes to accept the Let's Encrypt Subscriber Agreement." >&2; exit 1; }
command -v lego >/dev/null || { echo "Install lego v5 first (macOS: brew install lego)." >&2; exit 1; }

DOMAIN="$DUCKDNS_DOMAIN.duckdns.org"
SERVER=letsencrypt
OUT="$HERE/certs"
if [ -n "${STAGING:-}" ]; then SERVER=letsencrypt-staging; OUT="$HERE/certs-staging"; fi
mkdir -p "$OUT"
chmod 700 "$OUT"

export DUCKDNS_TOKEN
# DuckDNS has one TXT record per account and its DNS can be slow to update.
export DUCKDNS_PROPAGATION_TIMEOUT=${DUCKDNS_PROPAGATION_TIMEOUT:-180}
# lego confirms the TXT record through public resolvers before asking Let's
# Encrypt to check it. Its fallback, Cloudflare's 1.1.1.1, times out on some
# networks (it did from Lagos on 2026-11-16), so use Google's by default.
RESOLVERS=${DNS_RESOLVERS:-8.8.8.8:53,8.8.4.4:53}
lego run --accept-tos --server "$SERVER" --dns duckdns --dns.resolvers "$RESOLVERS" -d "$DOMAIN" --path "$OUT"
echo "Certificate for $DOMAIN is in $OUT"
find "$OUT" -name "$DOMAIN.crt" -o -name "$DOMAIN.key" | sed 's/^/  /'
