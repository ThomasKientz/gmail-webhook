# Installer le relais Gmail

Ce guide envoie chaque nouveau message Gmail vers un webhook, dans **votre** projet Google Cloud. Rien n’est installé sur votre ordinateur.

## Faire confiance au dépôt

Si Google demande **Trust repository** ou **Faire confiance au dépôt**, acceptez.

Sans ça, Cloud Shell n’utilise pas votre compte et le script ne peut pas créer les ressources. Si vous êtes dans un Cloud Shell « éphémère », fermez-le, ouvrez le Cloud Shell habituel (icône `>_` de la console) et lancez :

```sh
git clone https://github.com/ThomasKientz/gmail-webhook.git
cd gmail-webhook
teachme tutorial.md
```

## Choisir le projet

Créez d’abord un projet sur [console.cloud.google.com](https://console.cloud.google.com/) (sélecteur de projet en haut → **Nouveau projet**). Liez un compte de facturation : Google le demande même si la facture reste à 0 €. Menu → **Facturation**.

Vérifiez le projet actif. S’il est vide ou mauvais, remplacez `VOTRE_IDENTIFIANT` par l’identifiant (pas seulement le nom affiché), par exemple `relais-gmail-123456`.

```sh
gcloud config get-value project
```

```sh
gcloud config set project VOTRE_IDENTIFIANT
```

## Préparer l’accès Gmail

Ouvrez **Google Auth platform** dans le menu de la console.

1. **Démarrer**, si c’est la première fois. Nom : `Relais courriel`. E-mail d’assistance : le vôtre. Audience : **Externe** pour un `@gmail.com`, ou **Interne** si la boîte est dans le même Google Workspace que le projet.
2. Page **Audience** : ajoutez votre adresse Gmail dans les utilisateurs de test.
3. Sur la même page, cliquez **Publier l’application** / **Publish app**. Le statut doit passer à **En production**. Ne demandez pas la validation Google. En mode Test, le jeton expire au bout de 7 jours et les messages s’arrêtent. En production, pour un usage personnel, Google affiche seulement un avertissement.
4. Page **Clients** → **Créer un client** → type **Application de bureau** / **Desktop app**. Copiez le Client ID et le Client secret.

Détail des écrans : le fichier `README.md` du dépôt.

## Lancer l’installation

Placez-vous dans le dépôt si le terminal n’y est pas déjà (`cd gmail-webhook`), puis :

```sh
bash scripts/deploy.sh
```

Répondez aux questions :

- l’adresse `https://` du webhook ;
- la clé secrète (elle part dans `Authorization: Bearer …` ; Entrée si vous n’en avez pas) ;
- le Client ID et le Client secret.

Le script confirme que l’application est publiée, active les API, crée le sujet Pub/Sub, les secrets et deux fonctions. Comptez plusieurs minutes. Vous pouvez le relancer : il reprend là où il s’était arrêté.

## Autoriser la boîte

Le script affiche une longue adresse `accounts.google.com`. Ouvrez-la.

- Connectez-vous avec la boîte à surveiller.
- Sur l’avertissement « application non validée » : **Paramètres avancés**, puis **Accéder à Relais courriel (non sécurisé)**.
- Autorisez la lecture du courrier.
- La page `127.0.0.1` ne s’ouvre pas : c’est normal. Copiez **toute** l’adresse de la barre d’adresse et collez-la dans Cloud Shell.

Le script ne montre pas le jeton. Il affiche seulement l’adresse Gmail autorisée, puis un résumé.

## Envoyer un essai

Envoyez-vous un e-mail (une autre adresse, ou « M’envoyer un e-mail » dans Gmail). Le message doit arriver dans la boîte de réception.

Le webhook reçoit un JSON avec l’identifiant, l’expéditeur, le destinataire, l’objet, la date, un extrait et les étiquettes. Pas le corps du message.

Les journaux, sans le contenu du courrier : Cloud Run → service `gmail-webhook` → Journaux.

## Tout retirer

```sh
bash scripts/uninstall.sh
```

Tapez l’identifiant du projet quand il le demande. Vos e-mails ne sont pas touchés. Le client OAuth se supprime à part, dans **Google Auth platform → Clients**.
