# Banc d'exposition v1.3 : rapport de l'étape 1

Ben, 17/10/2026. Protocole : [`PROTOCOLE-EXPOSITION-v1.3.md`](PROTOCOLE-EXPOSITION-v1.3.md).
Audit d'origine : [`AUDIT-PROTOCOLE-EXPOSITION.md`](AUDIT-PROTOCOLE-EXPOSITION.md).
Artefacts : `out/bench-exposure/step1/summary.json` et `manifest.json`, régénérables par
`npm run bench:exposure:step1` (déterministes : même empreinte d'un run à l'autre).

**Périmètre tenu.** Mesures sur le développement `[2021-01-01, 2023-01-01)` uniquement. Le
ruban de l'étape 1 est **tronqué physiquement** au 2023-01-01 avant tout calcul : aucun
indicateur, aucun régime, aucun prix de la vérification interne n'est calculé. Aucune bougie
de la fenêtre scellée n'est dans le dépôt ni n'a été lue. Aucune variante de SCORE n'a été
exécutée. Aucune écriture en base, aucune variable Railway, aucun déploiement.

Convention : **Fait** = mesuré ou lu dans le code. **Déduction** = mon raisonnement.

---

## Le résultat en bref

1. **Le banc existe et se prouve.** 70 preuves, dont le sceau et le préfixe sur données
   synthétiques. Il y a aussi des invariants externes sur le développement : exposition, cash,
   réentrée lue sur la timeline de production, frontière découpée qui reproduit le run continu
   barre pour barre. Toute la suite `npm test` passe.
2. **Sur le développement, les trois règles dépassent 50 % de drawdown** : T100 64,9 %, R100/0
   70,1 %, RPA 70,8 %. **Les deux règles simples font pire que le témoin**, en rendement comme
   en drawdown.
3. **Déduction décisive :** le drawdown est continu depuis le début de la trajectoire, et le
   développement est le préfixe de la calibration. **R100/0 et RPA ne peuvent donc plus être
   admissibles en calibration**, quoi qu'il arrive sur la vérification. Il ne reste qu'une
   candidate possible, SCORE, à condition de tenir 50 % en 2022.
4. **Le stop de production et la réentrée arbitrée fabriquent l'essentiel de la rotation.**
   Pour T100, environ 90 % de la rotation (91,3 sur 98,2 fois l'équité moyenne) viennent des
   sorties par stop et des rachats qui les suivent. Les frictions coûtent 40 % du capital
   initial en deux ans. Sans le stop (diagnostic hors protocole), elles tombent à 3 %, mais le
   drawdown monte à 75,8 %.
5. **Préalable : aucune composante n'est significative**, à aucun horizon (|t| de Newey-West
   au plus 1,95). La plupart des composantes de tendance changent de signe entre 2021 et 2022.
   Deux ans de données donnent environ 24 périodes indépendantes à 30 jours : la puissance est
   faible, et la sélection des composantes ne pourra pas reposer sur la significativité.

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
- **Ce que le sceau garantit** (arbitrage de Julien sur le P1 Codex du round 1) :
  l'absence de mesure et de réglage sur la fenêtre, imposée par le code. **Il ne garantit pas
  l'ignorance du marché** : les bougies sont publiques ; le bundle v1 les contient et reste
  dans l'arbre de crypto-lab et dans l'historique des deux dépôts ; la PR #36 a calculé des
  indicateurs de régime dessus (aucun résultat de stratégie) ; l'évolution du marché sur
  2024-2026 est connue de toute l'équipe. La fenêtre est « non mesurée », pas « jamais vue ».

### Retrait de l'ancien banc (crypto-buddy)

- `data/calibration/crypto-buddy-exposure-v1/` retiré de l'arbre.
- **`npm test` exécutait l'ancien banc sur le v1**, donc sur la fenêtre scellée, à chaque
  lancement (`exposureCalibration.ts` et `exposureObservation.ts` appelaient `prepareTape`).
  Les preuves qui rejouaient le ruban v1 sont retirées. Les preuves d'observation tournent
  désormais sur le ruban v1.3 tronqué au développement. Le chargeur v1 refuse avant toute
  lecture, et les commandes `calibrate:exposure` / `validate:exposure` sont retirées.
- Le code de l'ancien banc reste en place parce que la production importe `controller.ts` et
  `config.ts`.

### Le banc v1.3 (`src/bench/exposure/`)

| Module | Rôle |
|---|---|
| `windows.ts` | fenêtres, sceau, seul le développement est mesurable, embargo |
| `bundle.ts` | certification des parties v2 ; refuse toute bougie ouverte ou fermée à partir du 2024-07-01, d'abord sur le manifeste, puis ligne par ligne |
| `tape.ts` | régime de production sur 5 actifs (univers vérifié par nom contre la config de production), troncature avant calcul, propriété de préfixe |
| `allocate.ts` | règles du point 7 : figées au poids courant, surpoids qui comprime, `waterfill` de production, `capacite_insuffisante` |
| `policy.ts` | T100, R100/0, RPA, contrat SCORE, seuil de rééquilibrage sur l'exposition totale |
| `execute.ts` | `planMovements` de production (achats au prorata, plancher appliqué comme en production), glissement constant |
| `engine.ts` | marche 4h, porte de production, réentrée, frontière, drawdown continu |
| `metrics.ts`, `stats.ts` | métriques ; Newey-West, Politis-White, bootstrap stationnaire, générateur à graine |
| `components.ts`, `predictive.ts`, `score.ts` | composantes candidates, préalable, outillage SCORE (normalisation apprise sur le développement seul, score composite, cibles exactes, décile de conviction) |

Preuves : `src/test/benchExposure.ts` (70 contrôles), branchées dans `npm test`.

---

## 2. Choix d'implémentation à valider

Ce sont des choix que j'ai tranchés moi-même, parce qu'ils se déduisent du protocole ou du code.
Chacun est visible dans le code et dans `bench_config_sha256`.

1. **Une ligne barrée après un stop est traitée comme une ligne stoppée** : à 0, sa part est
   redistribuée. **Une ligne exclue par RPA va au cash.** Si les deux s'appliquent, l'exclusion
   RPA l'emporte : sa part va au cash.
2. **Une ligne figée est un maintien.** À l'exécution, sa cible est revalorisée au prix
   d'ouverture, pour qu'elle ne trade pas sur une simple variation de prix entre la clôture et
   l'ouverture.
3. **Glissement et frais.** `planMovements` dimensionne sans glissement, comme en production.
   Le glissement réduit ensuite ce que rapporte une vente et ce que reçoit un achat. Si les
   ventes rapportent moins que prévu, les achats sont réduits au prorata du cash réellement
   disponible. Le cash ne passe jamais négatif.
4. **Bande morte du plancher de 2 %.** Une cible de 100 % se réalise autour de 97 % en régime
   libre : chaque ligne peut rester jusqu'à 2 points sous son nominal sans qu'aucune jambe ne
   franchisse le plancher. C'est le comportement de production, son « résidu accepté ». La
   borne structurelle est 92 % (4 lignes × 2 points). La première version de l'invariant
   exigeait 97 % ; elle a échoué sur 10 barres, toutes dans cette bande morte.
5. **Clôture anticipée chez Binance.** La barre 4h du 2020-02-19 à 08:00 a fermé à 11:35 (panne).
   Le chargeur accepte une clôture à l'intérieur de son créneau, jamais au-delà.
6. **Causalité des composantes.** Une bougie journalière est utilisable quand elle est close à
   l'instant de décision (clôture de la barre 4h). La production est plus prudente d'une barre
   pour son régime (bougie close avant l'ouverture de la barre 4h). Les deux règles sont
   causales, et les champs repris du régime suivent la règle de production. Preuve :
   tronquer les données ne change aucun des 3 047 vecteurs antérieurs.
7. **Échantillonnage du préalable.** Une observation par jour UTC, à la clôture de la barre de
   20:00. Le rendement futur va de l'ouverture de 00:00 à l'ouverture h jours plus tard, sur un
   panier acheté aux poids fixes et conservé. Horizons fixés avant de lire un chiffre : 1, 7 et
   30 jours.

---

## 3. T100, R100/0 et RPA sur le développement

Départ : 1 000 $ de cash au 2021-01-01, 4 380 barres 4h. Descriptif, sans seuil ni verdict.

| Politique | Net | Annualisé | Drawdown max | Frais + glissement (% du capital initial) | Rotation | Stops |
|---|---|---|---|---|---|---|
| T100 | 75,4 % | 32,5 % | 64,9 % | 268 $ + 134 $ (40,2 %) | 98,2 | 187 |
| R100/0 | 55,9 % | 24,9 % | 70,1 % | 363 $ + 182 $ (54,5 %) | 125,4 | 145 |
| RPA | 29,9 % | 14,0 % | 70,8 % | 403 $ + 201 $ (60,4 %) | 183,5 | 91 |

La rotation est le volume traité divisé par l'équité moyenne. Le temps passé sous le plus-haut
est de 97 à 98 % pour les trois : le plus-haut de novembre 2021 n'est jamais retrouvé.

**Distribution de l'exposition réalisée** (en %, temps passé par zone en % des barres) :

| Politique | Médiane | Q1 | Q3 | P90 | Moyenne | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| T100 | 100,0 | 82,4 | 100,0 | 100,0 | 84,5 | 6,9 | 5,5 | 12,4 | 75,2 |
| R100/0 | 100,0 | 70,7 | 100,0 | 100,0 | 80,9 | 12,2 | 4,1 | 9,7 | 74,0 |
| RPA | 85,0 | 20,3 | 100,0 | 100,0 | 64,3 | 24,1 | 9,7 | 12,9 | 53,4 |

T100 passe 25 % de son temps sous 80 %, sans risk_off : ce sont les lignes stoppées puis
barrées. La capacité est insuffisante sur 1 673 barres (38 %), parce qu'une ligne BTC ou ETH
hors jeu plafonne le livre à 70 %. C'est l'effet des plafonds annoncé dans l'audit.

**D'où vient la rotation** (en multiples de l'équité moyenne, par cause de l'ordre exécuté) :

| Politique | Stop | Réentrée après stop | Changement de cible totale | Changement d'état de ligne | Dérive |
|---|---|---|---|---|---|
| T100 | 46,7 | 44,6 | 0,0 | 4,5 | 2,4 |
| R100/0 | 38,2 | 36,1 | 38,4 | 10,5 | 2,1 |
| RPA | 25,4 | 29,5 | 11,4 | 114,7 | 2,5 |

**Diagnostic hors protocole : les mêmes règles sans le stop.** Ces trois runs ne sont pas des
candidats : ils mesurent ce que coûtent le stop et sa réentrée.

| Politique, sans stop | Net | Annualisé | Drawdown max | Frictions (% capital initial) | Rotation |
|---|---|---|---|---|---|
| T100 | 89,1 % | 37,6 % | 75,8 % | 3,0 % | 5,9 |
| R100/0 | 75,9 % | 32,7 % | 72,3 % | 37,0 % | 72,1 |
| RPA | 36,4 % | 16,8 % | 69,4 % | 57,4 % | 168,3 |

**Lecture (déductions).**

- **Le stop protège un peu et coûte beaucoup.** Sur T100, il retire 10,9 points de drawdown
  (75,8 → 64,9) et coûte 13,7 points de rendement net. Ses 187 sorties en deux ans font en
  moyenne une sortie tous les 16 jours par actif. Le mécanisme est celui que la PR #36 avait
  vu : le stop vend en transition, la ligne est rachetée dès qu'un régime neutre (`range`
  compris) se confirme, et le cycle recommence.
- **Les sorties sur régime 4h arrivent après la baisse et reviennent trop tôt.** R100/0 sort
  et revient sur le risk_off (38,4 de rotation, environ 19 allers-retours). RPA sort et
  revient actif par actif (114,7) : chaque changement confirmé du régime d'un actif, sur la
  grille 4h, déclenche une vente ou un rachat complet de sa ligne. Avec le stop, toutes deux
  font pire que T100 en drawdown. Sans le stop, elles font à peine mieux (72,3 % et 69,4 %
  contre 75,8 %), toujours loin de 50 %.
- **Sur ce développement, aucune règle de sortie testée ne protège contre 2022.** Mon
  hypothèse : la limite de 50 % ne peut être tenue que par une exposition réellement réduite
  sur toute la durée de la baisse, pas par des sorties tactiques rapides. C'est ce que la
  proposition SCORE de la section 5 met à l'épreuve.

---

## 4. Préalable (exploratoire)

730 jours de développement. Régression du rendement futur du panier sur chaque composante.
Statistique t de Newey-West au retard égal à l'horizon moins un jour, avec embargo à la
frontière (au plus 699 observations à 30 jours). Définitions dans `summary.json`.

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

- Aucune composante n'atteint |t| = 2 sur la période entière.
- Les corrélations à 30 jours vont jusqu'à 0,26 (trend_sma200), mais à 30 jours les erreurs-types
  corrigées du chevauchement valent 1,3 à 6,3 fois les erreurs naïves.
- **Le signe tient sur les deux années** pour `breadth_net`, `rsi_median_4h`,
  `volume_ratio_30_180` et `taker_buy_7d`. Il **s'inverse en 2022** pour toutes les tendances
  et tous les momentums.

**Corrélations entre composantes : trois blocs.**

- Tendance courte : `trend_sma50`, `mom_30d`, `rsi_daily`, `range_position_30d` (0,79 à 0,94).
- Tendance longue : `trend_sma200`, `mom_90d`, `mom_180d`, `drawdown_365d` (0,75 à 0,94).
- Largeur : `breadth_net`, `rsi_median_4h`, `taker_buy_7d` (0,57 à 0,75), reliée à la
  tendance courte par `range_position_30d`.
- `vol_30d` et `volume_ratio_30_180` sont à peu près indépendantes des autres (0,46 entre
  elles).

**Lecture (déductions).**

- **La pente globale positive et la pente 2022 négative ne se contredisent pas.** La
  régression sur deux ans voit surtout l'écart de niveau entre une année haussière à tendance
  positive et une année baissière à tendance négative. À l'intérieur de 2022, le marché
  revenait à la moyenne. Pour une politique d'**exposition**, c'est l'effet de niveau qui
  compte : baisser l'exposition sur toute la durée d'une baisse. C'est exactement ce que les
  règles de sortie rapides ne font pas (section 3).
- **Avec environ 24 périodes indépendantes à 30 jours, ce préalable ne peut pas départager
  les composantes.** Il peut seulement écarter les redondances et signaler les instabilités.
  Le choix doit reposer sur un raisonnement fixé à l'avance, et sur la vérification interne
  une fois les variantes gelées.
- Horizons à retenir : **30 jours** comme horizon principal, cohérent avec une décision
  d'exposition ; **7 jours** en contrôle. L'horizon d'un jour n'apporte rien.
- **Non fait à cette étape** : la contribution propre (régression multivariée) et la
  stabilité sur la vérification. La première peut se faire sur le développement avant le gel ;
  la seconde vient après.

---

## 5. Proposition d'ensemble fini de variantes SCORE à préenregistrer

Pour arbitrage à trois avant toute exécution. Principes : peu de composantes, une par bloc au
plus, poids égaux, normalisation apprise sur le développement seul (moyenne et écart-type de
chaque composante, déjà calculés dans `summary.json`), cible exacte. Même porte, mêmes stops,
même réentrée, même exécution que les règles simples.

**Trois jeux de composantes** (moyenne simple des z-scores) :

| Jeu | Composantes | Pourquoi |
|---|---|---|
| A | `trend_sma200` | une seule composante, bloc tendance longue : l'effet de niveau |
| B | `trend_sma200`, `breadth_net` | ajoute la largeur, le bloc au signe stable |
| C | `trend_sma200`, `breadth_net`, `taker_buy_7d` | ajoute le flux, signe stable, peu corrélé à la tendance longue (0,12) |

**Deux transformations score → cible** : linéaire de z = −1 (0 %) à z = +1 (100 %), bornée ;
paliers 0 / 50 / 100 % aux seuils z = −0,5 et +0,5.

**Seuil de rééquilibrage sur l'exposition totale** : {5, 10, 20} points. Méthode figée : sur
le développement, on retient le seuil qui maximise le rendement annualisé net de chaque
couple (jeu, transformation).

**Sortie en risk_off forcée à 0 %** : non. Le risk_off reste une entrée de la porte (marche 2),
mais ce n'est pas une composante du score. Section 3 : la sortie risk_off est un générateur de
va-et-vient.

Soit 3 × 2 = 6 variantes, chacune avec son seuil appris : 18 runs, sur le développement seul.

**Règle de sélection proposée** : parmi les 6, la variante retenue est celle qui a le meilleur
rendement annualisé net sur le développement, parmi celles qui ont un drawdown ≤ 50 % et une
exposition médiane ≥ 80 % dans leur décile de conviction le plus haut. Une seule variante
part en vérification interne. Si aucune ne remplit ces conditions sur le développement, rien
ne part, et le point 10 s'applique.

**Ce que je déconseille d'ajouter** : un deuxième élément du bloc tendance longue (redondant à
0,84-0,94), la tendance courte (signe instable, rotation), la volatilité (c'est du
dimensionnement par le risque, qui est classé exploratoire).

---

## 6. Limites connues

- Glissement constant (0,05 %), qui ne croît ni avec la volatilité ni avec la rotation. Il
  favorise les politiques qui tournent beaucoup, donc il **sous-estime** le coût de RPA et de
  R100/0.
- Stop évalué une fois par clôture 4h ; en production, il l'est à chaque cycle sur prix vivant.
- Biais de survie de l'univers : les quatre actifs ont été choisis en 2026.
- Le cas « un actif sans prix, les autres oui » n'existe pas dans les données de calibration.
  La règle est écrite et testée unitairement, jamais exercée sur données réelles.
- Les statistiques sont écrites dans le dépôt et testées contre des formes closes : AR(1) pour
  Politis-White, 30,7 contre 32,9 attendus ; borne du bootstrap sur bruit blanc à 1,645
  erreur-type. Elles n'ont pas été comparées à une bibliothèque de référence.

---

## Points qui demandent un arbitrage de Julien et d'Alex

1. **Admissibilité déjà tranchée pour R100/0 et RPA.** Leur drawdown dépasse 50 % sur le
   développement, et le drawdown est continu : elles ne seront pas admissibles en calibration.
   Le confirme-t-on tel quel, sans les rejouer sur la vérification pour le verdict ? Elles
   restent publiées à titre descriptif (point 10.5).
2. **Le stop et la réentrée.** Ils produisent environ 90 % de la rotation de T100 et 40 % de
   frictions en deux ans, pour 11 points de drawdown en moins. Les garde-t-on communs à toutes
   les architectures, SCORE compris, ou préenregistre-t-on dès maintenant l'expérience sur la
   règle de sortie (point 10) ? Par exemple : délai de réentrée, réentrée seulement sur régime
   haussier confirmé, ou stop désactivé.
3. **Les six variantes SCORE de la section 5**, leurs transformations, la grille du seuil de
   rééquilibrage et la règle de sélection sur le développement.
4. **Contribution propre** (régression multivariée des composantes retenues) : la mesure-t-on
   sur le développement avant le gel ?
5. **Choix d'implémentation de la section 2**, en particulier le point 1 (une ligne barrée
   après stop est redistribuée ; une ligne exclue par RPA va au cash ; l'exclusion RPA
   l'emporte).
6. **Hors banc.** La fenêtre scellée est « non mesurée », pas « jamais vue » (arbitrage
   rendu). Le rappeler à côté de tout verdict de validation.
