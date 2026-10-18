# pyPriority

Gestion des priorités (matrice d'Eisenhower), planning sur un ou plusieurs jours avec Google Agenda, et notes
rattachées aux tâches.

Deux versions, avec la même interface :

| | Appli web (`web/`) — **principale** | Version PC (`app.py`) |
|---|---|---|
| Appareils | PC, téléphone Android (installable) | PC uniquement |
| Données | navigateur de chaque appareil + Google Drive | `priorites.db` sur le PC |
| Hors ligne | oui | oui (serveur local) |
| Agenda | Google Agenda (connexion Google) | adresse iCal privée |

Installation de l'appli web : voir **[INSTALLATION.md](INSTALLATION.md)**. Pour passer de la version PC à l'appli web :
Paramètres → Exporter en JSON (version PC), puis Paramètres → Importer un fichier (appli web).

## Utilisation

| Saisie rapide | Effet |
|---|---|
| `#projet` | projet (créé s'il n'existe pas) |
| `!1` … `!4` | quadrant (1 = urgent et important) |
| `~45`, `~1h30` | durée estimée |
| `@auj`, `@demain`, `@lun`, `@12/10`, `@2026-10-12` | échéance |

Raccourcis : `N` nouvelle tâche, `/` filtrer, `1` `2` `3` changer de vue, `Échap` fermer, `Ctrl+Entrée` enregistrer une note.
Planning : `T` aujourd'hui, `D` un jour, `X` trois jours, `W` semaine, `←` `→` période précédente ou suivante ;
glisser dans le mini-calendrier pour afficher plusieurs jours (jusqu'à 14).

Une tâche planifiée un jour passé et non terminée revient automatiquement dans « Reportées » avec un compteur de reports.
On ne peut pas planifier une tâche non terminée dans le passé.

## Appli web : données et sécurité

- Stockage local IndexedDB, écritures « tout ou rien » ; plusieurs onglets ouverts restent cohérents.
- Synchronisation par un fichier JSON dans le dossier caché de Google Drive (`drive.appdata`) : fusion champ par champ
  (la valeur la plus récente gagne, horloge hybride), suppressions définitives propagées, fichiers en double fusionnés,
  fichier illisible mis de côté avant remplacement.
- Sauvegarde quotidienne dans Drive (30 conservées), restauration depuis Paramètres ; export et import JSON.
- Corbeille : 30 jours. Hors ligne complet grâce au service worker.
- Tests : `web/tests.html` (servi en local par `Tester l'appli web.bat`, puis ouvrir `/tests.html`).

Structure : `web/store.js` (données, logique, fusion), `web/sync.js` (Drive), `web/google.js` (connexion, API Google),
`web/calendar.js` (agenda), `web/app.js` (interface), `web/sw.js` (hors ligne).
Icônes : `python tools/make_icons.py`.

## Version PC

- `Lancer.bat` : avec une fenêtre de console (Ctrl+C pour arrêter).
- `Lancer sans console.vbs` : en arrière-plan ; arrêt par Paramètres > Quitter l'application.
- Relancer alors que l'application tourne déjà ouvre simplement le navigateur.
- Options : `python app.py --port 8800 --data D:\autre\dossier --no-browser`

Données : `priorites.db` (SQLite, WAL, transactions), `backups/` (copie quotidienne, 30 conservées, et avant toute
migration), `priorites.log` (journal). Serveur limité à la machine locale, requêtes d'autres sites refusées,
contrôle d'intégrité au démarrage.

Tests : `python -m unittest discover -s tests -t .` — structure : `priority/db.py`, `priority/ical.py`,
`priority/server.py`, `static/`, `tests/`. Pour modifier le schéma : ajouter une entrée à `MIGRATIONS` dans `db.py`.
