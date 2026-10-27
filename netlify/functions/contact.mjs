import { insererIdempotent, rpc, baseConfiguree } from './lib/db.mjs';
import { envoyer, gabarit, echapper } from './lib/mail.mjs';
import {
  json, erreur, corpsJSON, nettoyer, estEmail, empreinteIP, suspectRobot,
  fabriquerReference, destinatairesAssociation,
} from './lib/commun.mjs';

/**
 * Rubrique « Nous contacter ».
 *
 * Le message part vers chaque adresse interne séparément, comme les
 * notifications d'engagement : chacune réussit ou échoue pour son propre
 * compte. L'expéditeur reste l'adresse autorisée chez le fournisseur —
 * écrire au nom du visiteur ferait échouer l'authentification du domaine
 * et enverrait le message aux indésirables. C'est « Répondre à » qui
 * porte son adresse, de sorte qu'un clic sur « Répondre » lui écrive.
 *
 * Le message est d'abord enregistré, puis envoyé : si l'e-mail échoue,
 * il n'est pas perdu pour autant.
 */
export const config = { path: '/api/contact' };

const MAX_PAR_HEURE = 5;

const LONGUEURS = {
  nom: 120,
  email: 160,
  objet: 160,
  message: 5000,
};

export default async (req) => {
  if (req.method !== 'POST') return erreur('Méthode non autorisée.', 405);
  if (!baseConfiguree()) {
    return erreur("Le formulaire est momentanément indisponible. Réessayez plus tard.", 503);
  }

  const d = await corpsJSON(req);
  if (!d) return erreur('Requête illisible.', 400);

  // Piège à robots : la réponse imite un succès, pour ne rien apprendre
  // à qui sonde le formulaire. Rien n'est enregistré ni envoyé.
  if (suspectRobot(d)) {
    return json({ ok: true, reference: 'CONTACT-0000-XXXXXX', ignore: true });
  }

  const champs = {
    nom: nettoyer(d.nom, LONGUEURS.nom),
    email: nettoyer(d.email, LONGUEURS.email),
    objet: nettoyer(d.objet, LONGUEURS.objet),
    message: nettoyer(d.message, LONGUEURS.message),
  };

  const fautes = {};
  if (!champs.nom || champs.nom.length < 2) {
    fautes.nom = 'Indiquez votre nom.';
  }
  if (!estEmail(champs.email)) {
    fautes.email = 'Indiquez un e-mail valide, pour que nous puissions vous répondre.';
  }
  if (!champs.objet || champs.objet.length < 3) {
    fautes.objet = "Indiquez l'objet de votre message.";
  }
  if (!champs.message || champs.message.length < 10) {
    fautes.message = 'Écrivez votre message (10 caractères au minimum).';
  }
  // nettoyer() tronque déjà : on le signale plutôt que de couper en silence.
  for (const [cle, max] of Object.entries(LONGUEURS)) {
    if (!fautes[cle] && String(d[cle] ?? '').trim().length > max) {
      fautes[cle] = `Ce champ est limité à ${max} caractères.`;
    }
  }

  if (Object.keys(fautes).length) {
    return erreur('Certains champs sont à corriger.', 422, { fautes });
  }

  const ip_hash = empreinteIP(req);
  try {
    const recents = await rpc('compte_soumissions_recentes', { p_ip_hash: ip_hash, p_minutes: 60 });
    if (Number(recents) >= MAX_PAR_HEURE) {
      return erreur("Trop d'envois depuis cet appareil. Réessayez dans une heure.", 429);
    }
  } catch { /* ne bloque jamais un envoi légitime */ }

  const ligne = {
    reference: fabriquerReference('CONTACT'),
    ...champs,
    est_test: d.est_test === true,
    ip_hash,
  };

  // L'enregistrement d'abord : un message gardé en base n'est jamais
  // perdu, même si l'envoi échoue derrière.
  let enregistrement, deja;
  try {
    ({ enregistrement, deja } = await insererIdempotent(
      'messages_contact', ligne, nettoyer(d.cle_idempotence, 64)
    ));
  } catch (e) {
    console.error('contact:insertion', e.message);
    return erreur("L'envoi a échoué. Réessayez dans un instant.", 502);
  }

  // Même clé renvoyée : un double clic ne produit pas un second message.
  if (deja) {
    return json({ ok: true, deja: true, reference: enregistrement.reference });
  }

  const resultats = await notifier(enregistrement);

  // Aucune confirmation si rien n'est parti : le visiteur doit pouvoir
  // réessayer plutôt que de croire son message arrivé.
  if (!resultats.some((r) => r.envoye)) {
    return erreur(
      "Votre message n'a pas pu être transmis. Réessayez dans un instant, "
      + "ou écrivez-nous directement à l'adresse indiquée plus bas.",
      502,
      { reference: enregistrement.reference }
    );
  }

  return json({ ok: true, reference: enregistrement.reference });
};

/* ---------------------------------------------------------------------
   ENVOI AUX ADRESSES INTERNES
   Un envoi par adresse, pour que l'échec de l'une n'empêche pas l'autre
   de recevoir. Le message est bâti une seule fois.
   --------------------------------------------------------------------- */
async function notifier(m) {
  const destinataires = destinatairesAssociation();
  if (!destinataires.length) {
    console.error('contact:aucun destinataire configuré');
    return [];
  }

  const message = composer(m);
  const envois = await Promise.allSettled(
    destinataires.map((adresse) => envoyer({ ...message, destinataire: adresse }))
  );

  return envois.map((e, i) => {
    const r = e.status === 'fulfilled' ? e.value : { envoye: false, motif: String(e.reason) };
    if (!r.envoye) {
      // Le motif, jamais la clé d'envoi ni le contenu du message.
      console.error('contact:envoi', destinataires[i], String(r.motif).slice(0, 200));
    }
    return r;
  });
}

function composer(m) {
  const horodatage = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(m.recu_le || Date.now()));

  const corps = `
    <p><strong>Message reçu depuis la rubrique « Nous contacter ».</strong></p>
    <table cellpadding="4" style="font-size:14px;border-collapse:collapse">
      <tr><td style="color:#6b7d71">Référence</td><td><strong>${echapper(m.reference)}</strong></td></tr>
      <tr><td style="color:#6b7d71">Nom</td><td>${echapper(m.nom)}</td></tr>
      <tr><td style="color:#6b7d71">E-mail</td><td><a href="mailto:${echapper(m.email)}">${echapper(m.email)}</a></td></tr>
      <tr><td style="color:#6b7d71">Objet</td><td>${echapper(m.objet)}</td></tr>
      <tr><td style="color:#6b7d71">Reçu le</td><td>${echapper(horodatage)}</td></tr>
    </table>
    <p style="margin-top:18px;color:#6b7d71;font-size:13px">Message :</p>
    <div style="white-space:pre-wrap;border-left:3px solid #1E7A43;padding:10px 14px;background:#fff;font-size:15px">${echapper(m.message)}</div>
    <p style="margin-top:18px;color:#6b7d71;font-size:13px">
      Répondre à ce message écrit directement à ${echapper(m.email)}.
    </p>`;

  const texte = [
    'Message reçu depuis la rubrique « Nous contacter ».',
    '',
    `Référence : ${m.reference}`,
    `Nom : ${m.nom}`,
    `E-mail : ${m.email}`,
    `Objet : ${m.objet}`,
    `Reçu le : ${horodatage}`,
    '',
    'Message :',
    m.message,
    '',
    `Répondre à ce message écrit directement à ${m.email}.`,
  ].join('\n');

  return {
    sujet: `Contact — ${m.objet} — ${m.nom}`,
    texte,
    html: gabarit('Nouveau message', corps),
    // L'expéditeur reste l'adresse autorisée ; seule la réponse va au visiteur.
    repondreA: { email: m.email, nom: m.nom },
  };
}
