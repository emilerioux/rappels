# Rappels

Listes de rappels pour iPhone : on écrit ou on dicte une phrase comme on la dit
(« demain 15h appeler maman », « chaque mardi soir sortir le recyclage »), l'app
trouve la date, la répétition et la liste, et une notification arrive à l'heure.
On coche quand c'est fait. Claude peut aussi en ajouter (skill `/rappel`).

## Comment ça marche

```
iPhone (PWA, GitHub Pages)  ──API JSON + clé──▶  Worker Cloudflare  ──▶  D1 (SQLite)
        ▲                                              │
        └──────── Web Push (notif à l'heure) ◀── cron toutes les minutes
Claude (skill /rappel) ──API JSON + clé──▶ même Worker
```

| Fichier | Rôle |
| --- | --- |
| `js/parse.js` | Lit les phrases en français (dates, heures, « chaque… », `#liste`) |
| `js/dates.js` | Affichage des dates, prochaine occurrence d'un rappel récurrent |
| `js/store.js` | État local + file d'attente hors ligne vers le serveur |
| `js/app.js` | Écran, compositeur, dictée, glisser, feuilles, notifications |
| `js/ui.js`, `js/motion.js` | Feuille du bas et ressorts (repris de Popote/Reps) |
| `sw.js` | Cache hors ligne, réception des notifs, badge de l'icône |
| `worker/src/index.js` | API + envoi des notifs dues (cron) |
| `worker/src/push.js` | Web Push en WebCrypto pur (chiffrement RFC 8291 + VAPID) |
| `worker/src/recur.js` | Récurrences en heure de Montréal (heure d'été comprise) |

## Serveur (une seule fois)

```powershell
cd worker
npm install
npx wrangler login
npx wrangler d1 create rappels          # copier database_id dans wrangler.toml
npx wrangler d1 execute rappels --remote --file=schema.sql
# secrets : TOKEN (clé de l'app), VAPID_PUBLIC, VAPID_PRIVATE (JWK)
npx wrangler secret put TOKEN
npx wrangler deploy
```

Essai local : `npm run dev` (avec un fichier `.dev.vars`), puis dans l'app
`localStorage["rp-api"] = "http://127.0.0.1:8787"`.

## Sur l'iPhone

1. Ouvrir le lien avec la clé (`…/rappels/#cle=…`) dans Safari → **Copier ma clé**.
2. **Partager → Sur l'écran d'accueil**.
3. Ouvrir Rappels depuis l'écran d'accueil, coller la clé, **Activer les notifications**.

Les notifications web sur iPhone demandent iOS 16.4+ et l'app ouverte depuis l'écran d'accueil.

## Déploiement

GitHub Pages sur `main`. **Bumper `VERSION` dans `sw.js` à chaque déploiement.**
Serveur : `cd worker; npx wrangler deploy`.
