# Les témoins du pilote — rejeu officiel réparé, et ce qu'il dit au 17/09

Rejeu hors ligne, lecture seule, des trois livres chaînés sur la fenêtre officielle du pilote
d'exposition. Reproduire : `npm run replay:band-witnesses`. Huit critères tri-valués (`PASS`,
`FAIL`, `NON MESURABLE`), sortie non nulle sur un `FAIL`.

**Ce rapport ne contient aucun chiffre de rendement, aucun drawdown, aucun écart bot-témoin.**
Il sépare trois choses qu'un rapport précédent avait confondues : ce que le bot a **réellement**
fait, ce qu'un bot corrigé **chaîné** aurait envoyé, et ce que le modèle **fait** de la position
imposée.

Fenêtre : activation au cycle 1839 (06/09, 1 077,10 $), point d'arrêt prouvé complet 2081
(17/09). 239 cycles reconstruits en un segment, aucun trou. Entrée de B̂ : journal sur les 239.

---

## Ce qu'il faut lire en premier

**Le rapport précédent était trompeur, et ses huit critères verts ne disaient rien de la
correction.** B̂ recevait `decisions.applied_allocation`, qui est depuis l'activation
l'allocation **déjà corrigée** par la bande. Il corrigeait donc une cible corrigée : rien à
faire sur 239 cycles, zéro jambe de bande, et les achats BNB et ETH que la bande a faits au
cycle 1839 attribués au modèle. W5 et W6 étaient codés pour réussir, W4 passait à vide, C8 ne
lisait aucune donnée réelle.

**E, P et W0 à W3 n'ont pas bougé** : leurs lignes sont byte-identiques entre l'ancien et le
nouveau rejeu.

---

## 1. Faits réels — le journal des corrections de production

Source : `exposure_band_corrections`, par cycle et par actif, `planned_side` / `booked_side`.

| | |
|---|---|
| jambes de bande **prévues** | 12, sur 11 cycles |
| jambes de bande **exécutées** | **4, sur 3 cycles** |
| prévues **non passées** | 8 |

Les quatre exécutées :

| Cycle | Ligne | Origine | Sens | Booké | Le modèle demandait | La bande a imposé |
|---|---|---|---|---|---|---|
| 1839 | BNB | `allocation_de_secours` | achat | 163,67 $ | 0 | 15 |
| 1839 | ETH | `allocation_de_secours` | achat | 164,04 $ | 0 | 15 |
| 1922 | ETH | `correction_de_bande` | vente | 66,49 $ | 10 | 9 |
| 1951 | BTC | `correction_de_bande` | vente | 22,13 $ | 10 | 8,75 |

Les huit non passées sont toutes des ventes BTC de −1,25 pt, entre 21,13 et 21,56 $ (cycles
1926, 1928-1931, 1944, 1945, 1950), sans **aucune** ligne d'exécution. La seule voie de
l'exécuteur qui ne journalise rien est le seuil après arrondi au pas de la place ; le rapport
l'écrit comme une **déduction**, jamais comme un fait journalisé.

---

## 2. Contrefactuel B̂ — C7, ce que la répartition envoie en chaîne

B̂ part du **livre réel du bot** au cycle 1839, reçoit à chaque cycle l'**intention bornée du
modèle** (`clamped_weight_percent` du journal, comparée au clamp recalculé sur 238 cycles :
identiques), applique la bande sur son propre livre et hérite des gels. Il suit le bot réel
sans corriger sur un seul cycle, 2051, où le stop du code a pris une ligne.

| | Ancien rejeu | Nouveau rejeu |
|---|---|---|
| entrée de B̂ | `applied_allocation` (corrigée) | intention du modèle (journal) |
| ouverture de B̂ | en cash | livre réel du bot |
| cycle 1839 | `aucune_correction`, cible 45, 3 jambes **modèle** | `hausse_vers_plancher`, modèle 15 → 45, **BNB et ETH 164,18 $ chacune, bande** — le notional prévu par la production au centime |
| jambes de B̂ par origine | modèle 16 | secours 2 · correction 2 · modèle 11 |
| cycles où B̂ envoie | 14 | 14 |
| frais cumulés de B̂ | 1,41 $ | 1,25 $ |

Les jambes de bande de B̂ : 1839 BNB et ETH (identiques au réel), 1922 ETH vente 66,70 $
(réel 66,49 $), **1926 BTC vente 21,55 $** — que l'exécuteur réel a écartée. B̂ ne porte pas
l'arrondi au pas de la place, il exécute ce que sa plomberie accepte ; le bot réel n'a passé
cette vente qu'au cycle 1951. À partir de là les deux livres divergent, ce qui est exactement
ce qu'un contrefactuel chaîné doit faire.

W4 a désormais une population : **27 cycles** de B̂ combinent une ligne gelée et un mouvement
de bande, zéro jambe de bande sur une ligne gelée ; 385 lignes `gel` du journal réel, aucune
déplacée par la bande.

**Hypothèse affichée** : B̂ rejoue des intentions historiques figées contre un livre que le
modèle n'a jamais vu. Il mesure la conséquence mécanique de la correction, ni la réaction du
modèle, ni une borne de performance.

---

## 3. Mesure C8 — non concluante, et c'est le résultat honnête

Unité : l'**épisode exécuté par actif**. Réaction : la proposition brute du modèle au premier
cycle **décidé** suivant. Lecteur orienté, répétition lue d'abord.

| Épisode | Direction | Demandé → imposé (tenu) | Réaction | Lecture |
|---|---|---|---|---|
| 1839 BNB | hausse | 0 → 15 (15,20) | 1840 : 15 | `maintien` |
| 1839 ETH | hausse | 0 → 15 (15,23) | 1840 : 15 | `maintien` |
| 1922 ETH | baisse | 10 → 9 (9,01) | 1923 : 10 | `repetition` |
| 1951 BTC | baisse | 10 → 8,75 (8,75) | 1952 : 10 | `repetition` |

Quatre épisodes, quatre lectures, **aucun verdict** : la fenêtre de mesure est ouverte, et le
juge W6 refuse d'en publier un — c'est une de ses conditions d'échec. Deux `maintien` à la
hausse depuis une proposition initiale à zéro, deux `repetition` à la baisse où le modèle
redemande ses 10 — que l'ancien lecteur aurait appelées « adoption ».

**Le biais, nommé** : le prompt montre au modèle l'allocation corrigée sous l'étiquette
`risk_clamp`, figée pendant le pilote. Un `maintien` décrit la réaction du modèle au
portefeuille corrigé ; il ne prouve pas une adoption consciente de la bande d'exposition.

---

## Ce que les critères peuvent maintenant faire

| Critère | Population sur la fenêtre | Échoue quand |
|---|---|---|
| W4 | 27 cycles gel + bande, 385 lignes `gel` réelles | une jambe de bande touche une ligne gelée, dans B̂ ou dans le journal |
| W5 | 4 jambes de bande, 238 contrôles de clamp | entrée ≠ journal en fenêtre officielle, clamp divergent, attribution incohérente, 1839 non conforme |
| W6 | 4 épisodes exécutés | lecture contredisant ses nombres, réaction lue au mauvais cycle, épisode non booké, verdict officiel sur fenêtre ouverte |

Sans population, chacun répond `NON MESURABLE`, jamais `PASS`. Preuve 13 de
`src/test/exposureWitness.ts` fait échouer chacun sur fixture.

---

## Ce que ce rapport ne conclut pas

Ni que la bande A est bonne, ni que le modèle l'adopte. Quatre épisodes ne sont pas une
mesure ; le lecteur est prêt et le verdict attend la clôture officielle de la fenêtre. Il
conclut que **l'intervention observée correspond au mécanisme annoncé** — sur les faits réels,
sur le contrefactuel et sur le lecteur — et que le rapport précédent ne le vérifiait pas.
