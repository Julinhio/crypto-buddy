# Pilote d'exposition contrainte — briques 1 et 2

| Brique | Fichier | Ce qu'elle fait |
|---|---|---|
| 1 | `band.ts` | **évalue** : le contexte, la bande, où la cible se situe, ce que les gels et les plafonds laissent atteindre |
| 1 | `observe.ts` | une ligne d'observation par cycle + le contrôle d'intégrité par bougie |
| 2 | `correct.ts` | **répartit** : §3.5 vers le plancher, §3.6 vers le plafond, la préséance, la consolidation |

Les tenir séparées est ce qui a rendu le point de contrôle honnête : la morsure s'est publiée,
lue et contestée avant qu'une seule ligne de correction n'existe.

**Ce qu'elles ne produisent pas, et ne produiront jamais dans cet état : ni P&L, ni drawdown,
ni rendement.** Le rejeu historique le dit dans son propre artefact (`bite.json` →
`contract.not_measured`), pas seulement ici.

**Ni l'une ni l'autre ne touche au chemin des ordres.** Le mode `application` reste refusé par
le binaire jusqu'à la dernière brique ; jusque-là la correction est calculée, journalisée, et
rien ne l'envoie.

---

## Le contrat

### Le contexte est celui de production, jamais une deuxième opinion

`readContext` vient de `src/calibration/exposure/controller.ts` — importée, jamais réécrite.
Le cycle vivant l'appelle sur le `RegimePoint` de production ; le rejeu historique l'atteint
par `regimePointFromJournal`. Un test prouve que les deux lectures sont identiques sur la
même bougie, donc « le vivant et le rejeu lisent le même contexte » est une preuve et non un
espoir.

Ce qui est **repris du harnais de calibration**, et rien d'autre : cette définition du
contexte, et les six bornes de la bande A. **Non repris** : l'allocateur du harnais, qui part
d'un panier fixe et ne redistribue aucun manque. Ses performances mesurées ne sont ni une
promesse, ni une référence, ni un critère.

Les six bornes vivent dans `config/index.ts`, en configuration de production, et **pas** dans
`arms.ts`. Importer le bras y aurait tiré tout le harnais — moteur, tape, métriques — pour
quatre nombres. Un test suit le graphe d'imports depuis `beat.ts` et vérifie les deux moitiés :
`band.ts` y est, `arms.ts` et le moteur n'y sont pas.

### Une divergence d'univers, héritée et journalisée

Le contrôleur est défini sur les 4 actifs allouables. Le **régime** de production est calculé
sur les paires tradables **et** référence — 5 actifs aujourd'hui, SOL compris. Donc :

- la **largeur nette** est calculée sur les 4 allouables, l'univers de calibration ;
- le **`risk_off`** est celui de production, calculé sur 5.

L'état hérite des deux. Ce n'est pas un arbitrage que cette brique avait la liberté de
prendre — production est propriétaire de `risk_off`. C'est journalisé plutôt que lissé.

### Le contrat de gel est plus strict que la porte, et c'est délibéré

Arbitré : **le code ne crée pas lui-même d'ordre sur une ligne que la couche de transition
déclare gelée, quel que soit `TRANSITION_MODE`.** La contrainte porte sur les mouvements de la
correction et sur eux seuls — elle ne bascule pas la porte en `enforce`, et elle ne touche pas
au vecteur brut du modèle.

Aujourd'hui la porte est en `observe` : elle ne bloque rien, et 0 des 884 cycles v5 portent un
`applied_divergence_cause`. Le modèle peut donc trader une ligne gelée, la correction non.
L'asymétrie est une donnée, pas un défaut, et `increasable_assets` / `decreasable_assets` la
publient à chaque cycle.

La traduction de l'échelle de priorité, verdict par verdict :

| Verdict de porte | Augmenter | Réduire | Pourquoi |
|---|:--:|:--:|---|
| `actionable` | ✓ | ✓ | la couche a dégagé la ligne |
| `risk_off_reduction` | ✗ | ✓ | le barreau 2 lève le gel **pour les réductions seules** |
| `frozen` | ✗ | ✗ | transition en cours, aucun ordre du code |
| `no_regime` | ✗ | ✗ | échoue **fermé** : l'absence de lecture n'est pas une permission |
| `stop_exit` | ✗ | ✗ | le stop possède la ligne pour ce cycle |

### L'exposition est la SOMME des poids non-réserve

Jamais `100 − réserve`. Les deux coïncident dès que l'allocation totalise 100 — ce que le
schéma impose et que les 884 lignes v5 respectent — et quand elles divergent c'est la somme
qui est honnête : soustraire à un cent qui n'existe pas fabrique de l'exposition.
`target_sum_percent` est publié à côté pour que la divergence se voie.

### Une donnée absente n'est jamais un contexte neutre

`gap` nomme la raison : `no_regime`, `unclassifiable_regime`, `no_target`. Aucune des trois ne
devient `neutral`. Le protocole de fermeture compte des bougies par famille, et gonfler la
famille non constructive avec de l'absence décalerait la date d'arrêt du pilote.

Un cycle qui a échoué garde sa ligne, avec ses champs de cible à `null` et sa raison nommée.
Une population qui n'aurait gardé que les cycles réussis flatterait tous les taux calculés
dessus.

---

## Les trois modes

`EXPOSURE_BAND_MODE`, résolue une fois au démarrage :

| Valeur | Effet |
|---|---|
| absente / `off` | la bande n'est pas calculée et rien n'est écrit — comportement v5 strictement inchangé |
| `observation` | calcul et journal complets, **aucun effet sur les ordres** |
| `application` | **refusée par ce binaire** — voir ci-dessous |

**L'absence signifie sûr.** Rien à poser sur Railway pour garder le comportement actuel, et un
environnement qui perd ses variables revient bande éteinte plutôt qu'à moitié armée.

`application` est refusée **par le binaire**, pas par la discipline. Le passage
`observation` → `application` est l'instant officiel de départ du pilote : son equity, son
plus-haut et son horloge de huit semaines commencent là, et cet instant ne se dépense qu'une
fois. La correction, les deux témoins, l'identité et le coupe-circuit ne sont pas dans ce
build ; un bot qui accepterait `application` aujourd'hui démarrerait l'expérience sans témoin
et sans drawdown persistant pour l'arrêter. La valeur devient légale dans la PR qui la rend
sûre, et son message de refus le dit plutôt que de se lire comme une faute de frappe.

---

## Pourquoi cette brique ne peut pas changer ce que fait le bot

Structurel, pas promis. Quatre propriétés, chacune prouvée dans `src/test/exposureBand.ts` :

1. **La première instruction de la closure est l'interrupteur.** En `off` elle sort avant tout
   calcul et avant toute écriture — donc la table reste vide, elle n'accumule pas des lignes
   que personne n'a demandées.
2. **Elle retourne `void`.** Aucune allocation, aucun mouvement, aucun ordre ne peut en être
   dérivé : un appelant ne peut pas utiliser ce qu'il ne reçoit pas.
3. **Elle tourne APRÈS les ordres**, dans le même palier que l'observation de transition et le
   snapshot d'equity, donc une insertion bloquée ne peut pas peser sur le verdict de trading
   ni laisser le watchdog forcer la sortie.
4. **Son écrivain est best-effort et borné par contrat**, donc il ne peut pas non plus faire
   échouer un cycle. Un `runBoundedWrite` à 5 s, la même mécanique partagée que les deux
   autres écrivains observationnels.

Et le graphe d'imports de `band.ts` + `observe.ts` ne contient **aucun** fichier capable de
construire une requête. Les deux sont purs et totaux : `readContext` peut lever
`UnknownRegimeError` — délibérément, pour qu'un nouveau régime ne soit jamais compté neutre en
silence — et cette levée est attrapée et enregistrée comme un fait, jamais laissée tuer un
réveil.

---

## La cible que la bande évalue

La proposition **bornée par le risque** (`clamp.applied`), jamais `gateOutcome.appliedAllocation`.

C'est exactement là que la correction se placera quand elle deviendra réelle : le garde de
cohérence a déjà jugé l'intention brute du modèle à ce point (§3.4.5), et la porte de
transition n'a pas encore parlé (§3.4.2). Évaluer la valeur post-porte mesurerait la bande
contre une cible qui, sur un cycle refusé, est le vecteur du cycle précédent — un nombre que
la bande n'a jamais eu vocation à contraindre.

Note : sur les 884 cycles v5, `clamped` est **faux partout**. Le clamp n'a jamais mordu, donc
la cible bornée est aujourd'hui identique à la proposition brute. La colonne reste le fait, et
la recomputation serait une supposition.

---

## Reproduire la morsure historique

```bash
npm run replay:band-bite
```

Lecture seule : lit `decisions` et `transition_observations`, n'écrit rien en base, ne place
rien. Sept critères, sortie non nulle si l'un échoue. L'artefact `out/exposure-band-bite/`
n'est **pas commité** — c'est un extrait du journal vivant, régénérable à tout instant.

Le rapport publié est `docs/RAPPORT-MORSURE-BANDE.md`.

### La morsure est une BORNE HAUTE, pas une prévision

Chaque cycle est jugé là où le bot se trouvait réellement à cet instant — un contrefactuel à
un pas, ré-ancré sur le livre réel à chaque réveil, **jamais chaîné**. C'est la seule lecture
honnête d'une histoire où rien n'a jamais corrigé : le livre retombait sous le plancher parce
qu'aucune correction ne l'avait relevé.

En pilote il n'en ira pas ainsi. La première correction met la cible dans la bande, le modèle
ré-émet une proposition dans les mêmes proportions, et la cible corrigée retombe au même
endroit — donc les cycles suivants ne corrigent presque plus. La fréquence mesurée est un
**plafond** sur le taux d'intervention de régime permanent. Quiconque la cite comme « la bande
corrigera N % des cycles » la cite de travers.

### Deux populations, délibérément non fusionnées

La couche de transition n'a commencé à journaliser que le 08/08, deux semaines après le début
de v5. Les cycles antérieurs n'ont aucun verdict par actif, donc la question de la
**faisabilité** n'a simplement pas de réponse pour eux. Les verser dans le même taux
rapporterait tout l'avant-08/08 comme « rien n'était faisable », ce qui est un artefact du
journal et pas un fait de marché.

Donc : la morsure (sens et amplitude) sur tous les cycles, la faisabilité sur ceux qui portent
une lecture de transition, les deux dénominateurs imprimés.

---

## Le contrôle d'intégrité par bougie

Le bot se réveille 3 à 7 fois dans une même bougie 4h. Le contexte est calculé sur la bougie
**close**, donc ces réveils doivent partager un seul état, une seule largeur, un seul
`risk_off`. Le protocole de fermeture fait du **premier cycle** de la bougie l'unité
d'analyse ; cette convention n'est valide que si les autres sont d'accord avec lui.

Le contrôle **échoue**, il ne rapporte pas. Vérifié sur l'historique v5 réel avant d'être
écrit : 246 bougies, 901 cycles portant un régime, **zéro bougie instable**. Ce n'est donc pas
une tolérance — c'est un invariant qui tient aujourd'hui, et le rejeu s'arrête s'il cesse de
tenir.

L'empreinte porte sur la **lecture entière** du contrôleur, pas sur une poignée d'agrégats.
Un échange BTC↔ETH qui laisse la lecture identique n'est correctement **pas** une anomalie —
la bande ne peut pas le voir, et le signaler ferait échouer des runs sur une différence sans
conséquence. Ce que l'empreinte doit attraper, et attrape, c'est une perte partielle de donnée
de marché en cours de bougie (`unavailable` bouge, donc la largeur, donc potentiellement
l'état) et a fortiori un état qui bascule entre deux réveils.

---

## La répartition (brique 2)

### §3.5 — vers le plancher

1. **Proportionnellement** aux cibles risquées strictement positives du modèle qui peuvent
   encore augmenter. Le poids du modèle EST la part : une ligne à zéro n'a aucune conviction à
   mettre à l'échelle et ne reçoit rien — « strictement positives » exprimé en arithmétique
   plutôt qu'en filtre qu'il faudrait tenir en phase.
2. Plafonds et gels respectés : ils bornent le `headroom`, donc aucune passe ne peut les
   violer. L'excédent d'une ligne écrêtée est **re-versé** sur celles qui ont encore de la
   place, jamais perdu (`waterfill`).
3. Le reliquat est **réparti également** entre les autres lignes actionnables ayant de la
   capacité — exactement celles que le modèle a laissées à zéro, plus celles qu'il a saturées.
4. Cette seconde part porte `allocation_de_secours`, parce qu'elle n'exprime **aucune**
   conviction du modèle et qu'il ne faut pas qu'on puisse la relire plus tard comme si oui.
5. **La consolidation.** Le seuil de 2 % s'applique au résultat, et une répartition en petites
   jambes peut laisser la borne inaccessible alors qu'une jambe exécutable l'atteindrait. La
   recherche est un **rétrécissement** : chaque tentative garde les k candidats les plus
   prioritaires, donc le même déficit atterrit sur moins de lignes et les jambes grossissent.
   k = 1 est le cas « une jambe exécutable » que le protocole nomme.
   - La priorité est le poids du modèle décroissant : le rétrécissement **abandonne les lignes
     de secours avant toute ligne à laquelle le modèle croyait**.
   - Exclure toutes les lignes tombées d'un coup — la première implémentation évidente — est
     faux : quand toutes sont tombées, ça vide le pool et la correction s'effondre, ce qui est
     l'inverse de consolider.
6. Ce qui reste hors d'atteinte est journalisé, jamais attendu en silence.

### §3.6 — vers le plafond

Symétrique et tout aussi contraignant : l'exposition non modifiable des lignes gelées est
**réservée en premier**, le budget restant est réparti proportionnellement entre les cibles
positives du modèle sur les lignes réductibles, et si les gels dépassent le plafond à eux
seuls, **toutes les réductions autorisées descendent jusqu'à zéro** et le dépassement résiduel
est journalisé.

**Pas de consolidation ici**, délibérément. Le §3.5.5 la demande côté plancher et le §3.6 ne
la demande pas. Ajouter une règle non arbitrée à un protocole préenregistré ferait diverger les
deux côtés pour une raison que personne n'a tranchée.

### La limite mécanique qu'il faut connaître

Un déficit valant **environ un seuil de mouvement** ne peut être sauvé par aucune
concentration : le budget d'achat est divisé par `(1 + frais)`, donc une jambe calibrée
exactement sur 2 points d'un livre de 1000 arrive à 19,98 contre un seuil de 20,00. Toutes les
tentatives sont évaluées, aucune n'aide, et le résultat honnête est un écart de 2 points plutôt
qu'une cible qui prétend bouger. `consolidation_attempts` sépare « rien à faire » de « tout
essayé, rien n'a marché ».

### Le seuil de mouvement n'est jamais réimplémenté

La correction appelle `planMovements` — la fonction de l'exécuteur — sur chaque allocation
candidate. `computeMovements` en est devenu une enveloppe fine. Une correction qui aurait
modélisé le seuil elle-même finirait par diverger de ce qui envoie réellement les ordres.

Les plans candidats sont **étiquetés `[skip:band]`** dans les logs : sans ça, leurs lignes de
refus seraient indiscernables de celles du cycle réel et l'opérateur verrait deux fois plus de
refus qu'il n'y en a eu.

## Le journal en quatre faits

Un objectif d'allocation n'est pas une exécution.

| | Colonne | Ce que c'est |
|---|---|---|
| 1 | `raw_weight_percent` | ce que le **modèle** a proposé |
| 2 | `correction_points` | ce que la **bande** a imposé, signé |
| 3 | `corrected_weight_percent` | la **cible finale** pour le moteur d'exécution |
| 4 | `booked_*`, `post_cycle_weight_percent` | ce qui a **réellement** bougé et ce que le livre tient |

En mode `observation`, le fait 4 décrit le cycle **réel** du bot, qui n'est pas corrigé.
L'écart entre le fait 3 et le fait 4 est donc exactement la non-application de la correction —
c'est voulu, et c'est ce qui rendra le passage en `application` lisible : les deux convergeront.

**Deux écarts, pas un.** `unrealisable_points` mesure ce que les gels et les plafonds rendent
impossible ; `realised_gap_points` mesure ce qui reste hors bande une fois la plomberie passée
aussi. Leur différence est la part imputable au seuil de mouvement, et une colonne fusionnée
rendrait cette attribution indérivable.

**La cause par ligne va du plus spécifique au moins** : un gel est un gel quoi qu'il arrive, un
plafond atteint l'est quoi que dise le seuil, la plomberie n'est blâmée qu'en dernier. Les
confondre laisserait le seuil de 2 % prendre le crédit d'un gel.

### Le compteur « le modèle utilise-t-il l'exposition imposée »

Dérivé **en lecture**, jamais écrit dans le cycle : les colonnes ci-dessus suffisent, et
ajouter une lecture en base au chemin de trading pour une statistique serait un mode de panne
gratuit. La requête vit dans le rejeu (`C8`).

Trois lectures, parce qu'une seule serait trompeuse. « Le modèle demande moins que la position
imposée » est presque automatique — il ré-émet sa propre préférence. Ce qui distingue
l'indifférence de la **lutte**, c'est qu'il descende plus bas qu'il n'était descendu lui-même.

## Ce que ces briques ne peuvent pas conclure

Elle ne conclut pas que la bande A est bonne, ni qu'elle est déployable. Elle ne produit aucun
chiffre de rendement, et aucun ne serait recevable au point de contrôle. Ce qu'elle produit,
c'est la vérification que **l'intervention observée correspond au mécanisme annoncé** — et le
constat, chiffré, que le chemin « maximum faisable exécuté, écart journalisé » est un chemin
ordinaire et pas une branche défensive.
