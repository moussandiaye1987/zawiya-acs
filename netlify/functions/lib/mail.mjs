/**
 * Envoi d'e-mails.
 *
 * Deux fournisseurs possibles, choisis automatiquement selon la variable
 * d'environnement présente. Aucun mot de passe Gmail n'est utilisé.
 *
 *   BREVO_API_KEY   → Brevo (300 e-mails/jour gratuits, expéditeur à
 *                     vérifier par simple e-mail, sans nom de domaine)
 *   RESEND_API_KEY  → Resend (3 000/mois gratuits, nom de domaine requis
 *                     pour écrire à des tiers)
 *
 * Si aucune des deux n'est définie, l'envoi est ignoré proprement : la
 * soumission reste enregistrée et la notification est journalisée en
 * échec, prête à être rejouée.
 */

const EXPEDITEUR_EMAIL = process.env.MAIL_EXPEDITEUR || '';
const EXPEDITEUR_NOM = process.env.MAIL_EXPEDITEUR_NOM || 'Association Connaissance et Savoir';

export function fournisseurMail() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}

export function mailConfigure() {
  return Boolean(fournisseurMail() && EXPEDITEUR_EMAIL);
}

/**
 * @param {object}  options
 * @param {Array<{nom: string, base64: string}>} [options.pieces]
 *        Pièces jointes. Le contenu est déjà encodé en base64.
 *        Elles ne sont jamais déposées sur le site : elles n'existent que
 *        dans le message, à destination de l'association.
 * @returns {Promise<{envoye: boolean, motif?: string}>}
 * Ne lève jamais : un échec d'e-mail ne doit pas faire perdre une soumission.
 */
export async function envoyer({ destinataire, sujet, texte, html, pieces }) {
  if (!destinataire) return { envoye: false, motif: 'destinataire absent' };
  if (!mailConfigure()) return { envoye: false, motif: 'service e-mail non configuré' };

  const fournisseur = fournisseurMail();
  try {
    const reponse =
      fournisseur === 'brevo'
        ? await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
              'api-key': process.env.BREVO_API_KEY,
              'Content-Type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              sender: { email: EXPEDITEUR_EMAIL, name: EXPEDITEUR_NOM },
              to: [{ email: destinataire }],
              subject: sujet,
              textContent: texte,
              htmlContent: html || undefined,
              // Brevo attend { name, content } avec un contenu en base64.
              attachment: pieces && pieces.length
                ? pieces.map((p) => ({ name: p.nom, content: p.base64 }))
                : undefined,
            }),
          })
        : await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `${EXPEDITEUR_NOM} <${EXPEDITEUR_EMAIL}>`,
              to: [destinataire],
              subject: sujet,
              text: texte,
              html: html || undefined,
              // Resend attend { filename, content } avec un contenu en base64.
              attachments: pieces && pieces.length
                ? pieces.map((p) => ({ filename: p.nom, content: p.base64 }))
                : undefined,
            }),
          });

    if (!reponse.ok) {
      const detail = (await reponse.text()).slice(0, 200);
      return { envoye: false, motif: `${fournisseur} ${reponse.status} ${detail}` };
    }
    return { envoye: true };
  } catch (e) {
    return { envoye: false, motif: `${fournisseur} injoignable : ${e.message}` };
  }
}

/** Enveloppe HTML sobre, aux couleurs de l'association. */
export function gabarit(titre, corpsHtml) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#EFE8DC;font-family:Georgia,'Times New Roman',serif;color:#14301F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FBF8F2;border:1px solid rgba(20,48,31,.16);border-radius:3px">
    <tr><td style="padding:26px 28px 8px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#1E7A43">Association Connaissance et Savoir</p>
      <h1 style="margin:0;font-size:21px;font-weight:400;line-height:1.25">${titre}</h1>
    </td></tr>
    <tr><td style="padding:8px 28px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3b4f43">
      ${corpsHtml}
    </td></tr>
    <tr><td style="padding:16px 28px 22px;border-top:1px solid rgba(20,48,31,.12);font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#6b7d71">
      Zawiya Cheikh Ibrahim Niasse — Association Connaissance et Savoir<br>
      35 rue de la Petite Grille, 77400 Saint-Thibault-des-Vignes
    </td></tr>
  </table>
</body></html>`;
}

export function echapper(t) {
  return String(t ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
