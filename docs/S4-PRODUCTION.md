# S4 en production (pilote testnet) — exploitation

Depuis le 06/11/2026, S4 décide seul de l'état cible du portefeuille. S4 est la règle validée par le protocole de sortie v0.4 (gel `f2cc048`, « Go pilote testnet »). Le modèle n'écrit plus que l'explication Telegram d'un mouvement déjà exécuté.

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

## L'ancien pilote

`exposure_pilot` (A.1, clos le 01/11/2026) n'est ni lu ni écrit par S4. Le pilote « S4 testnet » est la ligne unique de `s4_pilot`. Son identité (début, cycle, SHA, capital de départ) est écrite par le premier cycle autorisé à trader.
