import { inserer, insererIdempotent, rpc, baseConfiguree, ErreurBase } from './lib/db.mjs';
import { envoyer, gabarit, echapper } from './lib/mail.mjs';
import { geocoder } from './lib/geocodage.mjs';
import {
  json, erreur, corpsJSON, nettoyer, estEmail, empreinteIP, suspectRobot,
  departementDepuisCP, fabriquerReference, VERSION_CONSENTEMENT, ZONES,
} from './lib/commun.mjs';

export const config = { path: '/api/dahira' };

const MAX_PAR_HEURE = 5;

export default async (req) => {
  if (req.method !== 'POST') return erreur('Méthode non autorisée.', 405);
  if (!baseConfiguree()) {
    return erreur("Le référencement est momentanément indisponible. Réessayez plus tard.", 503);
  }

  const d = await corpsJSON(req);
  if (!d) return erreur('Requête illisible.', 400);
  if (suspectRobot(d)) return json({ ok: true, reference: 'DAHIRA-0000-XXXXXX', ignore: true });

  const champs = {
    nom: nettoyer(d.nom, 120),
    guide: nettoyer(d.guide, 120),
    zone: nettoyer(d.zone, 60),
    ville: nettoyer(d.ville, 120),
    code_postal: nettoyer(d.code_postal, 10),
    lieu_activites: nettoyer(d.lieu_activites, 300),
    responsable_nom: nettoyer(d.responsable_nom, 120),
    responsable_email: nettoyer(d.responsable_email, 160),
    responsable_telephone: nettoyer(d.responsable_telephone, 40),
    contact_public_telephone: nettoyer(d.contact_public_telephone, 40),
    khadara_horaire: nettoyer(d.khadara_horaire, 160),
    wazifa_horaire: nettoyer(d.wazifa_horaire, 160),
  };
  const fautes = {};

  if (!champs.nom) fautes.nom = 'Indiquez le nom de la Dahira.';
  if (!champs.ville) fautes.ville = 'Indiquez la ville.';
  if (!champs.code_postal || !/^\d{5}$/.test(champs.code_postal)) {
    fautes.code_postal = 'Indiquez un code postal à 5 chiffres.';
  }
  if (!champs.responsable_nom) fautes.responsable_nom = 'Indiquez la personne responsable.';
  if (!estEmail(champs.responsable_email)) {
    fautes.responsable_email = 'Indiquez un e-mail valide pour le responsable.';
  }
  if (champs.zone && !ZONES.includes(champs.zone)) fautes.zone = 'Zone inconnue.';
  if (d.consentement_publication !== true) {
    fautes.consentement_publication =
      "Cochez la case : sans votre accord, la fiche ne peut pas être publiée.";
  }

  let effectif = null;
  if (d.effectif !== undefined && d.effectif !== null && d.effectif !== '') {
    effectif = Number(d.effectif);
    if (!Number.isInteger(effectif) || effectif < 0 || effectif > 100000) {
      fautes.effectif = 'Indiquez un nombre de disciples valide.';
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

  // Position sur la carte, calculée à l'enregistrement. Un échec n'est
  // pas bloquant : la fiche entre dans l'annuaire, simplement sans point.
  const point = await geocoder({
    adresse: champs.lieu_activites,
    code_postal: champs.code_postal,
    ville: champs.ville,
  });

  const ligne = {
    reference: fabriquerReference('DAHIRA'),
    ...champs,
    latitude: point ? point.latitude : null,
    longitude: point ? point.longitude : null,
    departement: departementDepuisCP(champs.code_postal),
    contact_public_autorise: d.contact_public_autorise === true,
    khadara_vendredi: d.khadara_vendredi === true,
    wazifa_quotidienne: d.wazifa_quotidienne === true,
    effectif,
    consentement_publication: true,
    consentement_version: VERSION_CONSENTEMENT,
    statut: 'En attente',            // jamais publiée automatiquement
    est_test: d.est_test === true,
    ip_hash,
  };

  let enregistrement, deja;
  try {
    ({ enregistrement, deja } = await insererIdempotent(
      'dahiras', ligne, nettoyer(d.cle_idempotence, 64)
    ));
  } catch (e) {
    if (e instanceof ErreurBase && e.code === '23505') {
      return erreur(
        'Une Dahira portant ce nom est déjà référencée dans cette ville. Contactez l’association si vous souhaitez la modifier.',
        409
      );
    }
    console.error('dahira:insertion', e.message);
    return erreur("L'envoi a échoué. Réessayez dans un instant.", 502);
  }

  if (deja) {
    return json({ ok: true, deja: true, reference: enregistrement.reference });
  }

  await notifier(enregistrement);

  return json({
    ok: true,
    reference: enregistrement.reference,
    statut: 'En attente',
    message: "Votre fiche est enregistrée. Elle sera publiée dans l'annuaire après vérification par l'association.",
  });
};

async function notifier(f) {
  const destAssoc = process.env.EMAIL_ASSOCIATION;
  const taches = [];

  if (destAssoc) {
    const corps = `
      <p><strong>Nouvelle demande de référencement.</strong> La fiche est en attente et n'apparaît pas encore sur le site.</p>
      <table cellpadding="4" style="font-size:14px">
        <tr><td style="color:#6b7d71">Référence</td><td><strong>${echapper(f.reference)}</strong></td></tr>
        <tr><td style="color:#6b7d71">Dahira</td><td>${echapper(f.nom)}</td></tr>
        <tr><td style="color:#6b7d71">Guide</td><td>${echapper(f.guide || '—')}</td></tr>
        <tr><td style="color:#6b7d71">Lieu</td><td>${echapper(f.ville)} (${echapper(f.code_postal)}) · ${echapper(f.zone || 'zone non précisée')}</td></tr>
        <tr><td style="color:#6b7d71">Responsable</td><td>${echapper(f.responsable_nom)} — ${echapper(f.responsable_email)} ${echapper(f.responsable_telephone || '')}</td></tr>
        <tr><td style="color:#6b7d71">Téléphone public</td><td>${f.contact_public_autorise ? echapper(f.contact_public_telephone || '—') : 'non autorisé à l’affichage'}</td></tr>
        <tr><td style="color:#6b7d71">Khadara du vendredi</td><td>${f.khadara_vendredi ? 'oui' : 'non'} ${echapper(f.khadara_horaire || '')}</td></tr>
        <tr><td style="color:#6b7d71">Wazifa quotidienne</td><td>${f.wazifa_quotidienne ? 'oui' : 'non'} ${echapper(f.wazifa_horaire || '')}</td></tr>
        <tr><td style="color:#6b7d71">Disciples affiliés</td><td>${f.effectif ?? '—'}</td></tr>
      </table>
      <p>Pour publier : passer le statut de « En attente » à « Publiée » dans la table <code>dahiras</code>, depuis votre tableau de bord Supabase.</p>`;
    taches.push(journaliser(f, destAssoc, 'dahira_association', envoyer({
      destinataire: destAssoc,
      sujet: `Dahira à valider — ${f.nom} (${f.ville})`,
      texte: `Nouvelle demande de référencement en attente de validation.\nRéférence : ${f.reference}\n${f.nom} — ${f.ville} ${f.code_postal}\nResponsable : ${f.responsable_nom} ${f.responsable_email}`,
      html: gabarit('Dahira à valider', corps),
    })));
  }

  if (f.responsable_email) {
    const corps = `
      <p>Bonjour ${echapper(f.responsable_nom)},</p>
      <p>Nous avons bien reçu la fiche de la Dahira <strong>${echapper(f.nom)}</strong>.</p>
      <p style="background:#EFE8DC;border-left:3px solid #1E7A43;padding:10px 14px">
        <strong>Sa publication dans l'annuaire est soumise à la validation de l'association.</strong>
        Elle n'apparaît pas encore sur le site. Comptez quelques jours.
      </p>
      <p>Référence de votre demande : <strong>${echapper(f.reference)}</strong>.</p>
      <p style="font-size:13px;color:#6b7d71">Aucun paiement n'a été effectué et ce référencement n'engage aucune contribution financière.</p>`;
    taches.push(journaliser(f, f.responsable_email, 'dahira_responsable', envoyer({
      destinataire: f.responsable_email,
      sujet: `Votre demande de référencement est reçue — ${f.reference}`,
      texte: `Bonjour ${f.responsable_nom},\n\nNous avons bien reçu la fiche de la Dahira ${f.nom}.\nSa publication dans l'annuaire est soumise à la validation de l'association : elle n'apparaît pas encore sur le site.\nRéférence : ${f.reference}\n\nAucun paiement n'a été effectué.`,
      html: gabarit('Demande de référencement reçue', corps),
    })));
  }

  await Promise.allSettled(taches);
}

async function journaliser(objet, destinataire, modele, promesse) {
  const resultat = await promesse;
  try {
    await inserer('journal_notifications', {
      type_objet: 'dahira',
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
