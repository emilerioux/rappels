/* ============================================================
   app.js — l'écran principal, le compositeur, les feuilles.
   ============================================================ */

import { parse, tidy } from "./parse.js";
import * as Sg from "./suggest.js";
import { fmtDue, hhmm, dayLabel, startOfDay, addDays, repeatLabel, REPEAT_CHOICES, toInput, fromInput } from "./dates.js";
import * as S from "./store.js";
import { openSheet, closeSheet, sheetIsOpen, toast, esc } from "./ui.js";
import { Spring, project, rubberband, tracker, capture, buzz, pop, REDUCED } from "./motion.js";

const $ = (id) => document.getElementById(id);
const VERSION = "v3";

const I = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  snooze: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3 2 6M22 6l-3-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
};

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushCapable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

let view = lsGet("rp-view") || "today";
let showDone = false;
let pushOn = false;
let lastNewId = null;
const checking = new Map();       // id → minuterie : cochés, pas encore partis

const when = (r) => r.snooze ?? r.due;
const listOf = (id) => S.getState().lists.find((l) => l.id === id) || { id, name: "?", color: "#8E8E93" };
const findR = (id) => S.getState().reminders.find((r) => r.id === id);
const short = (s) => (s.length > 28 ? s.slice(0, 27) + "…" : s);

/* ══ Vues et regroupements ═══════════════════════════════════ */

function views() {
  const st = S.getState();
  return [
    { id: "today", name: "Aujourd'hui" },
    { id: "scheduled", name: "Planifiés" },
    { id: "all", name: "Tout" },
    ...st.lists.map((l) => ({ id: `l:${l.id}`, name: l.name, color: l.color, list: l })),
  ];
}

function inView(r, v, now) {
  const t = when(r);
  if (v === "today") return t != null && t < addDays(startOfDay(now), 1);
  if (v === "scheduled") return t != null;
  if (v === "all") return true;
  return r.list_id === v.slice(2);
}

const byWhen = (a, b) => (when(a) ?? Infinity) - (when(b) ?? Infinity) || a.created_at - b.created_at;

function sections(items, v, now) {
  const today = startOfDay(now), tomorrow = addDays(today, 1);
  const groups = new Map();
  const put = (key, title, tone, r) => {
    if (!groups.has(key)) groups.set(key, { key, title, tone, items: [] });
    groups.get(key).items.push(r);
  };
  for (const r of [...items].sort(byWhen)) {
    const t = when(r);
    if (t != null && t < now) { put("late", "En retard", "late", r); continue; }
    if (v === "today") { put("today", "Plus tard aujourd'hui", "", r); continue; }
    if (v === "scheduled") { const d = startOfDay(t); put(`d${d}`, dayLabel(d, now), d === today ? "accent" : "", r); continue; }
    if (t == null) put("none", "Sans date", "", r);
    else if (t < tomorrow) put("today", "Aujourd'hui", "accent", r);
    else if (t < addDays(today, 2)) put("tomorrow", "Demain", "", r);
    else if (t < addDays(today, 7)) put("week", "Cette semaine", "", r);
    else put("later", "Plus tard", "", r);
  }
  const out = [...groups.values()];
  if (out.length === 1 && out[0].key === "none") out[0].title = "";
  return out;
}

/* ══ Rendu ═══════════════════════════════════════════════════ */

const listEl = $("list");

function rowHtml(r, now, showList, compact) {
  const l = listOf(r.list_id);
  const t = when(r);
  const meta = [];
  if (t != null && !r.done) {
    const late = t < now;
    const label = compact && !late ? hhmm(t) : fmtDue(t, now);   // le jour est déjà dans le titre de section
    meta.push(`<span class="due${late ? " late" : ""}">${r.snooze ? I.snooze : ""}${esc(label)}</span>`);
  } else if (r.done && r.done_at) {
    meta.push(`<span>Fait ${esc(dayLabel(r.done_at, now).toLowerCase())}, ${hhmm(r.done_at)}</span>`);
  }
  if (r.repeat && !r.done) meta.push(`<span class="rep">${I.repeat}${esc(repeatLabel(r.repeat))}</span>`);
  if (showList) meta.push(`<span class="lst"><i style="background:${l.color}"></i>${esc(l.name)}</span>`);
  if (r.notes) meta.push(`<span class="nt">${esc(r.notes.split("\n")[0])}</span>`);
  const cls = ["row", r.done ? "done" : "", checking.has(r.id) ? "checking" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" data-id="${r.id}" style="--c:${l.color}">
    <div class="row-actions">
      <button class="act act-snooze" aria-label="Me le redire plus tard">${I.snooze}<span>Plus tard</span></button>
      <button class="act act-del" aria-label="Supprimer">${I.trash}<span>Supprimer</span></button>
    </div>
    <div class="row-main">
      <button class="check" aria-label="${r.done ? "Rouvrir" : "Cocher"}">${I.check}</button>
      <div class="row-text">
        <div class="row-title">${esc(r.title)}</div>
        ${meta.length ? `<div class="row-meta">${meta.join("")}</div>` : ""}
      </div>
    </div>
  </div>`;
}

function emptyHtml(v, anyDone) {
  if (anyDone) return `<div class="empty-state"><div class="empty-emoji">✨</div><b>Tout est fait</b><p>Rien d'autre ici. Bravo.</p></div>`;
  if (v === "today") return `<div class="empty-state"><div class="empty-emoji">☀️</div><b>Rien pour aujourd'hui</b>
    <p>Écris ou dicte un rappel en bas, comme tu le dirais :<br><span class="ex">demain 15h appeler maman</span></p></div>`;
  return `<div class="empty-state"><div class="empty-emoji">🗒️</div><b>Aucun rappel</b><p>Ajoute-en un en bas.</p></div>`;
}

function render() {
  const st = S.getState();
  const now = Date.now();
  const all = views();
  if (!all.some((v) => v.id === view)) view = "today";
  const v = all.find((x) => x.id === view);

  $("title").textContent = v.name;
  $("bar-title").textContent = v.name;
  document.documentElement.style.setProperty("--view", v.color || "var(--accent)");

  const pending = st.reminders.filter((r) => !r.done);
  const lateCount = pending.filter((r) => when(r) != null && when(r) < now).length;

  /* Sous-titre */
  const sub = v.id === "today"
    ? new Date(now).toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long" })
    : "";
  $("subtitle").textContent = sub;
  $("subtitle").hidden = !sub;

  /* Pastilles */
  $("pills").innerHTML = all.map((x) => {
    const n = pending.filter((r) => inView(r, x.id, now)).length;
    const late = x.id === "today" && lateCount > 0;
    return `<button class="pill${x.id === view ? " on" : ""}" data-view="${x.id}" ${x.color ? `style="--c:${x.color}"` : ""}>
      ${x.color ? '<i class="pdot"></i>' : ""}<span>${esc(x.name)}</span>${n ? `<b class="${late ? "late" : ""}">${n}</b>` : ""}</button>`;
  }).join("") + `<button class="pill add" data-new-list aria-label="Nouvelle liste">${I.plus}</button>`;

  /* Rappels */
  const items = pending.filter((r) => inView(r, view, now));
  const showList = !v.list;
  const done = st.reminders.filter((r) => r.done && inView({ ...r, snooze: null, due: r.due ?? null }, view === "today" || view === "scheduled" ? "all" : view, now))
    .filter((r) => view !== "today" || (r.done_at && r.done_at >= startOfDay(now)))
    .sort((a, b) => b.done_at - a.done_at);

  let html = "";
  if (!items.length) html += emptyHtml(view, done.length > 0);
  for (const s of sections(items, view, now)) {
    html += `<section class="sec">${s.title ? `<h2 class="sec-h ${s.tone}">${esc(s.title)}<small>${s.items.length}</small></h2>` : ""}
      <div class="card">${s.items.map((r) => rowHtml(r, now, showList, s.key === "today" || s.key.startsWith("d"))).join("")}</div></section>`;
  }
  if (done.length) {
    html += `<section class="sec done-sec"><button class="done-toggle" id="done-toggle" aria-expanded="${showDone}">
        <span>${view === "today" ? "Faits aujourd'hui" : "Terminés"} · ${done.length}</span>
        <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
      ${showDone ? `<div class="card">${done.map((r) => rowHtml(r, now, showList)).join("")}</div>` : ""}</section>`;
  }
  listEl.innerHTML = html;

  if (lastNewId) {
    const el = listEl.querySelector(`.row[data-id="${lastNewId}"]`);
    if (el && !REDUCED.matches) {
      el.animate([{ transform: "translateY(10px) scale(.98)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 380, easing: "cubic-bezier(.2,.9,.25,1)" });
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    lastNewId = null;
  }

  renderBanner();
  renderComposer();
  if ("setAppBadge" in navigator) {
    try { lateCount ? navigator.setAppBadge(lateCount) : navigator.clearAppBadge(); } catch (_) {}
  }
}

function renderBanner() {
  const b = $("banner");
  const status = S.getStatus();
  let msg = "", act = null, tone = "";
  if (status === "badkey") { msg = "Clé refusée par le serveur. Touche pour la changer."; act = () => { S.forgetToken(); showSetup(); }; tone = "bad"; }
  else if (status === "offline" && S.pending()) { msg = `Hors ligne · ${S.pending()} modif${S.pending() > 1 ? "s" : ""} en attente`; act = () => S.sync(); tone = "warn"; }
  else if (status === "error") { msg = "Serveur injoignable. Nouvel essai bientôt."; act = () => S.sync(); tone = "warn"; }
  else if (isIOS && !isStandalone) { msg = "Ajoute Rappels à l'écran d'accueil pour recevoir les notifs."; act = openSettings; }
  else if (pushCapable && !pushOn && Notification.permission !== "denied") { msg = "Active les notifications pour être averti à l'heure."; act = enablePush; }
  b.hidden = !msg;
  b.className = `banner ${tone}`;
  b.innerHTML = msg ? `${I.snooze}<span>${esc(msg)}</span>` : "";
  b.onclick = act;
  $("settings-dot").hidden = !(pushCapable && !pushOn) && status !== "badkey";
}

/* ══ Interactions sur les rangées ════════════════════════════ */

$("pills").addEventListener("click", (e) => {
  const p = e.target.closest(".pill");
  if (!p) return;
  if (p.hasAttribute("data-new-list")) { openNewList(); return; }
  if (p.dataset.view === view) return;
  view = p.dataset.view;
  lsSet("rp-view", view);
  showDone = false;
  composerList = null;
  closeOpenRow();
  render();
  $("scroll").scrollTo({ top: 0, behavior: REDUCED.matches ? "auto" : "smooth" });
  p.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  if (!REDUCED.matches) listEl.animate([{ opacity: 0.4, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
});

let justSwiped = 0;
listEl.addEventListener("click", (e) => {
  if (Date.now() - justSwiped < 350) return;
  if (e.target.closest("#done-toggle")) { showDone = !showDone; render(); return; }
  const row = e.target.closest(".row");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest(".act-del")) { closeOpenRow(true); removeWithUndo(id, row); return; }
  if (e.target.closest(".act-snooze")) { closeOpenRow(); openSnooze(id); return; }
  if (openRow) { closeOpenRow(); return; }
  if (e.target.closest(".check")) { onCheck(id, row); return; }
  if (e.target.closest(".row-main")) openDetail(id);
});

function onCheck(id, row) {
  const r = findR(id);
  if (!r) return;
  if (r.done) { S.undoComplete(id, { rolled: false }); buzz(8); return; }
  if (checking.has(id)) {                       // re-toucher pendant le délai = annuler
    clearTimeout(checking.get(id));
    checking.delete(id);
    row.classList.remove("checking");
    return;
  }
  row.classList.add("checking");
  pop(row.querySelector(".check"), 1.25, 0.5);
  buzz(12);
  const recurring = !!(r.repeat && r.due);
  checking.set(id, setTimeout(async () => {
    checking.delete(id);
    const cur = listEl.querySelector(`.row[data-id="${id}"]`);
    if (!recurring) await collapse(cur);
    const info = S.completeReminder(id);
    if (!info) return;
    const msg = info.rolled ? `Prochain : ${fmtDue(info.next)}` : `« ${short(r.title)} » fait`;
    toast(msg, { action: "Annuler", onAction: () => S.undoComplete(id, info) });
  }, recurring ? 600 : 650));
}

function collapse(row) {
  if (!row || REDUCED.matches) return Promise.resolve();
  const h = row.offsetHeight;
  row.style.overflow = "hidden";
  return row.animate(
    [{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
    { duration: 260, easing: "cubic-bezier(.3,.7,.2,1)", fill: "forwards" },
  ).finished.catch(() => {});
}

async function removeWithUndo(id, row) {
  await collapse(row);
  const r = S.deleteReminder(id);
  if (r) toast(`« ${short(r.title)} » supprimé`, { action: "Annuler", onAction: () => S.restoreReminder(r) });
}

/* ── Glisser une rangée vers la gauche : Plus tard / Supprimer ──
   Suit le doigt au pixel, élastique aux bords, et au relâchement
   la vitesse projetée choisit ouvert ou fermé. */
const OPEN_W = 168;
let g = null, openRow = null;

function springOf(main) {
  if (!main._sp) {
    main._sp = new Spring(0, {
      response: 0.32, damping: 1, restDelta: 0.5,
      onUpdate: (x) => { main.style.transform = Math.abs(x) < 0.5 ? "" : `translate3d(${x}px,0,0)`; },
    });
  }
  return main._sp;
}

function closeOpenRow(instant) {
  if (!openRow) return;
  const sp = springOf(openRow);
  if (instant) sp.hold(0); else sp.to(0, { damping: 1 });
  openRow.parentElement?.classList.remove("open");
  openRow = null;
}

listEl.addEventListener("pointerdown", (e) => {
  const main = e.target.closest(".row-main");
  if (!main || e.button > 0 || main.closest(".done")) return;
  if (openRow && openRow !== main) closeOpenRow();
  g = { main, pid: e.pointerId, x0: e.clientX, y0: e.clientY, from: springOf(main).x, tr: tracker(), dir: null };
  g.tr.add(e.clientX, e.timeStamp);
});
listEl.addEventListener("pointermove", (e) => {
  if (!g || e.pointerId !== g.pid) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.dir) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      g.dir = "x";
      capture(g.main, e.pointerId);
      g.main.parentElement.classList.add("open");
    } else if (Math.abs(dy) > 10) { g = null; return; }
    else return;
  }
  g.tr.add(e.clientX, e.timeStamp);
  let x = g.from + dx;
  if (x > 0) x = rubberband(x, 60);
  else if (x < -OPEN_W) x = -OPEN_W - rubberband(-OPEN_W - x, 140);
  springOf(g.main).hold(x);
});
const endDrag = (e) => {
  if (!g || e.pointerId !== g.pid) return;
  const { main, dir } = g;
  if (dir === "x") {
    justSwiped = Date.now();
    const sp = springOf(main);
    const v = g.tr.velocity();
    const open = sp.x + project(v) < -OPEN_W / 2;
    sp.to(open ? -OPEN_W : 0, { velocity: v, damping: open && Math.abs(v) > 300 ? 0.82 : 1 });
    if (open) openRow = main;
    else { main.parentElement.classList.remove("open"); if (openRow === main) openRow = null; }
  }
  g = null;
};
listEl.addEventListener("pointerup", endDrag);
listEl.addEventListener("pointercancel", endDrag);

/* ══ Plus tard (snooze) ══════════════════════════════════════ */

function snoozeChoices(now = Date.now()) {
  const at = (days, h, m = 0) => { const d = new Date(addDays(startOfDay(now), days)); d.setHours(h, m, 0, 0); return d.getTime(); };
  const out = [
    ["10 min", now + 10 * 60e3],
    ["1 h", now + 60 * 60e3],
    ["3 h", now + 3 * 3600e3],
  ];
  if (now < at(0, 18)) out.push(["Ce soir", at(0, 19)]);
  out.push(["Demain", at(1, 9)]);
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  if (toMonday > 2) out.push(["Lundi", at(toMonday, 9)]);
  return out;
}

const snoozeButtons = (now) => snoozeChoices(now).map(([label, t]) =>
  `<button class="snz" data-t="${t}"><b>${label}</b><small>${esc(fmtDue(t, now))}</small></button>`).join("");

function doSnooze(id, t) {
  S.snoozeReminder(id, t);
  buzz(10);
  toast(`Je te le redis ${fmtDue(t).replace(/^./, (c) => c.toLowerCase())}`);
}

function openSnooze(id) {
  const r = findR(id);
  if (!r) return;
  openSheet(`
    <div class="sheet-head"><span class="head-btn"></span><span class="sheet-title">Me le redire…</span><button class="head-btn strong" data-close>OK</button></div>
    <div class="sheet-body"><p class="sheet-sub">${esc(r.title)}</p><div class="snz-grid">${snoozeButtons(Date.now())}</div></div>`,
  (sh) => sh.querySelectorAll(".snz").forEach((b) => b.addEventListener("click", () => { doSnooze(id, +b.dataset.t); closeSheet(); })));
}

/* ══ Détail d'un rappel ══════════════════════════════════════ */

function openDetail(id, { fromPush = false } = {}) {
  const r = findR(id);
  if (!r) { if (fromPush) toast("Ce rappel n'existe plus."); return; }
  const st = S.getState();
  const now = Date.now();
  const custom = r.repeat?.startsWith("days:") ? [[r.repeat, repeatLabel(r.repeat)]] : [];
  const repeatOpts = [...REPEAT_CHOICES, ...custom]
    .map(([k, label]) => `<option value="${k}"${(r.repeat || "") === k ? " selected" : ""}>${esc(label)}</option>`).join("");
  const listOpts = st.lists.map((l) => `<option value="${l.id}"${l.id === r.list_id ? " selected" : ""}>${esc(l.name)}</option>`).join("");
  const t = when(r);
  const late = t != null && t < now && !r.done;

  openSheet(`
    <div class="sheet-head">
      <button class="head-btn" data-close>Fermer</button>
      <span class="sheet-title"></span>
      <button class="head-btn strong" id="d-done">${r.done ? "Rouvrir" : "C'est fait"}</button>
    </div>
    <div class="sheet-body detail" style="--c:${listOf(r.list_id).color}">
      <textarea class="d-title" id="d-title" rows="1" enterkeyhint="done">${esc(r.title)}</textarea>
      <textarea class="d-notes" id="d-notes" rows="1" placeholder="Notes">${esc(r.notes)}</textarea>
      ${t != null && !r.done ? `
        <div class="d-when${late ? " late" : ""}">${r.snooze ? I.snooze : I.clock}<span>${r.snooze ? "Reporté à " : ""}${esc(fmtDue(t, now))}</span></div>
        <h3 class="set-h">Me le redire</h3>
        <div class="snz-grid compact">${snoozeButtons(now)}</div>` : ""}
      <h3 class="set-h">Quand</h3>
      <div class="set-card">
        <label class="set-line"><span>${I.cal}Date et heure</span>
          <input type="datetime-local" id="d-due" value="${toInput(r.due)}"></label>
        <label class="set-line${r.due ? "" : " off"}" id="d-repeat-line"><span>${I.repeat}Répéter</span>
          <select id="d-repeat"${r.due ? "" : " disabled"}>${repeatOpts}</select></label>
        <label class="set-line"><span>${I.list}Liste</span><select id="d-list">${listOpts}</select></label>
      </div>
      <div class="quick">
        <button data-q="tonight">Ce soir</button><button data-q="tomorrow">Demain 9 h</button>
        <button data-q="monday">Lundi 9 h</button><button data-q="none">Sans date</button>
      </div>
      <button class="ghost-btn danger wide" id="d-del">${I.trash}Supprimer</button>
    </div>`,
  (sh) => {
    const title = sh.querySelector("#d-title"), notes = sh.querySelector("#d-notes");
    const grow = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
    [title, notes].forEach((el) => { grow(el); el.addEventListener("input", () => grow(el)); });
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
    title.addEventListener("change", () => { const v = title.value.trim(); if (v && v !== r.title) S.updateReminder(id, { title: v }); });
    notes.addEventListener("change", () => S.updateReminder(id, { notes: notes.value }));

    const due = sh.querySelector("#d-due"), rep = sh.querySelector("#d-repeat");
    const setDue = (ms) => {
      S.updateReminder(id, { due: ms });
      due.value = toInput(ms);
      rep.disabled = !ms;
      sh.querySelector("#d-repeat-line").classList.toggle("off", !ms);
      if (!ms) rep.value = "";
    };
    due.addEventListener("change", () => setDue(fromInput(due.value)));
    rep.addEventListener("change", () => S.updateReminder(id, { repeat: rep.value || null }));
    sh.querySelector("#d-list").addEventListener("change", (e) => {
      S.updateReminder(id, { listId: e.target.value });
      sh.querySelector(".detail").style.setProperty("--c", listOf(e.target.value).color);
    });

    sh.querySelectorAll(".quick button").forEach((b) => b.addEventListener("click", () => {
      const n = Date.now();
      const at = (days, h) => { const d = new Date(addDays(startOfDay(n), days)); d.setHours(h, 0, 0, 0); return d.getTime(); };
      const toMonday = ((8 - new Date(n).getDay()) % 7) || 7;
      const q = b.dataset.q;
      const ms = q === "tonight" ? (n < at(0, 19) ? at(0, 19) : at(0, new Date(n).getHours() + 1))
        : q === "tomorrow" ? at(1, 9) : q === "monday" ? at(toMonday, 9) : null;
      setDue(ms);
      pop(b, 1.08);
      buzz(8);
    }));

    sh.querySelectorAll(".snz").forEach((b) => b.addEventListener("click", () => { doSnooze(id, +b.dataset.t); closeSheet(); }));
    sh.querySelector("#d-done").addEventListener("click", () => {
      closeSheet();
      const cur = findR(id);
      if (!cur) return;
      if (cur.done) { S.undoComplete(id, { rolled: false }); return; }
      const info = S.completeReminder(id);
      toast(info.rolled ? `Prochain : ${fmtDue(info.next)}` : `« ${short(cur.title)} » fait`,
        { action: "Annuler", onAction: () => S.undoComplete(id, info) });
    });
    sh.querySelector("#d-del").addEventListener("click", () => {
      closeSheet();
      const gone = S.deleteReminder(id);
      if (gone) toast(`« ${short(gone.title)} » supprimé`, { action: "Annuler", onAction: () => S.restoreReminder(gone) });
    });
  }, {
    onClose: () => {},
  });
}

/* ══ Listes ══════════════════════════════════════════════════ */

function openNewList(onCreated) {
  openSheet(`
    <div class="sheet-head"><button class="head-btn" data-close>Annuler</button><span class="sheet-title">Nouvelle liste</span><button class="head-btn strong" id="nl-ok" disabled>Créer</button></div>
    <div class="sheet-body"><label class="field"><span>Nom</span><input id="nl-name" placeholder="ex. Gym, Appart, Travail" autofocus enterkeyhint="done"></label></div>`,
  (sh) => {
    const inp = sh.querySelector("#nl-name"), ok = sh.querySelector("#nl-ok");
    inp.addEventListener("input", () => { ok.disabled = !inp.value.trim(); });
    const go = () => {
      const name = inp.value.trim(); if (!name) return;
      const l = S.addList(name);
      closeSheet();
      if (onCreated) { onCreated(l); return; }
      view = `l:${l.id}`; lsSet("rp-view", view);
      render();
    };
    ok.addEventListener("click", go);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    setTimeout(() => inp.focus(), 50);
  });
}

/* ══ Réglages ════════════════════════════════════════════════ */

function openSettings() {
  const st = S.getState();
  const status = { ok: "Synchronisé", sync: "Synchro…", offline: "Hors ligne", badkey: "Clé refusée", error: "Serveur injoignable" }[S.getStatus()];
  let notif;
  if (isIOS && !isStandalone) {
    notif = `<p class="note">Sur iPhone, les notifications marchent seulement quand l'app est ouverte depuis l'écran d'accueil :
      <b>Partager</b> → <b>Sur l'écran d'accueil</b>, puis ouvre Rappels de là.</p>`;
  } else if (!pushCapable) {
    notif = `<p class="note">Ce navigateur ne gère pas les notifications web.</p>`;
  } else if (Notification.permission === "denied") {
    notif = `<p class="note">Notifications bloquées. Va dans <b>Réglages iOS → Notifications → Rappels</b> pour les réactiver.</p>`;
  } else if (pushOn) {
    notif = `<div class="set-card"><div class="set-line"><span>Notifications</span><b class="ok">Activées</b></div></div>
      <button class="ghost-btn wide" id="s-test">Envoyer une notif test</button>`;
  } else {
    notif = `<button class="primary-btn wide" id="s-enable">Activer les notifications</button>`;
  }

  openSheet(`
    <div class="sheet-head"><span class="head-btn"></span><span class="sheet-title">Réglages</span><button class="head-btn strong" data-close>OK</button></div>
    <div class="sheet-body">
      <h3 class="set-h">Notifications</h3>${notif}
      <h3 class="set-h">Listes</h3>
      <div class="set-card lists-edit">${st.lists.map((l) => `
        <div class="set-line le" data-id="${l.id}">
          <button class="le-dot" style="--c:${l.color}" aria-label="Changer la couleur"></button>
          <input class="le-name" value="${esc(l.name)}" enterkeyhint="done">
          <button class="le-del" aria-label="Supprimer la liste">${I.trash}</button>
        </div>`).join("")}
      </div>
      <form class="add-row" id="s-add"><input id="s-add-name" placeholder="Nouvelle liste"><button class="add-btn" aria-label="Ajouter">${I.plus}</button></form>
      <h3 class="set-h">Ajouter un rappel</h3>
      <p class="note">Écris ou dicte comme tu parles : <span class="ex">demain 15h appeler maman</span>
        <span class="ex">chaque mardi soir sortir le recyclage</span> <span class="ex">dans 20 min sortir le linge</span>
        <span class="ex">le 28 oct 10h30 remettre le labo #école</span><br>
        Tu peux aussi le demander à Claude : <i>« ajoute un rappel… »</i></p>
      <h3 class="set-h">Connexion</h3>
      <div class="set-card">
        <div class="set-line"><span>État</span><b>${status}${S.pending() ? ` · ${S.pending()} en attente` : ""}</b></div>
        <div class="set-line"><span>Serveur</span><code class="code">${esc(S.apiUrl().replace(/^https?:\/\//, ""))}</code></div>
      </div>
      <button class="ghost-btn wide" id="s-sync">Synchroniser maintenant</button>
      <button class="ghost-btn danger wide" id="s-key">Changer de clé</button>
      <p class="note center">Rappels ${VERSION}</p>
    </div>`,
  (sh) => {
    sh.querySelector("#s-enable")?.addEventListener("click", async () => { await enablePush(); closeSheet(); });
    sh.querySelector("#s-test")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await S.testPush(); toast(r.sent ? "Notif envoyée — regarde ton écran" : "Aucun appareil abonné. Réactive les notifs."); }
      catch (_) { toast("Serveur injoignable"); }
      e.target.disabled = false;
    });
    sh.querySelector("#s-sync").addEventListener("click", async () => { await S.sync(); toast(S.getStatus() === "ok" ? "Synchronisé" : "Pas de réseau pour l'instant"); });
    sh.querySelector("#s-key").addEventListener("click", () => { closeSheet(); S.forgetToken(); showSetup(); });
    sh.querySelectorAll(".le").forEach((row) => {
      const id = row.dataset.id;
      row.querySelector(".le-dot").addEventListener("click", (e) => {
        const l = listOf(id);
        const c = S.LIST_COLORS[(S.LIST_COLORS.indexOf(l.color) + 1) % S.LIST_COLORS.length];
        S.updateList(id, { color: c });
        e.currentTarget.style.setProperty("--c", c);
        pop(e.currentTarget, 1.2);
      });
      const name = row.querySelector(".le-name");
      name.addEventListener("change", () => { const v = name.value.trim(); if (v) S.updateList(id, { name: v }); else name.value = listOf(id).name; });
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
      row.querySelector(".le-del").addEventListener("click", () => {
        const n = S.getState().reminders.filter((r) => r.list_id === id && !r.done).length;
        if (S.getState().lists.length <= 1) { toast("Il faut garder au moins une liste."); return; }
        if (n && !confirm(`Supprimer « ${listOf(id).name} » et ses ${n} rappel${n > 1 ? "s" : ""} ?`)) return;
        S.deleteList(id);
        row.remove();
      });
    });
    sh.querySelector("#s-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = sh.querySelector("#s-add-name");
      const v = inp.value.trim(); if (!v) return;
      S.addList(v); closeSheet(); setTimeout(openSettings, 380);
    });
  });
}

/* ══ Notifications push ══════════════════════════════════════ */

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushCapable) { openSettings(); return; }
  if (isIOS && !isStandalone) { openSettings(); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications refusées"); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await S.vapidKey()) });
    if (!(await S.saveSubscription(sub))) throw new Error("abonnement refusé");
    pushOn = true;
    buzz([10, 40, 10]);
    toast("Notifications activées 🔔");
  } catch (e) {
    toast(`Impossible d'activer : ${e.message || e}`);
  }
  render();
}

/* Au lancement : si déjà permis, on revalide l'abonnement auprès du
   serveur (il a pu changer, ou la base a été recréée). */
async function refreshPush() {
  if (!pushCapable || Notification.permission !== "granted") { pushOn = false; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await S.vapidKey()) });
    pushOn = await S.saveSubscription(sub);
  } catch (_) { pushOn = false; }
}

/* ══ Compositeur ═════════════════════════════════════════════
   En tapant, la phrase est lue en direct et une rangée de pastilles
   propose : une correction d'orthographe, l'heure habituelle, une
   date rapide, la répétition et la liste. Au-dessus, les anciens
   rappels qui commencent pareil. Ce qu'on touche l'emporte sur ce
   que la phrase disait. Le clavier reste ouvert pendant tout ça. */

const input = $("composer-input"), chips = $("chips"), sugg = $("suggest"), sendBtn = $("send"), dotBtn = $("composer-list");
const composerEl = $("composer");
let manual = {};            // choix touchés pour CE rappel : due, repeat, listId
let composerList = null;    // liste choisie, gardée d'un ajout à l'autre
let composerFocus = false;

function defaultList() {
  if (composerList && S.getState().lists.some((l) => l.id === composerList)) return composerList;
  if (view.startsWith("l:")) return view.slice(2);
  return S.getState().lists[0]?.id;
}

function draft() {
  const raw = input.value;
  const p = raw.trim() ? parse(raw, { lists: S.getState().lists }) : { title: "", due: null, repeat: null, listId: null };
  const due = "due" in manual ? manual.due : p.due;
  const repeat = due ? ("repeat" in manual ? manual.repeat : p.repeat) : null;
  return { title: p.title, due, repeat, listId: manual.listId || p.listId || defaultList(), parsed: p };
}

const atDay = (days, h, m = 0, now = Date.now()) => {
  const d = new Date(addDays(startOfDay(now), days)); d.setHours(h, m, 0, 0); return d.getTime();
};

function quickDates(now = Date.now()) {
  const out = [];
  if (new Date(now).getHours() < 18) out.push(["Ce soir", atDay(0, 19, 0, now)]);
  else { const d = new Date(now + 3600e3); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); out.push([`À ${hhmm(d.getTime())}`, d.getTime()]); }
  out.push(["Demain 9 h", atDay(1, 9, 0, now)]);
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  if (toMonday > 1) out.push(["Lundi 9 h", atDay(toMonday, 9, 0, now)]);
  return out;
}

/* Sous l'étiquette « Chaque », un mot suffit. */
const REPEAT_SHORT = [[null, "Non"], ["daily", "Jour"], ["weekdays", "Lun–ven"], ["weekly", "Semaine"], ["monthly", "Mois"], ["yearly", "Année"]];
const X_ICON = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>';

/* Une rangée titrée du panneau : « Quand », « Répéter », « Liste »… */
const panelRow = (label, body, cls = "") =>
  `<div class="cp-row${cls ? " " + cls : ""}"><span class="cp-label">${label}</span><div class="cp-chips">${body}</div></div>`;

function renderComposer() {
  const d = draft();
  const now = Date.now();
  const l = listOf(d.listId);
  dotBtn.style.setProperty("--c", l.color);
  dotBtn.setAttribute("aria-label", `Liste : ${l.name} (changer)`);
  sendBtn.disabled = !d.title;
  const typing = !!input.value.trim();
  composerEl.classList.toggle("active", typing || composerFocus);

  /* Complétion (sur le texte corrigé : « apeler » trouve « Appeler maman ») */
  const fix = typing && d.title ? Sg.spell(d.title) : null;
  const q = fix ? d.title.replace(fix.from, fix.to) : d.title;
  const comps = typing ? Sg.complete(q || input.value, 2) : [];
  sugg._items = comps;
  sugg.innerHTML = comps.map((e, i) => {
    const h = Sg.habit(e.t), lst = S.getState().lists.find((x) => x.id === e.l);
    const meta = [h ? hhmm(atDay(0, h.h, h.m)) : "", lst ? `<i style="background:${lst.color}"></i>${esc(lst.name)}` : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="sug" data-i="${i}">${I.history}<span>${esc(e.t)}</span>${meta ? `<small>${meta}</small>` : ""}</button>`;
  }).join("");

  const rows = [];

  /* Suggestions : seulement quand il y en a. */
  const sg = [];
  if (fix) sg.push(`<button type="button" class="chip fix" data-fix="${esc(fix.from)}" data-to="${esc(fix.to)}" aria-label="Corriger ${esc(fix.from)} en ${esc(fix.to)}">${I.pen}<s>${esc(fix.from)}</s>${esc(fix.to)}</button>`);
  const hab = typing && !d.due && d.title ? Sg.habit(d.title) : null;
  if (hab) {
    sg.push(`<button type="button" class="chip habit" data-due="${Sg.nextAt(hab.h, hab.m)}"${hab.repeat ? ` data-hrep="${hab.repeat}"` : ""}${hab.list ? ` data-hlist="${hab.list}"` : ""}>${I.history}${hhmm(atDay(0, hab.h, hab.m))} · ${hab.times > 1 ? "comme d'hab" : "comme la dernière fois"}</button>`);
  }
  if (sg.length) rows.push(panelRow("Idées", sg.join(""), "sg"));

  /* Quand : tout est visible, le choix actif est en couleur. */
  const quick = quickDates(now);
  const custom = d.due && !quick.some(([, t]) => t === d.due);
  const w = [`<button type="button" class="chip${d.due ? "" : " on"}" data-clear>Aucune</button>`];
  for (const [label, t] of quick) w.push(`<button type="button" class="chip${d.due === t ? " on" : ""}" data-due="${t}">${label}</button>`);
  w.push(custom
    ? `<label class="chip pick on">${I.cal}<span>${esc(fmtDue(d.due, now))}</span><input type="datetime-local" data-pick value="${toInput(d.due)}" aria-label="Changer la date"></label>`
    : `<label class="chip pick">${I.cal}<span>Autre date…</span><input type="datetime-local" data-pick aria-label="Choisir une date"></label>`);
  rows.push(panelRow("Quand", w.join("")));

  /* Répéter */
  const rp = REPEAT_SHORT.map(([v, label]) =>
    `<button type="button" class="chip${(d.repeat || null) === v ? " on" : ""}" data-rep="${v ?? ""}">${label}</button>`);
  if (d.repeat && !REPEAT_SHORT.some(([v]) => v === d.repeat)) rp.push(`<button type="button" class="chip on" data-rep="${d.repeat}">${esc(repeatLabel(d.repeat))}</button>`);
  rows.push(panelRow("Chaque", rp.join("")));

  /* Liste */
  const ls = S.getState().lists.map((x) =>
    `<button type="button" class="chip lst${x.id === d.listId ? " on" : ""}" data-list="${x.id}" style="--c:${x.color}"><i></i>${esc(x.name)}</button>`);
  ls.push(`<button type="button" class="chip add" data-new-list aria-label="Nouvelle liste">${I.plus}</button>`);
  rows.push(panelRow("Liste", ls.join("")));

  chips.innerHTML = rows.join("");
}

/* Toucher une pastille ne doit pas fermer le clavier. */
const keepFocus = () => { if (composerFocus) input.focus({ preventScroll: true }); };
for (const el of [chips, sugg, dotBtn]) {
  for (const ev of ["pointerdown", "mousedown"]) {
    el.addEventListener(ev, (e) => { if (!e.target.closest("[data-pick]")) e.preventDefault(); });
  }
}

input.addEventListener("input", () => {
  if (!input.value.trim()) manual = {};          // champ vidé : on repart de zéro
  renderComposer();
});
input.addEventListener("focus", () => { composerFocus = true; renderComposer(); });
input.addEventListener("blur", () => setTimeout(() => {
  composerFocus = document.activeElement === input;
  if (!composerFocus) renderComposer();
}, 180));

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

chips.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = draft();
  const ds = b.dataset;
  if (ds.fix) {
    const re = new RegExp(`(^|[^\\p{L}])(${reEsc(ds.fix)})(?![\\p{L}])`, "iu");
    input.value = input.value.replace(re, (_, pre, w) => pre + (w[0] === w[0].toLowerCase() ? ds.to.toLowerCase() : ds.to));
  } else if ("newList" in ds) {
    openNewList((l) => { manual.listId = l.id; composerList = l.id; renderComposer(); });
    return;
  } else if (ds.due) {
    manual.due = +ds.due;
    if (ds.hrep && !("repeat" in manual)) manual.repeat = ds.hrep;
    if (ds.hlist && !manual.listId && !d.parsed.listId) manual.listId = ds.hlist;
  } else if ("clear" in ds) {
    manual.due = null;
  } else if (ds.list) {
    manual.listId = ds.list;
    composerList = ds.list;
  } else if ("rep" in ds) {
    manual.repeat = ds.rep || null;
    if (manual.repeat && !d.due) manual.due = Sg.nextAt(9, 0);   // une répétition a besoin d'une première date
  }
  buzz(6);
  renderComposer();
  keepFocus();
});
chips.addEventListener("change", (e) => {
  if (!e.target.matches("[data-pick]")) return;
  manual.due = fromInput(e.target.value);
  renderComposer();
});

sugg.addEventListener("click", (e) => {
  const b = e.target.closest(".sug");
  if (!b) return;
  const it = sugg._items[+b.dataset.i];
  const p = draft().parsed;
  if (p.due && !("due" in manual)) manual.due = p.due;          // « demain app… » garde son « demain »
  if (p.repeat && !("repeat" in manual)) manual.repeat = p.repeat;
  if (!manual.listId && !p.listId && S.getState().lists.some((l) => l.id === it.l)) manual.listId = it.l;
  input.value = it.t;
  buzz(6);
  renderComposer();
  keepFocus();
});

/* Le rond à gauche du champ : passe à la liste suivante. */
dotBtn.addEventListener("click", () => {
  const lists = S.getState().lists;
  const next = lists[(lists.findIndex((l) => l.id === draft().listId) + 1) % lists.length];
  manual.listId = next.id;
  composerList = next.id;
  pop(dotBtn, 1.25);
  buzz(6);
  renderComposer();
  keepFocus();
});

$("composer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const d = draft();
  if (!d.title) return;
  const r = S.addReminder({ title: tidy(d.title), due: d.due, repeat: d.repeat, listId: d.listId });
  Sg.remember(r);
  lastNewId = r.id;
  manual = {};
  input.value = "";
  buzz(10);
  pop(sendBtn, 1.2);
  if (!inView(r, view, Date.now())) {
    toast(`Ajouté à « ${listOf(r.list_id).name} »${r.due ? ` · ${fmtDue(r.due)}` : ""}`, {
      action: "Voir", onAction: () => { view = `l:${r.list_id}`; lsSet("rp-view", view); render(); },
    });
  }
  render();
});

/* Dictée : la reconnaissance vocale du navigateur, en français
   d'ici. (Le micro du clavier iOS marche aussi, partout.) */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (SR) {
  const mic = $("mic");
  mic.hidden = false;
  mic.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = "fr-CA";
    rec.interimResults = true;
    rec.continuous = false;
    const base = input.value.trim() ? input.value.trim() + " " : "";
    rec.onresult = (e) => {
      let txt = "";
      for (const res of e.results) txt += res[0].transcript;
      input.value = base + txt;
      renderComposer();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Micro refusé. Utilise le micro du clavier à la place.");
    };
    rec.onend = () => { rec = null; mic.classList.remove("on"); renderComposer(); };
    try { rec.start(); mic.classList.add("on"); buzz(8); } catch (_) { rec = null; }
  });
}

/* Le clavier iOS : on garde le compositeur collé au-dessus. */
if (window.visualViewport) {
  const vv = window.visualViewport, comp = $("composer");
  const fit = () => {
    const off = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    comp.style.transform = off > 1 ? `translate3d(0,${-off}px,0)` : "";
    document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    document.body.classList.toggle("kb", off > 1);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
}

/* ══ Mise en route ═══════════════════════════════════════════ */

function showSetup() {
  const setup = $("setup");
  setup.hidden = false;
  const m = location.hash.match(/cle=([\w-]+)/);
  const keyInput = $("setup-key");
  if (m) {
    keyInput.value = m[1];
    if (isIOS && !isStandalone) $("setup-safari").hidden = false;
  }
  $("copy-key").onclick = async (e) => {
    try { await navigator.clipboard.writeText(keyInput.value); e.target.textContent = "Clé copiée ✓"; buzz(10); }
    catch (_) { keyInput.select(); document.execCommand("copy"); e.target.textContent = "Clé copiée ✓"; }
  };
  $("paste-key").onclick = async () => {
    try { keyInput.value = (await navigator.clipboard.readText()).trim(); } catch (_) { keyInput.focus(); }
  };
  $("setup-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("setup-err");
    err.textContent = "";
    const k = keyInput.value.trim().replace(/^.*cle=/, "");
    if (!k) { err.textContent = "Colle d'abord ta clé."; return; }
    try {
      if (!(await S.tryToken(k))) { err.textContent = "Cette clé n'est pas la bonne."; return; }
    } catch (_) { err.textContent = "Serveur injoignable. Vérifie ta connexion."; return; }
    setup.hidden = true;
    Sg.seed(S.getState().reminders);
    history.replaceState(null, "", location.pathname);
    await refreshPush();
    render();
    if (pushCapable && !pushOn && (!isIOS || isStandalone)) setTimeout(enablePush, 400);
  };
}

$("open-settings").addEventListener("click", openSettings);
$("scroll").addEventListener("scroll", (e) => { $("app").classList.toggle("scrolled", e.target.scrollTop > 44); }, { passive: true });

S.onChange(() => {
  /* Pas de re-rendu pendant qu'on glisse une rangée. */
  if (g?.dir === "x") return;
  render();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "push") S.sync();
    if (e.data?.type === "open" && e.data.id) S.sync().then(() => openDetail(e.data.id, { fromPush: true }));
  });
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) { S.sync(); render(); } });
addEventListener("online", () => S.sync());
setInterval(() => { if (!document.hidden && !sheetIsOpen() && !checking.size && !g) render(); }, 30e3);
setInterval(() => { if (!document.hidden) S.sync(); }, 60e3);

(async function start() {
  render();
  if (!S.hasToken()) { showSetup(); return; }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  await S.sync();
  Sg.seed(S.getState().reminders);
  await refreshPush();
  render();
  const openId = new URLSearchParams(location.search).get("r");
  if (openId) {
    history.replaceState(null, "", location.pathname);
    openDetail(openId, { fromPush: true });
  }
})();
