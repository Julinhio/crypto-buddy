# Protocole v0.4 : validation scellée de S4, règle de sortie et de rachat, Crypto-Buddy

**v0.4 (31/10/2026).** Copie du protocole v0.3 (gel `8602ba7`, rejeu du développement `dd2ff8e`, PR #51), reprise telle quelle, S4 et ses paramètres compris, avec les changements B0 à B4 décidés par Julien le 31/10/2026 après la publication du développement et **avant toute ouverture de la fenêtre scellée**. Ce n'est pas un réajustement de v0.3 après lecture : c'est une nouvelle décision de mandat, donc une nouvelle expérience au sens du protocole v1.3 et de l'amendement A2. Les changements sont reportés à leur place et repris en fin de document ; les précisions d'ouverture de Ben (§16) ont été écrites, testées et commitées avec le gel, avant l'ouverture.

*Texte de v0.3 :* Copie du protocole v0.2 (cadré par Alex et Claude le 17/10/2026, sans code), augmentée des amendements A0 à A3 décidés par Julien le 31/10/2026, avant tout code et toute mesure. Ne cherche pas à sauver SCORE : nouvelle architecture de sortie. Les amendements sont reportés à leur place dans le texte et repris en fin de document ; l'audit de faisabilité de Ben (§14) et ses précisions d'exécution (§15) ont été écrits et commités avant le premier rejeu mesuré.

## 0. Préambule (A0)

Cette expérience hors ligne peut démarrer avant la clôture du pilote A (1er novembre 2026, 11h46 UTC). Sa lecture officielle sera analysée séparément et ne modifiera pas les règles après les résultats. *(A0 remplace la mention du préambule v0.2 qui imposait de confronter le protocole à la lecture officielle du pilote avant le gel.)*

## 0 bis. Mandat du 31/10/2026 (B0, décision de Julien)

La limite de 50 % de drawdown venait d'une tolérance exprimée par Julien le 01/08, transformée à tort en critère éliminatoire. **Critère principal : le rendement net.** Une baisse temporaire profonde est acceptable si le capital remonte ; seule la ruine ne l'est pas. Le drawdown continu reste mesuré et publié ; il n'élimine plus. Partout où le texte de v0.3 ci-dessous fait de la limite de 50 % un critère (§1, §2, §9, §11, §12), elle est remplacée par ce mandat.

## 1. Question

**v0.4 :** S4, choisie avant toute lecture de la fenêtre scellée, fait-elle mieux que le mécanisme actuel (E1) en rendement net sur cette fenêtre, en restant positive ?

*Question de v0.3 :* À partir d'une cible constante de 100 % avec des poids fixes, une règle déterministe de sortie et de rachat peut-elle maintenir le drawdown continu sous 50 % tout en réduisant fortement les allers-retours et les frais du mécanisme actuel ?

## 2. Ce qui est fixe

Cible de 100 %, poids 32,5/32,5/20/15, plafonds 35/35/20/15, frais, glissement et exécution du banc v1.3. Aucune sélection par score ni par le modèle. ~~Limite dure : 50 % de drawdown continu.~~ *(B0 : drawdown publié, non éliminatoire.)*

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
- **v0.4 :** fenêtre scellée ouverte une seule fois, pour S4 seule, par la procédure du §16 ; jamais de second rejeu après lecture.

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

Un épisode est une baisse de l'indice synthétique du panier (celui de S5) d'au moins 30 % depuis son plus-haut glissant. Il commence au dernier plus-haut avant ce franchissement et se termine quand l'indice retrouve ce plus-haut, ou à la fin des données. Les épisodes sont listés avant tout rejeu (§14.3). Le drawdown de chaque politique par épisode est publié à titre descriptif. Le seul critère éliminatoire reste le drawdown continu global de 50 %. *(B0 : plus aucun critère éliminatoire de drawdown.)*

## 10. Mesures publiées pour chaque politique

Rendement net, drawdown continu, rotation, frais et glissement, nombre de sorties, temps passé en cash, distribution de l'exposition, résultats par année civile et par épisode. **Retard de rachat** : délai entre le creux d'un épisode de l'indice du panier et le premier retour à au moins 80 % d'exposition réalisée (« non revenu » si jamais atteint avant la fin des données).

## 11. Sélection sur le développement, règle préenregistrée

**v0.4 (B1) :** la sélection de v0.3 a été appliquée sur le développement (`docs/RAPPORT-SORTIE-DEV.md`) et n'a retenu aucune candidate, toutes éliminées par la limite de 50 %. Sous le mandat B0, **Julien a choisi S4 comme candidate unique le 31/10/2026** : meilleur rendement net du développement (95,6 % annualisés), drawdown le plus faible des cinq (52,4 %), retour en marché le plus rapide après le krach de 2022 (31,2 jours, à égalité avec S3). Il a écarté la préférence de simplicité, qui aurait désigné S5 (92,7 %, à moins de 3 points). La fenêtre scellée n'a jamais été lue : elle reste un test indépendant quel que soit le mode de sélection. S4 garde ses paramètres de v0.3 (stop suiveur 20 %, 10 jours minimum hors marché, moyenne 50 jours avec recroisement) et ses règles d'exécution (§15).

*Règle de v0.3, appliquée, conservée pour mémoire :*

- Éliminatoire : drawdown continu supérieur à 50 %.
- Exigence de frottements : frais et glissement cumulés au plus égaux à la moitié de ceux d'E1.
- Parmi les candidates restantes, meilleur rendement net. À moins de 3 points annualisés d'écart, préférence à la plus simple, dans l'ordre S1, S5, S2, S3, S4.
- Si aucune candidate ne remplit ces conditions, rien ne part en validation et le résultat est publié.
- **A2.** Si aucune candidate ne remplit les conditions du §11 : aucune ouverture de la fenêtre scellée, aucune modification de production. Ni les seuils ni la limite de 50 % ne changent après lecture des résultats. Toute nouvelle tentative exige une nouvelle expérience préenregistrée.

## 12. Validation scellée, verdict propre à cette expérience

**v0.4 (B2, B3), écrit avant l'ouverture et seul applicable :**

- Candidate unique : **S4**. Comparateurs rejoués sur la même trajectoire continue : **E0, E1, TC44**.
- **« Go pilote testnet »** si S4 termine la fenêtre scellée avec un rendement net strictement positif **et** un rendement net strictement supérieur à celui d'E1. **Sinon « Non retenue ».**
- E0 et TC44 sont publiés à titre informatif et n'entrent pas dans le verdict.
- Bootstrap publié à titre informatif : méthode préenregistrée en v0.3 (§15.13), longueurs de bloc Politis-White calculées sur le développement seul et figées dans le gel ; borne unilatérale à 95 % de S4 contre E1 (puis contre E0 et TC44, pour information).
- **B4.** Rien d'autre ne change après lecture des résultats : ni paramètre, ni comparateur, ni verdict, ni second rejeu.

*Verdicts de v0.3, remplacés par ceux ci-dessus :*

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

## 16. Précisions d'ouverture (Ben, 31/10/2026, v0.4, avant l'ouverture)

Écrites, codées, testées sur données synthétiques et répétées sur les données consommées avant le gel. Aucun paramètre n'est touché.

**Audit avant ouverture : aucune incompatibilité.** Le banc rejoue S4, E0, E1 et TC44 tels qu'en v0.3 ; il ne lui manquait que la commande d'ouverture de la partie scellée, ajoutée ici sans changer le moteur. Preuve : la répétition générale (point 9) reconstruit la bande certifiée à l'identique et retrouve, sur la trajectoire continue, les capitaux finaux du développement publiés par v0.3, au millionième de dollar.

1. **Trajectoire continue.** Un seul rejeu par politique du 2020-10-01 au 2026-06-01, exécution et porte du banc v1.3. L'état (positions, plus-hauts suiveurs de S4, plus-haut d'équité, ligne barrée, ordre en attente) franchit le 2024-07-01 tel qu'il a vécu. L'ordre décidé à la clôture du 2024-07-01 à 00:00 s'exécute à l'ouverture qui suit, première ouverture de la fenêtre.
2. **Fenêtre mesurée.** Les barres 4h ouvertes dans `[2024-07-01, 2026-06-01)`, découpées dans la trajectoire continue. Chaque montant en dollars est ramené à une base de 1 000 $ : l'équité de clôture 4h au 2024-07-01T00:00, dernière clôture du développement, vaut 1 000 $. Capital final = 1 000 $ × (1 + rendement net). Rendement annualisé sur 700 jours, années de 365,25 jours. Rendement net total et annualisé ordonnent de la même façon ; le verdict lit le rendement net total.
3. **Drawdown continu.** Le pire observé sur les clôtures 4h de la fenêtre, mesuré depuis le plus-haut de **toute** la trajectoire (v1.3, point 9). Il est publié avec trois dates : clôture du plus-haut (éventuellement antérieure à la fenêtre), clôture du creux, clôture du retour au plus-haut (« non retrouvé » sinon). Le drawdown depuis le plus-haut propre à la fenêtre, à partir de son équité d'ouverture, est publié à côté pour information.
4. **Frais, glissement, rotation, sorties, temps en cash, exposition.** Définis comme en v0.3 (§10, §15.9, §15.10), sur les barres de la fenêtre. Frais et glissement en dollars de la trajectoire ramenée à 1 000 $. Rotation = notionnel échangé / équité moyenne de la fenêtre.
5. **Années civiles.** 2024 (à partir du 1er juillet), 2025, 2026 (jusqu'au 1er juin). Le rendement de chaque année part de l'équité reportée ; son drawdown est le drawdown continu.
6. **Épisodes et retard de rachat.**
   - La règle du §9 est appliquée à l'indice synthétique sur les clôtures du 2020-10-01 au 2026-06-01 inclus, avec le même plus-haut glissant que v0.3.
   - Les épisodes encore ouverts après le 2024-07-01 sont publiés avec les lectures de chaque politique (§15.12) et le retard de rachat (§15.8), lus sur la trajectoire continue.
   - Le rapport indique si le creux tombe dans la fenêtre ou avant elle.
   - Tant que l'épisode 2, commencé le 2021-11-09, n'a pas retrouvé son plus-haut, aucun nouvel épisode ne peut commencer (§9).
7. **Bootstrap.** Série : différence quotidienne des rendements logarithmiques S4 moins comparateur, sur la fenêtre. Fins de journée à 00:00 UTC ; la première se mesure depuis l'ouverture ramenée à 1 000 $. Longueurs de bloc figées dans le gel. Méthode, tirages et graine : ceux de v0.3. Informatif.
8. **Procédure d'ouverture (jeton, empreinte, préfixe).** Commande `npm run bench:exit:sealed -- <dossier>` (`src/bench/exit/opening.ts`, `sealed.ts`, `run.ts`).
   1. Refus sauf si :
      - le gel v0.4 est commité à HEAD et intact ;
      - il signe ce `src`, ce lockfile, ce protocole et l'empreinte scellée ;
      - l'arbre est propre ;
      - HEAD est contenu dans la branche distante : le gel doit être poussé, donc horodaté publiquement, avant toute lecture.
   2. Refus si `out/bench-exit/sealed/opening.json` existe sur disque ou dans un commit du dépôt : **une seule ouverture**.
   3. Le registre d'ouverture est écrit, en création exclusive, **avant** la lecture du premier octet scellé. Le jeton émis à ce moment est la seule clé de la bande scellée et de la fenêtre continue ; il ne se contrefait pas (registre privé au module, comme l'ouverture de la vérification interne en v1.3).
   4. Le manifeste scellé est comparé octet pour octet au `manifest_sha256` épinglé dans `data/calibration/crypto-buddy-exposure-v2-validation.fingerprint.json`, commité depuis la production du bundle. Ensuite :
      - son `bundle_sha256` est recalculé ;
      - chaque fichier est haché ;
      - chaque ligne est rejugée jusqu'au 2026-06-01 (certification de la calibration, inchangée).
   5. La barre 4h de recouvrement (2024-06-30T20:00) doit être identique dans les deux parties.
   6. Tests de préfixe avant toute mesure :
      - timelines de régime et timelines collantes (v1.3, point 3) ;
      - table journalière lue par les règles ;
      - trajectoire continue de chaque politique coupée au 2024-07-01, égale barre pour barre et champ pour champ à son rejeu du développement ;
      - capitaux de fin de développement égaux aux valeurs figées ;
      - date de début et épisodes du développement inchangés sur les données complètes.
   7. Tout refus postérieur au registre est publié (`failure.json`). La fenêtre reste brûlée.
9. **Répétition générale, avant le gel.** La procédure complète, hors contrôles git, est exécutée sur les données consommées. Le 2023-01-01 y joue le rôle du sceau et le 2024-07-01 celui de la fin. Une partie au format scellé est écrite à partir des bougies certifiées, avec sa propre empreinte, puis certifiée, raccordée, testée en préfixe, rejouée en continu, découpée et mesurée. Elle reproduit la bande certifiée et les capitaux de v0.3 (`src/test/benchExitSealed.ts`, preuve 6).

## Changements v0.4 du 31/10/2026 (Julien), avant toute ouverture

- **B0** — mandat : critère principal = rendement net ; drawdown continu publié, non éliminatoire ; seule la ruine est inacceptable (§0 bis).
- **B1** — candidate unique : S4, choisie par Julien, préférence de simplicité écartée (§11).
- **B2** — comparateurs rejoués sur la même trajectoire continue : E0, E1, TC44 (§12).
- **B3** — verdict préenregistré : « Go pilote testnet » si S4 > 0 et S4 > E1 en rendement net sur la fenêtre scellée, sinon « Non retenue » ; E0, TC44 et le bootstrap (longueurs de bloc du développement) informatifs (§12).
- **B4** — rien d'autre ne change après lecture ; une seule ouverture, jamais de second rejeu (§12, §16).
