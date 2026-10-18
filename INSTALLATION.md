# Installer l'appli web sur le PC et le téléphone

L'appli web (dossier `web/`) fonctionne hors ligne et se synchronise par un dossier caché de ton
Google Drive. Il faut faire trois choses, une seule fois :

1. Créer un identifiant de connexion Google (environ 15 minutes).
2. Publier l'appli à une adresse https (GitHub Pages, gratuit).
3. L'installer sur le Pixel et sur le PC.

---

## 1. Identifiant Google (console Google Cloud)

Sur <https://console.cloud.google.com>, connecté avec ton compte Google :

1. **Créer un projet** : menu des projets en haut → « Nouveau projet » → nom `pyPriority` → Créer.
2. **Activer les API** : « API et services » → « Bibliothèque » →
   - rechercher **Google Drive API** → Activer ;
   - rechercher **Google Calendar API** → Activer.
3. **Écran de consentement** : « API et services » → « Écran de consentement OAuth » (ou « Google Auth Platform »)
   → Commencer :
   - nom de l'application : `Mes priorités`, adresse e-mail d'assistance : la tienne ;
   - audience : **Externe** ;
   - coordonnées : ton adresse ;
   - accepter et créer.
   - Dans « Audience », laisser le statut **En test** et ajouter ton adresse Gmail dans **Utilisateurs test**.
4. **Créer l'identifiant** : « Clients » (ou « Identifiants » → « Créer des identifiants » → « ID client OAuth ») :
   - type d'application : **Application Web** ;
   - nom : `Mes priorités` ;
   - **Origines JavaScript autorisées** : ajouter
     - `http://localhost:8080` (pour tester sur le PC),
     - `https://TON-COMPTE.github.io` (l'adresse de publication, étape 2) ;
   - pas d'URI de redirection ; Créer.
5. Copier l'**ID client** (il se termine par `.apps.googleusercontent.com`) et le coller dans
   [`web/config.js`](web/config.js) :

   ```js
   export const GOOGLE_CLIENT_ID = "1234…apps.googleusercontent.com";
   ```

   Ce n'est pas un secret : il ne fonctionne que depuis les origines autorisées ci-dessus.

**À savoir :**
- À la première connexion, Google affiche « Google n'a pas validé cette application ». C'est normal pour une appli
  personnelle en test : « Paramètres avancés » → « Accéder à Mes priorités ». Coche **les deux** accès
  (Drive pour la synchronisation, Agenda pour le planning).
- Accès demandés : `drive.appdata` (uniquement le dossier caché de l'appli, pas tes fichiers Drive) et
  `calendar.readonly` (lecture seule de l'agenda).

## 2. Tester sur le PC avant de publier

Double-clic sur **`Tester l'appli web.bat`** : l'appli s'ouvre sur <http://localhost:8080>.
Paramètres → **Connecter Google** → choisir le compte → autoriser. Ajoute une tâche : le témoin en bas de
la barre latérale doit passer à « ✓ Synchronisé ».

Les tests automatiques de l'appli web sont sur <http://localhost:8080/tests.html> (tous doivent être verts).

## 3. Publier sur GitHub Pages

1. Créer un compte sur <https://github.com> si besoin, puis un dépôt **public** nommé `pyPriority`
   (GitHub Pages gratuit exige un dépôt public ; le code n'a aucun secret et tes données n'y sont jamais).
2. Envoyer le projet :

   ```bash
   git remote add origin https://github.com/TON-COMPTE/pyPriority.git
   ```

   ```bash
   git push -u origin main
   ```

3. Sur GitHub : dépôt → **Settings** → **Pages** → Source : **GitHub Actions**.
   Le workflow `.github/workflows/pages.yml` publie le dossier `web/` à chaque envoi.
4. L'appli est à l'adresse **`https://TON-COMPTE.github.io/pyPriority/`**. Vérifie que
   `https://TON-COMPTE.github.io` est bien dans les origines autorisées (étape 1.4).

## 4. Installer sur le Pixel

1. Ouvrir `https://TON-COMPTE.github.io/pyPriority/` dans **Chrome**.
2. Menu ⋮ → **Installer l'application** (ou « Ajouter à l'écran d'accueil »).
3. Ouvrir l'appli depuis l'écran d'accueil → Menu → Paramètres → **Connecter Google**.

Sur le PC, même chose dans Chrome ou Edge : icône d'installation dans la barre d'adresse.

## Récupérer les données de pyPriority PC (version Python)

Dans l'ancienne version : Paramètres → **Exporter en JSON**. Dans l'appli web : Paramètres → **Importer un fichier…**.
L'import ne crée pas de doublons si tu le refais.

## Fonctionnement au quotidien

- **Hors ligne** : tout fonctionne ; les modifications partent à la prochaine connexion
  (témoin « Modifications en attente »).
- **Synchronisation** : automatique après chaque modification, à l'ouverture et toutes les 5 minutes.
  Si tu modifies la même tâche sur deux appareils, chaque champ garde sa valeur la plus récente
  (par exemple le titre changé sur le PC et le quadrant changé sur le téléphone sont tous deux conservés).
- **Connexion Google** : Google donne un accès valable une heure. Passé ce délai, le témoin affiche
  « Toucher pour reconnecter Google » : un toucher ouvre brièvement la fenêtre Google, qui se referme seule.
- **Sauvegardes** : une copie par jour dans le dossier caché du Drive, 30 conservées, restaurables depuis
  Paramètres. Une restauration commence toujours par sauvegarder l'état actuel.
- **Où sont les données ?** Dans le navigateur de chaque appareil (IndexedDB) et dans le dossier caché du Drive,
  visible dans Drive → Paramètres → **Gérer les applications** (on peut y supprimer les données cachées).

## Mettre à jour l'appli

Après une modification dans `web/`, augmenter `VERSION` dans `web/sw.js` **et** `APP_VERSION` dans
`web/app.js` (même valeur), puis envoyer sur GitHub. Les appareils affichent « Une nouvelle version est
disponible · Recharger ».
