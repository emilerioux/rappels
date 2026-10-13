/* ============================================================
   parse.js — lit une phrase comme on la dit :
     « demain 15h appeler maman »
     « rappelle-moi de sortir le recyclage chaque mardi soir »
     « dans 20 min sortir le linge #perso »
     « le 28 oct à 10h30 remettre le labo #école »
   et en tire { title, due, repeat, listId }.

   Méthode : on travaille sur une copie « pliée » (minuscules, sans
   accents) de même longueur que l'original ; chaque expression
   reconnue est effacée de l'original, ce qui reste est le titre.
   ============================================================ */

import { startOfDay, addDays, nextDue } from "./dates.js";

const WDN = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const WD = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";
const MONTHS = [["janvier", "janv", "jan"], ["fevrier", "fevr", "fev"], ["mars"], ["avril", "avr"], ["mai"], ["juin"],
  ["juillet", "juil"], ["aout"], ["septembre", "sept", "sep"], ["octobre", "oct"], ["novembre", "nov"], ["decembre", "dec"]];
const MONTH_OF = {};
MONTHS.forEach((names, i) => names.forEach((n) => { MONTH_OF[n] = i; }));
const MO = Object.keys(MONTH_OF).sort((a, b) => b.length - a.length).join("|");
const WORDNUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50 };
const PERIOD = { matin: 9, midi: 12, "apres-midi": 14, "apres midi": 14, apresmidi: 14, aprem: 14, soir: 19, soiree: 19, nuit: 21 };
const PREP = "(?:(?:a|vers|pour|avant|des|d'ici)\\s+)?";

export const fold = (s) => Array.from({ length: s.length }, (_, i) => {
  const c = s[i];
  if (c === "’" || c === "‘") return "'";
  return ((c.normalize("NFD")[0] || c).toLowerCase())[0] || c;
}).join("");

/* Mots de date tapés vite → la bonne forme. Liste explicite plutôt
   qu'une recherche floue : « marie » ne doit jamais devenir « mardi ». */
const TYPOS = {
  demin: "demain", deman: "demain", demian: "demain", demaim: "demain", dmain: "demain", deamin: "demain",
  demmain: "demain", demaib: "demain", dem1: "demain", dmn: "demain",
  ajd: "aujourd'hui", aujd: "aujourd'hui", aujourdhui: "aujourd'hui", aujourdui: "aujourd'hui",
  ajourdhui: "aujourd'hui", aujoudhui: "aujourd'hui", aujourhui: "aujourd'hui", aujoud: "aujourd'hui",
  lundy: "lundi", lindi: "lundi", lnudi: "lundi", lunid: "lundi",
  mardy: "mardi", madri: "mardi", mradi: "mardi", mardu: "mardi",
  mercerdi: "mercredi", mecredi: "mercredi", mercedi: "mercredi", mercrdi: "mercredi", merdredi: "mercredi",
  mercredie: "mercredi", mercreid: "mercredi", mecrcredi: "mercredi", mercrei: "mercredi",
  jeudy: "jeudi", jedi: "jeudi", jeudie: "jeudi", juedi: "jeudi", jeuid: "jeudi",
  vendredie: "vendredi", vendedi: "vendredi", vendrdi: "vendredi", vendrei: "vendredi", vnedredi: "vendredi",
  venderdi: "vendredi", vendredu: "vendredi", vendredy: "vendredi",
  samdi: "samedi", samedie: "samedi", samdei: "samedi", smaedi: "samedi", samedu: "samedi",
  dimance: "dimanche", dimanch: "dimanche", dimache: "dimanche", dimanhe: "dimanche", dimnache: "dimanche",
  soire: "soir", sior: "soir", matain: "matin", matim: "matin", mtin: "matin",
  procahine: "prochaine", prochine: "prochaine", prochaien: "prochaine", prochin: "prochain", procahin: "prochain",
  minuites: "minutes", minues: "minutes", miutes: "minutes", heurs: "heures", heurse: "heures",
  setembre: "septembre", septembe: "septembre", ocotbre: "octobre", otcobre: "octobre", novmebre: "novembre",
  novembe: "novembre", decmbre: "décembre", decembe: "décembre", janver: "janvier", fevier: "février",
  chaques: "chaque", chque: "chaque", chaqe: "chaque", touts: "tous",
};

export function fixDateTypos(text) {
  return text.replace(/[\p{L}\d'’]+/gu, (w) => {
    const fix = TYPOS[fold(w)];
    if (!fix) return w;
    return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
  });
}

/* Format du titre : espaces, ponctuation, majuscule. */
export function tidy(title) {
  return title
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/([,.!?])\1+/g, "$1")
    .replace(/,(?=\S)/g, ", ")
    .replace(/[\s,;:.–-]+$/, "")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function parse(input, { now = Date.now(), lists = [] } = {}) {
  const text = fixDateTypos(String(input || "").normalize("NFC"));
  let low = fold(text);
  const cut = new Array(text.length).fill(false);

  /* Cherche `re` dans le texte pas encore consommé ; `fn` reçoit le
     match et renvoie false pour le refuser. */
  const take = (re, fn) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m, hit = false;
    while ((m = g.exec(low))) {
      if (m[0].trim() === "") { g.lastIndex++; continue; }
      if (fn(m) === false) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) cut[i] = true;
      low = low.slice(0, m.index) + " ".repeat(m[0].length) + low.slice(m.index + m[0].length);
      hit = true;
      if (!re.flags.includes("g")) break;
    }
    return hit;
  };

  let listId = null, rel = null, day = null, time = null, period = null, repeat = null, subj = false;

  /* 1. Liste : « #école » (au moins 2 lettres, début du nom). */
  take(/(?<![\w#])#([a-z0-9_-]{2,})/, (m) => {
    const tag = m[1].replace(/[-_]/g, "");
    const l = lists.find((l) => fold(l.name).replace(/[^a-z0-9]/g, "").startsWith(tag));
    if (!l) return false;
    listId = l.id;
  });

  /* 2. Formules d'entrée. */
  take(/^\s*(?:(?:hey|eh|ok)\s+)?(?:rappelle[- ]?moi|rappelles?[- ]?moi|rappel|(?:il\s+)?(?:faut|faudrait)\s+(?:vraiment\s+)?que\s+(?:je|j')|je\s+dois|j'?dois|(?:il\s+)?faut|(?:pense|penser)\s+a|(?:n')?oublie\s+pas|ne\s+pas\s+oublier)\s*(?:de\s+|d'|que\s+|qu'|:\s*)?/, (m) => { subj = /\bque\s+(?:je\b|j')/.test(m[0]); });

  /* 3. Relatif : « dans 20 min », « dans 1h30 », « dans une heure ». */
  take(/\bdans\s+(?:une\s+)?demi[- ]?heure\b/, () => { rel = 30 * 60e3; });
  take(/\bdans\s+un\s+quart\s+d'heure\b/, () => { rel = 15 * 60e3; });
  take(new RegExp(`\\bdans\\s+(\\d+(?:[.,]\\d+)?|${Object.keys(WORDNUM).join("|")})\\s*(minutes?|mins?|mn|heures?|hres?|hrs?|h|jours?|j|semaines?|sem|mois|m)(?![a-z])(?:\\s*(\\d{1,2})(?!\\d))?`), (m) => {
    const n = WORDNUM[m[1]] ?? parseFloat(m[1].replace(",", "."));
    const u = m[2];
    if (/^h/.test(u)) rel = n * 3600e3 + (m[3] ? +m[3] * 60e3 : 0);
    else if (/^(mi|mn|m$)/.test(u)) rel = n * 60e3;
    else if (/^j/.test(u)) { day = startOfDay(addDays(now, n)); return; }
    else if (/^s/.test(u)) { day = startOfDay(addDays(now, 7 * n)); return; }
    else if (u === "mois") { const d = new Date(now); d.setMonth(d.getMonth() + n); day = startOfDay(d.getTime()); return; }
  });

  /* 4. Répétitions. */
  take(/\b(?:en\s+semaine|(?:chaque|tous\s+les)\s+jours?\s+de\s+(?:la\s+)?semaine|du\s+lundi\s+au\s+vendredi)\b/, () => { repeat = "weekdays"; });
  take(/\b(?:chaque|tous\s+les|toutes\s+les)\s+(jours?|matins?|midis?|soirs?|soirees?|nuits?)\b/, (m) => {
    repeat = "daily";
    const p = m[1].replace(/s$/, "");
    if (p !== "jour") period = PERIOD[p];
  });
  take(/\b(?:chaque|toutes\s+les)\s+semaines?\b/, () => { repeat = "weekly"; });
  take(/\b(?:chaque|tous\s+les)\s+mois\b/, () => { repeat = "monthly"; });
  take(/\b(?:chaque|tous\s+les)\s+(?:annees?|ans)\b/, () => { repeat = "yearly"; });
  take(new RegExp(`\\b(?:chaque|tous\\s+les|les)\\s+((?:${WD})s?(?:\\s*(?:,|et)\\s*(?:${WD})s?)*)\\b`), (m) => {
    const days = [...m[1].matchAll(new RegExp(WD, "g"))].map((x) => WDN.indexOf(x[0]));
    const uniq = [...new Set(days)].sort((a, b) => a - b);
    repeat = uniq.length === 1 ? "weekly" : `days:${uniq.join(",")}`;
    day = nextWeekday(now, uniq, true);
  });

  /* 5. Jours. */
  take(/\bapres[- ]demain\b/, () => { day = startOfDay(addDays(now, 2)); });
  take(/\bdemain\b/, () => { day = startOfDay(addDays(now, 1)); });
  take(/\b(?:aujourd'?\s?hui|auj)\b/, () => { day = startOfDay(now); });
  take(/\b(?:ce|cet|cette)\s+(soir|matin|midi|apres[- ]midi|aprem|nuit|soiree)\b/, (m) => {
    day = startOfDay(now); period = PERIOD[m[1]];
  });
  take(/\b(?:la\s+)?semaine\s+prochaine\b/, () => { day = nextWeekday(addDays(now, 1), [1], true); });
  take(/\b(?:en\s+|cette\s+|la\s+|ce\s+)?(?:fin\s+de\s+semaine|week-?end)\b/, () => {
    day = nextWeekday(now, [6, 0], true);
    if (period == null) period = 10;
  });
  take(new RegExp(`\\b(ce\\s+|le\\s+)?(${WD})(?:\\s+(prochain))?\\b`), (m) => {
    const wd = WDN.indexOf(m[2]);
    const today = new Date(now).getDay() === wd;
    day = today && !(m[1] || "").startsWith("ce") ? startOfDay(addDays(now, 7)) : nextWeekday(now, [wd], true);
    if (m[3] && !today && dayDiffFrom(now, day) < 2) day = addDays(day, 7);
  });
  take(new RegExp(`\\b(?:le\\s+)?(\\d{1,2})(?:er)?\\s+(${MO})\\b\\.?(?:\\s+(\\d{4})\\b)?`), (m) => {
    const d = +m[1]; if (d < 1 || d > 31) return false;
    day = absDate(now, d, MONTH_OF[m[2]], m[3] && +m[3]);
  });
  take(/\b(?:le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const d = +m[1], mo = +m[2] - 1; if (d < 1 || d > 31 || mo < 0 || mo > 11) return false;
    day = absDate(now, d, mo, m[3] && (m[3].length === 2 ? 2000 + +m[3] : +m[3]));
  });
  take(/\ble\s+(\d{1,2})(?:er)?\b(?!\s*(?:h|:|\d|heures?))/, (m) => {
    const d = +m[1]; if (d < 1 || d > 31) return false;
    const n = new Date(now);
    let t = new Date(n.getFullYear(), n.getMonth(), d).getTime();
    if (t < startOfDay(now)) t = new Date(n.getFullYear(), n.getMonth() + 1, d).getTime();
    day = t;
  });

  /* 6. Moments de la journée laissés seuls (« demain matin »). */
  take(/\b(?:le\s+|au\s+|en\s+|dans\s+l'|l')?(matin|apres[- ]midi|aprem|soir|soiree|nuit)\b/, (m) => { period = PERIOD[m[1]]; });

  /* 7. Heures. */
  take(new RegExp(`\\b${PREP}midi\\b`), () => { time = [12, 0]; });
  take(new RegExp(`\\b${PREP}minuit\\b`), () => { time = [23, 59]; });
  take(new RegExp(`\\b${PREP}(\\d{1,2})\\s*(?:hres?|hrs?|heures?|h|:)\\s*(\\d{2})?(?:\\s*(am|pm))?(?![a-z0-9])`), (m) => {
    let h = +m[1]; const mi = m[2] ? +m[2] : 0;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59) return false;
    time = [h, mi, !m[3]];
  });
  take(new RegExp(`\\b${PREP}(\\d{1,2})\\s*(am|pm)\\b`), (m) => {
    let h = +m[1]; if (h > 12) return false;
    if (m[2] === "pm" && h < 12) h += 12;
    if (m[2] === "am" && h === 12) h = 0;
    time = [h, 0];
  });

  /* « soir à 7 h » = 19 h ; « demain 3h » = 15 h (personne ne se fait
     rappeler d'appeler sa mère à 3 h du matin). « 3h du matin » reste 3 h. */
  if (time && time[2]) {
    if (period != null && period >= 14 && time[0] < 12) time[0] += 12;
    else if (period == null && time[0] >= 1 && time[0] <= 5 && !/\bdu\s+matin\b/.test(fold(text))) time[0] += 12;
  }

  /* ── Échéance ── */
  let due = null;
  if (rel != null) {
    due = now + rel;
  } else if (day != null || time || period != null || repeat) {
    const [h, mi] = time || [period ?? 9, 0];
    const at = (d) => { const x = new Date(d); x.setHours(h, mi, 0, 0); return x.getTime(); };
    due = at(day ?? startOfDay(now));
    if (day == null && due <= now) {
      /* Pas de jour dit : la prochaine fois que cette heure arrive
         (en respectant les jours d'une répétition). */
      const allowed = repeat === "weekdays" ? [1, 2, 3, 4, 5] : null;
      due = at(allowed ? nextWeekday(addDays(now, 1), allowed, true) : addDays(startOfDay(now), 1));
    } else if (day != null && due <= now && dayDiffFrom(now, day) === 0 && !time) {
      /* « aujourd'hui » sans heure, alors que 9 h est passé : dans
         la prochaine heure pile. */
      const x = new Date(now); x.setMinutes(0, 0, 0); x.setHours(x.getHours() + 1);
      due = x.getTime();
    }
    if (repeat === "weekdays" && day == null) {
      const wd = new Date(due).getDay();
      if (wd === 0 || wd === 6) due = at(nextWeekday(due, [1, 2, 3, 4, 5], true));
    }
    /* « chaque mardi et jeudi à 10 h », dit un mardi à midi : jeudi. */
    if (repeat && due <= now) due = nextDue(due, repeat, now) ?? due;
  }
  /* ── Titre : ce qui reste, sans les petits mots orphelins
     (« à », « de », « le »…) laissés aux bords. ── */
  let title = Array.from({ length: text.length }, (_, i) => (cut[i] ? " " : text[i])).join("");
  title = title.replace(/\s+/g, " ").trim();
  const head = /^(?:(?:de|du|à|a|le|la|pour|et|puis)\s+|d['’]|[,:–-]\s*)/i;
  const tail = /(?:\s+(?:à|a|le|la|pour|de|du|et)|\s*[,:–-])$/i;
  for (let i = 0; i < 4; i++) title = title.replace(head, "").replace(tail, "").trim();
  if (subj) title = infinitive(title);
  title = tidy(title);

  return { title, due, repeat: due ? repeat : null, listId };
}

function nextWeekday(from, days, includeToday) {
  for (let i = includeToday ? 0 : 1; i < 8; i++) {
    const t = startOfDay(addDays(from, i));
    if (days.includes(new Date(t).getDay())) return t;
  }
  return startOfDay(from);
}

const dayDiffFrom = (now, day) => Math.round((startOfDay(day) - startOfDay(now)) / 864e5);

function absDate(now, d, mo, year) {
  const n = new Date(now);
  let t = new Date(year || n.getFullYear(), mo, d).getTime();
  if (!year && t < startOfDay(now)) t = new Date(n.getFullYear() + 1, mo, d).getTime();
  return t;
}

/* « faudrait que j'appelle Marc » → « Appeler Marc » : après « que je »,
   le premier verbe est conjugué ; on le remet à l'infinitif. */
const IRREG = {
  aille: "aller", fasse: "faire", sorte: "sortir", finisse: "finir", prenne: "prendre", mette: "mettre",
  ecrive: "écrire", lise: "lire", dise: "dire", voie: "voir", parte: "partir", rende: "rendre", vende: "vendre",
  reponde: "répondre", attende: "attendre", envoie: "envoyer", paie: "payer", nettoie: "nettoyer",
  achete: "acheter", appelle: "appeler", rappelle: "rappeler", jette: "jeter", vienne: "venir",
  revienne: "revenir", choisisse: "choisir", remplisse: "remplir", dorme: "dormir", coure: "courir",
  boive: "boire", apprenne: "apprendre", comprenne: "comprendre", recoive: "recevoir", aie: "avoir",
};
function infinitive(title) {
  return title.replace(/^(\p{L}+)/u, (w) => {
    const f = fold(w);
    if (IRREG[f]) return IRREG[f];
    if (/[^aeiouy]es?$/.test(f) || /(ie|ue|ye|ee)$/.test(f)) return w.replace(/s$/, "") + "r";   // lave → laver, paye → payer
    return w;
  });
}
