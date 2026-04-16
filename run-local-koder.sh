#!/usr/bin/env bash

# FILE: run-local-koder.sh
# Purpose: Starts the local relay, bridge, and web client for one-command self-hosted testing.
# Layer: developer utility
# Exports: none
# Depends on: ./run-local-remodex.sh, web/package.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${SCRIPT_DIR}/web"
WEB_PORT="${WEB_PORT:-5173}"
WEB_LOG_FILE="${TMPDIR:-/tmp}/koder-web-dev.log"
WEB_CERT_DIR="${TMPDIR:-/tmp}/koder-web-certs"
WEB_CERT_KEY=""
WEB_CERT_CERT=""
RELAY_HOSTNAME=""
RELAY_PORT="${RELAY_PORT:-9000}"
REMODEX_PID=""
WEB_PID=""

cleanup() {
  if [[ -n "${WEB_PID}" ]] && kill -0 "${WEB_PID}" 2>/dev/null; then
    kill "${WEB_PID}" 2>/dev/null || true
    wait "${WEB_PID}" 2>/dev/null || true
  fi
  if [[ -n "${REMODEX_PID}" ]] && kill -0 "${REMODEX_PID}" 2>/dev/null; then
    kill "${REMODEX_PID}" 2>/dev/null || true
    wait "${REMODEX_PID}" 2>/dev/null || true
  fi
}

log() {
  printf '[run-local-koder] %s\n' "$*"
}

die() {
  log "$*"
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --hostname)
        shift
        [[ $# -gt 0 ]] || die "--hostname requires a value"
        RELAY_HOSTNAME="$1"
        ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value"
        RELAY_PORT="$1"
        ;;
    esac
    shift || true
  done
}

default_hostname() {
  local host_name
  host_name="$(hostname 2>/dev/null || true)"
  if [[ -n "${host_name}" ]]; then
    printf '%s' "${host_name}"
    return
  fi
  printf 'localhost'
}

ensure_web_dependencies() {
  [[ -d "${WEB_DIR}" ]] || die "Missing web client directory: ${WEB_DIR}"
  if [[ ! -d "${WEB_DIR}/node_modules" ]]; then
    log "Installing web dependencies in ${WEB_DIR}"
    (cd "${WEB_DIR}" && npm install)
  fi
}

ensure_web_port_available() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Web port ${WEB_PORT} is already in use. Stop the existing listener or set WEB_PORT."
  fi
}

is_ipv4_address() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

ensure_local_https_certificate() {
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the local HTTPS certificate."

  mkdir -p "${WEB_CERT_DIR}"
  WEB_CERT_KEY="${WEB_CERT_DIR}/koder-${RELAY_HOSTNAME}.key.pem"
  WEB_CERT_CERT="${WEB_CERT_DIR}/koder-${RELAY_HOSTNAME}.cert.pem"

  if [[ -f "${WEB_CERT_KEY}" && -f "${WEB_CERT_CERT}" ]]; then
    return
  fi

  local san_entry
  if is_ipv4_address "${RELAY_HOSTNAME}"; then
    san_entry="IP:${RELAY_HOSTNAME}"
  else
    san_entry="DNS:${RELAY_HOSTNAME}"
  fi

  local config_file
  config_file="${WEB_CERT_DIR}/koder-${RELAY_HOSTNAME}.openssl.cnf"
  cat > "${config_file}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = req_ext
distinguished_name = dn

[dn]
CN = ${RELAY_HOSTNAME}
O = Koder Local Dev

[req_ext]
subjectAltName = ${san_entry}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

  log "Generating local HTTPS certificate for ${RELAY_HOSTNAME}"
  openssl req \
    -x509 \
    -nodes \
    -newkey rsa:2048 \
    -days 7 \
    -keyout "${WEB_CERT_KEY}" \
    -out "${WEB_CERT_CERT}" \
    -config "${config_file}" >/dev/null 2>&1
}

start_web() {
  log "Starting web client on 0.0.0.0:${WEB_PORT} over HTTPS"
  : > "${WEB_LOG_FILE}"
  (
    cd "${WEB_DIR}"
    export KODER_HTTPS_KEY_PATH="${WEB_CERT_KEY}"
    export KODER_HTTPS_CERT_PATH="${WEB_CERT_CERT}"
    export KODER_RELAY_PROXY_TARGET="http://127.0.0.1:${RELAY_PORT}"
    npm run dev -- --host 0.0.0.0 --port "${WEB_PORT}" --strictPort
  ) >"${WEB_LOG_FILE}" 2>&1 &
  WEB_PID=$!
}

wait_for_web() {
  local attempt
  for attempt in {1..40}; do
    if [[ -n "${WEB_PID}" ]] && ! kill -0 "${WEB_PID}" 2>/dev/null; then
      tail -n 40 "${WEB_LOG_FILE}" >&2 || true
      die "Web client exited before becoming ready."
    fi
    if curl --silent --fail --insecure "https://127.0.0.1:${WEB_PORT}" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done

  tail -n 40 "${WEB_LOG_FILE}" >&2 || true
  die "Web client did not become ready on port ${WEB_PORT}."
}

print_web_summary() {
  local advertised_host="$1"
  cat <<EOF
[run-local-koder] Web client ready
  Browser URL : https://${advertised_host}:${WEB_PORT}
  Relay URL   : wss://${advertised_host}:${WEB_PORT}/relay
  HTTPS cert  : ${WEB_CERT_CERT}
  Web log     : ${WEB_LOG_FILE}

Open the Browser URL on your phone. If Safari warns that the local certificate is untrusted, you must explicitly trust it before live camera scan will work. Otherwise, use the photo fallback in the page.
EOF
}

trap cleanup EXIT INT TERM

parse_args "$@"

if [[ -z "${RELAY_HOSTNAME}" ]]; then
  RELAY_HOSTNAME="$(default_hostname)"
fi

ensure_web_dependencies
ensure_web_port_available
ensure_local_https_certificate
start_web
wait_for_web

print_web_summary "${RELAY_HOSTNAME}" "${RELAY_PORT}"

"${SCRIPT_DIR}/run-local-remodex.sh" "$@" &
REMODEX_PID=$!
wait "${REMODEX_PID}"
