# Zawiya Cheikh Ibrahim Niasse — site de l'ACS

Site public du projet d'acquisition de la Zawiya, avec enregistrement des
engagements de contribution et référencement des Dahiras.

**Ce site n'encaisse aucun paiement.** Il ne demande ni carte, ni IBAN, ni
mandat. Il enregistre des intentions ; les règlements sont gérés
séparément par l'association.

---

## 1. Ce qu'il y a dans ce dépôt

```
public/                 le site, publié tel quel par Netlify
  index.html            page unique : projet → adhésion → Dahiras → transparence → historique → contact
  confidentialite.html  page de confidentialité
  404.html              page d'erreur
  img/ · maquette-zawiya.mp4
netlify/functions/      traitement côté serveur
  engagement.mjs        POST /api/engagement
  dahira.mjs            POST /api/dahira
  donnees-publiques.mjs GET  /api/donnees-publiques   (agrégats + annuaire validé)
  participant.mjs       GET  /api/participant         (liens personnels des e-mails)
  rappels-mensuels.mjs  tâche planifiée, toutes les heures (e-mail)
  rappels-test.mjs      GET  /api/rappels-test        (déclenchement manuel, protégé)
  relance-whatsapp.mjs  GET  /api/relance-whatsapp    (page du bureau, protégée)
  lib/                  base, e-mails, validation, logique des rappels
outils/verifier.mjs     banc d'essai hors ligne des fonctions
db/README.md            note sur le schéma
netlify.toml            configuration Netlify
.env.example            liste des variables, sans aucune valeur
```

---

## 2. Services retenus, et pourquoi

| Service | Rôle | Coût | Pourquoi celui-là |
|---|---|---|---|
| **Netlify** | Hébergement + fonctions serveur | Gratuit | Déjà en place. Les fonctions évitent d'exposer le moindre secret au navigateur. |
| **Supabase** | Base de données PostgreSQL | Gratuit | Vous avez déjà un compte Supabase. Base en France, export CSV et édition en un clic depuis le tableau de bord, statuts et contraintes gérés par la base elle-même. |
| **Brevo** *(ou Resend)* | Envoi des e-mails | Gratuit jusqu'à 300/jour | Un expéditeur se valide par simple e-mail, sans nom de domaine — ce que Resend exige. Aucun mot de passe Gmail n'est utilisé. |

**Pourquoi pas Google Sheets.** Une feuille ne sait pas empêcher deux
inscriptions simultanées de créer un doublon, ni refuser un statut
inexistant, ni masquer une colonne privée à une lecture publique. Ici la
base refuse d'elle-même un second engagement sur la même adresse, un
second rappel le même mois, ou une Dahira déjà référencée dans la même
ville. Vous gardez malgré tout l'export CSV : il suffit d'un clic sur les
vues `v_export_engagements` et `v_export_dahiras`.

**Limites à connaître.** Un projet Supabase gratuit se met en veille après
une semaine sans aucune requête — la tâche horaire des rappels suffit à
l'en empêcher. Brevo plafonne à 300 e-mails par jour, large pour l'usage
prévu sauf pic exceptionnel. Les relances WhatsApp demandent un clic
humain : voir §7.

---

## 3. Variables d'environnement

À saisir dans **Netlify → Site configuration → Environment variables**.
Jamais dans le dépôt. `.env.example` en donne la liste commentée.

| Variable | Obligatoire | Où la trouver |
|---|---|---|
| `SUPABASE_URL` | oui | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | Supabase → Project Settings → API Keys → `service_role` |
| `BREVO_API_KEY` *ou* `RESEND_API_KEY` | pour les e-mails | tableau de bord du fournisseur |
| `MAIL_EXPEDITEUR` | pour les e-mails | adresse vérifiée chez le fournisseur |
| `MAIL_EXPEDITEUR_NOM` | non | défaut : « Association Connaissance et Savoir » |
| `EMAIL_ASSOCIATION` | oui | adresse qui reçoit les notifications |
| `URL_TABLEAU_BORD` | non | lien Supabase glissé dans les e-mails internes |
| `SEL_EMPREINTE` | oui | chaîne aléatoire, pour hacher les adresses IP |
| `SECRET_LIENS` | oui | chaîne aléatoire, pour signer les liens personnels |
| `SECRET_ADMIN` | oui | chaîne aléatoire, pour `/api/rappels-test` |

Générer un secret :
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> La clé `service_role` contourne toutes les protections de la base.
> Elle ne doit jamais être collée ailleurs que dans Netlify.
> Si elle fuite, régénérez-la dans Supabase et remplacez-la dans Netlify.

---

## 4. Mise en service

1. **Pousser ce dossier sur GitHub**, dans un dépôt neuf ou existant.
2. **Netlify → le site existant → Site configuration → Build & deploy →
   Link to a Git repository.** Choisissez le dépôt et la branche `main`.
   Netlify lit `netlify.toml` : dossier publié `public`, fonctions dans
   `netlify/functions`. Ne renseignez pas de commande de build.
3. **Saisir les variables** du §3, puis **Deploy site**.
4. **Vérifier** : ouvrir `/api/donnees-publiques`. Vous devez obtenir un
   JSON avec `"statut_donnees":"en_consolidation"` et `"dahiras":[]`.
5. **Un essai de bout en bout** : enregistrer un engagement avec une
   adresse à vous, vérifier l'accusé de réception, puis marquer la ligne
   `est_test = true` dans Supabase pour l'exclure des statistiques.

Après cette étape, chaque fusion sur `main` redéploie le site, chaque
pull request reçoit son aperçu, et **Deploys → Published deploy →
Publish deploy** permet de revenir à n'importe quelle version antérieure.

---

## 5. Administrer au quotidien

Tout se fait dans **Supabase → Table Editor**.

**Valider une Dahira.** Table `dahiras`, passer `statut` de
`En attente` à `Publiée`. La fiche apparaît sur le site en moins d'une
minute. Pour la situer sur la carte, renseigner `latitude` et
`longitude` — l'API Adresse de data.gouv.fr les donne gratuitement :

```
https://api-adresse.data.gouv.fr/search/?q=12+rue+de+Paris+Montreuil&postcode=93100&limit=1
```

Les coordonnées sont dans `features[0].geometry.coordinates`, au format
`[longitude, latitude]`.

**Suivre un engagement.** Table `engagements`, colonne `statut` :
`Nouveau` → `À contacter` → `Confirmé par l'association`, ou `Suspendu`,
`Terminé`, `Annulé`, `Doublon`. **Aucun de ces statuts ne signifie qu'un
paiement a été reçu.**

**Enregistrer un versement reçu.** Table `versements` : une ligne par
engagement et par mois, `mois` au premier jour du mois, `source` =
`association`. La personne est alors exclue du rappel de ce mois-là.
Une ligne `declaration_participant` provient du bouton « j'ai effectué
mon versement » : elle reste à vérifier et n'exclut du rappel qu'une fois
`confirme_par_association` passé à vrai.

**Publier les montants encaissés.** Table `suivi_association` :
renseigner `versements_recus_euros` et `versements_arretes_au`. Tant que
ces champs sont vides, le site affiche « Données en cours de
consolidation » plutôt qu'un zéro trompeur. Mettre `collecte_demarree` à
vrai le jour où la collecte est officiellement ouverte.

**Exporter.** Table Editor → vue `v_export_engagements` ou
`v_export_dahiras` → **Export CSV**.

**Rejouer un e-mail échoué.** Table `journal_notifications`, filtrer sur
`statut = echec` : la colonne `derniere_erreur` donne la cause.

---

## 6. Rappels mensuels

Désactivés à la livraison, et en mode test. Rien ne part tant que vous
n'avez pas décidé le contraire.

Table `parametres_rappels`, une seule ligne :

| Colonne | Défaut | Effet |
|---|---|---|
| `actifs` | `false` | Interrupteur général |
| `mode_test` | `true` | N'envoie qu'aux adresses de `destinataires_test` |
| `destinataires_test` | vide | Vos propres adresses, pour essayer |
| `jour_du_mois` | `dernier` | `dernier`, ou un numéro de jour |
| `heure_locale` | `18` | Heure de Paris, heure d'été comprise |
| `canal_email` | `true` | |
| `canal_whatsapp` | `true` | Alimente la page de relance assistée, §7 |
| `instructions_reglement` | IBAN de l'ACS | Repris tel quel dans l'e-mail |
| `contact_difficulte` | adresse de contact | Repris tel quel dans l'e-mail |

**Pour essayer :** mettre son adresse dans `destinataires_test`, passer
`actifs` à vrai, puis appeler
`https://VOTRE-SITE/api/rappels-test?cle=SECRET_ADMIN&forcer=1`.
Le paramètre `forcer` ignore le jour et l'heure. Le mode test, lui, reste
la seule garantie qu'aucun vrai destinataire n'est touché : gardez-le
actif pendant les essais.

**Pour ouvrir à tout le monde :** passer `mode_test` à faux.

La tâche tourne **toutes les heures** et décide elle-même si c'est le bon
moment à Paris. La syntaxe cron ne sait pas dire « le dernier jour du
mois » et ignore l'heure d'été ; faire le calcul dans le code permet
aussi de changer le jour et l'heure sans redéployer.

Garde-fous en place : un seul rappel par personne et par mois, imposé par
un index unique en base ; aucun rappel avant l'inscription ni après la
fin de l'engagement ; aucun rappel pour un engagement suspendu, terminé
ou annulé ; aucun rappel si le versement du mois est enregistré. Le texte
ne parle jamais de retard ni d'impayé et porte toujours la mention
« si vous avez déjà effectué votre contribution, merci de ne pas tenir
compte de ce message ». Chaque e-mail contient un lien de désinscription
qui coupe les rappels **sans annuler l'engagement**.

Récapitulatif pour le bureau : vues `v_rappels_recapitulatif` et
`v_versements_par_mois`.

---

## 7. WhatsApp — relance assistée

Le SMS a été abandonné : 4 à 9 centimes le message, soit 40 à 90 € par
mois pour 1 000 personnes. WhatsApp le remplace, **sans rien coûter**.

### Comment ça marche

À l'inscription, chacun choisit son canal : e-mail, WhatsApp, les deux,
ou aucun. L'e-mail part tout seul. WhatsApp passe par une page réservée
au bureau :

```
https://VOTRE-SITE/api/relance-whatsapp?cle=SECRET_ADMIN
```

Elle liste les personnes à relancer ce mois-ci et affiche pour chacune un
bouton **Ouvrir WhatsApp**. Le clic ouvre WhatsApp avec le message déjà
écrit — prénom, mois, montant, référence, instructions de règlement — il
ne reste qu'à l'envoyer. De retour sur la page, **Marquer comme fait**
retire la personne de la liste.

Les numéros sont mis au format international automatiquement (06… → +33,
+221 reconnu). Ceux dont le format n'est pas certain, un fixe ou un
numéro étranger inhabituel, sont affichés à part, sous l'intitulé
« numéros à vérifier » : mieux vaut un envoi manuel qu'un message chez un
inconnu.

### Pourquoi pas un envoi automatique

Deux raisons, et aucune n'est technique.

**Envoyer en masse depuis un WhatsApp ordinaire fait bloquer le numéro.**
Des centaines de messages identiques vers des gens qui n'ont pas
enregistré votre numéro déclenchent les filtres anti-spam de Meta. Le
numéro de l'association serait suspendu, et c'est souvent définitif.

**L'API officielle coûte surtout en abonnement.** Le message utilitaire
revient à 1 à 4 centimes en France, moins cher que le SMS. Mais il faut
une vérification d'entreprise chez Meta, un numéro dédié, des modèles de
message approuvés à l'avance, et un abonnement de plateforme entre 30 et
100 € par mois — qui dépasse le coût des messages eux-mêmes à ce volume.

Le clic humain reste donc la bonne réponse tant que le nombre
d'engagements se compte en dizaines ou en centaines. Si l'association
dépasse plusieurs centaines de relances mensuelles, l'API devient
défendable : le code est prêt à l'accueillir, il suffira de remplacer la
page assistée par un envoi direct.

### Consentement

Le choix du canal vaut consentement, et il est enregistré par personne.
Une personne qui n'a pas coché WhatsApp n'apparaît jamais dans la liste.
Le lien de désinscription des e-mails coupe **tous** les rappels, les
deux canaux compris, sans annuler l'engagement.

### Réglages

Table `parametres_rappels` : `canal_whatsapp` active ou désactive la
page. `instructions_reglement` et `contact_difficulte` alimentent le
texte du message, comme pour l'e-mail. La colonne `canal_sms` subsiste
dans le schéma mais reste à faux : le SMS n'est plus branché.

## 8. Confidentialité

- Les tables ont la sécurité au niveau des lignes activée **sans aucune
  politique** : sans la clé de service, personne ne lit ni n'écrit rien.
- Le navigateur ne reçoit **que** des agrégats et les Dahiras validées,
  via `/api/donnees-publiques`. Aucune liste de participants ne sort.
- L'e-mail et le téléphone privé d'un responsable de Dahira ne figurent
  dans aucune vue publique.
- Les adresses IP ne sont pas conservées : seulement une empreinte
  SHA-256 salée, pour limiter les envois répétés.
- La page `confidentialite.html` décrit ce qui est réellement en place,
  sans promettre de garantie technique qui ne le serait pas.

---

## 9. Vérifier avant de livrer

```bash
node outils/verifier.mjs
```

87 contrôles hors ligne sur les fonctions serveur : validation, pièges
anti-robot, doublons, panne du service d'e-mail, confidentialité des
réponses, liens personnels, rappels, format des numéros et page de
relance WhatsApp. Aucun appel réseau réel, aucun message envoyé.
