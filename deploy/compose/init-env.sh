#!/bin/sh
# Creates .env for deploy/compose with random secrets, or adds what is missing. Never changes a value that is set.
# Usage: ./init-env.sh [domain]     (with a domain, public URLs use https://api.<domain> and friends)
set -eu
cd "$(dirname "$0")"
touch .env
chmod 600 .env
rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
set_default() { grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env; }

set_default POSTGRES_PASSWORD "$(rand 24)"
set_default S3_ACCESS_KEY "kodudb$(rand 7)"
set_default S3_SECRET_KEY "$(rand 30)"
if [ "${1:-}" != "" ]; then
  set_default DOMAIN "$1"
  set_default BIND_ADDRESS 127.0.0.1
  set_default TRUST_PROXY 1
  set_default KODUDB_PUBLIC_URL "https://api.$1"
  set_default S3_PUBLIC_URL "https://s3.$1"
  set_default S3_CONSOLE_URL "https://storage.$1/rustfs/console/"
fi
echo "wrote $(pwd)/.env"
