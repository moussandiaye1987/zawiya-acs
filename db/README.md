# Schéma de la base

Le schéma vit dans le projet Supabase **`zawiya-acs`** (région Paris), où
les migrations ont déjà été appliquées. Elles y sont horodatées et
conservées dans la table `supabase_migrations.schema_migrations`.

| Migration | Contenu |
|---|---|
| `schema_initial_zawiya` | Tables `engagements`, `dahiras`, `journal_notifications`, `suivi_association` ; verrouillage RLS |
| `vues_agregats_et_export` | Vues d'agrégats, annuaire public, vues d'export CSV |
| `rappels_mensuels_et_versements` | `versements`, `rappels`, `parametres_rappels`, fonction `engagements_a_rappeler` |
| `durcissement_search_path` | `search_path` fixé sur les fonctions |
| `anti_spam_empreinte_ip` | Empreinte d'IP et limiteur de débit |
| `ajout_colonnes_canaux` | `rappel_email`, `rappel_whatsapp`, `canal_whatsapp` |
| `fonction_rappel_par_canal` | `engagements_a_rappeler(mois, canal)`, vue `v_canaux_rappel` |

## Récupérer le SQL

Le dépôt ne contient pas les fichiers `.sql` : la source fait foi côté
Supabase, et les y dupliquer ferait courir le risque de deux versions
divergentes. Pour les exporter dans ce dossier :

```bash
npx supabase login
npx supabase link --project-ref VOTRE_REF_PROJET
npx supabase db pull            # écrit supabase/migrations/*.sql
```

La référence du projet se lit dans l'URL du tableau de bord Supabase.

## Consulter sans rien installer

Tableau de bord Supabase → **SQL Editor** :

```sql
select version, name from supabase_migrations.schema_migrations
order by version;
```

Et pour relire une migration précise, ajoutez `statements` à la liste des
colonnes.

## Appliquer une modification

SQL Editor → coller → exécuter. Supabase enregistre la migration
automatiquement. Pensez ensuite à mettre ce tableau à jour.
