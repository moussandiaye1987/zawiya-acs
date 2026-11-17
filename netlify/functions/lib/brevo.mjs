/**
 * Interrogation de Brevo sur le sort des messages envoyés.
 *
 * Un message accepté par Brevo n'est pas un message reçu : l'API répond
 * « 201 » avec un identifiant dès qu'elle prend la demande en charge,
 * puis la remise peut échouer en silence — adresse rejetée, boîte
 * pleine, message classé en indésirable, ou destinataire inscrit sur la
 * liste de blocage du compte. Le journal du site ne connaît que
 * l'acceptation ; seul Brevo connaît la suite.
 *
 * Tout se passe côté serveur : la clé ne quitte jamais les variables
 * d'environnement, et aucune réponse n'est renvoyée au navigateur sans
 * être réduite à des états et des dates.
 *
 * Documentation : https://developers.brevo.com/reference
 */

const RACINE = 'https://api.brevo.com/v3';

export function brevoConfigure() {
  return Boolean(process.env.BREVO_API_KEY);
}

async function demander(chemin) {
  const r = await fetch(`${RACINE}${chemin}`, {
    headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY },
  });
  // 404 est une réponse utile ici : « cette adresse n'est pas bloquée ».
  if (r.status === 404) return { absent: true };
  if (!r.ok) {
    // Le corps peut contenir la clé en écho : on n'en garde que le code.
    throw new Error(`Brevo a refusé la demande (${r.status})`);
  }
  return r.json();
}

/**
 * Cette adresse est-elle sur la liste de blocage du compte ?
 *
 * Une adresse y entre après un rejet définitif, une plainte pour
 * courrier indésirable ou une désinscription. Tant qu'elle y figure,
 * Brevo accepte les demandes d'envoi et ne livre rien : c'est la cause
 * la plus fréquente d'un destinataire qui ne reçoit jamais rien alors
 * que le journal est au vert.
 */
export async function adresseBloquee(adresse) {
  const d = await demander(`/smtp/blockedContacts/${encodeURIComponent(adresse)}`);
  if (d.absent) return { bloquee: false };
  return {
    bloquee: true,
    motif: d.reason?.message || d.reason?.code || 'motif non précisé',
    depuis: d.blockedAt || null,
  };
}

/**
 * Les derniers événements connus pour une adresse.
 *
 * Les états parlants : « delivered » (remis au serveur du
 * destinataire), « hardBounces » (adresse refusée), « softBounces »
 * (échec passager), « blocked » (liste de blocage), « spam » (classé
 * indésirable par le destinataire), « deferred » (remise différée).
 */
export async function evenements(adresse, limite = 25) {
  const p = new URLSearchParams({
    email: adresse, limit: String(limite), sort: 'desc', days: '90',
  });
  const d = await demander(`/smtp/statistics/events?${p}`);
  if (d.absent || !Array.isArray(d.events)) return [];
  return d.events.map((e) => ({
    date: e.date || null,
    evenement: e.event || 'inconnu',
    sujet: (e.subject || '').slice(0, 120),
    reference: (e.messageId || '').slice(0, 200),
    motif: (e.reason || '').slice(0, 200),
  }));
}

/** Lecture d'ensemble pour une adresse : blocage et derniers événements. */
export async function sortDesMessages(adresse) {
  const resultat = { adresse, blocage: null, evenements: [], erreur: null };
  try {
    resultat.blocage = await adresseBloquee(adresse);
    resultat.evenements = await evenements(adresse);
  } catch (e) {
    resultat.erreur = String(e.message).slice(0, 200);
  }
  return resultat;
}

/**
 * Résumé lisible : ce qui compte est de savoir si quelque chose a été
 * remis, et sinon pourquoi.
 */
export function resumer(lecture) {
  if (lecture.erreur) return { verdict: 'indéterminé', detail: lecture.erreur };
  if (lecture.blocage?.bloquee) {
    return {
      verdict: 'bloquée',
      detail: `Brevo ne livre plus rien à cette adresse — ${lecture.blocage.motif}.`,
    };
  }
  const compte = {};
  for (const e of lecture.evenements) compte[e.evenement] = (compte[e.evenement] || 0) + 1;
  if (!lecture.evenements.length) {
    return { verdict: 'aucune trace', detail: 'Brevo ne connaît aucun événement sur 90 jours.' };
  }
  if (compte.delivered) {
    return { verdict: 'remise confirmée',
      detail: `${compte.delivered} message(s) remis au serveur du destinataire.` };
  }
  const ennuis = ['hardBounces', 'softBounces', 'blocked', 'spam', 'invalid', 'deferred']
    .filter((k) => compte[k]).map((k) => `${k} : ${compte[k]}`);
  return { verdict: 'non remise', detail: ennuis.join(', ') || 'aucune remise enregistrée.' };
}
