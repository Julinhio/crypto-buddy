# Protocole v0.3 : règle de sortie et de rachat, Crypto-Buddy

Copie du protocole v0.2 (cadré par Alex et Claude le 17/10/2026, sans code), augmentée des amendements A0 à A3 décidés par Julien le 31/10/2026, avant tout code et toute mesure. Ne cherche pas à sauver SCORE : nouvelle architecture de sortie. Les amendements sont reportés à leur place dans le texte et repris en fin de document ; l'audit de faisabilité de Ben (§14) et ses précisions d'exécution (§15) ont été écrits et commités avant le premier rejeu mesuré.

## 0. Préambule (A0)

Cette expérience hors ligne peut démarrer avant la clôture du pilote A (1er novembre 2026, 11h46 UTC). Sa lecture officielle sera analysée séparément et ne modifiera pas les règles après les résultats. *(A0 remplace la mention du préambule v0.2 qui imposait de confronter le protocole à la lecture officielle du pilote avant le gel.)*

## 1. Question

À partir d'une cible constante de 100 % avec des poids fixes, une règle déterministe de sortie et de rachat peut-elle maintenir le drawdown continu sous 50 % tout en réduisant fortement les allers-retours et les frais du mécanisme actuel ?

## 2. Ce qui est fixe

Cible de 100 %, poids 32,5/32,5/20/15, plafonds 35/35/20/15, frais, glissement et exécution du banc v1.3. Aucune sélection par score ni par le modèle. Limite dure : 50 % de drawdown continu.

## 3. Ce qui varie

Uniquement la mécanique de sortie, de maintien hors marché et de rachat, avec sa cadence. **Pour S1 à S5, la règle candidate remplace entièrement le stop actuel** (10 % armé en transition) : aucun autre mécanisme de sortie ne s'y ajoute.

**A1.** Une sortie déclenchée par la règle candidate vise zéro sur la ligne concernée. Aucun plancher, aucune bande ni aucun correctif d'exposition ne peut recréer cette position. Tout reliquat d'exécution reste visible et journalisé, jamais masqué. *(Retour du pilote : les cycles 3098 et 3100 ont remis ~3,33 % sur BTC, ETH et XRP alors que le modèle visait 0.)*

## 4. Temporalité

- Les règles journalières décident sur la clôture journalière UTC et exécutent à l'ouverture suivante. Aucune décision n'utilise une bougie non close.
- Le drawdown est observé sur l'equity à chaque clôture de 4 heures, comme dans le banc v1.3.

## 5. Interaction avec la porte de transition (confirmée par l'audit, §14.1)

- Une sortie décidée par une candidate a la priorité d'une sortie de stop : un gel de transition ne la bloque pas.
- Un rachat respecte la porte : une ligne gelée n'est pas rachetée tant que le gel dure.

## 6. Données

- Développement : période antérieure au 1er juillet 2024, à partir de la première date où toutes les politiques (références et candidates) disposent de leurs indicateurs de façon causale, SOL et contexte global compris. Date calculée mécaniquement et publiée (§14.2).
- Toute cette période est déjà consommée : apprentissage et lectures par sous-période seulement, jamais preuve indépendante.
- Fenêtre scellée `[2024-07-01, 2026-06-01)` fermée jusqu'au gel d'une seule candidate.

## 7. Références, rejouées sans être candidates

- **E0** : 100 % sans aucun stop.
- **E1** : mécanisme actuel, stop à 10 % armé en transition, rachat sur `trend_up` ou `reversal_up` confirmé.
- **TC44** : cible constante de 44,226403 %, règles du protocole v1.3.

## 8. Candidates, ensemble fini, paramètres fixés à l'avance

- **S1, filtre de tendance journalier par actif** : un actif est détenu quand sa clôture journalière est au-dessus de sa moyenne 200 jours, hors marché sinon.
- **S2, S1 avec hystérésis** : sortie d'un actif sous 97 % de sa moyenne 200 jours, rachat seulement au-dessus de 103 %.
- **S3, stop suiveur large toujours armé** : sortie à 20 % sous le plus-haut, évaluée à la clôture journalière. Le plus-haut est la plus haute clôture journalière UTC observée depuis l'exécution de l'entrée, réinitialisé à chaque rachat ; les plus-hauts intrajournaliers ne sont pas utilisés. Rachat quand la clôture journalière repasse au-dessus de la moyenne 50 jours.
- **S4, S3 avec délai minimum** : comme S3, avec au moins 10 jours hors marché avant tout rachat.
- **S5, filtre global journalier avec hystérésis** : indice synthétique du panier, rééquilibré quotidiennement aux poids 32,5/32,5/20/15, calculé à partir des rendements clôture à clôture. Sortie complète quand sa clôture journalière passe sous 97 % de sa moyenne 200 jours, rachat complet seulement au-dessus de 103 %.
- **Part d'un actif sorti (S1 à S4)** : elle reste en cash, sans redistribution sur les autres actifs.
- **A3.** Les paramètres sont figés tels qu'écrits : 97/103 %, stop suiveur 20 %, moyenne 50 jours, 10 jours minimum hors marché, moyenne 200 jours. Pas de grille de recherche. *(A3 remplace la mention v0.2 « à confirmer avant exécution, puis figées ».)*

## 9. Épisodes de krach, définis avant tout résultat

Un épisode est une baisse de l'indice synthétique du panier (celui de S5) d'au moins 30 % depuis son plus-haut glissant. Il commence au dernier plus-haut avant ce franchissement et se termine quand l'indice retrouve ce plus-haut, ou à la fin des données. Les épisodes sont listés avant tout rejeu (§14.3). Le drawdown de chaque politique par épisode est publié à titre descriptif. Le seul critère éliminatoire reste le drawdown continu global de 50 %.

## 10. Mesures publiées pour chaque politique

Rendement net, drawdown continu, rotation, frais et glissement, nombre de sorties, temps passé en cash, distribution de l'exposition, résultats par année civile et par épisode. **Retard de rachat** : délai entre le creux d'un épisode de l'indice du panier et le premier retour à au moins 80 % d'exposition réalisée (« non revenu » si jamais atteint avant la fin des données).

## 11. Sélection sur le développement, règle préenregistrée

- Éliminatoire : drawdown continu supérieur à 50 %.
- Exigence de frottements : frais et glissement cumulés au plus égaux à la moitié de ceux d'E1.
- Parmi les candidates restantes, meilleur rendement net. À moins de 3 points annualisés d'écart, préférence à la plus simple, dans l'ordre S1, S5, S2, S3, S4.
- Si aucune candidate ne remplit ces conditions, rien ne part en validation et le résultat est publié.
- **A2.** Si aucune candidate ne remplit les conditions du §11 : aucune ouverture de la fenêtre scellée, aucune modification de production. Ni les seuils ni la limite de 50 % ne changent après lecture des résultats. Toute nouvelle tentative exige une nouvelle expérience préenregistrée.

## 12. Validation scellée, verdict propre à cette expérience

- Une seule candidate figée et commitée avec ses paramètres, ce verdict et les paramètres du bootstrap : bootstrap stationnaire, longueur de bloc Politis-White calculée sur le développement seul pour chaque comparaison, 10 000 tirages, graine 20261101, borne unilatérale à 95 %.
- E0, E1 et TC44 rejoués comme comparateurs sur la même trajectoire continue.
- Admissibilité d'abord : drawdown continu inférieur ou égal à 50 % pour la candidate et pour chaque comparateur. Un comparateur non admissible reste publié mais n'entre pas dans le verdict.
- **Preuve forte** : candidate admissible, avance d'au moins 5 points de rendement annualisé net sur le meilleur comparateur admissible, borne inférieure du bootstrap positive face à lui.
- **Avantage pratique** : candidate admissible, avance d'au moins 5 points sur le meilleur comparateur admissible, intervalle incluant zéro.
- **Viable sans comparateur admissible** : candidate admissible, aucun comparateur admissible.
- **Non retenue** : candidate non admissible, ou avance inférieure à 5 points sur le meilleur comparateur admissible.

## 13. Hors périmètre

Toute modification de production. La règle retenue ne pourra passer en production qu'après le chantier d'exécution autonome (cadence fixe, stop indépendant du modèle), puis l'accord explicite de Julien. La PR #50 ne se merge qu'après clôture et lecture officielle du pilote, sur autorisation explicite de Julien.

## 14. Audit de faisabilité (Ben, avant tout rejeu)

*À compléter par l'audit, avant le gel.*

## 15. Précisions d'exécution (Ben, avant tout rejeu)

*À compléter par l'audit, avant le gel.*

## Amendements du 31/10/2026 (Julien), avant tout code et toute mesure

- **A0** — démarrage avant la clôture du pilote, lecture du pilote analysée à part et sans effet sur les règles (§0).
- **A1** — une sortie candidate vise zéro ; rien ne recrée la position ; tout reliquat est journalisé (§3).
- **A2** — sans candidate qualifiée : ni fenêtre scellée, ni production, ni changement de seuil ; nouvelle tentative = nouvelle expérience préenregistrée (§11).
- **A3** — paramètres figés tels qu'écrits, sans grille (§8).
