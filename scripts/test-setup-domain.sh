#!/usr/bin/env bash

set -Eeuo pipefail

readonly TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=setup-domain.sh
source "${TEST_DIR}/setup-domain.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
expect_valid() { VALIDATION_ERROR=''; "$1" "$2" || fail "Expected $1 to accept $2: ${VALIDATION_ERROR}"; }
expect_invalid() { VALIDATION_ERROR=''; if "$1" "$2"; then fail "Expected $1 to reject $2"; fi; }

expect_valid validate_domain 'es.mvphub.ir'
expect_valid validate_domain 'stream.example.com'
expect_invalid validate_domain 'https://stream.example.com'
expect_invalid validate_domain 'stream.example.com:443'
expect_invalid validate_domain 'localhost'
expect_valid validate_email 'admin@mvphub.ir'
expect_invalid validate_email 'admin'
expect_valid validate_optional_proxy ''
expect_valid validate_optional_proxy 'http://127.0.0.1:8118'
expect_invalid validate_optional_proxy 'socks5://127.0.0.1:1080'
[[ "$(domain_from_origin 'https://es.mvphub.ir')" == 'es.mvphub.ir' ]] || fail 'Origin parsing failed'
if domain_from_origin 'https://es.mvphub.ir:8443' >/dev/null 2>&1; then fail 'Custom origin port was accepted'; fi

fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT
DOMAIN='es.mvphub.ir'
ADMIN_EMAIL='admin@mvphub.ir'
write_caddy_config "${fixture}/Caddyfile"
grep -q '^es\.mvphub\.ir {$' "${fixture}/Caddyfile" || fail 'Domain missing from Caddyfile'
grep -q $'^\treverse_proxy 127\.0\.0\.1:8080$' "${fixture}/Caddyfile" || fail 'Upstream missing from Caddyfile'
grep -q $'^\temail admin@mvphub\.ir$' "${fixture}/Caddyfile" || fail 'Email missing from Caddyfile'

printf 'setup-domain helper tests: ok\n'
