# Observation passive de l'exposition

## Ce que cet outil mesure, et ce qu'il ne mesure pas

Le harnais de calibration (`src/calibration/exposure`) mesure un **contrôleur déterministe
appliqué à un allocateur proxy**. Le modèle n'y participe pas. Ses trois bras montrent un
signal à exposition comparable, aucun ne respecte la limite pré-enregistrée de 35 % de
drawdown, aucune bande n'est sélectionnée et le hors-échantillon reste fermé.

Cet outil-ci répond à une question différente, et à une seule :

> Que fait **réellement le modèle**, face au contexte déterministe que le contrôleur
> consommerait, sur les cycles que le bot a réellement vécus ?

Il n'y répond pas encore avec un chiffre. Il construit la **base d'observation** qui permettra
d'y répondre : un extrait en lecture seule du journal vivant, borné par un cutoff explicite,
reproductible à l'octet près.

**Ce qu'il ne produit pas, et ne produira jamais dans cet état : ni P&L, ni drawdown, ni
rendement, ni bande déployable.** C'est écrit dans l'artefact lui-même (`summary.json` →
`contract.not_measured`), pas seulement ici.

---

## Le contrat méthodologique

### Un pas, ré-ancré, jamais chaîné

L'unité fine est le **cycle réel**. Chaque cycle porte le livre **tel qu'il était avant sa
propre décision** — `deployedPercent`, l'exposition que le modèle avait sous les yeux. Rien
n'est reporté d'un cycle au suivant : aucun portefeuille proxy n'est maintenu, aucune demande
n'est chaînée, aucune trajectoire n'est construite. C'est un contrefactuel à un pas, ré-ancré
sur le livre réel à chaque réveil, et il ne prétend donc mesurer ni trajectoire, ni rendement,
ni drawdown.

### Aucune bande dans le chemin d'extraction

Le snapshot est **agnostique aux bandes**. L'observateur importe `readContext` — la fonction
de production qui classe le contexte en `defensive` / `neutral` / `constructive` — et
**jamais** `arms.ts`, où vivent les bandes A, B et C. Ce n'est pas une intention : le test
suit le graphe d'imports transitif depuis `observe.ts` et échoue si `arms.ts` y apparaît, puis
vérifie qu'aucune clé des artefacts n'est de forme « bande » ou « bras ».

Les bandes historiques servent **uniquement** de vecteur de test : la preuve 2 rejoue les
trois bras sur des points de régime réhydratés et vérifie que le calcul hors ligne reproduit
exactement `bandFor` + `projectOntoBand`. Elles ne deviennent ni candidates, ni
sélectionnables, ni déployables.

### La bougie 4h est l'unité de toute statistique de marché

Le bot se réveille **3 à 7 fois dans une même bougie 4h**. Le contexte est calculé sur la
bougie **close** : ces réveils partagent donc un seul régime, une seule largeur, un seul
`risk_off`. Les compter comme des observations indépendantes pondérerait une bougie par la
fréquence du scheduler.

Donc : tout ce qui parle du **marché** est agrégé par bougie (`summary.json` → `bars`). Tout
ce qui parle du **livre** ou du **modèle** garde le grain du cycle — parce que ces deux-là
bougent réellement entre deux réveils d'une même bougie, et que ce mouvement à information de
marché constante est précisément l'un des objets de ce snapshot (`summary.json` → `intrabar`).

### Aucune donnée postérieure au cutoff

Ni prix futur, ni outcome, ni instant au-delà du cutoff. La vérification n'est pas une
relecture : le payload entier est **parcouru** et tout instant ISO-8601 au cutoff ou après
fait échouer le run (`no_instant_at_or_after_the_cutoff`). Les horizons et les règles de
censure appartiennent au chantier hors ligne suivant.

---

## Ce que le snapshot contient

| Exigence | Où |
|---|---|
| le statut du cycle | `cycles[].status`, `skip_reason` |
| la clé et l'heure de la bougie 4h | `cycles[].bar.key`, `bar.source`, `bar.agrees_with_transition` |
| le contexte déterministe consommé par le contrôleur | `cycles[].context` (état, largeur nette, comptages, `risk_off`, RSI médian) |
| l'exposition réelle du livre avant décision | `cycles[].book.exposure_percent` |
| l'exposition totale proposée par le modèle | `cycles[].model_decision.raw_target.exposure_percent` |
| l'exposition totale effectivement retenue | `cycles[].model_decision.applied_target.exposure_percent` |
| les changements d'avis intrabougie | `summary.intrabar[]` |
| les verdicts de transition et les événements de stop | `cycles[].transition.verdicts[]`, `summary.stops` |
| les mouvements réservés ou exécutés | `cycles[].movements[]` (intent souverain + trace du venue) |

L'exposition est **Σ des poids non-réserve**, jamais `100 − réserve`. Les deux coïncident dès
que l'allocation totalise 100 — ce que le schéma impose sur toute ligne fraîche — et quand
elles divergent, c'est la somme qui est honnête : soustraire à un cent qui n'existe pas
fabrique de l'exposition. La somme réelle est publiée à côté (`sum_percent`).

### Les cycles sans réponse du modèle restent dans la population

Un cycle `error`, `parse_failed`, `guard_failed` ou `skipped` produit une ligne complète avec
ses champs de cible à `null`. Il ne disparaît pas. Une population qui les écarterait rendrait
« à quelle fréquence le modèle ne répond pas » impossible à lire dans le fichier même construit
pour lire le comportement du modèle, et flatterait tous les taux calculés sur les survivants.

### Ce que le snapshot ne rapatrie volontairement pas

`reasoning`, `raw_response`, `notification_summary`, `what_changed` et le blob de réponse du
venue ne sortent jamais de la base par cet outil. C'est la prose du modèle et les payloads de
l'exchange : rien de tout cela n'entre dans une statistique d'exposition, et un snapshot qui
les embarquerait serait un export en vrac de tout ce que le bot a jamais dit, dans un fichier
dont le rôle est de circuler.

---

## Une divergence réelle entre le contexte calibré et le contexte vivant

Le contrôleur est défini sur les actifs auxquels il peut allouer : la table des plafonds,
soit **4 actifs** (BTC, ETH, BNB, XRP). Le **régime** de production, lui, est calculé sur les
paires **tradables ET référence** — soit **5 actifs** aujourd'hui, SOL compris, que le bot
observe et ne trade jamais (`readRegime`, `src/context/build.ts`).

Conséquences, journalisées plutôt que lissées :

- la **largeur nette** (`context.net_breadth`) est calculée sur les 4 actifs allouables, qui
  sont l'univers de calibration du contrôleur. La paire de référence n'y contribue pas ;
- le **`risk_off`** est celui de production, repris verbatim du journal, et production le
  calcule sur 5. Le harnais de calibration calculait la même posture sur 4, parce que son
  bundle en portait 4.

L'état rapporté hérite donc des deux : sa branche `defensive` est la posture 5 actifs de
production, sa séparation `constructive` / `neutral` est une largeur 4 actifs. Ce n'est pas un
arbitrage que ce chantier avait la liberté de prendre — production est propriétaire de
`risk_off`, et le snapshot rapporte ce que le bot a réellement vu. C'est écrit dans chaque
contexte (`journal_global`, `journal_only_assets`) pour qu'aucune analyse ultérieure ne
compare un état vivant à un état calibré sans rencontrer la différence d'abord.

---

## Stops et réentrées : ce qui est préservé, ce qui n'est pas calculé

L'unité est **l'épisode, jamais la ligne**. La migration 0022 le dit sans détour : tant que
rien ne sort, le pic n'est jamais réinitialisé et la ligne reste sous son seuil — `stop_would_fire`
peut donc être vrai sur des dizaines de réveils consécutifs pour ce que le contrat compte comme
**une seule** sortie. Un épisode est une suite maximale de cycles consécutifs, par actif.

Un cycle qui n'a produit **aucun verdict** sur cet actif ne prolonge pas la suite : il la
coupe, et l'épisode le dit (`broken_by_missing_verdict`). Ponter le trou affirmerait une
continuité que personne n'a observée ; le traiter comme une guérison affirmerait l'inverse.

Quatre états restent distinguables :

- une sortie **réellement réservée** → `outcome: exit_booked`, avec `pre_trade_qty`,
  `booked_base_delta` et `residual_qty` pour que « sortie totale ? » soit de l'arithmétique et
  non un seuil arbitraire ;
- un stop armé sur un **cycle en échec** → `no_exit_booked` / `all_cycles_failed` ;
- un stop armé qui n'a rien réservé sur un cycle décidé → `no_exit_booked` / `no_sell_booked` ;
- la **réentrée réelle**, ou son absence.

La réentrée est le premier ACHAT réellement réservé sur cet actif après l'épisode. Son absence
n'est pas censurée : elle est `null`, accompagnée de `cycles_after_episode_in_window` — le
dénominateur honnête. Aucun horizon et aucune règle de censure ne sont appliqués ici ; ils
appartiennent au chantier suivant, pré-enregistrés.

**La sortie et la réentrée portent `booked_at`, l'instant du MOUVEMENT, jamais celui du cycle.**
Un réveil n'est pas atomique : la décision est insérée, puis les ordres sont passés, puis les
exécutions sont journalisées. Dater une réservation avec le `created_at` de son cycle
donnerait au chantier suivant — dont le sujet est précisément le délai entre un stop et sa
réentrée — un instant qui peut être matériellement antérieur à l'ordre qu'il prétend dater. Et
quand cet instant manque, le champ vaut `null` : le temps du cycle est à un `decision_id` de
là dans `cycles.json`, donc rien n'est perdu à refuser de le substituer, alors qu'un instant
substitué serait indiscernable d'un instant mesuré. Les bornes de l'épisode, elles, restent les
instants des RÉVEILS — un épisode est une suite de réveils, pas d'ordres — et s'appellent
`from_cycle_at` / `to_cycle_at` pour que les deux natures de temps ne puissent pas se
confondre.

**L'attribution n'est pas affirmée.** Savoir si une vente réservée vient de la sortie du code
ou du modèle vendant la même ligne au même réveil ne se lit pas dans le journal : le mode de la
couche est une variable d'environnement qu'aucune colonne n'enregistre. Le snapshot publie le
mouvement et le verdict de porte qui l'accompagnait, et s'arrête là. Ce qu'il ne fait jamais,
c'est attribuer au modèle une réentrée mécanique — il n'y a ici aucun proxy avec quoi réentrer.

---

## Reproduire

Les deux bornes sont **obligatoires** et jamais défaultées. Une borne par défaut serait un
paramètre caché de chaque chiffre publié.

```bash
npm run observe:exposure -- --from 2026-08-12T00:00:00Z --cutoff 2026-08-22T03:15:50Z
```

Les deux bornes doivent porter un **fuseau explicite** (`Z` ou un offset). Sans lui,
`Date.parse` les lit dans le fuseau de la machine : la même ligne de commande sélectionnerait
une population différente ailleurs, et l'artefact renormaliserait la borne en `Z` en sortie —
la divergence ne laisserait donc aucune trace dans le fichier qu'elle a changé.

Le cutoff doit être **stabilisé** : au moins un TTL de run-lock dans le passé. `decide()`
insère la décision AVANT de placer les ordres et de journaliser les verdicts, donc un cutoff
tombant au milieu de cette séquence capturerait un cycle sans mouvements ni verdicts — et le
même cutoff rejoué une heure plus tard produirait un fichier différent. Le run refuse.

Ce délai garantit qu'un cycle commencé avant le cutoff est **terminé au moment de la
lecture** ; il ne garantit pas qu'il s'est terminé **avant le cutoff**. Un cycle à cheval —
décision avant, verdicts ou mouvements après — est donc détecté séparément par
`every_cycle_settled_before_the_cutoff`, qui fait échouer le run. Le cycle est conservé
**entier** plutôt que tronqué : borner les tables filles sur leur propre `created_at`
amputerait ce cycle, qui se lirait alors comme un réveil n'ayant rien réservé — un fait
fabriqué, en silence. Le remède est d'un seul drapeau : reculer le cutoff au-delà de la fin
de ce réveil.

Preuve de déterminisme, deux exécutions sur le même cutoff :

```bash
npm run observe:exposure -- --from 2026-08-12T00:00:00Z --cutoff 2026-08-22T03:15:50Z --out out/exposure-observation/run-a
npm run observe:exposure -- --from 2026-08-12T00:00:00Z --cutoff 2026-08-22T03:15:50Z --out out/exposure-observation/run-b
diff -r out/exposure-observation/run-a out/exposure-observation/run-b
```

Les décisions et leurs deux tables filles sont **trois requêtes distinctes**, et `reset_bot`
tronque les trois dans **une seule** transaction. Un reset tombant entre deux lectures
laisserait des décisions dont les verdicts et les mouvements ont déjà été effacés — et rien ne
le verrait, puisque zéro verdict et zéro mouvement sont deux états parfaitement légaux. La
liste d'identités est donc **relue après** les tables filles : la fenêtre étant close sur un
cutoff stabilisé, aucune ligne légitime ne peut y entrer ni en sortir, et la moindre
différence fait échouer le run plutôt que de sceller un snapshot déchiré.

Les artefacts ne portent **aucune horloge murale** : ni date de run, ni durée. Une durée ne se
reproduit jamais, et un manifeste qui en contiendrait ne pourrait jamais être byte-identique
entre deux runs — ce qui rendrait la preuve de déterminisme invérifiable sur l'artefact même
censé certifier les autres. Les durées vont sur la sortie standard.

`manifest.json` porte l'empreinte : `snapshot_sha256`, un condensé unique sur les condensés des
deux autres fichiers, plus le commit, l'arbre `src/`, le lockfile et le digest de la
configuration du contrôleur.

**Les artefacts ne sont pas commités** (`.gitignore`). Ce sont des allocations, des mouvements
et un livre réels, régénérables à tout instant depuis le même cutoff.

---

## Les invariants de sécurité, et comment ils sont prouvés

| Invariant | Preuve |
|---|---|
| lecture seule sur la base vivante | un seul fichier (`read.ts`) peut construire une requête, dans tout le graphe transitif ; aucun fichier de l'observateur ne nomme une méthode d'écriture |
| aucune lecture déchirée | la liste d'identités est relue après les tables filles ; toute différence fait échouer le run |
| aucun instant lu dans le fuseau de la machine | `instants.ts` refuse toute chaîne sans fuseau explicite, pour les bornes du CLI comme pour le `barAt` journalisé |
| les artefacts ne peuvent atterrir ailleurs | `--out` est confiné **physiquement** à `out/exposure-observation` et ses descendants : chaque composant existant est résolu avant écriture, donc aucun lien ni aucune jonction n'en fait sortir, ni sur la racine ni sur un descendant |
| aucun instant de mouvement n'est inventé | la sortie de stop et la réentrée portent l'instant de réservation du mouvement, `null` s'il manque, jamais l'instant du cycle |
| aucune bande dans le chemin d'extraction | `arms.ts` est inatteignable depuis `observe.ts` ; aucun appel de fonction de bande ; aucune clé « bande » dans les artefacts |
| aucun chemin de production ne lit l'observateur | aucun fichier hors `src/observation` n'importe `observation/exposure` ni ne lit `out/exposure-observation` |
| chaque cycle apparaît exactement une fois | `every_cycle_exactly_once` |
| chaque cycle conserve sa clé de bougie | `every_cycle_keeps_its_bar` + `bar_key_agrees_across_writers` |
| les cycles décidés portent les deux expositions | `decided_cycles_carry_both_exposures` |
| les cycles en échec ne sont pas éliminés | `failed_cycles_are_preserved` |
| une bougie compte une fois | `bars_partition_the_cycles` + la preuve 7 |
| un épisode de stop n'est pas un compte de lignes | `stop_episodes_cover_every_fired_verdict` + la preuve 9 |
| aucun cycle ne chevauche le cutoff | `every_cycle_settled_before_the_cutoff` |
| rien ne dépasse le cutoff | `no_instant_at_or_after_the_cutoff` |

Les douze contrôles tournent à chaque run, sont écrits dans `summary.json`, et un seul en échec
fait sortir le processus en code non nul. Les artefacts sont quand même écrits — pour être
inspectés — mais rien ne peut en être cité tant que l'échec n'est pas compris.

---

## Ce que ce chantier ne peut pas conclure

Il ne peut pas conclure qu'une bande est livrable, et il n'ouvre pas le hors-échantillon. Il ne
produit aucun chiffre de performance. Ce qu'il produit, c'est la population sur laquelle un
chantier ultérieur — horizons et règles de censure pré-enregistrés — pourra travailler sans
avoir à retoucher au bot.
