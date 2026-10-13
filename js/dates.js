/* ============================================================
   dates.js — affichage des dates « à la québécoise » et calcul
   local de la prochaine occurrence (miroir de worker/src/recur.js,
   pour que l'app reste juste même hors ligne).
   ============================================================ */

export const DAY = 864e5;

export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
export const dayDiff = (t, now = Date.now()) => Math.round((startOfDay(t) - startOfDay(now)) / DAY);

const WD = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const WD_S = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MO = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* 15 h · 15 h 30 · 0 h 05 */
export function hhmm(t) {
  const d = new Date(t), m = d.getMinutes();
  return `${d.getHours()} h${m ? " " + String(m).padStart(2, "0") : ""}`;
}

export function dayLabel(t, now = Date.now()) {
  const n = dayDiff(t, now), d = new Date(t);
  if (n === 0) return "Aujourd'hui";
  if (n === 1) return "Demain";
  if (n === -1) return "Hier";
  if (n === 2) return "Après-demain";
  if (n > 2 && n < 7) return cap(WD[d.getDay()]);
  const y = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${cap(WD_S[d.getDay()])} ${d.getDate()} ${MO[d.getMonth()]}${y}`;
}

export const fmtDue = (t, now = Date.now()) => `${dayLabel(t, now)}, ${hhmm(t)}`;

/* Pour <input type="datetime-local"> */
export function toInput(t) {
  if (!t) return "";
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromInput = (s) => (s ? new Date(s).getTime() : null);

export const REPEAT_CHOICES = [
  ["", "Jamais"],
  ["daily", "Chaque jour"],
  ["weekdays", "En semaine (lun.–ven.)"],
  ["weekly", "Chaque semaine"],
  ["monthly", "Chaque mois"],
  ["yearly", "Chaque année"],
];

export function repeatLabel(r) {
  if (!r) return "";
  const hit = REPEAT_CHOICES.find(([k]) => k === r);
  if (hit) return hit[0] === "weekdays" ? "En semaine" : hit[1];
  if (r.startsWith("days:")) {
    const days = r.slice(5).split(",").map(Number);
    const names = days.map((d) => WD_S[d].replace(".", ""));
    return "Chaque " + (names.length > 1 ? names.slice(0, -1).join(", ") + " et " + names.at(-1) : WD[days[0]]);
  }
  return "";
}

function step(t, r) {
  const d = new Date(t);
  if (r === "daily") { d.setDate(d.getDate() + 1); return d.getTime(); }
  if (r === "weekly") { d.setDate(d.getDate() + 7); return d.getTime(); }
  if (r === "monthly" || r === "yearly") {
    const day = d.getDate();
    d.setDate(1);
    if (r === "monthly") d.setMonth(d.getMonth() + 1); else d.setFullYear(d.getFullYear() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d.getTime();
  }
  const days = r === "weekdays" ? [1, 2, 3, 4, 5] : r?.startsWith("days:") ? r.slice(5).split(",").map(Number) : null;
  if (!days?.length) return null;
  for (let i = 0; i < 7; i++) {
    d.setDate(d.getDate() + 1);
    if (days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

export function nextDue(due, repeat, now = Date.now()) {
  let t = step(due, repeat);
  for (let g = 0; t !== null && t <= now && g < 1000; g++) t = step(t, repeat);
  return t;
}
