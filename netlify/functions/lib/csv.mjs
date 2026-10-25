/**
 * Fabrication du CSV joint aux e-mails de l'association.
 *
 * Destination : Excel en français. D'où le point-virgule comme
 * séparateur, la virgule décimale, les dates en JJ/MM/AAAA et le BOM en
 * tête du fichier — sans lui, Excel lit l'UTF-8 comme du latin-1 et les
 * accents deviennent illisibles.
 */

/** Caractères qui, en tête de cellule, font d'un texte une formule. */
const DEBUTS_DANGEREUX = ['=', '+', '-', '@', '\t', '\r', '\n'];

/**
 * Neutralise l'injection de formule.
 *
 * Une cellule commençant par « = » ou « + » est exécutée par Excel et
 * LibreOffice. Un participant qui saisirait `=HYPERLINK(...)` dans son
 * nom ou son message pourrait ainsi piéger celui qui ouvre le fichier.
 * L'apostrophe en tête force la lecture en texte ; Excel ne l'affiche
 * pas. Seul effet visible : un téléphone saisi « +33… » apparaît avec
 * une apostrophe dans certains tableurs.
 */
export function neutraliser(valeur) {
  const t = String(valeur ?? '');
  if (!t) return '';
  return DEBUTS_DANGEREUX.includes(t[0]) ? `'${t}` : t;
}

/** Cellule texte : neutralisée, guillemetée, guillemets internes doublés. */
function texte(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return '""';
  const t = neutraliser(valeur).replace(/[\r\n]+/g, ' ').trim();
  return `"${t.replace(/"/g, '""')}"`;
}

/** Nombre : virgule décimale, sans guillemets, pour qu'Excel le calcule. */
function nombre(valeur, decimales = 2) {
  if (valeur === null || valeur === undefined || valeur === '') return '';
  const n = Number(valeur);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(decimales).replace('.', ',');
}

function entier(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return '';
  const n = Number(valeur);
  return Number.isFinite(n) ? String(Math.round(n)) : '';
}

/** Date et heure en JJ/MM/AAAA HH:MM, heure de Paris. */
function horodatage(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Date seule en JJ/MM/AAAA. */
function dateSeule(valeur) {
  if (!valeur) return '';
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.day}/${p.month}/${p.year}`;
}

const oui = (v) => (v ? 'Oui' : 'Non');

const NOM_FORFAIT = { bronze: 'Bronze', argent: 'Argent', gold: 'Gold', libre: 'Libre' };
const NOM_DEVISE = { EUR: 'EUR', XOF: 'FCFA' };

/** Colonnes du fichier : intitulé affiché, et comment lire la ligne. */
const COLONNES = [
  ['Référence',               (e) => texte(e.reference)],
  ['Reçu le',                 (e) => horodatage(e.recu_le)],
  ['Prénom',                  (e) => texte(e.prenom)],
  ['Nom',                     (e) => texte(e.nom)],
  ['E-mail',                  (e) => texte(e.email)],
  ['Téléphone',               (e) => texte(e.telephone)],
  ['Code postal',             (e) => texte(e.code_postal)],
  ['Ville',                   (e) => texte(e.ville)],
  ['Département',             (e) => texte(e.departement)],
  ['Zone',                    (e) => texte(e.zone)],
  ['Dahira',                  (e) => texte(e.dahira)],
  ['Forfait',                 (e) => texte(NOM_FORFAIT[e.forfait] || e.forfait)],
  // Le franc CFA ne se divise pas : aucune décimale pour lui.
  ['Montant déclaré',         (e) => nombre(e.montant_mensuel_declare, e.devise === 'XOF' ? 0 : 2)],
  ['Devise',                  (e) => texte(NOM_DEVISE[e.devise] || e.devise || 'EUR')],
  ['Périodicité',             (e) => texte(e.periodicite === 'mensuelle' ? 'Mensuelle' : e.periodicite)],
  ['Durée (mois)',            (e) => entier(e.duree_mois)],
  ['Total prévisionnel',      (e) => nombre(e.total_previsionnel, e.devise === 'XOF' ? 0 : 2)],
  ['Préférence de règlement', (e) => texte(e.preference_reglement)],
  ['Statut',                  (e) => texte(e.statut)],
  ['Début',                   (e) => dateSeule(e.debut_engagement)],
  ['Fin prévue',              (e) => dateSeule(e.fin_engagement)],
  ['Rappel e-mail',           (e) => texte(oui(e.rappel_email))],
  ['Rappel WhatsApp',         (e) => texte(oui(e.rappel_whatsapp))],
  ['Consentement le',         (e) => horodatage(e.consentement_le)],
  ['Message',                 (e) => texte(e.message)],
];

/**
 * @param {Array<object>} lignes  engagements, déjà filtrés des tests
 * @returns {string} le contenu du fichier, BOM compris
 */
export function fabriquerCSV(lignes) {
  const entete = COLONNES.map(([nom]) => `"${nom}"`).join(';');
  const corps = (lignes || []).map((e) => COLONNES.map(([, lire]) => lire(e)).join(';'));
  return '﻿' + [entete, ...corps].join('\r\n') + '\r\n';
}

/** engagements-zawiya-2026-10-25.csv */
export function nomFichierCSV(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return `engagements-zawiya-${p.year}-${p.month}-${p.day}.csv`;
}

/**
 * Totaux par devise. Les devises ne sont jamais additionnées entre elles :
 * la fonction renvoie une entrée par devise rencontrée.
 */
export function totauxParDevise(lignes) {
  const parDevise = new Map();
  for (const e of lignes || []) {
    const d = e.devise || 'EUR';
    if (!parDevise.has(d)) {
      parDevise.set(d, {
        devise: d,
        libelle: NOM_DEVISE[d] || d,
        nombre: 0,
        mensuel: 0,
        horizon24: 0,
        toutesDurees: 0,
        periodicites: new Set(),
      });
    }
    const t = parDevise.get(d);
    const montant = Number(e.montant_mensuel_declare) || 0;
    const duree = Number(e.duree_mois) || 0;
    t.nombre += 1;
    t.mensuel += montant;
    t.horizon24 += montant * Math.min(duree, 24);
    t.toutesDurees += montant * duree;
    t.periodicites.add(e.periodicite === 'mensuelle' ? 'mensuelle' : (e.periodicite || 'mensuelle'));
  }
  return [...parDevise.values()]
    .map((t) => ({ ...t, periodicites: [...t.periodicites] }))
    .sort((a, b) => (a.devise === 'EUR' ? -1 : b.devise === 'EUR' ? 1 : a.devise.localeCompare(b.devise)));
}

/** Montant formaté dans sa devise. */
export function montant(valeur, devise = 'EUR') {
  const n = Number(valeur) || 0;
  if (devise === 'XOF') {
    return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' FCFA';
  }
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';
}
