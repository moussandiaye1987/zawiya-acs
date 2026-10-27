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

// La même page chargée avec ?test=1 : le mode test doit s'y déclarer.
const domTest = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true,
  url:'https://site.test/?test=1', virtualConsole: new VirtualConsole(),
  beforeParse(win){
    win.fetch = async () => ({ ok:true, status:200, json: async () => DONNEES,
      headers:{ get: () => 'application/json' } });
  } });

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
  // Trois accès à l'origine ; « Nous contacter » est le quatrième,
  // demandé explicitement dans la navigation.
  v('quatre accès en haut', acces.length === 4, acces.join(' · '));
  v('les accès sont ceux attendus',
    acces.map((t) => t.replace(/Référencer ma dahiraMa dahira/, 'Ma dahira')).join('|')
      === 'Le projet|Nous contacter|Adhérer|Ma dahira',
    acces.join(' · '));
  v('« Adhérer » est le bouton principal',
    d.querySelector('.acces a.primaire').getAttribute('href') === '#adherer');
  const ancres = [...d.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)).filter(Boolean);
  const cassees = [...new Set(ancres)].filter(a => a !== 'haut' && !d.getElementById(a));
  v('aucune ancre cassée', cassees.length === 0, cassees.join(', '));
  v('menu mobile complet', d.querySelectorAll('#menuMobile a').length === 8,
    [...d.querySelectorAll('#menuMobile a')].map(a => a.textContent).join(' · '));

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

  console.log('\nACCORDÉONS');
  const accordeons = [...d.querySelectorAll('details.replier')];
  v('accordéons présents', accordeons.length >= 10, accordeons.length + ' sections repliables');
  v('tous ont un titre explicite',
    accordeons.every(a => (a.querySelector('summary')?.textContent || '').trim().length > 12),
    accordeons.map(a => a.querySelector('summary').textContent.trim().split('—')[0].trim()).join(' · '));
  v('aucun accordéon imbriqué',
    accordeons.every(a => !a.querySelector('details.replier')));
  v('tous fermés au chargement', accordeons.every(a => !a.open));
  v('ouverture et fermeture fonctionnent', (() => {
    const a = accordeons[0];
    a.open = true;
    const ouvert = a.open === true;
    a.open = false;
    return ouvert && a.open === false;
  })());
  v('navigation au clavier native (details/summary)',
    accordeons.every(a => a.querySelector('summary') && a.tagName === 'DETAILS'));
  v('le film et la galerie sont conservés',
    Boolean(d.querySelector('video')) && d.querySelectorAll('.galerie figure').length === 4);
  v('aucune image ni vidéo perdue',
    d.querySelectorAll('img').length >= 10 && d.querySelectorAll('video source').length === 1,
    d.querySelectorAll('img').length + ' images');
  v('l\'historique est conservé en entier', d.querySelectorAll('.frise li').length === 10);
  v('la FAQ est regroupée sous un seul bouton',
    accordeons.some(a => /Questions fréquentes/.test(a.querySelector('summary').textContent)));
  v('la FAQ garde ses 7 questions', d.querySelectorAll('.faq-q').length === 7);
  v('les questions sont des boutons, pas des accordéons imbriqués',
    d.querySelectorAll('.faq details').length === 0
    && [...d.querySelectorAll('.faq-q')].every(b => b.tagName === 'BUTTON'));
  v('réponses masquées au départ',
    [...d.querySelectorAll('.faq-r')].every(r => r.hidden === true));
  v('chaque question annonce son état',
    [...d.querySelectorAll('.faq-q')].every(b => b.getAttribute('aria-expanded') === 'false'
      && d.getElementById(b.getAttribute('aria-controls'))));
  v('un clic ouvre puis referme la réponse', (() => {
    const b = d.querySelector('.faq-q');
    const r = d.getElementById(b.getAttribute('aria-controls'));
    b.dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
    const ouvert = r.hidden === false && b.getAttribute('aria-expanded') === 'true';
    b.dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
    return ouvert && r.hidden === true && b.getAttribute('aria-expanded') === 'false';
  })());
  v('aucun texte de réponse perdu',
    [...d.querySelectorAll('.faq-r')].every(r => r.textContent.trim().length > 40));
  v('les boutons de participation restent visibles',
    [...d.querySelectorAll('a[href="#adherer"]')].some(a => !a.closest('details')));
  v('le formulaire d\'engagement n\'est pas replié',
    !d.getElementById('formEngagement').closest('details'));
  v('les compteurs de suivi restent visibles',
    !d.getElementById('kpiEngagements').closest('details'));
  v('le puzzle reste visible', !d.getElementById('puzzleSVG').closest('details'));

  console.log('\nDEVISE');
  v('sélecteur de devise présent', Boolean(d.getElementById('devise')));
  v('euro et franc CFA proposés',
    [...d.querySelectorAll('#devise option')].map(o => o.value).join(',') === 'EUR,XOF');
  v('euro par défaut', d.getElementById('devise').value === 'EUR');
  v('le sélecteur est masqué hors montant libre', d.getElementById('blocLibre').hidden === true);
  v('le total passe en FCFA avec le forfait libre', (() => {
    const libre = d.querySelector('input[name="forfait"][value="libre"]');
    libre.checked = true;
    libre.dispatchEvent(new w.Event('change', { bubbles:true }));
    d.getElementById('montantLibre').value = '25000';
    d.getElementById('devise').value = 'XOF';
    d.getElementById('devise').dispatchEvent(new w.Event('change', { bubbles:true }));
    const t = d.getElementById('totalAffiche').textContent;
    const argent = d.querySelector('input[name="forfait"][value="argent"]');
    argent.checked = true;
    argent.dispatchEvent(new w.Event('change', { bubbles:true }));
    return t.includes('FCFA');
  })());
  v('le total revient en euros avec un forfait fixe',
    d.getElementById('totalAffiche').textContent.includes('€'));

  console.log('\nNOUVEAUTÉS');
  const maquette = accordeons.find(a => /Maquette/.test(a.querySelector('summary').textContent));
  v('avertissement sur les visuels présent',
    /représentation souhaitée du projet/.test(maquette.textContent));
  v('il est le premier élément de la rubrique',
    maquette.querySelector('.contenu > *').classList.contains('avis'));
  v('le détail du bâtiment est dans la même rubrique',
    /Ce que nous recherchons dans le bâtiment/.test(maquette.textContent)
    && maquette.querySelectorAll('.niveau').length === 2);
  v('le programme est présenté comme un besoin',
    /besoins à satisfaire, non un bâtiment acquis/.test(maquette.textContent));
  v('plus de rubrique « Le bâtiment en détail » séparée',
    !accordeons.some(a => a.querySelector('summary').textContent.trim() === 'Le bâtiment en détail'));

  const liens = [...d.querySelectorAll('.acces a')];
  v('deux boutons d\'action en haut', liens.filter(a => a.classList.contains('primaire')
    || a.classList.contains('action')).length === 2);
  v('« Adhérer » et « Référencer ma dahira » côte à côte',
    liens.some(a => a.classList.contains('primaire') && a.getAttribute('href') === '#adherer')
    && liens.some(a => a.classList.contains('action') && a.getAttribute('href') === '#referencer'));
  v('le second bouton ouvre bien le formulaire existant',
    Boolean(d.getElementById('referencer')) && d.getElementById('referencer').querySelector('#formDahira'));
  v('libellé court prévu pour le téléphone',
    Boolean(d.querySelector('.acces .court')) && Boolean(d.querySelector('.acces .long')));

  v('bloc RIB sous le formulaire d\'adhésion', (() => {
    const rib = d.getElementById('rib');
    const form = d.getElementById('formEngagement');
    return rib && form && form.compareDocumentPosition(rib) & 4;   // rib après le formulaire
  })());
  v('le RIB est dans la section Adhérer',
    d.getElementById('rib').parentElement.closest('section').id === 'adherer');
  v('bénéficiaire indiqué',
    /ASS CONNAISSANCE ET SAVOIR/.test(d.getElementById('rib').textContent));
  v('IBAN et BIC officiels', (() => {
    const t = d.getElementById('rib').textContent;
    return t.includes('FR76 1010 7003 1900 9210 2803 703') && t.includes('BREDFRPPXXX');
  })());
  v('bouton de téléchargement du RIB', (() => {
    const a = d.querySelector('#rib a[download]');
    return a && a.getAttribute('href') === 'rib-acs.pdf';
  })());
  v('bouton de copie de l\'IBAN', Boolean(d.querySelector('#rib #copierIban')));
  v('le RIB n\'est pas replié', !d.getElementById('rib').closest('details'));
  v('mention du virement permanent dans le bloc RIB',
    /vous devez mettre en place vous-même un virement permanent/.test(d.getElementById('rib').textContent));
  v('mention du virement permanent près du choix mensuel',
    /vous devez mettre en place vous-même un virement permanent/
      .test(d.getElementById('formEngagement').textContent));
  v('l\'IBAN n\'apparaît qu\'à un seul endroit',
    (d.body.textContent.match(/FR76 1010 7003 1900 9210 2803 703/g) || []).length === 1);

  v('recherche de dahiras repliée',
    d.getElementById('annuaire').tagName === 'DETAILS');
  v('son titre reste visible fermée',
    /Trouver une dahira près de chez soi/.test(d.getElementById('annuaire').querySelector('summary').textContent));
  v('filtres et résultats conservés',
    Boolean(d.getElementById('fRecherche')) && Boolean(d.getElementById('listeDahiras'))
    && Boolean(d.getElementById('carteDahiras')));

  v('parcours de modification présent', Boolean(d.getElementById('modifier-dahira')));
  v('action clairement identifiable',
    /Modifier les informations de ma dahira/
      .test(d.getElementById('modifier-dahira').querySelector('summary').textContent));
  v('les trois coordonnées modifiables sont annoncées', (() => {
    const t = d.getElementById('modifier-dahira').textContent;
    return /adresse/i.test(t) && /e-mail/i.test(t) && /téléphone/i.test(t);
  })());
  v('le choix « plus accès à l\'e-mail » existe',
    Boolean(d.querySelector('input[name="mVoie"][value="sans_acces_email"]')));
  v('le bloc « sans accès » est masqué par défaut',
    d.getElementById('mBlocSansAcces').hidden === true);
  v('il apparaît quand on le choisit', (() => {
    const r = d.querySelector('input[name="mVoie"][value="sans_acces_email"]');
    r.checked = true;
    r.dispatchEvent(new w.Event('change', { bubbles:true }));
    const visible = d.getElementById('mBlocSansAcces').hidden === false
                 && d.getElementById('mBlocEmail').hidden === true;
    const r2 = d.querySelector('input[name="mVoie"][value="par_email"]');
    r2.checked = true; r2.dispatchEvent(new w.Event('change', { bubbles:true }));
    return visible;
  })());
  v('aucune modification directe depuis la page',
    !d.querySelector('#modifier-dahira input[id^="dNom"]'));

  console.log('\nNOUS CONTACTER');
  v('la rubrique existe', Boolean(d.getElementById('formContact')));
  v('les cinq éléments demandés sont là', (() => {
    const f = d.getElementById('formContact');
    return ['cNom','cEmail','cObjet','cMessage','btnContact'].every((id) => f.querySelector('#' + id));
  })());
  v('le bouton porte le libellé demandé',
    d.getElementById('btnContact').textContent.trim() === 'Envoyer mon message',
    d.getElementById('btnContact').textContent.trim());
  v('le message est une zone de texte multiligne',
    d.getElementById('cMessage').tagName === 'TEXTAREA');
  v('chaque champ a son étiquette', ['cNom','cEmail','cObjet','cMessage']
    .every((id) => d.querySelector(`label[for="${id}"]`)));
  v('les quatre champs sont obligatoires', ['cNom','cEmail','cObjet','cMessage']
    .every((id) => d.getElementById(id).hasAttribute('required')));
  v('les longueurs sont bornées dès la page', (() => {
    const max = { cNom:'120', cEmail:'160', cObjet:'160', cMessage:'5000' };
    return Object.entries(max).every(([id, n]) => d.getElementById(id).getAttribute('maxlength') === n);
  })());
  v('le champ e-mail est de type e-mail',
    d.getElementById('cEmail').getAttribute('type') === 'email');
  v('un piège à robots est présent et hors du clavier', (() => {
    const p = d.querySelector('#formContact .piege input');
    return Boolean(p) && p.getAttribute('tabindex') === '-1';
  })());
  v('la mention sur l’usage des informations est visible', (() => {
    const t = d.querySelector('#formContact .mention-donnees');
    if (!t) return false;
    const texte = t.textContent.replace(/\s+/g, ' ').trim();
    return /uniquement à traiter votre demande/.test(texte) && /ni transmis à des tiers/.test(texte);
  })());
  v('elle renvoie à la page de confidentialité',
    Boolean(d.querySelector('#formContact .mention-donnees a[href="confidentialite.html"]')));
  v('une zone de statut annoncée aux lecteurs d’écran', (() => {
    const z = d.getElementById('statutContact');
    return Boolean(z) && z.getAttribute('role') === 'status' && z.getAttribute('aria-live') === 'polite';
  })());
  v('le formulaire envoie au serveur, sans ouvrir la messagerie',
    /fetch\('\/api\/contact'/.test(html) && !/#formContact[\s\S]{0,400}mailto:/.test(html));
  v('le message exact de succès est celui demandé',
    html.includes('Merci ! Votre message a bien été envoyé. Nous vous répondrons dès que possible.'));
  v('la confirmation n’est affichée qu’après accord du serveur',
    /if\(r\.ok && rep\.ok\)\{[\s\S]{0,400}bien été envoyé/.test(html));
  v('le double clic est bloqué par un drapeau',
    /if\(envoiEnCours\) return;[\s\S]{0,1800}\/api\/contact/.test(html));
  // Un lien présent dans le code ne suffit pas : le menu déroulant est
  // masqué au-dessus de 1000 px, la barre du haut en dessous. Il faut
  // donc le lien AUX DEUX endroits pour qu'il soit atteignable partout.
  v('un lien « Nous contacter » dans la barre du haut (grand écran)',
    Boolean([...d.querySelectorAll('.acces a')].find((a) => /Nous contacter/.test(a.textContent))));
  v('un lien « Nous contacter » dans le menu déroulant (petit écran)',
    Boolean([...d.querySelectorAll('#menuMobile a')].find((a) => /Nous contacter/.test(a.textContent))));
  v('chaque entrée du menu déroulant mène à une section existante',
    [...d.querySelectorAll('#menuMobile a')].every((a) => {
      const h = a.getAttribute('href') || '';
      return !h.startsWith('#') || Boolean(d.getElementById(h.slice(1)));
    }));
  v('un lien « Nous contacter » figure dans le pied de page',
    Boolean([...d.querySelectorAll('footer a')].find((a) => /Nous contacter/.test(a.textContent))));
  v('tous les liens « Nous contacter » mènent à la rubrique', (() => {
    const cibles = [...d.querySelectorAll('header a, footer a')]
      .filter((a) => /Nous contacter/.test(a.textContent))
      .map((a) => a.getAttribute('href'));
    return cibles.length === 3 && cibles.every((h) => h === '#nous-ecrire')
      && Boolean(d.getElementById('nous-ecrire'));
  })());
  v('aucune clé d’envoi dans la page publique',
    !/BREVO_API_KEY|RESEND_API_KEY|xkeysib-|re_[A-Za-z0-9]{20,}/.test(html));

  console.log('\nMODE TEST');
  v('aucun bandeau de test par défaut',
    d.getElementById('bandeauTest').hidden === true);
  v('le bandeau apparaît avec ?test=1',
    domTest.window.document.getElementById('bandeauTest').hidden === false);
  v('il dit que l\'essai ne comptera pas', (() => {
    const t = domTest.window.document.getElementById('bandeauTest').textContent;
    return /totaux publics/.test(t) && /suivi/.test(t) && /\?test=1/.test(t);
  })());
  v('il se voit avant le formulaire',
    d.getElementById('bandeauTest').compareDocumentPosition(d.getElementById('prenom'))
      & 4);
  v('le drapeau est transmis au serveur',
    /est_test:\s*MODE_TEST/.test(html));
  v('le mode test se lit dans l\'adresse, pas ailleurs',
    /get\('test'\)\s*===\s*'1'/.test(html));
  v('le bouton d\'envoi annonce l\'essai',
    /MODE_TEST \? 'Enregistrement \(test\)…'/.test(html));
  v('le formulaire de dahira n\'est pas touché',
    !/d_site_web[\s\S]{0,200}est_test/.test(html));

  console.log('\nLOGOS DES DEUX STRUCTURES');
  const logosHaut = [...d.querySelectorAll('.topbar img')].map((i) => i.getAttribute('src'));
  const logosBas  = [...d.querySelectorAll('footer .logos img')].map((i) => i.getAttribute('src'));
  v('le logo ACS est en haut de page', logosHaut.some((s) => /logoacs/.test(s)));
  v('le logo FAF est en haut de page', logosHaut.some((s) => /logofaf/.test(s)));
  v('les deux logos sont côte à côte', (() => {
    const m = d.querySelector('.topbar .marques');
    return Boolean(m) && m.querySelectorAll('img').length === 2;
  })());
  v('le logo ACS est en bas de page', logosBas.some((s) => /logoacs/.test(s)));
  v('le logo FAF est en bas de page', logosBas.some((s) => /logofaf/.test(s)));
  v('les deux structures sont nommées en bas de page', (() => {
    const t = d.querySelector('footer .logos').textContent;
    return /Connaissance et Savoir/.test(t) && /Ansaruddîne/.test(t);
  })());
  v('la Fédération est nommée dans la signature du haut',
    /Ansaruddîne/.test(d.querySelector('.topbar .brand b').textContent));
  v('chaque logo porte un texte alternatif',
    [...d.querySelectorAll('.topbar img, footer .logos img')]
      .every((i) => (i.getAttribute('alt') || '').trim().length > 0));
  v('les fichiers de logo existent',
    [...new Set([...logosHaut, ...logosBas])]
      .every((chemin) => fs.existsSync(racine + 'public/' + chemin)));

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
