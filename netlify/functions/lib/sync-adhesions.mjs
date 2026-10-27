import { lire, remplacerLot, supprimer, majOu } from './db.mjs';
import {
  lireArticlesAdhesion, compterAdherents, helloassoConfigure,
  dureeAdhesionMois, ErreurHelloAsso,
} from './helloasso.mjs';

/**
 * Synchronisation des adhésions HelloAsso.
 *
 * Le principe : on relit tout, on en déduit la liste des personnes, et
 * l'on remplace le contenu de la table. Les personnes disparues du
 * catalogue — commande annulée, adhésion supprimée — s'effacent, celles
 * qui restent gardent leur empreinte.
 *
 * En cas d'échec, rien n'est touché : le dernier chiffre connu reste
 * affiché, avec sa date. Le compteur ne retombe jamais à zéro faute de
 * réponse.
 */

export async function synchroniser() {
  const depart = Date.now();
  const debutISO = new Date().toISOString();

  await majOu('synchronisation_helloasso', 'id=eq.1', {
    derniere_tentative: debutISO,
    statut: 'en_cours',
  }).catch(() => {});

  if (!helloassoConfigure()) {
    return echec('HelloAsso n\'est pas configuré sur le serveur.', depart);
  }

  let articles, pages;
  try {
    ({ articles, pages } = await lireArticlesAdhesion());
  } catch (e) {
    const motif = e instanceof ErreurHelloAsso
      ? e.message
      : `lecture impossible : ${String(e.message).slice(0, 150)}`;
    return echec(motif, depart);
  }

  const bilan = compterAdherents(articles);

  // Les lignes sont écrites avant la suppression : si l'écriture
  // échoue, l'ancien contenu reste en place plutôt que de disparaître.
  const marqueur = new Date().toISOString();
  try {
    const lignes = bilan.lignes.map((l) => ({
      cle_personne: l.cle_personne,
      premiere_adhesion: (l.premiere_adhesion || new Date(0)).toISOString(),
      derniere_adhesion: (l.derniere_adhesion || new Date(0)).toISOString(),
      nombre_adhesions: l.nombre_adhesions,
      active: l.active,
      vue_le: marqueur,
    }));

    // Par paquets : une requête unique de plusieurs milliers de lignes
    // serait refusée.
    for (let i = 0; i < lignes.length; i += 500) {
      await remplacerLot('adhesions_helloasso', lignes.slice(i, i + 500), 'cle_personne');
    }
    // Ce qui n'a pas été revu lors de ce passage n'existe plus chez
    // HelloAsso.
    await supprimer('adhesions_helloasso', `vue_le=lt.${encodeURIComponent(marqueur)}`);
  } catch (e) {
    return echec(`enregistrement impossible : ${String(e.message).slice(0, 150)}`, depart);
  }

  const etat = {
    derniere_tentative: debutISO,
    derniere_reussite: new Date().toISOString(),
    adherents_actifs: bilan.actifs,
    adhesions_totales: bilan.adhesions,
    periode_debut: bilan.periode.debut.toISOString(),
    periode_fin: bilan.periode.fin.toISOString(),
    articles_lus: articles.length,
    pages_lues: pages,
    duree_ms: Date.now() - depart,
    statut: 'ok',
    derniere_erreur: null,
  };
  await majOu('synchronisation_helloasso', 'id=eq.1', etat).catch(() => {});

  return {
    ok: true,
    ...etat,
    personnes: bilan.personnes,
    sans_date: bilan.sansDate,
    identification: bilan.voies,
    duree_adhesion_mois: dureeAdhesionMois(),
  };
}

async function echec(motif, depart) {
  // Le message est technique et ne contient ni identifiant ni secret :
  // helloasso.mjs ne remonte que des codes de statut.
  console.error('sync-helloasso', motif);
  await majOu('synchronisation_helloasso', 'id=eq.1', {
    statut: 'echec',
    derniere_erreur: String(motif).slice(0, 300),
    duree_ms: Date.now() - depart,
  }).catch(() => {});
  return { ok: false, statut: 'echec', motif, duree_ms: Date.now() - depart };
}

/**
 * État public : uniquement des chiffres agrégés.
 * Jamais de nom, d'e-mail ni de détail de paiement.
 */
export async function etatAdhesions() {
  let etat = null;
  try {
    const lignes = await lire('synchronisation_helloasso', 'select=*&id=eq.1');
    etat = Array.isArray(lignes) ? lignes[0] : lignes;
  } catch {
    return null;
  }
  if (!etat) return null;

  const objectif = 200;
  const actifs = Number.isInteger(etat.adherents_actifs) ? etat.adherents_actifs : null;

  return {
    objectif,
    adherents_actifs: actifs,
    restants: actifs === null ? null : Math.max(0, objectif - actifs),
    periode_debut: etat.periode_debut,
    periode_fin: etat.periode_fin,
    duree_adhesion_mois: dureeAdhesionMois(),
    derniere_synchronisation: etat.derniere_reussite,
    statut: etat.statut,
    // Le chiffre ne porte que sur HelloAsso : il n'est jamais présenté
    // comme le total de l'association.
    source: 'HelloAsso',
  };
}
