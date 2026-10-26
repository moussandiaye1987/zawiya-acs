import { createHash, randomBytes } from 'node:crypto';
import { lire, inserer, majParId, baseConfiguree } from './lib/db.mjs';
import { envoyer, gabarit, echapper } from './lib/mail.mjs';
import { geocoder } from './lib/geocodage.mjs';
import {
  json, erreur, corpsJSON, nettoyer, estEmail, empreinteIP,
  suspectRobot, fabriquerReference,
  destinatairesAssociation,
} from './lib/commun.mjs';

/**
 * Modification des coordonnées d'une Dahira déjà référencée.
 *
 * Trois garde-fous, dans cet ordre :
 *   1. Personne ne modifie une fiche depuis le site public. Il faut un
 *      lien envoyé à l'adresse e-mail DÉJÀ enregistrée sur la fiche.
 *   2. Un changement d'adresse e-mail doit être confirmé depuis la
 *      NOUVELLE adresse, sinon il est ignoré.
 *   3. Rien n'est publié avant que l'association n'ait validé. La fiche
 *      en ligne garde ses anciennes valeurs jusque-là.
 *
 * Les jetons ne sont stockés qu'en condensat : la base ne permet pas de
 * reconstituer un lien.
 *
 *   POST /api/dahira-modification   {action: 'demander'|'soumettre', …}
 *   GET  /api/dahira-modification?t=JETON          formulaire
 *   GET  /api/dahira-modification?v=JETON_EMAIL    confirmation d'adresse
 */
export const config = { path: '/api/dahira-modification' };

const VALIDITE_HEURES = 48;
const MAX_DEMANDES_PAR_HEURE = 3;

const condenser = (jeton) => createHash('sha256').update(String(jeton)).digest('hex');
const nouveauJeton = () => randomBytes(24).toString('hex');
const dansHeures = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

export default async (req) => {
  if (!baseConfiguree()) {
    return req.method === 'GET'
      ? pageHTML('Service indisponible', '<p>Réessayez dans quelques minutes.</p>', false)
      : erreur('Service momentanément indisponible.', 503);
  }

  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('v')) return confirmerNouvelEmail(url.searchParams.get('v'));
    if (url.searchParams.get('t')) return formulaireModification(url.searchParams.get('t'));
    return pageHTML('Lien incomplet', '<p>Ce lien est incomplet.</p>', false);
  }

  if (req.method !== 'POST') return erreur('Méthode non autorisée.', 405);

  const d = await corpsJSON(req);
  if (!d) return erreur('Requête illisible.', 400);
  if (suspectRobot(d)) return json({ ok: true, ignore: true });

  if (d.action === 'demander') return demanderAcces(d, req);
  if (d.action === 'soumettre') return soumettreModification(d, req);
  return erreur('Action inconnue.', 400);
};

/* =====================================================================
   1. DEMANDE D'ACCÈS
   ===================================================================== */
async function demanderAcces(d, req) {
  const nom = nettoyer(d.nom, 120);
  const ville = nettoyer(d.ville, 120);
  const email = nettoyer(d.email, 160);
  const voie = d.voie === 'sans_acces_email' ? 'sans_acces_email' : 'par_email';

  const fautes = {};
  if (!nom) fautes.nom = 'Indiquez le nom de la Dahira.';
  if (!ville) fautes.ville = 'Indiquez sa ville.';
  if (voie === 'par_email' && !estEmail(email)) {
    fautes.email = "Indiquez l'adresse e-mail enregistrée sur la fiche.";
  }
  if (voie === 'sans_acces_email' && !estEmail(nettoyer(d.email_contact, 160))) {
    fautes.email_contact = 'Indiquez une adresse où nous pouvons vous joindre.';
  }
  if (Object.keys(fautes).length) {
    return erreur('Certains champs sont à corriger.', 422, { fautes });
  }

  // Recherche de la fiche. On ne dira jamais au demandeur si elle existe.
  const fiches = await lire(
    'dahiras',
    `select=id,nom,ville,responsable_email,responsable_nom,statut` +
    `&nom=ilike.${encodeURIComponent(nom)}&ville=ilike.${encodeURIComponent(ville)}` +
    `&est_test=is.false&limit=2`
  );
  const fiche = fiches.length === 1 ? fiches[0] : null;
  const ip_hash = empreinteIP(req);

  if (fiche) {
    const recentes = await lire(
      'dahiras_modifications',
      `select=id&dahira_id=eq.${fiche.id}&demande_le=gte.${new Date(Date.now() - 3600000).toISOString()}`
    );
    if (recentes.length >= MAX_DEMANDES_PAR_HEURE) {
      return reponseNeutre(voie);
    }
  }

  // --- voie B : le responsable n'a plus accès à l'adresse enregistrée ---
  if (voie === 'sans_acces_email') {
    if (fiche) {
      const demande = await inserer('dahiras_modifications', {
        dahira_id: fiche.id,
        reference: fabriquerReference('DEMANDE'),
        origine: 'validation_manuelle',
        statut: 'a_valider',
        note_interne:
          `Le demandeur déclare ne plus avoir accès à ${fiche.responsable_email}. ` +
          `Il indique : ${nettoyer(d.email_contact, 160)} ` +
          `${nettoyer(d.telephone_contact, 40) || ''} ` +
          `${nettoyer(d.explication, 600) || ''}`.trim(),
        ip_hash,
      });
      await prevenirAssociation(fiche, demande, 'manuelle');
    }
    return json({
      ok: true,
      message:
        "Votre demande est transmise à l'association. Un membre du bureau vous recontactera " +
        "pour vérifier votre qualité de responsable avant toute modification.",
    });
  }

  // --- voie A : lien envoyé à l'adresse déjà enregistrée ---
  // Le lien ne part QUE si l'adresse saisie est celle de la fiche. La
  // réponse est identique dans tous les cas, pour ne rien révéler.
  if (fiche && fiche.responsable_email &&
      fiche.responsable_email.toLowerCase() === email.toLowerCase()) {
    const jeton = nouveauJeton();
    const demande = await inserer('dahiras_modifications', {
      dahira_id: fiche.id,
      reference: fabriquerReference('DEMANDE'),
      origine: 'lien_email',
      jeton_hash: condenser(jeton),
      jeton_expire_le: dansHeures(VALIDITE_HEURES),
      statut: 'lien_envoye',
      ip_hash,
    });
    await envoyerLienModification(fiche, demande, jeton);
  }

  return reponseNeutre('par_email');
}

function reponseNeutre(voie) {
  return json({
    ok: true,
    message: voie === 'par_email'
      ? "Si cette Dahira est référencée et que l'adresse correspond à celle enregistrée, " +
        "un lien de modification vient d'y être envoyé. Il est valable 48 heures."
      : "Votre demande est transmise à l'association.",
  });
}

async function envoyerLienModification(fiche, demande, jeton) {
  const base = process.env.URL || '';
  const lien = `${base}/api/dahira-modification?t=${jeton}`;
  const corps = `
    <p>Bonjour ${echapper(fiche.responsable_nom || '')},</p>
    <p>Une demande de modification a été faite pour la fiche de la Dahira
       <strong>${echapper(fiche.nom)}</strong> (${echapper(fiche.ville)}).</p>
    <p><a href="${lien}" style="display:inline-block;background:#1E7A43;color:#FBF8F2;text-decoration:none;padding:11px 20px;border-radius:3px">Modifier les informations</a></p>
    <p style="font-size:13px;color:#6b7d71">Ce lien est valable 48 heures et ne fonctionne qu'une fois.
       Les nouvelles coordonnées ne seront publiées qu'après vérification par l'association ;
       d'ici là, la fiche en ligne reste inchangée.</p>
    <p style="font-size:13px;color:#6b7d71">Si vous n'êtes pas à l'origine de cette demande,
       ignorez ce message : rien ne sera modifié.</p>`;
  return envoyer({
    destinataire: fiche.responsable_email,
    sujet: `Modifier la fiche de ${fiche.nom} — ${demande.reference}`,
    texte: `Bonjour,\n\nUne demande de modification a été faite pour la fiche de la Dahira ${fiche.nom} (${fiche.ville}).\n\n` +
      `Pour modifier les informations : ${lien}\n\n` +
      `Ce lien est valable 48 heures. Les nouvelles coordonnées ne seront publiées qu'après vérification par l'association.\n` +
      `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    html: gabarit('Modifier la fiche de votre Dahira', corps),
  });
}

/* =====================================================================
   2. FORMULAIRE DE MODIFICATION
   ===================================================================== */
async function formulaireModification(jeton) {
  const demande = await demandeParJeton(jeton);
  if (!demande) {
    return pageHTML('Lien expiré ou déjà utilisé',
      `<p>Ce lien n'est plus valable. Les liens expirent au bout de 48 heures et ne servent qu'une fois.</p>
       <p>Revenez sur le site et demandez-en un nouveau depuis « Modifier les informations de ma Dahira ».</p>`,
      false);
  }

  const [fiche] = await lire(
    'dahiras',
    `select=nom,ville,code_postal,lieu_activites,responsable_email,responsable_telephone,` +
    `contact_public_telephone,contact_public_autorise&id=eq.${demande.dahira_id}&limit=1`
  );
  if (!fiche) return pageHTML('Fiche introuvable', '<p>Cette fiche n’existe plus.</p>', false);

  const v = (x) => echapper(x || '');
  const corps = `
    <p class="intro">Modifiez ce qui doit l'être et laissez le reste tel quel.
       <strong>Rien n'est publié immédiatement</strong> : l'association vérifie les changements
       avant leur mise en ligne, et la fiche actuelle reste visible d'ici là.</p>

    <form id="formModif" novalidate>
      <input type="hidden" id="jeton" value="${echapper(jeton)}">
      <h2>${v(fiche.nom)} — ${v(fiche.ville)}</h2>

      <fieldset>
        <legend>Lieu des activités</legend>
        <label for="lieu">Adresse ou repère</label>
        <input id="lieu" type="text" value="${v(fiche.lieu_activites)}" placeholder="Salle, domicile, mosquée…">
        <div class="paire">
          <div>
            <label for="cp">Code postal</label>
            <input id="cp" type="text" inputmode="numeric" maxlength="5" value="${v(fiche.code_postal)}">
          </div>
          <div>
            <label for="ville">Ville</label>
            <input id="ville" type="text" value="${v(fiche.ville)}">
          </div>
        </div>
        <p class="aide">Si l'adresse change, la position sur la carte sera recalculée.</p>
      </fieldset>

      <fieldset>
        <legend>Téléphones</legend>
        <label for="telResp">Téléphone du responsable <span class="prive">privé</span></label>
        <input id="telResp" type="tel" inputmode="tel" value="${v(fiche.responsable_telephone)}">
        <label for="telPublic">Téléphone affiché dans l'annuaire</label>
        <input id="telPublic" type="tel" inputmode="tel" value="${v(fiche.contact_public_telephone)}">
        <label class="case">
          <input type="checkbox" id="publierTel" ${fiche.contact_public_autorise ? 'checked' : ''}>
          <span>Afficher ce numéro publiquement</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Adresse e-mail du responsable</legend>
        <p class="aide">Actuelle : <strong>${v(fiche.responsable_email)}</strong></p>
        <label for="nouvelEmail">Nouvelle adresse, si elle change</label>
        <input id="nouvelEmail" type="email" inputmode="email" placeholder="Laisser vide pour la conserver">
        <p class="aide">Une nouvelle adresse doit être confirmée depuis cette adresse avant d'être prise en compte.</p>
      </fieldset>

      <button type="submit" class="btn" id="btnModif">Envoyer ma demande</button>
      <p class="statut" id="statut" role="status"></p>
    </form>

    <script>
      const f = document.getElementById('formModif');
      const b = document.getElementById('btnModif');
      let envoi = false;
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (envoi) return;
        envoi = true; b.disabled = true; b.textContent = 'Envoi…';
        const s = document.getElementById('statut');
        s.className = 'statut'; s.textContent = '';
        try {
          const r = await fetch('/api/dahira-modification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'soumettre',
              jeton: document.getElementById('jeton').value,
              lieu_activites: document.getElementById('lieu').value,
              code_postal: document.getElementById('cp').value,
              ville: document.getElementById('ville').value,
              responsable_telephone: document.getElementById('telResp').value,
              contact_public_telephone: document.getElementById('telPublic').value,
              contact_public_autorise: document.getElementById('publierTel').checked,
              nouvel_email: document.getElementById('nouvelEmail').value
            })
          });
          const rep = await r.json();
          if (r.ok && rep.ok) {
            f.innerHTML = '<h2>C\\'est envoyé</h2><p>' + rep.message + '</p>';
            return;
          }
          s.className = 'statut ko';
          s.textContent = rep.message || 'L\\'envoi a échoué. Réessayez dans un instant.';
        } catch (err) {
          s.className = 'statut ko';
          s.textContent = 'Connexion impossible. Vos informations sont conservées.';
        } finally {
          envoi = false; b.disabled = false; b.textContent = 'Envoyer ma demande';
        }
      });
    </script>`;
  return pageHTML('Modifier les informations de ma Dahira', corps);
}

async function demandeParJeton(jeton) {
  if (!jeton || jeton.length < 20) return null;
  const [d] = await lire(
    'dahiras_modifications',
    `select=*&jeton_hash=eq.${condenser(jeton)}&jeton_utilise=is.false&statut=eq.lien_envoye&limit=1`
  );
  if (!d) return null;
  if (d.jeton_expire_le && new Date(d.jeton_expire_le) < new Date()) {
    await majParId('dahiras_modifications', d.id, { statut: 'expiree' });
    return null;
  }
  return d;
}

/* =====================================================================
   3. SOUMISSION DES CHANGEMENTS
   ===================================================================== */
async function soumettreModification(d, req) {
  const demande = await demandeParJeton(nettoyer(d.jeton, 80));
  if (!demande) {
    return erreur("Ce lien n'est plus valable. Demandez-en un nouveau depuis le site.", 410);
  }

  const [fiche] = await lire(
    'dahiras',
    `select=id,nom,ville,code_postal,lieu_activites,responsable_email,responsable_telephone,` +
    `contact_public_telephone,contact_public_autorise&id=eq.${demande.dahira_id}&limit=1`
  );
  if (!fiche) return erreur('Fiche introuvable.', 404);

  const lieu = nettoyer(d.lieu_activites, 300);
  const cp = nettoyer(d.code_postal, 10);
  const ville = nettoyer(d.ville, 120);
  const telResp = nettoyer(d.responsable_telephone, 40);
  const telPublic = nettoyer(d.contact_public_telephone, 40);
  const publierTel = d.contact_public_autorise === true;
  const nouvelEmail = nettoyer(d.nouvel_email, 160);

  const fautes = {};
  if (cp && !/^\d{5}$/.test(cp)) fautes.code_postal = 'Le code postal doit comporter 5 chiffres.';
  if (!ville) fautes.ville = 'La ville ne peut pas être vide.';
  if (nouvelEmail && !estEmail(nouvelEmail)) fautes.nouvel_email = 'Cette adresse ne semble pas valide.';
  if (nouvelEmail && nouvelEmail.toLowerCase() === (fiche.responsable_email || '').toLowerCase()) {
    fautes.nouvel_email = "C'est déjà l'adresse enregistrée.";
  }
  if (Object.keys(fautes).length) {
    return erreur('Certains champs sont à corriger.', 422, { fautes });
  }

  // On n'enregistre que ce qui change réellement : le reste reste NULL,
  // et le déclencheur de la base interprète NULL comme « inchangé ».
  const different = (nouveau, ancien) =>
    nouveau !== null && String(nouveau) !== String(ancien ?? '') ? nouveau : null;

  const champs = {
    n_lieu_activites: different(lieu, fiche.lieu_activites),
    n_code_postal: different(cp, fiche.code_postal),
    n_ville: different(ville, fiche.ville),
    n_responsable_telephone: different(telResp, fiche.responsable_telephone),
    n_contact_public_telephone: different(telPublic, fiche.contact_public_telephone),
    n_contact_public_autorise:
      publierTel !== Boolean(fiche.contact_public_autorise) ? publierTel : null,
  };

  const adresseChange =
    champs.n_lieu_activites !== null || champs.n_code_postal !== null || champs.n_ville !== null;

  // Nouvelle position sur la carte si l'adresse bouge. Un échec de
  // géocodage n'empêche pas la demande : la fiche restera sans point.
  if (adresseChange) {
    const point = await geocoder({
      adresse: lieu || fiche.lieu_activites,
      code_postal: cp || fiche.code_postal,
      ville: ville || fiche.ville,
    });
    if (point) {
      champs.n_latitude = point.latitude;
      champs.n_longitude = point.longitude;
    }
  }

  const changeQuelqueChose =
    Object.values(champs).some((v) => v !== null && v !== undefined) || Boolean(nouvelEmail);
  if (!changeQuelqueChose) {
    return erreur("Aucun changement n'a été détecté.", 422);
  }

  let jetonEmail = null;
  if (nouvelEmail) {
    jetonEmail = nouveauJeton();
    champs.email_a_verifier = nouvelEmail;
    champs.jeton_email_hash = condenser(jetonEmail);
    champs.jeton_email_expire_le = dansHeures(VALIDITE_HEURES);
    champs.email_verifie = false;
  }

  champs.jeton_utilise = true;
  champs.jeton_hash = null;              // le lien ne doit plus resservir
  champs.statut = nouvelEmail ? 'email_a_verifier' : 'a_valider';

  const majDemande = await majParId('dahiras_modifications', demande.id, champs);

  if (nouvelEmail) await envoyerVerificationEmail(fiche, majDemande, nouvelEmail, jetonEmail);
  await prevenirAssociation(fiche, majDemande, nouvelEmail ? 'email_en_attente' : 'a_valider');

  return json({
    ok: true,
    reference: majDemande.reference,
    message: nouvelEmail
      ? `Un message de confirmation vient d'être envoyé à ${nouvelEmail}. ` +
        `Cliquez sur le lien qu'il contient, puis l'association vérifiera l'ensemble avant publication. ` +
        `Votre fiche actuelle reste inchangée d'ici là.`
      : "Votre demande est transmise à l'association. Les nouvelles informations seront publiées " +
        "après vérification ; votre fiche actuelle reste visible d'ici là.",
  });
}

async function envoyerVerificationEmail(fiche, demande, nouvelEmail, jeton) {
  const base = process.env.URL || '';
  const lien = `${base}/api/dahira-modification?v=${jeton}`;
  const corps = `
    <p>Bonjour,</p>
    <p>Cette adresse a été indiquée comme nouvelle adresse de contact pour la Dahira
       <strong>${echapper(fiche.nom)}</strong> (${echapper(fiche.ville)}).</p>
    <p><a href="${lien}" style="display:inline-block;background:#1E7A43;color:#FBF8F2;text-decoration:none;padding:11px 20px;border-radius:3px">Confirmer cette adresse</a></p>
    <p style="font-size:13px;color:#6b7d71">Sans cette confirmation, l'adresse ne sera pas modifiée.
       Le lien est valable 48 heures. L'association vérifiera ensuite la demande avant publication.</p>
    <p style="font-size:13px;color:#6b7d71">Si vous ne connaissez pas cette Dahira, ignorez ce message.</p>`;
  return envoyer({
    destinataire: nouvelEmail,
    sujet: `Confirmez votre adresse pour ${fiche.nom}`,
    texte: `Bonjour,\n\nCette adresse a été indiquée comme nouvelle adresse de contact pour la Dahira ${fiche.nom} (${fiche.ville}).\n\n` +
      `Pour la confirmer : ${lien}\n\nSans confirmation, l'adresse ne sera pas modifiée. Lien valable 48 heures.`,
    html: gabarit('Confirmez votre adresse e-mail', corps),
  });
}

/* =====================================================================
   4. CONFIRMATION DE LA NOUVELLE ADRESSE
   ===================================================================== */
async function confirmerNouvelEmail(jeton) {
  if (!jeton || jeton.length < 20) {
    return pageHTML('Lien invalide', '<p>Ce lien est incomplet.</p>', false);
  }
  const [demande] = await lire(
    'dahiras_modifications',
    `select=*&jeton_email_hash=eq.${condenser(jeton)}&email_verifie=is.false&limit=1`
  );
  if (!demande) {
    return pageHTML('Lien expiré ou déjà utilisé',
      '<p>Cette adresse a peut-être déjà été confirmée. Écrivez-nous si vous avez un doute.</p>', false);
  }
  if (demande.jeton_email_expire_le && new Date(demande.jeton_email_expire_le) < new Date()) {
    return pageHTML('Lien expiré',
      '<p>Ce lien a dépassé ses 48 heures. Recommencez la demande depuis le site.</p>', false);
  }

  await majParId('dahiras_modifications', demande.id, {
    email_verifie: true,
    jeton_email_hash: null,
    statut: 'a_valider',
  });

  const [fiche] = await lire('dahiras', `select=nom,ville&id=eq.${demande.dahira_id}&limit=1`);
  if (fiche) await prevenirAssociation(fiche, demande, 'a_valider');

  return pageHTML('Adresse confirmée',
    `<p>Merci, votre adresse est confirmée.</p>
     <p><strong>L'association vérifie maintenant la demande</strong> avant de publier les nouvelles
        coordonnées. Votre fiche actuelle reste visible d'ici là.</p>`);
}

/* =====================================================================
   NOTIFICATION DU BUREAU
   ===================================================================== */
async function prevenirAssociation(fiche, demande, motif) {
  const destinataire = destinatairesAssociation();
  if (!destinataire.length) return { envoye: false, motif: 'destinataire absent' };

  const titres = {
    manuelle: 'Demande de modification sans accès à l’e-mail',
    email_en_attente: 'Modification de fiche — adresse e-mail en attente de confirmation',
    a_valider: 'Modification de fiche à valider',
  };
  const ligne = (t, v) =>
    v ? `<tr><td style="color:#6b7d71">${t}</td><td>${echapper(v)}</td></tr>` : '';

  const corps = `
    <p><strong>${echapper(titres[motif] || titres.a_valider)}</strong></p>
    <table cellpadding="4" style="font-size:14px">
      <tr><td style="color:#6b7d71">Dahira</td><td><strong>${echapper(fiche.nom)}</strong> — ${echapper(fiche.ville)}</td></tr>
      <tr><td style="color:#6b7d71">Référence</td><td>${echapper(demande.reference)}</td></tr>
      ${ligne('Nouveau lieu', demande.n_lieu_activites)}
      ${ligne('Nouvelle ville', demande.n_ville)}
      ${ligne('Nouveau code postal', demande.n_code_postal)}
      ${ligne('Nouveau téléphone du responsable', demande.n_responsable_telephone)}
      ${ligne('Nouveau téléphone public', demande.n_contact_public_telephone)}
      ${demande.email_a_verifier
        ? `<tr><td style="color:#6b7d71">Nouvelle adresse e-mail</td><td>${echapper(demande.email_a_verifier)}
           — <strong>${demande.email_verifie ? 'confirmée' : 'EN ATTENTE de confirmation'}</strong></td></tr>`
        : ''}
      ${ligne('Note', demande.note_interne)}
    </table>
    ${motif === 'manuelle'
      ? `<p style="background:#F6E7E5;border-left:3px solid #B4342A;padding:10px 14px;font-size:14px">
           Le demandeur déclare ne plus avoir accès à l'adresse enregistrée. <strong>Vérifiez son identité
           par un autre moyen</strong> avant toute modification : aucun lien de vérification n'a été envoyé.</p>`
      : `<p style="font-size:14px">Pour publier : passer <code>statut</code> à <code>validee</code> sur la ligne
         <code>${echapper(demande.reference)}</code> de la table <code>dahiras_modifications</code>.
         Les champs renseignés seront alors reportés automatiquement sur la fiche.
         La vue <code>v_modifications_a_valider</code> montre l'ancien et le nouveau côte à côte.</p>`}
    <p style="font-size:13px;color:#6b7d71">Tant que vous n'avez rien validé, la fiche en ligne reste inchangée.</p>`;

  return envoyer({
    destinataire,
    sujet: `${titres[motif] || titres.a_valider} — ${fiche.nom}`,
    texte: `${titres[motif] || titres.a_valider}\n\nDahira : ${fiche.nom} (${fiche.ville})\n` +
      `Référence : ${demande.reference}\n\n` +
      `À valider dans la table dahiras_modifications : statut = validee.\n` +
      `Tant que rien n'est validé, la fiche en ligne reste inchangée.`,
    html: gabarit(titres[motif] || titres.a_valider, corps),
  });
}

/* =====================================================================
   PAGE HTML
   ===================================================================== */
function pageHTML(titre, corps, succes = true) {
  return new Response(`<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${echapper(titre)} — Zawiya Cheikh Ibrahim Niasse</title>
<link rel="icon" href="/favicon.png" sizes="32x32">
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Alegreya+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--pierre:#EFE8DC;--craie:#FBF8F2;--encre:#14301F;--encre-2:#4A6152;--vert:#1E7A43;--trait:rgba(20,48,31,.18);--alerte:#B4342A}
@media (prefers-color-scheme:dark){:root{--pierre:#101F18;--craie:#17241D;--encre:#EDE6DA;--encre-2:#A9BCAE;--vert:#63BC82;--trait:rgba(237,230,218,.18);--alerte:#F0A096}}
*{box-sizing:border-box}
body{margin:0;background:var(--pierre);color:var(--encre);font-family:"Alegreya Sans",system-ui,sans-serif;font-size:17px;line-height:1.62;padding:2rem 0 4rem}
main{width:min(600px,92vw);margin-inline:auto;background:var(--craie);border:1px solid var(--trait);border-radius:3px;padding:1.8rem 1.6rem 2rem}
h1{font-family:"Marcellus",serif;font-weight:400;font-size:clamp(1.5rem,4.4vw,2rem);margin:0 0 .9rem;line-height:1.2}
h2{font-family:"Marcellus",serif;font-weight:400;font-size:1.22rem;margin:0 0 .8rem}
p{margin:0 0 1rem;color:var(--encre-2)}
strong{color:var(--encre);font-weight:500}
.marque{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:var(--vert);margin-bottom:.4rem}
.intro{background:var(--pierre);border-left:3px solid var(--vert);padding:.85rem 1.05rem;border-radius:0 3px 3px 0}
fieldset{border:1px solid var(--trait);border-radius:3px;padding:1rem 1.05rem 1.1rem;margin:0 0 1.1rem}
legend{font-size:.85rem;color:var(--encre-2);padding:0 .4rem}
label{display:block;font-size:.87rem;color:var(--encre-2);margin:.7rem 0 .3rem}
label:first-of-type{margin-top:0}
input[type=text],input[type=tel],input[type=email]{width:100%;font-family:inherit;font-size:16px;color:var(--encre);
 background:var(--pierre);border:1px solid var(--trait);border-radius:3px;padding:.72rem .8rem}
input:focus{outline:2px solid var(--vert);outline-offset:1px;border-color:var(--vert)}
.paire{display:grid;grid-template-columns:1fr 2fr;gap:.8rem}
@media(max-width:480px){.paire{grid-template-columns:1fr}}
.case{display:flex;gap:.6rem;align-items:flex-start;margin-top:.8rem;font-size:.92rem}
.case input{width:19px;height:19px;accent-color:var(--vert);margin-top:.2rem;flex:0 0 auto}
.aide{font-size:.83rem;color:var(--encre-2);margin:.4rem 0 0}
.prive{font-size:.74rem;background:var(--pierre);border:1px solid var(--trait);border-radius:99px;padding:.1rem .45rem;margin-left:.3rem}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;width:100%;cursor:pointer;
 font-family:inherit;font-size:1rem;padding:.8rem 1.3rem;border-radius:3px;border:1px solid var(--vert);
 background:var(--vert);color:var(--craie);text-decoration:none}
.btn:hover{background:var(--encre);border-color:var(--encre);color:var(--pierre)}
.btn[disabled]{opacity:.55;cursor:progress}
.statut{font-size:.92rem;color:var(--vert);min-height:1.3em;margin:.8rem 0 0}
.statut.ko{color:var(--alerte)}
.retour{display:inline-block;margin-top:1.2rem;color:var(--vert);font-size:.93rem}
</style></head><body><main>
<p class="marque">Association Connaissance et Savoir</p>
<h1>${echapper(titre)}</h1>
${corps}
<a class="retour" href="/#dahiras">← Retour à l'annuaire</a>
</main></body></html>`,
    { status: succes ? 200 : 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
