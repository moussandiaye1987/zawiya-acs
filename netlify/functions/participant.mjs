import { lire, inserer, majParId, baseConfiguree } from './lib/db.mjs';
import { signer } from './lib/commun.mjs';

export const config = { path: '/api/participant' };

/**
 * Liens personnels envoyés dans les e-mails de rappel.
 *
 *   ?r=RÉFÉRENCE&t=JETON&a=j-ai-verse&m=2026-11-01
 *   ?r=RÉFÉRENCE&t=JETON&a=suspendre-rappels
 *   ?r=RÉFÉRENCE&t=JETON&a=reprendre-rappels
 *
 * Le jeton est dérivé du secret individuel de l'engagement : impossible à
 * deviner, et il ne donne accès à rien d'autre qu'à ces trois actions.
 * Une déclaration de versement n'est jamais une confirmation d'encaissement.
 */
export default async (req) => {
  const url = new URL(req.url);
  const reference = url.searchParams.get('r') || '';
  const jeton = url.searchParams.get('t') || '';
  const action = url.searchParams.get('a') || '';
  const mois = url.searchParams.get('m') || null;

  if (!baseConfiguree()) return page('Service indisponible', "Réessayez plus tard.", false);
  if (!reference || !jeton) return page('Lien incomplet', 'Ce lien est incomplet.', false);

  const [e] = await lire(
    'engagements',
    `select=id,reference,prenom,jeton_prive,rappels_actifs,montant_mensuel_declare&reference=eq.${encodeURIComponent(reference)}&limit=1`
  );
  if (!e || signer(e.jeton_prive) !== jeton) {
    return page('Lien invalide', "Ce lien n'est plus valide. Écrivez-nous et nous vous aiderons.", false);
  }

  if (action === 'suspendre-rappels') {
    await majParId('engagements', e.id, { rappels_actifs: false });
    return page(
      'Rappels suspendus',
      `Vous ne recevrez plus de rappel mensuel, ${escapeHtml(e.prenom)}.
       <strong>Votre engagement reste en place</strong> : seule la relance par e-mail s'arrête.
       Écrivez-nous si vous souhaitez le modifier ou l'interrompre.`
    );
  }

  if (action === 'reprendre-rappels') {
    await majParId('engagements', e.id, { rappels_actifs: true });
    return page('Rappels réactivés', 'Vous recevrez de nouveau le rappel mensuel.');
  }

  if (action === 'j-ai-verse') {
    const moisValide = /^\d{4}-\d{2}-01$/.test(mois || '')
      ? mois
      : new Date().toISOString().slice(0, 8) + '01';
    try {
      await inserer('versements', {
        engagement_id: e.id,
        mois: moisValide,
        montant: e.montant_mensuel_declare,
        source: 'declaration_participant',
        confirme_par_association: false,
      });
    } catch (err) {
      if (err.code !== '23505') {
        console.error('participant:versement', err.message);
        return page('Enregistrement impossible', 'Réessayez dans un instant.', false);
      }
    }
    return page(
      'Merci, c’est noté',
      `Votre déclaration est enregistrée, ${escapeHtml(e.prenom)}.
       <strong>L'association la vérifiera auprès de la banque</strong> : cette déclaration ne vaut pas
       confirmation d'encaissement. Vous ne recevrez plus de rappel pour ce mois-ci.`
    );
  }

  return page('Action inconnue', 'Ce lien ne correspond à aucune action.', false);
};

function escapeHtml(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(titre, corps, succes = true) {
  const html = `<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titre)} — Zawiya Cheikh Ibrahim Niasse</title>
<link rel="icon" href="/favicon.png" sizes="32x32">
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Alegreya+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--pierre:#EFE8DC;--craie:#FBF8F2;--encre:#14301F;--encre-2:#4A6152;--vert:#1E7A43;--trait:rgba(20,48,31,.16)}
@media (prefers-color-scheme:dark){:root{--pierre:#101F18;--craie:#0B1611;--encre:#EDE6DA;--encre-2:#A9BCAE;--vert:#63BC82;--trait:rgba(237,230,218,.17)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--pierre);color:var(--encre);
 font-family:"Alegreya Sans",system-ui,sans-serif;font-size:17px;line-height:1.6;padding:2rem}
main{width:min(540px,92vw);background:var(--craie);border:1px solid var(--trait);border-radius:3px;padding:2rem 1.8rem}
h1{font-family:"Marcellus",serif;font-weight:400;font-size:1.7rem;margin:0 0 .9rem;line-height:1.2}
p{margin:0 0 1.1rem;color:var(--encre-2)}
strong{color:var(--encre);font-weight:500}
a.btn{display:inline-block;background:var(--vert);color:var(--craie);text-decoration:none;padding:.8rem 1.3rem;border-radius:3px}
.marque{font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;color:var(--vert);margin-bottom:.5rem}
</style></head><body><main>
<p class="marque">Association Connaissance et Savoir</p>
<h1>${escapeHtml(titre)}</h1>
<p>${corps}</p>
<a class="btn" href="/">Retour au site</a>
</main></body></html>`;
  return new Response(html, {
    status: succes ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
