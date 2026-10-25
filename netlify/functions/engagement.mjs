import { inserer, insererIdempotent, lire, rpc, baseConfiguree, ErreurBase } from './lib/db.mjs';
import { envoyer, gabarit, echapper } from './lib/mail.mjs';
import {
  json, erreur, corpsJSON, nettoyer, estEmail, empreinteIP, suspectRobot,
  departementDepuisCP, fabriquerReference, euros, signer,
  VERSION_CONSENTEMENT, MENTION_SANS_PAIEMENT, FORFAITS, ZONES, DUREES,
} from './lib/commun.mjs';

export const config = { path: '/api/engagement' };

const MAX_PAR_HEURE = 5;

export default async (req, context) => {
  if (req.method !== 'POST') return erreur('Méthode non autorisée.', 405);
  if (!baseConfiguree()) {
    return erreur(
      "L'enregistrement est momentanément indisponible. Réessayez plus tard ou contactez l'association.",
      503
    );
  }

  const d = await corpsJSON(req);
  if (!d) return erreur('Requête illisible.', 400);

  // --- pièges anti-robot (réponse volontairement identique à un succès) ---
  const robot = suspectRobot(d);
  if (robot) {
    return json({ ok: true, reference: 'ZAWIYA-0000-XXXXXX', ignore: true });
  }

  // --- validation côté serveur, indépendante du navigateur ---
  const champs = {
    prenom: nettoyer(d.prenom, 80),
    nom: nettoyer(d.nom, 80),
    email: nettoyer(d.email, 160),
    telephone: nettoyer(d.telephone, 40),
    code_postal: nettoyer(d.code_postal, 10),
    ville: nettoyer(d.ville, 120),
    zone: nettoyer(d.zone, 60),
    dahira: nettoyer(d.dahira, 120),
    preference_reglement: nettoyer(d.preference_reglement, 80),
    message: nettoyer(d.message, 1000),
  };
  const fautes = {};

  if (!champs.prenom) fautes.prenom = 'Indiquez votre prénom.';
  if (!champs.nom) fautes.nom = 'Indiquez votre nom.';
  if (!champs.email && !champs.telephone) {
    fautes.email = 'Indiquez au moins un e-mail ou un téléphone.';
  }
  if (champs.email && !estEmail(champs.email)) {
    fautes.email = "Cette adresse e-mail ne semble pas valide.";
  }
  if (champs.telephone && champs.telephone.replace(/\D/g, '').length < 8) {
    fautes.telephone = 'Ce numéro semble incomplet.';
  }
  if (champs.zone && !ZONES.includes(champs.zone)) fautes.zone = 'Zone inconnue.';

  const forfait = nettoyer(d.forfait, 20);
  if (!forfait || !FORFAITS[forfait]) fautes.forfait = 'Choisissez un forfait.';

  let montant = FORFAITS[forfait]?.montant;
  if (forfait === 'libre') {
    montant = Number(String(d.montant_mensuel_declare).replace(',', '.'));
    if (!Number.isFinite(montant) || montant < 5 || montant > 100000) {
      fautes.montant_mensuel_declare = 'Indiquez un montant mensuel entre 5 et 100 000 €.';
    }
  }

  const duree = Number(d.duree_mois);
  if (!DUREES.includes(duree)) fautes.duree_mois = 'Choisissez une durée.';

  if (d.consentement !== true) {
    fautes.consentement = 'Cochez la case de consentement pour enregistrer votre engagement.';
  }

  if (Object.keys(fautes).length) {
    return erreur('Certains champs sont à corriger.', 422, { fautes });
  }

  // --- limitation de débit ---
  const ip_hash = empreinteIP(req);
  try {
    const recents = await rpc('compte_soumissions_recentes', { p_ip_hash: ip_hash, p_minutes: 60 });
    if (Number(recents) >= MAX_PAR_HEURE) {
      return erreur("Trop d'envois depuis cet appareil. Réessayez dans une heure.", 429);
    }
  } catch { /* le limiteur ne doit jamais bloquer un envoi légitime */ }

  // --- enregistrement ---
  const ligne = {
    reference: fabriquerReference(),
    ...champs,
    departement: departementDepuisCP(champs.code_postal),
    forfait,
    montant_mensuel_declare: montant,
    duree_mois: duree,
    consentement: true,
    consentement_version: VERSION_CONSENTEMENT,
    consentement_le: new Date().toISOString(),
    // canaux de rappel : chacun doit être possible ET consenti
    rappel_email: d.rappel_email === true && Boolean(champs.email),
    rappel_whatsapp: d.rappel_whatsapp === true && Boolean(champs.telephone),
    consentement_rappels: d.rappel_email === true || d.rappel_whatsapp === true,
    rappels_actifs: (d.rappel_email === true && Boolean(champs.email))
                 || (d.rappel_whatsapp === true && Boolean(champs.telephone)),
    canal_rappel: d.rappel_email === true && champs.email ? 'email'
                : d.rappel_whatsapp === true && champs.telephone ? 'whatsapp' : 'aucun',
    est_test: d.est_test === true,
    ip_hash,
  };

  let enregistrement, deja;
  try {
    ({ enregistrement, deja } = await insererIdempotent(
      'engagements', ligne, nettoyer(d.cle_idempotence, 64)
    ));
  } catch (e) {
    if (e instanceof ErreurBase && e.code === '23505') {
      // index unique sur l'e-mail : un engagement actif existe déjà
      return erreur(
        "Un engagement est déjà enregistré avec cette adresse e-mail. Contactez l'association pour le modifier.",
        409
      );
    }
    console.error('engagement:insertion', e.message);
    return erreur("L'enregistrement a échoué. Réessayez dans un instant.", 502);
  }

  // Réponse immédiate si c'est un renvoi : pas de second e-mail.
  if (deja) {
    return json({ ok: true, deja: true, reference: enregistrement.reference, mention: MENTION_SANS_PAIEMENT });
  }

  // --- notifications : après l'enregistrement, et sans pouvoir l'annuler ---
  await notifier(enregistrement, context);

  return json({
    ok: true,
    reference: enregistrement.reference,
    total_previsionnel: Number(enregistrement.total_previsionnel),
    contribution_horizon_24: Number(enregistrement.montant_mensuel_declare) * Math.min(duree, 24),
    mention: MENTION_SANS_PAIEMENT,
  });
};

async function notifier(e, context) {
  const base = process.env.URL || context?.site?.url || '';
  const destAssoc = process.env.EMAIL_ASSOCIATION;
  const tableauBord = process.env.URL_TABLEAU_BORD || '';

  const taches = [];

  if (destAssoc) {
    const corps = `
      <p><strong>Nouvel engagement enregistré.</strong> Aucun paiement n'a été effectué.</p>
      <table cellpadding="4" style="font-size:14px">
        <tr><td style="color:#6b7d71">Référence</td><td><strong>${echapper(e.reference)}</strong></td></tr>
        <tr><td style="color:#6b7d71">Nom</td><td>${echapper(e.prenom)} ${echapper(e.nom)}</td></tr>
        <tr><td style="color:#6b7d71">Contact</td><td>${echapper(e.email || '—')} · ${echapper(e.telephone || '—')}</td></tr>
        <tr><td style="color:#6b7d71">Zone</td><td>${echapper(e.zone || 'non précisée')}</td></tr>
        <tr><td style="color:#6b7d71">Dahira</td><td>${echapper(e.dahira || 'non précisée')}</td></tr>
        <tr><td style="color:#6b7d71">Montant mensuel déclaré</td><td><strong>${euros(e.montant_mensuel_declare)}</strong> (${echapper(e.forfait)})</td></tr>
        <tr><td style="color:#6b7d71">Durée</td><td>${e.duree_mois} mois</td></tr>
        <tr><td style="color:#6b7d71">Total prévisionnel</td><td>${euros(e.total_previsionnel)}</td></tr>
        <tr><td style="color:#6b7d71">Préférence de règlement</td><td>${echapper(e.preference_reglement || 'non précisée')}</td></tr>
      </table>
      ${e.message ? `<p style="color:#6b7d71">Message : ${echapper(e.message)}</p>` : ''}
      ${tableauBord ? `<p><a href="${tableauBord}" style="color:#1E7A43">Ouvrir le tableau de suivi</a></p>` : ''}`;
    taches.push(['association', destAssoc, journaliser(e, destAssoc, 'engagement_association',
      envoyer({
        destinataire: destAssoc,
        sujet: `Engagement ${e.reference} — ${e.prenom} ${e.nom} — ${euros(e.montant_mensuel_declare)}/mois`,
        texte: `Nouvel engagement enregistré. Aucun paiement effectué.\nRéférence : ${e.reference}\n${e.prenom} ${e.nom}\n${e.email || ''} ${e.telephone || ''}\nMontant mensuel déclaré : ${euros(e.montant_mensuel_declare)}\nDurée : ${e.duree_mois} mois\nTotal prévisionnel : ${euros(e.total_previsionnel)}`,
        html: gabarit('Nouvel engagement enregistré', corps),
      }))]);
  }

  if (e.email) {
    const lienSuspendre = base
      ? `${base}/api/participant?r=${encodeURIComponent(e.reference)}&t=${signer(e.jeton_prive)}&a=suspendre-rappels`
      : null;
    const corps = `
      <p>Bonjour ${echapper(e.prenom)},</p>
      <p>Nous avons bien enregistré votre engagement de contribution au projet de Zawiya Cheikh Ibrahim Niasse. Merci.</p>
      <table cellpadding="4" style="font-size:14px">
        <tr><td style="color:#6b7d71">Votre référence</td><td><strong>${echapper(e.reference)}</strong></td></tr>
        <tr><td style="color:#6b7d71">Montant mensuel déclaré</td><td>${euros(e.montant_mensuel_declare)}</td></tr>
        <tr><td style="color:#6b7d71">Durée choisie</td><td>${e.duree_mois} mois</td></tr>
        <tr><td style="color:#6b7d71">Total prévisionnel</td><td>${euros(e.total_previsionnel)}</td></tr>
      </table>
      <p style="background:#EFE8DC;border-left:3px solid #1E7A43;padding:10px 14px"><strong>${MENTION_SANS_PAIEMENT}</strong></p>
      <p>Un membre du bureau vous recontactera pour la mise en place du versement. Indiquez votre référence sur chacun de vos virements.</p>
      ${e.rappels_actifs && lienSuspendre ? `<p style="font-size:13px;color:#6b7d71">Vous recevrez un rappel courtois chaque fin de mois${e.rappel_whatsapp && !e.rappel_email ? ' sur WhatsApp' : e.rappel_whatsapp ? ' par e-mail et sur WhatsApp' : ''}. <a href="${lienSuspendre}" style="color:#1E7A43">Suspendre ces rappels</a> — cela n'annule pas votre engagement.</p>` : ''}`;
    taches.push(['participant', e.email, journaliser(e, e.email, 'engagement_participant',
      envoyer({
        destinataire: e.email,
        sujet: `Votre engagement est enregistré — ${e.reference}`,
        texte: `Bonjour ${e.prenom},\n\nVotre engagement de contribution est enregistré.\nRéférence : ${e.reference}\nMontant mensuel déclaré : ${euros(e.montant_mensuel_declare)}\nDurée : ${e.duree_mois} mois\nTotal prévisionnel : ${euros(e.total_previsionnel)}\n\n${MENTION_SANS_PAIEMENT}\n\nL'association vous recontactera.`,
        html: gabarit('Votre engagement est enregistré', corps),
      }))]);
  }

  await Promise.allSettled(taches.map(([, , p]) => p));
}

/** Trace chaque notification pour pouvoir la rejouer. */
async function journaliser(objet, destinataire, modele, promesse) {
  const resultat = await promesse;
  try {
    await inserer('journal_notifications', {
      type_objet: 'engagement',
      objet_id: objet.id,
      destinataire,
      modele,
      statut: resultat.envoye ? 'envoye' : 'echec',
      tentatives: 1,
      derniere_erreur: resultat.envoye ? null : String(resultat.motif).slice(0, 300),
      envoye_le: resultat.envoye ? new Date().toISOString() : null,
    });
  } catch (e) {
    console.error('journal_notifications', e.message);
  }
  return resultat;
}
