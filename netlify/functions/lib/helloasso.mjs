import { createHash } from 'node:crypto';

/**
 * Accès à l'API HelloAsso.
 *
 * Tout se passe côté serveur : l'identifiant et le secret restent dans
 * les variables d'environnement, ne sont jamais envoyés au navigateur,
 * et n'apparaissent dans aucun journal.
 *
 * Variables attendues :
 *   HELLOASSO_CLIENT_ID      identifiant d'API
 *   HELLOASSO_CLIENT_SECRET  secret d'API
 *   HELLOASSO_ORGANISATION   identifiant d'organisation dans l'adresse
 *                            HelloAsso (le « slug »)
 *   HELLOASSO_DUREE_MOIS     durée de validité d'une adhésion, en mois
 *                            (12 par défaut)
 *   HELLOASSO_BAC_A_SABLE    « oui » pour viser l'environnement d'essai
 *
 * Documentation : https://dev.helloasso.com/docs/getting-started
 */

const RACINE = () =>
  /^(oui|true|1)$/i.test(process.env.HELLOASSO_BAC_A_SABLE || '')
    ? 'https://api.helloasso-sandbox.com'
    : 'https://api.helloasso.com';

/** Durée de validité d'une adhésion, en mois. */
export function dureeAdhesionMois() {
  const n = Number(process.env.HELLOASSO_DUREE_MOIS);
  return Number.isInteger(n) && n > 0 && n <= 120 ? n : 12;
}

export function helloassoConfigure() {
  return Boolean(
    process.env.HELLOASSO_CLIENT_ID
    && process.env.HELLOASSO_CLIENT_SECRET
    && process.env.HELLOASSO_ORGANISATION
  );
}

export class ErreurHelloAsso extends Error {
  constructor(message, statut) {
    super(message);
    this.name = 'ErreurHelloAsso';
    this.statut = statut || null;
  }
}

/* =====================================================================
   JETON D'ACCÈS
   Valable une trentaine de minutes. Il est gardé en mémoire le temps
   que dure l'instance, pour ne pas en redemander un à chaque appel.
   ===================================================================== */
let jetonEnCache = null; // { valeur, expireLe }

export function oublierJeton() {
  jetonEnCache = null;
}

async function jeton() {
  if (jetonEnCache && jetonEnCache.expireLe > Date.now() + 60_000) {
    return jetonEnCache.valeur;
  }

  const corps = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.HELLOASSO_CLIENT_ID,
    client_secret: process.env.HELLOASSO_CLIENT_SECRET,
  });

  const r = await fetch(`${RACINE()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corps.toString(),
  });

  if (!r.ok) {
    // Le corps de la réponse peut contenir l'identifiant : on n'en
    // garde que le code, jamais le détail.
    throw new ErreurHelloAsso(`authentification refusée (${r.status})`, r.status);
  }

  const d = await r.json();
  if (!d || !d.access_token) throw new ErreurHelloAsso('jeton absent de la réponse');

  const duree = Number(d.expires_in) > 0 ? Number(d.expires_in) : 1799;
  jetonEnCache = { valeur: d.access_token, expireLe: Date.now() + duree * 1000 };
  return jetonEnCache.valeur;
}

/* =====================================================================
   LECTURE PAGINÉE DES ARTICLES
   HelloAsso ne renvoie ni total ni nombre de pages : on avance avec le
   jeton de continuation et l'on s'arrête quand la page est vide.
   ===================================================================== */
const PAGE_MAX = 100;
const PAGES_MAX = 400;   // garde-fou : 40 000 articles

/**
 * Lit tous les articles d'adhésion de l'organisation.
 *
 * @param {object} [options]
 * @param {number} [options.pagesMax]
 * @returns {Promise<{articles: Array, pages: number}>}
 */
export async function lireArticlesAdhesion({ pagesMax = PAGES_MAX } = {}) {
  if (!helloassoConfigure()) throw new ErreurHelloAsso('HelloAsso n\'est pas configuré');

  const slug = process.env.HELLOASSO_ORGANISATION;
  const articles = [];
  let suite = null;
  let pages = 0;

  while (pages < pagesMax) {
    const params = new URLSearchParams({
      pageSize: String(PAGE_MAX),
      // Seules les adhésions : ni dons, ni billetterie, ni boutique.
      tierTypes: 'Membership',
      // Articles validés. « Waiting » (paiement en attente), « Deleted »
      // (annulé ou remboursé) et « Unknown » sont écartés d'emblée.
      itemStates: 'Processed',
      withDetails: 'false',
    });
    params.append('itemStates', 'Registered');
    if (suite) params.set('continuationToken', suite);

    const r = await fetch(
      `${RACINE()}/v5/organizations/${encodeURIComponent(slug)}/items?${params}`,
      { headers: { Authorization: `Bearer ${await jeton()}` } }
    );

    if (r.status === 401) {
      // Jeton périmé plus tôt que prévu : on en reprend un, une fois.
      oublierJeton();
      throw new ErreurHelloAsso('jeton refusé par HelloAsso', 401);
    }
    if (!r.ok) {
      throw new ErreurHelloAsso(`lecture des adhésions refusée (${r.status})`, r.status);
    }

    const d = await r.json();
    const page = d.data || d.items || [];
    pages += 1;

    // Une page vide marque la fin : le jeton de continuation, lui, peut
    // encore être présent après la dernière page.
    if (!page.length) break;
    articles.push(...page);

    const nouveau = d?.pagination?.continuationToken;
    if (!nouveau || nouveau === suite) break;
    suite = nouveau;
  }

  return { articles, pages };
}

/* =====================================================================
   RÈGLE DE COMPTAGE
   ===================================================================== */

/** Enlève accents, casse et espaces superflus. */
function normaliser(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Empreinte d'une personne adhérente.
 *
 * L'adhérent est la personne inscrite (`user`), qui n'est pas forcément
 * celle qui paie (`payer`) : une commande familiale porte un seul payeur
 * et plusieurs adhérents. On identifie donc en priorité par le nom de
 * l'adhérent, et l'on ne retombe sur l'e-mail du payeur que si l'article
 * ne porte aucun nom.
 *
 * Dernier recours, l'identifiant de l'article : la personne compte alors
 * pour une, mais ses renouvellements ne peuvent pas être regroupés.
 *
 * @returns {{cle: string, voie: 'nom'|'email'|'article'}}
 */
export function identifierPersonne(article) {
  const u = article?.user || {};
  const nom = normaliser(`${u.lastName || ''} ${u.firstName || ''}`);
  if (nom.replace(/\s/g, '').length >= 3) {
    return { cle: condenser(`nom:${nom}`), voie: 'nom' };
  }

  const email = normaliser(article?.payer?.email);
  if (email.includes('@')) {
    return { cle: condenser(`email:${email}`), voie: 'email' };
  }

  return { cle: condenser(`article:${article?.id}`), voie: 'article' };
}

function condenser(t) {
  const sel = process.env.SEL_EMPREINTE || 'sel-par-defaut-a-remplacer';
  return createHash('sha256').update(`${sel}:${t}`).digest('hex').slice(0, 40);
}

/** Date de l'adhésion : celle de la commande, à défaut celle de l'article. */
function dateArticle(article) {
  const brut = article?.order?.date || article?.date || null;
  const d = brut ? new Date(brut) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * Regroupe les articles par personne et détermine qui est à jour.
 *
 * Une personne est comptée une seule fois, quels que soient le nombre de
 * commandes et le nombre de renouvellements. Elle est « active » si sa
 * dernière adhésion est postérieure à la limite de validité.
 *
 * @param {Array} articles
 * @param {Date}  [maintenant]
 */
export function compterAdherents(articles, maintenant = new Date()) {
  const limite = new Date(maintenant);
  limite.setMonth(limite.getMonth() - dureeAdhesionMois());

  const personnes = new Map();
  let sansDate = 0;
  const voies = { nom: 0, email: 0, article: 0 };

  for (const a of articles) {
    const { cle, voie } = identifierPersonne(a);
    const d = dateArticle(a);
    if (!d) sansDate += 1;
    voies[voie] += 1;

    const existante = personnes.get(cle);
    if (!existante) {
      personnes.set(cle, {
        cle_personne: cle,
        premiere_adhesion: d,
        derniere_adhesion: d,
        nombre_adhesions: 1,
      });
      continue;
    }
    existante.nombre_adhesions += 1;
    if (d) {
      if (!existante.premiere_adhesion || d < existante.premiere_adhesion) existante.premiere_adhesion = d;
      if (!existante.derniere_adhesion || d > existante.derniere_adhesion) existante.derniere_adhesion = d;
    }
  }

  const lignes = [...personnes.values()].map((p) => ({
    ...p,
    // Sans date exploitable, on ne peut pas affirmer que l'adhésion
    // court encore : elle est comptée comme échue.
    active: Boolean(p.derniere_adhesion && p.derniere_adhesion >= limite),
  }));

  return {
    lignes,
    personnes: lignes.length,
    actifs: lignes.filter((l) => l.active).length,
    adhesions: articles.length,
    sansDate,
    voies,
    periode: { debut: limite, fin: maintenant },
  };
}
