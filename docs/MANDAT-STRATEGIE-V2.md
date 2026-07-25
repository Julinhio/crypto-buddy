# Mandat Stratégie V2 — Crypto-Buddy

Spec de **comportement**, pas d'implémentation. Décrit ce que le bot doit décider et sur quelles bases. Le comment reste au dev.

Version consensuelle Claude + GPT, 25/07/2026. Considérée prête pour le brief dev.

---

## Constat qui motive la V2

Mesuré sur les 47 jours d'observation testnet, du 08/06 au 25/07.

- 787 décisions valides, dont **785 hold**. Deux rebalance, le dernier le 15/06.
- **Trois allocations cibles distinctes en 47 jours.** Seuls ETH et le cash ont bougé, de 1 point à la fois. BTC 25, BNB 12, XRP 8 n'ont jamais bougé.
- **Environ 3128 intents générés, 99,5% rejetés.** Motifs : quantité écrasée à zéro au lot step, ou notional sous les 5 dollars du minimum Binance.
- 15 ordres réels en tout. Quatre le premier jour pour déployer le capital, puis 11 mouvements entre 5 et 7 dollars, tous sous une décision hold.
- **Le marché n'était pas plat.** Amplitude vue par le bot : ETH 27,6% (1527 à 1948), XRP 26,4% (1,017 à 1,286), BNB 16,2%, BTC 15,1%.
- Résultat : 1000 vers 1018,75, soit **+1,88%**, drawdown max -9,97%. C'est à peu près exactement l'allocation du jour 1 achetée puis oubliée.
- 4,47 millions de tokens consommés pour ça. Sonnet 4.6 actif depuis le 08/06, donc le modèle n'est pas en cause.
- **Le clamp n'a jamais déclenché, zéro fois sur 786 décisions.** Les plafonds et le plancher de cash n'ont jamais été effleurés.

Diagnostic : le bot applique correctement un mandat qui fabrique l'immobilisme. Le problème est stratégique, pas technique.

---

## Ce qui ne change pas en V2

- **Plancher de cash à 30%, sacré.** Plafonds par actif inchangés : BTC 35, ETH 35, BNB 20, XRP 15, indépendants.
- **L'IA propose, le code dispose.** L'allocation cible reste le contrat avec l'exécuteur.
- Testnet. Aucun argent réel dans cette version.
- Univers à 4 devises tradables, SOL en référence.

Raison de garder les garde-fous : ils n'ont jamais été approchés en 47 jours. On peut rendre le bot beaucoup plus offensif sans élargir d'un pouce son risque maximum.

---

## 1. Le régime est calculé par le code, et par actif

Aujourd'hui le `market_state` est déclaré par le modèle. Il a produit **2 valeurs distinctes en 47 jours** et est resté sur `risk_off` pendant que ETH prenait 27% depuis son plus bas. Cette classification était fausse.

Donc le régime est **calculé dans le code**, depuis les indicateurs déjà disponibles (position vs SMA50 et SMA200, RSI14, EMA21, amplitude et distance aux extrêmes du mois, plus l'horizon 4h du point 2). Il arrive au modèle comme un **fait établi**. Le modèle décide à l'intérieur du régime, il ne le déclare pas.

**Un régime tactique PAR ACTIF tradable.** Un régime global unique reproduirait l'aveuglement actuel sous forme déterministe. Sur la période observée ETH fait +11,4% et BNB -5,5%, une seule étiquette ne peut pas décrire les deux.

États directionnels non ambigus, un par actif :

`range`, `trend_up`, `trend_down`, `reversal_up`, `reversal_down`

**`risk_off` est un override global, prioritaire, pas une catégorie concurrente des autres.** C'est une posture de portefeuille, pas une structure de prix. Quand il est actif il prend le pas sur les régimes par actif.

**Hystérésis obligatoire.** Un changement de régime demande une confirmation minimale, sinon on bascule à chaque bougie 4h et on remplace l'immobilisme par du bruit.

Le régime retenu par actif, et l'override global, sont journalisés à chaque décision pour pouvoir les auditer.

---

## 2. Deux horizons temporels

- **Journalier** : la structure et le régime de fond.
- **4 heures** : le timing tactique. RSI, EMA21, position dans le range 4h récent.

Raison : réveiller Sonnet toutes les 2 heures avec des indicateurs quasi exclusivement journaliers ne peut produire que des répétitions. Le RSI journalier de BTC se déplace de 0,2 point entre deux réveils. Le raisonnement recopié mot pour mot n'est pas une faiblesse du modèle, c'est la seule réponse honnête à une question identique.

---

## 3. Playbooks par régime

**Range first**, mais pas range only. Les données justifient de commencer par le range, pas de s'y enfermer.

- **range** : accumuler dans les zones basses, alléger dans les zones hautes. L'aller-retour est l'objectif, pas un effet de bord.
- **trend_up** : conserver ou renforcer, protéger les gains par un trailing sur `peak_price_since_entry`. Pas de retour systématique à une allocation plate.
- **trend_down** : réduire franchement l'exposition sur cet actif. Le cash est une position, pas un résidu.
- **reversal_up** et **reversal_down** : rotation entre actifs, plutôt que retour à la même allocation.
- **risk_off (override global)** : réduction d'exposition sur l'ensemble, prioritaire sur les régimes par actif.

Garde de sortie : le playbook range se désactive dès qu'un actif quitte le range pour une tendance ou casse sa structure.

---

## 4. Cycle de vie par position

États : `accumulation`, `renforcement`, `maintien`, `allègement partiel`, `sortie`.

### Séparation stricte des propriétaires de l'état

**État détenu par le CODE, actualisé à chaque cycle :**

- `entry_date` : date de la **plus récente** transition de zéro vers positif
- `peak_price_since_entry` : **plus haut PRIX UNITAIRE** observé depuis l'entrée
- `last_significant_move` : date, sens, taille du dernier mouvement significatif
- prix moyen et P&L latent (déjà disponibles aujourd'hui)

**État rédigé par le MODÈLE :**

- la thèse en vigueur
- ses conditions d'invalidation

**La thèse persiste sur un hold.** Elle n'est réécrite que lors d'une décision significative, ou d'un remplacement explicite. Sinon on recrée 787 reformulations inutiles du même paragraphe.

### Définitions figées

- **Entrée** = la **plus récente** transition de zéro vers positif. Pas la première de l'histoire de la table : une ligne soldée puis rachetée redémarre une nouvelle vie.
- **`peak_price_since_entry`** = plus haut prix unitaire depuis l'entrée. **Un prix, jamais une valorisation de position.** Après un allègement de 50% la valorisation tombe de moitié à prix constant, un trailing branché sur la valorisation déclencherait une sortie sur un drawdown fictif.
- Le peak n'est **pas réinitialisé** par un renforcement ni par un allègement partiel. Il est réinitialisé **uniquement après une sortie totale**.
- Un **allègement partiel ne réinitialise pas la thèse**.
- **Prix moyen** = moyenne pondérée des achats, inchangée par les ventes.

**C'est de l'état, donc c'est stocké et écrit à chaque cycle. Jamais reconstruit à l'exécution.** C'est le piège payé en juin avec les snapshots V2, on ne le refait pas.

C'est la brique la plus lourde, elle touche le schéma, et c'est celle qui débloque réellement la prise de bénéfices.

---

## 5. Taille des mouvements

Deux seuils, de nature différente, donc ils ne peuvent pas se contredire.

**Seuil de plomberie (code, dur).** Tout mouvement sous **2% du capital** est écarté avant d'atteindre l'exchange. Environ 20 dollars aujourd'hui, soit 4 fois le minimum Binance. Supprime les 3128 déchets.

**Norme stratégique (mandat, donnée au modèle).** Une vraie décision déplace **au moins 2% du capital ET au moins 25% de la position touchée**. La contrainte la plus mordante gagne.

Pourquoi la double condition plutôt que "5% du capital sauf petite position" : XRP pèse 82 dollars sur un book de 1019. 5% du capital font 51 dollars, soit 62% de la position, ce n'est pas un allègement mais une liquidation. L'exception taillée pour les petites lignes se rouvrirait au prochain actif ajouté. La double condition ferme la classe pour les 4 actifs actuels et tous les futurs.

Tailles produites par la règle des 25% sur les positions actuelles : XRP environ 20 dollars, BNB 30, ETH 55, BTC 63. C'est exactement la granularité recherchée.

**La sortie totale d'une position est toujours permise**, quels que soient les seuils.

**Comportement attendu sur les petites lignes, à ne pas prendre pour un bug.** XRP à 20,5 dollars frôle le plancher de plomberie à 20,4. Si une ligne devient assez petite, les deux conditions se croisent et l'allègement partiel devient impossible sur cette ligne, il ne reste que la sortie totale. C'est cohérent et voulu. Ne pas le "corriger" plus tard en croyant à une régression.

**Cible tactique mobile** : le modèle doit pouvoir déplacer l'allocation cible de **5 à 10 points**, contre 1 point sur 47 jours aujourd'hui. Mettre un actif à zéro est un mouvement légitime.

---

## 6. La mémoire change de nature

**Retiré** : l'injection des 5 dernières décisions. Ce sont 5 hold identiques, servis à un mandat qui réclame la cohérence avec le passé. C'est un ancrage, on montrait au bot son immobilisme comme une preuve.

**À la place** : la dernière décision **significative** (pas le dernier réveil), la thèse active par position, ses conditions d'invalidation, et ce qui a réellement changé depuis.

**Retiré du mandat** : "ne rien faire est l'option par défaut" et "agit peu mais agit bien". Ne rien faire reste légitime quand rien ne justifie d'agir, mais ça cesse d'être le cadrage par défaut.

**Conservé, mais reformulé** : pas de yo-yo sans information nouvelle. La cohérence est désormais attendue **avec la thèse**, pas avec la dernière action.

---

## 7. Pas de quota de trades

L'objectif est de faire des mouvements **plus francs quand une opportunité existe**, pas de trader pour animer le dashboard. Aucune cible de nombre de trades, ni plancher ni plafond.

**Vocabulaire** : un ordre de 50 dollars n'est pas un bénéfice de 50 dollars. Le mandat ne promet aucun montant par trade. En revanche chaque allègement journalise le bénéfice réellement matérialisé.

---

## 8. Preuve et activation progressive

Le replay n'est pas une brique finale, c'est un **critère d'acceptation**. On ne valide pas un calculateur de régime après avoir construit tout ce qui repose dessus.

**Ce qu'on rejoue** : la couche **déterministe** sur les 47 jours collectés.

**Ce qu'on ne rejoue pas** : les décisions du LLM. Relancer Sonnet 787 fois coûte cher, n'est pas déterministe, et un backtest ne peut pas répondre honnêtement à la question "le modèle aurait-il pris ses bénéfices".

**Données disponibles** : 47 jours d'indicateurs journaliers déjà présents dans `decisions.market_context`, et les bougies 4h récupérables sur Binance public pour la même fenêtre.

### Le harness est introduit en PR 1 et réutilisé en PR 2, avec des preuves distinctes

**Critères portés par la PR 1**, régime uniquement :

- le régime qualifie la montée d'ETH depuis 1527 autrement que `risk_off`
- ETH et BNB ne portent pas la même étiquette sur la période où l'un monte et l'autre baisse
- l'override global `risk_off` est bien prioritaire sur les régimes par actif
- l'hystérésis empêche un changement de régime à chaque bougie 4h

**Critère porté par la PR 2**, seuil de plomberie, en réutilisant le même harness :

- aucun mouvement planifié sous 2% du capital n'atteint le journal d'exécution

La plomberie de seuil n'existe pas en PR 1, elle ne peut donc pas y être prouvée.

**Shadow mode.** Après validation du replay, le calculateur de régime tourne en production et journalise, **sans influencer le bot**. On accumule du régime en conditions réelles pendant qu'on construit le reste. Le prompt v5 n'est activé qu'après validation du régime, du filtre de plomberie et de l'état de position.

---

## 9. Activation de la V2 sur le portefeuille existant

**Pas de reset.** On conserve les 47 jours, ils servent au replay. On journalise une date d'activation V2 et les versions de régime et de prompt.

**Backfill unique de `peak_price_since_entry`.** Ce backfill ponctuel ne contredit pas la règle "jamais reconstruire à l'exécution", il initialise un état une seule fois.

Deux règles impératives, parce que le bot continue de tourner pendant tout le développement de la V2 :

1. **Le peak se calcule au moment réel de la migration**, depuis l'historique disponible à cet instant. Aucune valeur n'est écrite en dur.
2. **L'historique remonte à la dernière transition de zéro vers positif de chaque position**, pas au début de la table. Le bot actuel peut encore solder une petite ligne avant la bascule, et un actif ressorti puis racheté hériterait sinon d'un peak d'une vie antérieure.

Valeurs observées au 25/07, lues depuis `decisions.market_context`. **Illustratives uniquement**, elles servent de preuve de faisabilité et d'ordre de grandeur. Elles auront bougé à la migration.

| Actif | peak observé au 25/07 | Prix au 25/07 | Écart au peak |
|---|---|---|---|
| BTC | 67 234,06 | 64 024,07 | -4,8% |
| ETH | 1 948,37 | 1 856,38 | -4,7% |
| BNB | 630,00 | 564,51 | -10,4% |
| XRP | 1,2856 | 1,0884 | -15,3% |

**Conséquence à assumer, et c'est important.** À l'activation, il est probable que la plupart des lignes soient loin de leur plus haut, et XRP était à -15,3% au moment de la rédaction. Le bot hérite d'un portefeuille qui a déjà raté ses sorties.

**Décision : on backfille le vrai peak historique, on ne le remet pas à zéro à la date d'activation.** Repartir du prix d'activation masquerait un drawdown réel et reviendrait à mentir au bot sur son propre passé.

**Mais aucune liquidation de rattrapage n'est déclenchée par l'activation.** Si le bot décide d'alléger XRP à son premier réveil en v5, c'est une décision légitime évaluée par les règles normales, pas un artefact de bascule.

---

## 10. Évaluation de la V2

À comparer au buy-and-hold observé sur la même période, pas dans l'absolu :

- P&L **réalisé** (et pas seulement latent)
- rendement total
- drawdown maximum
- **frais cumulés**

Ordre de grandeur des frais, pour calibrer : à 0,1%, un mouvement de 50 dollars coûte 5 centimes. Un bot à 40 mouvements par mois paie environ 2 dollars, soit 0,2% mensuel de frottement sur un book de 1000. Acceptable, mais présent dans la comparaison dès le départ.

---

## 11. Hors périmètre V2

- **Plancher de cash dynamique.** Différé avec argument : le clamp n'a jamais déclenché en 786 décisions, donc le plancher n'est pas le goulot. Et piloter le seul garde-fou dur du système avec un classificateur de régime qui vient d'avoir tort 46 jours d'affilée n'est pas un mouvement de V1. À revoir si on observe le bot collé contre le plancher, avec une preuve au lieu d'une hypothèse.
- **Réduction de l'univers.** On garde les 4 devises. L'univers est un ensemble d'opportunités, pas l'obligation de tenir 4 lignes. La V2 peut déjà mettre un actif à zéro et concentrer tactiquement. Retirer un actif ajouterait une deuxième variable au test de la stratégie.
- Analyst IA. Inchangé, V2+.
- Argent réel. Les deux gardes qui restaient tiennent toujours : rate-limit du login dashboard et test de concurrence sur `claim_due_run`.

---

## 12. Séquencement d'implémentation

Une PR par brique, dans cet ordre.

1. **Calculateur de régime par actif dans le code, plus horizon 4h injecté au contexte.** Aucune modification de schéma au-delà de la journalisation du régime. Critère d'acceptation = les preuves PR 1 du point 8. Puis shadow mode.
2. **Seuil de plomberie à 2% du capital.** Trivial, et supprime immédiatement 99,5% du bruit dans le ledger. Réutilise le harness de la PR 1.
3. **État de position** : table, écriture à chaque cycle, `peak_price_since_entry` et thèse. Inclut le backfill unique du point 9. La plus lourde, touche le schéma, prérequis de la prise de bénéfices.
4. **Réécriture du mandat, prompt v5.** Dépend de 1 et 3 en production, puisqu'elle référence le régime et l'état de position. Livrée derrière `STRATEGY_VERSION`, qui reste sur `v4` en production.

Raison de cet ordre : 1 et 2 sont indépendants et immédiatement visibles, 3 débloque la prise de bénéfices réelle, et 4 ne peut pas s'écrire sérieusement avant que ses entrées existent.

Le détail du chantier, les preuves attendues par PR, l'inventaire des accès et la condition d'arrêt sont dans `BRIEF-STRATEGIE-V2.md`.
