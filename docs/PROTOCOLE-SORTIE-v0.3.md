# Protocole v0.3 : règle de sortie et de rachat, Crypto-Buddy

Copie du protocole v0.2 (cadré par Alex et Claude le 17/10/2026, sans code), augmentée des amendements A0 à A3 décidés par Julien le 31/10/2026, avant tout code et toute mesure. Ne cherche pas à sauver SCORE : nouvelle architecture de sortie. Les amendements sont reportés à leur place dans le texte et repris en fin de document ; l'audit de faisabilité de Ben (§14) et ses précisions d'exécution (§15) ont été écrits et commités avant le premier rejeu mesuré.

## 0. Préambule (A0)

Cette expérience hors ligne peut démarrer avant la clôture du pilote A (1er novembre 2026, 11h46 UTC). Sa lecture officielle sera analysée séparément et ne modifiera pas les règles après les résultats. *(A0 remplace la mention du préambule v0.2 qui imposait de confronter le protocole à la lecture officielle du pilote avant le gel.)*

## 1. Question

À partir d'une cible constante de 100 % avec des poids fixes, une règle déterministe de sortie et de rachat peut-elle maintenir le drawdown continu sous 50 % tout en réduisant fortement les allers-retours et les frais du mécanisme actuel ?

## 2. Ce qui est fixe

Cible de 100 %, poids 32,5/32,5/20/15, plafonds 35/35/20/15, frais, glissement et exécution du banc v1.3. Aucune sélection par score ni par le modèle. Limite dure : 50 % de drawdown continu.

## 3. Ce qui varie

Uniquement la mécanique de sortie, de maintien hors marché et de rachat, avec sa cadence. **Pour S1 à S5, la règle candidate remplace entièrement le stop actuel** (10 % armé en transition) : aucun autre mécanisme de sortie ne s'y ajoute.

**A1.** Une sortie déclenchée par la règle candidate vise zéro sur la ligne concernée. Aucun plancher, aucune bande ni aucun correctif d'exposition ne peut recréer cette position. Tout reliquat d'exécution reste visible et journalisé, jamais masqué. *(Retour du pilote : les cycles 3098 et 3100 ont remis ~3,33 % sur BTC, ETH et XRP alors que le modèle visait 0.)*

## 4. Temporalité

- Les règles journalières décident sur la clôture journalière UTC et exécutent à l'ouverture suivante. Aucune décision n'utilise une bougie non close.
- Le drawdown est observé sur l'equity à chaque clôture de 4 heures, comme dans le banc v1.3.

## 5. Interaction avec la porte de transition (confirmée par l'audit, §14.1)

- Une sortie décidée par une candidate a la priorité d'une sortie de stop : un gel de transition ne la bloque pas.
- Un rachat respecte la porte : une ligne gelée n'est pas rachetée tant que le gel dure.

## 6. Données

- Développement : période antérieure au 1er juillet 2024, à partir de la première date où toutes les politiques (références et candidates) disposent de leurs indicateurs de façon causale, SOL et contexte global compris. Date calculée mécaniquement et publiée (§14.2).
- Toute cette période est déjà consommée : apprentissage et lectures par sous-période seulement, jamais preuve indépendante.
- Fenêtre scellée `[2024-07-01, 2026-06-01)` fermée jusqu'au gel d'une seule candidate.

## 7. Références, rejouées sans être candidates

- **E0** : 100 % sans aucun stop.
- **E1** : mécanisme actuel, stop à 10 % armé en transition, rachat sur `trend_up` ou `reversal_up` confirmé.
- **TC44** : cible constante de 44,226403 %, règles du protocole v1.3.

## 8. Candidates, ensemble fini, paramètres fixés à l'avance

- **S1, filtre de tendance journalier par actif** : un actif est détenu quand sa clôture journalière est au-dessus de sa moyenne 200 jours, hors marché sinon.
- **S2, S1 avec hystérésis** : sortie d'un actif sous 97 % de sa moyenne 200 jours, rachat seulement au-dessus de 103 %.
- **S3, stop suiveur large toujours armé** : sortie à 20 % sous le plus-haut, évaluée à la clôture journalière. Le plus-haut est la plus haute clôture journalière UTC observée depuis l'exécution de l'entrée, réinitialisé à chaque rachat ; les plus-hauts intrajournaliers ne sont pas utilisés. Rachat quand la clôture journalière repasse au-dessus de la moyenne 50 jours.
- **S4, S3 avec délai minimum** : comme S3, avec au moins 10 jours hors marché avant tout rachat.
- **S5, filtre global journalier avec hystérésis** : indice synthétique du panier, rééquilibré quotidiennement aux poids 32,5/32,5/20/15, calculé à partir des rendements clôture à clôture. Sortie complète quand sa clôture journalière passe sous 97 % de sa moyenne 200 jours, rachat complet seulement au-dessus de 103 %.
- **Part d'un actif sorti (S1 à S4)** : elle reste en cash, sans redistribution sur les autres actifs.
- **A3.** Les paramètres sont figés tels qu'écrits : 97/103 %, stop suiveur 20 %, moyenne 50 jours, 10 jours minimum hors marché, moyenne 200 jours. Pas de grille de recherche. *(A3 remplace la mention v0.2 « à confirmer avant exécution, puis figées ».)*

## 9. Épisodes de krach, définis avant tout résultat

Un épisode est une baisse de l'indice synthétique du panier (celui de S5) d'au moins 30 % depuis son plus-haut glissant. Il commence au dernier plus-haut avant ce franchissement et se termine quand l'indice retrouve ce plus-haut, ou à la fin des données. Les épisodes sont listés avant tout rejeu (§14.3). Le drawdown de chaque politique par épisode est publié à titre descriptif. Le seul critère éliminatoire reste le drawdown continu global de 50 %.

## 10. Mesures publiées pour chaque politique

Rendement net, drawdown continu, rotation, frais et glissement, nombre de sorties, temps passé en cash, distribution de l'exposition, résultats par année civile et par épisode. **Retard de rachat** : délai entre le creux d'un épisode de l'indice du panier et le premier retour à au moins 80 % d'exposition réalisée (« non revenu » si jamais atteint avant la fin des données).

## 11. Sélection sur le développement, règle préenregistrée

- Éliminatoire : drawdown continu supérieur à 50 %.
- Exigence de frottements : frais et glissement cumulés au plus égaux à la moitié de ceux d'E1.
- Parmi les candidates restantes, meilleur rendement net. À moins de 3 points annualisés d'écart, préférence à la plus simple, dans l'ordre S1, S5, S2, S3, S4.
- Si aucune candidate ne remplit ces conditions, rien ne part en validation et le résultat est publié.
- **A2.** Si aucune candidate ne remplit les conditions du §11 : aucune ouverture de la fenêtre scellée, aucune modification de production. Ni les seuils ni la limite de 50 % ne changent après lecture des résultats. Toute nouvelle tentative exige une nouvelle expérience préenregistrée.

## 12. Validation scellée, verdict propre à cette expérience

- Une seule candidate figée et commitée avec ses paramètres, ce verdict et les paramètres du bootstrap : bootstrap stationnaire, longueur de bloc Politis-White calculée sur le développement seul pour chaque comparaison, 10 000 tirages, graine 20261101, borne unilatérale à 95 %.
- E0, E1 et TC44 rejoués comme comparateurs sur la même trajectoire continue.
- Admissibilité d'abord : drawdown continu inférieur ou égal à 50 % pour la candidate et pour chaque comparateur. Un comparateur non admissible reste publié mais n'entre pas dans le verdict.
- **Preuve forte** : candidate admissible, avance d'au moins 5 points de rendement annualisé net sur le meilleur comparateur admissible, borne inférieure du bootstrap positive face à lui.
- **Avantage pratique** : candidate admissible, avance d'au moins 5 points sur le meilleur comparateur admissible, intervalle incluant zéro.
- **Viable sans comparateur admissible** : candidate admissible, aucun comparateur admissible.
- **Non retenue** : candidate non admissible, ou avance inférieure à 5 points sur le meilleur comparateur admissible.

## 13. Hors périmètre

Toute modification de production. La règle retenue ne pourra passer en production qu'après le chantier d'exécution autonome (cadence fixe, stop indépendant du modèle), puis l'accord explicite de Julien. La PR #50 ne se merge qu'après clôture et lecture officielle du pilote, sur autorisation explicite de Julien.

## 14. Audit de faisabilité (Ben, 31/10/2026, avant tout rejeu)

Fait sur le code du banc v1.3 (`src/bench/exposure/`, HEAD `f7584cf`) et sur les seules données du développement, sans aucun rejeu de politique. Conclusion : **aucune incompatibilité** entre ce protocole et le banc ; l'expérience est exécutable telle qu'écrite, avec les précisions du §15.

### 14.1 Porte de transition (§5) : confirmée

- **Sortie candidate.** Une ligne que la règle tient hors marché passe à l'état `excluded` quel que soit le verdict de la porte (`frozen`, `no_regime` compris) : cible 0, part laissée en cash (la cible effective est réduite d'autant, `allocate`), jamais redistribuée. La vente est une sortie complète, que le plancher de 2 % de production ne bloque jamais (`isBelowFloor(..., fullExit)` dans `planMovements`). Elle s'exécute à l'ouverture qui suit la clôture journalière de décision.
- **Rachat.** Une ligne que la règle tient en marché obéit à la porte : gelée, elle est `fixed` et garde son poids courant, nul après une sortie ; elle n'est donc pas rachetée pendant le gel. Le moteur replanifie à chaque clôture 4h : le rachat se décide à la clôture de la première barre 4h où la ligne redevient libre, et s'exécute à l'ouverture suivante. La décision de la règle reste journalière ; seule son exécution peut être retardée par la porte.
- **Stop.** Pour S1 à S5 et E0, le stop de 10 % ne se déclenche jamais : un verdict `stop_exit` est lu comme ce que l'échelle de production répond sans lui (`frozen`).
- **risk_off global.** E0, E1 et S1 à S5 utilisent la porte de T100, aveugle au risk_off global : E1 est exactement le T100 du banc v1.3 (stop 10 % armé en transition, ligne barrée jusqu'à `trend_up` ou `reversal_up` confirmé), et chaque candidate est E1 dont seul le stop est remplacé (§3). TC44 voit le risk_off, comme en v1.3. Conséquence : sous risk_off, une ligne gelée d'E0, E1 ou S1 à S5 reste gelée ; la seule sortie possible d'une candidate est la sienne.
- **A1.** Aucune ligne sortie ne reçoit de poids (ni waterfill, ni bande, ni plancher). Le rejeu compte en plus, pour chaque politique, les clôtures 4h où une ligne tenue hors marché pèse encore quelque chose après l'exécution de sa sortie ; attendu : zéro, publié tel quel.

### 14.2 Date de début du développement (§6) : 2020-10-01T00:00Z

Calculée par `developmentStart` (`src/bench/exit/daily.ts`), première minuit UTC où chaque exigence est remplie de façon causale, avec fenêtres complètes :

| Exigence | Lue par | Première date |
|---|---|---|
| Régime complet des cinq actifs et contexte global (SMA50, EMA21 et RSI14 journaliers, 30 bougies journalières closes, EMA21 et RSI14 4h, 42 barres 4h) | porte de toutes les politiques, stop d'E1 et TC44 | **2020-10-01** |
| Moyenne 200 jours de chaque actif tradable | S1, S2 | 2020-07-19 |
| Moyenne 50 jours de chaque actif tradable | S3, S4 | 2020-02-20 |
| Moyenne 200 jours de l'indice synthétique | S5 | 2020-07-19 |

L'exigence contraignante est la SMA50 journalière de SOL (premières bougies le 2020-08-11, 50e clôture journalière le 2020-10-01 à 00:00) ; la veille, seule celle-ci manque. Fenêtre de développement : `[2020-10-01, 2024-07-01)`, 1 369 jours.

### 14.3 Épisodes de krach (§9), listés avant tout rejeu

Indice synthétique sur les clôtures journalières du 2020-10-01 au 2024-07-01 inclus (198,4 au départ, base 100 au 2020-01-02) :

| # | Début (dernier plus-haut) | Plus-haut | Franchissement de −30 % | Creux | Profondeur | Fin |
|---|---|---|---|---|---|---|
| 1 | 2021-05-12 | 2 280,6 | 2021-05-20 | 2021-07-21 (1 025,2) | 55,05 % | 2021-10-30, plus-haut retrouvé |
| 2 | 2021-11-09 | 2 582,9 | 2022-01-06 | 2022-06-19 (665,9) | 74,22 % | 2024-07-01, **non retrouvé** (fin des données, 2 146,8) |

### 14.4 Constats, sans effet sur les règles

- Le développement commence en plein marché haussier : l'indice est multiplié par 11,5 entre le 2020-10-01 et le 2021-05-12. Les rendements annualisés en sont dominés ; les résultats par année civile sont publiés pour le lire.
- L'épisode 2 ne se referme pas avant la fin des données : il couvre 2021-11-09 → 2024-07-01, soit les deux tiers de la fenêtre. Ses lectures sont proches des lectures globales.
- Avec une cible de 100 %, l'exposition réalisée plafonne vers 97 % (bande morte du plancher de 2 %, v1.3). Quand une candidate S1 à S4 sort un actif, l'exposition réalisée est bornée par 100 moins son poids : avec BTC ou ETH sorti, elle ne peut pas atteindre les 80 % du retard de rachat (§10).
- Pour mémoire, le banc v1.3 a mesuré 75,8 % de drawdown pour 100 % sans stop sur 2021-2022 (T100 sans stop, diagnostic) ; les ~65 % cités dans le brief correspondent au T100 avec stop de l'étape 1 (64,9 %).

## 15. Précisions d'exécution (Ben, 31/10/2026, avant tout rejeu)

Le texte des règles laisse quelques points à fixer pour les coder. Chacun est tranché ici, avant toute mesure, dans le sens le plus littéral, et gelé avec le reste. Aucun paramètre n'est touché (A3).

1. **Instants.** Une règle lit la bougie journalière close à 00:00 UTC sur la barre 4h qui se clôt à cet instant, et sa décision s'exécute à l'ouverture 4h suivante, à 00:00. À la première barre de la fenêtre, la règle lit la clôture du 2020-10-01 à 00:00 ; comme dans le banc v1.3, le premier achat de chaque politique s'exécute à 04:00.
2. **Moyennes.** Moyennes arithmétiques simples des N dernières clôtures journalières, celle lue comprise.
3. **S1.** En marché si la clôture est strictement au-dessus de la moyenne 200 jours, hors marché sinon.
4. **S2 et S5.** Sortie si la clôture passe strictement sous 97 % de la moyenne 200 jours, rachat si elle passe strictement au-dessus de 103 %. L'état est déroulé depuis la première clôture où la moyenne existe (2020-07-19) ; son premier état est celui de S1. L'état au 2020-10-01 est donc celui qu'impose l'historique.
5. **S5.** Indice de base 100 à la première clôture commune (2020-01-02), poids fixes 32,5/32,5/20/15 appliqués chaque jour aux rendements clôture à clôture, sans frais.
6. **S3 et S4.**
   - Elles démarrent en marché au début de la fenêtre.
   - Le plus-haut est la plus haute clôture journalière **strictement postérieure** à l'exécution de l'entrée : la clôture à l'instant même de l'exécution est la clôture de décision, pas une observation de la position.
   - Sortie si la clôture est inférieure ou égale à 80 % de ce plus-haut.
   - « Repasse au-dessus » est lu comme un **recroisement** : après la sortie, le rachat exige au moins une clôture inférieure ou égale à la moyenne 50 jours (la clôture de sortie comprise), puis une clôture strictement au-dessus. Une sortie prise alors que le cours est encore au-dessus de sa moyenne attend donc un passage dessous, au lieu de racheter à la clôture suivante.
   - S4 exige en plus au moins 10 jours entre la clôture de sortie et la clôture de rachat. L'armement acquis pendant ces 10 jours est conservé.
   - Une ligne en marché selon la règle mais non détenue (gelée, jamais achetée) n'a pas de plus-haut et ne peut pas être sortie.
7. **Épisodes.** Clôtures de l'indice du 2020-10-01 au 2024-07-01 inclus ; le plus-haut glissant part de la clôture du 2020-10-01 ; le creux est la plus basse clôture de l'épisode ; un épisode se termine à la première clôture supérieure ou égale à son plus-haut.
8. **Retard de rachat.** Première clôture 4h à partir de l'instant du creux avec une exposition réalisée d'au moins 80 %, cherchée jusqu'à la fin des données ; délai en jours ; « non revenu » sinon. Une politique déjà à 80 % au creux a un retard nul.
9. **Nombre de sorties.** Lignes détenues que la règle sort, pour S1 à S5 (une sortie globale de S5 compte une ligne par actif détenu et un événement), ou que le stop sort, pour E1 et TC44 ; aucune pour E0. L'état de départ d'une règle n'est pas une sortie : un actif déjà hors marché au 2020-10-01 n'a jamais été détenu.
10. **Temps passé en cash.** Publié de deux façons : part moyenne de cash (100 moins l'exposition moyenne réalisée) et part des clôtures 4h à moins de 1 % d'exposition. S'y ajoute la part du temps où la règle tient chaque actif hors marché.
11. **Sélection (§11).** Frottements = frais et glissement cumulés en dollars sur la fenêtre (même capital de départ, 1 000 $). Le « meilleur rendement net » se lit sur le rendement net annualisé, qui ordonne comme le rendement net total sur une fenêtre commune. « À moins de 3 points » s'entend strictement. Une égalité à 50 % de drawdown ou à exactement la moitié des frottements d'E1 passe.
12. **Drawdown par épisode.** Publié de deux façons : depuis le plus-haut propre de la politique à partir du début de l'épisode, et pire drawdown continu atteint pendant l'épisode.
13. **Bootstrap, méthode préenregistrée.** Série : différence quotidienne des rendements logarithmiques candidate moins comparateur, pour chacun d'E0, E1 et TC44, sur le développement. Longueur moyenne de bloc Politis-White calculée par le rejeu du développement pour chaque comparaison et publiée avec lui, puis figée avec la candidate avant toute ouverture de la fenêtre scellée. Bootstrap stationnaire, 10 000 tirages, graine 20261101, borne inférieure unilatérale à 95 % = 5e centile des moyennes rééchantillonnées. Calculée seulement si une candidate est retenue.
14. **Cadence d'exécution commune.** La grille 4h, la porte, le rééquilibrage de dérive au-delà du plancher de 2 % par ligne et l'exécution sont ceux du banc v1.3, identiques pour toutes les politiques (§2).

## Amendements du 31/10/2026 (Julien), avant tout code et toute mesure

- **A0** — démarrage avant la clôture du pilote, lecture du pilote analysée à part et sans effet sur les règles (§0).
- **A1** — une sortie candidate vise zéro ; rien ne recrée la position ; tout reliquat est journalisé (§3).
- **A2** — sans candidate qualifiée : ni fenêtre scellée, ni production, ni changement de seuil ; nouvelle tentative = nouvelle expérience préenregistrée (§11).
- **A3** — paramètres figés tels qu'écrits, sans grille (§8).
