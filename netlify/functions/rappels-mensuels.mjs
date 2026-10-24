import { executerRappels } from './lib/rappels.mjs';

/**
 * Tâche planifiée Netlify — rappels mensuels de contribution.
 *
 * Elle s'exécute côté serveur toutes les heures, qu'un visiteur ouvre le
 * site ou non. La fonction décide elle-même si c'est le bon jour et la
 * bonne heure à Paris : la syntaxe cron ne sait pas dire « le dernier
 * jour du mois » et ignore l'heure d'été.
 */
export const config = { schedule: '0 * * * *' };

export default async (req) => executerRappels(req);
