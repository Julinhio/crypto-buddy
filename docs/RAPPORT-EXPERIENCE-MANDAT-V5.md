# Expérience — le cadrage du mandat v5 influence-t-il l'exposition totale demandée ?

Généré le 2026-08-23T05:56:44.419Z par `npm run experiment:mandate`. Rapport entièrement
produit par le harnais à partir des artefacts de run — aucune valeur saisie à la main.

## Question et cadre

Quatre mandats sur quatre contextes de production rejoués à l'identique (contexte,
livre, mémoire et plomberie strictement identiques), cinq répétitions par cellule :

- **C** — contrôle : le prompt v5 de production, byte-identique ;
- **P** — placebo : instruction saillante sur la confiance, sans contenu d'exposition ;
- **F** — clarification du plancher de cash (limite de sécurité, pas une cible) ;
- **O** — propriété explicite de l'exposition totale au niveau portefeuille.

Réponse PRIMAIRE uniquement (pas de relance du garde). Les erreurs de transport sont
rejouées et comptées à part. Lecture préenregistrée dans `src/experiment/mandate/analyze.ts`.
Modèle demandé pour chaque appel : `claude-sonnet-4-6`.

## Les quatre mandats — empreintes et preuve de la contrainte dure

| Mandat | SHA-256 du system prompt | Ajout |
|---|---|---|
| C | `57c632fb9d698bf37fd38998955d6935f9eccf63689ae389c8e6dd9e88164c59` | aucun (prompt de production) |
| P | `d64b41aa138ceacb06852bae6e7b730bb014c5c891537aa48d9006d228cff74b` | 3 ligne(s) insérée(s) après « legitimate when nothing warrants acting; it is not the defau… » |
| F | `c662812af6ffdbb9c464e6adbb39a1d6a7a9691e202cd9aef34a689f3d72f0c6` | 2 ligne(s) insérée(s) après « this bounds total deployed capital to at most 70%.… » |
| O | `74ca9daf37261c66454b7d20a09bc13e3b38c73c7ed4529c561a1950334c2d84` | 2 ligne(s) insérée(s) après « legitimate when nothing warrants acting; it is not the defau… » |

**Preuve** : retirer les lignes insérées de chaque variante restitue le contrôle byte-identique.

- C : OK — control — the production prompt itself, no addition to prove.
- P : OK — removing the 4 inserted line(s) after line 153 restores the control byte-for-byte.
- F : OK — removing the 3 inserted line(s) after line 165 restores the control byte-for-byte.
- O : OK — removing the 3 inserted line(s) after line 153 restores the control byte-for-byte.

## Porte 1 — reconstruction des quatre contextes

### Décision 1297 — opportunité forte

- verdict : **OK** (12 contrôles, 0 échec(s))
- mémoire : décision significative 1283 ; référence du garde : 1296
- empreintes : contexte stocké `e7f69f79dd88ed43…`, mémoire `f0934ed432f1d4a1…`, user prompt `62772bd6f87471f3…`

- ✓ `row_identity` — status=decided, prompt_version=v5, model=claude-sonnet-4-6 (expected decided / v5 / claude-sonnet-4-6)
- ✓ `context_shape` — all required keys present (generatedAt, source, market, account, regime, positions)
- ✓ `enforce_mode_detected` — all 5 regime entries carry `actionable` and no candidate fields — the cycle ran under TRANSITION_MODE=enforce
- ✓ `portfolio_roundtrip` — toPortfolioView(rebuilt book) equals the persisted view field-for-field (key-order independent)
- ✓ `portfolio_consistency` — cash (922.96) + positions (101.99) vs equity (1024.95): gap 0.0000
- ✓ `universe_match` — derived universe [BTC, ETH, BNB, XRP, USDT] vs stored target keys [BNB, BTC, ETH, XRP, USDT]
- ✓ `historical_exposure` — stored requested exposure 20 vs brief 20
- ✓ `memory_row` — production memory query found 1283 (expected 1283)
- ✓ `guard_reference_row` — guard reference query found 1296 (expected 1296)
- ✓ `guard_reference_restated` — restated (sum 100.00, dropped: none)
- ✓ `clamp_replay` — replayed clamp reproduces the stored applied allocation (clamped=false)
- ✓ `historical_replay` — the persisted raw response replays as `accepted` with the stored target — schema, clamp, movements and guard all agree with production

### Décision 1433 — opportunité étroite sur BNB

- verdict : **OK** (12 contrôles, 0 échec(s))
- mémoire : décision significative 1399 ; référence du garde : 1432
- empreintes : contexte stocké `992d51a86c3acf4c…`, mémoire `dc1030ff81f0c3e6…`, user prompt `b4a322304cef2acd…`

- ✓ `row_identity` — status=decided, prompt_version=v5, model=claude-sonnet-4-6 (expected decided / v5 / claude-sonnet-4-6)
- ✓ `context_shape` — all required keys present (generatedAt, source, market, account, regime, positions)
- ✓ `enforce_mode_detected` — all 5 regime entries carry `actionable` and no candidate fields — the cycle ran under TRANSITION_MODE=enforce
- ✓ `portfolio_roundtrip` — toPortfolioView(rebuilt book) equals the persisted view field-for-field (key-order independent)
- ✓ `portfolio_consistency` — cash (854.76) + positions (177.17) vs equity (1031.93): gap 0.0000
- ✓ `universe_match` — derived universe [BTC, ETH, BNB, XRP, USDT] vs stored target keys [BNB, BTC, ETH, XRP, USDT]
- ✓ `historical_exposure` — stored requested exposure 22 vs brief 22
- ✓ `memory_row` — production memory query found 1399 (expected 1399)
- ✓ `guard_reference_row` — guard reference query found 1432 (expected 1432)
- ✓ `guard_reference_restated` — restated (sum 100.00, dropped: none)
- ✓ `clamp_replay` — replayed clamp reproduces the stored applied allocation (clamped=false)
- ✓ `historical_replay` — the persisted raw response replays as `accepted` with the stored target — schema, clamp, movements and guard all agree with production

### Décision 1368 — favorable, déjà fortement exposé

- verdict : **OK** (12 contrôles, 0 échec(s))
- mémoire : décision significative 1367 ; référence du garde : 1367
- empreintes : contexte stocké `17592bd36a80a344…`, mémoire `0cdcac0bd5f17b8f…`, user prompt `db2e0c3797915ac9…`

- ✓ `row_identity` — status=decided, prompt_version=v5, model=claude-sonnet-4-6 (expected decided / v5 / claude-sonnet-4-6)
- ✓ `context_shape` — all required keys present (generatedAt, source, market, account, regime, positions)
- ✓ `enforce_mode_detected` — all 5 regime entries carry `actionable` and no candidate fields — the cycle ran under TRANSITION_MODE=enforce
- ✓ `portfolio_roundtrip` — toPortfolioView(rebuilt book) equals the persisted view field-for-field (key-order independent)
- ✓ `portfolio_consistency` — cash (531.9) + positions (490.49) vs equity (1022.39): gap 0.0000
- ✓ `universe_match` — derived universe [BTC, ETH, BNB, XRP, USDT] vs stored target keys [BNB, BTC, ETH, XRP, USDT]
- ✓ `historical_exposure` — stored requested exposure 48 vs brief 48
- ✓ `memory_row` — production memory query found 1367 (expected 1367)
- ✓ `guard_reference_row` — guard reference query found 1367 (expected 1367)
- ✓ `guard_reference_restated` — restated (sum 100.00, dropped: none)
- ✓ `clamp_replay` — replayed clamp reproduces the stored applied allocation (clamped=false)
- ✓ `historical_replay` — the persisted raw response replays as `accepted` with the stored target — schema, clamp, movements and guard all agree with production

### Décision 1494 — contrôle négatif, suracheté

- verdict : **OK** (12 contrôles, 0 échec(s))
- mémoire : décision significative 1443 ; référence du garde : 1493
- empreintes : contexte stocké `3d4ad170c2a432b3…`, mémoire `35b3c31fc4ce0bea…`, user prompt `7be582d87ce58fdd…`

- ✓ `row_identity` — status=decided, prompt_version=v5, model=claude-sonnet-4-6 (expected decided / v5 / claude-sonnet-4-6)
- ✓ `context_shape` — all required keys present (generatedAt, source, market, account, regime, positions)
- ✓ `enforce_mode_detected` — all 5 regime entries carry `actionable` and no candidate fields — the cycle ran under TRANSITION_MODE=enforce
- ✓ `portfolio_roundtrip` — toPortfolioView(rebuilt book) equals the persisted view field-for-field (key-order independent)
- ✓ `portfolio_consistency` — cash (834.31) + positions (242.57) vs equity (1076.88): gap 0.0000
- ✓ `universe_match` — derived universe [BTC, ETH, BNB, XRP, USDT] vs stored target keys [BNB, BTC, ETH, XRP, USDT]
- ✓ `historical_exposure` — stored requested exposure 10 vs brief 10
- ✓ `memory_row` — production memory query found 1443 (expected 1443)
- ✓ `guard_reference_row` — guard reference query found 1493 (expected 1493)
- ✓ `guard_reference_restated` — restated (sum 100.00, dropped: none)
- ✓ `clamp_replay` — replayed clamp reproduces the stored applied allocation (clamped=false)
- ✓ `historical_replay` — the persisted raw response replays as `accepted` with the stored target — schema, clamp, movements and guard all agree with production

**Limite connue, arbitrée par la porte 2** : `market_context` est une colonne `jsonb`,
qui ne préserve pas l'ordre des clés. Le user prompt reconstruit contient exactement
les clés et valeurs que la production a envoyées, dans l'ordre (déterministe) de la
colonne plutôt que dans l'ordre de sérialisation d'origine, qu'aucun store n'a retenu.
Si cet ordre comptait pour le modèle, C ne reproduirait pas l'historique — c'est
exactement ce que la porte 2 mesure.

## Porte 2 — validité du contrôle

| Contexte | Rôle | Historique | Médiane C | MAD | Étendue | Seuil local | Écart | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1297 | opportunité forte | 20 | 10.00 | 0.00 | 10.00 | 10.00 | 10.00 | OK |
| 1433 | opportunité étroite sur BNB | 22 | 17.00 | 0.00 | 10.00 | 10.00 | 5.00 | OK |
| 1368 | favorable, déjà fortement exposé | 48 | 48.00 | 0.00 | 0.00 | 5.00 | 0.00 | OK |
| 1494 | contrôle négatif, suracheté | 10 | 20.00 | 0.00 | 13.00 | 13.00 | 10.00 | OK |

## Ordre d'entrelacement (déterministe, publié avant exécution)

Phase de validité : C sur les quatre contextes, entrelacé par contexte (5 tours).
Phase variantes : par tour et par contexte, rotation en carré latin de P/F/O — jamais
un bloc complet par variante. Les extensions éventuelles (contrôle négatif) suivent.

```
0:C@1297r1  1:C@1433r1  2:C@1368r1  3:C@1494r1  4:C@1297r2  5:C@1433r2  6:C@1368r2  7:C@1494r2
8:C@1297r3  9:C@1433r3  10:C@1368r3  11:C@1494r3  12:C@1297r4  13:C@1433r4  14:C@1368r4  15:C@1494r4
16:C@1297r5  17:C@1433r5  18:C@1368r5  19:C@1494r5  20:P@1297r1  21:F@1297r1  22:O@1297r1  23:F@1433r1
24:O@1433r1  25:P@1433r1  26:O@1368r1  27:P@1368r1  28:F@1368r1  29:P@1494r1  30:F@1494r1  31:O@1494r1
32:F@1297r2  33:O@1297r2  34:P@1297r2  35:O@1433r2  36:P@1433r2  37:F@1433r2  38:P@1368r2  39:F@1368r2
40:O@1368r2  41:F@1494r2  42:O@1494r2  43:P@1494r2  44:O@1297r3  45:P@1297r3  46:F@1297r3  47:P@1433r3
48:F@1433r3  49:O@1433r3  50:F@1368r3  51:O@1368r3  52:P@1368r3  53:O@1494r3  54:P@1494r3  55:F@1494r3
56:P@1297r4  57:F@1297r4  58:O@1297r4  59:F@1433r4  60:O@1433r4  61:P@1433r4  62:O@1368r4  63:P@1368r4
64:F@1368r4  65:P@1494r4  66:F@1494r4  67:O@1494r4  68:F@1297r5  69:O@1297r5  70:P@1297r5  71:O@1433r5
72:P@1433r5  73:F@1433r5  74:P@1368r5  75:F@1368r5  76:O@1368r5  77:F@1494r5  78:O@1494r5  79:P@1494r5
```

## Journal des appels

Exposition = exposition totale DEMANDÉE (100 − cash demandé), la grandeur mesurée.
Le détail par actif et la prose du modèle restent dans les artefacts locaux ignorés par Git.

| # | Mandat | Contexte | Rép. | Horodatage (UTC) | Issue | Expo. demandée | Action | Confiance | Modèle retourné | Rejeux transport |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | C | 1297 | 1 | 2026-08-23T04:33:20.511Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 1 | C | 1433 | 1 | 2026-08-23T04:33:48.615Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 2 | C | 1368 | 1 | 2026-08-23T04:34:20.405Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 3 | C | 1494 | 1 | 2026-08-23T04:34:43.161Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 4 | C | 1297 | 2 | 2026-08-23T04:35:24.974Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 5 | C | 1433 | 2 | 2026-08-23T04:35:45.841Z | accepted | 27.0 | rotate | medium | claude-sonnet-4-6 | 0 |
| 6 | C | 1368 | 2 | 2026-08-23T04:36:21.255Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 7 | C | 1494 | 2 | 2026-08-23T04:36:41.631Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 2 |
| 8 | C | 1297 | 3 | 2026-08-23T04:40:50.789Z | accepted | 20.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 9 | C | 1433 | 3 | 2026-08-23T04:41:20.554Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 10 | C | 1368 | 3 | 2026-08-23T04:41:52.600Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 11 | C | 1494 | 3 | 2026-08-23T04:42:11.580Z | accepted | 7.0 | rebalance | high | claude-sonnet-4-6 | 0 |
| 12 | C | 1297 | 4 | 2026-08-23T04:42:54.119Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 13 | C | 1433 | 4 | 2026-08-23T04:43:22.108Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 14 | C | 1368 | 4 | 2026-08-23T04:43:47.607Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 15 | C | 1494 | 4 | 2026-08-23T04:44:07.863Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 16 | C | 1297 | 5 | 2026-08-23T04:44:52.080Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 17 | C | 1433 | 5 | 2026-08-23T04:45:16.078Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 18 | C | 1368 | 5 | 2026-08-23T04:45:42.457Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 19 | C | 1494 | 5 | 2026-08-23T04:46:03.846Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 1 |
| 20 | P | 1297 | 1 | 2026-08-23T04:49:12.569Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 21 | F | 1297 | 1 | 2026-08-23T04:49:43.180Z | accepted | 20.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 22 | O | 1297 | 1 | 2026-08-23T04:50:12.674Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 23 | F | 1433 | 1 | 2026-08-23T04:50:34.195Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 24 | O | 1433 | 1 | 2026-08-23T04:51:00.825Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 25 | P | 1433 | 1 | 2026-08-23T04:51:26.755Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 26 | O | 1368 | 1 | 2026-08-23T04:51:55.991Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 27 | P | 1368 | 1 | 2026-08-23T04:52:13.837Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 28 | F | 1368 | 1 | 2026-08-23T04:52:36.850Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 29 | P | 1494 | 1 | 2026-08-23T04:52:58.976Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 1 |
| 30 | F | 1494 | 1 | 2026-08-23T04:56:04.437Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 31 | O | 1494 | 1 | 2026-08-23T04:56:46.792Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 32 | F | 1297 | 2 | 2026-08-23T04:57:31.112Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 33 | O | 1297 | 2 | 2026-08-23T04:57:52.948Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 34 | P | 1297 | 2 | 2026-08-23T04:58:18.682Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 35 | O | 1433 | 2 | 2026-08-23T04:58:44.136Z | accepted | 27.0 | rotate | medium | claude-sonnet-4-6 | 0 |
| 36 | P | 1433 | 2 | 2026-08-23T04:59:20.138Z | accepted | 27.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 37 | F | 1433 | 2 | 2026-08-23T05:00:00.002Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 38 | P | 1368 | 2 | 2026-08-23T05:00:33.675Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 39 | F | 1368 | 2 | 2026-08-23T05:00:54.486Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 40 | O | 1368 | 2 | 2026-08-23T05:01:14.370Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 41 | F | 1494 | 2 | 2026-08-23T05:01:34.301Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 2 |
| 42 | O | 1494 | 2 | 2026-08-23T05:05:47.886Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 1 |
| 43 | P | 1494 | 2 | 2026-08-23T05:08:46.586Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 44 | O | 1297 | 3 | 2026-08-23T05:09:30.730Z | accepted | 25.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 45 | P | 1297 | 3 | 2026-08-23T05:10:05.009Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 46 | F | 1297 | 3 | 2026-08-23T05:10:26.736Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 47 | P | 1433 | 3 | 2026-08-23T05:10:44.333Z | accepted | 27.0 | rotate | medium | claude-sonnet-4-6 | 0 |
| 48 | F | 1433 | 3 | 2026-08-23T05:11:26.811Z | accepted | 24.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 49 | O | 1433 | 3 | 2026-08-23T05:12:02.107Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 50 | F | 1368 | 3 | 2026-08-23T05:13:14.858Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 51 | O | 1368 | 3 | 2026-08-23T05:13:34.190Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 52 | P | 1368 | 3 | 2026-08-23T05:13:52.642Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 53 | O | 1494 | 3 | 2026-08-23T05:14:13.668Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 54 | P | 1494 | 3 | 2026-08-23T05:14:54.637Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 1 |
| 55 | F | 1494 | 3 | 2026-08-23T05:17:19.456Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 56 | P | 1297 | 4 | 2026-08-23T05:18:44.530Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 57 | F | 1297 | 4 | 2026-08-23T05:19:08.636Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 58 | O | 1297 | 4 | 2026-08-23T05:19:30.473Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 59 | F | 1433 | 4 | 2026-08-23T05:19:56.498Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 60 | O | 1433 | 4 | 2026-08-23T05:20:19.856Z | accepted | 27.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 61 | P | 1433 | 4 | 2026-08-23T05:20:55.365Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 62 | O | 1368 | 4 | 2026-08-23T05:21:21.172Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 63 | P | 1368 | 4 | 2026-08-23T05:21:42.810Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 64 | F | 1368 | 4 | 2026-08-23T05:22:04.592Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 65 | P | 1494 | 4 | 2026-08-23T05:22:24.700Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 66 | F | 1494 | 4 | 2026-08-23T05:22:59.586Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 2 |
| 67 | O | 1494 | 4 | 2026-08-23T05:27:10.085Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 1 |
| 68 | F | 1297 | 5 | 2026-08-23T05:29:31.130Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 69 | O | 1297 | 5 | 2026-08-23T05:29:54.534Z | accepted | 10.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 70 | P | 1297 | 5 | 2026-08-23T05:30:20.335Z | accepted | 20.0 | rebalance | medium | claude-sonnet-4-6 | 0 |
| 71 | O | 1433 | 5 | 2026-08-23T05:30:53.511Z | accepted | 24.0 | rotate | medium | claude-sonnet-4-6 | 0 |
| 72 | P | 1433 | 5 | 2026-08-23T05:31:26.191Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 73 | F | 1433 | 5 | 2026-08-23T05:31:56.854Z | accepted | 17.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 74 | P | 1368 | 5 | 2026-08-23T05:32:31.202Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 75 | F | 1368 | 5 | 2026-08-23T05:32:52.545Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 76 | O | 1368 | 5 | 2026-08-23T05:33:12.426Z | accepted | 48.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 77 | F | 1494 | 5 | 2026-08-23T05:33:28.740Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 78 | O | 1494 | 5 | 2026-08-23T05:34:03.551Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |
| 79 | P | 1494 | 5 | 2026-08-23T05:35:31.700Z | accepted | 20.0 | hold | medium | claude-sonnet-4-6 | 0 |

## Cellules — agrégats

| Mandat | Contexte | Appels | Acceptées | Invalides | Garde refusé | Contrat de sortie | Rejeux transport | Médiane expo. | MAD | Étendue | Confiance (l/m/h) | Ouvertures ligne à zéro |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C | 1297 | 5 | 5 | 0 | 0 | 0 | 0 | 10.00 | 0.00 | 10.00 | low 0 / medium 5 / high 0 | 1 |
| C | 1433 | 5 | 5 | 0 | 0 | 0 | 0 | 17.00 | 0.00 | 10.00 | low 0 / medium 5 / high 0 | 1 |
| C | 1368 | 5 | 5 | 0 | 0 | 0 | 0 | 48.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| C | 1494 | 5 | 5 | 0 | 0 | 0 | 3 | 20.00 | 0.00 | 13.00 | low 0 / medium 4 / high 1 | 0 |
| P | 1297 | 5 | 5 | 0 | 0 | 0 | 0 | 10.00 | 0.00 | 10.00 | low 0 / medium 5 / high 0 | 1 |
| P | 1433 | 5 | 5 | 0 | 0 | 0 | 0 | 17.00 | 0.00 | 10.00 | low 0 / medium 5 / high 0 | 2 |
| P | 1368 | 5 | 5 | 0 | 0 | 0 | 0 | 48.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| P | 1494 | 5 | 5 | 0 | 0 | 0 | 2 | 20.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| F | 1297 | 5 | 5 | 0 | 0 | 0 | 0 | 10.00 | 0.00 | 10.00 | low 0 / medium 5 / high 0 | 1 |
| F | 1433 | 5 | 5 | 0 | 0 | 0 | 0 | 17.00 | 0.00 | 7.00 | low 0 / medium 5 / high 0 | 1 |
| F | 1368 | 5 | 5 | 0 | 0 | 0 | 0 | 48.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| F | 1494 | 5 | 5 | 0 | 0 | 0 | 4 | 20.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| O | 1297 | 5 | 5 | 0 | 0 | 0 | 0 | 10.00 | 0.00 | 15.00 | low 0 / medium 5 / high 0 | 1 |
| O | 1433 | 5 | 5 | 0 | 0 | 0 | 0 | 24.00 | 3.00 | 10.00 | low 0 / medium 5 / high 0 | 3 |
| O | 1368 | 5 | 5 | 0 | 0 | 0 | 0 | 48.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |
| O | 1494 | 5 | 5 | 0 | 0 | 0 | 2 | 20.00 | 0.00 | 0.00 | low 0 / medium 5 / high 0 | 0 |

## Lecture préenregistrée

### Porte placebo

- contexte 1297 : P déplace l'exposition d'au moins le seuil : **non** ; P déplace la confiance : non
- contexte 1368 : P déplace l'exposition d'au moins le seuil : **non** ; P déplace la confiance : non
- contexte 1433 : P déplace l'exposition d'au moins le seuil : **non** ; P déplace la confiance : non
- contexte 1494 : P déplace l'exposition d'au moins le seuil : **non** ; P déplace la confiance : non

Placebo inerte (ne déplace ni l'exposition ni la confiance nulle part) : **OUI — la porte placebo n'a rien testé, le placebo est raté**

### Contextes favorables (1297, 1433, 1368)

| Mandat | Contexte | Effet (pts) | Seuil | ≥ seuil | Reproduit par P | Majorité au-dessus | Validité | **Effet retenu** |
|---|---|---|---|---|---|---|---|---|
| P | 1297 | 0.00 | 10.00 | non | non | non | oui | **non** |
| P | 1433 | 0.00 | 10.00 | non | non | non | oui | **non** |
| P | 1368 | 0.00 | 5.00 | non | non | non | oui | **non** |
| F | 1297 | 0.00 | 10.00 | non | non | non | oui | **non** |
| F | 1433 | 0.00 | 10.00 | non | non | non | oui | **non** |
| F | 1368 | 0.00 | 5.00 | non | non | non | oui | **non** |
| O | 1297 | 0.00 | 10.00 | non | non | non | oui | **non** |
| O | 1433 | 7.00 | 10.00 | non | non | oui | oui | **non** |
| O | 1368 | 0.00 | 5.00 | non | non | non | oui | **non** |

### Contrôle négatif (1494)

| Mandat | Dégradation médiane (pts) | Seuil | Éliminé (médiane) | Ouvertures ligne à zéro | Éliminé (ouvertures) |
|---|---|---|---|---|---|
| P | 0.00 | 13.00 | non | 0/5 | non |
| F | 0.00 | 13.00 | non | 0/5 | non |
| O | 0.00 | 13.00 | non | 0/5 | non |

### Cycles morts

Réponses primaires invalides ou refusées, total sur les quatre contextes — contrôle : 0.

- P : 0 — acceptable
- F : 0 — acceptable
- O : 0 — acceptable

### Distribution de `confidence` par mandat (toutes cellules)

- C : low 0 / medium 19 / high 1
- P : low 0 / medium 20 / high 0
- F : low 0 / medium 20 / high 0
- O : low 0 / medium 20 / high 0

## Synthèse (mécanique, depuis les règles préenregistrées)

- **F : pas d'effet au sens préenregistré.** C'est un résultat valide : cette formulation n'est pas la cause principale du niveau d'exposition observé.
- **O : pas d'effet au sens préenregistré.** C'est un résultat valide : cette formulation n'est pas la cause principale du niveau d'exposition observé.

## Hors périmètre, rappel

Aucune modification du prompt actif, aucune écriture en base, aucun ordre. Ce résultat
mesure un levier comportemental ; il ne dit rien du rendement, et même un résultat
positif ne déclenche aucune modification de production.
