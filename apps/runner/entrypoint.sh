#!/bin/sh
# Starts the Runner, trusting the CA that Cloudflare uses for the intercepted
# GitHub traffic of this Run. The CA exists only while interception is set up,
# so it is added at start, not in the image.
set -eu
intercept_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -r "$intercept_ca" ]; then
  bundle=/app/tls/ca-bundle.pem
  cat /etc/ssl/certs/ca-certificates.crt "$intercept_ca" > "$bundle"
  # gh and other Go programs, git, and Node.js each read their own setting.
  export SSL_CERT_FILE="$bundle" GIT_SSL_CAINFO="$bundle" \
    NODE_EXTRA_CA_CERTS="$intercept_ca"
fi
exec node /app/runner.cjs
