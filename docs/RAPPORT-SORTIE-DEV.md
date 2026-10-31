# Rapport : règle de sortie et de rachat, développement

Protocole : `docs/PROTOCOLE-SORTIE-v0.3.md` (v0.2 + amendements A0 à A3 du 31/10/2026, audit §14 et précisions d'exécution §15).
Artefacts : `out/bench-exit/development/summary.json` et `manifest.json`, produits par `npm run bench:exit:dev`.

## Verdict du §11 : aucune candidate

**Aucune candidate ne remplit les conditions du §11.** Les cinq dépassent la limite éliminatoire de 50 % de drawdown continu (S4 la plus proche, 52,40 %). Toutes remplissent en revanche l'exigence de frottements, avec 22 à 39 % des frais et du glissement d'E1.

Conséquence, par A2 : aucune ouverture de la fenêtre scellée, aucune modification de production, aucun changement de seuil ni de la limite de 50 %. Toute nouvelle tentative exige une nouvelle expérience préenregistrée. Le bootstrap n'a pas été calculé : sa méthode ne s'applique que si une candidate est retenue.

## Chronologie et provenance

| Étape | Commit | Heure |
|---|---|---|
| Protocole v0.3 (copie de v0.2 + A0 à A3) | `8d934f0` | 31/10/2026 10:23 (UTC+1) |
| Implémentation vérifiée sur données synthétiques, audit §14 et précisions §15 | `d7d0026` | 10:38:48 |
| **Gel** : `out/bench-exit/freeze.json` (paramètres, politiques, sélection, méthode du bootstrap, date de début, épisodes) | **`8602ba7`** | 10:38:51, poussé avant le rejeu |
| Rejeu du développement, exécuté sur l'arbre du gel | manifeste : `crypto_buddy_commit` = `8602ba7` | après le push |

Le rejeu refuse de tourner si le gel n'est pas commité à HEAD, si `src/`, `package-lock.json` ou le protocole diffèrent de ce que le gel a signé, ou si la date de début et les épisodes recalculés diffèrent des valeurs gelées. Aucun paramètre n'a été modifié après lecture d'un résultat. La fenêtre scellée n'a été ni lue ni ouverte.

## Fenêtre et épisodes (rappel du §14, gelés avant le rejeu)

Développement `[2020-10-01, 2024-07-01)`, 1 369 jours. La date est fixée par la SMA50 journalière de SOL, dernière brique du contexte global à devenir disponible.

| # | Début | Creux | Profondeur de l'indice | Fin |
|---|---|---|---|---|
| 1 | 2021-05-12 | 2021-07-21 | 55,05 % | 2021-10-30, retrouvé |
| 2 | 2021-11-09 | 2022-06-19 | 74,22 % | fin des données, non retrouvé |

## Tableau principal

Capital de départ 1 000 $ pour chaque politique. Le drawdown est continu, mesuré depuis le plus-haut de toute la trajectoire, sur l'equity de clôture 4h. Une rotation de 10× signifie un volume échangé égal à dix fois l'equity moyenne.

| Politique | Rendement net | Annualisé | Drawdown continu | Frais + glissement | Rotation | Sorties (événements) | Cash moyen | Entièrement en cash | Retard de rachat ép. 1 | ép. 2 |
|---|---|---|---|---|---|---|---|---|---|---|
| E0 | 962,0 % | 87,8 % | **75,52 %** | 79 $ (53 + 26) | 8,4× | 0 (0) | 0,4 % | 0,0 % | 0,0 j | 0,0 j |
| E1 | 490,1 % | 60,6 % | **71,83 %** | 708 $ (472 + 236) | 108,5× | 199 (174) | 24,4 % | 7,1 % | 2,2 j | 6,3 j |
| TC44 | 157,0 % | 28,6 % | **49,33 %** | 312 $ (208 + 104) | 96,7× | 199 (174) | 60,9 % | 7,1 % | non revenu | non revenu |
| S1 | 745,3 % | 76,7 % | **59,63 %** | 250 $ (167 + 83) | 33,1× | 68 (64) | 38,8 % | 24,7 % | 20,2 j | 209,2 j |
| S2 | 779,6 % | 78,6 % | **57,91 %** | 158 $ (105 + 53) | 19,6× | 35 (33) | 39,0 % | 24,8 % | 24,2 j | 210,2 j |
| S3 | 960,6 % | 87,8 % | **54,43 %** | 274 $ (183 + 91) | 27,5× | 45 (37) | 31,5 % | 14,9 % | 7,8 j | 31,2 j |
| S4 | 1 136,7 % | 95,6 % | **52,40 %** | 275 $ (183 + 92) | 25,4× | 42 (35) | 33,8 % | 18,0 % | 7,8 j | 31,2 j |
| S5 | 1 069,1 % | 92,7 % | **58,81 %** | 170 $ (113 + 57) | 17,1× | 24 (6) | 33,5 % | 33,0 % | 7,5 j | 139,2 j |

Définitions (§15) :

- **Sorties** : lignes détenues sorties par la règle (S) ou par le stop (E1, TC44).
- **Cash moyen** : 100 moins l'exposition moyenne réalisée.
- **Entièrement en cash** : part des clôtures 4h à moins de 1 % d'exposition.
- **Retard de rachat** : jours entre le creux de l'indice et la première clôture 4h à au moins 80 % d'exposition réalisée. TC44 vise 44 % et ne peut jamais l'atteindre.

## Application du §11

Plafond de frottements : la moitié des 707,66 $ d'E1, soit 353,83 $.

| Candidate | Drawdown continu | ≤ 50 % | Frais + glissement | Part d'E1 | ≤ 50 % d'E1 | Annualisé | Retenue |
|---|---|---|---|---|---|---|---|
| S1 | 59,63 % | **non** | 250 $ | 35,4 % | oui | 76,7 % | non |
| S2 | 57,91 % | **non** | 158 $ | 22,3 % | oui | 78,6 % | non |
| S3 | 54,43 % | **non** | 274 $ | 38,7 % | oui | 87,8 % | non |
| S4 | 52,40 % | **non** | 275 $ | 38,8 % | oui | 95,6 % | non |
| S5 | 58,81 % | **non** | 170 $ | 24,0 % | oui | 92,7 % | non |

Aucune candidate ne reste après le premier critère : la préférence de simplicité ne s'applique pas.

## Où la limite casse

Dates lues sur l'equity 4h de chaque politique, à titre descriptif.

| Politique | Plus-haut de référence | Premier passage au-delà de 50 % | Pire drawdown |
|---|---|---|---|
| S1 | 2021-05-12 | 2021-05-23 | 2023-03-10 (59,63 %) |
| S2 | 2021-05-12 | 2021-05-23 | 2023-03-10 (57,91 %) |
| S5 | 2021-05-12 | 2021-05-23 | 2021-07-29 (58,81 %) |
| S3 | 2021-11-10 | 2022-11-09 | 2023-01-06 (54,43 %) |
| S4 | 2021-11-10 | 2022-12-02 | 2023-01-06 (52,40 %) |
| E0 | 2021-11-10 | 2021-05-23 (depuis un plus-haut antérieur) | 2022-06-18 (75,52 %) |
| E1 | 2021-11-10 | 2022-05-07 | 2022-11-09 (71,83 %) |
| TC44 | 2021-11-10 | jamais | 2022-06-18 (49,33 %) |

Deux mécanismes distincts :

- **Filtres sur la moyenne 200 jours (S1, S2, S5)** : ils franchissent 50 % dès le krach de mai 2021. L'indice perd 30 % en huit jours (du 12 au 20 mai) et 55 % en dix semaines, alors que les cours sont encore loin au-dessus de leur moyenne 200 jours au moment de la chute. S1 et S2 ne retrouvent jamais leur plus-haut de mai 2021 ; leur pire point arrive en mars 2023, après les allers-retours de 2022-2023 autour de la moyenne.
- **Stops suiveurs à 20 % (S3, S4)** : ils traversent mai 2021 avec 26 et 23 % de drawdown, et finissent 2021 nettement devant E0. Ils cassent fin 2022 : la descente de 2022 se fait par paliers, chaque rachat sur recroisement de la moyenne 50 jours est suivi d'une nouvelle baisse de 20 %, et les pertes s'additionnent depuis le plus-haut de novembre 2021.

## Par année civile

Rendement de l'année / pire drawdown continu atteint dans l'année. 2020 couvre le seul quatrième trimestre ; 2024, le premier semestre.

| Politique | 2020 (T4) | 2021 | 2022 | 2023 | 2024 (S1) |
|---|---|---|---|---|---|
| E0 | 87,7 % / 19,2 % | 386,6 % / 57,1 % | −60,1 % / 75,5 % | 100,5 % / 71,3 % | 45,4 % / 46,2 % |
| E1 | 88,4 % / 15,5 % | 229,8 % / 42,1 % | −56,4 % / 71,8 % | 73,3 % / 70,5 % | 25,8 % / 51,8 % |
| TC44 | 44,3 % / 6,7 % | 77,3 % / 26,8 % | −33,1 % / 49,3 % | 34,8 % / 45,7 % | 11,3 % / 29,4 % |
| S1 | 85,0 % / 19,2 % | 168,2 % / 54,3 % | −17,9 % / 58,4 % | 43,6 % / 59,6 % | 44,5 % / 44,1 % |
| S2 | 85,0 % / 19,2 % | 204,8 % / 51,7 % | −22,8 % / 55,7 % | 40,5 % / 57,9 % | 43,7 % / 42,3 % |
| S3 | 109,8 % / 19,2 % | 277,3 % / 25,8 % | −41,5 % / 54,1 % | 79,3 % / 54,4 % | 27,7 % / 27,8 % |
| S4 | 109,8 % / 19,2 % | 301,6 % / 22,8 % | −38,9 % / 52,1 % | 80,8 % / 52,4 % | 32,8 % / 24,9 % |
| S5 | 87,7 % / 19,2 % | 256,6 % / 58,8 % | −20,5 % / 54,0 % | 51,1 % / 55,0 % | 45,4 % / 33,9 % |

## Par épisode (descriptif, §9)

« DD propre » : drawdown mesuré depuis le plus-haut de la politique à partir du début de l'épisode. « DD continu » : pire drawdown depuis le plus-haut de toute la trajectoire, atteint pendant l'épisode.

| Politique | Ép. 1 : rendement | DD propre | DD continu | Ép. 2 : rendement | DD propre | DD continu |
|---|---|---|---|---|---|---|
| E0 | 0,2 % | 57,1 % | 57,1 % | −15,1 % | 75,5 % | 75,5 % |
| E1 | 20,3 % | 42,1 % | 42,1 % | −34,8 % | 71,8 % | 71,8 % |
| TC44 | 3,9 % | 26,8 % | 26,8 % | −18,1 % | 49,3 % | 49,3 % |
| S1 | −35,3 % | 54,3 % | 54,3 % | 21,6 % | 43,8 % | 59,6 % |
| S2 | −28,9 % | 51,7 % | 51,7 % | 14,1 % | 46,9 % | 57,9 % |
| S3 | 28,0 % | 25,8 % | 25,8 % | 6,1 % | 54,4 % | 54,4 % |
| S4 | 40,6 % | 22,8 % | 22,8 % | 16,2 % | 52,4 % | 52,4 % |
| S5 | −26,4 % | 58,8 % | 58,8 % | 27,6 % | 44,9 % | 55,0 % |

## Distribution de l'exposition réalisée

En % de l'equity, sur les clôtures 4h.

| Politique | Moyenne | Médiane | Q1 | Q3 | P90 | 0-20 | 20-50 | 50-80 | 80-100 |
|---|---|---|---|---|---|---|---|---|---|
| E0 | 99,6 | 100,0 | 100,0 | 100,0 | 100,0 | 0,0 % | 0,0 % | 0,0 % | 100,0 % |
| E1 | 75,6 | 89,9 | 55,0 | 100,0 | 100,0 | 10,8 % | 9,6 % | 14,6 % | 64,9 % |
| TC44 | 39,1 | 43,9 | 42,6 | 44,6 | 45,5 | 10,9 % | 89,1 % | 0,0 % | 0,0 % |
| S1 | 61,2 | 83,4 | 14,4 | 100,0 | 100,0 | 29,2 % | 5,1 % | 11,1 % | 54,5 % |
| S2 | 61,0 | 83,4 | 13,9 | 100,0 | 100,0 | 30,0 % | 5,0 % | 11,9 % | 53,1 % |
| S3 | 68,5 | 84,3 | 47,6 | 100,0 | 100,0 | 17,6 % | 8,6 % | 17,3 % | 56,5 % |
| S4 | 66,2 | 83,8 | 45,4 | 100,0 | 100,0 | 20,9 % | 8,1 % | 15,5 % | 55,6 % |
| S5 | 66,5 | 98,1 | 0,0 | 100,0 | 100,0 | 33,0 % | 0,0 % | 0,1 % | 66,8 % |

Part du temps où chaque candidate tient un actif hors marché :

| Candidate | BTC | ETH | BNB | XRP | Rachats décidés |
|---|---|---|---|---|---|
| S1 | 39,7 % | 32,9 % | 38,4 % | 48,1 % | 67 |
| S2 | 39,4 % | 33,6 % | 39,2 % | 47,3 % | 34 |
| S3 | 30,5 % | 26,7 % | 29,4 % | 45,1 % | 44 |
| S4 | 32,7 % | 29,1 % | 32,7 % | 46,1 % | 41 |
| S5 | 33,0 % | 33,0 % | 33,0 % | 33,0 % | 24 |

## Contrôles

- **A1** : zéro clôture 4h, pour toutes les politiques, où une ligne sortie par la règle pèse encore quelque chose après l'exécution de sa sortie.
- **Reproduction de v1.3** : avant le gel, le chemin E0 reproduit au millionième de dollar l'equity finale publiée par v1.3 pour T100 sans stop sur 2021-2022 (1 891,421455 $), et T100 (= E1) reste inchangé (1 418,901502 $). Les 129 preuves du banc v1.3 passent toujours.
- **Ordres en attente à la frontière** : au plus un par politique, compté `pending_not_executed`, comme en v1.3.

## Lecture

- **Objectif de frottements : atteint par toutes les candidates.** Les frais et le glissement tombent de 708 $ (E1) à 158–275 $, la rotation de 108× à 17–33×. 93 % de la rotation d'E1 vient du stop (50,5×) et de son rachat (50,7×).
- **Objectif de drawdown : manqué par toutes.** Aucune règle de ce jeu préenregistré ne tient l'enveloppe entière sous 50 % sur ce développement. Les filtres lents sur la moyenne 200 jours sont pris de vitesse par un krach rapide (mai 2021). Les stops suiveurs survivent au krach rapide mais s'usent dans une baisse longue en paliers (2022).
- **Rien ici n'est une preuve, dans un sens comme dans l'autre.** La période est consommée (§6), sa trajectoire est unique, et elle commence en plein marché haussier (indice multiplié par 11,5 jusqu'en mai 2021). Les écarts de rendement entre candidates sont descriptifs et n'entrent dans aucune décision, puisqu'aucune ne passe le premier critère.
- **Seul comparateur admissible : TC44** (49,33 %), qui vise 44 % d'exposition. Le constat du banc v1.3 se confirme sur une fenêtre plus longue : aucune politique visant une exposition élevée ne reste sous 50 %.
- Par A2, ce rapport ne propose pas de nouveaux seuils. Une suite éventuelle relève d'une nouvelle expérience préenregistrée, décidée par Julien.
