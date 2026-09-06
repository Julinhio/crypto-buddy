# Pilote d'exposition contrainte — briques 1 à 4

| Brique | Fichier | Ce qu'elle fait |
|---|---|---|
| 1 | `band.ts` | **évalue** : le contexte, la bande, où la cible se situe, ce que les gels et les plafonds laissent atteindre |
| 1 | `observe.ts` | une ligne d'observation par cycle + le contrôle d'intégrité par bougie |
| 2 | `correct.ts` | **répartit** : §3.5 vers le plancher, §3.6 vers le plafond, la préséance, la consolidation |
| 3 | `witness.ts` | **compare** : les deux témoins chaînés, leur pondération sous plafonds, leur plomberie |
| 3 | `../replay/exposureBandWitnesses.ts` | le rejeu hors ligne des trois livres, en segments, et ses huit critères |
| 4 | `pilot.ts` | **arme** : l'identité persistante, le coupe-circuit, la fermeture de la fenêtre de mesure |
| 4 | `../persistence/exposurePilot.ts` | la lecture et les écritures obligatoires, bornées, sur le chemin de trading |

Les tenir séparées est ce qui a rendu le point de contrôle honnête : la morsure s'est publiée,
lue et contestée avant qu'une seule ligne de correction n'existe.

**Ce qu'elles ne produisent pas, et ne produiront jamais dans cet état : ni P&L, ni drawdown,
ni rendement.** Le rejeu historique le dit dans son propre artefact (`bite.json` →
`contract.not_measured`), pas seulement ici.

**Les briques 1 à 3 ne touchent pas au chemin des ordres**, et la brique 4 est la seule qui le
peut — sous deux verrous, et seulement quand le pilote est armé. En `off` et en `observation`
la correction est calculée, journalisée, et rien ne l'envoie.

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

**La porte est en `enforce`**, et elle l'était avant ce chantier. Le cycle 1590 du 26 août en
porte la preuve : un stop de sommet à −11,13 % a généré une sortie totale, le verdict de la
ligne XRP est `superseded`, la cible appliquée est passée à `XRP 0` contre 13 demandés par le
modèle, et le registre a booké la vente des 97,8 XRP.

Aucun cycle v5 ne porte de `applied_divergence_cause` pour autant : un stop qui reprend une
ligne SUPERSÈDE, il ne refuse pas. Les deux mécanismes sont distincts et seul le second remplit
cette colonne.

L'asymétrie tient quel que soit le mode : **le modèle peut proposer une jambe sur une ligne
gelée ; sous `enforce`, la porte décide ensuite du vecteur entier** — la correction, elle, n'en
crée jamais. `increasable_assets` / `decreasable_assets` la publient à chaque cycle.

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
| `application` | **légale depuis la brique 4**, et armée seulement si l'identité persistante le dit aussi |

**L'absence signifie sûr.** Rien à poser sur Railway pour garder le comportement actuel, et un
environnement qui perd ses variables revient bande éteinte plutôt qu'à moitié armée.

`application` est **légale** depuis la brique 4 — la correction, les deux témoins, l'identité
fixe et le coupe-circuit sont tous là. **Légale n'est pas armée** : la variable seule ne décide
de rien, et la correction n'atteint l'exécuteur que si l'identité persistante le dit aussi. Le
passage `observation` → `application` reste l'instant officiel du pilote, et il ne se dépense
qu'une fois.

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

## La limite connue de la brique 2 — LEVÉE (brique 3)

**Un achat abandonné faute de budget n'apparaissait nulle part.**

Quand le cash est déjà au niveau de la réserve cible et que les ventes censées le financer
sont toutes supprimées sous le seuil de 2 %, le budget d'achat est nul et `planMovements` saute
la boucle d'achat entière. Les achats en attente ne figurent alors **ni** dans `movements`,
**ni** dans `suppressed` : leur `suppressed_reason` reste nul et le compte de jambes supprimées
les ignore.

C'est la même famille que le défaut de poussière corrigé dans cette brique — une sortie
anticipée qui ne déclare pas ce qu'elle abandonne, dans une comptabilité que tous ses
consommateurs croient exhaustive.

Portée mesurée : **aucun ordre n'est modifié et aucun chiffre publié n'est affecté**. La
condition est étroite et sa fréquence n'a pas été mesurée. C'est pourquoi elle n'a pas été
corrigée dans la brique 2, sur arbitrage.

**Le critère obligatoire est rempli.** `planMovements` déclare désormais ces jambes sous une
quatrième raison, `no_budget`, distincte et durable (migration 0032) :

| Raison | Ce qu'elle dit de la jambe |
|---|---|
| `movement_floor` | trop petite pour valoir la peine d'être envoyée |
| `no_price` | pas dimensionnable, aucun prix ce cycle |
| `dust` | rien à bouger, le livre est déjà là |
| `no_budget` | elle valait la peine, elle tenait au-dessus du seuil, **et rien ne pouvait la payer** |

Les fondre aurait laissé le seuil de 2 % prendre le crédit d'une contrainte de trésorerie —
la même famille de mauvaise attribution que la cause par ligne existe pour empêcher. Côté
cause du §3.3, `no_budget` est la quatrième cause, `autre_impossibilite` : ce n'est pas le
seuil, et seul `movement_floor` peut réclamer `seuil_de_mouvement`.

**Aucun ordre ne change.** Ces jambes n'étaient pas envoyées avant et ne le sont pas
davantage ; ce qui change, c'est qu'elles sont déclarées. La preuve 23 de
`src/test/exposureCorrection.ts` vérifie les deux moitiés : la jambe non financée est
déclarée, le plan n'envoie toujours rien, et un achat *financé* est toujours envoyé sans
qu'aucune raison ne soit inventée pour lui.

## Les deux témoins (brique 3)

```bash
npm run replay:band-witnesses
```

Hors ligne, lecture seule, huit critères, sortie non nulle si l’un échoue. L'artefact
`out/exposure-band-witnesses/` n'est pas commité.

### Trois livres chaînés, et deux seulement sont des témoins

| Livre | Ce qu'il vise | Porte les gels du bot ? |
|---|---|:--:|
| **E** | l'exposition **réelle** du bot, à chaque intervalle | non |
| **P** | le **plancher** de la bande courante | non |
| **B̂** | le bot **corrigé** — pas un témoin, voir plus bas | oui |

Bot moins E mesure la sélection à exposition identique. E moins P mesure la valeur du timing
d'exposition dans la bande. Bot moins P mesure les deux ensemble.

### La pondération : équipondérée sous plafonds, excédent redistribué

Arbitré. Le §3.7 dit « répartie également entre les quatre actifs » et les plafonds par actif
disent que XRP ne dépasse pas 15. À 70 % d'exposition la part égale vaut 17,5 : au-dessus de
60 %, les deux ne peuvent pas tenir ensemble, et l'histoire v5 y passe 57 cycles sur 904.

**La priorité du contrat est l'exposition** — « bot moins E mesure la sélection *à exposition
identique* » n'est vrai que si E porte vraiment celle du bot. Donc : répartition égale,
écrêtement de ce qu'un plafond refuse, et **redistribution** de l'excédent sur les lignes qui
ont encore de la place — le même water-filling que la répartition de bande, importé plutôt que
réécrit. Aucun surplus ne repart en cash tant que les plafonds peuvent tenir l'exposition ;
seul ce qu'aucun plafond ne peut prendre est publié comme inplaçable.

Les actifs écrêtés et les points redistribués sont journalisés à chaque cycle.

### Les témoins portent la plomberie, jamais les gels

Arbitré aussi, et c'est une séparation de **nature**, pas de mode.

Ils portent leur propre plomberie d'exécution — frais, seuil de 2 %, poussière, prix absent,
budget insuffisant — appliquée à **leur** livre, à travers le `planMovements` de l'exécuteur
lui-même. Un témoin qui ignorerait le seuil serait un étalon qu'aucun portefeuille n'aurait pu
tenir.

Ils ne portent ni gel, ni stop, ni transition. Ces états décrivent une position **du bot** : un
`stop_exit` se déclenche sur son prix d'entrée, un `frozen` marque une transition sur sa ligne.
Un témoin n'a jamais pris cette entrée. Les lui appliquer rendrait le comparateur dépendant de
la trajectoire qu'il existe pour évaluer — et, aujourd'hui, plus contraint que le bot lui-même,
dont les gels décrivent SES positions et pas les leurs. **La séparation vaut sous la porte
telle qu'elle est aujourd'hui, en `enforce`** : elle dit de quel livre un gel parle, pas dans
quel mode il est lu.

Prouvé sur le graphe d'imports plutôt que sur le comportement : `transition/gate.ts` n'est pas
dans le graphe d'exécution de `witness.ts`, qui n'appelle aucune fonction de porte et ne lit
aucune carte de verdicts.

### B̂ — ce que la répartition envoie vraiment (C7)

B̂ n'est pas un témoin. C'est le bot **sous la correction**, chaîné : à chaque cycle la bande
est évaluée contre **son** livre, la correction dimensionnée sur **son** équité, et ses
mouvements bookés. À ce titre il hérite des gels en entier — le code ne crée jamais d'ordre sur
une ligne gelée.

**L'hypothèse est affichée, pas enfouie** : B̂ rejoue les réponses **historiques** du modèle
contre un livre que le modèle n'a jamais vu. Il mesure donc la **conséquence mécanique de la
correction sous décisions historiques figées**. Ce n'est ni une simulation de la réaction du
modèle, ni une borne de performance — ni haute ni basse.

C'est ce livre qui répond à C7, que le ré-ancrage à un pas de la brique 2 ne pouvait pas
atteindre : il repartait à chaque cycle d'un livre que rien n'avait corrigé.

### C8 n'a pas de verdict, et c'est de l'arithmétique

« Le modèle utilise-t-il l'exposition imposée, ou la combat-il ? » porte sur ce que le modèle
fait quand il **voit** une position que le correcteur a créée. En mode observation il n'en a
jamais vu une seule, et aucun contrefactuel chaîné ne répare cela : il ferait répondre les mots
réels du modèle à une question qu'on ne lui a jamais posée.

Le **lecteur** existe (`readAdoption`, trois lectures : adoption, indifférence, lutte) et les
données sont conservées. Le **chiffre** n'est pas publié : un chiffre affaibli serait lu comme
la réponse. C8 commence le jour où `application` expose réellement le modèle aux positions
corrigées.

### L'exposition que E vise est RECONSTRUITE, jamais lue

`equity_snapshots` ressemblait à la réponse et n'en est pas une : le scheduler la construit
depuis `DecideResult.portfolio`, documenté comme « le livre que l'IA a vu » — le livre **avant**
les ordres. Prouvé sur le corpus : au cycle 1807 le bot vend sa ligne ETH entière et le snapshot
la porte encore à sa quantité d'avant.

Le livre post-cycle est donc dérivé comme la production le dérive : **le livre pré-cycle plus le
registre souverain du même cycle** — `event_type='intent'` et `validation_status='executed'`,
exactement le filtre de `loadLedger`. Les quantités bougent de `ledger_base_delta`, le cash du
`ledger_quote_delta` frais compris, et le tout est valorisé aux prix **du cycle**. Les deux
entrées sont connues à l'instant N : rien d'un cycle ultérieur n'entre dans la cible de E.

**W2 vérifie cette reconstruction contre un terme indépendant** : le contexte du cycle
**suivant**, une autre ligne écrite par un autre chemin, qui montre ce que le bot tenait à son
réveil suivant. Comparé sur les **quantités** — un prix bouge entre deux réveils, une quantité
détenue non. L'ancien W2 était circulaire : il confrontait la cible de E à la valeur dont il
l'avait construite, et serait passé aussi bien sur le mauvais livre.

**Et W2 doit avoir comparé quelque chose.** « Aucune dérive » ne prouve rien sur un corpus où
rien n'a été comparé : un cycle terminal n'a pas de successeur, un segment singleton n'a aucune
paire, et un corpus entièrement fait de singletons serait passé avec zéro comparaison et un taux
d'accord affiché à 0 %. Le nombre attendu est donc calculé depuis la **structure des segments**
— quatre actifs par cycle ayant un successeur dans son segment — et l'observé doit lui être
**exactement égal**. Les cycles terminaux sont publiés comme non contrôlables, les segments
singletons comme **non exercés**, et un corpus n'attendant aucune comparaison ne peut pas faire
passer le critère.

### Le rejeu s'arrête à un point que le journal a PROUVÉ terminé

Une ligne de décision apparaît **avant** que le cycle qui l'a écrite soit fini : production
insère la décision, puis place les ordres, puis book le registre souverain, puis journalise les
verdicts de transition. Trois requêtes lancées ensemble peuvent donc enjamber cet instant —
l'une voyant la décision, l'autre ratant son registre — et le rejeu conclurait, en silence, que
le cycle n'a rien booké. C'est le défaut du livre pré-trade, ressuscité par une course.

La borne n'est donc pas « le dernier identifiant visible ». C'est **le dernier cycle que la
couche écrite en dernier couvre complètement** — un verdict de porte par actif de l'univers — et
toutes les requêtes portent ensuite exactement cette borne. Mesuré sur le corpus : les portes
arrivent 0,33 s après la ligne de décision en moyenne, 2,96 s au pire, et **jamais** avant le
registre. Aucun point figé du tout est un refus de rejouer, jamais un run vide.

### La précision dont dépend la reconstruction est un invariant, pas une hypothèse

Le livre de départ vient d'un contexte dont production arrondit les quantités à **8 décimales**
et le cash au **centime**. Repartir de là et y ajouter des deltas exacts n'égale la dérivation de
production que tant que les deux tiennent sur la grille du journal — ce qui est le cas, parce
qu'une quantité bookée est calée sur le pas du marché avant d'être journalisée.

Mesuré : 2472 comparaisons, écart relatif maximum **2,14 · 10⁻¹⁶**, soit du bruit machine. Mais
« mesuré » n'est pas « garanti », donc la condition est **vérifiée** : une quantité — du livre de
départ ou du registre — qui ne tient plus sur la grille **arrête le rejeu** avec son cycle et son
nombre nommés, plutôt que de laisser passer une approximation silencieuse.

L'arrondi du **cash** est documenté à part et borné : au plus 0,005 $ par reconstruction, sur
l'**équité** et jamais sur les quantités. À la plus petite équité de la fenêtre (1019,72 $), son
effet maximal sur l'exposition est de **0,00049 point** — quatre ordres de grandeur sous le seuil
de mouvement de 2 %. W2 reste la preuve empirique indépendante, et elle porte sur les quantités.

### Un trou coupe la chaîne, il ne la comprime jamais

Une chaîne qui saute un cycle irreconstructible et continue traite l'intervalle comme s'il
n'avait pas existé. Si les témoins s'y étaient rééquilibrés, toutes les lignes suivantes
portent des quantités, du cash et des frais qui n'ont jamais existé — et le compteur de trous
affiche un rejeu propre.

Donc un trou **interne ferme le segment**. Un nouveau s'ouvre au premier cycle complet suivant
et **réancre** les livres sur l'equity du bot à cet instant, en cash. Aucune equity, aucun
mouvement, aucun écart ne traverse la frontière, et chaque ligne porte son `segment_id`.

W0 distingue trois places, parce qu'elles ne coûtent pas la même chose :

| Place | Effet |
|---|---|
| antérieure au début reconstructible | aucun — la chaîne n'a pas commencé |
| **interne** | **rupture + réancrage** |
| terminale | aucune — rien ne reprend après |

La règle vit dans `witness.ts` (`cutIntoSegments`), pure et prouvée sur des fixtures qui **ont**
des trous : le corpus n'en porte aujourd'hui aucun d'interne, et une règle qui ne vivrait que
dans le rejeu ne serait jamais exercée.

### Ce que ce rejeu ne mesure pas

Aucun rendement, aucun drawdown, aucun écart bot-témoin. La fenêtre du pilote commence au
passage en `application` ; ce rejeu est un **banc d'essai de la machinerie**, et son artefact
le dit dans son propre bloc `contract.not_measured`.

Ce qu il prouve, c est le §6 : que toutes les entrées des témoins sont **durablement
journalisées** par le cycle vivant — prix, livre pré-cycle, registre souverain, journal de régime,
verdicts de porte, cible bornée — et que la reconstruction se **reproduit** à l'empreinte près.
Aucune écriture n'a été ajoutée au chemin de trading pour les témoins.

## L'identité du pilote et son coupe-circuit (brique 4)

C'est la brique qui **arme**. Les trois précédentes calculaient et journalisaient ; celle-ci
laisse la correction atteindre l'exécuteur — sous deux verrous indépendants.

### Deux verrous, pas un

| Verrou | Ce qu'il vaut |
|---|---|
| `EXPOSURE_BAND_MODE=application` | l'interrupteur de l'opérateur |
| l'identité persistante du pilote | celui du code, et il **échoue fermé** |

`application` est devenue une valeur légale du résolveur — les trois briques qu'elle attendait
sont là. **Légal n'est pas armé.** La variable seule ne décide de rien : la correction n'atteint
l'exécuteur que si l'identité le dit aussi, et l'identité refuse sur le moindre doute — ligne
illisible, plus-haut non écrit, contrat divergent, pilote arrêté à 50 %. Dans chacun de ces cas
le bot v5 continue **exactement** comme avant, et la cible transmise reste `clamp.applied`.

### Le point d'insertion EST le contrat de préséance

Entre `clamp.applied` et la porte de transition. Le garde a déjà jugé la proposition **brute** du
modèle (§3.4.5), la correction ne repasse pas devant lui (§3.4.7), et la porte parle **après**
elle, sur les mouvements corrigés (§3.4.2). Ce n'est pas une commodité : c'est le seul endroit du
cycle où les sept clauses tombent juste.

### L'instant officiel ne se dépense qu'une fois

Le premier cycle en `application` écrit l'identité : l'instant, l'equity d'ouverture, le
plus-haut initial. La correction s'applique **dès ce cycle** — l'alignement initial et ses frais
comptent, §3.8 — et aucun cycle suivant ne réactive quoi que ce soit.

**La base le garantit, pas la discipline** : un index unique interdit une seconde ligne. Créer un
pilote suivant supposera de lever cet index à la main, c'est-à-dire l'acte délibéré et revu que
l'arbitrage exige. Aucun chemin de code, aucune variable, aucune faute de frappe ne peut le
faire.

### Le coupe-circuit

| Seuil | Effet |
|---|---|
| **40 %** | une alerte **unique** et sa photographie. **La correction continue** — ce barreau est un avertissement, et en faire un arrêt désarmerait l'expérience à l'instant où son résultat devient intéressant. |
| **50 %** | la correction de bande s'arrête, **durablement**. Aucune liquidation, aucun verdict de stratégie, le bot v5 continue. L'identité ne peut plus se réactiver. |

Le drawdown se mesure depuis le **plus-haut du pilote**, qui ne fait que monter et survit à tout :
redémarrage, redéploiement, passage temporaire en `observation`. Un plus-haut remis à zéro
afficherait un drawdown nul le lendemain du pire jour du pilote, et c'est exactement la panne que
la preuve 4 de `src/test/exposurePilot.ts` met en scène.

### Une interruption du mode met fin au pilote

Le plus-haut n'est suivi que pendant que le pilote est armé. Un passage temporaire en
`observation` laisserait donc un trou, et un sommet atteint dans ce trou ferait paraître tous
les drawdowns suivants plus petits qu'ils ne sont — dans le sens qui fait mordre le
coupe-circuit trop tard.

Arbitré : **cette reprise silencieuse est refusée**. Dès qu'une identité active connaît un cycle
décidé hors `application`, l'interruption est constatée, persistée sous `interrupted_mode`, et
l'identité ne se réarme **jamais** — un retour de la variable n'y change rien.

**La détection vient du journal, pas d'un drapeau.** Un drapeau devrait être posé par le cycle
qui, précisément, ne faisait pas tourner ce code. Les cycles décidés, eux, sont écrits quoi
qu'il arrive : le pilote garde le dernier qu'il a vu, et si la table en contient un plus récent,
c'est qu'il en a manqué un. C'est ce qui fait de « aucun cycle intermédiaire ne peut être
ignoré » une preuve et non un espoir.

Un simple redémarrage ne laisse aucun trou : les cycles décidés se suivent et la reprise se fait
normalement depuis l'état persistant. Les cycles `skipped` et `error` ne comptent pas — ils ne
décident rien et ne déplacent aucun ordre.

L'invariant acheté : **une identité encore valide a vu tous les cycles décidés depuis son
activation**, donc aucun sommet observable ne manque à son plus-haut.

### Deux natures d'écriture, et deux conséquences différentes

| | Quand | Un échec fait quoi |
|---|---|---|
| **écritures préalables obligatoires** — activation, nouveau plus-haut, alerte, arrêt | **avant** que la correction touche un ordre | **désarme le cycle courant** : la correction ne s'applique pas, la cible reste `clamp.applied` |
| **le battement** — le reçu de continuité | **après** la décision, une fois la ligne écrite | **invalide le pilote au cycle suivant**, irréversiblement, sans rendre dangereux le cycle déjà exécuté |

La distinction est délibérée. Une écriture préalable garantit qu'aucun ordre corrigé ne part sur
un état qu'on n'a pas su enregistrer. Le battement, lui, ne peut pas être préalable — il nomme la
ligne de décision, qui n'existe pas encore quand la correction est calculée. Son échec ne rend
donc pas le cycle passé dangereux : ce cycle a bien tourné sous un pilote valide. Il rend le
**suivant** impossible, parce qu'à ce moment-là le pilote ne peut plus prouver avoir vu ce qui
s'est passé.

### Les trois instants officiels et leurs pointeurs

Activation, alerte 40 % et arrêt 50 % sont tous écrits **avant** que la ligne de décision
existe — cette ligne doit porter la cible corrigée, elle ne peut donc pas venir en premier.
Aucun des trois ne peut donc nommer son propre cycle au moment où il se produit. Chacun
enregistre son **instant**, durablement, et une passe de résolution remplit le cycle ensuite :
le premier cycle décidé à cet instant ou après.

Elle est **idempotente** — elle ne touche qu’un pointeur encore nul — et **récupérable** : un
cycle qui meurt entre son événement et cette passe laisse le pointeur nul, et le cycle suivant
le répare depuis le même instant durable.

**Un événement survenu n’est jamais enjambé.** La cascade par défaut est pilotée par le fait
que l’événement a eu lieu, pas par la présence de son pointeur : un arrêt survenu dont le cycle
reste irrésolu fait **refuser** le rejeu officiel, il ne le fait pas glisser jusqu’au point
courant. C’est la prolongation silencieuse que le premier jet réintroduisait par une autre
porte.

L’alerte à 40 % fait exception dans un seul sens : elle ne **borne** pas la cascade par défaut,
parce qu’elle ne termine rien — la correction continue de s’appliquer après elle.

### Un battement nul se lit, il ne dispense pas

Un battement nul recouvrait deux situations. L’activation fige donc une **référence durable** :
le dernier cycle décidé qui existait avant elle.

| Situation | Réponse |
|---|---|
| aucun cycle décidé depuis l’activation | **reprise possible** — le pilote n’a pas encore eu de cycle à nommer |
| au moins un cycle décidé sans battement | **statut interrompu** — il y a un trou dans le plus-haut |
| ni battement ni référence | **statut interrompu** — le pilote ne peut rien prouver de sa continuité |

Un crash **avant** toute décision tombe dans la première ligne ; un crash **après** la décision
mais avant le battement, dans la deuxième.
### Le mode de la porte est dans le contrat, et figé dans l’identité

La porte est en **`enforce`**, et elle l’était avant ce chantier. Ce n’est pas un détail
d’environnement : sous `enforce`, le code génère lui-même des sorties de stop, une jambe
interdite refuse le **vecteur entier** — correction comprise — et `stoppedWeightSurvives`
bascule, la bande dimensionnant alors sa correction contre un livre où la ligne stoppée part à
zéro.

Trois comportements différents de la même correction. Le mode entre donc **dans l’empreinte du
contrat** : le déplacer en cours de fenêtre invalide le pilote au lieu de le laisser continuer.

Et il est **figé dans l’identité** à l’activation. Le rejeu officiel reconstruit avec le mode
qui était en vigueur à ce moment-là, jamais avec la variable du poste où il est lancé — sans
quoi le même rejeu donnerait deux réponses selon la machine.

**Le banc d’essai historique, lui, dérive le mode des données.** Aucun `true` codé en dur : un
cycle où le stop du code a repris une ligne est nommé et écarté, parce que sa cible stockée est
post-porte et que ni elle ni le drapeau ne sont récupérables. Sur tous les autres, aucune ligne
n’est en instance de liquidation, donc le drapeau ne peut pas changer la réponse.

Un cycle et un seul est concerné dans tout le corpus : le **1590**, le 26 août.

### La morsure historique s’arrête au pré-pilote

Dès qu’une identité existe, `replay:band-bite` borne son corpus au cycle précédant
l’activation. Le rapport accepté décrit l’ère où rien ne corrigeait jamais ; cette ère se
termine à l’armement, et un vrai refus de porte après activation ne doit pas casser un rapport
qui ne parle pas de lui.
### La fenêtre officielle des témoins

Le rejeu des témoins lit ses bornes dans l'identité : ouverture au cycle officiel d'activation,
**inclusive**, sur l'**equity réellement enregistrée** à ce moment, et fermeture au cycle demandé
— `--at=alerte_40`, `arret_50` ou `cloture`. Rien d'antérieur à l'ouverture ni de postérieur à la
fermeture n'entre dans le résultat.

**Le refus est strict, et il est nommé.** Une identité présente ne suffit pas : si son cycle
d'activation est irrésolu ou son equity d'ouverture inutilisable, le résultat n'est pas officiel.
Un `--at` inconnu est refusé ; un `--at` connu dont le pointeur est absent est refusé aussi — et
**jamais prolongé jusqu'au point d'arrêt courant**, parce que « valorise au moment de l'arrêt » et
« valorise aujourd'hui » sont deux questions différentes.

Sans `--at`, le rejeu choisit **explicitement** l'instant réellement disponible — clôture, puis
arrêt, sinon le point courant — et publie le libellé de celui qu'il a pris. Aucun libellé ne
provient d'une chaîne vide ni d'un cast de la ligne de commande : les quatre valeurs sont closes.

**Sans identité — ou sur un refus — il n'y a pas de résultat officiel**, et le rejeu l'affiche
avec sa raison : c'est un banc d'essai de la machinerie, sa fenêtre est celle de l'historique
disponible, et son ouverture est un paramètre, pas un instant.

### Le contrat, et ce qui invalide un pilote

L'identité porte une empreinte canonique de tout son contrat **en valeurs** : version de politique
et de contrat, six bornes, univers et plafonds par actif, frais et seuil de mouvement, seuils de
drawdown, durées et couverture requise.

Elle **n'inclut pas le SHA git**. Un commentaire ou un renommage ne doit pas tuer une expérience de
huit semaines. La contrepartie est un devoir : une modification substantielle du comportement doit
déplacer `contractVersion` **à la main**, parce qu'aucune empreinte de valeurs ne voit un
changement de code.

Une divergence **invalide durablement** le pilote, arrête la correction et alerte une fois. Un
retour ultérieur à l'ancienne configuration ne le réactive pas. Le contrat est jugé **avant** tout
drawdown : des seuils qu'on ne reconnaît plus ne sont pas des seuils.

### La fenêtre de mesure se ferme ; la bande, non

Arbitré, et la distinction est tout. À huit semaines la fenêtre se ferme si la couverture requise
est atteinte — 84 bougies dans chaque famille — sinon elle court jusqu'à douze, où elle se ferme
dans tous les cas avec son libellé. Aucun cycle postérieur n'entre dans les résultats officiels,
**C8 compris**.

La correction, elle, **continue** après la clôture, en attendant notre décision. Elle ne se
désarme que sur le coupe-circuit ou sur un contrat invalide. Se désarmer sur une date
réarrangerait le portefeuille à un instant arbitraire, pour une raison qui n'a rien à voir avec le
risque.

### Ce qui est journalisé, cycle par cycle

`pilot_hold` dit pourquoi la correction n'a pas touché les ordres, et il n'est nul que quand elle
les a touchés. En `observation` il vaut `mode_inactif` partout : c'est la réponse honnête, et
c'est aussi la preuve continue que rien ne s'applique. À côté, le drawdown et le plus-haut que le
coupe-circuit voyait à cet instant — l'identité ne garde que le dernier état, et sans eux un arrêt
ne se relirait jamais dans son contexte.

## Passage de relais vers la brique 4

Ce que la brique 4 hérite, et ce qu'elle doit apporter :

| | |
|---|---|
| **Hérite** | les trois livres chaînés et leur rejeu reproductible, prêts à être valorisés à un instant donné — ce que demande le §3.9 au déclenchement du coupe-circuit |
| **Hérite** | le lecteur de C8 et les colonnes qui l'alimentent, en attente du premier cycle en `application` |
| **Doit apporter** | l'**identité persistante** du pilote : version de configuration, instant d'activation, equity initiale, plus-haut, état de l'alerte, actif ou arrêté — et qui survit à un redémarrage Railway |
| **Doit apporter** | le **coupe-circuit** : alerte unique à 40 %, désactivation persistante de la seule correction de bande à 50 %, aucune liquidation forcée |
| **Doit apporter** | la légalisation de `application` dans le résolveur d'environnement — **et elle seule crée l'instant officiel du pilote**, qui ne se dépense qu'une fois |

L'instant d'ouverture des témoins est aujourd'hui un **paramètre** du banc d'essai, pris au
premier cycle de la fenêtre. Le vrai instant appartient à la brique 4 : c'est le passage en
`application`, et les livres devront s'ouvrir là, sur l'equity réelle de ce moment.

## Passage de relais de la brique 2 (tenu)

Ce que la brique 3 hérite, et ce qu'elle doit apporter :

| | |
|---|---|
| **Hérite** | les faits par cycle : `base_weight_percent`, `correction_moves_holding`, `realised_*`, les deux écarts, `suppressed_reason` par ligne, l'origine et la cause |
| **Hérite** | l'artefact du rejeu, où les cycles sans faisabilité connue n'affirment **rien** plutôt que d'affirmer un écart fabriqué |
| **Doit apporter** | le contrefactuel **chaîné** — les témoins E et P — qui seul permet une lecture entre cycles |
| **A levé** | la limite ci-dessus — `no_budget`, migration 0032, preuve 23 |

Deux conclusions ont été retirées de la brique 2 et lui revenaient : ce que la répartition
enverrait réellement (C7), et si le modèle utilise ou combat l'exposition imposée (C8).

**Ce passage de relais était juste sur la première et faux sur la seconde**, et la brique 3 l'a
corrigé plutôt que de l'exécuter tel quel. C7 est bien une question de cadre de valorisation :
un livre chaîné y répond, et c'est B̂. C8 demande la **réaction du modèle** à une position qu'il
n'a jamais vue ; aucun chaînage ne fabrique cette réponse, et son verdict attend le pilote. Le
détail est dans la section des témoins ci-dessus.

## Ce que ces briques ne peuvent pas conclure

Elle ne conclut pas que la bande A est bonne, ni qu'elle est déployable. Elle ne produit aucun
chiffre de rendement, et aucun ne serait recevable au point de contrôle. Ce qu'elle produit,
c'est la vérification que **l'intervention observée correspond au mécanisme annoncé** — et le
constat, chiffré, que le chemin « maximum faisable exécuté, écart journalisé » est un chemin
ordinaire et pas une branche défensive.
