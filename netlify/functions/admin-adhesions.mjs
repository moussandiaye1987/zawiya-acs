import { lire, majOu } from './lib/db.mjs';
import { synchroniser } from './lib/sync-adhesions.mjs';
import { helloassoConfigure, dureeAdhesionMois } from './lib/helloasso.mjs';
import { echapper } from './lib/mail.mjs';

/**
 * Espace d'administration des adhésions.
 *
 *   GET  /api/admin-adhesions?cle=SECRET_ADMIN            la page
 *   POST /api/admin-adhesions?cle=SECRET_ADMIN&action=... actualiser,
 *                                                        ou changer
 *                                                        l'état d'un critère
 *
 * La page n'affiche que des chiffres et des états : aucun nom, aucun
 * e-mail, aucun détail de paiement. La clé ne quitte jamais l'adresse.
 */
export const config = { path: '/api/admin-adhesions' };

const ETATS = ['À vérifier', 'En cours', 'Satisfait', 'Non satisfait'];

export default async (req) => {
  const url = new URL(req.url);
  const cle = url.searchParams.get('cle');
  if (!process.env.SECRET_ADMIN || cle !== process.env.SECRET_ADMIN) {
    return new Response('Clé invalide.', { status: 403 });
  }

  if (req.method === 'POST') {
    const action = url.searchParams.get('action');

    if (action === 'actualiser') {
      const bilan = await synchroniser();
      return redirection(url, bilan.ok ? 'actualise' : 'echec');
    }

    if (action === 'critere') {
      const form = await req.formData();
      const code = String(form.get('code') || '');
      const etat = String(form.get('etat') || '');
      const commentaire = String(form.get('commentaire') || '').slice(0, 500);
      if (!ETATS.includes(etat)) return redirection(url, 'etat_inconnu');
      // Un critère ne change d'état que par cette action, jamais par
      // déduction depuis les données HelloAsso.
      await majOu('criteres_rup', `code=eq.${encodeURIComponent(code)}`, {
        etat, commentaire: commentaire || null, maj_le: new Date().toISOString(),
      }).catch(() => {});
      return redirection(url, 'critere_enregistre');
    }

    return redirection(url, 'action_inconnue');
  }

  return new Response(await page(url), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};

function redirection(url, message) {
  const cible = new URL(url);
  cible.searchParams.delete('action');
  cible.searchParams.set('message', message);
  return new Response(null, { status: 303, headers: { Location: cible.toString() } });
}

/* ------------------------------------------------------------------ */

async function page(url) {
  const cle = url.searchParams.get('cle');
  const message = url.searchParams.get('message');

  let etat = null, criteres = [], adherents = null;
  try {
    const l = await lire('synchronisation_helloasso', 'select=*&id=eq.1');
    etat = Array.isArray(l) ? l[0] : l;
  } catch { /* la page s'affiche quand même */ }
  try {
    criteres = await lire('criteres_rup', 'select=*&order=ordre.asc') || [];
  } catch { criteres = []; }
  try {
    const l = await lire('adhesions_helloasso', 'select=active');
    adherents = {
      total: l.length,
      actifs: l.filter((x) => x.active).length,
    };
  } catch { /* facultatif */ }

  const dateFr = (v) => v
    ? new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short',
      }).format(new Date(v))
    : '—';

  const messages = {
    actualise: 'Synchronisation terminée.',
    echec: 'La synchronisation a échoué. Le détail figure ci-dessous.',
    critere_enregistre: 'Critère enregistré.',
    etat_inconnu: 'État inconnu : rien n\'a été changé.',
    action_inconnue: 'Action inconnue.',
  };

  const pastille = (s) => {
    const couleurs = { ok: '#1E7A43', echec: '#9b2c2c', en_cours: '#b4641e', jamais: '#6b7d71' };
    return `<span class="etat" style="--c:${couleurs[s] || '#6b7d71'}">${echapper(s || 'jamais')}</span>`;
  };

  const lignesCriteres = criteres.map((c) => `
    <tr>
      <td><strong>${echapper(c.libelle)}</strong></td>
      <td>
        <form method="post" action="?cle=${encodeURIComponent(cle)}&amp;action=critere">
          <input type="hidden" name="code" value="${echapper(c.code)}">
          <select name="etat">
            ${ETATS.map((e) => `<option${e === c.etat ? ' selected' : ''}>${echapper(e)}</option>`).join('')}
          </select>
          <input type="text" name="commentaire" maxlength="500" placeholder="Justificatif, référence…"
                 value="${echapper(c.commentaire || '')}">
          <button type="submit">Enregistrer</button>
        </form>
      </td>
      <td class="discret">${dateFr(c.maj_le)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Adhésions — administration</title>
<style>
:root{--pierre:#EFE8DC;--craie:#FBF8F2;--encre:#14301F;--encre-2:#4A6152;--vert:#1E7A43;--trait:rgba(20,48,31,.16)}
*{box-sizing:border-box}
body{margin:0;background:var(--pierre);color:var(--encre);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.6}
.wrap{width:min(900px,94vw);margin-inline:auto;padding:2rem 0 4rem}
h1{font-size:1.6rem;margin:0 0 .3rem;font-weight:500}
h2{font-size:1.15rem;margin:2.2rem 0 .8rem;font-weight:500}
.sous{color:var(--encre-2);margin:0 0 1.5rem;font-size:.95rem}
.carte{background:var(--craie);border:1px solid var(--trait);border-radius:4px;padding:1.2rem 1.4rem;margin-bottom:1rem}
.chiffres{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem}
.chiffre b{display:block;font-size:1.9rem;font-weight:500;color:var(--vert);line-height:1.1}
.chiffre span{font-size:.82rem;color:var(--encre-2)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
td,th{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--trait);vertical-align:top}
th{font-weight:500;font-size:.82rem;color:var(--encre-2)}
form{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin:0}
select,input[type=text]{font:inherit;font-size:.88rem;padding:.35rem .5rem;border:1px solid var(--trait);
  border-radius:3px;background:#fff;color:var(--encre)}
input[type=text]{flex:1 1 180px;min-width:0}
button{font:inherit;font-size:.88rem;padding:.4rem .9rem;border:0;border-radius:3px;
  background:var(--vert);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.1)}
.etat{display:inline-block;padding:.1rem .55rem;border-radius:999px;font-size:.78rem;
  background:color-mix(in srgb,var(--c) 14%,transparent);color:var(--c)}
.alerte{border-left:3px solid #9b2c2c;background:rgba(155,44,44,.07);padding:.8rem 1rem;
  border-radius:0 3px 3px 0;font-size:.9rem;margin-bottom:1rem}
.info{border-left:3px solid var(--vert);background:rgba(30,122,67,.08);padding:.8rem 1rem;
  border-radius:0 3px 3px 0;font-size:.9rem;margin-bottom:1rem}
.discret{color:var(--encre-2);font-size:.85rem}
code{background:rgba(20,48,31,.07);padding:.1em .35em;border-radius:2px;font-size:.88em}
@media (max-width:620px){ form{flex-direction:column;align-items:stretch} }
</style></head><body><div class="wrap">

<h1>Adhésions HelloAsso</h1>
<p class="sous">Espace réservé. Cette page n'est pas indexée et n'affiche aucune donnée nominative.</p>

${message ? `<div class="info">${echapper(messages[message] || message)}</div>` : ''}
${!helloassoConfigure() ? `<div class="alerte">
  <strong>HelloAsso n'est pas configuré.</strong> Les variables
  <code>HELLOASSO_CLIENT_ID</code>, <code>HELLOASSO_CLIENT_SECRET</code> et
  <code>HELLOASSO_ORGANISATION</code> manquent côté serveur. Le compteur reste vide
  tant qu'elles ne sont pas renseignées.
</div>` : ''}
${etat && etat.statut === 'echec' && etat.derniere_erreur ? `<div class="alerte">
  <strong>Dernière synchronisation en échec.</strong><br>${echapper(etat.derniere_erreur)}<br>
  <span class="discret">Le chiffre affiché au public reste celui de la dernière réussite.</span>
</div>` : ''}

<div class="carte">
  <div class="chiffres">
    <div class="chiffre"><b>${etat?.adherents_actifs ?? '—'}</b><span>adhérents à jour (HelloAsso)</span></div>
    <div class="chiffre"><b>${adherents?.total ?? '—'}</b><span>personnes connues au total</span></div>
    <div class="chiffre"><b>${etat?.adhesions_totales ?? '—'}</b><span>adhésions lues</span></div>
    <div class="chiffre"><b>${Math.max(0, 200 - (etat?.adherents_actifs ?? 0))}</b><span>restants sur 200</span></div>
  </div>
</div>

<h2>Synchronisation</h2>
<div class="carte">
  <table>
    <tr><td>État</td><td>${pastille(etat?.statut)}</td></tr>
    <tr><td>Dernière réussite</td><td>${dateFr(etat?.derniere_reussite)}</td></tr>
    <tr><td>Dernière tentative</td><td>${dateFr(etat?.derniere_tentative)}</td></tr>
    <tr><td>Période d'adhésion retenue</td><td>${dureeAdhesionMois()} mois — du ${dateFr(etat?.periode_debut)} au ${dateFr(etat?.periode_fin)}</td></tr>
    <tr><td>Pages lues</td><td>${etat?.pages_lues ?? '—'} (${etat?.articles_lus ?? '—'} articles)</td></tr>
    <tr><td>Durée</td><td>${etat?.duree_ms ? `${etat.duree_ms} ms` : '—'}</td></tr>
    <tr><td>Automatique</td><td class="discret">toutes les 6 heures</td></tr>
  </table>
  <p style="margin:1rem 0 0">
    <form method="post" action="?cle=${encodeURIComponent(cle)}&amp;action=actualiser">
      <button type="submit">Actualiser maintenant</button>
    </form>
  </p>
</div>

<h2>Règle de comptage</h2>
<div class="carte discret">
  <p style="margin:0 0 .6rem">Sont retenus les articles de type <strong>adhésion</strong> uniquement —
  ni dons, ni billetterie, ni boutique — dont l'état est <code>Processed</code> ou
  <code>Registered</code>. Les adhésions en attente de paiement, annulées ou remboursées
  (<code>Waiting</code>, <code>Deleted</code>) sont écartées.</p>
  <p style="margin:0 0 .6rem">Ce sont les <strong>personnes</strong> qui sont comptées, pas les commandes
  ni les échéances de paiement : une commande portant plusieurs adhérents compte pour autant de
  personnes, et un renouvellement ne compte pas deux fois.</p>
  <p style="margin:0">Une personne est identifiée par le nom de l'adhérent inscrit ; à défaut par
  l'e-mail du payeur ; à défaut par l'identifiant de l'article. Elle est comptée
  « à jour » si sa dernière adhésion a moins de ${dureeAdhesionMois()} mois.</p>
</div>

<h2>Reconnaissance d'utilité publique</h2>
<div class="carte">
  <p class="discret" style="margin:0 0 1rem">Le seuil de 200 adhérents n'est qu'un critère parmi
  d'autres. Ceux-ci restent « À vérifier » tant qu'un justificatif n'est pas apporté : aucun ne se
  déduit des données HelloAsso.</p>
  <table>
    <thead><tr><th>Critère</th><th>État et justificatif</th><th>Mis à jour</th></tr></thead>
    <tbody>${lignesCriteres || '<tr><td colspan="3" class="discret">Critères indisponibles.</td></tr>'}</tbody>
  </table>
</div>

</div></body></html>`;
}
