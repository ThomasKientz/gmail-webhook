#!/usr/bin/env bash
# Shared helpers for the Cloud Shell setup scripts.
# Do not run with `bash -x`: that would print secrets.

info() {
  printf '%s\n' "$*" >&2
}

die() {
  printf 'Erreur: %s\n' "$*" >&2
  exit 1
}

require_commands() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "Commande introuvable: ${cmd}. Ouvrez Google Cloud Shell, rien d'autre n'est à installer."
  done
}

ensure_project() {
  if [[ -z "${PROJECT}" ]]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
    die "Aucun projet Google Cloud. Créez-en un dans la console, puis relancez avec --project IDENTIFIANT."
  fi
  if [[ ! "${PROJECT}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    die "Identifiant de projet inattendu: ${PROJECT}"
  fi
  gcloud config set project "${PROJECT}" >/dev/null
}

require_billing() {
  local enabled
  enabled="$(gcloud billing projects describe "${PROJECT}" --format='value(billingEnabled)' 2>/dev/null || true)"
  if [[ "${enabled}" != "True" ]]; then
    die "La facturation n'est pas activée sur ${PROJECT}. Même pour le niveau gratuit, Google la demande. Ouvrez https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT} puis relancez le script."
  fi
}

reject_delimiter() {
  local label="$1"
  local value="$2"
  if [[ "${value}" == *"@"* || "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    die "${label} ne doit pas contenir @ ni de retour à la ligne."
  fi
}

secret_exists() {
  gcloud secrets describe "$1" --project="${PROJECT}" >/dev/null 2>&1
}

secret_has_version() {
  gcloud secrets versions access latest --secret="$1" --project="${PROJECT}" >/dev/null 2>&1
}

disable_old_secret_versions() {
  local name="$1"
  local versions version skip
  versions="$(gcloud secrets versions list "${name}" --project="${PROJECT}" --filter="state=ENABLED" --format="value(name)" --sort-by="~createTime" 2>/dev/null || true)"
  skip=1
  while IFS= read -r version; do
    [[ -z "${version}" ]] && continue
    if [[ "${skip}" -eq 1 ]]; then
      skip=0
      continue
    fi
    gcloud secrets versions disable "${version}" --secret="${name}" --project="${PROJECT}" --quiet >/dev/null
  done <<<"${versions}"
}

add_secret_value() {
  local name="$1"
  local value="$2"
  local tmp current
  if ! secret_exists "${name}"; then
    gcloud secrets create "${name}" --project="${PROJECT}" --replication-policy="automatic" >/dev/null
  fi
  tmp="$(mktemp)"
  if gcloud secrets versions access latest --secret="${name}" --project="${PROJECT}" >"${tmp}" 2>/dev/null; then
    current="$(cat "${tmp}")"
  else
    current=""
  fi
  rm -f "${tmp}"
  if [[ "${current}" == "${value}" ]]; then
    info "Secret ${name} inchangé."
    return 0
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${name}" --project="${PROJECT}" --data-file=- >/dev/null
  disable_old_secret_versions "${name}"
  info "Secret ${name} enregistré."
}

bind_secret_accessor() {
  local name="$1"
  local member="$2"
  gcloud secrets add-iam-policy-binding "${name}" \
    --project="${PROJECT}" \
    --member="${member}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
}

retry() {
  local attempts="$1"
  local delay="$2"
  shift 2
  local n=1
  local status
  while true; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if [[ "${n}" -ge "${attempts}" ]]; then
      return "${status}"
    fi
    info "Nouvelle tentative dans ${delay}s (${n}/${attempts})."
    sleep "${delay}"
    n=$((n + 1))
  done
}
