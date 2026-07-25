# Brief maître — Stratégie V2 crypto-buddy

Destiné à Claude Code Desktop, en mode `/goal`.

Compagnon obligatoire : `docs/MANDAT-STRATEGIE-V2.md`, qui décrit le comportement attendu. Ce brief décrit le chantier, ses preuves et ses garde-fous. Le mandat dit QUOI, ce brief dit dans quel ordre et comment on prouve.

Rédigé le 25/07/2026. Consensus Claude + GPT.

---

## Objectif en une phrase

Faire passer le bot d'une allocation statique qui n'a rien fait pendant 47 jours à une gestion active de positions avec prise de bénéfices, en 4 PR séquentielles, sans toucher aux garde-fous de risque et sans activer le nouveau comportement en production.

---

## Contexte minimum

Le bot tourne en autonomie sur Railway depuis le 06/06, cron 5 min, testnet, capital 1000 USD, 4 devises. Sur 47 jours il a produit 785 décisions `hold` sur 787, trois allocations cibles distinctes, 99,5% d'intents rejetés pour cause de taille sous le minimum Binance, et une performance égale au buy-and-hold. Le marché offrait pourtant 27,6% d'amplitude sur ETH et 26,4% sur XRP.

Le diagnostic complet et les causes sont dans le mandat. Ce n'est pas un bug, c'est un mandat qui fabrique l'immobilisme.

---

## Rails à ne pas casser

Non négociable, à vérifier avant chaque merge.

1. **Le plancher de cash à 30% et les plafonds par actif ne bougent pas.** BTC 35, ETH 35, BNB 20, XRP 15, indépendants. Aucune PR de ce chantier n'a de raison d'y toucher.
2. **L'IA propose, le code dispose.** L'allocation cible reste le contrat avec l'exécuteur. Le régime de marché est calculé par le code, jamais déclaré par le modèle.
3. **Aucune donnée de trading synthétique écrite dans la base vivante.** Les tables `decisions`, `executions`, `equity_snapshots` et `scheduler_runs` sont le registre d'observation du bot, elles servent de référence de comparaison pour la V2. Tout test qui aurait besoin d'écrire dedans passe par un mode sans persistance.
4. **Aucun effet de bord externe depuis un test.** Pas de Telegram, pas de ping Healthchecks, pas d'ordre testnet depuis un harness de test ou une probe.
5. **Testnet uniquement.** Aucun code de ce chantier ne touche à un compte réel.
6. **Migration avant déploiement**, toujours. Règle dure du projet.
7. **Le nouveau comportement de trading n'est PAS activé à la fin du goal.** Voir la section `STRATEGY_VERSION`.

---

## Le point qui change la façon de mener ce goal

Railway est branché sur le repo en mode Cron Schedule. **Chaque merge sur `main` redéploie le bot vivant.** Quatre PR mergées, c'est quatre déploiements sur un bot en production testnet, potentiellement sans personne devant l'écran.

Le séquencement rend les PR 1 à 3 inoffensives au merge : shadow mode, moins d'ordres inutiles, écriture d'état. La PR 4 changerait le comportement de trading au moment du merge, ce qui n'est pas acceptable dans un run non surveillé.

**Donc : le prompt v5 et les playbooks arrivent derrière une variable d'environnement `STRATEGY_VERSION`.** Son **absence vaut `v4`**, donc il n'y a rien à poser sur Railway pour rester en sécurité, et la variable ne doit PAS être créée par ce chantier. Le code livre la capacité et la prouve, Julien pose `v5` lui-même le jour où il décide d'activer. Merge et activation deviennent deux événements distincts.

Un `STRATEGY_VERSION` présent mais inconnu ou mal formé doit faire échouer le démarrage bruyamment, pas retomber silencieusement sur un défaut.

**Raison de ce choix, indépendante de tout accès** : le mode dangereux exige un opt-in explicite, et l'absence de configuration veut dire mode sûr. Si Railway perd ses variables un jour, le bot reste en `v4`. C'est strictement meilleur qu'une sécurité qui dépend d'une variable posée correctement.

**Classe de test exhaustive à couvrir**, plutôt que des cas au coup par coup :

| Valeur de `STRATEGY_VERSION` | Comportement attendu |
|---|---|
| absente | `v4` |
| `v4` | `v4` |
| `v5` | `v5` |
| toute autre valeur présente | échec bruyant au démarrage |

**Railway est en LECTURE SEULE pour ce chantier.** Le CLI est installé sur la machine, donc l'environnement est inspectable, et une vérification en lecture est bienvenue. Mais **ne jamais créer ni modifier `STRATEGY_VERSION`**, ni aucune autre variable. Une variable absente n'est pas un oubli à réparer, c'est la configuration voulue. L'activation de `v5` est une décision de Julien, pas une étape de ce chantier.

---

## PR 1 — Régime par actif et horizon 4h

### Périmètre

Calculer le régime de marché dans le code, par actif tradable, et enrichir le contexte d'un horizon 4 heures. Journaliser le résultat. **Ne rien changer au comportement de décision du bot.**

Le régime arrive au modèle comme un fait établi. États par actif : `range`, `trend_up`, `trend_down`, `reversal_up`, `reversal_down`. Plus un override global `risk_off`, prioritaire, qui est une posture de portefeuille et non une catégorie concurrente.

Hystérésis obligatoire : un changement de régime demande une confirmation minimale. Sans ça on remplace l'immobilisme par du bruit à chaque bougie 4h.

Inclut le **harness de replay**, réutilisé par la PR 2.

### Preuves attendues

Sortie du harness collée dans la conversation, montrant sur les 47 jours collectés :

- le régime d'ETH pendant sa montée depuis 1527 est autre chose que `risk_off`
- ETH et BNB ne portent pas la même étiquette sur la période où l'un monte et l'autre baisse
- l'override global `risk_off` est bien prioritaire sur les régimes par actif
- le nombre de changements de régime par actif sur la période, avec l'hystérésis active, reste dans un ordre de grandeur plausible et non un changement par bougie

Plus une requête Supabase montrant le régime journalisé sur les cycles postérieurs au déploiement, en shadow mode.

Le seuil de plomberie n'existe pas encore à ce stade, il n'est donc pas prouvé ici.

---

## PR 2 — Seuil de plomberie

### Périmètre

Tout mouvement planifié sous **2% du capital** est écarté avant d'atteindre l'exécuteur. Environ 20 dollars aujourd'hui, quatre fois le minimum Binance.

### Preuves attendues

- le harness de la PR 1 rejoué, montrant qu'aucun mouvement sous 2% du capital n'atteindrait le journal d'exécution
- une requête Supabase sur les cycles postérieurs au merge montrant **zéro intent rejeté pour taille insuffisante, les DEUX familles incluses** : `notional < minNotional` et `quantity snapped to zero at the lot step`

Repère de départ, pour mesurer l'effet : environ 3128 intents rejetés sur 3143 générés avant ce changement. La répartition compte, parce qu'un critère qui ne viserait que le notional laisserait passer la plus grosse famille :

| Motif de rejet | Volume approximatif |
|---|---|
| `quantity snapped to zero at the lot step` | environ 800 |
| `notional < minNotional` | le reste |

Un plancher à 2% du capital, soit environ 20 dollars, tue bien les deux familles : le lot step le plus grossier des quatre actifs vaut moins d'un dollar, donc 20 dollars ne s'écrase jamais à zéro.

---

## PR 3 — État de position

### Périmètre

La brique la plus lourde, elle touche le schéma. Stocker l'état de chaque position, écrit à chaque cycle, jamais reconstruit à l'exécution.

**Propriété stricte de l'état :**

- détenu par le **code** : `entry_date`, `peak_price_since_entry`, `last_significant_move`
- rédigé par le **modèle** : la thèse et ses conditions d'invalidation

`peak_price_since_entry` est un **prix unitaire, jamais une valorisation de position**. Après un allègement de 50% la valorisation tombe de moitié à prix constant, un trailing branché sur la valorisation déclencherait une sortie sur un drawdown fictif.

Il n'est réinitialisé ni par un renforcement ni par un allègement partiel, uniquement après une sortie totale.

La thèse persiste sur un hold. Elle n'est réécrite que lors d'une décision significative ou d'un remplacement explicite.

### Backfill, à faire correctement

Le bot tourne pendant le développement de ce chantier. Le backfill se calcule **au moment de la migration**, depuis l'historique réellement disponible à cet instant, et **depuis la dernière transition de zéro vers positif de chaque position**. Pas depuis le début de l'historique : si un actif a été soldé puis racheté entre temps, il hériterait d'un peak d'une vie antérieure.

**Ne pas écrire en dur les valeurs ci-dessous.** Elles sont une preuve de faisabilité et un ordre de grandeur au 25/07, lues depuis `decisions.market_context`. Elles auront bougé.

| Actif | peak observé au 25/07 | prix au 25/07 | écart |
|---|---|---|---|
| BTC | 67 234,06 | 64 024,07 | -4,8% |
| ETH | 1 948,37 | 1 856,38 | -4,7% |
| BNB | 630,00 | 564,51 | -10,4% |
| XRP | 1,2856 | 1,0884 | -15,3% |

À l'activation, il est probable que la plupart des lignes soient loin de leur plus haut. C'est assumé : on backfille le vrai peak historique, pas le prix du jour de bascule, sinon on masque un drawdown réel. Aucune liquidation de rattrapage n'est déclenchée par la migration.

### Preuves attendues

- migration appliquée, requête Supabase montrant les 4 lignes d'état avec `peak_price_since_entry` non nul et cohérent avec l'historique
- une requête montrant que le peak calculé correspond bien au maximum des prix observés depuis la dernière entrée, et pas depuis le début de la table
- un cycle live postérieur au merge montrant l'état mis à jour, sans reconstruction

---

## PR 4 — Prompt v5 et playbooks, derrière un flag

### Périmètre

Réécriture du mandat envoyé au modèle. Dépend des PR 1 et 3 en production, puisqu'il référence le régime et l'état de position.

Contenu, détaillé dans le mandat : playbooks par régime, cycle de vie par position, norme stratégique de taille (au moins 2% du capital ET au moins 25% de la position touchée, la contrainte la plus mordante gagne, sortie totale toujours permise), cible tactique mobile de 5 à 10 points, mémoire portant la thèse et non la liste des holds.

Retirer du mandat "ne rien faire est l'option par défaut" et "agit peu mais agit bien". Conserver l'interdiction du yo-yo, mais rattachée à la thèse et non à la dernière action.

**Livré derrière `STRATEGY_VERSION`, qui reste sur `v4` en production à la fin du goal.**

### Preuve comportementale obligatoire

Le replay déterministe ne peut pas prouver que le modèle prendra ses bénéfices. Activer v5 sans aucun test du modèle nous exposerait exactement au risque qu'on cherche à corriger.

Six probes isolées, sur contexte synthétique, **sans persistance en base et sans effet de bord externe**. Les sorties réelles du modèle sont collées dans la conversation.

| Scénario | Comportement attendu |
|---|---|
| Haut de range, P&L positif, `reversal_down` | allègement significatif |
| Bas de range, `reversal_up`, cash disponible | accumulation |
| `trend_up` intact, léger repli | maintien ou renforcement, pas de vente mécanique |
| `trend_down`, forte baisse depuis le peak | réduction ou sortie |
| Override `risk_off` | réduction globale de l'exposition |
| Aucun changement réel | hold, sans réécriture de la thèse |

Ces probes ne sont ni un backtest ni une promesse de performance. Elles prouvent que le nouveau mandat produit la bonne classe de comportements.

---

## Inventaire des accès

Un goal qui se bloque en plein milieu pour réclamer une clé, c'est un goal perdu.

**Repo** : `crypto-buddy` (bot) uniquement. Le repo dashboard n'est pas dans le périmètre de ces 4 PR.

**Supabase** : projet `nqawthwgqkgpbnlqtpjg`. Migrations via le connecteur MCP. **À vérifier dans la fenêtre Claude Code avant de lancer le goal** : Codex y accède, mais ça ne prouve pas que le connecteur de CC a le même accès. C'est un projet sur le compte perso, pas sur l'organisation INVESTMALIN.

**Binance public mainnet** : nécessaire pour les bougies 4h du replay. Vérifié le 25/07, l'endpoint `api/v3/klines` en intervalle 4h répond depuis la machine locale.

**Anthropic API** : requise pour les probes de la PR 4. Clé déjà dans le `.env` local.

**Railway** : le CLI est installé sur la machine, donc l'environnement est inspectable. **Lecture seule.** Ne jamais créer ni modifier `STRATEGY_VERSION` ni aucune autre variable. Une variable absente est la configuration voulue, pas un oubli à réparer.

**Identifiants et secrets** : jamais dans ce fichier, il part dans git. Ils vont dans le chat Claude Code.

---

## Process de review Codex

C'est le point qui déraille le plus souvent sur ce projet. À lire en entier avant la première PR.

### Déclenchement

- **L'auto-review est désactivée globalement.** Le seul mode est un commentaire manuel `@codex review` sur la PR.
- **Un seul trigger par round, JAMAIS de repost.** Reposter empile des jobs en double et fait poller des verdicts ancrés sur d'anciens commits. Vécu le 23/07, ça a fait dérailler tout un run.
- **L'icône 👀 ne prouve RIEN.** Elle apparaît en moins de 10 secondes si le trigger est passé, mais elle est retirée quand le job se termine. Son absence ne distingue pas "trigger raté" de "job déjà fini". On juge sur les verdicts, jamais sur la réaction.
- Temps de review : 2 à 10 minutes selon la taille de la PR. Ne pas confondre avec le temps de déclenchement.

### Récupérer le verdict, la partie qui casse à chaque fois

**L'auteur du verdict est `chatgpt-codex-connector[bot]`, avec le suffixe `[bot]`.** Un filtre d'auteur sans le `[bot]` ne remonte rien, systématiquement. C'est la cause numéro un des rounds ratés.

**Le comportement de Codex est ASYMÉTRIQUE**, et c'est pour ça qu'il faut surveiller trois canaux et pas un :

| Situation | Où le verdict apparaît |
|---|---|
| Il a des findings | une REVIEW, state `COMMENTED`, sur l'endpoint **reviews** |
| La PR est propre | un simple **issue comment** ("Didn't find any major issues") |
| La PR est propre, variante | juste une **réaction 👍** sur le commentaire déclencheur |

Conséquence si on ne surveille que l'endpoint reviews : on attrape chaque round rouge en moins d'une minute et on rate chaque round vert. C'est exactement ce qui s'est produit sur trois PR en juillet, et c'est Julien qui a dû annoncer les verts pendant que l'agent attendait pour rien.

**Donc : surveiller les TROIS canaux à chaque round.** Endpoint reviews, issue comments du bot, réaction 👍 sur le commentaire déclencheur.

### Autres pièges vérifiés en vrai

- **Vérifier le commit relu dans chaque verdict.** Il indique "Reviewed commit: `abc1234`". Un verdict ancré sur un SHA qui n'est plus le HEAD est une réponse tardive à un déclenchement précédent : on l'ignore et on continue d'attendre, **sans redéclencher**. Ne jamais valider une PR sur un verdict qui ne pointe pas le HEAD.
- **Poll INLINE dans le tour.** Pas de watcher en arrière-plan, il ne réveille pas l'agent de façon fiable. Vérifier, attendre un peu, revérifier.
- **Le bot peut planter et se rattraper tout seul.** Un message "Codex Review: Something went wrong / Unknown error" n'est PAS un échec définitif, il a déjà relancé de lui-même et posté un verdict propre 2 minutes plus tard. Ne pas redéclencher dans la minute.
- **Sortie de secours obligatoire.** Si aucun verdict sur le HEAD courant après environ 10 minutes de polling, on ARRÊTE. Pas de repost, pas de bricolage. On rend la main à Julien avec l'état : quel commit est en tête, ce qui a été déclenché et à quelle heure, ce qui a été reçu.

### Rounds et triage

- **4 rounds de review maximum par PR.** Au 5e demandé par Codex, arrêt et question à Julien, sans relancer de tour.
- Une PR propre se merge sans attendre de validation : squash and merge, suppression de la branche distante, cleanup local.
- Triage des findings : fix trivial dans notre code **pris**, pré-existant non lié à la PR **différé**, quasi-impossible à impact nul **décliné** avec un accepted residual tracé en commentaire. Ne pas dérouler un correctif par réflexe.
- **Codex n'est pas une source de vérité sur les faits de plateforme.** Il est fort sur le raisonnement autour du code, mais sa connaissance des API vieillit. Sur ce repo précisément, en juin, un reviewer a affirmé que les structured outputs et les modèles Claude 4.x n'existaient pas. Le suivre aurait jeté du code correct. Toute affirmation factuelle sur une plateforme (existence d'un modèle, d'une méthode SDK, d'une feature) se vérifie contre la doc officielle **avant** d'agir sur le retour. Vaut particulièrement pour la PR 4, qui touche l'API Anthropic.

### Discipline git

- Une PR = une brique. Quatre PR séquentielles, mergées une par une, jamais en parallèle.
- Branches `feat/...`, conventional commits, squash and merge.
- Cleanup local après merge : `git checkout main; git pull; git branch -D <branche>; git fetch --prune`. Le `-D` majuscule est normal après un squash.

---

## Condition d'arrêt du goal

Terminé quand tout ce qui suit est vrai et prouvé dans la conversation :

1. Les 4 PR sont mergées sur `main`, dans l'ordre, chacune après une review Codex propre.
2. La sortie du harness de replay régime est collée et remplit les critères de la PR 1.
3. Le replay rejoué prouve qu'aucun mouvement sous 2% du capital n'atteint le journal, et une requête Supabase sur les cycles postérieurs au merge de la PR 2 montre zéro intent rejeté pour taille insuffisante, les deux familles incluses : `notional < minNotional` et `quantity snapped to zero at the lot step`.
4. Une requête Supabase montre les 4 lignes d'état de position, avec un `peak_price_since_entry` backfillé dynamiquement et cohérent avec l'historique.
5. Les 6 sorties de probes comportementales sont collées, avec le verdict pour chacune.
6. Le bot tourne sur testnet, heartbeat de moins de 10 minutes, zéro échec consécutif.
7. La classe de test `STRATEGY_VERSION` est couverte et verte : absente vaut `v4`, `v4` vaut `v4`, `v5` vaut `v5`, toute autre valeur présente fait échouer le démarrage bruyamment. Plus une requête Supabase montrant qu'un cycle live postérieur au merge de la PR 4 a bien journalisé `v4`. Aucune variable Railway créée ni modifiée pendant le goal, aucune activation de `v5`.
8. Aucune donnée de trading synthétique dans la base vivante.

**Ou arrêt après environ 50 tours** si la condition ne converge pas.

Porte de sortie : poser une question de cadrage en cours de route ne clôt pas le goal. Si quelque chose paraît mal cadré, ou si une meilleure approche existe, le dire avant de coder plutôt qu'appliquer aveuglément.
