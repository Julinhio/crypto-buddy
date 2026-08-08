# Rapport — Contrat de transition et calibration du stop au pic

Mesure uniquement. **Aucun comportement de production n'a été modifié.** Le bot a continué de tourner
pendant tout le chantier, et Supabase n'a été lu qu'en lecture seule.

Fenêtre mesurée : **2026-06-08 10:30 → 2026-08-08 08:41 UTC**, soit 61 jours, 1079 cycles,
42 ordres souverains, 366 bougies 4h par actif.

Reproduction :

```bash
npm run replay:transition
```

Le harness sort en code 0 si les quatre validations passent. Les trois blocs de mesure ne peuvent pas
échouer : ils rapportent. Les invariants de la règle elle-même sont dans `npm test`
(`src/test/stickyTransition.ts`).

---

## 0. Ce que le code dit du diagnostic

Le diagnostic tenait. `signalsAt` (`src/market/regime.ts`) calcule `pullbackConsumed` et
`bounceConsumed` à partir de la position dans le range 4h **de la bougie courante**, sans lissage,
pendant que le régime montré au modèle est celui qui a survécu à trois bougies de confirmation.
Le playbook v5 (`src/decision/promptV5.ts`) demande explicitement de lire la paire comme un ordre :
« reversal_down · pullbackConsumed FALSE → LIGHTEN ».

Le cycle 1163 en est le spécimen propre. BNB montré `range`, brut `trend_up` à deux bougies de la
confirmation, et le modèle écrit dans sa propre thèse : *« régime passé de trend_up à range »* — il lit
une étiquette périmée comme une nouvelle fraîche — puis vend deux points de la ligne dans un marché
qui monte.

**Une nuance que le diagnostic ne mentionne pas.** `raw` et `pendingRegime` *sont* présents dans le
JSON que le modèle reçoit : tout le `RegimeJournal` est sérialisé dans le contexte. Le mandat ne les
nomme jamais, ne les explique jamais, et ne dit jamais quoi en faire. Ce n'est pas une circonstance
atténuante — un champ non documenté dans une charge utile qu'on interdit au modèle de contester est
plus proche d'un piège que d'un avertissement — mais c'est un fait, et il appartient au dossier.

---

## 1. Validations — ce qui doit être vrai avant que le moindre chiffre compte

| id | ce qui est vérifié | résultat |
|----|--------------------|----------|
| T0 | la règle **filtre**, elle ne réétiquette jamais | 1830 asset-bougies, régime confirmé identique à celui de `Hysteresis` partout |
| T1 | le régime rejoué est celui que le bot a journalisé | 1435 asset-cycles vs `decisions.regime`, 287 résolutions de bougie, zéro écart |
| T2 | le pic rejoué est le pic que le bot détenait | 933 pics et 933 drawdowns journalisés, zéro écart |
| T3 | aucun artefact de préchauffage n'atteint la fenêtre | 359 bougies de warm-up, première bougie actionnable à l'index 2 |

**T0 est la validation qui porte tout le reste.** Les quatre points du contrat se réduisent à un seul
invariant : un actif est actionnable exactement quand son régime brut est identique depuis
`confirmations` bougies consécutives, bougie courante incluse. Le régime *confirmé* que produit cette
marche est identique, bougie par bougie, à celui de la `Hysteresis` de production — prouvé ici sur la
bande réelle, et prouvé exhaustivement sur 59 049 séries synthétiques (toutes les séries de 10 bougies
sur 3 étiquettes) par `src/test/stickyTransition.ts`. La règle collante **ajoute une porte
d'actionnabilité et rien d'autre**. Elle ne peut pas déplacer un régime, ni en inventer un, ni changer
ce que le modèle voit. C'est ce qui permet d'attribuer les chiffres des blocs B et C à la porte seule.

**T2 mérite un mot.** `position_state.peak_price_since_entry` est écrasé sur place à chaque cycle : la
table connaît le pic d'aujourd'hui et aucune histoire. Le pic de chaque cycle passé est donc rejoué en
faisant passer tout le flux par la fonction de production inchangée (`nextPositionState`), puis
réconcilié avec la seule trace journalisée qui existe — les 933 vues de cycle de vie v5 montrées au
modèle. L'état final du rejeu coïncide aussi, exactement, avec la table `position_state` vivante
(qty, entry_date et pic, sur les quatre actifs).

Deux pièges rencontrés en route, corrigés, et signalés parce qu'ils auraient produit des chiffres
plausibles et faux :

- `positions[].price` du contexte est **arrondi à 2 décimales** pour l'affichage. Sur XRP à ~1,10 $
  c'est 0,9 % d'erreur, un sixième du plus petit seuil testé. Le prix est lu depuis
  `market.tradable[].price`, en pleine précision.
- une ligne à plat est absente du tableau `positions`, donc le cycle qui l'**ouvre** n'y trouve aucun
  prix pour amorcer son pic. L'union avec les actifs négociables est nécessaire.

---

## 2. Bloc A — le coût du gel

### Taux de gel

| actif | bougies | gelées | taux | épisodes | plus long | retours avortés |
|-------|---------|--------|------|----------|-----------|-----------------|
| BTC | 366 | 114 | 31,1 % | 33 | 8 bougies / 32 h | 12 |
| ETH | 366 | 105 | 28,7 % | 29 | 10 bougies / 40 h | 9 |
| BNB | 366 | 126 | 34,4 % | 36 | **11 bougies / 44 h** | 10 |
| XRP | 366 | 102 | 27,9 % | 28 | 8 bougies / 32 h | 9 |
| SOL | 366 | 132 | 36,1 % | 42 | 8 bougies / 32 h | 11 |
| **tous** | **1830** | **579** | **31,6 %** | **168** | **11 bougies** | **51** |

L'ordre de grandeur annoncé dans le brief est **confirmé sans réserve** : 31,6 % d'états gelés
(attendu ~31,6 %) et un maximum de 11 bougies (attendu ~11). Aucun épisode n'était encore ouvert à la
dernière bougie de la fenêtre, donc aucune durée n'est une borne inférieure.

### Distribution des durées

| durée | épisodes | part |
|-------|----------|------|
| 2 bougies (8 h) | 76 | 45,2 % |
| 3 bougies (12 h) | 29 | 17,3 % |
| 4 bougies (16 h) | 23 | 13,7 % |
| 5 bougies (20 h) | 20 | 11,9 % |
| 6 bougies (24 h) | 7 | 4,2 % |
| 7 bougies (28 h) | 3 | 1,8 % |
| 8 bougies (32 h) | 8 | 4,8 % |
| 10 bougies (40 h) | 1 | 0,6 % |
| 11 bougies (44 h) | 1 | 0,6 % |

n = 168 · médiane **3 bougies** · p90 **6 bougies** · p99 **10 bougies** · max **11 bougies**

La forme compte plus que le total. **Deux gels sur trois durent 12 h ou moins**, et la queue est
courte : un seul épisode dépasse 40 h sur 61 jours et cinq actifs. Le taux de 31,6 % ne décrit donc pas
un bot immobilisé un tiers du temps par blocs de deux jours, mais un bot qui s'abstient très souvent
et très brièvement.

### Retours avortés

**51 des 168 gels (30,4 %)** se sont résolus en revenant dans le régime qu'ils avaient quitté. Ce sont
exactement les épisodes pour lesquels le point 4 existe : la bande a hésité, l'ancien régime est
revenu, et sous le code actuel le modèle a vu pendant tout ce temps une étiquette périmée à côté de
drapeaux vivants. Les cinq plus longs :

| actif | de → à | durée | régime quitté | étiquettes brutes vues |
|-------|--------|-------|---------------|------------------------|
| BTC | 2026-08-02 00:00 → 08-03 04:00 | 8 bougies (32 h) | reversal_down | 2 |
| ETH | 2026-08-02 00:00 → 08-03 04:00 | 8 bougies (32 h) | reversal_down | 2 |
| BNB | 2026-06-11 16:00 → 06-12 20:00 | 8 bougies (32 h) | range | 2 |
| XRP | 2026-08-02 00:00 → 08-03 04:00 | 8 bougies (32 h) | trend_down | 3 |
| BNB | 2026-06-22 08:00 → 06-23 08:00 | 7 bougies (28 h) | trend_down | 3 |

Les trois premières lignes du 2 août couvrent précisément la fenêtre où le bot a vendu dans la hausse.

---

## 3. Bloc B — les ordres que la règle supprime, et ceux qu'elle garde

### Les deux comptes, côte à côte

Sur les **42** ordres souverains de toute l'histoire :

| verdict | nombre | achats / ventes | part |
|---------|--------|-----------------|------|
| **AUTORISÉS** | 26 | 14 / 12 | 61,9 % |
| **INTERDITS** | 16 | 5 / 11 | 38,1 % |

Les deux chiffres comptent autant. Une règle assez serrée pour bloquer chaque erreur bloque aussi
chaque bon trade, et elle ne produit aucune erreur visible en le faisant — le bot cesse simplement
d'agir.

### Ce que « interdit » coûte réellement : la règle **retarde**, elle n'annule pas

Sur les 16 ordres interdits, **15 redeviennent actionnables plus tard dans la fenêtre**, un seul jamais.

- délai jusqu'à l'actionnabilité : **médiane 7,3 h** · p90 31 h · max 31 h (une bougie de 4 h est le plancher)
- mouvement de prix sur ce délai, signé en faveur de l'ordre : **−0,7 %** en moyenne, 4/15 améliorés
  (ventes −1,1 %, achats 0,0 %)

À lire étroitement. Ce chiffre valorise **un seul** contrefactuel — le *même* ordre, émis une ou deux
bougies plus tard — et c'est une borne supérieure du coût d'exécution du délai, rien de plus. Ce n'est
pas le bénéfice de la règle, et ça ne peut pas l'être : tout l'intérêt de geler l'actif est que le
modèle verra ensuite une étiquette et des drapeaux qui concordent, et n'émettra peut-être pas l'ordre
du tout. Seul un re-run du modèle pourrait le dire, et ce harness ne re-run pas le modèle.

### La fenêtre du 1er au 8 août

| intervalle | ordres | dont brut ≠ montré | interdits parmi eux |
|------------|--------|--------------------|---------------------|
| [08-01, 08-08) | 24 | **12** (10 ventes, 2 achats) | 12/12 |
| [08-01, fin de fenêtre] | 25 | 13 | **13/13 — tous** |

Les chiffres du brief sont reproduits exactement : 24 ordres dans la semaine, **12 divergents dont 10
ventes**. Tous les 13 divergents, cycle 1163 compris, sont interdits par la règle.

### Les cas de référence

**C6 — cycle 1163** (BNB vendu sur une étiquette `range` alors que le brut était déjà `trend_up`,
run = 2) : **INTERDIT**. ✅

**Les six ventes BTC/ETH des cycles 1035, 1054 et 1067** — toutes montrées `reversal_down` alors que le
brut était déjà revenu en `range` : **6/6 INTERDITES**. ✅

| cycle | actif | montré | brut | run | verdict |
|-------|-------|--------|------|-----|---------|
| 1035 | BTC | reversal_down | range | 1 | INTERDIT |
| 1035 | ETH | reversal_down | range | 1 | INTERDIT |
| 1054 | BTC | reversal_down | range | 2 | INTERDIT |
| 1054 | ETH | reversal_down | range | 2 | INTERDIT |
| 1067 | BTC | reversal_down | range | 1 | INTERDIT |
| 1067 | ETH | reversal_down | range | 1 | INTERDIT |

### ⚠ Le cycle 1061 contredit le brief

Le brief affirme que les achats du cycle 1061 sur BTC et ETH sont de bonnes décisions qui **doivent
passer**. Sous le contrat tel que spécifié, **elles ne passent pas** : 0/3 autorisées.

| cycle | actif | montré | brut | run | verdict |
|-------|-------|--------|------|-----|---------|
| 1061 | BTC | reversal_down | reversal_down | 2 | INTERDIT |
| 1061 | ETH | reversal_down | reversal_down | 2 | INTERDIT |
| 1061 | BNB | reversal_up | trend_up | 2 | INTERDIT |

Ce ne sont pas des divergences brut/montré : sur BTC et ETH les deux étiquettes **concordent** sur
`reversal_down`. Ce qui les bloque est le **point 4**. La trace brute le montre sans ambiguïté :

```
BTC, autour du 2026-08-03 10:10
  2026-08-02 00:00  raw range          active reversal_down  run 1  FROZEN
  2026-08-02 04:00  raw range          active reversal_down  run 2  FROZEN
  2026-08-02 08:00  raw reversal_down  active reversal_down  run 1  FROZEN
  2026-08-02 12:00  raw reversal_down  active reversal_down  run 2  FROZEN
  2026-08-02 16:00  raw range          active reversal_down  run 1  FROZEN
  2026-08-02 20:00  raw range          active reversal_down  run 2  FROZEN
  2026-08-03 00:00  raw reversal_down  active reversal_down  run 1  FROZEN
  2026-08-03 04:00  raw reversal_down  active reversal_down  run 2  FROZEN  ← la bougie lue par le cycle
  2026-08-03 08:00  raw reversal_down  active reversal_down  run 3  actionnable
```

ETH est identique bougie pour bougie. Le brut a alterné `range` / `reversal_down` par paires pendant
une journée entière — un scintillement de manuel — et le cycle 1061 est tombé sur `run = 2`, à **une
bougie** de la confirmation.

**Les deux exigences du brief sont incompatibles sur cette bande.** Le point 4 est ce qui rend le
critère causal : sans lui, décider de l'actionnabilité de la bougie courante exigerait de savoir si le
retour va durer trois bougies, c'est-à-dire de lire l'avenir. On ne peut pas garder la causalité et
laisser passer 1061 ; le même compteur produit les deux effets.

La bonne nouvelle, mesurée : **le coût est de 4 heures**. La bougie suivante (08:00) est actionnable, et
le cycle qui la suit aurait pu acheter. 1061 n'est pas annulé, il est décalé d'une bougie. C'est ce que
la ligne « la règle retarde, elle n'annule pas » chiffre sur les 16 ordres.

**Ceci est une décision de cadrage à trancher, pas une chose à corriger en silence.** Trois options,
sans recommandation de ma part parce que c'est un arbitrage de mandat :

1. **Garder le contrat tel quel.** 1061 est décalé de 4 h. Simple, causal, une seule règle.
2. **Rouvrir l'actionnabilité quand brut == confirmé**, quelle que soit la longueur du run. Laisse
   passer 1061, et laisse aussi passer chaque scintillement d'une bougie vers l'ancien régime —
   c'est-à-dire vide le point 4 de sa substance.
3. **Distinguer le sens.** N'interdire que les ordres qui *aggravent* la position dans le sens du
   régime périmé. 1061 est un achat sur `reversal_down` : il va contre l'étiquette périmée, donc il ne
   peut pas être un artefact de lecture de cette étiquette. Plus fin, mais introduit une notion de sens
   que le contrat n'a pas aujourd'hui, et demande sa propre mesure.

---

## 4. Bloc C — calibration du stop au pic

### Contrat implémenté

Exactement celui du brief, sans aucune latitude : armé **uniquement** pendant une transition
collante ; lit **uniquement** le prix courant et `peak_price_since_entry` ; seuil en configuration
(`PEAK_STOP_THRESHOLDS`, jamais choisi par le modèle) ; déclenchement = sortie **complète et unique** ;
aucune réentrée tant que la transition n'est pas confirmée ; prix ou pic absent ou périmé → **aucun
ordre**, jamais de valeur de remplacement.

Sur les 61 jours, les abstentions pour donnée manquante sont **4** (prix absent ou périmé), zéro pour
régime manquant, zéro pour pic manquant.

### Ce que la mesure est, et ce qu'elle n'est pas

Le stop est une **surcouche fantôme** : chaque déclenchement est évalué sur le chemin de prix observé,
et la bande réelle n'est jamais réécrite. La réécrire changerait chaque livre montré au modèle par la
suite, et seul un re-run du modèle pourrait dire ce qu'il aurait alors décidé — ce que ce harness
refuse de faire, pour la raison que le replay de régime donne déjà : un backtest ne peut pas répondre
honnêtement à « le modèle aurait-il pris ses bénéfices ».

Le contrefactuel n'a donc **aucun paramètre libre** : vendre toute la ligne au prix du cycle
déclencheur, payer les frais, la racheter au premier cycle où l'actif redevient actionnable, payer les
frais une deuxième fois. « Net » = valeur de la ligne à l'instant de la réentrée, stoppée moins tenue.
Les ordres réels qui atterrissent sur une ligne pendant que le fantôme la tient en cash sont comptés et
publiés (colonne `stranded`) : c'est la taille de la divergence entre les deux mondes, chiffrée plutôt
que supposée.

### La base de calibration : drawdown observé **pendant un gel**

Indépendant de tout seuil, donc la seule partie du bloc C qu'aucun choix de paramètre ne peut déformer.

| actif | asset-cycles gelés | pire | p99 | p95 | p90 | médiane | ≤5 % | ≤8 % | ≤10 % | ≤12 % |
|-------|--------------------|------|-----|-----|-----|---------|------|------|-------|-------|
| BTC | 337 | −12,0 % | −11,4 % | −9,7 % | −8,1 % | −4,5 % | 118 | 35 | 13 | **0** |
| ETH | 325 | −15,5 % | −15,3 % | −14,4 % | −13,5 % | −5,0 % | 156 | 68 | 63 | 48 |
| BNB | 362 | −13,0 % | −12,6 % | −12,1 % | −11,3 % | −8,9 % | 275 | 228 | 95 | 22 |
| XRP | 222 | −19,5 % | −19,1 % | −18,5 % | −17,9 % | −13,8 % | 168 | 148 | 141 | 129 |

Les points de repère du brief sont cohérents avec cette table (BTC jusqu'à ~−11,5 %, ETH jusqu'à
~−14,9 %). Le fait décisif est la colonne de droite : **à 12 %, le stop est mort sur BTC** — zéro
asset-cycle gelé n'atteint ce seuil sur 61 jours. Un seuil qui ne peut structurellement pas protéger
l'actif le plus lourd du portefeuille n'est pas un stop, c'est une décoration.

À l'autre bout, la médiane du drawdown gelé est de −4,5 % sur BTC et −5,0 % sur ETH : **un seuil à 5 %
sort sur la moitié des gels**, c'est-à-dire sur des retracements parfaitement ordinaires.

### Les quatre seuils, côte à côte

| seuil | sorties | résolues | net | frais | baisse évitée | rebond 24 h | rebond 72 h | max hors marché | moy. hors marché | ordres échoués |
|-------|---------|----------|-----|-------|---------------|-------------|-------------|-----------------|------------------|----------------|
| 5 % | 17 | 17 | +10,75 $ | 5,18 $ | −1,9 % | −0,5 % | −0,3 % | 22,3 h | 9,6 h | 1 |
| 8 % | 8 | 8 | +5,43 $ | 2,14 $ | −1,4 % | −0,6 % | 0,0 % | 11,9 h | 8,6 h | 1 |
| **10 %** | **5** | **5** | **+11,83 $** | **1,42 $** | **−2,8 %** | −0,7 % | −1,0 % | 11,9 h | 9,2 h | 1 |
| 12 % | 3 | 3 | +0,68 $ | 0,77 $ | −1,0 % | −0,6 % | −0,5 % | 10,3 h | 7,8 h | 0 |

*baisse évitée* = plus bas coté entre la sortie et la réentrée, en % du prix de sortie (plus négatif =
plus de baisse esquivée). *rebond 24 h / 72 h* = prix 24 h / 72 h après la sortie, en % du prix de
sortie (positif = un rebond que le stop a manqué). Équité au dernier cycle : 1025,87 $.

### Robustesse — le total est-il porté par un seul épisode ?

C'est la question que pose explicitement le brief (« le seuil retenu sera celui qui améliore le
résultat net sur tout le replay, pas celui qui protège le mieux un épisode »). Elle a une réponse
franche, et elle disqualifie deux seuils sur quatre.

| seuil | net | % équité | meilleur épisode | net **sans** le meilleur | épisode médian | taux de réussite |
|-------|-----|----------|------------------|--------------------------|----------------|------------------|
| 5 % | +10,75 $ | 1,05 % | +10,13 $ | **+0,61 $** | +0,14 $ | 10/17 |
| 8 % | +5,43 $ | 0,53 % | +7,89 $ | **−2,46 $** | +0,04 $ | 5/8 |
| **10 %** | **+11,83 $** | **1,15 %** | +10,13 $ | **+1,70 $** | +0,71 $ | 3/5 |
| 12 % | +0,68 $ | 0,07 % | +0,76 $ | **−0,08 $** | +0,71 $ | 2/3 |

À 8 % et à 12 %, retirer le seul meilleur épisode fait passer le total en négatif. Ces deux seuils ne
sont pas des calibrations, ce sont des anecdotes avec un signe pourcentage.

---

## 5. Recommandation : **10 %**

Argumentée sur quatre points, dans l'ordre de leur poids.

1. **C'est le seul seuil qui survit au retrait de son meilleur épisode tout en gardant le meilleur
   total.** +11,83 $ brut, +1,70 $ sans l'épisode ETH du 25 juin. 5 % survit aussi (+0,61 $) mais pour
   un total inférieur ; 8 % et 12 % basculent en négatif.
2. **C'est le seuil le plus profond qui reste vivant sur les quatre actifs.** À 12 %, BTC n'atteint
   jamais le déclencheur (0 asset-cycle gelé sur 337). À 10 %, les quatre actifs sont couverts
   (BTC 13, ETH 63, BNB 95, XRP 141 asset-cycles gelés atteignant le seuil).
3. **Il attrape ce qu'il faut attraper et rien d'autre.** 5 sorties en 61 jours contre 17 à 5 %, pour
   1,42 $ de frais contre 5,18 $, et une baisse moyenne évitée nettement supérieure (−2,8 % contre
   −1,9 %). À 5 % le stop sort sur des retracements ordinaires : la médiane du drawdown gelé est
   de −4,5 % sur BTC et −5,0 % sur ETH, donc il déclencherait sur la moitié des gels.
4. **Le coût d'exposition est faible et borné.** 0,50 % d'équité·cycles non portée, contre 1,87 % à
   5 %. Durée maximale hors marché 11,9 h, moyenne 9,2 h — bien en deçà des 44 h du plus long gel,
   parce que le stop ne s'arme que tard dans un gel et que la réentrée suit la confirmation.

### Ce que la recommandation ne prétend pas

**L'effet reste petit et l'échantillon est mince.** +1,15 % d'équité sur 61 jours, sur **5 épisodes**,
dont trois concentrés autour de la baisse du 25 juin. Ce n'est pas une source de rendement et il ne
faut pas le vendre comme telle. La valeur du stop est de **borner le risque de queue pendant un gel**,
c'est-à-dire de rendre acceptable une règle qui peut empêcher toute réduction de position pendant
44 heures. Sur cette bande, ce bornage est gratuit — il ne coûte pas de performance. C'est le résultat
utile, pas le +11,83 $.

**Le seuil est proposé uniforme.** La table de drawdown gelé suggère qu'une calibration par actif se
défendrait (XRP a une médiane gelée de −13,8 %, BTC de −4,5 % : le même seuil ne dit pas la même chose
sur les deux). Le contrat prévoit déjà « par actif ou par classe de volatilité ». Je ne l'ai pas
calibré par actif ici : avec 5 épisodes au total, découper par actif produirait un à deux épisodes par
seuil, ce qui n'est plus une mesure. À refaire quand le corpus aura doublé.

---

## 6. Limites, énoncées

- **Pas de contrefactuel d'équité complet.** La bande n'est pas réécrite, donc les blocs B et C ne
  disent pas ce que le portefeuille *aurait* valu. Ils disent quels ordres tombent, ce que le délai
  coûte à l'exécution, et ce que chaque épisode de stop rapporte au niveau de la ligne. Aller plus loin
  demanderait de re-run le modèle 1079 fois, ce qui produirait un nombre non déterministe auquel
  personne ne devrait faire confiance.
- **Un seul régime de marché.** 61 jours, une baisse marquée (25 juin) et une hausse (première semaine
  d'août). Rien ici ne dit comment la règle se comporte dans un marché durablement directionnel.
- **`stranded` = 1 à 5 %, 8 % et 10 %.** Un ordre réel a atterri sur une ligne que le fantôme tenait en
  cash. La divergence entre les deux mondes est donc réelle mais minuscule sur cette bande.
- **Trois épisodes de stop n'ont pas de « baisse évitée »** : leur durée hors marché est inférieure à
  une bougie 4h, donc aucune bougie close ne tombe dans l'intervalle. Reportés comme `—`, jamais
  comblés.

---

## 7. Ce qui reste à trancher avant toute implémentation

1. **Le cycle 1061** (§3). Point 4 tel quel, réouverture sur brut == confirmé, ou distinction par sens.
   C'est un arbitrage de mandat, pas une question technique.
2. **Le régime global `risk_off`** a lui aussi une hystérésis, et ce contrat ne le touche pas. Sur cette
   fenêtre l'override ne s'est jamais armé en production, donc la question ne s'est pas posée — mais
   elle se posera.
3. **Le stop et le modèle.** Le contrat dit « aucune réentrée tant que la transition n'est pas
   confirmée ». Une fois confirmée, c'est le modèle qui décide de rentrer ou non. La mesure ci-dessus
   suppose une réentrée automatique au même notionnel, ce qui est le contrefactuel neutre, pas le
   comportement proposé.
