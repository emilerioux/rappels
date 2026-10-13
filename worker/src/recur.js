/* ============================================================
   recur.js — prochaine occurrence d'un rappel récurrent.

   Le serveur tourne en UTC, mais « chaque jour à 8 h » veut dire
   8 h à Montréal, été comme hiver. On calcule donc en heure murale
   de Montréal, puis on reconvertit en UTC.
   ============================================================ */

const TZ = "America/Montreal";
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

export function wall(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}

function offset(ms) {
  const p = wall(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000;
}

/* Heure murale de Montréal → ms UTC. Date.UTC accepte les jours
   « qui débordent » (32 octobre = 1er novembre), on en profite. */
export function fromWall(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

const weekday = (p) => new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function step(ms, repeat) {
  const p = wall(ms);
  if (repeat === "daily") return fromWall(p.y, p.m, p.d + 1, p.h, p.mi);
  if (repeat === "weekly") return fromWall(p.y, p.m, p.d + 7, p.h, p.mi);
  if (repeat === "monthly") {
    const y = p.m === 12 ? p.y + 1 : p.y, m = p.m === 12 ? 1 : p.m + 1;
    return fromWall(y, m, Math.min(p.d, daysIn(y, m)), p.h, p.mi);
  }
  if (repeat === "yearly") return fromWall(p.y + 1, p.m, Math.min(p.d, daysIn(p.y + 1, p.m)), p.h, p.mi);

  let days = null;
  if (repeat === "weekdays") days = [1, 2, 3, 4, 5];
  else if (repeat?.startsWith("days:")) days = repeat.slice(5).split(",").map(Number);
  if (!days?.length) return null;
  for (let i = 1; i <= 7; i++) {
    const q = wall(fromWall(p.y, p.m, p.d + i, 12, 0));
    if (days.includes(weekday(q))) return fromWall(q.y, q.m, q.d, p.h, p.mi);
  }
  return null;
}

/* Prochaine échéance strictement après `now` (on saute celles
   qu'on aurait ratées). null si la règle est inconnue. */
export function nextDue(due, repeat, now = Date.now()) {
  let t = step(due, repeat);
  for (let guard = 0; t !== null && t <= now && guard < 1000; guard++) t = step(t, repeat);
  return t;
}
