import { createHash, randomUUID } from 'node:crypto';

/** Version du texte de consentement. À incrémenter si le texte change. */
export const VERSION_CONSENTEMENT = '2026-10-25';

/**
 * Mention affichée partout où un engagement est pris ou confirmé.
 * Source unique : la page, les e-mails et les réponses de l'API citent
 * cette même phrase, pour qu'aucune formulation ne laisse croire à un paiement.
 */
export const MENTION_SANS_PAIEMENT =
  "Ce formulaire enregistre votre engagement de contribution. Aucun paiement ni prélèvement n'est effectué sur ce site. L'association vous communiquera les modalités de règlement.";

/**
 * Rappel destiné aux contributions par virement. Même phrase sur la page
 * et dans l'e-mail, pour que personne ne croie qu'un prélèvement a été
 * mis en place.
 */
export const MENTION_VIREMENT_PERMANENT =
  "Pour une contribution régulière par virement, vous devez mettre en place vous-même un virement permanent depuis votre compte bancaire. Votre adhésion sur ce site ne déclenche aucun prélèvement ni virement automatique.";

export const FORFAITS = {
  bronze: { nom: 'Bronze', montant: 25 },
  argent: { nom: 'Argent', montant: 50 },
  gold: { nom: 'Gold', montant: 100 },
  libre: { nom: 'Libre', montant: null },
};

export const ZONES = [
  'Île-de-France', 'Nord', 'Grand-Est', 'Loire',
  'Auvergne-Rhône-Alpes', 'Sud', 'Hors de France',
];

export const DUREES = [12, 24, 36];

/** Devises acceptées. Les totaux ne les additionnent jamais entre elles. */
export const DEVISES = {
  EUR: { nom: 'Euro', symbole: '€', plancher: 5, plafond: 100000 },
  XOF: { nom: 'Franc CFA', symbole: 'FCFA', plancher: 1000, plafond: 50000000 },
};

export function json(donnees, statut = 200, entetes = {}) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...entetes,
    },
  });
}

export function erreur(message, statut = 400, extra = {}) {
  return json({ ok: false, message, ...extra }, statut);
}

/** Empreinte de l'adresse IP : jamais stockée en clair. */
export function empreinteIP(req) {
  const brut =
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'inconnue';
  const sel = process.env.SEL_EMPREINTE || 'sel-par-defaut-a-remplacer';
  return createHash('sha256').update(`${sel}:${brut}`).digest('hex').slice(0, 32);
}

/** Jeton signé pour les liens personnels envoyés par e-mail. */
export function signer(valeur) {
  const secret = process.env.SECRET_LIENS || 'secret-par-defaut-a-remplacer';
  return createHash('sha256').update(`${secret}:${valeur}`).digest('hex').slice(0, 24);
}

export function nettoyer(v, max = 300) {
  if (v === undefined || v === null) return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

export function estEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

export function departementDepuisCP(cp) {
  const chiffres = String(cp || '').replace(/\D/g, '');
  if (chiffres.length < 2) return null;
  return chiffres.startsWith('97') || chiffres.startsWith('98')
    ? chiffres.slice(0, 3)
    : chiffres.slice(0, 2);
}

export function euros(n) {
  return `${Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} €`;
}

/** Référence lisible et unique : ZAWIYA-2026-A7K3Q2 */
export function fabriquerReference(prefixe = 'ZAWIYA') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
  const brut = randomUUID().replace(/-/g, '');
  let suffixe = '';
  for (let i = 0; i < 6; i++) {
    suffixe += alphabet[parseInt(brut.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  }
  return `${prefixe}-${new Date().getFullYear()}-${suffixe}`;
}

/** Lit le corps JSON en tolérant un corps absent ou mal formé. */
export async function corpsJSON(req) {
  try {
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

/**
 * Pièges anti-robot : un champ caché qui doit rester vide, et un délai
 * minimal entre l'affichage du formulaire et son envoi.
 */
export function suspectRobot(donnees) {
  if (nettoyer(donnees.site_web)) return 'piège rempli';
  const delai = Number(donnees.duree_saisie_ms);
  if (Number.isFinite(delai) && delai > 0 && delai < 2500) return 'envoi trop rapide';
  return null;
}
