# Banc d'exposition v1.3 : rapport de l'étape 2, TC44 et vérification interne

Ben, 17/10/2026. Protocole : [`PROTOCOLE-EXPOSITION-v1.3.md`](PROTOCOLE-EXPOSITION-v1.3.md),
amendements 1 (réentrée) et 2 (TC44 et qualification). Étape précédente :
[`RAPPORT-BANC-ETAPE-1.md`](RAPPORT-BANC-ETAPE-1.md).

## Résultat

**SCORE-C-linear ne se qualifie pas.** Elle réussit F1 et F2, mais échoue F4. Sur la
vérification interne, elle fait **21,2 %** de rendement annualisé net contre **31,1 %** pour
TC44, qui est admissible. L'écart est de **−9,9 points**, pour une avance exigée de +5. Le
banc s'arrête ici, conformément au gel : la candidate ne part pas en validation, et rien n'a
été ajusté après lecture.

## Chronologie, vérifiable dans l'historique

| Étape | Commit | Contenu |
|---|---|---|
| Code et protocole amendé | `75f8235` | TC44, longueurs de bloc, gel, ouverture gardée de la vérification, filtres |
| **Commit de gel** | **`77e3f70257a784b774a3ad46bfffdc361947e836`** | `out/bench-exposure/development/freeze.json`, empreinte `0da173c7…4b16f`, poussé le 17/10 à 08:12:25 UTC |
| Ouverture de la vérification | `1715f0f` | `out/bench-exposure/verification/`, run lancé à 08:12:34 UTC |

L'ouverture n'est pas qu'une discipline : le code l'impose. Le ruban refuse toute bougie
postérieure au 2023-01-01, et le moteur toute fenêtre de vérification, sans un
`VerificationOpening`. Seul `openVerification` le construit (un test le vérifie), et seulement
si toutes ces conditions sont réunies :

- le gel vérifie sa propre empreinte ;
- il est commité au HEAD avec ce contenu exact ;
- l'arbre est propre ;
- l'arbre source est celui qui a écrit le gel (`70f59b9a…`).

Avant de mesurer quoi que ce soit, le lanceur vérifie aussi que la moitié développement de la
trajectoire continue reproduit au centime la référence figée de chaque politique.

## Ce qui a été figé (`freeze.json`)

- **Candidate** : SCORE-C-linear. Composantes `trend_sma200`, `breadth_net` et `taker_buy_7d`,
  moyenne simple des z-scores, transformation linéaire z = −1 → 0 %, z = +1 → 100 %, seuil de
  rééquilibrage de 20 points, sans sortie risk_off forcée. Normalisations du développement en
  pleine précision, **utilisées depuis le fichier**, jamais réajustées :

  | Composante | Moyenne | Écart-type |
  |---|---|---|
  | `trend_sma200` | 0,0563114 | 0,4320676 |
  | `breadth_net` | 0,0297945 | 0,6930785 |
  | `taker_buy_7d` | −0,0031396 | 0,0053254 |

- **TC44** : cible constante de 44,226403 %. Mêmes poids, plafonds, stops, réentrée, gels,
  porte (risk_off vu) et exécution que la candidate.
- **Longueurs de bloc**, Politis-White sur les 730 différences quotidiennes du développement :

  | Comparaison | Décisionnelle possible | Longueur moyenne | Coupure m̂ |
  |---|---|---|---|
  | SCORE-C-linear − TC44 | oui | 1,54 | 0 |
  | SCORE-C-linear − T100 | non (drawdown continu déjà > 50 %) | 2,61 | 0 |
  | SCORE-C-linear − R100/0 | non (non admissible) | 1,00 | 0 |
  | SCORE-C-linear − RPA | non (non admissible) | 1,00 | 0 |

- **Bootstrap** : stationnaire, 10 000 tirages, graine 20261101, borne unilatérale à 95 %
  (5e centile des moyennes).
- **Règles** : F1 à F4 bis et les verdicts du point 10, en nombres et en texte.

## Les filtres

| Filtre | Mesure | Seuil | Résultat |
|---|---|---|---|
| F1 : drawdown continu de la candidate sur la calibration | 43,9 % | ≤ 50 % | **réussi** |
| F2 : décile de conviction, calibration | médiane 100 % (770 barres) | ≥ 80 % | **réussi** |
| F2 : décile de conviction, vérification seule | médiane 100 % (332 barres) | ≥ 80 % | **réussi** |
| F3 : admissibilité de TC44 sur la calibration | drawdown 49,3 % | ≤ 50 % | **admissible** |
| F4 : avance annualisée sur TC44, vérification | 21,2 − 31,1 = **−9,9 points** | ≥ +5 | **échec** |

**Intervalles sur la vérification** (différence quotidienne des rendements logarithmiques,
annualisée ×365, en points de log) :

| Comparaison | Rôle | Moyenne | Borne inférieure à 95 % |
|---|---|---|---|
| SCORE-C-linear − TC44 | publié, n'élimine pas (F4) | −7,8 | −28,6 |
| SCORE-C-linear − T100 | descriptif | −32,8 | −58,7 |
| SCORE-C-linear − R100/0 | descriptif | −41,2 | −70,9 |
| SCORE-C-linear − RPA | descriptif | −15,5 | −36,8 |

## Les mesures

Trajectoire continue sur la calibration `[2021-01-01, 2024-07-01)` depuis 1 000 $. Le
drawdown est continu depuis le plus-haut de toute la trajectoire.

### Vérification interne `[2023-01-01, 2024-07-01)`

| Politique | Net | Annualisé | Drawdown max (continu) | Frais + glissement (% du capital initial) | Rotation | Stops |
|---|---|---|---|---|---|---|
| SCORE-C-linear | 33,4 % | 21,2 % | 43,8 % | 151 $ + 76 $ (11,0 %) | 61,6 | 37 |
| TC44 | 50,0 % | 31,1 % | 45,7 % | 38 $ + 19 $ (4,8 %) | 25,3 | 52 |
| T100 | 118,1 % | 68,3 % | 70,5 % | 64 $ + 32 $ (6,8 %) | 28,0 | 52 |
| R100/0 | 147,4 % | 83,1 % | 68,2 % | 116 $ + 58 $ (11,5 %) | 41,9 | 36 |
| RPA | 68,1 % | 41,5 % | 51,8 % | 198 $ + 99 $ (16,0 %) | 76,2 | 16 |

Les frictions sont exprimées en pourcentage de l'équité au 2023-01-01.

### Calibration entière

| Politique | Net | Annualisé | Drawdown max (continu) | Frais + glissement (% du capital initial) | Rotation | Stops |
|---|---|---|---|---|---|---|
| SCORE-C-linear | 173,9 % | 33,4 % | 43,9 % | 393 $ + 196 $ (58,9 %) | 156,9 | 146 |
| TC44 | 75,8 % | 17,5 % | 49,3 % | 138 $ + 69 $ (20,8 %) | 91,1 | 188 |
| T100 | 209,4 % | 38,1 % | 71,8 % | 244 $ + 122 $ (36,6 %) | 101,9 | 188 |
| R100/0 | 273,7 % | 45,8 % | 68,2 % | 369 $ + 185 $ (55,4 %) | 138,1 | 149 |
| RPA | 213,4 % | 38,6 % | 51,8 % | 472 $ + 236 $ (70,8 %) | 188,1 | 88 |

### Développement (pour rappel ; identique au gel, au centime)

| Politique | Net | Annualisé | Drawdown max | Frais + glissement (% du capital initial) | Rotation | Stops |
|---|---|---|---|---|---|---|
| SCORE-C-linear | 105,4 % | 43,3 % | 43,9 % | 242 $ + 121 $ (36,2 %) | 95,1 | 109 |
| TC44 | 17,1 % | 8,2 % | 49,3 % | 101 $ + 50 $ (15,1 %) | 65,3 | 136 |
| T100 | 41,9 % | 19,1 % | 71,8 % | 180 $ + 90 $ (27,0 %) | 72,8 | 136 |
| R100/0 | 51,0 % | 22,9 % | 68,1 % | 253 $ + 127 $ (38,0 %) | 97,3 | 113 |
| RPA | 86,4 % | 36,6 % | 51,4 % | 273 $ + 137 $ (41,0 %) | 112,2 | 72 |

### Exposition réalisée sur la vérification (en %, temps par zone en % des barres)

| Politique | Médiane | Q1 | Q3 | P90 | Moyenne | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| SCORE-C-linear | 50,1 | 22,2 | 71,8 | 97,9 | 47,9 | 21,5 | 27,9 | 34,1 | 16,5 |
| TC44 | 44,1 | 43,5 | 44,7 | 45,8 | 42,6 | 3,9 | 96,1 | 0,0 | 0,0 |
| T100 | 97,8 | 83,6 | 100,0 | 100,0 | 85,0 | 3,4 | 4,7 | 16,5 | 75,4 |
| R100/0 | 97,8 | 84,6 | 100,0 | 100,0 | 83,4 | 6,7 | 2,9 | 14,5 | 75,9 |
| RPA | 53,3 | 14,6 | 90,0 | 100,0 | 51,2 | 32,3 | 14,9 | 18,5 | 34,2 |

### Exposition réalisée sur la calibration entière

| Politique | Médiane | Q1 | Q3 | P90 | Moyenne | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| SCORE-C-linear | 45,5 | 18,6 | 71,1 | 97,7 | 45,8 | 26,8 | 26,4 | 29,1 | 17,7 |
| TC44 | 43,9 | 42,6 | 44,6 | 45,4 | 38,8 | 11,7 | 88,3 | 0,0 | 0,0 |
| T100 | 89,9 | 54,6 | 100,0 | 100,0 | 74,9 | 11,6 | 9,6 | 14,9 | 63,9 |
| R100/0 | 90,1 | 55,0 | 100,0 | 100,0 | 73,9 | 14,6 | 7,3 | 13,3 | 64,7 |
| RPA | 52,9 | 0,0 | 90,0 | 100,0 | 49,8 | 34,9 | 13,4 | 16,3 | 35,5 |

### Rotation par cause sur la vérification (multiples de l'équité moyenne)

| Politique | Stop | Réentrée après stop | Changement de cible totale | Changement d'état de ligne | Dérive |
|---|---|---|---|---|---|
| SCORE-C-linear | 7,7 | 9,1 | 33,5 | 10,9 | 0,4 |
| TC44 | 10,8 | 10,4 | 0,0 | 3,7 | 0,4 |
| T100 | 13,3 | 13,0 | 0,0 | 1,4 | 0,4 |
| R100/0 | 9,2 | 9,2 | 18,1 | 5,1 | 0,3 |
| RPA | 3,6 | 5,2 | 1,6 | 65,2 | 0,5 |

### Par année civile (rendement / drawdown continu / exposition moyenne)

L'année 2024 couvre le 1er semestre seulement.

| Politique | 2021 | 2022 | 2023 | 2024 (S1) |
|---|---|---|---|---|
| SCORE-C-linear | 180,1 % / 35,8 % / 54,1 % | −26,7 % / 43,9 % / 34,3 % | 16,2 % / 43,8 % / 41,5 % | 14,8 % / 39,1 % / 60,8 % |
| TC44 | 75,0 % / 26,8 % / 34,7 % | −33,1 % / 49,3 % / 37,3 % | 34,8 % / 45,7 % / 43,2 % | 11,3 % / 29,4 % / 41,5 % |
| T100 | 225,7 % / 42,1 % / 64,2 % | −56,4 % / 71,8 % / 70,3 % | 73,3 % / 70,5 % / 86,9 % | 25,8 % / 51,8 % / 81,2 % |
| R100/0 | 230,6 % / 39,2 % / 63,5 % | −54,3 % / 68,1 % / 70,0 % | 104,1 % / 68,2 % / 84,8 % | 21,2 % / 38,6 % / 80,7 % |
| RPA | 179,6 % / 37,2 % / 53,8 % | −33,3 % / 51,4 % / 43,7 % | 43,5 % / 51,8 % / 50,4 % | 17,2 % / 34,9 % / 52,7 % |

## Lecture

Ce sont des **déductions**, à lire comme telles. Aucune n'a conduit à modifier quoi que ce
soit.

- **L'échec porte sur 2023.** Avec une exposition moyenne voisine (41,5 % contre 43,2 %), la
  candidate gagne 16,2 % quand TC44 gagne 34,8 %. Mon interprétation : un score ancré sur
  `trend_sma200` reste bas pendant la reprise qui suit un creux, puis monte une fois la hausse
  déjà faite. C'est le retard propre au suivi de tendance, l'envers de ce qui l'a protégé en
  2022 (−26,7 % contre −33,1 % pour TC44).
- **L'avance du développement était en partie celle de la sélection.** Sur le développement,
  la candidate battait TC44 de 35,1 points annualisés ; sur la vérification, elle perd 9,9
  points. Le seuil et la variante avaient été choisis sur le développement. La vérification
  joue exactement le rôle de filtre qu'on lui a donné.
- **Le coût de pilotage pèse aussi.** Sur la vérification, la candidate a 11,0 % de frictions
  contre 4,8 % pour TC44. Sa rotation de cible totale (33,5) n'existe pas chez TC44. Ce coût
  n'explique pas à lui seul −9,9 points, mais il en fait partie.
- **L'intervalle est large.** La borne inférieure de la comparaison avec TC44 est de
  −28,6 points de log annualisés, pour une moyenne de −7,8. Sur 18 mois, la vérification ne
  dit pas que la candidate est significativement pire. Elle dit qu'elle n'a pas montré
  l'avance de 5 points exigée, ce qui suffit au filtre.
- **Constat descriptif, sans portée décisionnelle** : sur la vérification seule, T100 et
  R100/0 rapportent bien plus (68 % et 83 % annualisés). Leur drawdown continu de 2022 les
  rend non admissibles, et la limite n'est pas relâchée après coup.

## Ce qui n'a pas été fait, volontairement

- Aucun ajustement de paramètre, de règle, de variante ou de comparateur après la lecture.
- Fenêtre scellée non ouverte. Le ruban s'arrête au 2024-07-01, et le dépôt ne contient rien
  au-delà.
- Pas de stabilité du préalable sur la vérification : ce n'était pas demandé dans ce cycle.
- Aucune des cinq autres variantes SCORE rejouée sur la vérification : une seule candidate
  avait été figée.

## Points qui demandent un arbitrage de Julien et d'Alex

1. **Constat d'échec.** Le protocole prévoit que, si la candidate échoue, le résultat est
   publié et le banc s'arrête. Le confirme-t-on, et clôt-on ce banc sans validation ?
2. **La suite du chantier.** Le point 10 du protocole prévoit, si aucune politique n'est
   admissible, une nouvelle expérience préenregistrée sur la règle de sortie. Ici, une
   politique simple est admissible (TC44), et c'est elle qui l'emporte sur la vérification.
   Faut-il traiter TC44 comme un résultat en soi ? Cela demanderait un nouveau protocole, et
   une fenêtre de test qui n'a pas servi à le choisir.
3. **La fenêtre scellée reste intacte.** Aucune politique n'a été testée dessus. Faut-il la
   garder pour un futur candidat préenregistré, ou la considérer comme le seul juge restant
   d'une hypothèse unique, à définir avant toute nouvelle mesure ?
4. **Le stop et la réentrée** restent le premier poste de rotation pour TC44 et T100 sur toute
   la calibration (188 stops chacun). Une expérience séparée sur la règle de sortie
   reste-t-elle prioritaire ?
5. **Le pilote vivant** se termine le 1er novembre. Rien dans ce banc ne justifie aujourd'hui
   une nouvelle politique d'exposition en production. Faut-il prolonger le contrat actuel,
   arrêter le pilote, ou en définir un autre ?

## Note de traçabilité : corrections postérieures au run

Les deux findings de la review Codex sur `c8379e1` sont corrigés dans
**`9167f8032167c96acdb386204d0435c7c586b692`**, après le run terminé :

- **P1 : jeton d'ouverture falsifiable.** L'ouverture est désormais une capacité privée au
  module `opening.ts`. Un jeton n'est accepté que s'il a été délivré par `openVerification`.
  L'environnement git injectable n'existe plus que dans une vérification pure, qui ne délivre
  aucun jeton.
- **P2 : lock de dépendances non vérifié.** `openVerification` compare maintenant le lock
  courant (`HEAD:package-lock.json`) au `deps_lock_sha` du gel, et refuse l'ouverture s'ils
  diffèrent.

Ces corrections n'ont entraîné aucun rejeu, aucune régénération du gel `77e3f70`, aucune mise à
jour d'artefact ni de manifeste. Entre le gel et l'ouverture du run, ni `src` ni
`package-lock.json` n'avaient changé : le lock valait `eb23e7e…` au gel comme à l'ouverture. Les
chiffres de ce rapport ne dépendent donc pas de ces deux défauts.
