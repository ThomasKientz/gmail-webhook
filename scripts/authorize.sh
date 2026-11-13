#!/usr/bin/env bash
# Guides the mailbox owner through OAuth and stores the refresh token in Secret Manager.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

REDIRECT_URI="http://127.0.0.1:8085"
SCOPE="https://www.googleapis.com/auth/gmail.readonly"

usage() {
  cat <<'EOF'
Usage: scripts/authorize.sh [--project ID] [--client-id ID] [--client-secret SECRET]
                            [--refresh-token TOKEN] [--i-published]

Ouvre la page d'autorisation Gmail, reçoit le code collé depuis la barre
d'adresse, puis enregistre le jeton dans Secret Manager. Le jeton n'est
jamais affiché.
EOF
}

confirm_published() {
  if [[ "${ASSUME_PUBLISHED}" == "1" ]]; then
    return 0
  fi
  cat <<EOF

Avant d'autoriser Gmail, l'écran de consentement doit être publié.
Sinon le jeton expire au bout de 7 jours et les messages s'arrêtent sans prévenir.

  1. Ouvrez https://console.cloud.google.com/auth/audience?project=${PROJECT}
  2. Compte Gmail personnel : cliquez sur « Publier l'application » / « Publish app ».
     Le statut doit devenir « En production » / « In production ».
     Ne demandez pas la validation Google : pour un usage personnel, l'avertissement
     « application non validée » est normal.
  3. Compte Google Workspace du même organisme : le type « Interne » / « Internal »
     suffit, sans publication.

EOF
  local answer
  read -r -p "C'est fait ? [o/N] " answer
  if [[ "${answer}" != "o" && "${answer}" != "O" && "${answer}" != "y" && "${answer}" != "Y" ]]; then
    die "Publiez l'application, puis relancez le script."
  fi
}

prompt_if_empty() {
  local var_name="$1"
  local label="$2"
  local secret="$3"
  local current="${!var_name}"
  if [[ -n "${current}" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "Valeur manquante: ${label}. Relancez dans Cloud Shell ou passez le drapeau correspondant."
  fi
  local value
  if [[ "${secret}" == "1" ]]; then
    read -r -s -p "${label} : " value
    printf '\n'
  else
    read -r -p "${label} : " value
  fi
  printf -v "${var_name}" '%s' "${value}"
}

extract_code() {
  local input="$1"
  INPUT="${input}" python3 - <<'PY'
import os
import urllib.parse
raw = os.environ["INPUT"].strip()
if "error=" in raw and "code=" not in raw:
    raise SystemExit("access_denied")
if "code=" not in raw:
    print(raw)
    raise SystemExit(0)
if "://" not in raw:
    raw = "http://127.0.0.1/?" + (raw.split("?", 1)[-1] if "?" in raw else raw)
query = urllib.parse.urlparse(raw).query
code = urllib.parse.parse_qs(query).get("code", [""])[0]
if not code:
    raise SystemExit("code_missing")
print(code)
PY
}

store_and_verify_code() {
  local code="$1"
  local verifier="$2"
  local token_file err_file email err
  token_file="$(mktemp)"
  err_file="$(mktemp)"
  chmod 600 "${token_file}"
  if ! email="$(
    CLIENT_ID="${CLIENT_ID}" \
      CLIENT_SECRET="${CLIENT_SECRET}" \
      AUTH_CODE="${code}" \
      CODE_VERIFIER="${verifier}" \
      REDIRECT_URI="${REDIRECT_URI}" \
      TOKEN_FILE="${token_file}" \
      python3 - 2>"${err_file}" <<'PY'
import json
import os
import urllib.error
import urllib.parse
import urllib.request

def post(url, fields):
    data = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            err = json.loads(raw).get("error", "oauth_error")
        except json.JSONDecodeError:
            err = "oauth_error"
        raise SystemExit(err)

token = post(
    "https://oauth2.googleapis.com/token",
    {
        "client_id": os.environ["CLIENT_ID"],
        "client_secret": os.environ["CLIENT_SECRET"],
        "code": os.environ["AUTH_CODE"],
        "code_verifier": os.environ["CODE_VERIFIER"],
        "redirect_uri": os.environ["REDIRECT_URI"],
        "grant_type": "authorization_code",
    },
)
refresh = token.get("refresh_token") or ""
access = token.get("access_token") or ""
if not refresh or not access:
    raise SystemExit("no_refresh_token")
with open(os.environ["TOKEN_FILE"], "w", encoding="utf-8") as handle:
    handle.write(refresh)
request = urllib.request.Request(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    headers={"Authorization": "Bearer " + access},
)
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        profile = json.load(response)
except urllib.error.HTTPError:
    raise SystemExit("profile_failed")
print(profile.get("emailAddress", ""))
PY
  )"; then
    err="$(cat "${err_file}")"
    rm -f "${token_file}" "${err_file}"
    die "L'autorisation a échoué (${err:-oauth_error}). Relancez le script et acceptez l'accès en lecture."
  fi
  rm -f "${err_file}"
  REFRESH_TOKEN="$(cat "${token_file}")"
  rm -f "${token_file}"
  if [[ -z "${REFRESH_TOKEN}" ]]; then
    die "Google n'a pas renvoyé de jeton de rafraîchissement."
  fi
  add_secret_value "gmail-oauth-client-id" "${CLIENT_ID}"
  add_secret_value "gmail-oauth-client-secret" "${CLIENT_SECRET}"
  add_secret_value "gmail-oauth-refresh-token" "${REFRESH_TOKEN}"
  unset REFRESH_TOKEN
  info "Gmail autorisé pour ${email}."
}

verify_existing_refresh_token() {
  local token_file err_file email err
  token_file="$(mktemp)"
  err_file="$(mktemp)"
  chmod 600 "${token_file}"
  printf '%s' "${REFRESH_TOKEN}" >"${token_file}"
  if ! email="$(
    CLIENT_ID="${CLIENT_ID}" \
      CLIENT_SECRET="${CLIENT_SECRET}" \
      TOKEN_FILE="${token_file}" \
      python3 - 2>"${err_file}" <<'PY'
import json
import os
import urllib.error
import urllib.parse
import urllib.request

with open(os.environ["TOKEN_FILE"], encoding="utf-8") as handle:
    refresh = handle.read()
data = urllib.parse.urlencode(
    {
        "client_id": os.environ["CLIENT_ID"],
        "client_secret": os.environ["CLIENT_SECRET"],
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }
).encode()
request = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        token = json.load(response)
except urllib.error.HTTPError as exc:
    raw = exc.read().decode("utf-8", "replace")
    try:
        err = json.loads(raw).get("error", "oauth_error")
    except json.JSONDecodeError:
        err = "oauth_error"
    raise SystemExit(err)
access = token.get("access_token") or ""
if not access:
    raise SystemExit("oauth_error")
profile_request = urllib.request.Request(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    headers={"Authorization": "Bearer " + access},
)
try:
    with urllib.request.urlopen(profile_request, timeout=60) as response:
        profile = json.load(response)
except urllib.error.HTTPError:
    raise SystemExit("profile_failed")
print(profile.get("emailAddress", ""))
PY
  )"; then
    err="$(cat "${err_file}")"
    rm -f "${token_file}" "${err_file}"
    die "Le jeton fourni ne fonctionne pas (${err:-oauth_error})."
  fi
  rm -f "${err_file}"
  rm -f "${token_file}"
  add_secret_value "gmail-oauth-client-id" "${CLIENT_ID}"
  add_secret_value "gmail-oauth-client-secret" "${CLIENT_SECRET}"
  add_secret_value "gmail-oauth-refresh-token" "${REFRESH_TOKEN}"
  unset REFRESH_TOKEN
  info "Gmail autorisé pour ${email}."
}

browser_authorization() {
  local verifier challenge auth_url pasted code
  verifier="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  challenge="$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  auth_url="https://accounts.google.com/o/oauth2/v2/auth?client_id=$(
    python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${CLIENT_ID}"
  )&redirect_uri=$(
    python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${REDIRECT_URI}"
  )&response_type=code&scope=$(
    python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${SCOPE}"
  )&access_type=offline&prompt=consent&code_challenge=${challenge}&code_challenge_method=S256"

  cat <<EOF

Ouvrez cette adresse dans le navigateur (elle est longue, copiez-la en entier) :

${auth_url}

Connectez-vous avec la boîte Gmail à surveiller.
Si Google affiche « Application non validée » / « Google hasn't verified this app » :
  • cliquez sur « Paramètres avancés » / « Advanced »
  • puis « Accéder à … (non sécurisé) » / « Go to … (unsafe) »
Cochez l'accès en lecture à Gmail et continuez.

Le navigateur affiche ensuite une page inaccessible (127.0.0.1). C'est normal.
Copiez toute l'adresse de la barre d'adresse : elle contient code=.

EOF
  if [[ ! -t 0 ]]; then
    die "Collez le code dans un terminal interactif."
  fi
  read -r -p "Collez l'adresse ou le code : " pasted
  if ! code="$(extract_code "${pasted}")"; then
    die "Autorisation refusée ou code illisible. Relancez le script."
  fi
  if [[ -z "${code}" ]]; then
    die "Code vide."
  fi
  store_and_verify_code "${code}" "${verifier}"
}

run_oauth_setup() {
  local keep="0"
  if [[ -z "${REFRESH_TOKEN}" && "${KEEP_TOKEN}" == "1" ]]; then
    keep="1"
  elif [[ -z "${REFRESH_TOKEN}" ]] && secret_has_version "gmail-oauth-refresh-token"; then
    if [[ -t 0 ]]; then
      local answer
      read -r -p "Un jeton Gmail existe déjà. Le conserver ? [O/n] " answer
      if [[ "${answer}" != "n" && "${answer}" != "N" ]]; then
        keep="1"
      fi
    else
      keep="1"
    fi
  fi
  if [[ "${keep}" == "1" ]]; then
    info "Jeton Gmail conservé."
    return 0
  fi

  confirm_published
  prompt_if_empty CLIENT_ID "Identifiant client OAuth (Client ID)" 0
  prompt_if_empty CLIENT_SECRET "Secret client OAuth (Client secret)" 1
  if [[ -z "${CLIENT_ID}" || -z "${CLIENT_SECRET}" ]]; then
    die "Identifiant et secret du client OAuth requis."
  fi
  reject_delimiter "Client OAuth" "${CLIENT_ID}"
  reject_delimiter "Secret OAuth" "${CLIENT_SECRET}"

  if [[ -n "${REFRESH_TOKEN}" ]]; then
    verify_existing_refresh_token
    return 0
  fi
  browser_authorization
}

authorize_main() {
  PROJECT=""
  CLIENT_ID=""
  CLIENT_SECRET=""
  REFRESH_TOKEN=""
  ASSUME_PUBLISHED="0"
  KEEP_TOKEN="0"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project)
        PROJECT="$2"
        shift 2
        ;;
      --client-id)
        CLIENT_ID="$2"
        shift 2
        ;;
      --client-secret)
        CLIENT_SECRET="$2"
        shift 2
        ;;
      --refresh-token)
        REFRESH_TOKEN="$2"
        shift 2
        ;;
      --i-published)
        ASSUME_PUBLISHED="1"
        shift
        ;;
      --keep-token)
        KEEP_TOKEN="1"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Option inconnue: $1"
        ;;
    esac
  done
  require_commands gcloud python3 openssl curl
  ensure_project
  run_oauth_setup
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  authorize_main "$@"
fi
