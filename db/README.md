# Schéma de la base

Les migrations ci-dessous ont **déjà été appliquées** au projet Supabase
`zawiya-acs`. Elles sont conservées ici pour mémoire, pour pouvoir
recréer la base ailleurs, et pour que toute évolution future soit tracée
dans Git.

| Fichier | Contenu |
|---|---|
| `001_schema_initial.sql` | Tables `engagements`, `dahiras`, `journal_notifications`, `suivi_association`, verrouillage RLS |
| `002_vues_agregats.sql` | Vues d'agrégats, annuaire public, vues d'export CSV |
| `003_rappels_mensuels.sql` | `versements`, `rappels`, `parametres_rappels`, fonction `engagements_a_rappeler` |
| `004_anti_spam.sql` | Empreinte d'IP et limiteur de débit |
| `005_durcissement.sql` | `search_path` fixé sur les fonctions |

Pour appliquer une migration : tableau de bord Supabase → SQL Editor,
coller le contenu, exécuter.
