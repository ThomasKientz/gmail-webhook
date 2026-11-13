# Relais Gmail

**English.** This is a small, open-source bridge that turns new Gmail messages into HTTPS webhook calls. You deploy it in **your own** Google Cloud project, so nobody else — including the author of this repository — can read your mail. Gmail notifies a Pub/Sub topic, a Cloud Run function (2nd gen) reads message metadata with a read-only OAuth token, and POSTs a short JSON body to the webhook you choose. A daily Cloud Scheduler job renews the Gmail watch. Setup is one script in Google Cloud Shell. There is no “Deploy to Cloud Run” button: that button cannot create the Pub/Sub topic, the Gmail publisher permission, the secrets, or the daily renewal.

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/ThomasKientz/gmail-webhook&cloudshell_git_branch=main&cloudshell_tutorial=tutorial.md&show=ide%2Cterminal)

---

Chaque nouveau message de votre boîte Gmail déclenche un appel vers une adresse de votre choix (un webhook). Tout s’exécute dans **votre** projet Google Cloud. Ce dépôt ne reçoit jamais vos messages, ni votre jeton.

Le bouton ci-dessus ouvre Google Cloud Shell, clone ce dépôt et affiche un guide pas à pas. Quand Google demande si vous faites confiance au dépôt, choisissez **Trust repository** / **Faire confiance au dépôt**. Sinon Cloud Shell n’a pas accès à votre compte et le script ne peut rien créer.

## Ce que ça fait

1. Gmail surveille votre boîte (la boîte de réception, par défaut).
2. À chaque changement, Gmail publie une notification dans un sujet Pub/Sub de votre projet.
3. Une fonction Cloud Run lit les **nouveaux** messages depuis le dernier point connu.
4. Elle envoie, pour chaque message, un petit JSON au webhook.
5. Tous les jours, une tâche planifiée renouvelle la surveillance (Gmail l’oublie au bout de 7 jours).

Le corps du message et les pièces jointes ne sont pas envoyés, sauf si vous le demandez explicitement. L’application ne peut que **lire** le courrier (`gmail.readonly`) : elle ne peut ni envoyer, ni supprimer, ni modifier un message.

## Confidentialité

- Le programme tourne uniquement dans le projet Google que vous choisissez.
- Le jeton OAuth, l’identifiant du client et la clé du webhook sont dans Secret Manager, dans ce même projet.
- Les journaux de la fonction enregistrent un compteur et un statut. Ils ne contiennent ni le contenu du message, ni l’objet, ni les secrets. La notification Pub/Sub envoyée par Gmail contient seulement l’adresse de la boîte et un numéro d’historique ; les journaux de la plateforme peuvent la conserver.
- Le curseur (« dernier message déjà traité ») est un petit fichier dans un bucket Cloud Storage privé de votre projet.
- Le webhook ne reçoit que les champs listés plus bas.

## Coût

Google demande un compte de facturation, même quand la facture reste à 0 €. Pour une boîte personnelle, l’usage reste dans le niveau gratuit :

- Cloud Run : 2 millions d’appels par mois
- Cloud Scheduler : 3 tâches gratuites
- Pub/Sub : 10 Gio par mois
- Secret Manager : 6 versions actives (le script n’en garde qu’une par secret)
- Cloud Storage (régions US, dont `us-central1`) : 5 Go

L’image du conteneur dans Artifact Registry peut coûter quelques centimes par mois. Rien d’autre n’est prévu pour un usage personnel. La région par défaut est `us-central1`, celle du niveau gratuit.

## Avant de commencer

Il vous faut un compte Google, un projet Cloud vide (ou un projet qui n’est pas déjà utilisé pour autre chose) et un compte de facturation lié. Le projet doit être **le vôtre** : c’est lui qui héberge le jeton.

### 1. Créer le projet

1. Ouvrez [console.cloud.google.com](https://console.cloud.google.com/).
2. Dans la barre du haut, cliquez sur le sélecteur de projet, puis **Nouveau projet** / **New project**.
3. Nommez-le par exemple `relais-gmail`, puis créez-le.
4. Notez l’**identifiant** du projet (en bas de la fiche, souvent `relais-gmail-123456`). Le nom affiché et l’identifiant ne sont pas la même chose.
5. Menu (☰) → **Facturation** / **Billing** → associez un compte de facturation. [Raccourci](https://console.cloud.google.com/billing).

### 2. Préparer l’accès à Gmail

Gmail n’accepte de parler à l’application que si vous créez un client OAuth dans ce projet. Aucune validation Google n’est nécessaire pour un usage personnel.

1. Menu → **Google Auth platform** → **Démarrer** / **Get started** (s’il n’y a pas encore d’écran).
   - Nom de l’application : `Relais courriel` (évitez un nom qui contient « Google » ou « Gmail »).
   - E-mail d’assistance : votre adresse.
   - Audience : **Externe** / **External** pour un compte `@gmail.com`. Si la boîte est dans Google Workspace et le projet appartient au même organisme, choisissez **Interne** / **Internal**.
   - E-mail de contact du développeur : votre adresse.
   - Acceptez, puis créez.
2. Menu → **Google Auth platform** → **Audience**.
   - Sous **Test users** / **Utilisateurs de test**, ajoutez l’adresse Gmail à surveiller.
3. **Publiez l’application avant d’autoriser la boîte.**
   - Toujours sur **Audience**, cliquez **Publier l’application** / **Publish app** et confirmez.
   - Le statut doit afficher **En production** / **In production**.
   - Ne cliquez pas sur « Soumettre pour validation » / « Submit for verification ». Pour vous seul (ou quelques personnes que vous connaissez), Google prévoit une exception : un écran d’avertissement, pas une revue. Un plafond d’environ 100 comptes s’applique, ce qui est largement suffisant.
   - **Pourquoi cette étape.** En mode **Test**, le jeton expire au bout de **7 jours**. Les messages s’arrêtent alors sans message clair. Une fois l’application **en production**, même sans validation, le jeton ne tombe plus au bout de 7 jours. Il peut encore cesser de marcher si vous révoquez l’accès, si vous changez le mot de passe du compte Gmail, ou s’il n’est pas utilisé pendant six mois (ici il l’est tous les jours).
   - Si vous avez déjà autorisé la boîte pendant que l’application était en test, relancez `bash scripts/authorize.sh` **après** la publication. L’ancien jeton ne se prolonge pas tout seul.
   - Compte Workspace **Interne** : pas de publication, pas d’expiration à 7 jours. Seules les adresses de l’organisme peuvent autoriser l’application.
4. Menu → **Google Auth platform** → **Clients** → **Créer un client** / **Create client**.
   - Type : **Application de bureau** / **Desktop app**.
   - Nom : `Relais courriel`.
   - Créez. Copiez le **Client ID** et le **Client secret**. Vous pourrez réafficher le secret en ouvrant ce client plus tard.
   - Ne choisissez pas « Application Web » : le script utilise l’adresse `http://127.0.0.1:8085`, déjà autorisée pour une application de bureau.

Vous n’avez pas à déclarer les scopes à la main. Le script demande uniquement `https://www.googleapis.com/auth/gmail.readonly`.

## Installation

Cliquez sur **Open in Cloud Shell** en haut de cette page.

1. Si une fenêtre demande de faire confiance au dépôt, acceptez. C’est ce qui permet à Cloud Shell d’utiliser votre compte Google.
2. Le guide s’ouvre à droite. Vous pouvez aussi tout faire avec une seule commande, depuis le dossier du dépôt :

```sh
bash scripts/deploy.sh
```

3. Le script demande :
   - l’URL du webhook, en `https://` ;
   - la clé secrète. Elle est envoyée dans l’en-tête `Authorization: Bearer <clé>`. Laissez vide s’il n’y a pas de clé ;
   - le Client ID et le Client secret copiés à l’étape précédente.
4. Il affiche une longue adresse `accounts.google.com`. Ouvrez-la dans le navigateur, avec **la même adresse Gmail** que celle ajoutée comme utilisateur de test.
5. Google affiche un avertissement, parce que l’application n’est pas validée. C’est attendu :
   - **Paramètres avancés** / **Advanced**
   - **Accéder à Relais courriel (non sécurisé)** / **Go to Relais courriel (unsafe)**
6. Autorisez la lecture du courrier.
7. Le navigateur ouvre `127.0.0.1` et affiche une erreur du type « impossible d’accéder à ce site ». **C’est normal.** Copiez **toute** l’adresse dans la barre d’adresse (elle contient `code=`) et collez-la dans Cloud Shell.
8. Le script enregistre le jeton, déploie deux fonctions et active la surveillance. À la fin il affiche un résumé. Le jeton n’est jamais affiché.

Si le bouton Cloud Shell vous a ouvert un environnement « éphémère » sans compte :

```sh
# Dans un Cloud Shell normal (icône >_ en haut à droite de la console)
git clone https://github.com/ThomasKientz/gmail-webhook.git
cd gmail-webhook
bash scripts/deploy.sh
```

Choisissez d’abord le projet si Cloud Shell n’est pas déjà dessus :

```sh
gcloud config set project VOTRE_IDENTIFIANT_DE_PROJET
```

Relancer `bash scripts/deploy.sh` est sans danger : ce qui existe déjà est réutilisé. Le script propose de **conserver** le jeton Gmail.

Pour recommencer seulement l’autorisation (par exemple après une publication oubliée) :

```sh
bash scripts/authorize.sh
```

## Essayer

Envoyez un message à la boîte que vous avez autorisée, depuis une autre adresse, ou utilisez « M’envoyer un e-mail » dans Gmail. En général le webhook est appelé dans la minute. Un message parti pendant l’installation peut être ignoré : renvoyez-en un après le résumé du script.

Les journaux de la fonction (sans le contenu du courrier) :

`https://console.cloud.google.com/run/detail/us-central1/gmail-webhook/logs?project=VOTRE_PROJET`

(Remplacez la région si vous n’avez pas gardé `us-central1`.)

### Exemple de charge

```json
{
  "id": "18c5f0e2a1b3c4d5",
  "threadId": "18c5f0e2a1b3c4d5",
  "from": "Ada Lovelace <ada@example.com>",
  "to": "vous@gmail.com",
  "subject": "Bonjour",
  "date": "Thu, 13 Nov 2026 09:15:00 +0100",
  "snippet": "Bonjour, juste un essai.",
  "labelIds": ["INBOX", "UNREAD"]
}
```

L’en-tête HTTP par défaut est `Authorization: Bearer <votre clé>`.

## Réglages

Passez-les à `scripts/deploy.sh`. Un second passage met les fonctions à jour.

| Option | Défaut | Rôle |
| --- | --- | --- |
| `--project` | projet Cloud Shell | Projet qui héberge tout |
| `--region` | `us-central1` | Région des fonctions, du bucket et de la tâche |
| `--webhook-url` | demandé | Adresse `https` appelée pour chaque message |
| `--webhook-key` | demandé | Clé secrète de l’en-tête |
| `--auth-header` | `Authorization` | Nom de l’en-tête |
| `--auth-scheme` | `Bearer` | `Bearer` produit `Bearer <clé>`. `none` envoie la clé telle quelle |
| `--label-ids` | `INBOX` | Étiquettes, séparées par des virgules. Vide = toute la boîte. Plusieurs étiquettes en `include` signifient « au moins une » |
| `--label-behavior` | `include` | `include` ou `exclude` |
| `--payload-fields` | voir ci-dessous | Champs du JSON, séparés par des virgules |
| `--include-body` | non | Ajoute le texte brut (`text/plain`) dans le champ `body`. Un message seulement en HTML donne un corps vide |
| `--schedule` | `0 8 * * *` | Quand renouveler la surveillance |
| `--time-zone` | `Europe/Paris` | Fuseau de cette tâche |

Champs possibles : `id`, `threadId`, `from`, `to`, `cc`, `bcc`, `subject`, `date`, `snippet`, `labelIds`, `historyId`, `internalDate`, `messageId`, `replyTo`, `body`.

Le défaut est `id,threadId,from,to,subject,date,snippet,labelIds`. Pour retirer un champ, repassez la liste sans lui. `date` est l’en-tête Date du message. `internalDate` est l’horodatage Gmail.

Exemple :

```sh
bash scripts/deploy.sh \
  --webhook-url "https://exemple.test/hook" \
  --webhook-key "une-longue-cle" \
  --payload-fields "id,from,subject,date" \
  --label-ids "INBOX"
```

Les étiquettes personnelles ont un identifiant du type `Label_123`, pas leur nom affiché. `INBOX`, `UNREAD`, `SENT`, `STARRED`, `SPAM` fonctionnent tels quels.

Variables d’environnement équivalentes sur les fonctions : `WEBHOOK_URL`, `WEBHOOK_AUTH_HEADER_NAME`, `WEBHOOK_AUTH_SCHEME`, `GMAIL_LABEL_IDS`, `GMAIL_LABEL_FILTER_BEHAVIOR`, `PAYLOAD_FIELDS`, `INCLUDE_BODY`, `HISTORY_EXPIRED_MAX_MESSAGES` (défaut 10), `MAX_HISTORY_MESSAGES` (défaut 500).

Secrets (Secret Manager) : `gmail-oauth-client-id`, `gmail-oauth-client-secret`, `gmail-oauth-refresh-token`, `gmail-webhook-key`.

## Si quelque chose ne va pas

**Le script dit que la facturation n’est pas activée.** Liez un compte de facturation au projet, puis relancez. La facture peut rester à 0 €.

**Google dit que l’application n’est pas validée.** C’est le chemin prévu. Paramètres avancés, puis Accéder à l’application. Ne lancez pas une demande de validation pour un usage personnel.

**Les messages s’arrêtent au bout d’une semaine.** L’écran de consentement est encore en **Test**. Publiez l’application (Audience → Publier), puis `bash scripts/authorize.sh`.

**`invalid_grant` dans les journaux.** Le jeton a été révoqué, a expiré (mode Test), ou le mot de passe Gmail a changé. Relancez `bash scripts/authorize.sh`.

**La surveillance échoue avec une erreur 403.** Le sujet Pub/Sub doit autoriser `gmail-api-push@system.gserviceaccount.com` à publier. Le script le fait. Relancez-le. L’identifiant du projet dans le sujet doit être exactement celui du projet.

**Le webhook répond 401 ou 403.** La clé ou le nom de l’en-tête ne correspond pas à ce que le destinataire attend. Relancez le script avec la bonne clé.

**Rien n’arrive.** Vérifiez que le message est bien dans la boîte de réception (ou dans les étiquettes choisies), que l’adresse autorisée est la bonne, et que l’URL du webhook est en `https`. Regardez les journaux Cloud Run. Le premier point de départ est posé au moment de l’installation : les anciens messages ne sont pas renvoyés, seulement ceux d’après.

**Un trou dans l’historique.** Si Gmail répond que l’historique est trop ancien (souvent après une longue panne), la fonction envoie les derniers messages récents de l’étiquette (10 par défaut) puis reprend. Un message plus ancien peut manquer. Les identifiants déjà envoyés ne sont pas renvoyés.

**Un message part deux fois.** Gmail et Pub/Sub peuvent livrer deux fois. La fonction retient les derniers identifiants envoyés. Un chevauchement très serré de deux exécutions peut encore produire un doublon. Le destinataire devrait accepter le même `id` deux fois.

**Cloud Shell demande de se reconnecter.** Vous êtes dans l’environnement éphémère. Revenez au Cloud Shell habituel et clonez le dépôt (voir plus haut).

## Enlever l’installation

Depuis le dossier du dépôt :

```sh
bash scripts/uninstall.sh
```

Le script demande de retaper l’identifiant du projet. Il supprime les deux fonctions, la tâche quotidienne, le sujet Pub/Sub, le bucket d’état, les quatre secrets et le compte de service. Il ne supprime ni vos e-mails, ni le client OAuth, ni le projet. Le client OAuth se retire dans **Google Auth platform → Clients**. Une image peut rester dans Artifact Registry (`gcf-artifacts`) : supprimez-la dans la console si ce projet ne sert plus à aucune fonction.

Pour révoquer l’accès Gmail : [myaccount.google.com/permissions](https://myaccount.google.com/permissions), puis retirez « Relais courriel ».

## Développement

Les tests ne contactent ni Google ni un webhook.

```sh
npm install
npm test
npm run lint
bash -n scripts/*.sh
shellcheck -x -P scripts scripts/*.sh
```

Licence MIT. Copyright (c) 2026 Thomas Kientz.
