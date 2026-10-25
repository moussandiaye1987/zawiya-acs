import { lire, inserer, majParId, rpc, baseConfiguree } from './db.mjs';
import { envoyer, gabarit, echapper } from './mail.mjs';
import { euros, signer } from './commun.mjs';

/**
 * Rappel mensuel de contribution, par e-mail.
 *
 * WhatsApp n'est pas traité ici : il passe par la page de relance
 * assistée (relance-whatsapp.mjs), où un responsable clique lui-même.
 * Le SMS a été abandonné, son coût étant prohibitif.
 *
 * La fonction tourne toutes les heures, indépendamment de toute visite du
 * site. À chaque passage elle regarde l'heure locale à Paris et n'agit que
 * le jour et à l'heure configurés dans `parametres_rappels`.
 *
 * Pourquoi toutes les heures plutôt qu'une seule fois par mois : la syntaxe
 * cron ne sait pas exprimer « le dernier jour du mois », et elle ignore
 * l'heure d'été. On planifie donc large et on décide ici, ce qui rend aussi
 * le jour et l'heure modifiables sans redéployer.
 */
const MAX_TENTATIVES = 3;

export async function executerRappels(req) {
  if (!baseConfiguree()) return rep({ ok: false, motif: 'base non configurée' });

  // Le contrôle du secret appartient au point d'entrée HTTP (rappels-test.mjs) :
  // la tâche planifiée, elle, n'est pas exposée sur le réseau.
  const forcer = req ? new URL(req.url).searchParams.get('forcer') === '1' : false;

  const parametres = (await lire('parametres_rappels', 'select=*&id=eq.1'))[0];
  if (!parametres) return rep({ ok: false, motif: 'paramètres absents' });
  if (!parametres.actifs && !forcer) {
    return rep({ ok: true, action: 'aucune', motif: 'rappels désactivés' });
  }

  const maintenant = new Date();
  const local = partiesLocales(maintenant, parametres.fuseau || 'Europe/Paris');

  if (!forcer) {
    if (local.heure !== Number(parametres.heure_locale)) {
      return rep({ ok: true, action: 'aucune', motif: `heure ${local.heure} ≠ ${parametres.heure_locale}` });
    }
    const jourAttendu =
      parametres.jour_du_mois === 'dernier'
        ? dernierJourDuMois(local.annee, local.mois)
        : Number(parametres.jour_du_mois);
    if (local.jour !== jourAttendu) {
      return rep({ ok: true, action: 'aucune', motif: `jour ${local.jour} ≠ ${jourAttendu}` });
    }
  }

  const mois = `${local.annee}-${String(local.mois).padStart(2, '0')}-01`;
  const nomMois = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${mois}T12:00:00Z`));

  const candidats = await rpc('engagements_a_rappeler', { p_mois: mois, p_canal: 'email' });
  const resultats = { mois, examines: candidats.length, envoyes: 0, echecs: 0, ignores: 0 };

  for (const c of candidats) {
    // Filtre du mode test : tant qu'il est actif, seuls les destinataires
    // listés reçoivent quoi que ce soit.
    if (parametres.mode_test) {
      const autorises = (parametres.destinataires_test || []).map((a) => a.toLowerCase());
      if (!c.email || !autorises.includes(c.email.toLowerCase())) {
        await marquer(c, mois, 'email', 'ignore', 'mode test : destinataire non listé');
        resultats.ignores++;
        continue;
      }
    }

    if (!parametres.canal_email || !c.email) {
      await marquer(c, mois, 'email', 'ignore', 'pas de canal e-mail utilisable');
      resultats.ignores++;
      continue;
    }

    const envoi = await envoyerRappel(c, mois, nomMois, parametres);
    if (envoi.envoye) { resultats.envoyes++; } else { resultats.echecs++; }
  }

  // Rejoue les échecs des mois précédents, dans la limite des tentatives.
  const aRejouer = await lire(
    'rappels',
    `select=*&statut=eq.echec&tentatives=lt.${MAX_TENTATIVES}&order=cree_le.asc&limit=20`
  );
  resultats.rejoues = aRejouer.length;

  return rep({ ok: true, ...resultats });
}

async function envoyerRappel(c, mois, nomMois, p) {
  const base = process.env.URL || '';
  const jeton = signer(c.jeton_prive);
  const lien = (action) =>
    base ? `${base}/api/participant?r=${encodeURIComponent(c.reference)}&t=${jeton}&a=${action}&m=${mois}` : null;

  const lienVerse = lien('j-ai-verse');
  const lienStop = lien('suspendre-rappels');

  const texte = `Bonjour ${c.prenom},

Merci pour votre soutien au projet de Zawiya Cheikh Ibrahim Niasse.
Voici votre rappel pour la contribution de ${nomMois}, d'un montant de ${euros(c.montant_mensuel_declare)}.
Référence à indiquer : ${c.reference}.

${p.instructions_reglement}

Si vous avez déjà effectué votre contribution, merci de ne pas tenir compte de ce message.
Pour modifier ou suspendre votre engagement, contactez-nous à ${p.contact_difficulte}.

Merci pour votre participation.`;

  const html = gabarit(`Votre contribution de ${escapeMois(nomMois)}`, `
    <p>Bonjour ${echapper(c.prenom)},</p>
    <p>Merci pour votre soutien au projet de Zawiya Cheikh Ibrahim Niasse.</p>
    <p>Voici votre rappel pour la contribution de <strong>${escapeMois(nomMois)}</strong>,
       d'un montant de <strong>${euros(c.montant_mensuel_declare)}</strong>.<br>
       Référence à indiquer : <strong>${echapper(c.reference)}</strong>.</p>
    <p style="background:#EFE8DC;border-left:3px solid #1E7A43;padding:10px 14px">${echapper(p.instructions_reglement)}</p>
    <p><em>Si vous avez déjà effectué votre contribution, merci de ne pas tenir compte de ce message.</em></p>
    ${lienVerse ? `<p><a href="${lienVerse}" style="display:inline-block;background:#1E7A43;color:#FBF8F2;text-decoration:none;padding:10px 18px;border-radius:3px">J'ai effectué mon versement</a>
      <br><span style="font-size:12px;color:#6b7d71">Cette déclaration sera vérifiée par l'association ; elle ne vaut pas confirmation d'encaissement.</span></p>` : ''}
    <p style="font-size:13px;color:#6b7d71">
      Pour modifier ou suspendre votre engagement, écrivez à ${echapper(p.contact_difficulte)}.
      ${lienStop ? `<br><a href="${lienStop}" style="color:#1E7A43">Ne plus recevoir ces rappels</a> — cela n'annule pas votre engagement.` : ''}
    </p>`);

  const resultat = await envoyer({
    destinataire: c.email,
    sujet: `Votre contribution de ${nomMois} — ${c.reference}`,
    texte,
    html,
  });

  await marquer(
    c, mois, 'email',
    resultat.envoye ? 'envoye' : 'echec',
    resultat.envoye ? null : String(resultat.motif).slice(0, 300)
  );
  return resultat;
}

/** Une seule ligne par personne et par mois : l'index unique empêche le double envoi. */
async function marquer(c, mois, canal, statut, detail) {
  const champs = {
    engagement_id: c.engagement_id,
    mois,
    canal,
    statut,
    tentatives: 1,
    envoye_le: statut === 'envoye' ? new Date().toISOString() : null,
  };
  if (statut === 'echec') champs.derniere_erreur = detail;
  if (statut === 'ignore') champs.motif_ignore = detail;

  try {
    await inserer('rappels', champs);
  } catch (e) {
    if (e.code === '23505') {
      const [existant] = await lire(
        'rappels',
        `select=*&engagement_id=eq.${c.engagement_id}&mois=eq.${mois}&canal=eq.${canal}&limit=1`
      );
      if (existant) {
        await majParId('rappels', existant.id, {
          statut,
          tentatives: existant.tentatives + 1,
          derniere_erreur: statut === 'echec' ? detail : null,
          envoye_le: statut === 'envoye' ? new Date().toISOString() : existant.envoye_le,
        });
      }
    } else {
      console.error('rappels:marquer', e.message);
    }
  }
}

/** Découpe une date dans un fuseau donné, sans dépendance externe. */
function partiesLocales(date, fuseau) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: fuseau, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    annee: Number(p.year),
    mois: Number(p.month),
    jour: Number(p.day),
    heure: Number(p.hour) % 24,
  };
}

function dernierJourDuMois(annee, mois) {
  return new Date(Date.UTC(annee, mois, 0)).getUTCDate();
}

function escapeMois(m) {
  return echapper(m.charAt(0).toUpperCase() + m.slice(1));
}

function rep(corps, statut = 200) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
