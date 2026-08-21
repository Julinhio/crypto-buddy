# Harnais de calibration de la bande d'exposition

## Ce que cette expérience mesure, et ce qu'elle ne mesure pas

**Le modèle n'est pas dans l'expérience.** Le replay est entièrement déterministe. On calibre
un contrôleur de contexte appliqué à un **allocateur proxy**, alors que la production
appliquera une contrainte **par-dessus le modèle**. Ce n'est pas le même système.

Question à laquelle ce protocole répond honnêtement :

> Le contrôleur déterministe de contexte améliore-t-il le couple rendement/risque par
> rapport à une exposition constante comparable, **sous notre allocateur proxy** ?

Question à laquelle il **ne répond pas** :

> Le bot complet, avec son modèle, possède-t-il cet edge en production ?

La seconde exigera un mode observation en production, qui est un chantier ultérieur.

---

## Pourquoi ce chantier existe

Le bot est resté autour de 79 % de cash pendant des semaines. Sur toute la stratégie v5, il
fait environ **+2,9 %** quand la simple conservation du portefeuille détenu au lancement en
aurait fait **+7,9 %**.

La cause n'est ni les plafonds ni le plancher de cash : ils autorisent déjà bien plus
d'exposition que ce que le bot utilise. La cause est **l'absence d'objectif d'exposition**.
Chaque position est traitée comme une tranche tactique isolée, sans socle cohérent avec le
contexte global.

Ce harnais construit de quoi **calibrer** cet objectif. **Il ne le déploie pas.**

---

## Ce que cette PR ne fait pas

- Elle ne modifie **aucun comportement de production**.
- Elle ne touche à **aucun plafond**, aucune configuration active, aucun prompt, aucun mandat.
- Elle ne modifie **pas la porte de transition** ni sa symétrie achat/vente.
- Elle ne touche **pas au stop déterministe**.
- **Aucune migration, aucune écriture en base, aucun appel LLM, aucun réseau.**

Le harnais **importe** les fonctions de production — régimes, hystérésis, transition
collante, posture `risk_off`, verdicts de porte — et n'en réécrit aucune. Sa seule licence
sur ces données est d'adapter les objets `t/o/h/l/c/v` du bundle vers le type `Candle`.

---

## Le plancher de cash est absent par construction

Production tourne avec `caps.minCashPercent = 30`. Le protocole impose **aucun plancher de
cash**. Ces deux faits sont séparés par autre chose que de la discipline, parce que l'échec
serait silencieux : un plancher à 30 % plafonnerait toute exposition réalisée à 70 %, ce qui
amputerait la bande constructive du bras C (85–100 %) et rendrait son résultat vide de sens —
pendant que tous les chiffres continueraient de paraître plausibles.

Le plancher n'est donc **pas mis à zéro. Il n'est pas représentable.** `ExperimentConfig` n'a
pas de champ pour lui, le harnais n'appelle jamais `clampAllocation` (où vit ce plancher en
production), et un test cherche l'identifiant dans tout le harnais et échoue s'il apparaît.
On ne peut pas oublier de zéroter un nombre qui n'a nulle part où aller.

Ce qui **vient** de production et reste inchangé : les plafonds par actif, le plancher de
mouvement, le seuil du stop de pic.

---

## Deux mécanismes distincts, journalisés séparément

Ils sont régulièrement confondus, et les tenir séparés est l'essentiel de `allocate.ts` :

- **L'intervalle faisable** est une borne **agrégée**. Il dit quelle exposition totale le
  livre pourrait atteindre, compte tenu des lignes que la porte laisse toucher.
- **La non-redistribution** est une règle **par ligne**. Une ligne qui n'atteint pas sa cible
  nominale ne transmet pas son manque à une autre.

Satisfaire le premier n'implique **pas** d'atteindre la cible, parce que le second peut
échouer sur des lignes individuellement bloquées.

### L'écart va dans les deux sens

La non-redistribution produit de la sous-exposition — et aussi de la **sur-exposition**,
moitié qu'on oublie. BTC gelé à 30 % avec une cible de 40 % : sa part nominale vaut 13,3 %,
il ne peut pas être vendu, et si les trois autres lignes rejoignent leurs cibles nominales le
livre atterrit **au-dessus** de 40 %. Rien n'a mal fonctionné : un surpoids gelé ne peut pas
être rogné, et le reste a été dimensionné comme s'il pouvait l'être.

Mesuré sur ce scénario : projeté 40,00 %, **atteint 56,67 %**, écart **+16,67 pts**,
journalisé `BTC / frozen / +16.67`.

---

## Les deux règles anti-triche du moteur

**Aucun look-ahead.** Le signal est calculé sur la **clôture** de la barre `i` ; l'ordre
s'exécute à l'**ouverture** de la barre `i+1`. Même instant sur l'horloge, deux prix
différents — et cette différence est tout l'enjeu : au moment où le bot connaît la clôture de
`i`, ce prix n'est plus traitable. S'y exécuter est le mensonge le plus confortable qu'un
backtest puisse se raconter.

**Aucune barre inventée.** Les séries 4h portent la panne Binance du 19/02/2020 comme un
**trou**. « Barre suivante » signifie donc la barre suivante **dans la série**, jamais
`t + 4h`. Un signal sans barre suivante du tout — la fin du bundle — ne produit aucun ordre et
est compté `pending_not_executed`, jamais exécuté sur une clôture de substitution.

---

## La métrique s'appelle `excès de CAGR contre témoin constant`

Jamais « alpha » tout court : ce n'est ni un alpha de régression, ni l'edge du bot complet.

Le témoin subit lui aussi la porte, les stops et le plancher de mouvement. La porte est donc
tenue constante entre le bras et son témoin, et **l'écart isole le contrôleur de bande, lui
seul**. Cette phrase accompagne le chiffre partout où il est cité.

### Un témoin par configuration validable

Chaque configuration susceptible d'entrer en validation possède **son propre** témoin
constant, calculé sur la calibration puis **figé** avant ouverture du hors-échantillon. Le
RSI comme l'asymétrie modifient l'exposition moyenne réalisée : si le témoin ne suit pas, il
cesse d'être apparié et le contrôle du bêta — sa seule raison d'être — s'effondre.

Le témoin est **cherché**, pas déduit : une cible constante ne produit pas mécaniquement
l'exposition moyenne annoncée, puisque la porte, les stops et le plancher s'interposent.
Recherche exhaustive de 0 à 100 % par pas de 0,25 point (401 cibles), on retient la cible
minimisant l'écart absolu d'exposition moyenne **réalisée**, égalité résolue vers la cible la
plus basse. Tolérance pré-enregistrée : **0,25 point**. Si aucune cible ne l'atteint, le
témoin est déclaré **imparfait** et ne peut soutenir aucune affirmation d'excès de CAGR.

### Le témoin équipondéré est un repère externe

25 % par actif, acheté au premier prix exécutable, jamais rééquilibré, frais et slippage
inclus. **Il ne respecte pas les plafonds individuels du bot** (BTC 35 / ETH 35 / BNB 20 /
XRP 15) — il détient donc une allocation que le bot ne pourrait jamais tenir. Cette mention
accompagne son chiffre partout.

---

## Le bundle

Produit par `crypto-lab`, PR #1, squash `ed9bc04`. Copié **byte-identique** sous
`data/calibration/crypto-buddy-exposure-v1/`. Le harnais ne dépend **ni d'un checkout voisin
de `crypto-lab`, ni du réseau**.

Avant tout usage il vérifie : `schema_version`, `bundle_id`, le `bundle_sha256` épinglé, les
huit fichiers, le SHA-256 de chacun, les bornes et nombres de lignes, l'absence de toute
bougie inadmissible, et la présence du trou du 19/02/2020 — **déclaré et réellement absent**.
Une seule vérification en échec arrête le run. **Pas de mode dégradé.**

Le `bundle_sha256` est **recalculé** depuis la préimage, pas seulement comparé : une chaîne
comparée à une constante prouve qu'on n'a pas remplacé le manifeste en bloc, mais ne prouve
rien contre un manifeste édité de façon cohérente.

`.gitattributes` épingle les fins de ligne de `data/calibration/**`. Ce n'est pas
hypothétique : `core.autocrlf=true` est actif sur la machine d'origine, et `crypto-lab` a dû
faire exactement la même chose pour la même raison.

---

## Les artefacts, et ce que leurs empreintes prouvent

Trois artefacts sont **commités** — `selection.json`, `summary.json`, `manifest.json` — parce
que le protocole exige que la sélection soit figée et commitée **avant** toute ouverture de la
fenêtre scellée, et parce que les deux autres sont le résultat publié.

`trajectory.json` (~13,5 Mo, la trajectoire barre par barre) n'est **pas** commité : il se
régénère intégralement depuis le bundle figé et le commit du manifeste, et il ajouterait un
blob de 13,5 Mo à l'historique à chaque run.

**Son SHA-256 dans le manifeste est un engagement d'intégrité, pas une vérification.** Il ne
devient une vérification qu'une fois le fichier régénéré et comparé. Pour le faire :

```bash
npx tsx src/calibration/exposure/calibrate.ts
```

puis, depuis la racine du dépôt :

```bash
node -e "const c=require('node:crypto'),f=require('node:fs');const m=require('./out/exposure-calibration/manifest.json');const e=m.outputs.find(o=>o.file==='trajectory.json');const g=c.createHash('sha256').update(f.readFileSync('out/exposure-calibration/trajectory.json')).digest('hex');console.log(g===e.sha256?'MATCH '+g:'DIVERGENCE\ncommitted '+e.sha256+'\nregenerated '+g)"
```

Un `MATCH` prouve que la trajectoire régénérée est celle qui a produit les chiffres publiés.
Une divergence signifie que le code, le bundle ou la configuration ont bougé depuis — et le
manifeste dit lequel, puisqu'il épingle le commit, le `bundle_sha256` et
l'`experiment_config_sha256`.

Le manifeste ne porte **aucune durée d'exécution**, et ce n'est pas un oubli : une durée ne
peut jamais se reproduire, donc un manifeste qui en contiendrait ne pourrait jamais être
byte-identique entre deux runs — ce qui rendrait la preuve de déterminisme invérifiable sur
l'artefact même dont le rôle est de certifier les autres. Les durées vont sur la sortie
standard et dans la description de PR.

## Limite à lire à côté des résultats

Les trois bras diffèrent sur les **trois** états à la fois. Si C gagne, **on ne saura pas** si
c'est sa bande défensive, neutre ou constructive qui porte le résultat. C'est assumé, et ça
doit être écrit à côté du chiffre.

---

## Issue négative pré-écrite

Si **aucun bras n'est éligible**, on ne livre pas de bande. Le résultat négatif est publié.
C'est une issue acceptable, écrite d'avance.
