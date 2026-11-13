#!/usr/bin/env bash
# Idempotent setup: APIs, Pub/Sub, secrets, Cloud Run functions, daily watch renewal, OAuth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
# shellcheck source=authorize.sh
source "${SCRIPT_DIR}/authorize.sh"

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT=""
REGION="us-central1"
TOPIC="gmail-notifications"
WEBHOOK_URL=""
WEBHOOK_KEY=""
WEBHOOK_KEY_SET=0
AUTH_HEADER_NAME="Authorization"
AUTH_SCHEME="Bearer"
LABEL_IDS="INBOX"
LABEL_BEHAVIOR="include"
INCLUDE_BODY="false"
PAYLOAD_FIELDS=""
EXPIRED_MAX="10"
TIME_ZONE="Europe/Paris"
SCHEDULE="0 8 * * *"
CLIENT_ID=""
CLIENT_SECRET=""
REFRESH_TOKEN=""
ASSUME_PUBLISHED=0
KEEP_TOKEN=0

FUNCTION_PUSH="gmail-webhook"
FUNCTION_RENEW="gmail-watch-renew"
SA_NAME="gmail-webhook"

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [options]

  --project ID              Projet Google Cloud (sinon, le projet actif)
  --region REGION           Région, défaut us-central1 (niveau gratuit)
  --webhook-url URL         URL https appelée pour chaque nouveau message
  --webhook-key KEY         Valeur envoyée dans l'en-tête d'autorisation
  --auth-header NAME        Défaut: Authorization
  --auth-scheme SCHEME      Défaut: Bearer. Utilisez none pour envoyer la clé seule.
  --label-ids IDS           Étiquettes Gmail, défaut INBOX. Liste séparée par des virgules.
  --label-behavior include|exclude
  --payload-fields LIST     Champs du JSON, séparés par des virgules
  --include-body            Inclut le texte brut du message (désactivé par défaut)
  --time-zone ZONE          Défaut: Europe/Paris
  --schedule CRON           Défaut: 0 8 * * * (tous les jours à 08:00)
  --client-id ID            Client OAuth (sinon demandé)
  --client-secret SECRET    Secret OAuth (sinon demandé)
  --refresh-token TOKEN     Jeton déjà obtenu
  --keep-token              Conserve le jeton déjà stocké
  --i-published             Confirme que l'écran de consentement est en production
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --webhook-url) WEBHOOK_URL="$2"; shift 2 ;;
    --webhook-key) WEBHOOK_KEY="$2"; WEBHOOK_KEY_SET=1; shift 2 ;;
    --auth-header) AUTH_HEADER_NAME="$2"; shift 2 ;;
    --auth-scheme) AUTH_SCHEME="$2"; shift 2 ;;
    --label-ids) LABEL_IDS="$2"; shift 2 ;;
    --label-behavior) LABEL_BEHAVIOR="$2"; shift 2 ;;
    --payload-fields) PAYLOAD_FIELDS="$2"; shift 2 ;;
    --include-body) INCLUDE_BODY="true"; shift ;;
    --time-zone) TIME_ZONE="$2"; shift 2 ;;
    --schedule) SCHEDULE="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --refresh-token) REFRESH_TOKEN="$2"; shift 2 ;;
    --keep-token) KEEP_TOKEN=1; shift ;;
    --i-published) ASSUME_PUBLISHED=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Option inconnue: $1 (essayez --help)" ;;
  esac
done

require_commands gcloud python3 openssl curl
ensure_project
require_billing

LABEL_BEHAVIOR="$(printf '%s' "${LABEL_BEHAVIOR}" | tr '[:upper:]' '[:lower:]')"
if [[ "${LABEL_BEHAVIOR}" != "include" && "${LABEL_BEHAVIOR}" != "exclude" ]]; then
  die "label-behavior doit être include ou exclude."
fi
if [[ "${AUTH_SCHEME}" == "raw" ]]; then
  AUTH_SCHEME="none"
fi
if [[ ! "${REGION}" =~ ^[a-z][a-z0-9-]+$ ]]; then
  die "Région inattendue: ${REGION}"
fi
if [[ ! "${WEBHOOK_URL}" =~ ^https:// ]]; then
  if [[ -z "${WEBHOOK_URL}" && -t 0 ]]; then
    read -r -p "URL du webhook (https://...) : " WEBHOOK_URL
  fi
fi
if [[ ! "${WEBHOOK_URL}" =~ ^https:// ]]; then
  die "L'URL du webhook doit commencer par https://"
fi
if [[ "${WEBHOOK_KEY_SET}" -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    die "Passez --webhook-key (ou relancez dans un terminal pour la saisir)."
  fi
  read -r -s -p "Clé du webhook, envoyée comme « ${AUTH_SCHEME} <clé> » (Entrée si aucune) : " WEBHOOK_KEY
  printf '\n'
  WEBHOOK_KEY_SET=1
fi

reject_delimiter "URL du webhook" "${WEBHOOK_URL}"
reject_delimiter "Clé du webhook" "${WEBHOOK_KEY}"
reject_delimiter "En-tête" "${AUTH_HEADER_NAME}"
reject_delimiter "Schéma" "${AUTH_SCHEME}"
reject_delimiter "Étiquettes" "${LABEL_IDS}"
reject_delimiter "Champs" "${PAYLOAD_FIELDS}"
reject_delimiter "Fuseau" "${TIME_ZONE}"
reject_delimiter "Planning" "${SCHEDULE}"

BUCKET="${PROJECT}-gmail-webhook"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ENV_VARS="^@^GCP_PROJECT=${PROJECT}@STATE_BUCKET=${BUCKET}@PUBSUB_TOPIC=${TOPIC}@WEBHOOK_URL=${WEBHOOK_URL}@WEBHOOK_AUTH_HEADER_NAME=${AUTH_HEADER_NAME}@WEBHOOK_AUTH_SCHEME=${AUTH_SCHEME}@GMAIL_LABEL_IDS=${LABEL_IDS}@GMAIL_LABEL_FILTER_BEHAVIOR=${LABEL_BEHAVIOR}@INCLUDE_BODY=${INCLUDE_BODY}@HISTORY_EXPIRED_MAX_MESSAGES=${EXPIRED_MAX}"
if [[ -n "${PAYLOAD_FIELDS}" ]]; then
  ENV_VARS="${ENV_VARS}@PAYLOAD_FIELDS=${PAYLOAD_FIELDS}"
fi

info "Activation des API (une seule fois, quelques minutes)."
gcloud services enable \
  gmail.googleapis.com \
  pubsub.googleapis.com \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  eventarc.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="${PROJECT}"

gcloud services identity create --service=pubsub.googleapis.com --project="${PROJECT}" >/dev/null || true
gcloud services identity create --service=eventarc.googleapis.com --project="${PROJECT}" >/dev/null || true

if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  info "Création du compte de service."
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT}" \
    --display-name="Relais Gmail"
fi

if ! gcloud pubsub topics describe "${TOPIC}" --project="${PROJECT}" >/dev/null 2>&1; then
  info "Création du sujet Pub/Sub ${TOPIC}."
  gcloud pubsub topics create "${TOPIC}" --project="${PROJECT}" >/dev/null
fi

info "Autorisation de Gmail à publier sur le sujet."
gcloud pubsub topics add-iam-policy-binding "${TOPIC}" \
  --project="${PROJECT}" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --quiet >/dev/null

if ! gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
  info "Création du bucket d'état."
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --quiet >/dev/null

info "Enregistrement de la clé du webhook."
if [[ -z "${WEBHOOK_KEY}" ]]; then
  add_secret_value "gmail-webhook-key" "__NO_WEBHOOK_KEY__"
else
  add_secret_value "gmail-webhook-key" "${WEBHOOK_KEY}"
fi

info "Autorisation Gmail (lecture seule)."
run_oauth_setup

for secret_name in gmail-oauth-client-id gmail-oauth-client-secret gmail-oauth-refresh-token gmail-webhook-key; do
  if ! secret_exists "${secret_name}"; then
    die "Secret manquant: ${secret_name}. Relancez le script pour terminer l'autorisation."
  fi
  bind_secret_accessor "${secret_name}" "serviceAccount:${SA_EMAIL}"
done

deploy_function() {
  local name="$1"
  local entry="$2"
  shift 2
  info "Déploiement de ${name}."
  gcloud functions deploy "${name}" \
    --project="${PROJECT}" \
    --gen2 \
    --runtime=nodejs22 \
    --region="${REGION}" \
    --source="${ROOT}" \
    --entry-point="${entry}" \
    --run-service-account="${SA_EMAIL}" \
    --memory=256Mi \
    --timeout=120s \
    --min-instances=0 \
    --max-instances=3 \
    --concurrency=1 \
    --set-env-vars="${ENV_VARS}" \
    --quiet \
    "$@"
}

retry 3 20 deploy_function "${FUNCTION_PUSH}" onGmailPush --trigger-topic="${TOPIC}" --retry
retry 3 20 deploy_function "${FUNCTION_RENEW}" renewWatch --trigger-http --no-allow-unauthenticated

gcloud functions add-iam-policy-binding "${FUNCTION_RENEW}" \
  --project="${PROJECT}" \
  --gen2 \
  --region="${REGION}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker" \
  --quiet >/dev/null

RENEW_URL="$(gcloud functions describe "${FUNCTION_RENEW}" --gen2 --region="${REGION}" --project="${PROJECT}" --format='value(serviceConfig.uri)')"
if [[ -z "${RENEW_URL}" ]]; then
  die "Impossible de lire l'adresse de la fonction de renouvellement."
fi

scheduler_args=(
  --project="${PROJECT}"
  --location="${REGION}"
  --schedule="${SCHEDULE}"
  --time-zone="${TIME_ZONE}"
  --uri="${RENEW_URL}"
  --http-method=POST
  --oidc-service-account-email="${SA_EMAIL}"
  --oidc-token-audience="${RENEW_URL}"
  --attempt-deadline=180s
)

if gcloud scheduler jobs describe "${FUNCTION_RENEW}" --project="${PROJECT}" --location="${REGION}" >/dev/null 2>&1; then
  info "Mise à jour de la tâche quotidienne."
  gcloud scheduler jobs update http "${FUNCTION_RENEW}" "${scheduler_args[@]}" --quiet >/dev/null
else
  info "Création de la tâche quotidienne."
  gcloud scheduler jobs create http "${FUNCTION_RENEW}" "${scheduler_args[@]}" --quiet >/dev/null
fi

call_renew() {
  local token tmp code
  token="$(gcloud auth print-identity-token --audiences="${RENEW_URL}")"
  tmp="$(mktemp)"
  code="$(curl -sS -o "${tmp}" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "${RENEW_URL}" || true)"
  unset token
  if [[ "${code}" != "200" ]]; then
    info "Renouvellement HTTP ${code}."
    cat "${tmp}" >&2 || true
    rm -f "${tmp}"
    return 1
  fi
  cat "${tmp}"
  rm -f "${tmp}"
}

info "Première surveillance de la boîte mail."
if ! renew_output="$(retry 5 10 call_renew)"; then
  die "Les ressources sont créées, mais la première surveillance a échoué. Attendez une minute puis relancez le même script."
fi

EXPIRATION="$(printf '%s' "${renew_output}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("expiration",""))')"
WHEN=""
if [[ -n "${EXPIRATION}" ]]; then
  WHEN="$(python3 -c 'import datetime,sys; ms=int(sys.argv[1]); print(datetime.datetime.fromtimestamp(ms/1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))' "${EXPIRATION}")"
fi

cat <<EOF

C'est installé.

  Projet          ${PROJECT}
  Région          ${REGION}
  Sujet Pub/Sub   ${TOPIC}
  Webhook         ${WEBHOOK_URL}
  Étiquettes      ${LABEL_IDS:-toutes} (${LABEL_BEHAVIOR})
  Renouvellement  ${SCHEDULE} (${TIME_ZONE})
  Surveillance    ${WHEN:-active}

Pour essayer : envoyez un message à la boîte Gmail que vous venez d'autoriser,
depuis une autre adresse ou avec « m'envoyer un e-mail ». Le webhook reçoit un
JSON (expéditeur, objet, extrait, identifiants). Le corps du message n'est pas
envoyé.

Journaux : https://console.cloud.google.com/run/detail/${REGION}/${FUNCTION_PUSH}/logs?project=${PROJECT}

Pour tout enlever plus tard : bash scripts/uninstall.sh
EOF
