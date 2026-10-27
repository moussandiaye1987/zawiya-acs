import { lire, baseConfiguree } from './lib/db.mjs';
import { etatAdhesions } from './lib/sync-adhesions.mjs';

export const config = { path: '/api/donnees-publiques' };

/**
 * Seule porte de sortie des données vers le navigateur.
 *
 * Ne renvoie que des agrégats et les fiches de Dahiras validées, dans les
 * colonnes que leur responsable a autorisées. Aucune ligne nominative
 * d'engagement ne transite jamais par ici.
 */
export default async () => {
  const entetes = {
    'Content-Type': 'application/json; charset=utf-8',
    // 60 s de cache sur le réseau de diffusion : les chiffres bougent lentement
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  };

  if (!baseConfiguree()) {
    return new Response(
      JSON.stringify({ statut_donnees: 'en_consolidation', motif: 'service non configuré', dahiras: [] }),
      { status: 200, headers: entetes }
    );
  }

  try {
    const [globales, forfaits, zones, departements, durees, suivi, dahiras] = await Promise.all([
      lire('v_stats_globales', 'select=*'),
      lire('v_stats_forfaits', 'select=*'),
      lire('v_stats_zones', 'select=*'),
      lire('v_stats_departements', 'select=*'),
      lire('v_stats_durees', 'select=*'),
      lire('suivi_association', 'select=*&id=eq.1'),
      lire('v_dahiras_publiques', 'select=*&order=nom.asc'),
    ]);

    const g = globales[0] || {};
    const s = suivi[0] || {};
    const nbEngagements = Number(g.engagements_enregistres || 0);

    // Tant qu'aucun engagement n'est enregistré et que l'association n'a pas
    // déclaré la collecte ouverte, on ne présente pas des zéros comme des
    // chiffres : on annonce que les données sont en cours de consolidation.
    const statut_donnees =
      nbEngagements === 0 && !s.collecte_demarree ? 'en_consolidation' : 'disponible';

    const parCle = (rows, cle, valeur) =>
      Object.fromEntries(rows.map((r) => [r[cle], Number(r[valeur])]));

    return new Response(JSON.stringify({
      statut_donnees,
      objectif_euros: Number(s.objectif_euros ?? 2000000),
      horizon_mois: Number(s.horizon_mois ?? 24),
      collecte_demarree: Boolean(s.collecte_demarree),
      collecte_demarree_le: s.collecte_demarree_le || null,
      commentaire_public: s.commentaire_public || null,

      // engagements DÉCLARÉS — jamais des sommes encaissées
      engagements_enregistres: nbEngagements,
      mensuel_declare_total: Number(g.mensuel_declare_total || 0),
      previsionnel_horizon_24: Number(g.previsionnel_horizon_24 || 0),
      previsionnel_toutes_durees: Number(g.previsionnel_toutes_durees || 0),
      dernier_enregistrement: g.dernier_enregistrement || null,

      par_forfait: parCle(forfaits, 'forfait', 'nombre'),
      par_zone: parCle(zones, 'zone', 'nombre'),
      par_departement: parCle(departements, 'departement', 'nombre'),
      par_duree: parCle(durees, 'duree_mois', 'nombre'),

      // encaissements : publiés seulement si l'association les a saisis
      versements_recus_euros:
        s.versements_recus_euros === null || s.versements_recus_euros === undefined
          ? null
          : Number(s.versements_recus_euros),
      versements_arretes_au: s.versements_arretes_au || null,

      dahiras,

      // Adhésions HelloAsso : des chiffres agrégés, rien d'autre. Null
      // si rien n'a encore été synchronisé — jamais un zéro trompeur.
      adhesions: await etatAdhesions().catch(() => null),

      // Lien officiel vers la campagne d'adhésion. Vide tant que
      // l'association ne l'a pas renseigné : la page retombe alors sur
      // la page publique de l'association, qui est vérifiée.
      helloasso_adhesion: process.env.HELLOASSO_URL_ADHESION || null,

      // Information fiscale : affichée seulement si l'association a
      // confirmé son éligibilité et activé l'interrupteur.
      fiscal_actif: /^(oui|true|1)$/i.test(process.env.AFFICHER_INFO_FISCALE || ''),

      genere_le: new Date().toISOString(),
    }), { status: 200, headers: entetes });
  } catch (e) {
    console.error('donnees-publiques', e.message);
    return new Response(
      JSON.stringify({ statut_donnees: 'en_consolidation', motif: 'lecture impossible', dahiras: [] }),
      { status: 200, headers: entetes }
    );
  }
};
