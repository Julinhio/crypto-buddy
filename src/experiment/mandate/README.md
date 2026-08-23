# Expérience — cadrage du mandat v5 et exposition totale demandée

Harnais hors production répondant à une seule question : **le cadrage du mandat v5
influence-t-il causalement l'exposition totale demandée, à contexte, livre, mémoire
et plomberie strictement identiques ?**

Le protocole est fermé et arbitré (Julien, Alex, Vera) ; ce dossier l'implémente,
il ne le réinvente pas. La lecture est préenregistrée dans `analyze.ts` et n'est pas
ajustée après coup. Une absence d'effet est un résultat valide.

## Les quatre mandats

- **C** — contrôle : `buildSystemPromptV5(config, 'enforce')`, byte-identique à la
  production (mode détecté dans les contextes persistés, pas supposé) ;
- **P** — placebo : instruction saillante sur la confiance, sans contenu d'exposition ;
- **F** — clarification : le plancher de cash est une limite de sécurité, pas une cible ;
- **O** — propriété : l'exposition totale est une décision de niveau portefeuille.

Chaque variante ne diffère du contrôle QUE par son ajout — propriété **prouvée** par
`proveVariantProperty` (retirer l'ajout restitue le contrôle byte-identique), pas promise.

## Les quatre contextes

Décisions de production 1297, 1433, 1368, 1494, rejouées depuis leur `market_context`
persisté. La mémoire (dernière décision significative) et la référence du garde sont
reconstruites avec les requêtes de production bornées strictement AVANT le cycle
(`read.ts`) ; `position_state` n'est jamais lue — le jeu de thèses vient du contexte
persisté lui-même.

## Les portes

1. **Reconstruction** (`reconstruct.ts`) — dont le contrôle le plus fort : la réponse
   brute historique doit ressortir `accepted` du pipeline du harnais avec la cible
   stockée. Toute divergence arrête l'expérience avant le moindre appel.
2. **Validité du contrôle** — C d'abord (5 × 4, entrelacé par contexte) ; si la
   médiane de C s'écarte de la réponse historique de plus du seuil local
   (max(5 pts, étendue de C)), arrêt complet avant les variantes.

Puis P/F/O en rotation carré-latin par (tour, contexte) — jamais un bloc par
variante. Réponse PRIMAIRE uniquement (pas de relance du garde) ; les erreurs de
transport (`retryable_llm_transport`) sont rejouées et comptées à part.

## Exécution

```
npm run experiment:mandate                     # tout : portes, 80 appels, analyse, rapport
npm run experiment:mandate -- --reconstruct-only   # porte 1 seule, zéro appel
npm run experiment:mandate -- --analyze-only       # ré-analyse des appels déjà enregistrés
```

Reprise sur incident : chaque appel est journalisé dans
`out/mandate-experiment/calls.jsonl` dès qu'il aboutit ; relancer la commande saute
les appels déjà faits.

## Sorties

- `out/mandate-experiment/` (**ignoré par Git**) : prompts complets, réponses brutes
  (raisonnement inclus, inspection locale uniquement), journal des appels, analyse.
- `docs/RAPPORT-EXPERIENCE-MANDAT-V5.md` (**commité**) : empreintes, portes, ordre,
  horodatages, agrégats par cellule, lecture préenregistrée. Ni prose du modèle, ni
  allocation par actif.

## Sécurité par construction

Ce dossier importe les builders de prompt, le client LLM, le pipeline de jugement et
des loaders Supabase en SELECT — rien d'autre. Aucun exécuteur, aucune alerte,
aucune écriture : le harnais ne peut ni passer un ordre ni écrire une ligne, faute
d'en avoir les moyens.
