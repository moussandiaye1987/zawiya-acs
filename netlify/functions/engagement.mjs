import { inserer, insererIdempotent, lire, rpc, baseConfiguree, ErreurBase } from './lib/db.mjs';
import { envoyer, gabarit, echapper } from './lib/mail.mjs';
import { fabriquerCSV, nomFichierCSV, totauxParDevise, montant } from './lib/csv.mjs';
import {
  json, erreur, corpsJSON, nettoyer, estEmail, empreinteIP, suspectRobot,
  departementDepuisCP, fabriquerReference, signer,
  VERSION_CONSENTEMENT, MENTION_SANS_PAIEMENT, MENTION_VIREMENT_PERMANENT,
  FORFAITS, ZONES, DUREES, DEVISES,
  destinatairesAssociation,
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

  let montantMensuel = FORFAITS[forfait]?.montant;
  if (forfait === 'libre') {
    montantMensuel = Number(String(d.montant_mensuel_declare).replace(',', '.'));
    const plancher = d.devise === 'XOF' ? 1000 : 5;
    const plafond = d.devise === 'XOF' ? 50000000 : 100000;
    if (!Number.isFinite(montantMensuel) || montantMensuel < plancher || montantMensuel > plafond) {
      fautes.montant_mensuel_declare = `Indiquez un montant mensuel entre ${plancher.toLocaleString('fr-FR')} et ${plafond.toLocaleString('fr-FR')}.`;
    }
  }

  // La devise ne s'applique qu'au montant libre : les forfaits sont en euros.
  let devise = 'EUR';
  if (forfait === 'libre') {
    devise = nettoyer(d.devise, 8) || 'EUR';
    if (!DEVISES[devise]) fautes.devise = 'Choisissez une devise.';
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
    montant_mensuel_declare: montantMensuel,
    devise,
    periodicite: 'mensuelle',
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
    devise: enregistrement.devise,
    mention: MENTION_SANS_PAIEMENT,
  });
};

async function notifier(e, context) {
  const base = process.env.URL || context?.site?.url || '';
  const destAssoc = destinatairesAssociation();
  const taches = [];

  // Un seul message pour tout le bureau : la notification, le
  // récapitulatif et le CSV partent en un envoi, jamais en double.
  if (destAssoc.length) {
    taches.push(journaliser(e, destAssoc.join(', '), 'engagement_association',
      mailAssociation(e, destAssoc)));
  }
  if (e.email) {
    taches.push(journaliser(e, e.email, 'engagement_participant', mailParticipant(e, base)));
  }
  await Promise.allSettled(taches);
}

/* ---------------------------------------------------------------------
   E-MAIL À L'ASSOCIATION
   Le nouvel engagement, le récapitulatif de tous les engagements à
   l'instant de l'envoi, et le fichier CSV en pièce jointe. Les montants
   sont présentés devise par devise, jamais additionnés entre elles.
   --------------------------------------------------------------------- */
async function mailAssociation(e, destinataire) {
  const dev = e.devise || 'EUR';

  // Récapitulatif et export : tous les engagements retenus, tests exclus.
  let lignes = [];
  let lectureEnEchec = false;
  try {
    lignes = await lire('v_export_suivi', 'select=*');
  } catch (err) {
    console.error('mailAssociation:lecture', err.message);
    lectureEnEchec = true;
  }

  const totaux = totauxParDevise(lignes);
  const maintenant = new Date();
  const horodatage = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short',
  }).format(maintenant);

  const nouvelEngagement = `
    <h2 style="font-family:Georgia,serif;font-weight:400;font-size:17px;margin:0 0 10px">Le nouvel engagement</h2>
    <table cellpadding="4" style="font-size:14px;border-collapse:collapse">
      <tr><td style="color:#6b7d71">Référence</td><td><strong>${echapper(e.reference)}</strong></td></tr>
      <tr><td style="color:#6b7d71">Nom</td><td>${echapper(e.prenom)} ${echapper(e.nom)}</td></tr>
      <tr><td style="color:#6b7d71">Contact</td><td>${echapper(e.email || '—')} · ${echapper(e.telephone || '—')}</td></tr>
      <tr><td style="color:#6b7d71">Zone</td><td>${echapper(e.zone || 'non précisée')}${e.departement ? ` (${echapper(e.departement)})` : ''}</td></tr>
      <tr><td style="color:#6b7d71">Dahira</td><td>${echapper(e.dahira || 'non précisée')}</td></tr>
      <tr><td style="color:#6b7d71">Montant déclaré</td><td><strong>${montant(e.montant_mensuel_declare, dev)}</strong> par mois (forfait ${echapper(e.forfait)})</td></tr>
      <tr><td style="color:#6b7d71">Durée</td><td>${e.duree_mois} mois</td></tr>
      <tr><td style="color:#6b7d71">Total prévisionnel</td><td>${montant(e.total_previsionnel, dev)}</td></tr>
      <tr><td style="color:#6b7d71">Préférence de règlement</td><td>${echapper(e.preference_reglement || 'non précisée')}</td></tr>
      <tr><td style="color:#6b7d71">Rappels</td><td>${e.rappel_email ? 'e-mail' : ''}${e.rappel_email && e.rappel_whatsapp ? ' et ' : ''}${e.rappel_whatsapp ? 'WhatsApp' : ''}${!e.rappel_email && !e.rappel_whatsapp ? 'aucun' : ''}</td></tr>
    </table>
    ${e.message ? `<p style="color:#6b7d71;font-size:14px">Message : ${echapper(e.message)}</p>` : ''}`;

  const recapitulatif = lectureEnEchec
    ? `<p style="color:#B4342A">Le récapitulatif n'a pas pu être calculé : la base n'a pas répondu. Le nouvel engagement ci-dessus est bien enregistré.</p>`
    : `
    <h2 style="font-family:Georgia,serif;font-weight:400;font-size:17px;margin:22px 0 4px">Tous les engagements enregistrés</h2>
    <p style="font-size:13px;color:#6b7d71;margin:0 0 10px">Arrêté au ${horodatage}. Les engagements de test, annulés et en doublon sont exclus.</p>
    ${totaux.length === 0 ? '<p style="font-size:14px">Aucun engagement enregistré à ce jour.</p>' : totaux.map((t) => `
      <table cellpadding="5" style="font-size:14px;border-collapse:collapse;border:1px solid #d9d2c4;margin-bottom:10px">
        <tr style="background:#EFE8DC">
          <td colspan="2"><strong>${t.nombre} engagement${t.nombre > 1 ? 's' : ''} en ${echapper(t.libelle)}</strong>
          <span style="color:#6b7d71">· périodicité ${t.periodicites.join(', ')}</span></td>
        </tr>
        <tr><td style="color:#6b7d71">Montant mensuel déclaré, au total</td><td><strong>${montant(t.mensuel, t.devise)}</strong> par mois</td></tr>
        <tr><td style="color:#6b7d71">Prévisionnel sur l'horizon de 24 mois</td><td>${montant(t.horizon24, t.devise)}</td></tr>
        <tr><td style="color:#6b7d71">Prévisionnel, toutes durées confondues</td><td>${montant(t.toutesDurees, t.devise)}</td></tr>
      </table>`).join('')}
    ${totaux.length > 1 ? '<p style="font-size:13px;color:#6b7d71">Les devises sont présentées séparément et ne sont jamais additionnées.</p>' : ''}`;

  const pieceJointe = lectureEnEchec ? [] : [{
    nom: nomFichierCSV(maintenant),
    base64: Buffer.from(fabriquerCSV(lignes), 'utf8').toString('base64'),
  }];

  const corps = `
    <p><strong>Nouvel engagement enregistré.</strong> Aucun paiement n'a été effectué.</p>
    ${nouvelEngagement}
    ${recapitulatif}
    ${pieceJointe.length
      ? `<p style="font-size:13px;color:#6b7d71">Le fichier <strong>${echapper(pieceJointe[0].nom)}</strong> joint à ce message contient le détail des ${lignes.length} engagement${lignes.length > 1 ? 's' : ''}. Il s'ouvre directement dans Excel. Il est réservé au bureau : ne le transférez pas.</p>`
      : ''}`;

  const texte = [
    "Nouvel engagement enregistré. Aucun paiement effectué.",
    '',
    `Référence : ${e.reference}`,
    `${e.prenom} ${e.nom}`,
    `${e.email || ''} ${e.telephone || ''}`.trim(),
    `Zone : ${e.zone || 'non précisée'}`,
    `Montant déclaré : ${montant(e.montant_mensuel_declare, dev)} par mois`,
    `Durée : ${e.duree_mois} mois`,
    `Total prévisionnel : ${montant(e.total_previsionnel, dev)}`,
    '',
    `Tous les engagements enregistrés, arrêté au ${horodatage} :`,
    ...(lectureEnEchec
      ? ['Récapitulatif indisponible : la base n\'a pas répondu.']
      : totaux.length
        ? totaux.map((t) =>
            `- ${t.nombre} en ${t.libelle} (périodicité ${t.periodicites.join(', ')}) : ` +
            `${montant(t.mensuel, t.devise)} par mois, ` +
            `${montant(t.horizon24, t.devise)} sur 24 mois`)
        : ['Aucun engagement enregistré à ce jour.']),
    '',
    ...(pieceJointe.length ? [`Fichier joint : ${pieceJointe[0].nom}`] : []),
  ].join('\n');

  return envoyer({
    destinataire,
    sujet: `Engagement ${e.reference} — ${e.prenom} ${e.nom} — ${montant(e.montant_mensuel_declare, dev)}/mois`,
    texte,
    html: gabarit('Nouvel engagement enregistré', corps),
    pieces: pieceJointe,
  });
}

/* ---------------------------------------------------------------------
   ACCUSÉ AU PARTICIPANT
   Ses informations, et rien d'autre : ni récapitulatif collectif, ni
   pièce jointe, ni lien vers quoi que ce soit d'interne.
   --------------------------------------------------------------------- */
function mailParticipant(e, base) {
  const dev = e.devise || 'EUR';
  // La précision ne vaut que pour un règlement par virement : inutile de
  // l'imposer à qui remet son versement à sa Dahira.
  const pref = e.preference_reglement || '';
  const parVirement = !pref || /virement/i.test(pref);
  const lienSuspendre = base
    ? `${base}/api/participant?r=${encodeURIComponent(e.reference)}&t=${signer(e.jeton_prive)}&a=suspendre-rappels`
    : null;

  const corps = `
    <p>Bonjour ${echapper(e.prenom)},</p>
    <p>Nous avons bien enregistré votre engagement de contribution au projet de Zawiya Cheikh Ibrahim Niasse. Merci.</p>
    <table cellpadding="4" style="font-size:14px">
      <tr><td style="color:#6b7d71">Votre référence</td><td><strong>${echapper(e.reference)}</strong></td></tr>
      <tr><td style="color:#6b7d71">Montant déclaré</td><td>${montant(e.montant_mensuel_declare, dev)} par mois</td></tr>
      <tr><td style="color:#6b7d71">Durée choisie</td><td>${e.duree_mois} mois</td></tr>
      <tr><td style="color:#6b7d71">Total prévisionnel</td><td>${montant(e.total_previsionnel, dev)}</td></tr>
    </table>
    <p style="background:#EFE8DC;border-left:3px solid #1E7A43;padding:10px 14px"><strong>${MENTION_SANS_PAIEMENT}</strong></p>
    ${parVirement
      ? `<p style="background:#EFE8DC;border-left:3px solid #1E7A43;padding:10px 14px">${MENTION_VIREMENT_PERMANENT}</p>`
      : ''}
    <p>Un membre du bureau vous recontactera pour la mise en place du versement. Indiquez votre référence sur chacun de vos virements.</p>
    ${e.rappels_actifs && lienSuspendre
      ? `<p style="font-size:13px;color:#6b7d71">Vous recevrez un rappel courtois chaque fin de mois${e.rappel_whatsapp && !e.rappel_email ? ' sur WhatsApp' : e.rappel_whatsapp ? ' par e-mail et sur WhatsApp' : ''}. <a href="${lienSuspendre}" style="color:#1E7A43">Suspendre ces rappels</a> — cela n'annule pas votre engagement.</p>`
      : ''}`;

  return envoyer({
    destinataire: e.email,
    sujet: `Votre engagement est enregistré — ${e.reference}`,
    texte: `Bonjour ${e.prenom},\n\nVotre engagement de contribution est enregistré.\n` +
      `Référence : ${e.reference}\n` +
      `Montant déclaré : ${montant(e.montant_mensuel_declare, dev)} par mois\n` +
      `Durée : ${e.duree_mois} mois\n` +
      `Total prévisionnel : ${montant(e.total_previsionnel, dev)}\n\n` +
      `${MENTION_SANS_PAIEMENT}\n\n` +
      (parVirement ? `${MENTION_VIREMENT_PERMANENT}\n\n` : '') +
      `L'association vous recontactera.`,
    html: gabarit('Votre engagement est enregistré', corps),
  });
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
