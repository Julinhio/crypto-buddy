# Rapport : validation scellée de S4, règle de sortie et de rachat

Protocole : `docs/PROTOCOLE-SORTIE-v0.4.md` (v0.3 + changements B0 à B4 de Julien du 31/10/2026, précisions d'ouverture §16).
Artefacts : `out/bench-exit/sealed/opening.json`, `summary.json` et `manifest.json`, produits par `npm run bench:exit:sealed`.

## Verdict du §12 : « Go pilote testnet »

**S4 termine la fenêtre scellée à +10,15 % net, contre −17,62 % pour E1.** Les deux conditions préenregistrées sont remplies : rendement net strictement positif, et strictement supérieur à celui d'E1. Le verdict est appliqué tel qu'écrit.

Ce que le verdict ne dit pas, à lire avec lui (E0, TC44 et le bootstrap sont informatifs par B3) :

- **S4 fait moins bien qu'E0**, la détention à 100 % sans stop : +17,66 % net, soit environ 7,5 points de plus que S4.
- **Le bootstrap ne distingue pas S4 d'E1 avec confiance** : la borne unilatérale à 95 % de l'écart quotidien est négative (−0,037 % par jour, pour une moyenne de +0,041 %). L'avance est réelle sur cette trajectoire, mais elle n'est pas une preuve statistique.
- **Les cinq derniers mois sont mauvais** : −20,1 % en 2026, dans un krach de l'indice de 54,7 % encore ouvert à la fin des données.

## Chronologie et provenance

| Étape | Commit | Heure (UTC) |
|---|---|---|
| Protocole v0.4 (copie de v0.3 + B0 à B4, §16) | `32424ff` | 31/10/2026 12:48:44 |
| Implémentation de l'ouverture, 56 preuves dont la répétition générale | `3bdb363` | 12:48:45 |
| **Gel** : `out/bench-exit/sealed-freeze.json` (S4, comparateurs, verdict, mesures, empreinte scellée, longueurs de bloc du développement) | **`f2cc048`** | 12:49:05 |
| Push de la branche `feat/protocole-sortie-v0.4`, tête distante = `f2cc048` | | **12:49:08** |
| **Ouverture unique** : registre `opening.json` écrit avant toute lecture scellée | HEAD = tête distante = `f2cc048` | **12:49:27** |

- **Une seule ouverture.** Le registre d'ouverture a été écrit en création exclusive avant la lecture du premier octet scellé. Toute nouvelle tentative est refusée dès qu'il existe sur disque ou dans un commit du dépôt. Aucun second rejeu n'a eu lieu, aucun paramètre, comparateur ni verdict n'a changé après lecture.
- **Gel public avant ouverture.** L'ouverture refuse de démarrer si HEAD n'est pas contenu dans la branche distante. Le gel a été poussé 19 secondes avant l'ouverture.
- **Partie scellée authentifiée.** Le manifeste a été comparé octet pour octet au `manifest_sha256` commité dans `data/calibration/crypto-buddy-exposure-v2-validation.fingerprint.json` depuis la production du bundle. Son `bundle_sha256` a été recalculé, chaque fichier haché, chaque ligne rejugée jusqu'au 2026-06-01.

## Fenêtre et épisodes

Fenêtre scellée `[2024-07-01, 2026-06-01)`, 700 jours, lue comme une tranche de la trajectoire continue commencée le 2020-10-01 (§16). Chaque politique est ramenée à 1 000 $ à la clôture 4h du 2024-07-01T00:00.

Épisodes de l'indice du panier encore ouverts après le 2024-07-01 (règle du §9 sur toute la trajectoire) :

| # | Début | Franchissement de −30 % | Creux | Profondeur | Fin |
|---|---|---|---|---|---|
| 1 | 2021-11-09 | 2022-01-06 | 2022-06-19, **avant la fenêtre** | 74,22 % | 2024-11-12, retrouvé |
| 2 | 2024-12-17 | 2025-03-10 | 2025-04-09 | 40,04 % | 2025-07-16, retrouvé |
| 3 | 2025-10-07 | 2025-11-21 | 2026-02-06 | 54,74 % | fin des données, **non retrouvé** |

L'épisode 1 est l'épisode 2 du développement : il se referme dans la fenêtre, ce qui permet à deux nouveaux épisodes de commencer.

## Tableau principal

| Politique | Capital final | Rendement net | Annualisé | Drawdown continu | Frais + glissement | Rotation | Sorties (événements) | Cash moyen | Entièrement en cash | Retard de rachat ép. 2 | ép. 3 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **S4** | **1 101,50 $** | **+10,15 %** | **+5,17 %** | 46,82 % | 23,62 $ (15,75 + 7,87) | 13,7× | 26 (19) | 32,3 % | 17,3 % | 18,2 j | 38,3 j |
| E1 | 823,83 $ | −17,62 % | −9,62 % | 51,92 % | 77,29 $ (51,53 + 25,76) | 48,0× | 87 (82) | 18,9 % | 3,1 % | 4,2 j | 8,8 j |
| E0 *(informatif)* | 1 176,63 $ | +17,66 % | +8,86 % | 55,44 % | 6,99 $ (4,66 + 2,33) | 3,3× | 0 (0) | 0,5 % | 0,0 % | 0,0 j | 0,0 j |
| TC44 *(informatif)* | 893,05 $ | −10,69 % | −5,73 % | 34,52 % | 68,36 $ (45,58 + 22,78) | 43,8× | 87 (82) | 58,7 % | 3,1 % | non revenu | non revenu |

Définitions (v0.3 §15, v0.4 §16) :

- **Drawdown continu** : pire baisse observée dans la fenêtre, mesurée depuis le plus-haut de toute la trajectoire, sur l'équité de clôture 4h. Il n'élimine plus rien (B0).
- **Rotation** : volume échangé divisé par l'équité moyenne de la fenêtre.
- **Sorties** : lignes détenues sorties par la règle (S4) ou par le stop (E1, TC44).
- **Retard de rachat** : jours entre le creux de l'indice et la première clôture 4h à au moins 80 % d'exposition réalisée. TC44 vise 44 % et ne peut jamais l'atteindre.

## Drawdown, avec ses dates

| Politique | Drawdown continu | Plus-haut | Creux | Retour au plus-haut | Depuis le plus-haut de la fenêtre (informatif) |
|---|---|---|---|---|---|
| S4 | 46,82 % | 2024-03-14 (développement) | 2024-09-06 | 2024-12-04 | 40,61 % : 2025-10-07 → 2026-04-02, non retrouvé |
| E1 | 51,92 % | 2021-11-10 (développement) | 2026-02-24 | non retrouvé | 51,90 % : 2024-12-17 → 2026-02-24, non retrouvé |
| E0 | 55,44 % | 2025-10-07 | 2026-02-06 | non retrouvé | 55,44 %, mêmes dates |
| TC44 | 34,52 % | 2025-10-07 | 2026-02-06 | non retrouvé | 34,52 %, mêmes dates |

- S4 entre dans la fenêtre déjà sous son plus-haut de mars 2024, touche son pire point en septembre 2024 et le retrouve en décembre 2024.
- E1 ne retrouve jamais le plus-haut de novembre 2021, ni pendant le développement ni pendant la fenêtre.

## Par année civile

Rendement depuis l'équité reportée ; drawdown continu atteint dans l'année ; exposition moyenne.

| Politique | 2024 (dès le 1er juillet) | 2025 | 2026 (jusqu'au 1er juin) |
|---|---|---|---|
| **S4** | **+19,58 %** (46,82 %, 77,7 %) | **+15,24 %** (31,78 %, 62,0 %) | **−20,07 %** (40,61 %, 69,3 %) |
| E1 | +36,57 % (46,62 %, 85,0 %) | −29,33 % (44,65 %, 79,4 %) | −14,64 % (51,92 %, 80,8 %) |
| E0 | +52,01 % (34,99 %, 99,5 %) | +0,35 % (42,57 %, 99,5 %) | −22,87 % (55,44 %, 99,2 %) |
| TC44 | +13,39 % (27,19 %, 41,6 %) | −12,25 % (23,64 %, 41,3 %) | −10,24 % (34,52 %, 41,0 %) |

Frais et glissement de S4 par année : 6,42 $, 11,03 $, 6,17 $. Stops d'E1 : 24, 50, 13.

## Par épisode (descriptif)

Rendement de la politique sur l'épisode ; drawdown depuis son propre plus-haut à partir du début de l'épisode ; retard de rachat.

| Politique | Ép. 1 (2021-11 → 2024-11) | Ép. 2 (2024-12 → 2025-07) | Ép. 3 (2025-10 → fin) |
|---|---|---|---|
| S4 | +9,92 %, 52,40 %, 31,2 j | −4,34 %, 31,78 %, 18,2 j | −35,01 %, 40,61 %, 38,3 j |
| E1 | −25,93 %, 71,83 %, 6,3 j | −17,51 %, 44,63 %, 4,2 j | −44,66 %, 50,68 %, 8,8 j |
| E0 | +2,30 %, 75,52 %, 0 j | −0,49 %, 42,57 %, 0 j | −48,17 %, 55,44 %, 0 j |
| TC44 | −14,68 %, 49,33 %, non revenu | −3,60 %, 21,46 %, non revenu | −29,92 %, 34,52 %, non revenu |

Le creux de l'épisode 1 tombe dans le développement : ses retards de rachat sont ceux déjà publiés par v0.3.

## Distribution de l'exposition réalisée

| Politique | Moyenne | Médiane | Q1 | Q3 | P90 | 0-20 % | 20-50 % | 50-80 % | 80-100 % |
|---|---|---|---|---|---|---|---|---|---|
| S4 | 67,7 % | 85,7 % | 35,6 % | 100 % | 100 % | 20,5 % | 6,4 % | 16,4 % | 56,7 % |
| E1 | 81,1 % | 97,7 % | 69,8 % | 100 % | 100 % | 5,8 % | 8,1 % | 16,7 % | 69,5 % |
| E0 | 99,5 % | 100 % | 100 % | 100 % | 100 % | 0 % | 0 % | 0 % | 100 % |
| TC44 | 41,3 % | 44,0 % | 43,4 % | 44,5 % | 45,3 % | 6,0 % | 94,0 % | 0 % | 0 % |

Temps où S4 tient chaque actif hors marché : BNB 22,4 %, BTC 23,7 %, ETH 42,6 %, XRP 39,6 %. Rotation de S4 par cause : sorties 5,5×, rachats 5,1×, changements d'état de ligne 2,2×, dérive 0,8×. Celle d'E1 vient à 93,5 % du stop (22,1×) et de son rachat (22,7×).

## Bootstrap (informatif)

Différence quotidienne des rendements logarithmiques, S4 moins comparateur, sur les 700 jours de la fenêtre. Bootstrap stationnaire, 10 000 tirages, graine 20261101, longueurs de bloc Politis-White figées sur le développement.

| Comparaison | Écart moyen par jour | Longueur de bloc figée | Borne inférieure unilatérale à 95 % |
|---|---|---|---|
| S4 − E1 | +0,0415 % | 1,91 | **−0,0367 %** |
| S4 − E0 | −0,0094 % | 8,67 | −0,0919 % |
| S4 − TC44 | +0,0300 % | 1,00 | −0,0447 % |

Les trois intervalles incluent zéro.

## Contrôles

- **Tests de préfixe, tous passés avant toute mesure :**
  - date de début et épisodes du développement inchangés sur les données complètes ;
  - timelines de régime et timelines collantes identiques barre pour barre jusqu'au 2024-07-01 ;
  - table journalière identique ;
  - trajectoires continues de S4, E0, E1 et TC44 identiques champ pour champ à leurs rejeux du développement, capitaux de fin de développement égaux aux valeurs figées.
- **Barre de recouvrement** du 2024-06-30T20:00 identique dans la calibration et la partie scellée.
- **A1** : zéro clôture 4h où une ligne sortie par S4 pèse encore quelque chose après l'exécution de sa sortie.
- **Ordre en attente à la fin des données** : un par politique, compté `pending_not_executed`, comme en v1.3.
- **Répétition générale avant le gel** : sur les données consommées, la procédure complète reconstruit la bande certifiée à l'identique et retrouve les capitaux de v0.3 au millionième (`src/test/benchExitSealed.ts`, preuve 6).

## Lecture

- **Le verdict est « Go pilote testnet », et c'est le seul verdict de cette expérience.** S4 bat le mécanisme actuel de 27,8 points de rendement net sur une fenêtre jamais mesurée. Elle le fait avec 69 % de frais et de glissement en moins (23,6 $ contre 77,3 $) et une rotation 3,5 fois plus faible.
- **D'où vient l'écart avec E1.** E1 perd surtout en 2025 (−29,3 %), où son stop sort 50 lignes puis les rachète, dans une baisse en dents de scie. S4 gagne 15,2 % la même année. Dans les deux krachs de la fenêtre, S4 perd moins qu'E1 : −4,3 % contre −17,5 %, puis −35,0 % contre −44,7 %.
- **Ce qu'il ne faut pas en conclure.**
  - S4 ne bat pas la détention pure : E0 fait mieux de 7,5 points, avec un drawdown plus profond (55,4 % contre 46,8 %).
  - Le bootstrap ne permet pas d'affirmer la supériorité de S4 sur E1 au seuil de 95 %.
  - Une seule fenêtre de 23 mois, sur un univers fixe de quatre actifs, avec un glissement constant.
- **Le risque reste élevé.** Drawdown continu de 46,8 %, −40,6 % depuis le plus-haut d'octobre 2025, non retrouvé au 1er juin 2026. S4 réduit les pertes des krachs sans les éviter, et rachète en 18 à 38 jours après le creux.
- **Ce que le verdict autorise, et rien de plus.** Un pilote sur testnet. Le passage en production reste conditionné, comme en v0.3 §13, au chantier d'exécution autonome (cadence fixe, stop indépendant du modèle), puis à l'accord explicite de Julien. Rien n'a été modifié sur `main`, ni sur Railway, ni en base de production.
