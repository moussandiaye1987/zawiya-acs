/**
 * Banc d'essai de la page publique.
 *
 * Charge index.html dans un navigateur simulé (jsdom), avec une réponse
 * d'API factice, et vérifie la structure, le vocabulaire, les calculs,
 * les formulaires et l'accessibilité.
 *
 *   npm run verifier:page
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';

const erreurs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => erreurs.push('jsdomError: ' + e.message));
vc.on('error', (...a) => erreurs.push('console.error: ' + a.join(' ')));

const racine = new URL('..', import.meta.url).pathname;
const html = fs.readFileSync(racine + 'public/index.html', 'utf8');
let appelsAPI = [];
let DONNEES;
const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true,
  url:'https://site.test/', virtualConsole: vc,
  beforeParse(win){
    win.fetch = async (url) => {
      appelsAPI.push(String(url));
      return { ok:true, status:200, json: async () => DONNEES,
               headers:{ get: () => 'application/json' } };
    };
  } });
const w = dom.window;

// réponse simulée de /api/donnees-publiques
DONNEES = {
  statut_donnees:'disponible', objectif_euros:2000000, horizon_mois:24,
  collecte_demarree:true, engagements_enregistres:212,
  mensuel_declare_total:14250, previsionnel_horizon_24:342000,
  previsionnel_toutes_durees:361000, dernier_enregistrement:'2026-10-20T10:00:00Z',
  par_forfait:{ gold:62, argent:96, bronze:41, libre:13 },
  par_zone:{ 'Île-de-France':70, 'Sud':38, 'Auvergne-Rhône-Alpes':27,
             'Grand-Est':30, 'Loire':21, 'Nord':26 },
  par_departement:{ '93':22, '95':18 }, par_duree:{ '24':180, '12':20, '36':12 },
  versements_recus_euros:null, versements_arretes_au:null,
  dahiras:[{ reference:'D-1', nom:'Dahira Nasrul Ilm', guide:'Moukhadam Diop',
    zone:'Île-de-France', ville:'Montreuil', code_postal:'93100',
    khadara_vendredi:true, wazifa_quotidienne:false, effectif:40,
    latitude:48.861, longitude:2.441, telephone_public:'06 00 00 00 00', contact_public_autorise:true }],
  genere_le:'2026-10-25T08:00:00Z',
};

setTimeout(() => {
  const d = w.document;
  let total = 0, ok = 0;
  const v = (nom, cond, info='') => { total++; if(cond){ ok++; console.log('  ok     ' + nom + (info?' — '+info:'')); }
    else console.log('  ÉCHEC  ' + nom + (info?' — '+info:'')); };

  console.log('Erreurs JavaScript : ' + erreurs.length);
  erreurs.slice(0,5).forEach(e => console.log('    ' + e.slice(0,200)));

  console.log('\nSTRUCTURE ET NAVIGATION');
  const ordre = [...d.querySelectorAll('main section[id]')].map(s => s.id);
  v('ordre des sections conforme',
    JSON.stringify(ordre) === JSON.stringify(['projet','adherer','dahiras','transparence','historique','contact']),
    ordre.join(' → '));
  const acces = [...d.querySelectorAll('.acces a')].map(a => a.textContent.trim());
  v('trois accès en haut', acces.length === 3, acces.join(' · '));
  v('« Adhérer » est le bouton principal',
    d.querySelector('.acces a.primaire').getAttribute('href') === '#adherer');
  const ancres = [...d.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)).filter(Boolean);
  const cassees = [...new Set(ancres)].filter(a => a !== 'haut' && !d.getElementById(a));
  v('aucune ancre cassée', cassees.length === 0, cassees.join(', '));
  v('menu mobile complet', d.querySelectorAll('#menuMobile a').length === 7);

  console.log('\nVOCABULAIRE SANS ENCAISSEMENT');
  const texte = d.body.textContent;
  v('la mention obligatoire est présente',
    /Ce formulaire enregistre votre engagement de contribution\. Aucun paiement ni prélèvement n'est effectué sur ce site\. L'association vous communiquera les modalités de règlement\./.test(texte.replace(/\s+/g,' ')));
  v('mention affichée près du formulaire ET dans la confirmation',
    d.querySelectorAll('#adherer .mention-paiement').length >= 2);
  ['collecté','Collecté','sécurisé','sécurisée','encaissé par le site','somme collectée'].forEach(mot => {
    v('vocabulaire interdit absent : « ' + mot + ' »', !texte.includes(mot));
  });
  v('« engagements enregistrés » employé', /engagements? enregistré/i.test(texte));
  v('« montant mensuel déclaré » employé', /montant mensuel déclaré/i.test(texte));
  v('le moyen de règlement est présenté comme une préférence',
    /Simple préférence\. Rien n'est mis en place/.test(texte));
  v('aucun champ bancaire dans les formulaires',
    [...d.querySelectorAll('form input')].every(i => !/iban|bic|carte|rib/i.test(i.id + i.name)));

  console.log('\nCOHÉRENCE DU FINANCEMENT');
  const piedEq = d.getElementById('piedEquation').textContent.replace(/ | /g,' ');
  v('le tableau totalise 1 000 pièces', piedEq.includes('1 000'), piedEq.trim().replace(/\s+/g,' '));
  const parMois = Number((piedEq.match(/([\d ]+) €/) || [,'0'])[1].replace(/\s/g,''));
  v('le total mensuel couvre la cible de 83 333 €', parMois >= 83333, parMois.toLocaleString('fr-FR') + ' €');
  const sur24 = Number((piedEq.match(/([\d ]+) €\s*$/) || [,'0'])[1].replace(/\s/g,''));
  v('le total sur 24 mois couvre les 2 000 000 €', sur24 >= 2000000, sur24.toLocaleString('fr-FR') + ' €');
  v('simulateur pré-rempli depuis la même configuration',
    d.getElementById('simGold').value === '300' && d.getElementById('simArgent').value === '300'
    && d.getElementById('simBronze').value === '156' && d.getElementById('simLibreN').value === '244');
  v('le simulateur conclut que l’objectif est tenu',
    /objectif est tenu/.test(d.getElementById('simVerdict').textContent));
  v('explication « 1 000 engagements ne suffisent pas »',
    /ne font pas automatiquement deux millions/.test(texte));
  v('durées 12 / 24 / 36 proposées', d.querySelectorAll('#duree option').length === 3);

  console.log('\nTABLEAU DE BORD');
  v('engagements enregistrés affichés',
    d.querySelector('#kpiEngagements b').textContent === '212',
    d.querySelector('#kpiEngagements b').textContent);
  const normal = t => t.replace(/[\u202f\u00a0]/g, ' ');
  v('montant mensuel déclaré affiché',
    normal(d.querySelector('#kpiMensuel b').textContent).includes('14 250'),
    d.querySelector('#kpiMensuel b').textContent);
  v('versements non consolidés : pas de zéro trompeur',
    d.querySelector('#kpiVersements b').textContent === 'Données en cours de consolidation');
  v('date de dernière actualisation affichée', /actualisée le/.test(d.getElementById('majDonnees').textContent));
  v('la jauge précise qu’elle mesure du déclaré',
    /pas des sommes encaissées/.test(texte));

  console.log('\nPUZZLE ET CARTES');
  v('puzzle alimenté par les données', d.getElementById('puzzleCompte').textContent === '212');
  v('pièces posées tracées', d.getElementById('pose-gold').getAttribute('d').length > 500);
  v('pièces restantes tracées', d.getElementById('voile-argent').getAttribute('d').length > 500);
  v('légende du puzzle complète', d.getElementById('puzzleLegende').children.length === 4);
  v('carte des zones colorée', d.querySelector('#regionsZones .region').style.fill.length > 0);
  v('13 régions tracées', d.querySelectorAll('#regionsZones .region').length === 13);
  v('légende des zones complète', d.getElementById('legendeZones').children.length === 6);
  v('carte des Dahiras clonée', d.getElementById('regionsDahiras').children.length === 13);
  v('marqueur de Dahira placé', d.querySelectorAll('#marqueurs .marqueur').length === 1);

  console.log('\nANNUAIRE');
  v('fiche affichée', d.querySelectorAll('.dahira-carte').length === 1);
  v('téléphone public affiché car autorisé', /06 00 00 00 00/.test(d.getElementById('listeDahiras').textContent));
  v('filtre par zone fonctionne', (() => {
    const s = d.getElementById('fZone'); s.value = 'Nord';
    s.dispatchEvent(new w.Event('input', { bubbles:true }));
    const n = d.querySelectorAll('.dahira-carte').length;
    s.value = ''; s.dispatchEvent(new w.Event('input', { bubbles:true }));
    return n === 0;
  })());

  console.log('\nFORMULAIRES');
  const fe = d.getElementById('formEngagement');
  fe.dispatchEvent(new w.Event('submit', { bubbles:true, cancelable:true }));
  const errPrenom = fe.querySelector('.erreur[data-pour="prenom"]');
  v('validation navigateur : prénom signalé', errPrenom && !errPrenom.hidden, errPrenom?.textContent);
  v('champ marqué invalide pour les lecteurs d’écran',
    d.getElementById('prenom').getAttribute('aria-invalid') === 'true');
  v('total prévisionnel calculé par défaut',
    d.getElementById('totalAffiche').textContent.replace(/ | /g,' ') === '1 200 €',
    d.getElementById('totalAffiche').textContent);
  v('piège anti-robot présent et masqué',
    d.getElementById('site_web') && d.querySelector('.piege'));
  v('consentement non coché par défaut', d.getElementById('consentement').checked === false);
  v('rappel e-mail proposé et coché par défaut',
    d.getElementById('rappelEmail') && d.getElementById('rappelEmail').checked === true);
  v('rappel WhatsApp proposé, décoché par défaut',
    d.getElementById('rappelWhatsapp') && d.getElementById('rappelWhatsapp').checked === false);
  v('WhatsApp sans numéro : l\'utilisateur est averti', (() => {
    const wa = d.getElementById('rappelWhatsapp');
    wa.checked = true;
    wa.dispatchEvent(new w.Event('change', { bubbles:true }));
    const txt = d.getElementById('aideRappel').textContent;
    wa.checked = false; wa.dispatchEvent(new w.Event('change', { bubbles:true }));
    return /numéro de téléphone/.test(txt);
  })());
  v('aucune mention de SMS sur le site', !/\bSMS\b/.test(texte));
  v('formulaire Dahira présent', Boolean(d.getElementById('formDahira')));
  v('consentement de publication non coché par défaut',
    d.getElementById('dConsentement').checked === false);
  v('aucune adresse postale complète demandée',
    !d.querySelector('#formEngagement input[autocomplete="street-address"]'));

  console.log('\nACCESSIBILITÉ ET MOBILE');
  v('langue déclarée', d.documentElement.lang === 'fr');
  v('viewport présent', Boolean(d.querySelector('meta[name=viewport]')));
  v('toutes les images ont un texte alternatif',
    [...d.querySelectorAll('img')].every(i => i.hasAttribute('alt')));
  v('tous les champs ont une étiquette',
    [...d.querySelectorAll('input:not([type=radio]):not([type=checkbox]), select, textarea')]
      .every(i => !i.id || d.querySelector('label[for="' + i.id + '"]')));
  v('tableaux dans une zone de défilement',
    [...d.querySelectorAll('table')].every(t => t.closest('.scroll-x')));
  v('lien vers la confidentialité', Boolean(d.querySelector('a[href="confidentialite.html"]')));

  console.log('\n' + '─'.repeat(60));
  console.log(ok + ' / ' + total + ' contrôles réussis');
  process.exit(ok === total && erreurs.length === 0 ? 0 : 1);
}, 2500);
