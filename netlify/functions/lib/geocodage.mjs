/**
 * Géocodage d'une adresse, pour placer une Dahira sur la carte.
 *
 * Service : l'API Adresse de data.gouv.fr. Gratuite, sans clé, sans
 * compte, hébergée en France. Elle ne couvre que la France ; une adresse
 * à l'étranger ne renvoie rien, ce qui est le comportement attendu — la
 * fiche reste dans l'annuaire, simplement sans point sur la carte.
 *
 * L'échec n'est jamais bloquant : une fiche sans coordonnées vaut mieux
 * qu'une fiche refusée.
 */

const DELAI_MS = 4000;

/**
 * @returns {Promise<{latitude: number, longitude: number}|null>}
 */
export async function geocoder({ adresse, code_postal, ville }) {
  const requete = [adresse, ville].filter(Boolean).join(' ').trim();
  if (!requete && !code_postal) return null;

  const url = new URL('https://api-adresse.data.gouv.fr/search/');
  url.searchParams.set('q', requete || String(code_postal));
  if (code_postal) url.searchParams.set('postcode', String(code_postal));
  url.searchParams.set('limit', '1');

  try {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);
    const reponse = await fetch(url, { signal: controleur.signal });
    clearTimeout(minuteur);
    if (!reponse.ok) return null;

    const donnees = await reponse.json();
    const trouve = donnees && donnees.features && donnees.features[0];
    if (!trouve || !trouve.geometry || !Array.isArray(trouve.geometry.coordinates)) return null;

    const [longitude, latitude] = trouve.geometry.coordinates;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    // Un score trop faible signale une correspondance douteuse : mieux
    // vaut aucun point qu'un point au mauvais endroit.
    if (typeof trouve.properties?.score === 'number' && trouve.properties.score < 0.4) return null;

    return { latitude, longitude };
  } catch {
    return null;   // réseau indisponible, délai dépassé, réponse illisible
  }
}
