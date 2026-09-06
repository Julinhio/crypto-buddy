-- Migration 0037 — le mode de la porte entre dans le contrat du pilote
--
-- Le chantier a ete construit, documente et arbitre sur l'idee que la porte de transition etait
-- en `observe`. Elle est en `enforce`, et elle l'etait deja : le cycle 1590 du 26 aout en porte
-- la preuve dans le journal — un stop de sommet a `-11,13 %` a genere une sortie totale, le
-- verdict de la ligne XRP est `superseded`, la cible appliquee est passee a `XRP 0` alors que le
-- modele demandait 13, et le registre a booke la vente des 97,8 XRP.
--
-- Ce mode n'est pas un detail d'environnement : sous `enforce`, le code genere lui-meme des
-- sorties de stop, une jambe interdite refuse le vecteur ENTIER, et `stoppedWeightSurvives`
-- bascule — la bande dimensionne alors sa correction contre un livre ou la ligne stoppee part a
-- zero, et non contre son poids survivant.
--
-- Deux consequences, et cette colonne les sert toutes les deux :
--
--   1. IL ENTRE DANS L'EMPREINTE. Un passage `enforce` → `observe` en cours de fenetre change
--      ce que la correction produit ; le pilote doit etre invalide, pas continuer.
--   2. IL EST FIGE DANS L'IDENTITE. Le rejeu officiel doit reconstruire avec le mode qui etait
--      en vigueur A L'ACTIVATION, jamais avec la variable du poste ou il est lance — sans quoi
--      le meme rejeu produirait deux resultats selon la machine.

alter table public.exposure_pilot
  add column if not exists transition_mode text;

alter table public.exposure_pilot
  drop constraint if exists exposure_pilot_transition_mode_known;

alter table public.exposure_pilot
  add constraint exposure_pilot_transition_mode_known
    check (transition_mode is null or transition_mode in ('observe', 'enforce'));

comment on column public.exposure_pilot.transition_mode is
  'Le mode de la porte de transition A L''ACTIVATION, fige dans l''identite. Il entre dans l''empreinte du contrat — un changement invalide le pilote — et c''est lui, jamais la variable d''environnement du poste ou tourne le rejeu, qui pilote `stoppedWeightSurvives` et toute reconstruction dependant de la porte dans la fenetre officielle.';
