import { lire } from './lib/db.mjs';
import { echapper } from './lib/mail.mjs';
import { destinatairesAssociation } from './lib/commun.mjs';
import { brevoConfigure, sortDesMessages, resumer } from './lib/brevo.mjs';

/**
 * Diagnostic des notifications internes.
 *
 *   GET /api/diagnostic-envois?cle=SECRET_ADMIN
 *
 * Répond à une question que le journal du site ne peut pas trancher :
 * un message parti est-il arrivé ? Le journal n'enregistre que
 * l'acceptation par Brevo. Cette page rapproche ce journal de ce que
 * Brevo sait du sort réel de chaque message, destinataire par
 * destinataire.
 *
 * Elle affiche les adresses internes de l'association, qui sont des
 * adresses de service connues du bureau, et jamais celles des adhérents.
 */
export const config = { path: '/api/diagnostic-envois' };

export default async (req) => {
  const url = new URL(req.url);
  if (!process.env.SECRET_ADMIN || url.searchParams.get('cle') !== process.env.SECRET_ADMIN) {
    return new Response('Clé invalide.', { status: 403 });
  }

  const attendus = destinatairesAssociation();

  let journal = [];
  let erreurJournal = null;
  try {
    journal = await lire('journal_notifications',
      'select=cree_le,destinataire,modele,statut,tentatives,reference_fournisseur,derniere_erreur'
      + '&modele=eq.engagement_association&order=cree_le.desc&limit=40');
  } catch (e) {
    erreurJournal = String(e.message).slice(0, 200);
  }

  // Les adresses à interroger : celles configurées, plus celles que le
  // journal a réellement servies — une adresse retirée de la
  // configuration peut rester à expliquer.
  const adresses = [...new Set([...attendus, ...journal.map((l) => l.destinataire)])]
    .filter(Boolean).slice(0, 12);

  let lectures = [];
  if (brevoConfigure()) {
    lectures = await Promise.all(adresses.map(async (a) => {
      const lecture = await sortDesMessages(a);
      return { ...lecture, resume: resumer(lecture) };
    }));
  }

  return new Response(page({ attendus, journal, erreurJournal, lectures }), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};

const COULEURS = {
  'remise confirmée': '#1A6B3B',
  'bloquée': '#A3271F',
  'non remise': '#A3271F',
  'aucune trace': '#8A6D1F',
  'indéterminé': '#5A6B60',
};

function dateFr(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
}

function page({ attendus, journal, erreurJournal, lectures }) {
  const configurees = attendus.length
    ? attendus.map((a) => `<code>${echapper(a)}</code>`).join(' · ')
    : '<b style="color:#A3271F">aucune adresse configurée — la variable EMAIL_ASSOCIATION est vide</b>';

  const blocsBrevo = !brevoConfigure()
    ? '<p class="discret">Brevo n\'est pas configuré sur le serveur : le sort des messages ne peut pas être vérifié.</p>'
    : lectures.map((l) => {
      const c = COULEURS[l.resume.verdict] || '#5A6B60';
      const lignes = l.evenements.slice(0, 12).map((e) => `
        <tr><td>${dateFr(e.date)}</td><td><b>${echapper(e.evenement)}</b></td>
            <td class="discret">${echapper(e.motif || e.sujet || '')}</td></tr>`).join('');
      return `
      <div class="carte">
        <h3>${echapper(l.adresse)}
          ${attendus.includes(l.adresse) ? '' : '<span class="etiquette">hors configuration</span>'}</h3>
        <p class="verdict" style="color:${c}">${echapper(l.resume.verdict)}
          <span class="discret">— ${echapper(l.resume.detail)}</span></p>
        ${lignes ? `<table><thead><tr><th>Quand</th><th>Événement</th><th>Détail</th></tr></thead>
          <tbody>${lignes}</tbody></table>`
        : '<p class="discret" style="margin:0">Aucun événement sur les quatre-vingt-dix derniers jours.</p>'}
      </div>`;
    }).join('');

  const lignesJournal = journal.map((l) => `
    <tr>
      <td>${dateFr(l.cree_le)}</td>
      <td>${echapper(l.destinataire)}</td>
      <td>${echapper(l.statut)}</td>
      <td class="discret">${l.reference_fournisseur ? 'oui' : '—'}</td>
      <td class="discret">${echapper((l.derniere_erreur || '').slice(0, 90))}</td>
    </tr>`).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Diagnostic des notifications</title>
<style>
  :root{color-scheme:light}
  body{margin:0; padding:1.4rem; background:#F3EDE2; color:#22312A;
       font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  .page{max-width:900px; margin:0 auto}
  h1{font-size:1.5rem; margin:0 0 .3rem} h2{font-size:1.1rem; margin:2rem 0 .7rem}
  h3{font-size:1rem; margin:0 0 .4rem; word-break:break-all}
  .carte{background:#FFFDF8; border:1px solid #D8D0C0; border-radius:12px;
         padding:1rem 1.1rem; margin-bottom:1rem}
  .discret{color:#5A6B60; font-size:.9rem}
  .verdict{font-weight:700; margin:.2rem 0 .8rem}
  .etiquette{font-size:.72rem; font-weight:400; background:#EFE8DC; color:#5A6B60;
             border-radius:999px; padding:.12rem .5rem; margin-left:.4rem; vertical-align:middle}
  table{width:100%; border-collapse:collapse; font-size:.88rem}
  th,td{text-align:left; padding:.34rem .5rem; border-bottom:1px solid #EAE3D6; vertical-align:top}
  th{color:#5A6B60; font-weight:600}
  code{background:#EFE8DC; border-radius:5px; padding:.08rem .35rem; font-size:.9em}
  .encart{background:#FFF8E6; border:1px solid #E3D3A3; border-radius:12px;
          padding:.9rem 1.1rem; margin-bottom:1.3rem}
</style></head><body><div class="page">

<h1>Diagnostic des notifications internes</h1>
<p class="discret">Généré le ${dateFr(new Date().toISOString())}. Page non indexée, non mise en cache.</p>

<div class="encart">
  <p style="margin:0 0 .5rem"><b>Accepté n'est pas reçu.</b> Le journal du site n'enregistre que la
  prise en charge par Brevo, qui répond favorablement avant toute tentative de remise. Un message
  peut donc être « envoyé » dans le journal et n'arriver jamais : adresse sur la liste de blocage,
  rejet du serveur destinataire, ou classement en indésirable.</p>
  <p style="margin:0" class="discret">Seule la colonne de Brevo, plus bas, dit ce qui est
  réellement parvenu au serveur du destinataire. Elle ne dit pas si le message a été lu, ni s'il est
  arrivé dans la boîte principale plutôt que dans les indésirables.</p>
</div>

<h2>Adresses configurées</h2>
<div class="carte"><p style="margin:0">${configurees}</p>
<p class="discret" style="margin:.5rem 0 0">Issues de la variable <code>EMAIL_ASSOCIATION</code>.
Pour en changer, il faut modifier cette variable dans Netlify puis redéployer : les fonctions ne
relisent les variables qu'au déploiement suivant.</p></div>

<h2>Ce que Brevo sait du sort des messages</h2>
${blocsBrevo}

<h2>Journal du site — notifications d'engagement</h2>
<div class="carte">
  ${erreurJournal ? `<p style="color:#A3271F; margin:0">Journal illisible : ${echapper(erreurJournal)}</p>`
    : lignesJournal ? `<table>
    <thead><tr><th>Quand</th><th>Destinataire</th><th>Statut</th><th>Référence</th><th>Erreur</th></tr></thead>
    <tbody>${lignesJournal}</tbody></table>`
    : '<p class="discret" style="margin:0">Aucune notification d\'engagement enregistrée.</p>'}
</div>

</div></body></html>`;
}
