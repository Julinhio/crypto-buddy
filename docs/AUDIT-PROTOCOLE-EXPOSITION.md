# Audit de faisabilité : le protocole d'exposition v1.2 confronté au code

Ben, 17/10/2026. Base : `main` à `5b76d64` (PR #49). Protocole audité :
[`PROTOCOLE-EXPOSITION-v1.2.md`](PROTOCOLE-EXPOSITION-v1.2.md).

**Ce que cet audit n'a pas fait.** Aucune bougie de la fenêtre scellée n'a été chargée ni lue
(seuls le manifeste du bundle et les 400 premiers octets d'un fichier, daté de janvier 2020, ont
été ouverts). Aucun replay, aucun chiffre de performance, aucun test exécuté sur les données.
Aucune écriture en base, aucune variable Railway, aucun déploiement. Les seuls chiffres de
performance cités sont ceux **déjà publiés** dans la PR #36, et ils sont signalés comme tels.

Convention : **Fait** = lu dans le code, avec sa référence. **Déduction** = mon raisonnement à
partir des faits, à vérifier lors de la construction.

---

## Verdict en bref

1. **Le protocole est réalisable**, mais pas sur le banc tel quel, et deux préalables passent
   avant toute ligne de code du banc : (a) le bundle actuel contient physiquement la fenêtre
   scellée et le banc calcule ses indicateurs dessus ; (b) le risk_off du banc n'est pas celui
   de la production (4 actifs au lieu de 5, SOL manque).
2. **T100 peut ignorer `risk_off` proprement** : stops, gels et plafonds n'en dépendent pas. Une
   seule marche de la porte change, et dans le sens restrictif.
3. **La redistribution est presque sans objet avec les plafonds actuels.** À cible 100 %, BNB et
   XRP sont déjà à leur plafond : il n'existe que 5 points de marge dans tout le livre. Un BTC
   stoppé plafonne l'exposition à 70 % quoi qu'on redistribue. Le vrai levier du mandat « toute
   l'enveloppe mobilisable », ce sont les plafonds, pas la redistribution.
4. **Le stop de production n'est pas un stop suiveur général.** Il n'est armé que pendant une
   transition, et son contrat dit « pas de réentrée automatique, le modèle décide ». Dans des
   architectures sans modèle, la réentrée devient automatique : il faut une règle, et le
   protocole n'en a pas.
5. **Les chiffres déjà publiés de la PR #36 rendent très probable l'élimination de T100 (et
   peut-être de R100/0) par la limite de 50 %.** Le protocole ne dit pas ce qui se passe si tout
   est éliminé en calibration. Il faut écrire cette issue d'avance, comme la PR #36 l'avait fait.
6. **Le stop déterministe en cas de panne du modèle n'existe pas.** Sur un cycle en échec, le
   stop est seulement annoncé sur Telegram, aucun ordre n'est passé.

---

## 0. Préalable : la fenêtre scellée est dans le bundle, et le banc calcule dessus

**Faits.**

- Le bundle `crypto-buddy-exposure-v1` couvre `[2020-01-01, 2026-08-21)` (`manifest.json`,
  `as_of_exclusive`). Les huit fichiers contiennent donc toute la fenêtre scellée
  `[2024-07-01, 2026-06-01)`.
- `loadVerifiedBundle` lit et parse chaque fichier en entier (`bundle.ts:183`), ce qui est
  nécessaire pour vérifier son SHA-256.
- `prepareTape` calcule ensuite toute la timeline de régimes jusqu'à `as_of_exclusive`
  (`tape.ts:80`, `nowMs: bundle.asOfExclusiveMs`), puis les timelines collantes, **avant** que
  la fenêtre de calibration ne filtre quoi que ce soit. Relancer `calibrate:exposure` aujourd'hui
  calcule des indicateurs sur les bougies scellées. Le résultat de calibration n'en est pas
  contaminé (les indicateurs sont causaux), mais la contrainte dure du brief est violée.
- `VALIDATION_WINDOW` se termine au `2026-08-21` (`tape.ts:118`), pas au `2026-06-01` du
  protocole.

**Proposition.** Rendre la séparation structurelle, dans l'esprit du « plancher de cash non
représentable » de la PR #36 :

- un **bundle v2 de calibration**, produit par `crypto-lab`, qui ne contient physiquement que les
  bougies dont l'ouverture est antérieure au `2024-07-01` (plus SOL, voir point 1) ;
- la partie scellée produite à part, son SHA-256 épinglé et commité, ses fichiers **hors du
  dépôt** jusqu'à l'ouverture ;
- à l'ouverture, un test de préfixe : la timeline calculée sur les données complètes doit être
  identique, barre pour barre, à celle de la calibration sur `[.., 2024-07-01)`. Ce test est
  écrit et exercé dès maintenant sur des données synthétiques.

**Conséquence de bord, à fixer dans le banc.** La dernière barre 4h de calibration ouvre le
`2024-06-30T20:00Z`. Son signal s'exécute à l'ouverture de la barre du `2024-07-01T00:00Z`,
c'est-à-dire sur un prix scellé. En calibration, ce dernier ordre doit rester
`pending_not_executed` et traverser la frontière comme état. Même règle pour les rendements
futurs du préalable (point 3) : aucun horizon ne peut atteindre une ouverture postérieure au
`2024-06-30T20:00Z`.

---

## 1. T100 peut-il ignorer `risk_off` sans perdre les autres protections ?

**Réponse : oui, tel quel, avec une précision de définition.**

**Faits.**

- Le stop et le gel ne lisent pas le risk_off. Le stop s'arme sur `sticky.frozen && held`
  (`gate.ts:156`). Les timelines collantes sont construites sur le régime brut **par actif**
  (`transition.ts:185-188`), sans la posture globale.
- Les plafonds vivent dans l'allocateur (`allocate.ts`) et dans `clampAllocation`, sans lien avec
  le risk_off.
- Le risk_off n'entre dans la porte que par la marche 2 (`gate.ts`, `risk_off_reduction`) : sous
  risk_off confirmé, une ligne gelée ou sans régime **peut être vendue**. Il n'interdit rien de
  plus qu'un gel : il **ouvre** les réductions.
- `evaluateTransition` reçoit `riskOffConfirmed` en argument (`engine.ts:342`).

**Déduction.** T100 = la même fonction `evaluateTransition` avec `riskOffConfirmed: false`.
Effet unique : une ligne gelée pendant un risk_off reste gelée au lieu de devenir vendable, et
une ligne sans régime tombe en `no_regime`. C'est plus restrictif, jamais plus permissif, et à
cible 100 % ça ne mord que sur le rognage d'un surpoids gelé. Stops, gels, plafonds et
indisponibilités sont intacts.

**Ce qui doit être écrit dans le protocole.** « Même porte » signifie « même fonction, entrée
risk_off forcée à faux pour T100 ». Le banc journalise le nombre de barres où les verdicts de
T100 diffèrent de ceux de R100/0, pour que la différence de porte soit lisible.

**Le vrai trou est ailleurs : la réentrée après un stop.** Le contrat du stop de production dit
« pas de réentrée automatique, une fois la transition confirmée, le modèle décide »
(`gate.ts`, commentaire de `evaluateStop`). Dans T100, R100/0 et SCORE, le modèle n'est plus là :
la ligne redevient `actionable` dès que la transition se confirme, et la cible la rachète
aussitôt, y compris quand le régime confirmé est baissier. La PR #36 l'avait déjà mesuré sur son
allocateur proxy : « sortie au creux, réentrée plus haut ». Il faut une règle de réentrée
préenregistrée (aucune réentrée tant que le régime confirmé est baissier, ou délai fixe, ou
réentrée libre assumée). C'est un arbitrage, voir la liste finale.

---

## 2. La redistribution face aux stops, gels, plafonds et actifs indisponibles

**Réponse : réalisable de façon déterministe, et l'outil existe déjà en production. Mais sous
les plafonds actuels, elle ne récupère presque rien.**

**Faits.**

- Le banc ne redistribue jamais (`allocate.ts:356`, « NO redistribution »). Il publie l'écart
  signé, y compris la **sur-exposition** imposée par un surpoids gelé.
- La production a déjà une répartition proportionnelle sous plafonds, avec reversement de
  l'excédent : `waterfill` (`exposure/correct.ts:249`), pure, terminante, testée.
- Plafonds de production : BTC 35, ETH 35, BNB 20, XRP 15, somme 105
  (`config/index.ts:684`).

**La capacité, calculée sur les plafonds (arithmétique, pas une mesure de marché).**

| Ligne bloquée à 0 | Capacité des autres | Panier sans redistribution | Gain de la redistribution |
|---|---|---|---|
| aucune | 105 → cible 100 atteignable | 100 | 0 |
| BTC | 70 | 67,5 | +2,5 |
| ETH | 70 | 67,5 | +2,5 |
| BNB | 85 | 80 | +5 |
| XRP | 90 | 85 | +5 |
| BTC et ETH | 35 | 35 | 0 |

À cible 100 %, BNB (20) et XRP (15) sont **exactement** à leur plafond : toute la marge du livre,
5 points, est sur BTC et ETH. La phrase du protocole « il ne reste du cash que si la capacité
totale est inférieure à la cible » décrira donc **le cas général** dès qu'une ligne est stoppée
ou gelée sous son poids.

**Interactions, ligne par ligne, et la règle que je propose.**

| Situation | Ce que la ligne fait | Ce qu'elle libère ou consomme |
|---|---|---|
| `stop_exit` | va à 0, exempte du plancher de mouvement (comme `computeStopExits`) | libère son poids nominal |
| `frozen` sous son nominal | reste à son poids courant (gel symétrique) | libère `nominal − courant` |
| `frozen` au-dessus | reste à son poids courant | **consomme** `courant − nominal` |
| `no_regime` | reste à son poids courant (**fail-closed**, comme `capabilityOf`) | idem gel |
| prix indisponible | aucun ordre, poids courant (comme `no_price` dans `planMovements`) | idem gel |
| `risk_off_reduction` (R100/0, SCORE) | ne peut que baisser | plafond effectif = poids courant |

Algorithme proposé, déterministe et en une seule passe :

1. Les lignes figées (gel, sans régime, indisponible) gardent leur poids ; les lignes stoppées
   vont à 0.
2. Budget = cible − somme des poids figés. S'il est négatif (surpoids figé au-delà de la cible),
   les lignes libres vont à 0 et la sur-exposition résiduelle est publiée, comme aujourd'hui.
3. Le budget est réparti par `waterfill` entre les lignes éligibles, au prorata du panier
   32,5 / 32,5 / 20 / 15, la marge de chaque ligne étant son plafond (ou son poids courant si
   elle ne peut que baisser).
4. Ce qui ne trouve pas de place reste en cash, journalisé `capacite_insuffisante`.
5. Plancher de mouvement appliqué ensuite par ligne. Une jambe sous le plancher est abandonnée,
   journalisée `reliquat_inexecutable`, **et n'est pas redistribuée une seconde fois** (sinon
   l'ordre des passes déciderait de l'exposition).

**Deux décisions de fond que cette règle tranche, et qu'il faut valider.**

- Un surpoids gelé **comprime** les autres lignes pour tenir la cible totale (point 2 de
  l'algorithme). C'est cohérent avec « la cible est une exposition totale », mais ça vend des
  lignes saines pour compenser une ligne qu'on ne peut pas toucher. L'alternative est de
  laisser le surpoids hors cible, comme le banc actuel.
- La redistribution déplace de la capacité vers les autres actifs **au moment où l'un d'eux est
  en transition ou vient d'être stoppé**. Sous les plafonds actuels l'effet est borné à 5 points,
  donc secondaire. Il deviendrait de premier ordre si les plafonds étaient relevés.

**Actifs indisponibles : la règle sera écrite et testée, mais jamais exercée par les données.**
Le seul trou des séries 4h est le 19/02/2020 (`manifest.json`), avant la calibration, et il
touche les quatre actifs à la fois. Le banc saute d'ailleurs la barre entière dès qu'un actif
manque (`engine.ts:289`) et n'exécute rien si une ouverture manque (`engine.ts:454`). Le cas
« un actif indisponible, les autres non » n'existe pas dans `[2021, 2024-07)`. Il se prouve par
des tests unitaires, pas par la calibration.

---

## 3. Les composantes du score sont-elles calculables sans fuite temporelle ?

**Contenu du bundle (fait).** Pour BTC, ETH, BNB et XRP, en 1d et en 4h, depuis le
`2020-01-01` : `o h l c v`, plus `qv` (volume en USDT), `trades`, `takerBuyBase`,
`takerBuyQuote`. Rien d'autre. SOL est absent.

**Mécanique sans fuite (fait).** `regimeTimeline` n'admet que les barres 4h closes et n'avance
le curseur journalier que sur les bougies journalières closes avant la barre
(`regime.ts:411`, `regime.ts:443`). Le moteur décide sur la clôture de `i` et exécute à
l'ouverture de `i+1`. La règle du protocole est déjà celle du banc.

**Calculables depuis le bundle :**

| Famille | Exemples | Remarque |
|---|---|---|
| Tendance / structure | prix vs SMA50 et SMA200 journalières, EMA21, pente | SMA200 disponible dès mi-2020, donc avant 2021 |
| Momentum temporel | rendements 1 semaine à 6 mois | 12 mois commence pile au 2021-01-01, aucune marge |
| Régime de production | régime par actif, gel, `netBreadth`, risk_off | breadth sur 4 ou 5 actifs : seulement 5 ou 6 niveaux possibles |
| RSI | journalier, 4h, médiane de l'univers | déjà calculé par `regimeTimeline` |
| Position dans le range | 30 jours, 7 jours (4h), pullback / rebond consommés | déjà calculé |
| Volatilité | réalisée, ATR, régime de volatilité | à écrire, causal |
| Drawdown | depuis le plus-haut **depuis 2020** | voir ATH ci-dessous |
| Volume et flux | z-score de `qv`, nombre de trades, ratio acheteur taker | voir rupture Binance ci-dessous |
| Relatif | ETH/BTC, dispersion, corrélation entre les quatre | quatre actifs seulement |

**Non calculables, et pourquoi :**

- **Distance à l'ATH telle que la production la calcule.** La production lit un cache
  ATH/ATL alimenté par une longue série hebdomadaire (`persistence/athAtlCache.ts`). Le bundle
  commence au 2020-01-01 : les ATH de 2017-2018 n'y sont pas. Pour XRP, le plus-haut de janvier
  2018 n'est pas dépassé pendant toute la calibration (fait de marché public), donc « distance au
  plus-haut du bundle » n'est pas la même variable. Calculable seulement avec une série plus
  longue ajoutée au bundle.
- **Funding, open interest, base futures.** Absents. Récupérables auprès de Binance par
  `crypto-lab`, au prix d'un nouveau bundle.
- **On-chain, dominance BTC, capitalisation totale, stablecoins, Fear & Greed, macro, news.**
  Absents, et sources externes avec révisions possibles : le « point-in-time » serait à prouver
  pour chacune.
- **Carnet d'ordres, spread.** Pas d'historique.
- **Toute sortie du modèle.** Aucun historique sur 2021-2024, et le protocole l'exclut.

**Trois pièges de fuite propres au protocole, à écrire dans le banc :**

1. **Embargo aux frontières.** Un signal du `2022-12-28` mesuré à 7 jours lit des prix de la
   vérification interne. Un seuil ajusté sur le développement avec ces rendements fuit dans la
   vérification. Il faut purger, de chaque côté de chaque frontière, les signaux dont l'horizon
   la traverse. À la frontière scellée, c'est le point 0.
2. **La variable cible doit être celle du dimensionnement.** SCORE fixe une **exposition
   totale** appliquée à un panier fixe (point 5). La valeur prédictive à mesurer est donc celle
   d'une composante sur le **rendement futur du panier 32,5 / 32,5 / 20 / 15**, pas sur chaque
   actif. Une composante par actif doit être agrégée avant d'être testée, sinon on mesure une
   capacité d'inclinaison du panier que la politique n'utilise pas.
3. **Rupture de structure des volumes.** De mémoire, à vérifier à la source : Binance a supprimé
   les frais sur les paires BTC de juillet 2022 à mars 2023, ce qui a gonflé le volume BTC
   précisément à cheval sur la frontière développement / vérification. Une composante de volume
   normalisée sur le développement serait alors mal calibrée sur la vérification pour une
   raison sans rapport avec le marché.

**Erreurs-types corrigées du chevauchement.** Aucune bibliothèque statistique dans le dépôt
(`package.json`). Newey-West ou Hansen-Hodrick, avec un retard égal à l'horizon moins un pas,
s'écrivent en quelques dizaines de lignes, avec un test sur une série synthétique de
covariance connue.

---

## 4. Les trois trajectoires peuvent-elles partager les mêmes prix, frais et exécution ?

**Réponse : oui, le moteur est conçu pour, à trois corrections près.**

**Fait.** Toutes les politiques passent par le même `runReplay` : mêmes prix (ouverture de la
barre suivante), mêmes frais (0,1 %), même glissement (0,05 %), même porte de production, même
plancher de mouvement. Les trajectoires divergent ensuite par dépendance au chemin (quels stops
tirent), ce qui est attendu.

**À corriger :**

1. **Biais d'ordre à l'achat.** `executeTargets` achète actif par actif dans l'ordre alphabétique,
   chacun prenant `min(delta, cash)` (`engine.ts:506`). Avec la PR #36, à 70 % d'exposition, il
   restait du cash. À 100 %, frais et glissement des ventes manquent toujours à la fin : **XRP,
   dernier de l'ordre, serait systématiquement sous-pondéré.** La production répartit le budget
   au prorata (`movements.ts:285`). Proposition : construire un `VirtualPortfolio` et appeler
   `planMovements` de production, comme le banc importe déjà la porte au lieu de la réécrire.
2. **Le plancher de mouvement ne s'applique pas tout à fait pareil.** Le banc le teste une fois,
   sur l'écart de poids de chaque ligne. La production le teste sur la jambe, puis **une seconde
   fois** sur la part du budget d'achat qui revient à chaque achat, et ne redistribue pas le
   budget libéré par une jambe abandonnée (`movements.ts`, après la ligne 285). À 100 %, quand
   le budget est juste, c'est ce second test qui décide du reliquat inexécutable. Utiliser
   `planMovements` règle ce point et le précédent.
3. **`no_regime` diverge de la production.** Le banc l'autorise à vendre
   (`NO_REGIME_MAY_REDUCE = true`, `engine.ts:161`) ; la correction de bande de production le
   traite en fail-closed (`capabilityOf`, `band.ts:70`). Il faut s'aligner sur la production.

**Limite commune, à publier.** Le glissement est constant : il ne grossit ni avec la
volatilité ni avec la rotation. Il favorise légèrement l'architecture qui tourne le plus,
probablement SCORE. Le stop est évalué une fois par clôture 4h dans le banc, à chaque cycle sur
prix vivant en production : le banc tire plus tard et moins souvent. Ces deux écarts touchent
les trois trajectoires de la même façon et ne faussent pas leur comparaison, mais ils
éloignent le banc de la production.

---

## 5. L'état traverse-t-il correctement les frontières ?

**Réponse : oui pour l'état du livre ; trois points sont mal posés ou non définis.**

**Faits.** `EngineState` porte cash, positions (quantité et plus-haut du stop) et l'ordre décidé
sur la dernière barre (`engine.ts`, `resume`). La timeline de régimes et l'hystérésis sont
calculées une fois sur toute la série, donc continues par construction. L'équité d'ouverture d'une
fenêtre reprise est celle portée à la frontière, frais de l'ordre de frontière inclus.

**À définir :**

1. **Avec le scellement du point 0, la continuité n'est plus gratuite.** La timeline de
   calibration et celle de validation seront calculées sur deux jeux de données. Le test de
   préfixe du point 0 devient la preuve de continuité.
2. **Le test inverse a une dépendance circulaire.** Ajuster sur la vérification exige de la
   rejouer, donc de partir de l'état du `2023-01-01`, qui est produit par le développement rejoué
   avec les paramètres ajustés sur la vérification. Ça ne fuit pas de rendement, mais ça fait
   lire les prix du développement pour construire l'état. Je propose de partir **à plat** au
   `2023-01-01` pour l'ajustement inverse (indicateurs chauffés depuis 2020), et de l'écrire.
3. **Le drawdown de validation repart de zéro à la frontière.** `drawdown` sème le plus-haut à
   l'équité d'ouverture de la fenêtre (`metrics.ts:96`). Une candidate déjà à −30 % sous son
   plus-haut le `2024-07-01`, qui perd encore 40 % ensuite, lit 40 % en validation, alors que son
   drawdown réel depuis son plus-haut est de 58 %. La limite dure doit dire si le plus-haut est celui de la fenêtre ou celui de toute
   la trajectoire. Même question pour la base d'échantillonnage : le banc mesure sur l'équité de
   clôture 4h, sans les plus-bas intra-barre.

**Et une question de fond :** la candidate validée garde-t-elle les paramètres ajustés sur le
seul développement (ce qui a été vérifié), ou est-elle réajustée sur toute la calibration avant
l'ouverture ? Je recommande la première option : rien n'est réajusté après la vérification.

---

## 6. Ce qui se garde du banc de la PR #36, et ce qui tromperait

**À garder tel quel :**

- la vérification du bundle (`bundle.ts`), y compris le recalcul du `bundle_sha256` ;
- l'import des fonctions de production (régimes, timelines collantes, porte), jamais réécrites ;
- le moteur clôture `i` / ouverture `i+1`, sans barre inventée, `pending_not_executed` en fin de
  série ;
- la reprise d'état aux frontières et l'ancrage de l'équité d'ouverture ;
- le sceau de validation (`validate.ts`) : commande séparée, `source_tree_sha`, `deps_lock_sha`,
  `decisions_sha256`, refus sur dépôt sale ou fichier non commité ;
- la discipline des artefacts (`manifest.json` sans durée, trajectoire régénérable) ;
- les métriques de base : CAGR, drawdown, temps sous l'eau, rotation, frais.

**À garder en changeant une valeur :** limite de drawdown 35 % (`calibrate.ts:53`) et 45 %
(`validate.ts:89`) → 50 % ; `VALIDATION_WINDOW` → fin au `2026-06-01` ; univers du régime → 5
actifs.

**Produirait une mesure trompeuse sous ce protocole :**

| Élément | Pourquoi |
|---|---|
| `deterministicBasket` (`config.ts:79`) | pondération proportionnelle aux plafonds, remplacée par 32,5 / 32,5 / 20 / 15 |
| non-redistribution (`allocate.ts:356`) | contredit la règle 6 |
| `prepareTape` sur tout le bundle | calcule sur la fenêtre scellée (point 0) |
| univers à 4 actifs | risk_off différent de la production (point 7) |
| achats séquentiels | biais contre XRP à 100 % (point 4) |
| `no_regime` vendable | diverge de la production (point 4) |
| projection de moindre changement sur une bande | sans objet pour une cible exacte ; pour SCORE, c'est le seuil de rééquilibrage qui la remplace |
| témoin à exposition appariée (recherche sur 401 cibles) | répond à une autre question ; remplacé par T100 et R100/0 |
| frein RSI, gel asymétrique | hors protocole |
| `feasibleInterval` | utile comme calcul de capacité, à réutiliser, mais il ne prend pas la redistribution en compte |

---

## 7. Autres contradictions entre le protocole et le code

**7.1. Le risk_off du banc n'est pas celui de la production.** La production calcule la largeur
du risk_off sur **5 actifs**, les 4 tradables plus SOL en référence
(`context/build.ts:469`, `universeSize = tradablePairs + referencePairs`). Le seuil de 80 % y
veut dire « 4 sur 5 ». Le banc ne charge que 4 actifs (`tape.ts`, `universeSize:
dataAssets.length`) : 80 % y veut dire « 4 sur 4 », et la RSI médiane est prise sur 4 valeurs au
lieu de 5. R100/0, et toute composante de SCORE fondée sur la largeur, mesureraient donc une
règle qui n'a jamais tourné en production. Il faut SOL dans le bundle v2. Les gels et les stops
ne sont pas touchés (régime par actif).

**7.2. « Stop suiveur à 10 % » est un raccourci.** Le seuil vaut bien 10 %
(`config/index.ts:622`), mais le stop n'est armé que **pendant une transition** (`gate.ts:156`).
Dans un régime baissier confirmé, sans transition en cours, rien ne vend. T100 traverse donc une
baisse confirmée à pleine exposition. Le point « Exploratoire » du protocole doit partir de ce
contrat-là, pas d'un stop suiveur permanent.

**7.3. L'issue négative de la calibration n'est pas écrite.** Fait publié, PR #36 : sur la même
fenêtre et le même univers, le bras C, à 70 % d'exposition moyenne réalisée, a touché
**59,21 %** de drawdown maximal ; le bras A, à 38 %, **38,61 %**. Déduction : une exposition
visée à 100 % dépasserait probablement 50 % en 2022, et seule une sortie franche en risk_off a une
chance de l'empêcher. Le point 8 ne dit pas ce qu'on fait si T100, R100/0 et SCORE sont tous
éliminés : pas de candidate, résultat publié, ou relâchement préenregistré ? Il faut l'écrire
maintenant, avant de voir les chiffres. Je ne calcule rien ici, c'est une lecture de chiffres
déjà publics.

**7.4. Seuil de rééquilibrage et plancher de mouvement.** Les deux sont listés (règles 6). Le
plancher de 2 % existe en production, non surchargeable ; le seuil de rééquilibrage n'existe
pas. Un seuil inférieur à 2 % serait inerte. Il faut préciser s'il porte sur la dérive par ligne,
sur l'écart d'exposition totale, ou sur les deux, et le borner à au moins 2 %.

**7.5. « 100 % structurellement atteignable » n'est pas vrai en production aujourd'hui.**
`minCashPercent` doit être dans `(0, 95)` (`config/index.ts:811`), avec 30 déployé, et il fait
partie du contrat du pilote (`pilot.ts`, `caps.minCashPercent`). Sans conséquence pour le banc
(il n'a pas de plancher, par construction), mais le point 12 devra changer cette borne, et donc
revoir pourquoi elle existe (la bande de corruption de la PR #34).

**7.6. Le point 11 change l'architecture de production, pas un paramètre.** Aujourd'hui tout le
cycle passe par le modèle : une panne du modèle empêche toute exécution, stops compris (voir
« Hors périmètre »). La cadence est choisie par le modèle, de 15 à 240 minutes
(`config/index.ts`, `minDelayMinutes` / `maxDelayMinutes`), alors que le banc décide sur chaque
clôture 4h. Une politique calculée par le code demande une cadence fixe alignée sur les
clôtures 4h, et un cycle qui exécute sans réponse du modèle. Le chemin de reprise v4
(`STRATEGY_VERSION`) et le garde de cohérence sont construits autour d'une décision du modèle.
C'est un chantier à part entière, à cadrer après le banc.

**7.7. Puissance du test sur la vérification interne.** 18 mois, environ 546 rendements
quotidiens d'une différence très bruitée entre deux politiques exposées au même marché : la
borne inférieure à 95 % sera difficile à rendre positive. Ce n'est pas une erreur, mais le protocole retient R100/0 par
défaut presque mécaniquement. Il vaut mieux le savoir et l'assumer. Le double critère du point 9
(battre T100 **et** R100/0) est un test d'intersection-union : aucune correction de
multiplicité n'est nécessaire.

**7.8. Points de détail à fixer :**

- le décile de conviction du point 7 se calcule sur quelle fenêtre (calibration entière ou
  vérification) ?
- la longueur de bloc Politis-White porte sur quelle série : la différence candidate moins
  témoin, sur toute la calibration ?
- les seuils hérités de la production (confirmations 3, RSI 55/45, largeur 80 %, RSI médiane 40,
  stop 10 %) sont figés tels quels, jamais réajustés dans le banc ;
- biais de survie de l'univers : les quatre actifs ont été choisis en 2026, en connaissant leur
  survie. Il avantage T100. À publier, rien à corriger ;
- le pilote vivant comme contrefactuel : faisable sur `[2026-09-06, 2026-11-01)`, hors fenêtre
  scellée, mais avec des bougies que le bundle n'a pas (il s'arrête au 2026-08-20).

---

## Hors périmètre : le stop déterministe en cas de panne du modèle

**Il n'existe pas.** Fait : `computeStopExits` (`decide.ts:508`) ne génère des sorties que sur le
chemin décidé (`decide.ts:1921`). Sur les chemins `error`, `guard_failed` et `parse_failed`
(`decide.ts:1445`, `1518`, `1587`), `alertArmedStopNotFired` envoie une alerte et ne passe aucun
ordre. Son commentaire le dit : « ALERTS ONLY — it places nothing », le changement de
sémantique d'échec étant renvoyé à une PR dédiée.

Le coupe-circuit du pilote (50 % de drawdown) ne vend rien non plus : il arrête la correction de
bande, qui revient à l'allocation du modèle (`decide.ts`, commentaire de `judgePilot`).

Avec le point 11, le sujet change de nature : si la cible est calculée par le code, une panne du
modèle n'a plus de raison de bloquer l'exécution. Mais tant que l'exécution reste suspendue à
la réponse du modèle, une hausse réelle de l'exposition se ferait sans ce filet.

---

## Arbitrages demandés à Julien et Alex avant la construction du banc

1. **Plafonds.** Les garde-t-on à 35 / 35 / 20 / 15 ? Avec eux, une ligne BTC ou ETH stoppée
   plafonne le livre à 70 %, et la redistribution ne récupère que 2,5 à 5 points. Si le mandat
   veut vraiment « toute l'enveloppe », c'est cette question qui compte.
2. **Réentrée après un stop**, sans modèle pour décider : règle préenregistrée (pas de réentrée
   en régime confirmé baissier, délai fixe, ou réentrée libre assumée) ?
3. **Surpoids gelé** : comprime-t-il les autres lignes pour tenir la cible totale (ma
   proposition), ou reste-t-il hors cible comme dans le banc actuel ?
4. **Issue négative de la calibration** : que fait-on si les trois architectures dépassent 50 % ?
   À écrire avant de lancer quoi que ce soit.
5. **Drawdown de la limite dure** : plus-haut de la fenêtre ou de toute la trajectoire ; équité
   de clôture 4h ou plus-bas intra-barre ?
6. **Bundle v2** par `crypto-lab` : calibration seule, SOL ajouté, partie scellée hors du dépôt.
   Faut-il y ajouter dès maintenant une série longue pour l'ATH, ou le funding ? Chaque ajout
   élargit le score possible, et chaque ajout doit être décidé avant l'ouverture.
7. **Test inverse** : ajustement sur la vérification en partant à plat au 2023-01-01 ?
8. **Paramètres de la candidate** : ceux du développement seul, sans réajustement sur toute la
   calibration ?
9. **Seuil de rééquilibrage** : sur la dérive par ligne, sur l'exposition totale, ou les deux,
   borné à au moins 2 % ?
10. **Stop en cas de panne du modèle** : prérequis avant toute hausse réelle d'exposition,
    toujours absent. Le traite-t-on avant le point 12, ou dans le même chantier que la sortie du
    modèle du chemin des ordres ?
