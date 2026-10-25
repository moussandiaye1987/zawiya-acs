import { lire, inserer, majParId, rpc, baseConfiguree } from './lib/db.mjs';
import { lienWhatsApp } from './lib/telephone.mjs';
import { euros, signer } from './lib/commun.mjs';

/**
 * Page de relance assistée par WhatsApp, réservée au bureau.
 *
 *   /api/relance-whatsapp?cle=SECRET_ADMIN
 *   /api/relance-whatsapp?cle=SECRET_ADMIN&mois=2026-11-01
 *
 * Pourquoi « assistée » et non automatique : envoyer des messages en
 * masse depuis un compte WhatsApp ordinaire fait bloquer le numéro.
 * L'API officielle, elle, suppose une vérification d'entreprise Meta,
 * un numéro dédié et un abonnement mensuel — disproportionné ici.
 *
 * Cette page prépare donc le travail sans le faire à la place d'un
 * humain : un bouton par personne, le message déjà écrit, et un
 * marquage « envoyé » pour que la liste se vide au fur et à mesure et
 * que personne ne soit relancé deux fois.
 */
export const config = { path: '/api/relance-whatsapp' };

export default async (req) => {
  const url = new URL(req.url);

  if (!process.env.SECRET_ADMIN || url.searchParams.get('cle') !== process.env.SECRET_ADMIN) {
    return new Response('Clé invalide.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!baseConfiguree()) {
    return page('Service indisponible', '<p>La base de données n’est pas configurée.</p>');
  }

  const mois = /^\d{4}-\d{2}-01$/.test(url.searchParams.get('mois') || '')
    ? url.searchParams.get('mois')
    : new Date().toISOString().slice(0, 8) + '01';

  // --- marquage d'un envoi, en retour de clic ---
  const marquer = url.searchParams.get('marquer');
  if (marquer) {
    await marquerEnvoye(marquer, mois);
    const retour = new URL(req.url);
    retour.searchParams.delete('marquer');
    return new Response(null, { status: 303, headers: { Location: retour.toString() } });
  }

  const parametres = (await lire('parametres_rappels', 'select=*&id=eq.1'))[0] || {};
  const candidats = await rpc('engagements_a_rappeler', { p_mois: mois, p_canal: 'whatsapp' });

  const nomMois = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${mois}T12:00:00Z`));
  const base = process.env.URL || '';

  const lignes = candidats.map((c) => {
    const texte = messageRappel(c, nomMois, parametres, base);
    const lien = lienWhatsApp(c.telephone, texte);
    return { ...c, lien, texte };
  });

  const surs = lignes.filter((l) => l.lien.url && l.lien.certain);
  const douteux = lignes.filter((l) => l.lien.url && !l.lien.certain);
  const sansNumero = lignes.filter((l) => !l.lien.url);

  // Récapitulatif du mois, pour savoir où l'on en est
  const deja = await lire(
    'rappels',
    `select=canal,statut&mois=eq.${mois}`
  );
  const compte = deja.reduce((a, r) => {
    const k = `${r.canal}:${r.statut}`;
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});

  const moisPrec = decalerMois(mois, -1);
  const moisSuiv = decalerMois(mois, +1);
  const lienMois = (m) => `?cle=${encodeURIComponent(url.searchParams.get('cle'))}&mois=${m}`;

  return page(`Relances WhatsApp — ${majuscule(nomMois)}`, `
    <nav class="mois">
      <a href="${lienMois(moisPrec)}">← ${majuscule(nomMoisDe(moisPrec))}</a>
      <strong>${majuscule(nomMois)}</strong>
      <a href="${lienMois(moisSuiv)}">${majuscule(nomMoisDe(moisSuiv))} →</a>
    </nav>

    <p class="intro">
      Cliquez sur un bouton : WhatsApp s'ouvre avec le message déjà écrit, vous n'avez qu'à l'envoyer.
      En revenant sur cette page, la personne disparaît de la liste.
      <strong>Aucun message ne part tout seul.</strong>
    </p>

    <div class="compteurs">
      <div><b>${surs.length}</b><span>à relancer</span></div>
      <div><b>${douteux.length}</b><span>numéros à vérifier</span></div>
      <div><b>${compte['whatsapp:envoye'] || 0}</b><span>déjà faits ce mois-ci</span></div>
      <div><b>${compte['email:envoye'] || 0}</b><span>relancés par e-mail</span></div>
    </div>

    ${bloc('À relancer', surs, url, mois, true)}
    ${douteux.length ? `<h2>Numéros à vérifier</h2>
      <p class="note">Le format de ces numéros n'est pas certain. Vérifiez-le avant d'envoyer : un numéro mal interprété, c'est un message chez un inconnu.</p>
      ${bloc(null, douteux, url, mois, true)}` : ''}
    ${sansNumero.length ? `<h2>Sans numéro exploitable</h2>
      <p class="note">${sansNumero.length} personne(s) ont demandé WhatsApp sans numéro utilisable. À joindre autrement.</p>` : ''}

    ${lignes.length === 0 ? `<div class="vide">
      <b>Rien à relancer pour ${majuscule(nomMois)}</b>
      Soit personne n'a choisi WhatsApp, soit tout le monde a déjà été relancé ou a versé.
    </div>` : ''}
  `);
};

function bloc(titre, lignes, url, mois, avecBouton) {
  if (!lignes.length) return '';
  const cle = encodeURIComponent(url.searchParams.get('cle'));
  return (titre ? `<h2>${titre}</h2>` : '') + '<ul class="liste">' + lignes.map((l) => `
    <li>
      <div class="qui">
        <b>${echapper(l.prenom)} ${echapper(l.nom)}</b>
        <span>${echapper(l.reference)} · ${euros(l.montant_mensuel_declare)} / mois</span>
        <span class="num">${echapper(l.telephone || '—')}${l.lien.e164 ? ` → +${l.lien.e164}` : ''}</span>
        ${l.lien.motif ? `<span class="motif">${echapper(l.lien.motif)}</span>` : ''}
      </div>
      <div class="actions">
        ${avecBouton && l.lien.url
          ? `<a class="btn wa" href="${l.lien.url}" target="_blank" rel="noopener">Ouvrir WhatsApp</a>`
          : ''}
        <a class="btn fait" href="?cle=${cle}&mois=${mois}&marquer=${l.engagement_id}">Marquer comme fait</a>
      </div>
    </li>`).join('') + '</ul>';
}

function messageRappel(c, nomMois, p, base) {
  const jeton = signer(c.jeton_prive);
  const lienVerse = base
    ? `\n\nJ'ai déjà versé : ${base}/api/participant?r=${encodeURIComponent(c.reference)}&t=${jeton}&a=j-ai-verse`
    : '';
  return `Bonjour ${c.prenom},

Merci pour votre soutien au projet de Zawiya Cheikh Ibrahim Niasse.

Voici votre rappel pour la contribution de ${nomMois}, d'un montant de ${euros(c.montant_mensuel_declare)}.
Référence à indiquer : ${c.reference}

${p.instructions_reglement || ''}

Si vous avez déjà effectué votre contribution, merci de ne pas tenir compte de ce message.
Pour modifier ou suspendre votre engagement, écrivez-nous à ${p.contact_difficulte || ''}.

Merci pour votre participation.${lienVerse}`;
}

async function marquerEnvoye(engagementId, mois) {
  const champs = {
    engagement_id: engagementId,
    mois,
    canal: 'whatsapp',
    statut: 'envoye',
    tentatives: 1,
    envoye_le: new Date().toISOString(),
  };
  try {
    await inserer('rappels', champs);
  } catch (e) {
    if (e.code === '23505') {
      const [existant] = await lire(
        'rappels',
        `select=*&engagement_id=eq.${engagementId}&mois=eq.${mois}&canal=eq.whatsapp&limit=1`
      );
      if (existant) {
        await majParId('rappels', existant.id, {
          statut: 'envoye',
          tentatives: existant.tentatives + 1,
          envoye_le: new Date().toISOString(),
        });
      }
    } else {
      console.error('relance-whatsapp:marquer', e.message);
    }
  }
}

const decalerMois = (mois, n) => {
  const d = new Date(`${mois}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 8) + '01';
};
const nomMoisDe = (mois) =>
  new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${mois}T12:00:00Z`));
const majuscule = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const echapper = (t) =>
  String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(titre, corps) {
  return new Response(`<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${echapper(titre)}</title>
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Alegreya+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--pierre:#EFE8DC;--craie:#FBF8F2;--encre:#14301F;--encre-2:#4A6152;--vert:#1E7A43;--wa:#25D366;--trait:rgba(20,48,31,.16);--alerte:#B4342A}
@media (prefers-color-scheme:dark){:root{--pierre:#101F18;--craie:#17241D;--encre:#EDE6DA;--encre-2:#A9BCAE;--vert:#63BC82;--trait:rgba(237,230,218,.17);--alerte:#F0A096}}
*{box-sizing:border-box}
body{margin:0;background:var(--pierre);color:var(--encre);font-family:"Alegreya Sans",system-ui,sans-serif;font-size:16px;line-height:1.6}
.wrap{width:min(880px,94vw);margin-inline:auto;padding:2rem 0 4rem}
h1{font-family:"Marcellus",serif;font-weight:400;font-size:clamp(1.6rem,4vw,2.2rem);margin:0 0 1rem}
h2{font-family:"Marcellus",serif;font-weight:400;font-size:1.25rem;margin:2rem 0 .6rem}
p{margin:0 0 1rem;color:var(--encre-2)}
.intro{background:var(--craie);border-left:3px solid var(--vert);padding:.9rem 1.1rem;border-radius:0 3px 3px 0}
.note{font-size:.9rem;color:var(--alerte)}
.mois{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.2rem;font-size:.95rem}
.mois a{color:var(--vert);text-decoration:none}
.compteurs{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--trait);border:1px solid var(--trait);margin:1.4rem 0}
@media(max-width:620px){.compteurs{grid-template-columns:repeat(2,1fr)}}
.compteurs div{background:var(--craie);padding:.9rem}
.compteurs b{display:block;font-family:"Marcellus",serif;font-size:1.6rem;color:var(--vert);line-height:1}
.compteurs span{display:block;font-size:.8rem;color:var(--encre-2);margin-top:.3rem}
.liste{list-style:none;margin:0;padding:0}
.liste li{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;
  background:var(--craie);border:1px solid var(--trait);border-radius:3px;padding:.9rem 1rem;margin-bottom:.6rem}
.qui b{display:block;font-weight:500}
.qui span{display:block;font-size:.85rem;color:var(--encre-2)}
.qui .num{font-variant-numeric:tabular-nums}
.qui .motif{color:var(--alerte);font-size:.82rem}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;min-height:42px;padding:.55rem 1rem;border-radius:3px;
  text-decoration:none;font-size:.92rem;border:1px solid var(--trait)}
.btn.wa{background:var(--wa);border-color:var(--wa);color:#07301A;font-weight:500}
.btn.fait{background:transparent;color:var(--encre-2)}
.btn.fait:hover{border-color:var(--vert);color:var(--vert)}
.vide{border:1px dashed var(--trait);border-radius:3px;padding:2rem;text-align:center;color:var(--encre-2)}
.vide b{display:block;font-family:"Marcellus",serif;font-size:1.2rem;color:var(--encre);margin-bottom:.3rem}
</style></head><body><div class="wrap"><h1>${echapper(titre)}</h1>${corps}</div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
