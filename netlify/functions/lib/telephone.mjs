/**
 * Mise au format international des numéros, pour les liens WhatsApp.
 *
 * Principe de prudence : en cas de doute, on NE devine PAS. Un numéro mal
 * interprété, c'est un message qui part chez un inconnu. Les numéros
 * ambigus sont renvoyés avec `certain: false` et la page de relance les
 * affiche à part, à vérifier à la main.
 */

/** Indicatifs reconnus, du plus long au plus court pour éviter les collisions. */
const INDICATIFS = [
  '221', // Sénégal
  '223', // Mali
  '224', // Guinée
  '225', // Côte d'Ivoire
  '226', // Burkina Faso
  '227', // Niger
  '229', // Bénin
  '241', // Gabon
  '212', // Maroc
  '213', // Algérie
  '216', // Tunisie
  '234', // Nigéria
  '237', // Cameroun
  '220', // Gambie
  '245', // Guinée-Bissau
  '222', // Mauritanie
  '32',  // Belgique
  '33',  // France
  '34',  // Espagne
  '39',  // Italie
  '41',  // Suisse
  '44',  // Royaume-Uni
  '49',  // Allemagne
  '1',   // Amérique du Nord
];

/**
 * @param {string} brut  le numéro tel que saisi
 * @returns {{e164: string|null, certain: boolean, motif?: string}}
 *          e164 sans le « + », prêt pour wa.me
 */
export function versInternational(brut) {
  const texte = String(brut || '').trim();
  if (!texte) return { e164: null, certain: false, motif: 'numéro absent' };

  const avaitPlus = texte.startsWith('+');
  let chiffres = texte.replace(/\D/g, '');
  if (!chiffres) return { e164: null, certain: false, motif: 'aucun chiffre' };

  // 00 en tête = préfixe international, équivalent à +
  let international = avaitPlus;
  if (chiffres.startsWith('00')) {
    chiffres = chiffres.slice(2);
    international = true;
  }

  if (international) {
    const indicatif = INDICATIFS.find((i) => chiffres.startsWith(i));
    if (!indicatif) {
      return { e164: chiffres, certain: false, motif: 'indicatif pays non reconnu' };
    }
    if (chiffres.length < 8 || chiffres.length > 15) {
      return { e164: chiffres, certain: false, motif: 'longueur inhabituelle' };
    }
    return { e164: chiffres, certain: true };
  }

  // Numéro national français : 10 chiffres commençant par 0
  if (chiffres.length === 10 && chiffres.startsWith('0')) {
    const mobile = /^0[67]/.test(chiffres);
    return {
      e164: '33' + chiffres.slice(1),
      certain: mobile,                       // un fixe n'a pas de WhatsApp
      motif: mobile ? undefined : 'numéro fixe : probablement sans WhatsApp',
    };
  }

  // Numéro national sénégalais : 9 chiffres commençant par 7
  if (chiffres.length === 9 && chiffres.startsWith('7')) {
    return { e164: '221' + chiffres, certain: false, motif: 'Sénégal supposé, à confirmer' };
  }

  return { e164: chiffres, certain: false, motif: 'format non reconnu' };
}

/** Lien WhatsApp avec message pré-rempli. */
export function lienWhatsApp(numero, message) {
  const { e164, certain, motif } = versInternational(numero);
  if (!e164) return { url: null, certain: false, motif };
  return {
    url: `https://wa.me/${e164}?text=${encodeURIComponent(message)}`,
    e164,
    certain,
    motif,
  };
}
