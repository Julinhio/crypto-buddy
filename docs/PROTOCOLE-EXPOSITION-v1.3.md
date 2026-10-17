# Protocole de mesure, politique d'exposition Crypto-Buddy, v1.3

Validé par Julien, Alex et Claude le 17/10/2026, après l'audit `docs/AUDIT-PROTOCOLE-EXPOSITION.md` (Ben, commit `d6ba853`).

## 1. Objectif

Maximiser le rendement net sous une limite dure de 50 % de drawdown, face à T100 et aux règles simples.

## 2. Mandat

Aucun cash permanent ni réserve structurelle. Toute l'enveloppe est mobilisable. L'exposition varie de 0 à 100 % selon la force mesurée de la situation, sans obligation d'être à 100 %. Les limites de concentration par actif sont conservées. La confiance déclarée par le modèle n'entre pas dans le dimensionnement.

## 3. Données

- Bundle v2 produit par `crypto-lab`, contenant physiquement uniquement les bougies dont l'ouverture est antérieure au `2024-07-01`, SOL compris (risk_off calculé sur 5 actifs comme en production).
- Partie scellée produite à part, SHA-256 épinglé et commité, fichiers hors du dépôt jusqu'à l'ouverture.
- Test de préfixe à l'ouverture : la timeline calculée sur les données complètes doit être identique, barre pour barre, à celle de la calibration sur `[.., 2024-07-01)`. Test écrit et exercé dès maintenant sur données synthétiques.
- Ni funding, ni série longue pour l'ATH.

## 4. Fenêtres

- Calibration `[2021-01-01, 2024-07-01)` :
  - développement `[2021-01-01, 2023-01-01)` ;
  - vérification interne `[2023-01-01, 2024-07-01)`.
- Paramètres, seuils, normalisations et seuil de rééquilibrage appris sur le développement seul, jamais réajustés ensuite.
- Embargo à chaque frontière : aucun signal dont l'horizon traverse une frontière n'entre dans un ajustement. Le dernier ordre d'une fenêtre reste `pending_not_executed` et traverse la frontière comme état.
- Pas de rejeu inverse.
- Validation scellée `[2024-07-01, 2026-06-01)`, ouverte une seule fois.
- Pilote vivant : contrefactuel mécanique à décisions figées, lu à part.

## 5. Préalable

- Valeur prédictive des composantes candidates du score, mesurée sur le rendement futur du panier à poids fixes, pas sur chaque actif.
- Signal connu à la clôture, rendement depuis l'ouverture suivante, horizons fixés à l'avance, erreurs-types de Newey-West avec retard égal à l'horizon moins un pas.
- Mesuré sur le **développement uniquement** avant le gel des variantes de SCORE. La stabilité sur la vérification interne n'est regardée qu'après ce gel, comme partie de la vérification.
- Seuils hérités de la production (confirmations, RSI, largeur, stop 10 %) figés, jamais réajustés.

## 6. Architectures

- **T100**, témoin : cible 100 % constante, même fonction de porte avec `riskOffConfirmed` forcé à faux.
- **R100/0**, règle simple : cible 100 %, ramenée à 0 % en risk_off global confirmé.
- **RPA**, règle simple : chaque actif sort quand son régime baissier est confirmé, ne revient qu'une fois son régime neutre ou haussier confirmé, jamais pendant une transition. Sortie totale en risk_off global confirmé.
- **SCORE** : score de conviction calculé par le code, transformé en cible exacte entre 0 et 100 %. Ensemble fini de variantes (composantes, pondérations, seuils), préenregistré avant exécution.
- **Exploratoire**, hors sélection : dimensionnement par le risque, seulement une fois un stop initial déterministe et son contrat complet figés.
- Une cible de 100 % n'est pas une promesse d'exposition réalisée permanente.

## 7. Règles communes

- Poids 32,5 / 32,5 / 20 / 15, plafonds 35 / 35 / 20 / 15. Cette pondération remplace explicitement la pondération proportionnelle aux plafonds du banc PR #36.
- Ligne stoppée : 0. Ligne gelée, sans régime ou sans prix : garde son poids courant (fail-closed, comme `capabilityOf` en production).
- Un surpoids gelé consomme le budget et comprime les lignes libres. Si le budget devient négatif, les lignes libres vont à 0 et la sur-exposition résiduelle est publiée.
- Budget restant réparti par `waterfill` au prorata des poids entre lignes éligibles, dans la limite de leurs plafonds (ou de leur poids courant si elles ne peuvent que baisser).
- Ce qui ne trouve pas de place reste en cash, journalisé `capacite_insuffisante`. Jambe sous le plancher de 2 % abandonnée, journalisée `reliquat_inexecutable`, jamais redistribuée une seconde fois.
- Réentrée après un stop, toutes architectures : jamais pendant une transition ni en régime baissier confirmé ; automatique dès qu'un régime neutre ou haussier est confirmé.
- Exécution : même fonction de porte, `planMovements` de production (achats au prorata), mêmes prix, frais et glissement.
- Seuil de rééquilibrage : porte sur la variation de l'exposition totale, distinct du plancher de 2 % par ligne, méthode de sélection gelée avec la politique.

## 8. Usage réel de la plage

- Toutes architectures : distribution réelle de l'exposition publiée (médiane, quartiles, 90e centile, temps dans 0-20, 20-50, 50-80, 80-100 %).
- SCORE uniquement : exposition médiane d'au moins 80 % dans le décile de conviction le plus élevé, sur chaque fenêtre évaluée.

## 9. Drawdown

Continu depuis le plus-haut de toute la trajectoire, sur l'équité de clôture 4h. La limite de 50 % s'applique aux seules politiques susceptibles d'être retenues (R100/0, RPA, SCORE), jamais à T100.

## 10. Ordre de décision et verdicts

1. Admissibilité : pour R100/0, RPA et SCORE, drawdown inférieur ou égal à 50 % et exigences propres remplies.
2. Les comparaisons décisionnelles ne portent qu'entre politiques admissibles.
3. T100 est toujours publié, et n'entre dans le verdict que s'il respecte lui-même la limite de 50 %.
4. SCORE doit conserver une avance d'au moins 5 points de rendement annualisé face à la meilleure règle simple admissible.
5. Une politique non admissible reste dans le rapport, à titre descriptif.

Sélection en calibration : une seule candidate, figée et commitée avec cette règle de décision et les paramètres du bootstrap avant l'ouverture. En validation, T100, R100/0 et RPA sont rejoués comme comparateurs ; seule la candidate figée reçoit un verdict.

Verdicts :

- **Preuve forte** : admissible, exigence de simplicité remplie, borne inférieure unilatérale à 95 % positive face à chaque comparateur admissible requis.
- **Avantage pratique** : admissible, exigence de simplicité remplie, avance d'au moins 5 points face aux comparateurs admissibles requis, intervalle incluant zéro.
- **Viable sans comparateur admissible** : admissible, mais aucune autre politique admissible ne permet de comparaison décisionnelle. Peut entrer dans un nouveau pilote, sans affirmation de supériorité.
- **Non retenue** : drawdown supérieur à 50 %, perte face à un comparateur admissible requis, ou SCORE ne justifiant pas sa complexité face à la meilleure règle simple admissible.

Une preuve forte ou un avantage pratique autorise un nouveau pilote ; l'avantage pratique est présenté comme une hypothèse prometteuse. Si aucune politique n'est admissible en calibration, rien ne part en validation, le résultat est publié et une nouvelle expérience sur la règle de sortie est préenregistrée. La limite n'est jamais relâchée après coup.

## 11. Bootstrap

- Série : différence quotidienne des rendements logarithmiques candidate moins comparateur.
- Bootstrap stationnaire par blocs, longueur moyenne fixée par Politis-White sur cette série en calibration, vérifiée et figée avant ouverture.
- 10 000 tirages, graine 20261101.

## 12. Publié sans seuil

Frais, rotation, temps sous le plus-haut, résultats par sous-période. Limites connues : glissement constant, stop évalué une fois par clôture 4h, biais de survie de l'univers.

## 13. Rôle du modèle

Hors du chemin des ordres. Classement journalisé en parallèle, jugé de façon prospective.

## 14. Production, hors banc

- Rien sur `main` de crypto-buddy avant la clôture du pilote (1er novembre 2026, 11h46 UTC, puis cycle suivant).
- Avant toute hausse réelle d'exposition, chantier séparé : exécution autonome sans le modèle, cadence fixe sur les clôtures 4h, stops indépendants du modèle, révision de la borne de `minCashPercent`.
- Plafonds et répartition : expérience ultérieure distincte.
