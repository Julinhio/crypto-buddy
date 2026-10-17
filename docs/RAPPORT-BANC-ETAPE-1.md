# Banc d'exposition v1.3 : rapport de l'étape 1, avec la réentrée gelée et les variantes SCORE

Ben, 17/10/2026. Protocole : [`PROTOCOLE-EXPOSITION-v1.3.md`](PROTOCOLE-EXPOSITION-v1.3.md),
amendé le 17/10 (trois chemins de réentrée gelés, note en fin de protocole).
Audit d'origine : [`AUDIT-PROTOCOLE-EXPOSITION.md`](AUDIT-PROTOCOLE-EXPOSITION.md).

Artefacts : `out/bench-exposure/development/summary.json` et `manifest.json`, régénérables par
`npm run bench:exposure:dev`. Ils sont déterministes, et le lanceur refuse d'écrire si l'arbre
n'est pas propre en dehors de son dossier : le manifeste pointe donc vers le commit de code
`9521e94`, et son `crypto_buddy_src_tree_sha` est égal à `HEAD:src`. Les artefacts de la
première version de l'étape 1, produits avec l'ancienne règle de réentrée, restent dans
l'historique à `122601f`.

**Périmètre tenu.** Développement `[2021-01-01, 2023-01-01)` uniquement, ruban **tronqué
physiquement** au 2023-01-01 avant tout calcul. Rien sur la vérification interne, rien sur la
fenêtre scellée. Aucune écriture en base, aucune variable Railway, aucun déploiement.

Convention : **Fait** = mesuré ou lu dans le code. **Déduction** = mon raisonnement.

---

## Le résultat en bref

1. **Le gel du 17/10 est appliqué et prouvé.** 92 preuves, dont les trois chemins de
   réentrée sur un ruban scénarisé :
   - une ligne stoppée reste barrée pendant dix barres de `range` confirmé, puis est libérée
     sur `trend_up` ;
   - une sortie RPA reste mémorisée à travers huit barres de `range` ;
   - R100/0 revient à 100 % à la fin du risk_off.

   Sur le développement, les invariants lus sur la timeline de production le confirment :
   toutes les libérations ont lieu sur `trend_up` ou `reversal_up` confirmé. Le protocole est
   amendé en conséquence.
2. **Admissibilité constatée : R100/0 et RPA sont non admissibles.** Leur drawdown est de
   68,1 % et 51,4 %. Le drawdown est continu, et le développement est le préfixe de la
   calibration : cela ne peut plus changer. T100 fait 71,8 %.
3. **Quatre variantes SCORE sur six tiennent 50 %.** La règle préenregistrée retient
   **SCORE-C-linear**, au seuil de 20 points : 43,3 % annualisé, drawdown de 43,9 %,
   exposition médiane de 100 % dans son décile de conviction le plus élevé.
4. **Déduction décisive pour la suite :** aucun comparateur ne sera admissible en
   validation. R100/0 et RPA sont déjà éliminées, et T100 dépasse 50 % sur la même trajectoire
   continue. D'après le point 10 du protocole, le meilleur verdict accessible à la candidate
   est donc « viable sans comparateur admissible ». Ni preuve forte, ni avantage pratique.
5. **Le stop reste coûteux avec la règle corrigée.** Il ne produit plus 90 % mais environ 93 %
   de la rotation de T100 (67,7 sur 72,8). Il ne retire plus que 4 points de drawdown à T100
   (75,8 % sans, 71,8 % avec), pour 47 points de rendement net en moins (89,1 % contre 41,9 %).

---

## 1. Ce qui a été construit

### Bundle v2 (crypto-lab, PR #2, mergée en `8dfe154`)

| Partie | Contenu | Où |
|---|---|---|
| `crypto-buddy-exposure-v2-core` | BTC, ETH, BNB, XRP, 4h et 1d, `[2020-01-01, 2024-07-01)` | `data/calibration/` (copie octet pour octet) |
| `crypto-buddy-exposure-v2-sol` | SOL, 4h et 1d, `[2020-08-11T04:00, 2024-07-01)` | `data/calibration/` |
| `crypto-buddy-exposure-v2-validation` | les cinq, `[2024-06-30T20:00, 2026-06-01)` | hors dépôt, `OneDrive\Documents\Claude\crypto-buddy-sealed\exposure-v2-validation\` |

- SOL a sa propre configuration. Modifier le producteur pour accepter un début tardif
  changeait son empreinte et cassait la vérification du v1 publié.
- De la partie scellée, seules les empreintes sont commitées
  (`data/calibration/crypto-buddy-exposure-v2-validation.fingerprint.json`). Sa production n'a
  calculé que les contrôles d'intégrité du producteur.
- **Ce que le sceau garantit** (arbitrage de Julien) : l'absence de mesure et de réglage sur
  la fenêtre, imposée par le code. **Il ne garantit pas l'ignorance du marché** :
  - les bougies sont publiques ;
  - le bundle v1 les contient, et reste dans l'arbre de crypto-lab et dans l'historique des
    deux dépôts ;
  - la PR #36 a calculé des indicateurs de régime dessus (aucun résultat de stratégie) ;
  - l'évolution du marché sur 2024-2026 est connue de toute l'équipe.

  La fenêtre est « non mesurée », pas « jamais vue ».

### Retrait de l'ancien banc (crypto-buddy)

- `data/calibration/crypto-buddy-exposure-v1/` est retiré de l'arbre.
- **`npm test` exécutait l'ancien banc sur le v1**, donc sur la fenêtre scellée. Les preuves
  qui rejouaient le ruban v1 sont retirées. Les preuves d'observation tournent sur le ruban
  v1.3 tronqué au développement. Le chargeur v1 refuse avant toute lecture.
- Le code de l'ancien banc reste en place parce que la production importe `controller.ts` et
  `config.ts`.

### Le banc v1.3 (`src/bench/exposure/`)

| Module | Rôle |
|---|---|
| `windows.ts` | fenêtres, sceau, seul le développement est mesurable, embargo |
| `bundle.ts` | certification des parties v2 ; refuse toute bougie ouverte ou fermée à partir du 2024-07-01 |
| `tape.ts` | régime de production sur 5 actifs, troncature avant calcul, propriété de préfixe |
| `allocate.ts` | règles du point 7 : figées au poids courant, surpoids qui comprime, `waterfill` de production, `capacite_insuffisante` |
| `policy.ts` | T100, R100/0, RPA à sortie mémorisée, contrat SCORE, libération sur haussier confirmé seulement |
| `execute.ts` | `planMovements` de production, glissement constant |
| `engine.ts` | marche 4h, porte de production, barre après stop, mémoire RPA, frontière, drawdown continu |
| `metrics.ts`, `stats.ts` | métriques, années civiles ; Newey-West, Politis-White, bootstrap stationnaire |
| `components.ts`, `predictive.ts`, `score.ts` | composantes, préalable, outillage SCORE |
| `variants.ts` | les six variantes préenregistrées, le choix du seuil, la règle de sélection |

Preuves : `src/test/benchExposure.ts` (92 contrôles), dans `npm test`.

---

## 2. Choix d'implémentation

Les sept premiers ont été validés le 17/10. Les quatre suivants sont nouveaux et découlent de
l'exécution des variantes.

1. Une ligne barrée après un stop est traitée comme une ligne stoppée : à 0, sa part est
   redistribuée. Une ligne exclue par RPA va au cash. Si les deux s'appliquent, l'exclusion
   RPA l'emporte.
2. Une ligne figée est un maintien, revalorisé au prix d'ouverture à l'exécution.
3. `planMovements` dimensionne sans glissement. Si les ventes rapportent moins que prévu, les
   achats sont réduits au prorata. Le cash ne passe jamais négatif.
4. Bande morte du plancher de 2 % : une cible de 100 % se réalise autour de 97 % en régime
   libre. La borne structurelle est de 92 %.
5. La barre 4h du 2020-02-19 à 08:00 a fermé à 11:35 (panne Binance) : une clôture à
   l'intérieur de son créneau est acceptée.
6. Une bougie journalière est utilisable quand elle est close à l'instant de décision.
7. Préalable : une observation par jour UTC, horizons de 1, 7 et 30 jours fixés avant lecture.
8. **La mémoire RPA est mise à jour à chaque barre, risk_off compris.** Un `trend_down`
   confirmé pendant un risk_off global reste une sortie dont l'actif doit sortir par un
   régime haussier.
9. **Décile de conviction** : le score lu à la clôture de la barre t est apparié à
   l'exposition réalisée à la clôture de la barre t+1. C'est l'exposition que son ordre a
   produite ; celle de la barre t, le score ne pouvait pas encore la changer.
10. **Égalités** : pour le seuil, la plus petite valeur de la grille ; pour la sélection, la
    variante la plus tôt dans l'ordre préenregistré. Aucune égalité de sélection ne s'est
    produite.
11. **Le seuil est inerte pour les paliers.** Ils ne bougent que par sauts de 50 points, que
    chaque seuil de la grille laisse passer. Les trois essais sont identiques, et l'égalité
    retient 5 points.

---

## 3. T100, R100/0 et RPA avec la réentrée gelée

Départ : 1 000 $ de cash au 2021-01-01, 4 380 barres 4h.

| Politique | Net | Annualisé | Drawdown max | Frais + glissement (% du capital initial) | Rotation | Stops |
|---|---|---|---|---|---|---|
| T100 | 41,9 % | 19,1 % | 71,8 % | 180 $ + 90 $ (27,0 %) | 72,8 | 136 |
| R100/0 | 51,0 % | 22,9 % | 68,1 % | 253 $ + 127 $ (38,0 %) | 97,3 | 113 |
| RPA | 86,4 % | 36,6 % | 51,4 % | 273 $ + 137 $ (41,0 %) | 112,2 | 72 |

**Admissibilité (constat final, point 10.1)** : R100/0 (68,1 %) et RPA (51,4 %) dépassent
50 %. **Toutes deux sont non admissibles.** T100 n'est pas soumis à la limite, mais il la
dépasse aussi (71,8 %).

**Exposition réalisée** (en %, temps par zone en % des barres) :

| Politique | Médiane | Q1 | Q3 | P90 | Moyenne | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| T100 | 88,0 | 35,0 | 100,0 | 100,0 | 67,3 | 17,7 | 13,4 | 13,7 | 55,2 |
| R100/0 | 88,9 | 34,7 | 100,0 | 100,0 | 66,7 | 20,5 | 10,6 | 12,4 | 56,4 |
| RPA | 52,4 | 0,0 | 90,1 | 100,0 | 48,8 | 36,8 | 12,2 | 14,6 | 36,4 |

**Rotation par cause** (en multiples de l'équité moyenne) :

| Politique | Stop | Réentrée après stop | Changement de cible totale | Changement d'état de ligne | Dérive |
|---|---|---|---|---|---|
| T100 | 33,7 | 34,0 | 0,0 | 2,2 | 3,0 |
| R100/0 | 29,3 | 28,7 | 28,7 | 8,0 | 2,5 |
| RPA | 17,5 | 20,8 | 4,7 | 67,5 | 1,7 |

**Diagnostic hors protocole, sans le stop** (ce ne sont pas des candidats) :

| Politique, sans stop | Net | Annualisé | Drawdown max | Frictions (% capital initial) | Rotation |
|---|---|---|---|---|---|
| T100 | 89,1 % | 37,6 % | 75,8 % | 3,0 % | 5,9 |
| R100/0 | 75,9 % | 32,7 % | 72,3 % | 37,0 % | 72,1 |
| RPA | 72,3 % | 31,3 % | 52,9 % | 36,9 % | 108,2 |

**Par année civile** :

| Politique | 2021 : rendement | 2021 : drawdown max | 2021 : exposition moyenne | 2022 : rendement | 2022 : drawdown max | 2022 : exposition moyenne |
|---|---|---|---|---|---|---|
| T100 | 225,7 % | 42,1 % | 64,2 % | -56,4 % | 71,8 % | 70,3 % |
| R100/0 | 230,6 % | 39,2 % | 63,5 % | -54,3 % | 68,1 % | 70,0 % |
| RPA | 179,6 % | 37,2 % | 53,8 % | -33,3 % | 51,4 % | 43,7 % |
| T100 sans stop | 380,1 % | 56,2 % | 99,6 % | -60,6 % | 75,8 % | 99,4 % |
| R100/0 sans stop | 339,5 % | 53,0 % | 95,3 % | -60,0 % | 72,3 % | 84,4 % |
| RPA sans stop | 159,7 % | 39,4 % | 57,6 % | -33,6 % | 52,9 % | 44,6 % |

**Ce que le gel a changé** (mêmes données ; ancienne règle à `122601f`) :

| Politique | Net, avant → après | Drawdown, avant → après | Rotation, avant → après | Stops, avant → après |
|---|---|---|---|---|
| T100 | 75,4 → 41,9 % | 64,9 → 71,8 % | 98,2 → 72,8 | 187 → 136 |
| R100/0 | 55,9 → 51,0 % | 70,1 → 68,1 % | 125,4 → 97,3 | 145 → 113 |
| RPA | 29,9 → 86,4 % | 70,8 → 51,4 % | 183,5 → 112,2 | 91 → 72 |

**Lecture (déductions).**

- **La mémoire RPA fait l'essentiel du progrès de RPA.** Ne plus revenir sur un simple `range`
  coupe la rotation d'état de ligne (114,7 → 67,5) et ramène le drawdown 2022 de 70,8 % à
  51,4 %. Il manque 1,4 point pour l'admissibilité, et le résultat est publié tel quel.
- **Pour T100, attendre `trend_up` coûte plus que racheter sur `range`.** Les lignes stoppées
  restent hors jeu bien plus longtemps : la capacité est insuffisante sur 2 888 barres (66 %),
  et l'exposition médiane descend à 88 %. Le rachat a lieu plus haut, après la confirmation de
  la hausse. Le rendement chute de 75,4 % à 41,9 %, et le drawdown s'aggrave (64,9 → 71,8 %).
- **Le stop, même corrigé, reste le premier poste de rotation** pour T100 et R100/0. Sans lui,
  T100 garde 89,1 % de rendement net pour 3 % de frictions, mais 75,8 % de drawdown.

---

## 4. Préalable (exploratoire, inchangé)

Le préalable ne dépend d'aucune règle d'allocation. Il est identique, octet pour octet, à
celui de la première version de l'étape 1 (vérifié).

| Composante | t, 1 j | t, 7 j | t, 30 j | t, 30 j, 2021 | t, 30 j, 2022 |
|---|---|---|---|---|---|
| breadth_net | 0,69 | 1,14 | 1,43 | 0,78 | 0,43 |
| risk_off | -0,38 | -0,61 | -1,04 | -1,37 | 1,69 |
| trend_sma50 | 0,85 | 1,33 | 1,52 | 1,28 | -0,63 |
| trend_sma200 | 1,21 | 1,34 | 1,33 | 0,63 | -1,86 |
| mom_30d | 1,06 | 1,95 | 1,54 | 1,20 | -0,37 |
| mom_90d | 1,24 | 1,41 | 1,08 | 0,65 | -2,48 |
| mom_180d | 1,00 | 1,22 | 1,25 | 0,17 | -0,68 |
| vol_30d | 0,75 | 0,76 | 0,93 | -0,05 | 1,35 |
| drawdown_365d | 0,95 | 1,14 | 0,96 | 0,12 | -1,79 |
| rsi_median_4h | -0,08 | 1,18 | 1,83 | 1,50 | 0,10 |
| rsi_daily | 1,33 | 1,17 | 1,52 | 1,27 | -0,82 |
| range_position_30d | 1,14 | 1,76 | 1,55 | 1,10 | -0,16 |
| volume_ratio_30_180 | 1,16 | 1,00 | 0,83 | 0,71 | 0,30 |
| taker_buy_7d | 1,55 | 1,25 | 1,28 | 0,92 | 1,54 |

**Faits.**

- Aucune composante n'atteint |t| = 2.
- À 30 jours, les erreurs-types corrigées du chevauchement valent 1,3 à 6,3 fois les erreurs
  naïves.
- Le signe tient sur les deux années pour `breadth_net`, `rsi_median_4h`,
  `volume_ratio_30_180` et `taker_buy_7d`. Il s'inverse en 2022 pour toutes les tendances et
  tous les momentums.
- Trois blocs corrélés :
  - tendance courte : `trend_sma50`, `mom_30d`, `rsi_daily`, `range_position_30d` ;
  - tendance longue : `trend_sma200`, `mom_90d`, `mom_180d`, `drawdown_365d` ;
  - largeur : `breadth_net`, `rsi_median_4h`, `taker_buy_7d`.

**Déduction.** Avec environ 24 périodes indépendantes à 30 jours, le préalable ne départage
pas les composantes. Pour une politique d'exposition, ce qui compte est l'effet de niveau :
réduire l'exposition sur toute la durée d'une baisse.

---

## 5. Les six variantes SCORE (validées le 17/10)

Moyenne simple des z-scores, normalisés sur le développement. Pas de sortie risk_off forcée.
Mêmes porte, stops, réentrée gelée et exécution que les règles simples.

| Jeu | Composantes |
|---|---|
| A | `trend_sma200` |
| B | `trend_sma200`, `breadth_net` |
| C | `trend_sma200`, `breadth_net`, `taker_buy_7d` |

Les transformations : **linéaire** (z = −1 → 0 %, z = +1 → 100 %, bornée) et **paliers**
(0 / 50 / 100 % aux seuils −0,5 et +0,5).

**Choix du seuil de rééquilibrage par variante** (annualisé / drawdown max) :

| Variante | 5 points | 10 points | 20 points | Retenu |
|---|---|---|---|---|
| SCORE-A-linear | 38,7 % / 47,1 % | 38,2 % / 47,3 % | 36,6 % / 48,9 % | 5 |
| SCORE-A-steps | 28,6 % / 54,6 % | identique | identique | 5 (inerte) |
| SCORE-B-linear | 32,6 % / 51,0 % | 32,7 % / 50,7 % | 34,5 % / 49,7 % | 20 |
| SCORE-B-steps | 32,6 % / 51,6 % | identique | identique | 5 (inerte) |
| SCORE-C-linear | 41,7 % / 43,5 % | 40,0 % / 44,7 % | 43,3 % / 43,9 % | 20 |
| SCORE-C-steps | 41,0 % / 49,7 % | identique | identique | 5 (inerte) |

**Résultats de chaque variante, à son seuil retenu :**

| Variante | Net | Annualisé | Drawdown max | Frictions (% capital initial) | Rotation | Stops | Décile : exposition médiane | Éligible |
|---|---|---|---|---|---|---|---|---|
| SCORE-A-linear (5) | 92,4 % | 38,7 % | 47,1 % | 20,9 % | 58,0 | 116 | 89,6 % | oui |
| SCORE-A-steps (5) | 65,4 % | 28,6 % | 54,6 % | 23,7 % | 68,4 | 90 | 89,6 % | non : drawdown |
| SCORE-B-linear (20) | 80,7 % | 34,5 % | 49,7 % | 34,2 % | 97,7 | 106 | 97,7 % | oui |
| SCORE-B-steps (5) | 75,7 % | 32,6 % | 51,6 % | 45,0 % | 132,2 | 75 | 97,6 % | non : drawdown |
| **SCORE-C-linear (20)** | **105,4 %** | **43,3 %** | **43,9 %** | 36,2 % | 95,1 | 109 | 100,0 % | **oui** |
| SCORE-C-steps (5) | 98,8 % | 41,0 % | 49,7 % | 54,9 % | 137,3 | 77 | 100,0 % | oui |

Le décile compte 438 à 441 barres selon la variante. Aucune barre n'est sans score.

**Exposition réalisée :**

| Variante | Médiane | Q1 | Q3 | P90 | Moyenne | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| SCORE-A-linear | 26,6 | 4,7 | 56,3 | 84,4 | 33,4 | 43,1 | 29,2 | 16,5 | 11,3 |
| SCORE-A-steps | 34,6 | 0,0 | 50,4 | 90,2 | 32,7 | 46,9 | 23,2 | 16,2 | 13,7 |
| SCORE-B-linear | 37,1 | 6,9 | 68,1 | 90,0 | 40,9 | 33,9 | 26,3 | 22,3 | 17,6 |
| SCORE-B-steps | 49,7 | 0,0 | 51,6 | 100,0 | 40,7 | 37,0 | 19,8 | 23,1 | 20,0 |
| SCORE-C-linear | 40,4 | 14,7 | 70,1 | 97,7 | 44,2 | 30,8 | 25,2 | 25,3 | 18,7 |
| SCORE-C-steps | 49,7 | 0,0 | 66,6 | 100,0 | 45,1 | 31,6 | 25,1 | 19,7 | 23,6 |

**Rotation par cause :**

| Variante | Stop | Réentrée après stop | Changement de cible totale | Changement d'état de ligne | Dérive |
|---|---|---|---|---|---|
| SCORE-A-linear | 23,0 | 22,0 | 5,0 | 5,8 | 2,3 |
| SCORE-A-steps | 22,0 | 21,6 | 13,8 | 8,7 | 2,1 |
| SCORE-B-linear | 22,4 | 28,1 | 35,3 | 9,8 | 2,1 |
| SCORE-B-steps | 18,2 | 21,2 | 70,7 | 19,9 | 2,2 |
| SCORE-C-linear | 21,8 | 23,7 | 36,2 | 11,6 | 1,9 |
| SCORE-C-steps | 17,1 | 19,6 | 70,0 | 28,7 | 1,9 |

**Par année civile :**

| Variante | 2021 : rendement | 2021 : drawdown max | 2021 : exposition moyenne | 2022 : rendement | 2022 : drawdown max | 2022 : exposition moyenne |
|---|---|---|---|---|---|---|
| SCORE-A-linear | 160,9 % | 35,6 % | 52,1 % | -26,3 % | 47,1 % | 14,6 % |
| SCORE-A-steps | 158,0 % | 34,0 % | 51,5 % | -35,9 % | 54,6 % | 14,0 % |
| SCORE-B-linear | 164,7 % | 38,0 % | 54,5 % | -31,7 % | 49,7 % | 27,2 % |
| SCORE-B-steps | 155,8 % | 38,4 % | 56,2 % | -31,3 % | 51,6 % | 25,3 % |
| SCORE-C-linear | 180,1 % | 35,8 % | 54,1 % | -26,7 % | 43,9 % | 34,3 % |
| SCORE-C-steps | 197,7 % | 37,2 % | 54,3 % | -33,2 % | 49,7 % | 35,9 % |

### Sélection (règle préenregistrée)

Sont éligibles les variantes au drawdown ≤ 50 % et à l'exposition médiane ≥ 80 % dans le
décile de conviction le plus élevé : A-linear, B-linear, C-linear, C-steps. La retenue est
celle qui a le meilleur rendement annualisé net : **SCORE-C-linear, seuil de 20 points**, à
43,3 %. Viennent ensuite C-steps (41,0 %), A-linear (38,7 %) et B-linear (34,5 %).

**C'est la seule variante qui part en vérification interne**, une fois cette sélection
arbitrée.

**Lecture (déductions).**

- **SCORE tient la limite en réduisant l'exposition sur la durée de la baisse**, pas par des
  sorties rapides. L'exposition moyenne de C-linear passe de 54 % en 2021 à 34 % en 2022, et sa
  rotation de cible totale reste modérée (36,2). C'est l'hypothèse de la section 3 de la
  première version de ce rapport.
- **Les marges sont minces.** Trois des quatre éligibles finissent entre 47 et 50 %, et deux
  variantes sur six échouent de moins de 5 points. La candidate a la plus grande marge
  (6,1 points), mais c'est une sélection **dans l'échantillon** : le seuil et la variante sont
  choisis sur le développement. La vérification interne sert précisément à le mesurer.
- **Le stop pèse aussi sur SCORE** : stops et réentrées font 45,5 des 95,1 de rotation de
  C-linear, et les frictions coûtent 36,2 % du capital initial en deux ans.
- **Exposition** : la moyenne de C-linear est de 44 %, et elle ne passe que 18,7 % de son temps
  au-dessus de 80 %. L'exigence du point 8 est remplie (100 % dans le décile le plus élevé),
  mais le mandat « toute l'enveloppe mobilisable » reste peu utilisé hors des convictions
  fortes.

---

## 6. Limites connues

- Glissement constant (0,05 %) : il sous-estime le coût des politiques qui tournent beaucoup.
- Stop évalué une fois par clôture 4h, à chaque cycle en production.
- Biais de survie de l'univers : les quatre actifs ont été choisis en 2026.
- Le cas « un actif sans prix, les autres oui » n'existe pas dans les données ; la règle est
  testée unitairement seulement.
- **Sélection dans l'échantillon** : seuil et variante choisis sur le développement. Le
  rendement de la candidate sur le développement est donc optimiste par construction.
- Statistiques écrites dans le dépôt et testées contre des formes closes :
  - Politis-White sur AR(1) : 30,4 attendu 32,9 ;
  - coupure MA(1) au retard 1, bruit blanc au retard 0 ;
  - borne du bootstrap sur bruit blanc à 1,645 erreur-type.

  Les autocorrélations prennent leurs dénominateurs sur les observations du produit croisé, et
  non avec le décalage de l'implémentation `arch`.

---

## Points qui demandent un arbitrage de Julien et d'Alex

1. **Ouverture de la vérification interne pour SCORE-C-linear** (seuil de 20 points), seule
   candidate. Il faut d'abord figer et commiter la candidate, la règle de décision et les
   paramètres du bootstrap (point 10). Le confirme-t-on ?
2. **Le verdict accessible est plafonné.** R100/0 et RPA sont non admissibles, et T100 dépasse
   50 % sur la trajectoire continue. Aucun comparateur décisionnel n'existera donc en
   validation, et le meilleur verdict possible est « viable sans comparateur admissible ».
   L'accepte-t-on tel quel, ou veut-on préenregistrer un comparateur supplémentaire avant
   l'ouverture (ce serait un amendement) ?
3. **RPA échoue de 1,4 point.** Le protocole interdit de relâcher la limite, et le résultat est
   publié tel quel. Je le signale pour qu'il ne soit pas relu comme un quasi-succès.
4. **Le stop.** Même corrigé, il reste le premier poste de rotation. Pour T100, il coûte
   47 points de rendement net pour 4 points de drawdown en moins. Le point 10 prévoit une expérience sur la règle de sortie : la
   préenregistre-t-on maintenant, séparément de la candidate ?
5. **Les quatre nouveaux choix d'implémentation** de la section 2 (points 8 à 11), en
   particulier l'appariement du décile de conviction à l'exposition de la barre suivante.
6. **Hors banc.** La fenêtre scellée est « non mesurée », pas « jamais vue ». Le rappeler à côté
   de tout verdict de validation.
