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
process.env.EMAIL_ASSOCIATION = 'bureau@exemple.test, second@exemple.test';
process.env.SEL_EMPREINTE = 'sel-de-test';
process.env.SECRET_LIENS = 'secret-de-test';
process.env.SECRET_ADMIN = 'admin-de-test';
process.env.URL = 'https://site.test';

/* ------------------------------------------------------------------ */
/* Base de données simulée                                             */
/* ------------------------------------------------------------------ */
const BASE = { engagements: [], dahiras: [], journal_notifications: [], versements: [], rappels: [] };
const APPELS = { mails: [], echecMail: false, rpc: [], geocodages: [], geocodageEnPanne: false };

function reinitialiser(){
  Object.keys(BASE).forEach(k => { BASE[k].length = 0; });
  APPELS.mails.length = 0; APPELS.rpc.length = 0; APPELS.echecMail = false;
  APPELS.geocodages.length = 0; APPELS.geocodageEnPanne = false;
}

function repJSON(corps, status = 200){
  return new Response(JSON.stringify(corps), { status, headers:{ 'Content-Type':'application/json' } });
}

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const methode = (options.method || 'GET').toUpperCase();

  // --- API Adresse de data.gouv.fr ---
  if(u.hostname === 'api-adresse.data.gouv.fr'){
    APPELS.geocodages.push(u.searchParams.get('q'));
    if(APPELS.geocodageEnPanne) throw new Error('réseau coupé');
    return repJSON({ features: [{ geometry:{ coordinates:[2.441, 48.861] },
                                  properties:{ score: 0.92 } }] });
  }

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
        // on reproduit le filtre de la fonction SQL : un seul rappel par
        // personne et par mois, tous canaux confondus
        const { p_mois, p_canal } = JSON.parse(options.body || '{}');
        const deja = new Set(BASE.rappels
          .filter(r => r.mois === p_mois && ['envoye','ignore'].includes(r.statut))
          .map(r => r.engagement_id));
        return repJSON((BASE.engagements_a_rappeler || [])
          .filter(c => !deja.has(c.engagement_id))
          .filter(c => !c.canal_voulu || c.canal_voulu === p_canal)
          .map(c => ({ ...c, canal: p_canal })));
      }
      return repJSON(null);
    }

    const table = segments;
    if(table === 'v_export_suivi'){
      return repJSON((BASE.engagements || []).filter(e => !e.est_test));
    }
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

    // GET — on reproduit les opérateurs PostgREST réellement utilisés
    const q = u.searchParams;
    let resultat = lignes.slice();
    for(const [k, v] of q){
      if(k === 'select' || k === 'limit' || k === 'order') continue;
      const brut = String(v);
      if(brut.startsWith('eq.')){
        const val = brut.slice(3);
        resultat = resultat.filter(l => String(l[k]) === val);
      } else if(brut.startsWith('ilike.')){
        const val = brut.slice(6).toLowerCase();
        resultat = resultat.filter(l => String(l[k] ?? '').toLowerCase() === val);
      } else if(brut.startsWith('is.')){
        const val = brut.slice(3);
        const attendu = val === 'true' ? true : val === 'false' ? false : null;
        resultat = resultat.filter(l => (l[k] ?? null) === attendu
          || (attendu === false && !l[k]) || (attendu === true && Boolean(l[k])));
      } else if(brut.startsWith('gte.')){
        const val = brut.slice(4);
        resultat = resultat.filter(l => String(l[k] ?? '') >= val);
      } else if(brut.startsWith('lt.')){
        const val = brut.slice(3);
        resultat = resultat.filter(l => Number(l[k]) < Number(val));
      } else {
        resultat = resultat.filter(l => String(l[k]) === brut);
      }
    }
    const limite = Number(q.get('limit'));
    return repJSON(Number.isFinite(limite) && limite > 0 ? resultat.slice(0, limite) : resultat);
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

  // une personne qui n'a choisi que WhatsApp ne doit rien recevoir par e-mail
  reinitialiser();
  BASE.parametres_rappels = [{ id:1, actifs:true, jour_du_mois:'dernier', heure_locale:18,
    fuseau:'Europe/Paris', canal_email:true, canal_whatsapp:true, canal_sms:false, mode_test:false,
    destinataires_test:[], instructions_reglement:'x', contact_difficulte:'y' }];
  BASE.engagements_a_rappeler = [{ engagement_id:'id-w', reference:'R', prenom:'P', nom:'N',
    email:null, telephone:'0600000000', canal_voulu:'whatsapp',
    montant_mensuel_declare:25, jeton_prive:'j' }];
  r = await executerRappels(req('?forcer=1')); c = await r.json();
  verifier('un abonné WhatsApp ne reçoit aucun e-mail', c.envoyes === 0 && APPELS.mails.length === 0);
}

/* ------------------------------------------------------------------ */
serie('RELANCE WHATSAPP');
{
  const { versInternational, lienWhatsApp } = await import('../netlify/functions/lib/telephone.mjs');
  verifier('numéro français converti', versInternational('06 76 55 10 98').e164 === '33676551098');
  verifier('numéro sénégalais converti', versInternational('+221 71 012 49 30').e164 === '221710124930');
  verifier('numéro fixe signalé comme douteux', versInternational('01 42 00 00 00').certain === false);
  verifier('format inconnu signalé', versInternational('12345').certain === false);
  verifier('numéro vide refusé', versInternational('').e164 === null);
  const l = lienWhatsApp('0676551098', 'Bonjour Aminata, référence ZAWIYA-2026-ABCDEF');
  verifier('lien wa.me bien formé', l.url.startsWith('https://wa.me/33676551098?text='));
  verifier('message encodé dans le lien', decodeURIComponent(l.url.split('text=')[1]).includes('ZAWIYA-2026-ABCDEF'));

  process.env.SECRET_ADMIN = 'admin-de-test';
  const { default: relance } = await import('../netlify/functions/relance-whatsapp.mjs');
  reinitialiser();
  BASE.parametres_rappels = [{ id:1, actifs:true, canal_whatsapp:true,
    instructions_reglement:'Virement IBAN FR76...', contact_difficulte:'contact@exemple.test' }];
  BASE.engagements_a_rappeler = [];
  BASE.rappels = [];

  let r = await relance(new Request('https://site.test/api/relance-whatsapp'));
  verifier('page refusée sans la clé', r.status === 403);

  BASE.engagements_a_rappeler = [{ engagement_id:'id-1', reference:'ZAWIYA-2026-QQQQQQ',
    prenom:'Fatou', nom:'DIOP', email:null, telephone:'06 11 22 33 44',
    montant_mensuel_declare:50, jeton_prive:'jeton-x' }];
  r = await relance(new Request('https://site.test/api/relance-whatsapp?cle=admin-de-test'));
  const html = await r.text();
  verifier('page servie avec la clé', r.status === 200);
  verifier('la personne est listée', html.includes('Fatou') && html.includes('ZAWIYA-2026-QQQQQQ'));
  verifier('un lien WhatsApp est proposé', html.includes('https://wa.me/33611223344'));
  verifier('aucun message n\'a été envoyé automatiquement', APPELS.mails.length === 0);
  verifier('la page ne parle ni de retard ni d\'impayé', !/retard|impay/i.test(html));
  verifier('la page est exclue des moteurs de recherche', /noindex/.test(html));

  // marquage : la personne doit sortir de la liste
  r = await relance(new Request('https://site.test/api/relance-whatsapp?cle=admin-de-test&marquer=id-1'));
  verifier('le marquage redirige', r.status === 303);
  verifier('le rappel est journalisé',
    BASE.rappels.length === 1 && BASE.rappels[0].canal === 'whatsapp' && BASE.rappels[0].statut === 'envoye');

  r = await relance(new Request('https://site.test/api/relance-whatsapp?cle=admin-de-test'));
  const html2 = await r.text();
  verifier('la personne a disparu de la liste', !html2.includes('ZAWIYA-2026-QQQQQQ'));
}

/* ------------------------------------------------------------------ */
serie('CSV — format et sécurité');
{
  const { fabriquerCSV, nomFichierCSV, neutraliser, totauxParDevise, montant } =
    await import('../netlify/functions/lib/csv.mjs');

  const lignes = [
    { reference:'ZAWIYA-2026-AAA111', recu_le:'2026-10-25T14:30:00Z', prenom:'Aminata',
      nom:'NDIAYE', email:'a@exemple.test', telephone:'+33 6 11 22 33 44',
      code_postal:'93100', ville:'Montreuil', departement:'93', zone:'Île-de-France',
      dahira:'Nasrul Ilm', forfait:'argent', montant_mensuel_declare:50, devise:'EUR',
      periodicite:'mensuelle', duree_mois:24, total_previsionnel:1200,
      preference_reglement:'Virement mensuel', statut:'Nouveau',
      debut_engagement:'2026-10-01', fin_engagement:'2028-10-01',
      rappel_email:true, rappel_whatsapp:false, consentement_le:'2026-10-25T14:30:00Z',
      message:'Qu\'Allah facilite' },
    { reference:'ZAWIYA-2026-BBB222', recu_le:'2026-10-25T15:00:00Z', prenom:'Ibrahima',
      nom:'DIOP', email:'b@exemple.test', telephone:'+221 77 123 45 67',
      code_postal:null, ville:'Dakar', departement:null, zone:'Hors de France',
      dahira:null, forfait:'libre', montant_mensuel_declare:25000, devise:'XOF',
      periodicite:'mensuelle', duree_mois:24, total_previsionnel:600000,
      preference_reglement:null, statut:'Nouveau',
      debut_engagement:'2026-10-01', fin_engagement:'2028-10-01',
      rappel_email:false, rappel_whatsapp:true, consentement_le:'2026-10-25T15:00:00Z',
      message:null },
  ];

  const csv = fabriquerCSV(lignes);
  const rangs = csv.split('\r\n');

  verifier('le fichier commence par le BOM', csv.charCodeAt(0) === 0xFEFF);
  verifier('le séparateur est le point-virgule', rangs[0].includes('";"') || rangs[0].split(';').length > 20);
  verifier('les en-têtes sont en français',
    rangs[0].includes('"Référence"') && rangs[0].includes('"Montant déclaré"') && rangs[0].includes('"Devise"'));
  verifier('la périodicité est une colonne', rangs[0].includes('"Périodicité"'));
  verifier('une ligne par engagement', rangs.filter(r => r.trim()).length === 3, `${rangs.filter(r=>r.trim()).length} lignes`);
  verifier('les accents sont intacts', csv.includes('Île-de-France') && csv.includes('Référence'));
  verifier('les montants ont la virgule décimale', rangs[1].includes(';50,00;'));
  verifier('les dates sont au format français', /;25\/10\/2026 \d{2}:\d{2};/.test(rangs[1]));
  verifier('les devises sont lisibles', rangs[1].includes('"EUR"') && rangs[2].includes('"FCFA"'));
  verifier('les booléens sont en français', rangs[1].includes('"Oui"') && rangs[1].includes('"Non"'));

  // injection de formule
  const piege = [{ ...lignes[0],
    prenom:'=HYPERLINK("http://mechant.test","cliquez")',
    nom:'+1+1', ville:'-2+3', message:'@SUM(A1:A9)', dahira:'\tonglet' }];
  const csvPiege = fabriquerCSV(piege);
  verifier('formule « = » neutralisée', csvPiege.includes('"\'=HYPERLINK'));
  verifier('formule « + » neutralisée', csvPiege.includes('"\'+1+1"'));
  verifier('formule « - » neutralisée', csvPiege.includes('"\'-2+3"'));
  verifier('formule « @ » neutralisée', csvPiege.includes('"\'@SUM'));
  verifier('tabulation neutralisée', csvPiege.includes('"\'') && neutraliser('\tx').startsWith("'"));
  verifier('aucune cellule ne commence par un caractère de formule',
    csvPiege.split('\r\n').slice(1).every(r =>
      r.split(';').every(c => !/^["']?[=+\-@]/.test(c.replace(/^"/, '')) || c.startsWith('"\''))));
  verifier('les guillemets internes sont doublés',
    fabriquerCSV([{ ...lignes[0], ville:'Saint-"Denis"' }]).includes('Saint-""Denis""'));
  verifier('les retours à la ligne ne cassent pas le fichier',
    fabriquerCSV([{ ...lignes[0], message:'ligne 1\nligne 2' }]).split('\r\n').filter(r => r.trim()).length === 2);

  verifier('le nom du fichier est daté',
    /^engagements-zawiya-\d{4}-\d{2}-\d{2}\.csv$/.test(nomFichierCSV(new Date('2026-10-25T12:00:00Z'))),
    nomFichierCSV(new Date('2026-10-25T12:00:00Z')));

  // totaux par devise
  const t = totauxParDevise(lignes);
  verifier('les devises sont séparées', t.length === 2);
  verifier('les euros ne sont pas mélangés aux FCFA',
    t.find(x => x.devise === 'EUR').mensuel === 50 && t.find(x => x.devise === 'XOF').mensuel === 25000);
  verifier('le prévisionnel sur 24 mois est juste',
    t.find(x => x.devise === 'EUR').horizon24 === 1200);
  verifier('la périodicité est remontée',
    t.every(x => x.periodicites.includes('mensuelle')));
  verifier('le formatage respecte la devise',
    montant(50, 'EUR').includes('€') && montant(25000, 'XOF').includes('FCFA'));
}

/* ------------------------------------------------------------------ */
serie('DESTINATAIRES INTERNES — plusieurs adresses, un seul envoi');
{
  const { destinatairesAssociation } = await import('../netlify/functions/lib/commun.mjs');
  const lire = (v) => { process.env.EMAIL_ASSOCIATION = v; return destinatairesAssociation(); };
  const garde = process.env.EMAIL_ASSOCIATION;

  verifier('une seule adresse reste acceptée',
    lire('bureau@exemple.test').join('|') === 'bureau@exemple.test');
  verifier('la virgule sépare les adresses',
    lire('a@x.test,b@x.test').join('|') === 'a@x.test|b@x.test');
  verifier('le point-virgule, l\'espace et le retour à la ligne aussi',
    lire('a@x.test; b@x.test\nc@x.test d@x.test').join('|') === 'a@x.test|b@x.test|c@x.test|d@x.test');
  verifier('l\'ordre de la variable est conservé',
    lire('second@x.test,premier@x.test')[0] === 'second@x.test');
  verifier('un doublon exact est retiré',
    lire('a@x.test, a@x.test').length === 1);
  verifier('un doublon de casse est retiré',
    lire('Bureau@X.test, bureau@x.TEST').length === 1);
  verifier('une adresse mal formée est ignorée',
    lire('a@x.test, pas-une-adresse, b@x.test').join('|') === 'a@x.test|b@x.test');
  verifier('une variable vide ne donne aucun destinataire', lire('').length === 0);
  verifier('les espaces superflus sont retirés',
    lire('  a@x.test ,  b@x.test  ').join('|') === 'a@x.test|b@x.test');

  process.env.EMAIL_ASSOCIATION = garde;
  reinitialiser();
  const r = await engagement(requete(engagementValide({ email:'duo@exemple.test' })));
  verifier('engagement enregistré', r.status === 200);

  const assoc = APPELS.mails.filter(
    (m) => m.to.some((d) => d.email === 'bureau@exemple.test'));
  verifier('le bureau ne reçoit qu\'UN message', assoc.length === 1,
    `${assoc.length} message(s)`);
  verifier('ce message porte les deux adresses',
    assoc[0].to.length === 2
    && assoc[0].to.map((d) => d.email).join('|') === 'bureau@exemple.test|second@exemple.test',
    assoc[0].to.map((d) => d.email).join(', '));
  verifier('la seconde adresse reçoit la notification du nouvel adhérent',
    /Ndiaye|Aminata/.test(assoc[0].htmlContent));
  verifier('elle reçoit le récapitulatif à date',
    /Tous les engagements enregistrés/.test(assoc[0].htmlContent)
    && /Arrêté au /.test(assoc[0].htmlContent));
  verifier('elle reçoit le CSV, joint une seule fois',
    Array.isArray(assoc[0].attachment) && assoc[0].attachment.length === 1);
  verifier('au total, deux messages seulement : le bureau et l\'adhérent',
    APPELS.mails.length === 2, APPELS.mails.length + ' message(s)');
  verifier('l\'e-mail de l\'adhérent ne part qu\'à lui',
    APPELS.mails.find((m) => m.to[0].email === 'duo@exemple.test').to.length === 1);
  verifier('le journal garde la trace des deux destinataires',
    BASE.journal_notifications.some(
      (j) => j.destinataire === 'bureau@exemple.test, second@exemple.test'));
  verifier('l\'expéditeur est inchangé',
    assoc[0].sender.email === process.env.MAIL_EXPEDITEUR);
}

/* ------------------------------------------------------------------ */
serie('E-MAIL À L\'ASSOCIATION — pièce jointe et cloisonnement');
{
  reinitialiser();
  const r = await engagement(requete(engagementValide({ email:'nouvelle@exemple.test' })));
  verifier('engagement enregistré', r.status === 200);

  const pourAssoc = APPELS.mails.find(m => m.to[0].email === 'bureau@exemple.test');
  const pourParticipant = APPELS.mails.find(m => m.to[0].email === 'nouvelle@exemple.test');

  verifier('le bureau reçoit une pièce jointe',
    Array.isArray(pourAssoc.attachment) && pourAssoc.attachment.length === 1);
  verifier('la pièce jointe est un CSV daté',
    /^engagements-zawiya-\d{4}-\d{2}-\d{2}\.csv$/.test(pourAssoc.attachment[0].name),
    pourAssoc.attachment[0].name);

  const contenu = Buffer.from(pourAssoc.attachment[0].content, 'base64').toString('utf8');
  verifier('la pièce jointe contient le BOM', contenu.charCodeAt(0) === 0xFEFF);
  verifier('la pièce jointe contient le nouvel engagement', contenu.includes('Ndiaye') || contenu.includes('Aminata'));
  verifier('le récapitulatif figure dans le message',
    /Tous les engagements enregistrés/.test(pourAssoc.htmlContent));
  verifier('le récapitulatif est horodaté', /Arrêté au /.test(pourAssoc.htmlContent));
  verifier('le récapitulatif précise la périodicité', /périodicité mensuelle/.test(pourAssoc.htmlContent));
  verifier('plus aucun lien « tableau de suivi »',
    !/tableau de suivi/i.test(pourAssoc.htmlContent) && !/github/i.test(pourAssoc.htmlContent));

  verifier('le participant ne reçoit AUCUNE pièce jointe',
    !pourParticipant.attachment || pourParticipant.attachment.length === 0);
  verifier('le participant ne voit que ses informations',
    !/Tous les engagements/.test(pourParticipant.htmlContent));
  verifier('le participant ne voit aucune autre référence',
    (pourParticipant.htmlContent.match(/ZAWIYA-\d{4}-[A-Z0-9]{6}/g) || [])
      .every((v, _, t) => v === t[0]));

  // les lignes de test ne doivent jamais entrer dans l'export réel
  reinitialiser();
  BASE.engagements.push({ id:'t1', reference:'TEST-X', prenom:'Faux', nom:'TEST',
    email:'faux@exemple.test', est_test:true, montant_mensuel_declare:999,
    devise:'EUR', duree_mois:24, total_previsionnel:23976, forfait:'gold' });
  await engagement(requete(engagementValide({ email:'reel@exemple.test' })));
  const assoc2 = APPELS.mails.find(m => m.to[0].email === 'bureau@exemple.test');
  const csv2 = Buffer.from(assoc2.attachment[0].content, 'base64').toString('utf8');
  verifier('les engagements de test sont exclus du CSV', !csv2.includes('TEST-X'));
  verifier('les engagements de test sont exclus du récapitulatif',
    !assoc2.htmlContent.includes('23 976') && !assoc2.htmlContent.includes('999'));
}

/* ------------------------------------------------------------------ */
serie('GÉOCODAGE');
{
  reinitialiser();
  const { geocoder } = await import('../netlify/functions/lib/geocodage.mjs');
  const p1 = await geocoder({ adresse:'12 rue de Paris', code_postal:'93100', ville:'Montreuil' });
  verifier('adresse géocodée', p1 && p1.latitude === 48.861 && p1.longitude === 2.441);
  verifier('la requête contient rue et ville', APPELS.geocodages[0].includes('Montreuil'));

  APPELS.geocodageEnPanne = true;
  const p2 = await geocoder({ adresse:'x', code_postal:'75001', ville:'Paris' });
  verifier('une panne du service ne lève pas d\'erreur', p2 === null);
  APPELS.geocodageEnPanne = false;

  const p3 = await geocoder({});
  verifier('une adresse vide ne déclenche aucun appel', p3 === null);

  // à la création d'une fiche
  reinitialiser();
  await dahira(requete({
    nom:'Dahira Geo', ville:'Montreuil', code_postal:'93100', lieu_activites:'12 rue de Paris',
    responsable_nom:'R', responsable_email:'r@exemple.test',
    consentement_publication:true, cle_idempotence:'g1', duree_saisie_ms:9000,
  }, 'https://site.test/api/dahira'));
  verifier('une nouvelle fiche est positionnée sur la carte',
    BASE.dahiras[0].latitude === 48.861 && BASE.dahiras[0].longitude === 2.441);
}

/* ------------------------------------------------------------------ */
serie('MODIFICATION D\'UNE FICHE DAHIRA');
{
  const { createHash } = await import('node:crypto');
  const { default: modif } = await import('../netlify/functions/dahira-modification.mjs');
  const condenser = (j) => createHash('sha256').update(String(j)).digest('hex');
  const poster = (corps) => new Request('https://site.test/api/dahira-modification', {
    method:'POST', headers:{ 'Content-Type':'application/json', 'x-nf-client-connection-ip':'203.0.113.9' },
    body: JSON.stringify(corps),
  });

  function ficheDeBase(){
    reinitialiser();
    BASE.dahiras.push({
      id:'d-1', reference:'DAHIRA-2026-AAA111', nom:'Dahira Nasrul Ilm', ville:'Montreuil',
      code_postal:'93100', lieu_activites:'12 rue de Paris', responsable_nom:'Moussa',
      responsable_email:'resp@exemple.test', responsable_telephone:'0600000000',
      contact_public_telephone:'0611111111', contact_public_autorise:true,
      statut:'Publiée', est_test:false, latitude:48.86, longitude:2.44,
    });
  }

  // --- une adresse qui ne correspond pas ne déclenche aucun envoi ---
  ficheDeBase();
  let r = await modif(poster({ action:'demander', voie:'par_email',
    nom:'Dahira Nasrul Ilm', ville:'Montreuil', email:'pirate@exemple.test', duree_saisie_ms:9000 }));
  let c = await r.json();
  verifier('mauvaise adresse : aucun lien envoyé', APPELS.mails.length === 0);
  verifier('mauvaise adresse : aucune demande créée', (BASE.dahiras_modifications || []).length === 0);
  verifier('la réponse ne révèle rien', c.ok === true && /Si cette Dahira est référencée/.test(c.message));

  // --- la bonne adresse reçoit le lien ---
  ficheDeBase();
  r = await modif(poster({ action:'demander', voie:'par_email',
    nom:'Dahira Nasrul Ilm', ville:'Montreuil', email:'resp@exemple.test', duree_saisie_ms:9000 }));
  c = await r.json();
  verifier('bonne adresse : un lien part', APPELS.mails.length === 1);
  verifier('le lien va à l\'adresse enregistrée', APPELS.mails[0].to[0].email === 'resp@exemple.test');
  verifier('la réponse reste identique', /Si cette Dahira est référencée/.test(c.message));

  const lien = APPELS.mails[0].textContent.match(/\?t=([a-f0-9]+)/);
  verifier('le message contient un jeton', Boolean(lien), lien ? lien[1].slice(0,12) + '…' : '');
  const jeton = lien[1];
  const demande = BASE.dahiras_modifications[0];
  verifier('le jeton n\'est pas stocké en clair',
    !JSON.stringify(demande).includes(jeton) && demande.jeton_hash === condenser(jeton));
  verifier('le jeton a une date d\'expiration', Boolean(demande.jeton_expire_le));
  verifier('la fiche publiée n\'a pas bougé',
    BASE.dahiras[0].ville === 'Montreuil' && BASE.dahiras[0].responsable_email === 'resp@exemple.test');

  // --- le formulaire s'ouvre avec le bon jeton, pas avec un faux ---
  r = await modif(new Request('https://site.test/api/dahira-modification?t=' + jeton));
  const page = await r.text();
  verifier('le formulaire s\'ouvre avec le jeton', r.status === 200 && page.includes('Dahira Nasrul Ilm'));
  verifier('le formulaire est pré-rempli', page.includes('value="12 rue de Paris"'));
  verifier('la page est exclue des moteurs', /noindex/.test(page));
  r = await modif(new Request('https://site.test/api/dahira-modification?t=' + 'f'.repeat(48)));
  verifier('un faux jeton est rejeté', r.status === 400);

  // --- soumission sans changement d'adresse e-mail ---
  r = await modif(poster({ action:'soumettre', jeton,
    lieu_activites:'45 avenue de la République', code_postal:'93170', ville:'Bagnolet',
    responsable_telephone:'0600000000', contact_public_telephone:'0622222222',
    contact_public_autorise:true, nouvel_email:'' }));
  c = await r.json();
  verifier('la demande est acceptée', r.status === 200 && c.ok);
  const d2 = BASE.dahiras_modifications[0];
  verifier('seuls les champs modifiés sont enregistrés',
    d2.n_ville === 'Bagnolet' && d2.n_code_postal === '93170' && d2.n_responsable_telephone === null);
  verifier('la nouvelle position est calculée', d2.n_latitude === 48.861);
  verifier('le statut passe à « à valider »', d2.statut === 'a_valider');
  verifier('le jeton est neutralisé', d2.jeton_hash === null && d2.jeton_utilise === true);
  verifier('la fiche publiée reste inchangée',
    BASE.dahiras[0].ville === 'Montreuil' && BASE.dahiras[0].code_postal === '93100');
  verifier('le bureau est prévenu',
    APPELS.mails.some(m => m.to[0].email === 'bureau@exemple.test' && /valider/i.test(m.subject)));

  // --- le lien ne resert pas ---
  r = await modif(poster({ action:'soumettre', jeton, ville:'Pantin' }));
  verifier('le lien ne peut pas resservir', r.status === 410);

  // --- changement d'adresse e-mail ---
  ficheDeBase();
  await modif(poster({ action:'demander', voie:'par_email',
    nom:'Dahira Nasrul Ilm', ville:'Montreuil', email:'resp@exemple.test', duree_saisie_ms:9000 }));
  const jeton2 = APPELS.mails[0].textContent.match(/\?t=([a-f0-9]+)/)[1];
  APPELS.mails.length = 0;
  r = await modif(poster({ action:'soumettre', jeton: jeton2,
    ville:'Montreuil', nouvel_email:'nouveau@exemple.test' }));
  c = await r.json();
  verifier('un changement d\'adresse est accepté', r.status === 200 && c.ok);
  const d3 = BASE.dahiras_modifications[0];
  verifier('le statut attend la confirmation', d3.statut === 'email_a_verifier');
  verifier('l\'adresse n\'est pas encore confirmée', d3.email_verifie === false);
  verifier('un message part vers la NOUVELLE adresse',
    APPELS.mails.some(m => m.to[0].email === 'nouveau@exemple.test'));
  verifier('le jeton de confirmation n\'est pas stocké en clair', (() => {
    const m = APPELS.mails.find(x => x.to[0].email === 'nouveau@exemple.test');
    const j = m.textContent.match(/\?v=([a-f0-9]+)/)[1];
    return d3.jeton_email_hash === condenser(j) && !JSON.stringify(d3).includes(j);
  })());

  const jetonMail = APPELS.mails.find(m => m.to[0].email === 'nouveau@exemple.test')
    .textContent.match(/\?v=([a-f0-9]+)/)[1];
  r = await modif(new Request('https://site.test/api/dahira-modification?v=' + jetonMail));
  const pageConf = await r.text();
  verifier('la confirmation aboutit', r.status === 200 && /confirmée/i.test(pageConf));
  verifier('l\'adresse est marquée confirmée', BASE.dahiras_modifications[0].email_verifie === true);
  verifier('le statut passe à « à valider »', BASE.dahiras_modifications[0].statut === 'a_valider');
  verifier('la fiche publiée garde encore l\'ancienne adresse',
    BASE.dahiras[0].responsable_email === 'resp@exemple.test');
  r = await modif(new Request('https://site.test/api/dahira-modification?v=' + jetonMail));
  verifier('le lien de confirmation ne resert pas', r.status === 400);

  // --- voie « sans accès à l'e-mail » ---
  ficheDeBase();
  r = await modif(poster({ action:'demander', voie:'sans_acces_email',
    nom:'Dahira Nasrul Ilm', ville:'Montreuil',
    email_contact:'autre@exemple.test', telephone_contact:'0700000000',
    explication:'Je suis le nouveau responsable', duree_saisie_ms:9000 }));
  c = await r.json();
  verifier('la demande manuelle est acceptée', r.status === 200 && c.ok);
  verifier('aucun lien automatique n\'est envoyé',
    !APPELS.mails.some(m => /\?t=[a-f0-9]+/.test(m.textContent || '')));
  verifier('le bureau est alerté de vérifier l\'identité',
    APPELS.mails.some(m => m.to[0].email === 'bureau@exemple.test'
      && /Vérifiez son identité/i.test(m.htmlContent)));
  verifier('la demande est tracée pour l\'historique',
    BASE.dahiras_modifications[0].origine === 'validation_manuelle');

  // --- robots et champs manquants ---
  ficheDeBase();
  r = await modif(poster({ action:'demander', voie:'par_email', nom:'x', ville:'y',
    email:'resp@exemple.test', site_web:'http://spam.test', duree_saisie_ms:9000 }));
  verifier('le piège anti-robot répond sans rien faire',
    (await r.json()).ignore === true && APPELS.mails.length === 0);
  r = await modif(poster({ action:'demander', voie:'par_email', duree_saisie_ms:9000 }));
  c = await r.json();
  verifier('les champs obligatoires sont exigés', r.status === 422 && c.fautes.nom && c.fautes.ville);
}

/* ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(60));
console.log(`${reussis} / ${total} contrôles réussis`);
process.exit(reussis === total ? 0 : 1);
