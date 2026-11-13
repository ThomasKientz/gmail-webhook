#!/usr/bin/env bash
# Removes the resources created by scripts/deploy.sh. Mail and the OAuth client stay.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PROJECT=""
REGION="us-central1"
TOPIC="gmail-notifications"
ASSUME_YES=0
FUNCTION_PUSH="gmail-webhook"
FUNCTION_RENEW="gmail-watch-renew"
SA_NAME="gmail-webhook"

usage() {
  cat <<'EOF'
Usage: scripts/uninstall.sh [--project ID] [--region REGION] [--topic NAME] [--yes]

Supprime les fonctions, la tâche planifiée, le sujet Pub/Sub, le bucket
d'état, les secrets et le compte de service. Les messages Gmail et le client
OAuth dans la console ne sont pas supprimés.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --topic) TOPIC="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Option inconnue: $1" ;;
  esac
done

require_commands gcloud
ensure_project

BUCKET="${PROJECT}-gmail-webhook"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  cat <<EOF
Suppression du relais dans ${PROJECT} (${REGION}) :
  fonctions ${FUNCTION_PUSH} et ${FUNCTION_RENEW},
  tâche Cloud Scheduler, sujet ${TOPIC},
  bucket gs://${BUCKET}, quatre secrets, compte ${SA_EMAIL}.

Les e-mails restent dans Gmail. Le client OAuth reste dans
Google Auth platform ; vous pouvez le supprimer à la main.
EOF
  if [[ ! -t 0 ]]; then
    die "Ajoutez --yes pour confirmer hors d'un terminal."
  fi
  confirm=""
  read -r -p "Tapez ${PROJECT} pour confirmer : " confirm
  if [[ "${confirm}" != "${PROJECT}" ]]; then
    die "Annulé."
  fi
fi

if gcloud scheduler jobs describe "${FUNCTION_RENEW}" --project="${PROJECT}" --location="${REGION}" >/dev/null 2>&1; then
  info "Suppression de la tâche planifiée."
  gcloud scheduler jobs delete "${FUNCTION_RENEW}" --project="${PROJECT}" --location="${REGION}" --quiet
else
  info "Aucune tâche planifiée."
fi

delete_function() {
  local name="$1"
  if gcloud functions describe "${name}" --gen2 --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
    info "Suppression de la fonction ${name}."
    gcloud functions delete "${name}" --gen2 --region="${REGION}" --project="${PROJECT}" --quiet
  else
    info "Fonction ${name} absente."
  fi
}

delete_function "${FUNCTION_PUSH}"
delete_function "${FUNCTION_RENEW}"

if gcloud pubsub topics describe "${TOPIC}" --project="${PROJECT}" >/dev/null 2>&1; then
  subs="$(gcloud pubsub subscriptions list --project="${PROJECT}" --format='value(name)' --filter="topic:projects/${PROJECT}/topics/${TOPIC}" || true)"
  if [[ -n "${subs}" ]]; then
    while IFS= read -r sub; do
      [[ -z "${sub}" ]] && continue
      info "Suppression de l'abonnement ${sub}."
      gcloud pubsub subscriptions delete "${sub}" --project="${PROJECT}" --quiet
    done <<<"${subs}"
  fi
  info "Suppression du sujet ${TOPIC}."
  gcloud pubsub topics delete "${TOPIC}" --project="${PROJECT}" --quiet
else
  info "Sujet ${TOPIC} absent."
fi

if gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
  info "Suppression du bucket d'état."
  gcloud storage rm --recursive "gs://${BUCKET}/**" --project="${PROJECT}" >/dev/null 2>&1 || true
  gcloud storage buckets delete "gs://${BUCKET}" --project="${PROJECT}" --quiet
else
  info "Bucket absent."
fi

for secret_name in gmail-oauth-client-id gmail-oauth-client-secret gmail-oauth-refresh-token gmail-webhook-key; do
  if secret_exists "${secret_name}"; then
    info "Suppression du secret ${secret_name}."
    gcloud secrets delete "${secret_name}" --project="${PROJECT}" --quiet
  fi
done

if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  info "Suppression du compte de service."
  gcloud iam service-accounts delete "${SA_EMAIL}" --project="${PROJECT}" --quiet
fi

info "Images de conteneur éventuellement restantes : dépôt Artifact Registry « gcf-artifacts » dans ${REGION}. Supprimez-les dans la console si ce projet ne sert plus à aucune autre fonction."
info "Relais retiré du projet ${PROJECT}."
