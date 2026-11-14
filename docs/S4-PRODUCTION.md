# S4 en production (pilote testnet) — exploitation

Depuis le 06/11/2026, S4 décide seul de l'état cible du portefeuille. S4 est la règle validée par le protocole de sortie v0.4 (gel `f2cc048`, « Go pilote testnet »). Depuis le 14/11/2026, plus aucun modèle n'intervient : le motif Telegram d'un mouvement est écrit par le code (voir « Ce que le bot affiche »).

## Ce qui tourne

- **Cadence.** Un cycle sur la grille 4h, 3 minutes après chaque frontière (00:03, 04:03…). Le cron Railway bat toutes les 5 minutes.
- **Décision d'état S4.** Elle a lieu une fois par clôture journalière UTC, avec les règles du banc (`stepTrailingLine`, `src/bench/exit/rules.ts`) :
  - stop suiveur de 20 % sur les clôtures journalières depuis l'entrée ;
  - au moins 10 jours hors marché ;
  - rachat sur recroisement de la moyenne 50 jours.

  Chaque clôture est consommée une seule fois, en une transaction : `s4_commit_closes`, journal unique par `(close_at, asset)`.
- **Moteur d'exécution.** Il tourne à chaque cycle et reprend le banc (`s4Allocation`, `allocate`) :
  - cible 100 % aux poids 32,5 / 32,5 / 20 / 15, plafonds 35 / 35 / 20 / 15 ;
  - la part d'un actif sorti reste en cash ;
  - porte de transition aveugle au risk_off global, stop de 10 % neutralisé ;
  - une sortie S4 passe un gel, un rachat l'attend ;
  - plancher de 2 % et rééquilibrage de dérive dans `planMovements`.

## Ce que le bot affiche

Trois affichages, tous construits par le code à partir de valeurs enregistrées (chantier du 14/11/2026).

- **Notification d'un mouvement.** Chaque mouvement porte son motif, écrit par `formatS4Motif` (`src/s4/motif.ts`) :
  - la cause est celle que le cycle attribue (`s4MoveReason`) : transition initiale, sortie S4, rachat S4 ou rééquilibrage ;
  - les valeurs sont celles de la clôture qui a décidé, telles que le journal `s4_close_decisions` les a enregistrées. Exemple : « BTC vendu : clôture 68 314 sous le seuil de sortie 69 296 (20 % sous le plus-haut 86 620). »
  - un mouvement qui exécute une décision prise par un cycle précédent (ordre non rempli, rachat qui attendait un gel) relit le journal après le cycle et nomme la clôture qui a décidé ;
  - si le journal ne peut pas être relu, le motif le dit. Aucun chiffre n'est jamais reconstitué.
- **Bilan du jour.** Une ligne « Pilote S4 (depuis le …) » mesurée depuis `s4_pilot.starting_equity_usd`, et une ligne « Historique (base …$) » mesurée depuis `bot_state.starting_capital_usd`. Le capital indique l'heure de sa valorisation : c'est la photo du dernier cycle, qui peut dater de quatre heures. Une lecture en échec est retentée une fois, puis la ligne affiche « indisponible (lecture en échec) », distinct de « pas de photo de référence ».
- **Photo du portefeuille** (`equity_snapshots`). La photo d'un cycle est le portefeuille après ses ordres et leurs frais (`photoBookOf`). Le portefeuille d'avant les ordres reste dans la ligne de décision (`market_context.book`). Les photos écrites avant le 14/11/2026 montrent le portefeuille d'avant les ordres de leur cycle ; elles n'ont pas été réécrites.

`npm run replay:display` rejoue ces trois affichages sur les valeurs enregistrées en base, en lecture seule (par défaut les cycles 3278, 3293 et 3323).

## Coupe-circuit

Pour arrêter tout nouvel ordre dès le cycle suivant, sans redéploiement :

```sql
update public.s4_pilot set orders_enabled = false, updated_at = now() where id = 1;
```

Les cycles continuent de lire le marché, de décider l'état S4 et de journaliser. Les ordres prévus sont annoncés sur Telegram comme « non envoyés ». Rien ne réactive l'ancienne stratégie, qui n'a plus de chemin vers les ordres.

Pour reprendre : `orders_enabled = true`.

## Données journalières manquantes

Une clôture due mais absente, non close, invalide ou sans moyenne 50 jours bloque le cycle. Dans ce cas :
- la clôture n'est pas marquée comme consommée et aucun ordre ne part ;
- une alerte Telegram part, une seule fois par clôture ;
- le bot retente au réveil suivant (5 minutes).

Les clôtures manquées pendant une panne du bot sont rejouées dans l'ordre au réveil.

## Démarrage reconstruit

L'état de départ n'est pas « quatre actifs en marché ». C'est l'état de la trajectoire du banc rejouée depuis le 2020-10-01 jusqu'à la bascule. La reconstruction est refusée si l'un de ces contrôles échoue :
- elle reproduit 1 101,50 $ sur la fenêtre scellée ;
- elle a le même préfixe de régime et de trajectoire que le banc ;
- l'état final est le même quel que soit le départ.

```bash
npm run s4:reconstruct -- --sealed-dir <bundle scellé> --book <livre.json>
```

Elle écrit `out/s4/reconstruction.json`, `out/s4/seed.sql` (l'amorçage de `s4_pilot` et `s4_line_state`) et les bougies publiques utilisées (`out/s4/live/`).

`npm run s4:dry-run -- --book <livre.json>` rejoue un cycle sur le marché réel sans rien écrire.

Le lot scellé 2024-2026 est versionné depuis le 14/11/2026 dans `data/calibration/crypto-buddy-exposure-v2-validation` (sa fenêtre a été ouverte une fois, pour la validation de S4). Il reste vérifié octet pour octet contre son empreinte.

## Façon de démarrer

Le démarrage ci-dessus reprend l'état de la trajectoire continue. Ce n'est pas la seule façon de faire, et depuis 100 % de cash le code efface le plus-haut d'une ligne qu'il ne détient pas. L'étude `docs/RAPPORT-DEMARRAGE-S4.md` (`npm run bench:start`) compare cinq façons de démarrer sur 320 dates de départ. Elle est descriptive et ne change rien à la production.

## L'ancien pilote

`exposure_pilot` (A.1, clos le 01/11/2026) n'est ni lu ni écrit par S4. Le pilote « S4 testnet » est la ligne unique de `s4_pilot`. Son identité (début, cycle, SHA, capital de départ) est écrite par le premier cycle autorisé à trader.
