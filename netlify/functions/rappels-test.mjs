import { executerRappels } from './lib/rappels.mjs';

/**
 * Déclenchement manuel des rappels, pour les essais.
 *
 *   /api/rappels-test?cle=SECRET_ADMIN            → respecte jour et heure
 *   /api/rappels-test?cle=SECRET_ADMIN&forcer=1   → ignore jour, heure et
 *                                                   interrupteur général
 *
 * Le mode test des paramètres reste la seule garantie que rien ne part
 * vers de vrais destinataires : gardez-le actif tant que vous essayez.
 */
export const config = { path: '/api/rappels-test' };

export default async (req) => {
  const url = new URL(req.url);
  if (!process.env.SECRET_ADMIN || url.searchParams.get('cle') !== process.env.SECRET_ADMIN) {
    return new Response(JSON.stringify({ ok: false, motif: 'clé invalide' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
  return executerRappels(req);
};
