import { synchroniser } from './lib/sync-adhesions.mjs';

/**
 * Synchronisation automatique des adhésions HelloAsso.
 *
 * Toutes les six heures : assez pour que le compteur reste juste, assez
 * peu pour ménager l'API et les ressources de l'hébergement. Un
 * rafraîchissement immédiat reste possible depuis l'espace
 * d'administration.
 */
export const config = { schedule: '17 */6 * * *' };

export default async () => {
  const bilan = await synchroniser();
  // La tâche planifiée n'a pas de destinataire : seul le journal garde
  // la trace. Aucun secret n'y figure.
  console.log('sync-helloasso', JSON.stringify({
    ok: bilan.ok, statut: bilan.statut,
    adherents_actifs: bilan.adherents_actifs ?? null,
    articles_lus: bilan.articles_lus ?? null,
    duree_ms: bilan.duree_ms,
  }));
  return new Response(null, { status: 204 });
};
