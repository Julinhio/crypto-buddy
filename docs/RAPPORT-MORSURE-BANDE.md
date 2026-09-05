# Morsure historique de la bande A — point de contrôle obligatoire

Rejeu de la bande A contre l'historique v5 réel, **sans produire un seul ordre**.
Reproduire : `npm run replay:band-bite`. Sept critères, sortie non nulle si l'un échoue.

**Ce rapport ne contient aucun chiffre de rendement, et aucun n'y serait recevable.** Il
vérifie que l'intervention observée correspond au mécanisme annoncé. Il ne sélectionne aucune
politique sur sa performance historique.

Corpus : 933 cycles v5, ids 879 → 1811 (25/07 → 05/09). Politique A : défensif [0, 20],
neutre [20, 45], constructif [45, 70].

---

## Ce qu'il faut lire en premier

**La fréquence de 71,8 % est une borne haute, pas une prévision.** Chaque cycle est jugé là où
le bot se trouvait réellement à cet instant — un contrefactuel à un pas, ré-ancré sur le livre
réel à chaque réveil, jamais chaîné. C'est la seule lecture honnête d'une histoire où rien n'a
jamais corrigé : le livre retombait sous le plancher parce qu'aucune correction ne l'avait
relevé. En pilote, la première correction met la cible dans la bande, le modèle ré-émet une
proposition dans les mêmes proportions, et la cible corrigée retombe au même endroit — donc
les cycles suivants ne corrigent presque plus.

**Deux populations, jamais fusionnées.** La couche de transition n'a commencé à journaliser
que le 08/08. Les cycles antérieurs n'ont aucun verdict par actif, donc la question de la
faisabilité n'a pas de réponse pour eux — et le dire est différent de dire que les gels ont
bloqué la correction. Chaque section imprime son propre dénominateur.

---

## C1 — Intégrité du contexte par bougie : **passe**

246 bougies, 902 cycles portant un régime, **zéro bougie instable**.

Le contrôle échoue bruyamment, il ne rapporte pas — prouvé d'abord sur un cas fabriqué
(`src/test/exposureBand.ts`, preuve 12 : une bougie lue `defensive` à un réveil et
`constructive` à un autre fait échouer le contrôle), puis passé sur l'historique réel. Le
premier cycle d'une bougie peut donc servir d'unité d'analyse pour le protocole de fermeture.

## C2 — Couverture de contexte

| Famille | Bougies |
|---|---:|
| constructive | 108 |
| non_constructive | 138 |
| — dont `neutral` | 138 |
| — dont `defensive` | **0** |
| sans contexte exploitable | 0 |

**Aucun contexte défensif sur tout l'historique v5.** `risk_off` n'a jamais été confirmé
depuis le 25/07. Le barreau [0, 20] a donc une chance sérieuse de ne jamais être exercé
pendant les huit semaines. C'est une limite de couverture à rapporter, pas une raison de
bouger la bande.

Le ratio 108/138 sur 41 jours rend en revanche le critère de fermeture — 84 bougies valides
dans chacune des deux familles sur ~336 bougies — atteignable sans difficulté.

## C3 — La morsure : fréquence, sens, amplitude

Population : 885 cycles portant à la fois un contexte et une cible retenue.

| Contexte | Cycles | ↑ plancher | ↓ plafond | Dans la bande |
|---|---:|---:|---:|---:|
| constructif | 372 | **325** | 0 | 47 |
| neutre | 513 | 180 | 130 | 203 |
| défensif | 0 | — | — | — |

Amplitudes, en points d'exposition :

| | moyenne | médiane | p90 | max |
|---|---:|---:|---:|---:|
| constructif ↑ | 24,95 | 25 | 35 | 35 |
| neutre ↑ | 5,67 | 5 | 10 | 15 |
| neutre ↓ | 11,77 | 12 | 22 | 22 |

**635 / 885 cycles auraient reçu une correction (71,8 %)** — borne haute, voir plus haut.

La morsure est très asymétrique : en constructif elle est quasi systématique (325/372) et
lourde (25 points en médiane) ; en neutre elle est minoritaire (310/513) et modérée.

**Le plafond constructif à 70 % est structurellement redondant** avec le plancher de cash de
30 % : `clampAllocation` borne déjà l'exposition à 70 %. Zéro correction vers ce plafond, et
lire zéro ici ne prouve rien sur la politique — la borne haute qui mord réellement est le 45 %
du neutre, et elle mord 130 fois.

## C4 — Faisabilité : ce que les gels et les plafonds laissent atteindre

Population : **598 cycles** portant une lecture de transition (sur 885 évalués).

Sur 450 corrections dues :

- **46 (10,2 %) sont partiellement irréalisables**, dont **32 totalement** ;
- écart journalisé : moyenne 8,93 pt, médiane 5, max 20 ;
- **35 cycles n'ont aucune ligne** que la correction pourrait augmenter ;
- corrections certainement inertes : **32** parce que les gels ne laissaient rien de faisable,
  **0** parce que le mouvement restait sous le seuil de 2 %.

Les deux causes d'inertie sont publiées séparément et jamais additionnées : sinon la plomberie
porterait le chapeau du contrat de gel, ou l'inverse.

**Ce n'est pas un cas limite.** Le chemin « maximum faisable exécuté, écart journalisé » du
contrat de préséance est un chemin ordinaire — un cycle sur dix — pas une branche défensive.
C'est la conséquence directe de l'arbitrage : le code ne crée pas d'ordre sur une ligne gelée,
quel que soit `TRANSITION_MODE`.

À noter, et c'est important pour lire ce chiffre : **la porte de transition est aujourd'hui en
`observe`** — 0 des 885 cycles v5 portent un `applied_divergence_cause`, alors que 7 ordres du
modèle ont été journalisés `forbidden`. Le modèle peut donc trader une ligne gelée ; la
correction, non. L'asymétrie est voulue et publiée à chaque cycle
(`increasable_assets` / `decreasable_assets`).

## C5 — Changements de contexte concernés

11 changements d'état sur 246 bougies : `neutral→constructive` ×6, `constructive→neutral` ×5.

176 bougies auraient reçu une correction, dont **6 sur la bougie même du changement**. Le
reste — 170 bougies — est la bande tenant une position que le modèle continue de ne pas
prendre, cycle après cycle.

C'est précisément le comportement que le pilote existe pour observer, et c'est aussi ce qui
rend la borne haute si haute : sans correction, rien ne ramène jamais le livre dans la bande.

## C6 — Le temps passé à chaque niveau

Par **bougie**, jamais par cycle. Population : les **158 bougies** portant les deux lectures ;
82 bougies ont une cible réelle mais aucune faisabilité (avant le 08/08) et sont exclues des
deux lignes, sinon l'écart mesurerait une différence de population.

| Niveau d'exposition | Cible réellement retenue | Cible sous bande (faisable) |
|---|---:|---:|
| [0, 20) | 75 bougies — 300 h | 3 bougies — 12 h |
| [20, 45) | 70 bougies — 280 h | 79 bougies — 316 h |
| [45, 70] | 13 bougies — 52 h | 76 bougies — 304 h |
| > 70 | 0 | 0 |

Moyenne : **21,28 % réelle contre 34,30 % sous bande**, soit +13,02 points.

Mesure ré-ancrée à un pas, **pas une trajectoire** : rien n'est chaîné d'une bougie à la
suivante, donc aucun rendement ni aucun drawdown ne peut en être tiré — et aucun n'est calculé.

---

## Ce que ce rapport permet de conclure, et ce qu'il ne permet pas

**Il permet de conclure** que le mécanisme se comporte comme annoncé : le contexte se lit par
la fonction de production, la bougie 4h est une unité stable, la bande mord dans le sens et
avec l'amplitude que sa définition implique, et le contrat de gel a un coût mesuré et borné.

**Il ne permet pas de conclure** que la bande A est bonne, ni qu'elle est déployable. Aucune
politique n'a été sélectionnée sur ce rejeu, et le mode `application` reste refusé par le
binaire jusqu'à la dernière brique.

**Deux points méritent votre lecture avant la brique 2 :**

1. La morsure en constructif est quasi systématique et lourde. Même en tenant compte du fait
   que 71,8 % est une borne haute, le pilote va passer une part importante de son temps
   constructif à une exposition que le modèle n'a jamais demandée. C'est l'objet de
   l'expérience — mais c'est aussi le mode de panne que le §6 du brief nomme, et il faudra le
   surveiller sur les premières semaines plutôt que sur les huit.
2. Le barreau défensif est très probablement mort-né. Si `risk_off` ne se confirme pas
   davantage dans les huit à douze semaines à venir qu'il ne l'a fait dans les six dernières,
   le pilote se fermera avec `defensive = 0` et l'un des trois barreaux n'aura jamais été
   exercé.
