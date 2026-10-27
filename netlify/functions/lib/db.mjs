/**
 * Accès à la base Supabase, côté serveur uniquement.
 *
 * La clé de service ne doit JAMAIS quitter cet environnement : elle vit
 * dans les variables d'environnement Netlify, jamais dans le dépôt,
 * jamais dans le navigateur. Les tables ont la sécurité au niveau des
 * lignes activée sans aucune politique : sans cette clé, personne ne lit
 * ni n'écrit quoi que ce soit.
 */

const URL_BASE = process.env.SUPABASE_URL;
const CLE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function baseConfiguree() {
  return Boolean(URL_BASE && CLE_SERVICE);
}

function entetes(extra = {}) {
  return {
    apikey: CLE_SERVICE,
    Authorization: `Bearer ${CLE_SERVICE}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function appeler(chemin, options = {}) {
  if (!baseConfiguree()) {
    throw new ErreurBase('Base de données non configurée sur le serveur.', 503);
  }
  const reponse = await fetch(`${URL_BASE}/rest/v1/${chemin}`, {
    ...options,
    headers: entetes(options.headers),
  });
  const texte = await reponse.text();
  let corps = null;
  if (texte) {
    try { corps = JSON.parse(texte); } catch { corps = texte; }
  }
  if (!reponse.ok) {
    const err = new ErreurBase(
      (corps && corps.message) || `Erreur base ${reponse.status}`,
      reponse.status
    );
    err.code = corps && corps.code;
    err.details = corps;
    throw err;
  }
  return corps;
}

export class ErreurBase extends Error {
  constructor(message, statut = 500) {
    super(message);
    this.name = 'ErreurBase';
    this.statut = statut;
  }
}

/** Insère une ligne et renvoie l'enregistrement créé. */
export function inserer(table, ligne) {
  return appeler(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(ligne),
  }).then((r) => (Array.isArray(r) ? r[0] : r));
}

/** Lit des lignes. `requete` est une chaîne PostgREST, par ex. "select=*&statut=eq.Nouveau". */
export function lire(table, requete = 'select=*') {
  return appeler(`${table}?${requete}`);
}

export function majParId(table, id, champs) {
  return appeler(`${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(champs),
  }).then((r) => (Array.isArray(r) ? r[0] : r));
}

/**
 * Insère ou met à jour un lot de lignes en un seul appel.
 * `conflit` nomme la ou les colonnes qui identifient une ligne existante.
 */
export function remplacerLot(table, lignes, conflit) {
  if (!lignes.length) return Promise.resolve([]);
  return appeler(`${table}?on_conflict=${encodeURIComponent(conflit)}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(lignes),
  });
}

/** Supprime des lignes. `requete` est une chaîne PostgREST. */
export function supprimer(table, requete) {
  return appeler(`${table}?${requete}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

/** Met à jour des lignes désignées par une requête PostgREST. */
export function majOu(table, requete, champs) {
  return appeler(`${table}?${requete}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(champs),
  }).then((r) => (Array.isArray(r) ? r[0] : r));
}

/** Appelle une fonction SQL. */
export function rpc(nom, arguments_ = {}) {
  return appeler(`rpc/${nom}`, { method: 'POST', body: JSON.stringify(arguments_) });
}

/**
 * Insertion idempotente.
 * Si la clé d'idempotence existe déjà, on renvoie l'enregistrement
 * existant au lieu d'en créer un second : un double clic ou une nouvelle
 * tentative après un échec réseau ne crée jamais de doublon.
 */
export async function insererIdempotent(table, ligne, cle) {
  if (cle) {
    const existant = await lire(
      table,
      `select=*&cle_idempotence=eq.${encodeURIComponent(cle)}&limit=1`
    );
    if (existant.length) return { enregistrement: existant[0], deja: true };
  }
  try {
    const enregistrement = await inserer(table, { ...ligne, cle_idempotence: cle || null });
    return { enregistrement, deja: false };
  } catch (e) {
    // 23505 = violation d'unicité. Course entre deux envois simultanés,
    // ou doublon détecté par un index métier.
    if (e.code === '23505' && cle) {
      const existant = await lire(
        table,
        `select=*&cle_idempotence=eq.${encodeURIComponent(cle)}&limit=1`
      );
      if (existant.length) return { enregistrement: existant[0], deja: true };
    }
    throw e;
  }
}
