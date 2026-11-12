#!/bin/sh
set -eu
# The ephemeral CA is mounted only after HTTPS intercept registration.
if [ "${TAILOS_REQUIRE_EGRESS_CA:-0}" = "1" ]; then
  test -s /etc/cloudflare/certs/cloudflare-containers-ca.crt
fi
if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates
  export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
fi
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --ambient-caps=-all node /app/runner.cjs
