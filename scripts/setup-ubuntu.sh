#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEFAULT_PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly PROJECT_ROOT="${EASY_STREAM_PROJECT_ROOT:-${DEFAULT_PROJECT_ROOT}}"
readonly ENV_FILE="${PROJECT_ROOT}/.env"

NO_START=false
SKIP_DOCKER_INSTALL=false
VALIDATION_ERROR=''
CREATE_ARCHIVE=false
ENV_BACKUP=''
declare -a ROOT_COMMAND=()
declare -a DOCKER_COMMAND=()
declare -a CLEANUP_FILES=()

cleanup() {
  local file
  for file in "${CLEANUP_FILES[@]:-}"; do
    [[ -n "${file}" ]] && rm -f -- "${file}"
  done
  return 0
}
trap cleanup EXIT

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

success() {
  printf '\033[1;32mOK:\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-ubuntu.sh [options]

Interactively configures Easy Stream on a fresh Ubuntu server.

Options:
  --no-start             Write and validate configuration without building/starting containers.
  --skip-docker-install  Require an existing Docker Engine + Compose plugin installation.
  -h, --help             Show this help.

The script must run from an interactive terminal. It never prints entered secrets.
EOF
}

validation_failure() {
  VALIDATION_ERROR="$1"
  return 1
}

validate_nonempty() {
  [[ -n "$1" ]] || validation_failure 'A value is required.'
}

validate_env_string() {
  local value="$1"
  [[ -n "${value}" ]] || return 0
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    validation_failure 'Line breaks are not allowed.'
    return 1
  fi
  if [[ "${value}" == *"'"* ]]; then
    validation_failure "Single quotes are not supported in generated .env values."
    return 1
  fi
}

validate_origin() {
  local value="$1"
  local authority port
  if [[ "${value}" != https://* ]]; then
    validation_failure 'Use an HTTPS origin, for example https://stream.example.com.'
    return 1
  fi
  authority="${value#https://}"
  if [[ -z "${authority}" || "${authority}" == *'/'* || "${authority}" == *'?'* \
    || "${authority}" == *'#'* || "${authority}" == *' '* ]]; then
    validation_failure 'Enter only the origin, without a path, query, fragment, or trailing slash.'
    return 1
  fi
  if [[ ! "${authority}" =~ ^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]]; then
    validation_failure 'The HTTPS hostname or optional port is invalid.'
    return 1
  fi
  if [[ "${authority}" =~ :([0-9]{1,5})$ ]]; then
    port="${BASH_REMATCH[1]}"
    if ((10#${port} < 1 || 10#${port} > 65535)); then
      validation_failure 'The HTTPS port must be between 1 and 65535.'
      return 1
    fi
  fi
}

validate_email() {
  local value="$1"
  if [[ ! "${value}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    validation_failure 'Enter a valid administrator email address.'
    return 1
  fi
  if ((${#value} > 320)); then
    validation_failure 'The email address is too long.'
    return 1
  fi
  validate_env_string "${value}"
}

validate_bind_address() {
  local value="$1"
  local -a octets=()
  local octet
  local IFS='.'
  read -r -a octets <<< "${value}"
  ((${#octets[@]} == 4)) \
    || validation_failure 'Enter an IPv4 bind address such as 127.0.0.1, 0.0.0.0, or a private interface address.'
  ((${#octets[@]} == 4)) || return 1
  for octet in "${octets[@]}"; do
    if [[ ! "${octet}" =~ ^[0-9]{1,3}$ ]] || ((10#${octet} > 255)); then
      validation_failure 'Enter a valid IPv4 bind address.'
      return 1
    fi
  done
}

validate_absolute_path() {
  local value="$1"
  if [[ "${value}" != /* ]]; then
    validation_failure 'Use an absolute filesystem path.'
    return 1
  fi
  if [[ "${value}" == '/' ]]; then
    validation_failure 'The filesystem root cannot be used here.'
    return 1
  fi
  if [[ "${value}" == *:* ]]; then
    validation_failure 'Colon is not supported in Docker bind-mount paths.'
    return 1
  fi
  validate_env_string "${value}"
}

validate_positive_integer() {
  local value="$1"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] \
    || validation_failure 'Enter a positive whole number.'
}

validate_concurrency() {
  local value="$1"
  validate_positive_integer "${value}" || return 1
  ((value <= 64)) || validation_failure 'Concurrency must be 64 or lower.'
}

validate_cache_gib() {
  local value="$1"
  validate_positive_integer "${value}" || return 1
  ((value >= 10 && value <= 1048576)) \
    || validation_failure 'Cache capacity must be between 10 GiB and 1 PiB.'
}

validate_ttl() {
  local value="$1"
  validate_positive_integer "${value}" || return 1
  ((value >= 300 && value <= 86400)) \
    || validation_failure 'Playback TTL must be between 300 and 86400 seconds.'
}

validate_postgres_password() {
  local value="$1"
  if ((${#value} < 24)); then
    validation_failure 'Use at least 24 characters.'
    return 1
  fi
  if [[ ! "${value}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    validation_failure 'Use only letters, digits, underscore, and hyphen (the value is embedded in a database URL).'
    return 1
  fi
}

validate_safe_secret() {
  local value="$1"
  if ((${#value} < 32)); then
    validation_failure 'Use at least 32 characters.'
    return 1
  fi
  if [[ ! "${value}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    validation_failure 'Use only base64url-safe letters, digits, underscore, and hyphen.'
    return 1
  fi
}

validate_admin_password() {
  local value="$1"
  if ((${#value} < 12)); then
    validation_failure 'Use at least 12 characters.'
    return 1
  fi
  if [[ "${value}" == 'change-me-before-production' ]]; then
    validation_failure 'The example password is forbidden.'
    return 1
  fi
  validate_env_string "${value}"
}

validate_optional_token() {
  validate_env_string "$1"
}

prompt_value() {
  local destination="$1"
  local label="$2"
  local default_value="$3"
  local validator="$4"
  local value
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

prompt_secret() {
  local destination="$1"
  local label="$2"
  local validator="$3"
  local allow_generate="$4"
  local value confirmation
  while true; do
    VALIDATION_ERROR=''
    if [[ "${allow_generate}" == true ]]; then
      read -r -s -p "${label} (leave blank to generate): " value
    else
      read -r -s -p "${label}: " value
    fi
    printf '\n'
    if [[ -z "${value}" && "${allow_generate}" == true ]]; then
      value="$(generate_secret)"
      printf -v "${destination}" '%s' "${value}"
      return 0
    fi
    if ! "${validator}" "${value}"; then
      warn "${VALIDATION_ERROR:-Invalid value.}"
      continue
    fi
    read -r -s -p "Confirm ${label}: " confirmation
    printf '\n'
    if [[ "${value}" != "${confirmation}" ]]; then
      warn 'Values did not match; please try again.'
      continue
    fi
    printf -v "${destination}" '%s' "${value}"
    return 0
  done
}

confirm() {
  local prompt="$1"
  local default_answer="${2:-no}"
  local hint answer
  if [[ "${default_answer}" == yes ]]; then
    hint='Y/n'
  else
    hint='y/N'
  fi
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

generate_secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

canonical_path() {
  local input="$1"
  if realpath -m -- "${input}" 2>/dev/null; then
    return 0
  fi
  # BSD realpath (useful when testing the helpers on macOS) has no -m. Resolve
  # the nearest existing parent and append missing components. Ubuntu always
  # takes the GNU realpath branch above.
  local probe suffix=''
  probe="${input%/}"
  [[ -n "${probe}" ]] || probe='/'
  while [[ ! -e "${probe}" && "${probe}" != '/' ]]; do
    suffix="/$(basename -- "${probe}")${suffix}"
    probe="$(dirname -- "${probe}")"
  done
  printf '%s%s\n' "$(realpath -- "${probe}")" "${suffix}"
}

path_is_within() {
  local root candidate
  root="$(canonical_path "$1")"
  candidate="$(canonical_path "$2")"
  [[ "${candidate}" == "${root}" || "${candidate}" == "${root}/"* ]]
}

assert_separate_paths() {
  local -a labels=('archive' 'cache' 'derived' 'metadata')
  local -a values=("${ARCHIVE_ROOT}" "${CACHE_ROOT}" "${DERIVED_ROOT}" "${METADATA_ROOT}")
  local left right
  for ((left = 0; left < ${#values[@]}; left += 1)); do
    for ((right = left + 1; right < ${#values[@]}; right += 1)); do
      if path_is_within "${values[left]}" "${values[right]}" \
        || path_is_within "${values[right]}" "${values[left]}"; then
        die "${labels[left]} and ${labels[right]} paths must not overlap: ${values[left]} / ${values[right]}"
      fi
    done
  done
  for ((left = 1; left < ${#values[@]}; left += 1)); do
    if path_is_within "${values[left]}" "${PROJECT_ROOT}"; then
      die "The ${labels[left]} root must not contain the project checkout: ${values[left]}"
    fi
  done
}

env_quote() {
  local value="$1"
  validate_env_string "${value}" || die "Cannot write .env value: ${VALIDATION_ERROR}"
  printf "'%s'" "${value}"
}

write_env_pair() {
  local destination="$1"
  local key="$2"
  local value="$3"
  printf '%s=%s\n' "${key}" "$(env_quote "${value}")" >> "${destination}"
}

check_host() {
  [[ -r /etc/os-release ]] || die 'Cannot identify this operating system.'
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || die 'This bootstrap script supports Ubuntu only.'
  [[ -n "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ]] \
    || die 'Ubuntu release codename is missing from /etc/os-release.'
  command -v apt-get >/dev/null || die 'apt-get is required.'
  command -v systemctl >/dev/null || die 'systemd is required.'
  command -v realpath >/dev/null || die 'GNU realpath is required.'
  [[ -f "${PROJECT_ROOT}/compose.yaml" && -f "${PROJECT_ROOT}/.env.example" ]] \
    || die "Run this script from a complete Easy Stream checkout (${PROJECT_ROOT})."
  success "Detected Ubuntu ${VERSION_ID:-unknown} (${UBUNTU_CODENAME:-${VERSION_CODENAME}})."
}

initialize_privilege() {
  if ((EUID == 0)); then
    ROOT_COMMAND=()
    return 0
  fi
  command -v sudo >/dev/null || die 'sudo is required when not running as root.'
  info 'Requesting sudo access for package installation and host directories'
  sudo -v
  ROOT_COMMAND=(sudo)
}

run_root() {
  if ((${#ROOT_COMMAND[@]} == 0)); then
    "$@"
  else
    "${ROOT_COMMAND[@]}" "$@"
  fi
}

docker_cli_available() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker() {
  if docker_cli_available; then
    run_root systemctl enable --now docker.service
    success 'Docker Engine CLI and Compose plugin are already installed.'
    return 0
  fi
  if [[ "${SKIP_DOCKER_INSTALL}" == true ]]; then
    die 'Docker Engine with the Compose plugin is required, but --skip-docker-install was used.'
  fi

  info "Installing Docker Engine from Docker's official Ubuntu apt repository"
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl

  local -a conflicting=()
  local package status
  for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    status="$(dpkg-query -W -f='${db:Status-Abbrev}' "${package}" 2>/dev/null || true)"
    [[ "${status}" == ii* ]] && conflicting+=("${package}")
  done
  if ((${#conflicting[@]} > 0)); then
    warn "Conflicting distribution packages are installed: ${conflicting[*]}"
    confirm 'Remove these packages before installing official Docker Engine?' no \
      || die 'Docker installation cancelled; remove conflicting packages manually or rerun with an existing supported Docker installation.'
    run_root env DEBIAN_FRONTEND=noninteractive apt-get remove -y "${conflicting[@]}"
  fi

  local key_tmp sources_tmp codename architecture
  key_tmp="$(mktemp)"
  sources_tmp="$(mktemp)"
  CLEANUP_FILES+=("${key_tmp}" "${sources_tmp}")
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "${key_tmp}"
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME}}"
  architecture="$(dpkg --print-architecture)"
  cat > "${sources_tmp}" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  run_root install -m 0755 -d /etc/apt/keyrings
  run_root install -m 0644 "${key_tmp}" /etc/apt/keyrings/docker.asc
  run_root install -m 0644 "${sources_tmp}" /etc/apt/sources.list.d/docker.sources
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable --now docker.service containerd.service
  run_root docker compose version >/dev/null
  success 'Docker Engine and the Compose plugin are installed and enabled.'
}

select_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER_COMMAND=(docker)
  elif run_root docker info >/dev/null 2>&1; then
    DOCKER_COMMAND=("${ROOT_COMMAND[@]}" docker)
    warn 'Docker commands require sudo for this user. The script does not add users to the root-equivalent docker group.'
  else
    die 'Docker daemon is not reachable after installation.'
  fi
}

prepare_directories() {
  info 'Preparing read-only archive and writable media directories'
  if [[ "${CREATE_ARCHIVE}" == true ]]; then
    run_root install -d -o 1000 -g 1000 -m 0750 "${ARCHIVE_ROOT}"
  fi
  [[ -d "${ARCHIVE_ROOT}" ]] || die "Archive directory does not exist: ${ARCHIVE_ROOT}"

  local directory
  for directory in "${CACHE_ROOT}" "${DERIVED_ROOT}" "${METADATA_ROOT}"; do
    [[ ! -L "${directory}" ]] || die "Writable roots cannot be symlinks: ${directory}"
    run_root install -d -o 1000 -g 1000 -m 0750 "${directory}"
  done

  if command -v setpriv >/dev/null 2>&1; then
    if ! run_root setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/test -r "${ARCHIVE_ROOT}" \
      || ! run_root setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/test -x "${ARCHIVE_ROOT}"; then
      warn 'Container UID/GID 1000 cannot read/traverse the archive root. Adjust mount ownership or ACLs before scanning.'
    fi
  fi

  if command -v findmnt >/dev/null 2>&1; then
    local mount_options
    mount_options="$(findmnt -no OPTIONS --target "${ARCHIVE_ROOT}" 2>/dev/null || true)"
    if [[ -n "${mount_options}" && ",${mount_options}," != *,ro,* ]]; then
      warn 'The host archive filesystem is writable. Compose still mounts it read-only, but a read-only host mount is safer.'
    fi
  fi

  local available_bytes
  available_bytes="$(df --output=avail -B1 "${CACHE_ROOT}" | tail -n 1 | tr -d ' ')"
  if [[ "${available_bytes}" =~ ^[0-9]+$ ]] && ((available_bytes < CACHE_MAX_BYTES)); then
    warn "Cache limit (${CACHE_GIB} GiB) exceeds currently available space ($((${available_bytes} / 1073741824)) GiB)."
  fi
  success 'Host directories are ready for container UID/GID 1000.'
}

write_environment() {
  info 'Writing protected production environment configuration'
  local temporary
  temporary="$(mktemp "${PROJECT_ROOT}/.env.tmp.XXXXXX")"
  CLEANUP_FILES+=("${temporary}")
  chmod 0600 "${temporary}"
  cat > "${temporary}" <<'EOF'
# Generated by scripts/setup-ubuntu.sh. Keep this file secret and out of backups shared with developers.
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
REPOSITORY_DRIVER=postgres
EOF
  write_env_pair "${temporary}" POSTGRES_PASSWORD "${POSTGRES_PASSWORD}"
  write_env_pair "${temporary}" WEB_ORIGIN "${PUBLIC_ORIGIN}"
  write_env_pair "${temporary}" PUBLIC_ORIGIN "${PUBLIC_ORIGIN}"
  write_env_pair "${temporary}" MEDIA_PUBLIC_BASE_URL "${PUBLIC_ORIGIN}/media"
  write_env_pair "${temporary}" GATEWAY_BIND_ADDRESS "${GATEWAY_BIND_ADDRESS}"
  write_env_pair "${temporary}" ARCHIVE_ROOT "${ARCHIVE_ROOT}"
  write_env_pair "${temporary}" CACHE_ROOT "${CACHE_ROOT}"
  write_env_pair "${temporary}" DERIVED_ROOT "${DERIVED_ROOT}"
  write_env_pair "${temporary}" METADATA_ROOT "${METADATA_ROOT}"
  write_env_pair "${temporary}" PLAYBACK_PROFILE 'cmaf-v1'
  write_env_pair "${temporary}" PLAYBACK_SIGNING_SECRET "${PLAYBACK_SIGNING_SECRET}"
  write_env_pair "${temporary}" MEDIA_AUTH_SHARED_SECRET "${MEDIA_AUTH_SHARED_SECRET}"
  printf 'PLAYBACK_TTL_SECONDS=%s\n' "${PLAYBACK_TTL_SECONDS}" >> "${temporary}"
  write_env_pair "${temporary}" ADMIN_BOOTSTRAP_EMAIL "${ADMIN_BOOTSTRAP_EMAIL}"
  write_env_pair "${temporary}" ADMIN_BOOTSTRAP_PASSWORD "${ADMIN_BOOTSTRAP_PASSWORD}"
  printf 'ADMIN_SESSION_TTL_SECONDS=28800\n' >> "${temporary}"
  write_env_pair "${temporary}" TMDB_API_TOKEN "${TMDB_API_TOKEN}"
  printf 'TMDB_COMMERCIAL_LICENSE_CONFIRMED=%s\n' "${TMDB_COMMERCIAL_LICENSE_CONFIRMED}" >> "${temporary}"
  printf 'JIT_REMUX_CONCURRENCY=%s\n' "${JIT_REMUX_CONCURRENCY}" >> "${temporary}"
  printf 'ENCODE_CONCURRENCY=1\n' >> "${temporary}"
  printf 'CACHE_HIGH_WATERMARK=0.85\n' >> "${temporary}"
  printf 'CACHE_LOW_WATERMARK=0.75\n' >> "${temporary}"
  printf 'CACHE_MAX_BYTES=%s\n' "${CACHE_MAX_BYTES}" >> "${temporary}"

  if [[ -e "${ENV_FILE}" ]]; then
    ENV_BACKUP="${ENV_FILE}.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
    run_root cp -p -- "${ENV_FILE}" "${ENV_BACKUP}"
    run_root chmod 0600 "${ENV_BACKUP}"
  fi
  mv -f -- "${temporary}" "${ENV_FILE}"
  local owner_uid owner_gid
  owner_uid="${SUDO_UID:-$(id -u)}"
  owner_gid="${SUDO_GID:-$(id -g)}"
  run_root chown "${owner_uid}:${owner_gid}" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  success "Wrote ${ENV_FILE} with mode 0600."
  [[ -z "${ENV_BACKUP}" ]] || success "Preserved the previous environment at ${ENV_BACKUP}."
}

restore_environment() {
  if [[ -n "${ENV_BACKUP}" && -f "${ENV_BACKUP}" ]]; then
    run_root cp -p -- "${ENV_BACKUP}" "${ENV_FILE}"
    warn "Restored the previous ${ENV_FILE} because Compose validation failed."
  else
    rm -f -- "${ENV_FILE}"
    warn "Removed the invalid ${ENV_FILE}."
  fi
}

validate_compose() {
  info 'Validating the generated Compose configuration'
  if ! (cd "${PROJECT_ROOT}" && "${DOCKER_COMMAND[@]}" compose --env-file .env config --quiet); then
    restore_environment
    die 'Docker Compose rejected the generated configuration.'
  fi
  success 'Docker Compose accepted the generated production configuration.'
}

start_stack() {
  info 'Building Easy Stream images (the first FFmpeg build can take several minutes)'
  (cd "${PROJECT_ROOT}" && "${DOCKER_COMMAND[@]}" compose --env-file .env build)
  info 'Starting PostgreSQL, Redis, migrations, API, worker, and gateway'
  (cd "${PROJECT_ROOT}" && "${DOCKER_COMMAND[@]}" compose --env-file .env up -d)
  (cd "${PROJECT_ROOT}" && "${DOCKER_COMMAND[@]}" compose --env-file .env ps)
}

collect_configuration() {
  info 'Production values (secrets are hidden and never printed)'
  prompt_value PUBLIC_ORIGIN 'Public HTTPS origin' '' validate_origin
  prompt_value GATEWAY_BIND_ADDRESS 'Gateway host bind address' '127.0.0.1' validate_bind_address

  local archive_input
  prompt_value archive_input 'Archive directory' '/srv/easy-stream/archive' validate_absolute_path
  ARCHIVE_ROOT="$(canonical_path "${archive_input}")"
  if [[ ! -d "${ARCHIVE_ROOT}" ]]; then
    warn "Archive directory does not exist: ${ARCHIVE_ROOT}"
    if confirm 'Create an empty archive directory during setup?' no; then
      CREATE_ARCHIVE=true
    else
      die 'Mount or create the archive directory, then rerun setup.'
    fi
  fi

  local path_input
  prompt_value path_input 'Disposable HLS cache directory' '/srv/easy-stream/cache' validate_absolute_path
  CACHE_ROOT="$(canonical_path "${path_input}")"
  prompt_value path_input 'Durable compatibility-media directory' '/srv/easy-stream/derived' validate_absolute_path
  DERIVED_ROOT="$(canonical_path "${path_input}")"
  prompt_value path_input 'Metadata and registry directory' '/srv/easy-stream/metadata' validate_absolute_path
  METADATA_ROOT="$(canonical_path "${path_input}")"
  assert_separate_paths

  prompt_value CACHE_GIB 'Maximum disposable cache size in GiB' '2048' validate_cache_gib
  CACHE_MAX_BYTES=$((CACHE_GIB * 1073741824))
  local default_concurrency=2
  if command -v nproc >/dev/null 2>&1 && (( $(nproc) < 4 )); then
    default_concurrency=1
  fi
  prompt_value JIT_REMUX_CONCURRENCY 'Concurrent on-demand remux jobs' "${default_concurrency}" validate_concurrency
  prompt_value PLAYBACK_TTL_SECONDS 'Playback authorization lifetime in seconds' '14400' validate_ttl
  prompt_value ADMIN_BOOTSTRAP_EMAIL 'Initial administrator email' '' validate_email

  prompt_secret POSTGRES_PASSWORD 'PostgreSQL password' validate_postgres_password true
  prompt_secret PLAYBACK_SIGNING_SECRET 'Playback signing secret' validate_safe_secret true
  while true; do
    prompt_secret MEDIA_AUTH_SHARED_SECRET 'Gateway media-auth secret' validate_safe_secret true
    [[ "${MEDIA_AUTH_SHARED_SECRET}" != "${PLAYBACK_SIGNING_SECRET}" ]] && break
    warn 'The gateway and playback signing secrets must be different.'
  done
  prompt_secret ADMIN_BOOTSTRAP_PASSWORD 'Initial administrator password' validate_admin_password false

  read -r -s -p 'TMDB API token (optional; leave blank to disable): ' TMDB_API_TOKEN
  printf '\n'
  VALIDATION_ERROR=''
  validate_optional_token "${TMDB_API_TOKEN}" \
    || die "Invalid TMDB token: ${VALIDATION_ERROR}"
  TMDB_COMMERCIAL_LICENSE_CONFIRMED=false
  if [[ -n "${TMDB_API_TOKEN}" ]]; then
    if confirm 'Do you have written confirmation permitting commercial TMDB use?' no; then
      TMDB_COMMERCIAL_LICENSE_CONFIRMED=true
    else
      warn 'TMDB integration will remain disabled because commercial permission was not confirmed.'
      TMDB_API_TOKEN=''
    fi
  fi

  if [[ -e "${ENV_FILE}" ]]; then
    warn "An existing ${ENV_FILE} will be backed up before replacement."
    confirm 'Replace the current environment configuration?' no \
      || die 'Setup cancelled without changing the existing environment.'
  fi
}

show_summary() {
  info 'Review configuration'
  cat <<EOF
Public origin:       ${PUBLIC_ORIGIN}
Gateway listener:    ${GATEWAY_BIND_ADDRESS}:8080
Archive (read-only): ${ARCHIVE_ROOT}
HLS cache:           ${CACHE_ROOT} (${CACHE_GIB} GiB limit)
Durable media:       ${DERIVED_ROOT}
Metadata:            ${METADATA_ROOT}
JIT concurrency:     ${JIT_REMUX_CONCURRENCY}
Playback TTL:        ${PLAYBACK_TTL_SECONDS} seconds
Administrator:       ${ADMIN_BOOTSTRAP_EMAIL}
TMDB enabled:        ${TMDB_COMMERCIAL_LICENSE_CONFIRMED}
Secrets:             hidden (generated values are stored only in .env)
EOF
  printf '\nThis script does not configure DNS, TLS, CDN authorization, or a firewall.\n'
  if [[ "${GATEWAY_BIND_ADDRESS}" == '0.0.0.0' ]]; then
    warn 'The gateway will listen on every interface. Restrict port 8080 with a provider/network firewall before starting.'
  fi
}

main() {
  while (($# > 0)); do
    case "$1" in
      --no-start) NO_START=true ;;
      --skip-docker-install) SKIP_DOCKER_INSTALL=true ;;
      -h|--help) usage; return 0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done

  [[ -t 0 && -t 1 ]] || die 'Run this script from an interactive terminal.'
  check_host
  collect_configuration
  show_summary
  confirm 'Apply this configuration to the server?' no || die 'Setup cancelled without server changes.'

  initialize_privilege
  install_docker
  select_docker_command
  prepare_directories
  write_environment
  validate_compose

  local should_start=true
  if [[ "${NO_START}" == true ]]; then
    should_start=false
  elif ! confirm 'Build and start the Easy Stream stack now?' yes; then
    should_start=false
  fi

  if [[ "${should_start}" == true ]]; then
    start_stack
    success "Easy Stream is running. Route ${PUBLIC_ORIGIN} through TLS/CDN to this server's port 8080, then open ${PUBLIC_ORIGIN}/admin."
  else
    info 'Configuration is complete; the stack was not started'
    local docker_prefix=''
    ((${#ROOT_COMMAND[@]} == 0)) || docker_prefix='sudo '
    printf 'Run from %s:\n  %sdocker compose --env-file .env build\n  %sdocker compose --env-file .env up -d\n' \
      "${PROJECT_ROOT}" "${docker_prefix}" "${docker_prefix}"
  fi

  warn 'Store an encrypted copy of .env and the PostgreSQL volume backup separately. Docker group membership was not changed.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
