# Protocole de mesure de la politique d'exposition — v1.2

> Copie de l'annexe du brief du 17/10/2026 (Julien, Alex, Claude), reproduite sans modification
> de fond. L'audit de faisabilité qui la confronte au code est
> [`AUDIT-PROTOCOLE-EXPOSITION.md`](AUDIT-PROTOCOLE-EXPOSITION.md).

## 1. Objectif

Maximiser le rendement net sous une limite dure de 50 % de drawdown, face à T100 et à la règle
simple R100/0.

## 2. Mandat

Aucun cash permanent ni réserve structurelle. Toute l'enveloppe est mobilisable. L'exposition
varie de 0 à 100 % selon la force mesurée de la situation, sans obligation d'être à 100 %. La
confiance déclarée par le modèle n'entre pas dans le dimensionnement.

## 3. Fenêtres

- Calibration : `[2021-01-01, 2024-07-01)`.
- Développement : `[2021-01-01, 2023-01-01)`.
- Vérification interne : `[2023-01-01, 2024-07-01)`.
- Seuils, normalisations, poids et seuil de rééquilibrage sont ajustés uniquement sur la moitié
  d'entraînement.
- Le test inverse ne sert qu'à vérifier qu'une relation ne dépend pas d'un seul régime de
  marché. Ce n'est pas une validation.
- Validation scellée : `[2024-07-01, 2026-06-01)`, ouverte une seule fois.
- Pilote vivant : lu à part, comme contrefactuel mécanique à décisions figées.

## 4. Préalable

Valeur prédictive de chaque composante candidate du score : signal connu à la clôture, rendement
mesuré depuis l'ouverture suivante, horizons fixés à l'avance, erreurs-types corrigées pour le
chevauchement. On mesure aussi les corrélations entre composantes, la contribution propre de
chacune et sa stabilité.

## 5. Architectures

- **T100** : cible de 100 % constante, sans pilotage par le contexte.
- **R100/0** : cible de 100 %, ramenée à 0 % en risk_off confirmé.
- **SCORE** : score de conviction calculé par le code, transformé en cible exacte entre 0 et
  100 %. Peu de composantes, contribution propre démontrée, poids simples. L'ensemble des
  variantes testées (composantes, pondérations, seuils) est fini et préenregistré avant leur
  exécution.
- **Exploratoire, hors sélection principale** : dimensionnement par le risque, seulement une
  fois figés un stop initial déterministe, son interaction avec le stop suiveur à 10 % et son
  contrat complet.
- Une cible de 100 % n'est pas la promesse d'une exposition réalisée permanente à 100 %. Les
  contraintes factuelles communes peuvent temporairement empêcher de l'atteindre.

## 6. Règles communes aux trois architectures

- **Poids** : 32,5 % BTC, 32,5 % ETH, 20 % BNB et 15 % XRP. C'est le panier le plus proche de
  l'équipondération compatible avec les plafonds. Il remplace explicitement la pondération
  proportionnelle aux plafonds du banc existant (33,333 / 33,333 / 19,048 / 14,286).
- **Redistribution** : toute capacité inutilisée (actif stoppé, gelé ou indisponible) est
  redistribuée de façon déterministe entre les actifs éligibles, dans la limite de leurs
  plafonds. Il ne reste du cash que si la capacité totale disponible est inférieure à la cible,
  ou si le reliquat est inexécutable.
- Mêmes plafonds, frais, seuil de mouvement, stops, gels et porte de transition.
- Le risk_off n'existe pas dans T100.
- **Seuil de rééquilibrage** : il fait partie de la politique. Sa méthode de sélection est gelée
  avec le score, et les frais et la rotation sont mesurés après son application.

## 7. Usage réel de la plage

- Toutes les architectures : une cible de 100 % est structurellement atteignable, et la
  distribution réelle de l'exposition est publiée (médiane, quartiles, 90e centile, temps passé
  dans les zones 0-20, 20-50, 50-80 et 80-100 %).
- SCORE uniquement : dans le décile de conviction le plus élevé, l'exposition médiane est d'au
  moins 80 %.

## 8. Sélection en calibration

- Éliminatoire : drawdown maximal supérieur à 50 %, ou exigences du point 7 non remplies.
- SCORE n'est préféré à R100/0 que si son avance de rendement net sur la vérification interne
  est significative selon la méthode du point 9. Sinon, R100/0 est retenue.
- Une seule candidate, figée et commitée avec la règle de décision et les paramètres du
  bootstrap, avant l'ouverture de la validation.

## 9. Décision sur la validation

- Limite dure : drawdown maximal inférieur ou égal à 50 %.
- Série rééchantillonnée : la différence quotidienne des rendements logarithmiques de la
  candidate et du témoin. On ne rééchantillonne jamais les bougies.
- Méthode : bootstrap stationnaire par blocs. La longueur moyenne des blocs est fixée par une
  méthode nommée, par exemple Politis-White, appliquée aux seules données de calibration, puis
  vérifiée et figée avant l'ouverture.
- 10 000 tirages, graine fixe 20261101.
- Critère : borne inférieure unilatérale à 95 % strictement positive.
- La candidate doit battre T100. Si c'est SCORE, elle doit aussi battre R100/0.
- En cas d'échec, le résultat est publié tel quel. Julien tranche à partir des chiffres, sans
  politique imposée par défaut.

## 10. Publié sans seuil

Frais, rotation du portefeuille, temps passé sous le plus-haut, drawdown, résultats par
sous-période haussière et baissière.

## 11. Rôle du modèle

Hors du chemin des ordres. Son classement des actifs est journalisé en parallèle et jugé de
façon prospective. Il n'est promu que sur un avantage mesuré.

## 12. Production

Rien ne va sur main avant la clôture du pilote, le 1er novembre à 11h46 UTC, puis le cycle
suivant. Un nouveau contrat implique une nouvelle identité de pilote, créée par une opération
administrative explicite.
