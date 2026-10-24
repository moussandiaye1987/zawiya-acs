/**
 * Banc d'essai des fonctions serveur.
 *
 * Rien ne sort de la machine : la base et le fournisseur d'e-mails sont
 * simulés. On vérifie le comportement, pas la connectivité.
 *
 *   node outils/verifier.mjs
 */

process.env.SUPABASE_URL = 'https://faux.supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'cle-de-test';
process.env.BREVO_API_KEY = 'cle-brevo-de-test';
process.env.MAIL_EXPEDITEUR = 'test@exemple.test';
process.env.EMAIL_ASSOCIATION = 'bureau@exemple.test';
process.env.SEL_EMPREINTE = 'sel-de-test';
process.env.SECRET_LIENS = 'secret-de-test';
process.env.SECRET_ADMIN = 'admin-de-test';
process.env.URL = 'https://site.test';

/* ------------------------------------------------------------------ */
/* Base de données simulée                                             */
/* ------------------------------------------------------------------ */
const BASE = { engagements: [], dahiras: [], journal_notifications: [], versements: [], rappels: [] };
const APPELS = { mails: [], echecMail: false, rpc: [] };

function reinitialiser(){
  Object.keys(BASE).forEach(k => { BASE[k].length = 0; });
  APPELS.mails.length = 0; APPELS.rpc.length = 0; APPELS.echecMail = false;
}

function repJSON(corps, status = 200){
  return new Response(JSON.stringify(corps), { status, headers:{ 'Content-Type':'application/json' } });
}

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const methode = (options.method || 'GET').toUpperCase();

  // --- fournisseur d'e-mails ---
  if(u.hostname === 'api.brevo.com'){
    if(APPELS.echecMail) return new Response('service indisponible', { status: 500 });
    APPELS.mails.push(JSON.parse(options.body));
    return repJSON({ messageId: 'faux' }, 201);
  }

  // --- PostgREST simulé ---
  if(u.hostname === 'faux.supabase.test'){
    const segments = u.pathname.replace('/rest/v1/', '').split('?')[0];

    if(segments.startsWith('rpc/')){
      const nom = segments.slice(4);
      APPELS.rpc.push(nom);
      if(nom === 'compte_soumissions_recentes') return repJSON(0);
      if(nom === 'engagements_a_rappeler'){
        // on reproduit le filtre de la fonction SQL : pas deux fois le même mois
        const { p_mois } = JSON.parse(options.body || '{}');
        const deja = new Set(BASE.rappels
          .filter(r => r.mois === p_mois && ['envoye','ignore'].includes(r.statut))
          .map(r => r.engagement_id));
        return repJSON((BASE.engagements_a_rappeler || []).filter(c => !deja.has(c.engagement_id)));
      }
      return repJSON(null);
    }

    const table = segments;
    const lignes = BASE[table] || (BASE[table] = []);

    if(methode === 'POST'){
      const corps = JSON.parse(options.body);
      // contraintes d'unicité reproduites
      if(corps.cle_idempotence && lignes.some(l => l.cle_idempotence === corps.cle_idempotence)){
        return repJSON({ code:'23505', message:'duplicate key' }, 409);
      }
      if(table === 'engagements' && corps.email &&
         lignes.some(l => l.email === corps.email && !l.est_test)){
        return repJSON({ code:'23505', message:'duplicate email' }, 409);
      }
      // index métier de la base : une Dahira par nom et par ville
      if(table === 'dahiras' && lignes.some(l =>
          (l.nom || '').toLowerCase() === (corps.nom || '').toLowerCase() &&
          (l.ville || '').toLowerCase() === (corps.ville || '').toLowerCase() && !l.est_test)){
        return repJSON({ code:'23505', message:'duplicate dahira' }, 409);
      }
      const ligne = {
        id: 'id-' + (lignes.length + 1),
        total_previsionnel: corps.montant_mensuel_declare != null
          ? corps.montant_mensuel_declare * corps.duree_mois : null,
        jeton_prive: 'jeton-' + (lignes.length + 1),
        ...corps,
      };
      lignes.push(ligne);
      return repJSON([ligne], 201);
    }

    if(methode === 'PATCH'){
      const q = u.searchParams;
      const cible = lignes.find(l => {
        for(const [k, v] of q) {
          if(k === 'select') continue;
          if(String(l[k]) !== String(v).replace(/^eq\./, '')) return false;
        }
        return true;
      });
      if(cible) Object.assign(cible, JSON.parse(options.body));
      return repJSON(cible ? [cible] : []);
    }

    // GET
    const q = u.searchParams;
    let resultat = lignes.slice();
    for(const [k, v] of q){
      if(k === 'select' || k === 'limit' || k === 'order') continue;
      const val = String(v).replace(/^eq\./, '');
      resultat = resultat.filter(l => String(l[k]) === val);
    }
    return repJSON(resultat);
  }

  throw new Error('appel réseau inattendu : ' + url);
};

/* ------------------------------------------------------------------ */
/* Outils de test                                                      */
/* ------------------------------------------------------------------ */
let total = 0, reussis = 0;
const serie = (titre) => console.log('\n' + titre);
function verifier(nom, condition, detail = ''){
  total++;
  if(condition){ reussis++; console.log('  ok     ' + nom + (detail ? ' — ' + detail : '')); }
  else { console.log('  ÉCHEC  ' + nom + (detail ? ' — ' + detail : '')); }
}

const requete = (corps, url = 'https://site.test/api/engagement') =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-nf-client-connection-ip':'203.0.113.7' },
    body: JSON.stringify(corps),
  });

const engagementValide = (extra = {}) => ({
  prenom:'Aminata', nom:'Ndiaye', email:'aminata@exemple.test',
  forfait:'argent', duree_mois:24, consentement:true,
  code_postal:'93100', zone:'Île-de-France',
  cle_idempotence:'cle-' + Math.random().toString(16).slice(2),
  duree_saisie_ms: 9000, ...extra,
});

const { default: engagement } = await import('../netlify/functions/engagement.mjs');
const { default: dahira }     = await import('../netlify/functions/dahira.mjs');
const { default: publiques }  = await import('../netlify/functions/donnees-publiques.mjs');
const { default: participant }= await import('../netlify/functions/participant.mjs');

/* ------------------------------------------------------------------ */
serie('ENGAGEMENT — validation');
{
  reinitialiser();
  let r = await engagement(requete({ prenom:'', nom:'', consentement:false, duree_saisie_ms:9000 }));
  let c = await r.json();
  verifier('champs manquants refusés', r.status === 422 && c.fautes.prenom && c.fautes.nom);
  verifier('consentement exigé', Boolean(c.fautes.consentement));
  verifier('rien n’est écrit en base', BASE.engagements.length === 0);

  r = await engagement(requete(engagementValide({ email:'', telephone:'' })));
  c = await r.json();
  verifier('e-mail ou téléphone exigé', r.status === 422 && Boolean(c.fautes.email));

  r = await engagement(requete(engagementValide({ email:'pas-un-email' })));
  verifier('e-mail invalide refusé', r.status === 422);

  r = await engagement(requete(engagementValide({ duree_mois: 18 })));
  verifier('durée hors liste refusée', r.status === 422);

  r = await engagement(requete(engagementValide({ forfait:'libre', montant_mensuel_declare: 2 })));
  verifier('montant libre trop faible refusé', r.status === 422);

  r = await engagement(requete(engagementValide({ forfait:'libre', montant_mensuel_declare: 150 })));
  c = await r.json();
  verifier('montant libre valide accepté', r.status === 200 && c.ok, c.reference);
}

serie('ENGAGEMENT — anti-robot');
{
  reinitialiser();
  let r = await engagement(requete(engagementValide({ site_web:'http://spam.test' })));
  let c = await r.json();
  verifier('piège rempli : réponse neutre', r.status === 200 && c.ignore === true);
  verifier('piège rempli : aucune écriture', BASE.engagements.length === 0);

  r = await engagement(requete(engagementValide({ duree_saisie_ms: 400 })));
  c = await r.json();
  verifier('envoi trop rapide ignoré', c.ignore === true && BASE.engagements.length === 0);
}

serie('ENGAGEMENT — enregistrement et notifications');
{
  reinitialiser();
  const r = await engagement(requete(engagementValide()));
  const c = await r.json();
  verifier('engagement enregistré', r.status === 200 && c.ok === true);
  verifier('référence lisible attribuée', /^ZAWIYA-\d{4}-[A-Z0-9]{6}$/.test(c.reference), c.reference);
  verifier('une seule ligne en base', BASE.engagements.length === 1);
  verifier('la mention « aucun paiement » accompagne la réponse',
    /Aucun paiement ni prélèvement/.test(c.mention));
  verifier('total prévisionnel correct', c.total_previsionnel === 1200, String(c.total_previsionnel));
  verifier('version du consentement conservée',
    BASE.engagements[0].consentement_version === '2026-10-25');
  verifier('adresse IP non stockée en clair',
    !JSON.stringify(BASE.engagements[0]).includes('203.0.113.7') && BASE.engagements[0].ip_hash.length === 32);
  verifier('deux e-mails partis', APPELS.mails.length === 2, APPELS.mails.map(m => m.to[0].email).join(', '));
  verifier('accusé au participant sans mention de paiement effectué',
    APPELS.mails.some(m => m.to[0].email === 'aminata@exemple.test' &&
      /Aucun paiement ni prélèvement/.test(m.textContent)));
  verifier('notification à l’association avec référence et montant',
    APPELS.mails.some(m => m.to[0].email === 'bureau@exemple.test' &&
      m.subject.includes(c.reference) && m.subject.includes('50')));
  verifier('les deux envois sont journalisés', BASE.journal_notifications.length === 2);
  verifier('journal marqué « envoyé »',
    BASE.journal_notifications.every(j => j.statut === 'envoye'));
}

serie('ENGAGEMENT — doublons et renvois');
{
  reinitialiser();
  const charge = engagementValide({ cle_idempotence:'cle-fixe' });
  const r1 = await engagement(requete(charge)); const c1 = await r1.json();
  const r2 = await engagement(requete(charge)); const c2 = await r2.json();
  verifier('le renvoi ne crée pas de doublon', BASE.engagements.length === 1);
  verifier('le renvoi retourne la même référence', c1.reference === c2.reference);
  verifier('le renvoi est signalé', c2.deja === true);
  verifier('pas de second e-mail au renvoi', APPELS.mails.length === 2);

  const r3 = await engagement(requete(engagementValide({ email:'aminata@exemple.test' })));
  const c3 = await r3.json();
  verifier('deuxième engagement avec le même e-mail refusé proprement',
    r3.status === 409 && /déjà enregistré/.test(c3.message));
}

serie('ENGAGEMENT — panne du service d’e-mail');
{
  reinitialiser();
  APPELS.echecMail = true;
  const r = await engagement(requete(engagementValide({ email:'panne@exemple.test' })));
  const c = await r.json();
  verifier('la soumission est conservée malgré la panne', r.status === 200 && BASE.engagements.length === 1);
  verifier('l’échec est journalisé pour rejeu',
    BASE.journal_notifications.length === 2 &&
    BASE.journal_notifications.every(j => j.statut === 'echec'));
  verifier('le motif technique est conservé',
    BASE.journal_notifications.every(j => (j.derniere_erreur || '').includes('brevo')));
}

serie('DAHIRA');
{
  reinitialiser();
  let r = await dahira(requete({ nom:'X', duree_saisie_ms:9000 }, 'https://site.test/api/dahira'));
  let c = await r.json();
  verifier('champs obligatoires exigés',
    r.status === 422 && c.fautes.ville && c.fautes.code_postal && c.fautes.responsable_email);
  verifier('consentement de publication exigé', Boolean(c.fautes.consentement_publication));

  const fiche = {
    nom:'Dahira Nasrul Ilm', ville:'Montreuil', code_postal:'93100',
    responsable_nom:'Moussa Ndiaye', responsable_email:'moussa@exemple.test',
    responsable_telephone:'0600000000', contact_public_telephone:'0600000000',
    contact_public_autorise:true, khadara_vendredi:true, wazifa_quotidienne:false,
    effectif:40, consentement_publication:true, zone:'Île-de-France',
    cle_idempotence:'d-1', duree_saisie_ms:9000,
  };
  r = await dahira(requete(fiche, 'https://site.test/api/dahira'));
  c = await r.json();
  verifier('fiche enregistrée', r.status === 200 && c.ok);
  verifier('statut « En attente » imposé par le serveur',
    BASE.dahiras[0].statut === 'En attente' && c.statut === 'En attente');
  verifier('le département est déduit du code postal', BASE.dahiras[0].departement === '93');
  verifier('accusé au responsable annonçant la validation',
    APPELS.mails.some(m => m.to[0].email === 'moussa@exemple.test' &&
      /validation de l'association/.test(m.textContent)));
  verifier('le bureau est prévenu',
    APPELS.mails.some(m => m.to[0].email === 'bureau@exemple.test' && /valider/.test(m.subject)));

  // même nom, même ville : refusé par l'index métier
  const avant = BASE.dahiras.length;
  r = await dahira(requete({ ...fiche, cle_idempotence:'d-2' }, 'https://site.test/api/dahira'));
  verifier('une fiche en double n’est pas recréée silencieusement',
    BASE.dahiras.length === avant || r.status === 409);
}

serie('DONNÉES PUBLIQUES — confidentialité');
{
  reinitialiser();
  await engagement(requete(engagementValide({ email:'prive@exemple.test', nom:'Secret' })));
  BASE.v_stats_globales = [{ engagements_enregistres:0, mensuel_declare_total:0,
    previsionnel_horizon_24:0, previsionnel_toutes_durees:0, dernier_enregistrement:null }];
  BASE.v_stats_forfaits = []; BASE.v_stats_zones = []; BASE.v_stats_departements = [];
  BASE.v_stats_durees = []; BASE.v_dahiras_publiques = [];
  BASE.suivi_association = [{ id:1, objectif_euros:2000000, horizon_mois:24,
    versements_recus_euros:null, collecte_demarree:false }];

  const r = await publiques();
  const c = await r.json();
  const brut = JSON.stringify(c);
  verifier('aucun nom de participant transmis', !brut.includes('Secret') && !brut.includes('prive@exemple.test'));
  verifier('aucune référence individuelle transmise', !/ZAWIYA-\d{4}/.test(brut));
  verifier('« données en cours de consolidation » quand rien n’est connu',
    c.statut_donnees === 'en_consolidation');
  verifier('aucun montant encaissé inventé', c.versements_recus_euros === null);
  verifier('réponse mise en cache côté réseau seulement',
    /s-maxage/.test(r.headers.get('Cache-Control')));
}

serie('LIEN PARTICIPANT');
{
  reinitialiser();
  await engagement(requete(engagementValide({ email:'lien@exemple.test' })));
  const e = BASE.engagements[0];
  const { createHash } = await import('node:crypto');
  const jeton = createHash('sha256').update('secret-de-test:' + e.jeton_prive).digest('hex').slice(0, 24);
  const lien = (a, t = jeton) =>
    new Request(`https://site.test/api/participant?r=${e.reference}&t=${t}&a=${a}&m=2026-11-01`);

  let r = await participant(lien('suspendre-rappels', 'faux-jeton'));
  verifier('jeton falsifié rejeté', r.status === 400);

  r = await participant(lien('suspendre-rappels'));
  verifier('suspension des rappels acceptée', r.status === 200);
  verifier('les rappels sont bien coupés', BASE.engagements[0].rappels_actifs === false);
  verifier('l’engagement n’est pas annulé', BASE.engagements[0].statut !== 'Annulé');
  const corps = await r.text();
  verifier('la page le dit explicitement', /reste en place/.test(corps));

  r = await participant(lien('j-ai-verse'));
  const corps2 = await r.text();
  verifier('déclaration de versement enregistrée',
    BASE.versements.length === 1 && BASE.versements[0].source === 'declaration_participant');
  verifier('déclaration non confirmée par défaut',
    BASE.versements[0].confirme_par_association === false);
  verifier('la page ne prétend pas que le paiement est constaté',
    /ne vaut pas\s+confirmation d'encaissement/.test(corps2.replace(/\s+/g, ' ')));
}

/* ------------------------------------------------------------------ */
serie('RAPPELS MENSUELS');
{
  reinitialiser();
  const { executerRappels } = await import('../netlify/functions/lib/rappels.mjs');
  const req = (q = '') => new Request('https://site.test/api/rappels-test' + q);

  BASE.parametres_rappels = [{ id:1, actifs:false, jour_du_mois:'dernier', heure_locale:18,
    fuseau:'Europe/Paris', canal_email:true, canal_sms:false, mode_test:true,
    destinataires_test:['essai@exemple.test'],
    instructions_reglement:'Virement sur le compte de l\'association.',
    contact_difficulte:'contact@exemple.test' }];

  let r = await executerRappels(req()); let c = await r.json();
  verifier('désactivés par défaut : aucun envoi', c.action === 'aucune' && APPELS.mails.length === 0);

  BASE.parametres_rappels[0].actifs = true;
  BASE.engagements_a_rappeler = [];
  r = await executerRappels(req('?forcer=1')); c = await r.json();
  verifier('forçage sans candidat : rien ne part', c.ok === true && c.envoyes === 0);

  // un candidat dont l'adresse n'est pas dans la liste de test
  BASE.engagements_a_rappeler = [{ engagement_id:'id-1', reference:'ZAWIYA-2026-ABCDEF',
    prenom:'Aminata', nom:'Ndiaye', email:'vraie@exemple.test', telephone:null,
    canal:'email', montant_mensuel_declare:50, jeton_prive:'jeton-1' }];
  r = await executerRappels(req('?forcer=1')); c = await r.json();
  verifier('mode test : un vrai destinataire est épargné',
    c.ignores === 1 && APPELS.mails.length === 0);
  verifier('la mise à l\'écart est tracée',
    BASE.rappels.length === 1 && BASE.rappels[0].statut === 'ignore');

  // destinataire autorisé
  reinitialiser();
  BASE.parametres_rappels = [{ id:1, actifs:true, jour_du_mois:'dernier', heure_locale:18,
    fuseau:'Europe/Paris', canal_email:true, canal_sms:false, mode_test:true,
    destinataires_test:['essai@exemple.test'],
    instructions_reglement:'Virement sur le compte de l\'association, référence à rappeler.',
    contact_difficulte:'contact@exemple.test' }];
  BASE.engagements_a_rappeler = [{ engagement_id:'id-9', reference:'ZAWIYA-2026-ZZZZZZ',
    prenom:'Essai', nom:'TEST', email:'essai@exemple.test', telephone:null,
    canal:'email', montant_mensuel_declare:50, jeton_prive:'jeton-9' }];
  r = await executerRappels(req('?forcer=1')); c = await r.json();
  verifier('destinataire de test : le rappel part', c.envoyes === 1 && APPELS.mails.length === 1);

  const mail = APPELS.mails[0];
  verifier('le message est personnalisé', /Bonjour Essai/.test(mail.textContent));
  verifier('le mois concerné est nommé', /contribution de \w+ \d{4}/.test(mail.textContent));
  verifier('le montant prévu figure', /50 €/.test(mail.textContent));
  verifier('la référence individuelle figure', mail.textContent.includes('ZAWIYA-2026-ZZZZZZ'));
  verifier('les instructions de règlement figurent', /Virement sur le compte/.test(mail.textContent));
  verifier('le contact en cas de difficulté figure', /contact@exemple\.test/.test(mail.textContent));
  verifier('la formule « si vous avez déjà versé » figure',
    /Si vous avez déjà effectué votre contribution, merci de ne pas tenir compte/.test(mail.textContent));
  verifier('aucun vocabulaire de retard ou d\'impayé',
    !/retard|impay|relance|défaut de paiement/i.test(mail.textContent + mail.htmlContent));
  verifier('lien de désinscription présent', /suspendre-rappels/.test(mail.htmlContent));
  verifier('la déclaration « j\'ai versé » est présentée comme à vérifier',
    /ne vaut pas confirmation d'encaissement/.test(mail.htmlContent));
  verifier('l\'envoi est journalisé une seule fois',
    BASE.rappels.length === 1 && BASE.rappels[0].statut === 'envoye');

  // second passage le même mois
  r = await executerRappels(req('?forcer=1'));
  verifier('aucun second envoi le même mois', APPELS.mails.length === 1);

  // canal SMS désactivé
  reinitialiser();
  BASE.parametres_rappels = [{ id:1, actifs:true, jour_du_mois:'dernier', heure_locale:18,
    fuseau:'Europe/Paris', canal_email:true, canal_sms:false, mode_test:false,
    destinataires_test:[], instructions_reglement:'x', contact_difficulte:'y' }];
  BASE.engagements_a_rappeler = [{ engagement_id:'id-s', reference:'R', prenom:'P', nom:'N',
    email:null, telephone:'0600000000', canal:'sms', montant_mensuel_declare:25, jeton_prive:'j' }];
  r = await executerRappels(req('?forcer=1')); c = await r.json();
  verifier('SMS désactivé par défaut : rien n\'est envoyé', c.ignores === 1 && APPELS.mails.length === 0);
}

/* ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(60));
console.log(`${reussis} / ${total} contrôles réussis`);
process.exit(reussis === total ? 0 : 1);
