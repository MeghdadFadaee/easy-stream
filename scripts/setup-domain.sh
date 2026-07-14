#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="${EASY_STREAM_PROJECT_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd -P)}"
readonly ENV_FILE="${PROJECT_ROOT}/.env"

VALIDATION_ERROR=''
DOMAIN=''
ADMIN_EMAIL=''
OUTBOUND_PROXY=''
CONFIG_BACKUP=''
declare -a ROOT_COMMAND=()
declare -a CLEANUP_FILES=()

cleanup() {
  local file
  for file in "${CLEANUP_FILES[@]:-}"; do
    [[ -n "${file}" ]] && rm -f -- "${file}"
  done
  return 0
}
trap cleanup EXIT

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
success() { printf '\033[1;32mOK:\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-domain.sh

Installs Caddy and publishes Easy Stream through automatic HTTPS. The script
reads defaults from .env, preserves an existing Caddyfile, and requires an
interactive confirmation before changing the server.
EOF
}

validation_failure() { VALIDATION_ERROR="$1"; return 1; }

validate_domain() {
  local value="$1"
  if [[ ! "${value}" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
    validation_failure 'Enter a hostname such as stream.example.com, without a scheme, path, or port.'
    return 1
  fi
}

validate_email() {
  local value="$1"
  if [[ ! "${value}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    validation_failure 'Enter a valid email address for certificate notices.'
    return 1
  fi
}

validate_optional_proxy() {
  local value="$1"
  local proxy_pattern='^https?://[^[:space:]"\\]+$'
  [[ -n "${value}" ]] || return 0
  if [[ ! "${value}" =~ ${proxy_pattern} ]]; then
    validation_failure 'Use an http:// or https:// proxy URL, or leave it blank.'
    return 1
  fi
}

prompt_value() {
  local destination="$1" label="$2" default_value="$3" validator="$4" value
  while true; do
    VALIDATION_ERROR=''
    if [[ -n "${default_value}" ]]; then
      read -r -p "${label} [${default_value}]: " value
      value="${value:-${default_value}}"
    else
      read -r -p "${label}: " value
    fi
    if "${validator}" "${value}"; then
      printf -v "${destination}" '%s' "${value}"
      return 0
    fi
    warn "${VALIDATION_ERROR:-Invalid value.}"
  done
}

confirm() {
  local prompt="$1" default_answer="${2:-no}" hint answer
  [[ "${default_answer}" == yes ]] && hint='Y/n' || hint='y/N'
  while true; do
    read -r -p "${prompt} [${hint}]: " answer
    answer="${answer:-${default_answer}}"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn 'Answer yes or no.' ;;
    esac
  done
}

read_env_value() {
  local key="$1" line value
  [[ -f "${ENV_FILE}" ]] || return 1
  line="$(grep -m1 -E "^${key}=" "${ENV_FILE}" || true)"
  [[ -n "${line}" ]] || return 1
  value="${line#*=}"
  if [[ "${value}" == "'"*"'" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == '"'*'"' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s\n' "${value}"
}

domain_from_origin() {
  local origin="$1" authority
  [[ "${origin}" == https://* ]] || return 1
  authority="${origin#https://}"
  [[ "${authority}" != *'/'* && "${authority}" != *':'* ]] || return 1
  validate_domain "${authority}" || return 1
  printf '%s\n' "${authority}"
}

initialize_privilege() {
  if ((EUID == 0)); then
    ROOT_COMMAND=()
  else
    command -v sudo >/dev/null || die 'sudo is required when not running as root.'
    sudo -v
    ROOT_COMMAND=(sudo)
  fi
}

run_root() {
  if ((${#ROOT_COMMAND[@]} == 0)); then "$@"; else "${ROOT_COMMAND[@]}" "$@"; fi
}

run_root_network() {
  if [[ -n "${OUTBOUND_PROXY}" ]]; then
    run_root env \
      HTTP_PROXY="${OUTBOUND_PROXY}" HTTPS_PROXY="${OUTBOUND_PROXY}" \
      http_proxy="${OUTBOUND_PROXY}" https_proxy="${OUTBOUND_PROXY}" \
      NO_PROXY='localhost,127.0.0.1' no_proxy='localhost,127.0.0.1' "$@"
  else
    run_root "$@"
  fi
}

download() {
  local url="$1" destination="$2"
  if [[ -n "${OUTBOUND_PROXY}" ]]; then
    curl --fail --location --silent --show-error --retry 4 --retry-all-errors \
      --connect-timeout 30 --max-time 300 --proxy "${OUTBOUND_PROXY}" \
      --output "${destination}" "${url}"
  else
    curl --fail --location --silent --show-error --retry 4 --retry-all-errors \
      --connect-timeout 30 --max-time 300 --output "${destination}" "${url}"
  fi
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    success "Caddy is already installed ($(caddy version | head -n1))."
    return 0
  fi

  info "Installing Caddy from Caddy's official Ubuntu repository"
  run_root_network env DEBIAN_FRONTEND=noninteractive apt-get update
  run_root_network env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl debian-archive-keyring debian-keyring gpg

  local key_tmp repository_tmp
  key_tmp="$(mktemp)"
  repository_tmp="$(mktemp)"
  CLEANUP_FILES+=("${key_tmp}" "${repository_tmp}")
  download 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' "${key_tmp}"
  download 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' "${repository_tmp}"
  run_root gpg --batch --yes --dearmor --output /usr/share/keyrings/caddy-stable-archive-keyring.gpg "${key_tmp}"
  run_root install -m 0644 "${repository_tmp}" /etc/apt/sources.list.d/caddy-stable.list
  run_root_network env DEBIAN_FRONTEND=noninteractive apt-get update
  run_root_network env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  success "Installed $(caddy version | head -n1)."
}

write_proxy_override() {
  local override_dir='/etc/systemd/system/caddy.service.d'
  local override_file="${override_dir}/easy-stream-proxy.conf"
  if [[ -n "${OUTBOUND_PROXY}" ]]; then
    local temporary
    temporary="$(mktemp)"
    CLEANUP_FILES+=("${temporary}")
    cat > "${temporary}" <<EOF
[Service]
Environment="HTTP_PROXY=${OUTBOUND_PROXY}"
Environment="HTTPS_PROXY=${OUTBOUND_PROXY}"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
    run_root install -d -m 0755 "${override_dir}"
    run_root install -m 0600 "${temporary}" "${override_file}"
  elif [[ -f "${override_file}" ]]; then
    run_root rm -f -- "${override_file}"
  fi
  run_root systemctl daemon-reload
}

write_caddy_config() {
  local destination="$1"
  cat > "${destination}" <<EOF
{
	email ${ADMIN_EMAIL}
}

${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
	header -Server
}
EOF
}

install_configuration() {
  info "Configuring automatic HTTPS for ${DOMAIN}"
  local temporary='/etc/caddy/Caddyfile.easy-stream.tmp'
  local candidate
  candidate="$(mktemp)"
  CLEANUP_FILES+=("${candidate}")
  write_caddy_config "${candidate}"
  run_root install -m 0644 "${candidate}" "${temporary}"
  run_root caddy validate --config "${temporary}" --adapter caddyfile >/dev/null \
    || die 'Caddy rejected the generated configuration; the active configuration was not changed.'

  if [[ -f /etc/caddy/Caddyfile ]]; then
    CONFIG_BACKUP="/etc/caddy/Caddyfile.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
    run_root cp -p /etc/caddy/Caddyfile "${CONFIG_BACKUP}"
  fi
  run_root mv -f "${temporary}" /etc/caddy/Caddyfile
  if ! run_root caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
    [[ -n "${CONFIG_BACKUP}" ]] && run_root cp -p "${CONFIG_BACKUP}" /etc/caddy/Caddyfile
    die 'Caddy validation failed after installation; the previous configuration was restored.'
  fi
  [[ -z "${CONFIG_BACKUP}" ]] || success "Preserved the previous Caddyfile at ${CONFIG_BACKUP}."
}

configure_firewall() {
  command -v ufw >/dev/null 2>&1 || return 0
  local status
  status="$(run_root ufw status | head -n1)"
  [[ "${status}" == *active* && "${status}" != *inactive* ]] || return 0
  if confirm 'UFW is active. Allow public HTTP and HTTPS traffic?' yes; then
    run_root ufw allow 80/tcp
    run_root ufw allow 443/tcp
  else
    warn 'Ports 80 and 443 were not opened; automatic certificate issuance may fail.'
  fi
}

check_gateway() {
  command -v curl >/dev/null || die 'curl is required.'
  curl --noproxy '*' --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/ >/dev/null \
    || die 'Easy Stream is not responding at http://127.0.0.1:8080. Start the Compose stack first.'
  success 'Easy Stream gateway is responding on 127.0.0.1:8080.'
}

check_public_ports() {
  command -v ss >/dev/null 2>&1 || return 0
  local listeners
  listeners="$(run_root ss -H -ltnp 2>/dev/null | awk '$4 ~ /:80$|:443$/ { print }')"
  [[ -z "${listeners}" ]] && return 0
  if command -v caddy >/dev/null 2>&1 && grep -qi caddy <<< "${listeners}"; then
    return 0
  fi
  warn 'Another process already listens on public HTTP/HTTPS ports:'
  printf '%s\n' "${listeners}" >&2
  die 'Stop or reconfigure that reverse proxy before installing Caddy; the existing service was not changed.'
}

main() {
  if (($# > 0)); then
    case "$1" in -h|--help) usage; return 0 ;; *) die "Unknown option: $1" ;; esac
  fi
  [[ -t 0 && -t 1 ]] || die 'Run this script from an interactive terminal.'
  [[ -r /etc/os-release ]] || die 'Cannot identify this operating system.'
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || die 'This domain setup supports Ubuntu only.'

  local origin default_domain default_email default_proxy
  origin="${EASY_STREAM_DOMAIN_ORIGIN:-$(read_env_value PUBLIC_ORIGIN || true)}"
  default_domain="$(domain_from_origin "${origin}" 2>/dev/null || true)"
  default_email="${EASY_STREAM_ADMIN_EMAIL:-$(read_env_value ADMIN_BOOTSTRAP_EMAIL || true)}"
  default_proxy="${EASY_STREAM_OUTBOUND_PROXY:-$(read_env_value BUILD_HTTP_PROXY || true)}"

  info 'Public domain and automatic HTTPS'
  prompt_value DOMAIN 'Public domain' "${default_domain}" validate_domain
  prompt_value ADMIN_EMAIL 'Certificate notification email' "${default_email}" validate_email
  prompt_value OUTBOUND_PROXY 'Host outbound HTTP(S) proxy (optional)' "${default_proxy}" validate_optional_proxy
  printf '\nDomain:          %s\nUpstream:        http://127.0.0.1:8080\nHTTPS:           automatic (Caddy)\nOutbound proxy:  %s\n' \
    "${DOMAIN}" "$([[ -n "${OUTBOUND_PROXY}" ]] && printf enabled || printf disabled)"
  warn 'DNS must point to this server, and provider/network firewalls must allow inbound TCP 80 and 443.'
  confirm 'Install and activate this public HTTPS endpoint?' no || die 'Domain setup cancelled without changes.'

  initialize_privilege
  check_gateway
  check_public_ports
  install_caddy
  write_proxy_override
  install_configuration
  configure_firewall
  run_root systemctl enable --now caddy.service
  run_root systemctl reload caddy.service
  success "Caddy is active. Open https://${DOMAIN}/ and https://${DOMAIN}/admin."
  printf 'Certificate status: journalctl -u caddy --since "10 minutes ago" --no-pager\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
