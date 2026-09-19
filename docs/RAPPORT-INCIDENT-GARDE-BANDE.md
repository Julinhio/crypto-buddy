# L'incident garde/bande des 18-19/09 — diagnostic, réparation, et ce que la mesure en garde

PR #48 (`fix/guard-band-hold`). Ce rapport fixe ce qui s'est passé, ce qui change dans le
garde de cohérence, et ce que les rapports du pilote liront désormais de ces cycles. Les
chiffres viennent de trois rejeux en lecture seule sur la base de production :
`npm run replay:guard-band-incident`, `npm run replay:coherence`, `npm run replay:policy-change`.

**Il ne contient aucun chiffre de rendement, de drawdown ni de performance du pilote.** Le
contrat A.1, la bande, la porte de transition et `contractVersion` ne bougent pas.

---

## Ce qu'il faut lire en premier

Le garde et le pilote étaient structurellement incompatibles depuis l'activation, et
l'incompatibilité s'est réveillée au cycle 2112 parce que la correction de bande y a été
assez grosse (+4,5 points sur BNB et ETH) pour laisser un écart exécutable durable entre
l'intention brute du modèle (33,75 % d'exposition) et le livre corrigé (45 %). Quinze cycles
sur dix-neuf perdus entre 2113 et 2131.

Deux faits que le brief ne connaissait pas, et que la base a donnés :

1. **Le chemin (b) — recopier l'allocation appliquée en `hold` — était rejeté depuis le cycle
   1840, pas depuis 2112.** Vingt-deux rejets en première tentative entre l'activation et
   l'incident, tous suivis d'une relance, dont vingt pour un maintien qui ne changeait rien.
   Ils ont survécu uniquement parce que les corrections d'alors étaient sous le seuil de 2 %.
   Et ce que le modèle recopie est l'allocation appliquée de la dernière décision
   **significative** — celle que le prompt lui montre — pas celle de la dernière ligne
   décidée, que la bande recalcule à chaque hold sans jamais l'exécuter (1922 recopiée
   vingt-cinq fois entre 1925 et 1951).
2. **Le même défaut de la règle 4 avait déjà tué deux cycles sur une simple dérive de prix**,
   2027 et 2028 le 14/09 : un maintien inchangé, XRP monté au-delà du seuil de 2 %, une thèse
   exigée pour un rééquilibrage que le modèle n'avait pas décidé.

Et un fait sur la mesure : la relance disait « ré-émets la référence inchangée », ce qui
ramenait le modèle à sa préférence brute. Aucune des quatre lectures C8 existantes n'a été
produite par une réponse orientée (1840 a relabellé son hold en gardant sa cible ; 1923 et
1952 sont passés du premier coup). Le fait reste tracé.

---

## 1. La frontière : qu'est-ce qu'un mouvement voulu par le modèle

Deux changements dans `src/decision/coherence.ts`, tous deux dans le sens permissif.

**Règle 1 — un `hold` peut reprendre l'une des cibles précédentes.** La dernière intention du
modèle (comme avant), ou une allocation appliquée : celle que la chaîne a retenue en dernier,
ou celle que le prompt lui a montrée (la mémoire de la dernière décision significative).
Reprendre ce que le livre tient est un maintien. Un `hold` qui ne correspond à aucune de ces
cibles est la famille 987 — une vraie révision sous la mauvaise étiquette — et reste refusé.
Une copie arrondie à l'entier (« BTC 11 » pour 10,95) ne correspond à rien à 0,01 près : la
règle 1 tire, seule, la relance cite les cibles valides et la seconde réponse passe.

**Règle 4 — une ligne est bougée par le modèle quand son intention y change ET que ce
changement trade.** Une dérive du livre ou le renversement d'une correction de bande
tradent des lignes que le modèle n'a pas révisées : rien n'est dû. Une révision sous le
seuil de 2 % ne trade pas : rien n'est dû non plus. Ce qui est dû, c'est l'intersection.
Sans référence (amorçage), tout mouvement reste celui du modèle, comme avant.

Règle 3 inchangée, délibérément plus large que la règle 4 : le garde laisse passer une thèse
sur toute ligne que la chaîne tradera, et la lifecycle reste le dernier mot (le
`thesis_write_refused` de 2124 sur ETH est ce chemin). Règle 2 inchangée, avec un résidu
nommé et épinglé par un test : après un déplacement de bande, une révision sous le seuil
sur une ligne déplacée passe par le contrefactuel. Aucun ordre, aucun cycle mort.

---

## 2. Le rejeu in situ — 2112 à 2131 sous le nouveau garde

Chaque réponse jugée contre les références que production avait à cet instant. Les deux
tentatives de chaque cycle en échec : la seconde est journalisée (`raw_response`), la
première reconstruite depuis le journal du garde — la règle 1 cite l'allocation émise dans
son refus, format `fmt()` du garde ; un refus règle 4 seule prouve que la cible était la
référence (la règle 1 n'a pas tiré) et sans note (la règle 4 a tiré).

| Critère | Résultat |
|---|---|
| I1 — les 11 `guard_failed` : la réponse journalisée (chemin a) | **11/11 acceptées** |
| I2 — les 11 premières tentatives reconstruites | 8 copies exactes d'une référence **acceptées** ; 3 copies arrondies (2128, 2129, 2131) → `hold_moved_target` seule, jamais la règle 4 |
| I3 — les 5 cycles décidés de l'incident | **5/5 acceptés**, jugés sur la proposition bornée journalisée |
| I4 — contrôles négatifs | un hold avec BNB 10 → 5 (aucune référence) → `hold_moved_target` ; un `de_risk` BNB 10 → 5 sans note → `moved_line_without_note` sur BNB seule ; 2124 réel avec sa note ETH retirée → `moved_line_without_note` (« ETH 14.5% → 12% ») |
| I5 — les relances de l'activation à l'incident | 22 rejets en première tentative ; **19 acceptés en première tentative sous le nouveau garde**, 3 copies arrondies (1939, 1943, 2102) qui gardent leur relance, 0 autre |

Ce que le tableau montre cycle par cycle : sur le chemin (a) le garde voit les ventes ETH,
BNB, XRP contre le livre déplacé, constate que l'intention n'a pas changé, et n'attribue
rien au modèle ; sur le chemin (b) il constate que la cible égale l'allocation appliquée et
ne relance pas.

Le rejeu de corpus (`replay:coherence`) reste à **5 rejets / 123 passages** sur les 128 de
l'analyse initiale. Il a fallu lui corriger un défaut : depuis l'activation il jugeait les
mouvements du garde sur `applied_allocation`, qui est l'allocation déjà corrigée par la
bande, et publiait dix-sept cycles acceptés comme `moved_line_without_note` — la même
mauvaise entrée que le rapport des témoins avait dû corriger pour B̂. Il juge désormais sur la
proposition bornée journalisée (`clamped_weight_percent`), et nomme la source.

`replay:policy-change` change de chiffre, et c'est voulu : un plafond qui bouge le livre vers
une intention inchangée est le mouvement du plafond, pas du modèle. Le cas « relâché » ne
coûte plus aucune relance (au lieu d'une) ; le cas « resserré » exécute sa réduction du
premier coup.

---

## 3. Ce que la mesure en garde — migration 0039

**`decisions.coherence_guard_armed`**, écrit à chaque réveil. NULL sur tout l'historique,
jamais reconstruit : un garde désarmé n'émet aucun événement, donc rien en base ne pouvait
dire que les cycles après 2131 ont tourné garde désarmé à la main. Les rapports le lisent en
quatre valeurs (`armed`, `disarmed`, `armed_by_event`, `unknown`) et « inconnu » n'est jamais
lu comme l'un des deux autres.

**`decision_integrity_marks`**, une ligne par (décision, type), écrite par la migration et
par rien d'autre :

- `selection_par_le_garde` sur **2115, 2124, 2125, 2126** — décidés parce qu'ils bougeaient.
  Insertion gardée par l'existence d'une ligne `decided` portant cet id.
- `relance_orientee_par_le_garde` sur les **20 cycles décidés sur seconde tentative depuis
  l'activation** (1840, puis 1925 à 2102), dérivés de `guard_recovered_on_retry` — sans
  inférence — avec la première réponse recopiée en JSON depuis le détail du refus.

C8 lit les marques sur le cycle de l'épisode et sur le cycle de réaction. Effet attendu sur
le réel une fois la migration appliquée : les dix épisodes exécutés de 2112 (3), 2115 (2),
2125 (2) et 2126 (3) sortent `non_attribuable` ; les quatre lectures d'avant l'incident ne
bougent pas — 1840 porte sa marque de relance avec une **réserve** (première réponse au même
poids), pas un changement de lecture. Un type de marque inconnu rend l'épisode `illisible` et
refuse la lecture officielle.

Preuve du mécanisme sur un PostgreSQL 17 local (embedded-postgres, les 39 migrations dans
l'ordre, formes de production semées avant la 0039) : 18 contrôles, dont l'idempotence, la
contrainte d'unicité, le CHECK des types, la cascade, RLS, et `reset_bot` qui tronque la
nouvelle table avec les autres. La correspondance schéma/fichiers en production reste le
contrôle de Julien, en lecture seule.

---

## 4. Ce que cette PR ne conclut pas

Elle ne réarme pas le garde — geste de Julien — et ne prouve pas encore un maintien live
après correction de bande : c'est la troisième condition de validation, qui dépend du marché.
Elle ne dit rien de la valeur du pilote. Elle dit que le garde et le pilote peuvent désormais
coexister, que la population de la fenêtre porte ses marques là où on la lit, et que les
notifications qui attribuent au modèle les ordres de la bande et du stop restent à traiter
(PR 2).
