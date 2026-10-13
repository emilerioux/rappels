/* ============================================================
   suggest.js — ce que l'app propose pendant qu'on écrit :
   - complétion à partir des anciens rappels ;
   - l'heure habituelle d'un rappel déjà fait ;
   - une correction d'orthographe à toucher.

   L'historique vit dans ce téléphone (localStorage « rp-history ») :
   le serveur, lui, oublie les rappels faits après 7 jours.
   ============================================================ */

import { fold } from "./parse.js";

const K = "rp-history";
const MAX = 400;

const ff = (t) => fold(t).replace(/œ/g, "oe").replace(/æ/g, "ae");
const key = (t) => ff(t).replace(/[^a-z0-9' -]/g, "").replace(/\s+/g, " ").trim();

let hist = (() => { try { return JSON.parse(localStorage.getItem(K)) || []; } catch (_) { return []; } })();
const save = () => { try { localStorage.setItem(K, JSON.stringify(hist)); } catch (_) {} };

/* Retient un rappel ajouté (titre, liste, heure, répétition). */
export function remember(r, { count = true } = {}) {
  const k = key(r.title);
  if (!k) return;
  let e = hist.find((x) => x.k === k);
  if (!e) { e = { k, n: 0 }; hist.push(e); }
  e.t = r.title;
  e.l = r.list_id;
  if (count) e.n += 1; else e.n = Math.max(e.n, 1);
  e.last = Math.max(e.last || 0, r.created_at || Date.now());
  if (r.due) {
    const d = new Date(r.due);
    const hm = [d.getHours(), d.getMinutes()];
    /* Heure « habituelle » : on garde les heures vues, la plus fréquente gagne. */
    e.hm = e.hm || {};
    const s = `${hm[0]}:${hm[1]}`;
    e.hm[s] = (e.hm[s] || 0) + 1;
  }
  if (r.repeat) e.rep = r.repeat;
  if (hist.length > MAX) hist = hist.sort((a, b) => b.last - a.last).slice(0, MAX);
  save();
}

/* Au premier lancement, on amorce avec les rappels déjà sur le serveur. */
export function seed(reminders) {
  for (const r of reminders) if (!hist.some((x) => x.k === key(r.title))) remember(r, { count: false });
}

export function complete(text, n = 3) {
  const q = key(text);
  if (q.length < 2) return [];
  const words = q.split(" ");
  return hist
    .filter((e) => e.k !== q && (e.k.startsWith(q) || words.every((w) => e.k.split(" ").some((x) => x.startsWith(w)))))
    .sort((a, b) => (b.k.startsWith(q) - a.k.startsWith(q)) || b.n - a.n || b.last - a.last)
    .slice(0, n);
}

/* Heure la plus souvent choisie pour ce titre exact : { h, m, times }. */
export function habit(title) {
  const e = hist.find((x) => x.k === key(title));
  if (!e?.hm) return null;
  const [best, times] = Object.entries(e.hm).sort((a, b) => b[1] - a[1])[0];
  const [h, m] = best.split(":").map(Number);
  return { h, m, times, list: e.l, repeat: e.rep || null };
}

export const nextAt = (h, m, now = Date.now()) => {
  const d = new Date(now); d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
};

/* ── Orthographe ─────────────────────────────────────────────
   Un lexique des mots qui reviennent dans des rappels. Un mot
   proche d'un mot du lexique (une lettre de trop, de moins, ou
   inversée), ou le même sans ses accents, est proposé en
   correction. Les noms propres (majuscule hors début) et les mots
   déjà vus dans tes rappels ne sont jamais signalés. */

const LEXICON = `appeler rappeler téléphoner texter écrire envoyer courriel courriels répondre message messages
acheter payer loyer facture factures épicerie pharmacie médicament médicaments ordonnance rendez-vous dentiste
médecin docteur hôpital clinique coiffeur réserver réservation annuler confirmer renouveler passeport permis
assurance banque virement impôts rapport laboratoire devoir devoirs examen examens lecture étudier réviser
révision remettre imprimer présentation projet réunion rencontre cours travail horaire ménage lavage lessive
vaisselle poubelle poubelles recyclage compost aspirateur nettoyer ranger sortir linge plantes arroser cuisiner
souper dîner déjeuner recette gâteau anniversaire cadeau fête mariage souhaiter maman papa frère sœur
grand-mère grand-père voiture essence garage pneus changement huile entretien entraînement courir course
natation vitamines prendre chercher ramasser déposer retourner colis livraison commande commander magasin
épargne budget billets festival spectacle concert valise voyage appartement propriétaire électricité internet
téléphone abonnement inscription formulaire signer contrat document documents dossier application candidature
vérifier préparer finir terminer commencer organiser planifier oublier apporter laver changer réparer installer
mettre fromage beurre café fruits légumes viande poulet poisson pâtes sucre farine yogourt céréales savon
shampoing œufs cœur dentifrice papier essuie-tout chambre cuisine salle bureau école université bibliothèque emprunter
rendre livres livre calendrier semaine physique chimie mathématiques religion midterm final étude groupe
équipe partenaire conjointe chat chien vétérinaire nourriture litière promenade marcher dormir réveil
électronique ordinateur cellulaire chargeur batterie clés portefeuille lunettes vêtements souliers manteau
bottes pharmacien prescription vaccin rendez prise sang analyse résultats remboursement reçu reçus taxes
déclaration salaire paie horaire quart congé vacances billet avion hôtel location`.split(/\s+/);

const COMMON = new Set(`le la les de du des un une et ou à au aux pour avec sans sur sous dans chez par mon ma mes
ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces qui que quoi faire fais fait aller va voir
avant après demain soir matin midi jour jours tout tous toute toutes plus moins très bien encore aussi rien
puis alors donc mais car être avoir lui elle eux elles nous vous ils moi toi chaque prochain prochaine heure
heures minutes semaine mois année lundi mardi mercredi jeudi vendredi samedi dimanche`.split(/\s+/).map(ff));

const LEX = LEXICON.map((w) => ({ w, f: ff(w) }));
const LEX_F = new Set(LEX.map((x) => x.f));

/* Distance d'édition avec inversion de deux lettres voisines. */
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

function knownWords() {
  const s = new Set();
  for (const e of hist) for (const w of e.k.split(/[\s'-]+/)) s.add(w);
  return s;
}

/* Première faute repérée dans le titre : { from, to } ou null. */
export function spell(title) {
  const seen = knownWords();
  const words = [...title.matchAll(/\p{L}+(?:-\p{L}+)*/gu)];
  for (const [i, m] of words.entries()) {
    const w = m[0];
    if (i > 0 && w[0] !== w[0].toLowerCase()) continue;          // nom propre
    const lw = w.toLowerCase(), f = ff(w);
    if (f.length < 4 || COMMON.has(f)) continue;
    /* Même mot sans ses accents : « epicerie » → « épicerie ». */
    const acc = LEX.find((x) => x.f === f && x.w !== lw);
    if (acc && lw === fold(w)) return { from: w, to: matchCase(w, acc.w) };
    if (LEX_F.has(f) || seen.has(f)) continue;
    if (f.length < 5) continue;
    const max = f.length >= 8 ? 2 : 1;
    let best = null, bestD = max + 1, tie = false;
    for (const x of LEX) {
      const dd = dist(f, x.f, max);
      if (dd < bestD) { best = x; bestD = dd; tie = false; } else if (dd === bestD && best && x.f !== best.f) tie = true;
    }
    if (best && bestD <= max && !tie) return { from: w, to: matchCase(w, best.w) };
  }
  return null;
}

const matchCase = (orig, w) => (orig[0] !== orig[0].toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w);
