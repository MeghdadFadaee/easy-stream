#!/usr/bin/env bash

set -Eeuo pipefail

readonly TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=setup-ubuntu.sh
source "${TEST_DIR}/setup-ubuntu.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

expect_valid() {
  local function_name="$1"
  local value="$2"
  VALIDATION_ERROR=''
  "${function_name}" "${value}" || fail "Expected ${function_name} to accept ${value}: ${VALIDATION_ERROR}"
}

expect_invalid() {
  local function_name="$1"
  local value="$2"
  VALIDATION_ERROR=''
  if "${function_name}" "${value}"; then
    fail "Expected ${function_name} to reject ${value}"
  fi
}

expect_valid validate_origin 'https://stream.example.com'
expect_valid validate_origin 'https://stream.example.com:8443'
expect_invalid validate_origin 'http://stream.example.com'
expect_invalid validate_origin 'https://stream.example.com/media'
expect_invalid validate_origin 'https://stream.example.com/'
expect_invalid validate_origin 'https://stream.example.com:0'
expect_invalid validate_origin 'https://stream.example.com:70000'
expect_valid validate_bind_address '127.0.0.1'
expect_valid validate_bind_address '10.10.0.12'
expect_invalid validate_bind_address '999.10.0.12'
expect_invalid validate_bind_address 'localhost'

expect_valid validate_postgres_password 'safe_database_password_1234'
expect_invalid validate_postgres_password 'short'
expect_invalid validate_postgres_password 'unsafe:database@password/value'
expect_valid validate_safe_secret '0123456789abcdefghijklmnopqrstuvwxyz_ABCD'
expect_invalid validate_safe_secret 'contains.a.dot.and.is.not_base64url_safe'
expect_valid validate_admin_password 'A-real-admin-password!'
expect_invalid validate_admin_password 'change-me-before-production'

expect_valid validate_absolute_path '/srv/easy-stream/cache'
expect_invalid validate_absolute_path 'relative/cache'
expect_invalid validate_absolute_path '/srv/easy-stream/cache:bad'
path_is_within '/srv/easy-stream' '/srv/easy-stream/cache' \
  || fail 'Expected nested path detection to succeed'
if path_is_within '/srv/easy-stream/cache' '/srv/easy-stream-derived'; then
  fail 'Path prefix without a separator must not count as nested'
fi

[[ "$(env_quote 'hello world')" == "'hello world'" ]] \
  || fail 'Environment quoting changed unexpectedly'
[[ "$(generate_secret)" =~ ^[a-f0-9]{64}$ ]] \
  || fail 'Generated secret is not 256-bit lowercase hex'

fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT
EASY_STREAM_PROJECT_ROOT="${fixture}" bash -c '
  set -Eeuo pipefail
  source "$1"
  PUBLIC_ORIGIN=https://stream.example.com
  GATEWAY_BIND_ADDRESS=127.0.0.1
  POSTGRES_PASSWORD=safe_database_password_1234
  ARCHIVE_ROOT=/srv/easy-stream/archive
  CACHE_ROOT=/srv/easy-stream/cache
  DERIVED_ROOT=/srv/easy-stream/derived
  METADATA_ROOT=/srv/easy-stream/metadata
  PLAYBACK_SIGNING_SECRET=0123456789abcdefghijklmnopqrstuvwxyz_ABCD
  MEDIA_AUTH_SHARED_SECRET=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc
  PLAYBACK_TTL_SECONDS=14400
  ADMIN_BOOTSTRAP_EMAIL=admin@example.com
  ADMIN_BOOTSTRAP_PASSWORD="A-real-admin-password!"
  TMDB_API_TOKEN=""
  TMDB_COMMERCIAL_LICENSE_CONFIRMED=false
  JIT_REMUX_CONCURRENCY=2
  CACHE_MAX_BYTES=2147483648000
  write_environment >/dev/null
  test -f "$EASY_STREAM_PROJECT_ROOT/.env"
  if permissions="$(stat -c %a "$EASY_STREAM_PROJECT_ROOT/.env" 2>/dev/null)"; then
    : # GNU stat (Ubuntu)
  else
    permissions="$(stat -f %Lp "$EASY_STREAM_PROJECT_ROOT/.env")" # BSD stat (macOS)
  fi
  if test "$permissions" != 600; then
    printf "Expected generated .env mode 600, got %s\n" "$permissions" >&2
    exit 1
  fi
  test "$(grep -c "^PLAYBACK_TTL_SECONDS=" "$EASY_STREAM_PROJECT_ROOT/.env")" -eq 1
  grep -q "^NODE_ENV=production$" "$EASY_STREAM_PROJECT_ROOT/.env"
  grep -q "^PUBLIC_ORIGIN='"'"'https://stream.example.com'"'"'$" "$EASY_STREAM_PROJECT_ROOT/.env"
  grep -q "^MEDIA_PUBLIC_BASE_URL='"'"'https://stream.example.com/media'"'"'$" "$EASY_STREAM_PROJECT_ROOT/.env"
  grep -q "^GATEWAY_BIND_ADDRESS='"'"'127.0.0.1'"'"'$" "$EASY_STREAM_PROJECT_ROOT/.env"
  cp "$EASY_STREAM_PROJECT_ROOT/.env" "$EASY_STREAM_PROJECT_ROOT/expected.env"
  PUBLIC_ORIGIN=https://new.example.com
  write_environment >/dev/null
  test -n "$ENV_BACKUP"
  cmp -s "$ENV_BACKUP" "$EASY_STREAM_PROJECT_ROOT/expected.env"
  restore_environment >/dev/null 2>&1
  cmp -s "$EASY_STREAM_PROJECT_ROOT/.env" "$EASY_STREAM_PROJECT_ROOT/expected.env"
' bash "${TEST_DIR}/setup-ubuntu.sh" || fail 'Environment writer integration test failed'

printf 'setup-ubuntu helper tests: ok\n'
