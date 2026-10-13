/* ============================================================
   store.js — l'état de l'app et sa synchro avec le serveur.

   Chaque modification s'applique tout de suite à l'écran (et dans
   localStorage), puis part dans une file d'attente envoyée au
   serveur dès que le réseau le permet. Hors ligne, l'app continue
   de marcher ; tout part au retour du réseau. Les ids viennent du
   client, donc rejouer une requête ne crée jamais de doublon.
   ============================================================ */

import { nextDue } from "./dates.js";

/* Adresse du serveur Cloudflare. Remplaçable pour un essai local :
   localStorage["rp-api"] = "http://127.0.0.1:8787" */
const DEFAULT_API = "https://rappels.emilerioux.workers.dev";

const K_STATE = "rp-state", K_OUT = "rp-outbox", K_TOKEN = "rp-token", K_API = "rp-api";

const read = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (_) { return fb; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

export const DEFAULT_LISTS = [
  { id: "perso", name: "Perso", color: "#0A84FF", position: 0 },
  { id: "ecole", name: "École", color: "#FF9F0A", position: 1 },
  { id: "epicerie", name: "Épicerie", color: "#30D158", position: 2 },
];

let state = read(K_STATE, null) || { lists: DEFAULT_LISTS, reminders: [] };
let outbox = read(K_OUT, []);
let token = (() => { try { return localStorage.getItem(K_TOKEN) || ""; } catch (_) { return ""; } })();
export const apiUrl = () => { try { return localStorage.getItem(K_API) || DEFAULT_API; } catch (_) { return DEFAULT_API; } };

/* ok | sync | offline | badkey | error */
let status = "sync";
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((f) => f());

export const getState = () => state;
export const getStatus = () => status;
export const pending = () => outbox.length;
export const hasToken = () => !!token;
const setStatus = (s) => { if (s !== status) { status = s; emit(); } };

function commit() { write(K_STATE, state); emit(); }

async function req(method, path, body, tk = token) {
  return fetch(apiUrl() + path, {
    method,
    headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
}

/* ── Clé ── */

export async function tryToken(tk) {
  tk = tk.trim();
  const res = await req("GET", "/api/state", null, tk);
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`serveur ${res.status}`);
  token = tk;
  try { localStorage.setItem(K_TOKEN, tk); } catch (_) {}
  const data = await res.json();
  state = { lists: data.lists, reminders: data.reminders };
  commit();
  setStatus("ok");
  return true;
}

export function forgetToken() {
  token = "";
  try { localStorage.removeItem(K_TOKEN); } catch (_) {}
  emit();
}

/* ── Synchro ── */

let syncing = null;
export function sync() {
  if (!token) return Promise.resolve();
  if (!syncing) syncing = run().finally(() => { syncing = null; });
  return syncing;
}

async function run() {
  if (outbox.length) setStatus("sync");
  while (outbox.length) {
    const op = outbox[0];
    let res;
    try { res = await req(op.m, op.p, op.b); } catch (_) { setStatus("offline"); return; }
    if (res.status === 401) { setStatus("badkey"); return; }
    if (res.status >= 500) { setStatus("error"); return; }
    outbox.shift();                     // 2xx, ou 4xx qui ne passera jamais : on passe
    write(K_OUT, outbox);
  }
  try {
    const res = await req("GET", "/api/state");
    if (res.status === 401) { setStatus("badkey"); return; }
    if (!res.ok) { setStatus("error"); return; }
    const data = await res.json();
    if (outbox.length) return;          // une modif est arrivée entre-temps : on garde la version locale
    state = { lists: data.lists, reminders: data.reminders };
    commit();
    setStatus("ok");
  } catch (_) { setStatus("offline"); }
}

function queue(m, p, b) {
  outbox.push({ m, p, b });
  write(K_OUT, outbox);
  sync();
}

/* ── Rappels ── */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const find = (id) => state.reminders.find((r) => r.id === id);

export function addReminder({ title, due = null, repeat = null, listId, notes = "" }) {
  const now = Date.now();
  const r = {
    id: uid(), list_id: listId || state.lists[0]?.id || "perso", title, notes,
    due, snooze: null, repeat: due ? repeat : null, done: 0, done_at: null,
    notified: due && due <= now - 60000 ? 1 : 0, created_at: now, updated_at: now,
  };
  state.reminders.push(r);
  commit();
  queue("POST", "/api/reminders", { id: r.id, title, due, repeat: r.repeat, list_id: r.list_id, notes, created_at: now });
  return r;
}

export function updateReminder(id, patch) {
  const r = find(id); if (!r) return;
  const body = {};
  if ("title" in patch) { r.title = patch.title; body.title = patch.title; }
  if ("notes" in patch) { r.notes = patch.notes; body.notes = patch.notes; }
  if ("listId" in patch) { r.list_id = patch.listId; body.list_id = patch.listId; }
  if ("due" in patch) {
    if (patch.due !== r.due) { r.snooze = null; r.notified = patch.due && patch.due <= Date.now() - 60000 ? 1 : 0; }
    r.due = patch.due; body.due = patch.due;
    if (!r.due) { r.repeat = null; }
  }
  if ("repeat" in patch) { r.repeat = r.due ? patch.repeat || null : null; body.repeat = r.repeat; }
  r.updated_at = Date.now();
  commit();
  queue("PATCH", `/api/reminders/${id}`, body);
}

/* Renvoie { rolled, prevDue } : un rappel récurrent saute à sa
   prochaine date au lieu de disparaître. */
export function completeReminder(id) {
  const r = find(id); if (!r) return null;
  const now = Date.now();
  const prevDue = r.due, prevSnooze = r.snooze;
  queue("POST", `/api/reminders/${id}/complete`, { due: r.due });
  if (r.repeat && r.due) {
    const nd = nextDue(r.due, r.repeat, now);
    if (nd) {
      Object.assign(r, { due: nd, snooze: null, notified: 0, done_at: now });
      commit();
      return { rolled: true, prevDue, prevSnooze, next: nd };
    }
  }
  Object.assign(r, { done: 1, done_at: now, snooze: null });
  commit();
  return { rolled: false, prevDue, prevSnooze };
}

export function undoComplete(id, info) {
  const r = find(id); if (!r || !info) return;
  if (info.rolled) {
    updateReminder(id, { due: info.prevDue });
    if (info.prevSnooze) snoozeReminder(id, info.prevSnooze);
    return;
  }
  Object.assign(r, { done: 0, done_at: null });
  commit();
  queue("POST", `/api/reminders/${id}/uncomplete`);
}

export function snoozeReminder(id, until) {
  const r = find(id); if (!r) return;
  Object.assign(r, { snooze: until, notified: 0 });
  commit();
  queue("POST", `/api/reminders/${id}/snooze`, { until });
}

export function deleteReminder(id) {
  const i = state.reminders.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const [r] = state.reminders.splice(i, 1);
  commit();
  queue("DELETE", `/api/reminders/${id}`);
  return r;
}

/* Annuler une suppression : on recrée à l'identique. */
export function restoreReminder(r) {
  state.reminders.push(r);
  commit();
  queue("POST", "/api/reminders", { id: r.id, title: r.title, due: r.due, repeat: r.repeat, list_id: r.list_id, notes: r.notes, created_at: r.created_at });
  if (r.snooze) queue("POST", `/api/reminders/${r.id}/snooze`, { until: r.snooze });
}

/* ── Listes ── */

const COLORS = ["#0A84FF", "#FF9F0A", "#30D158", "#FF375F", "#BF5AF2", "#64D2FF", "#FFD60A", "#AC8E68"];
export const LIST_COLORS = COLORS;

export function addList(name) {
  const l = { id: uid(), name, color: COLORS[state.lists.length % COLORS.length], position: state.lists.length, created_at: Date.now() };
  state.lists.push(l);
  commit();
  queue("POST", "/api/lists", { id: l.id, name: l.name, color: l.color });
  return l;
}

export function updateList(id, patch) {
  const l = state.lists.find((x) => x.id === id); if (!l) return;
  Object.assign(l, patch);
  commit();
  queue("PATCH", `/api/lists/${id}`, patch);
}

export function deleteList(id) {
  state.lists = state.lists.filter((l) => l.id !== id);
  state.reminders = state.reminders.filter((r) => r.list_id !== id);
  commit();
  queue("DELETE", `/api/lists/${id}`);
}

/* ── Notifications ── */

export async function vapidKey() {
  const res = await fetch(apiUrl() + "/api/vapid", { cache: "no-store" });
  return (await res.json()).key;
}
export const saveSubscription = async (sub) => (await req("POST", "/api/subscribe", sub.toJSON())).ok;
export const testPush = async () => (await req("POST", "/api/test-push", {})).json();

/* ── Dictée : l'audio part au serveur, le texte revient. ── */
export async function transcribe(blob, lists = []) {
  const res = await fetch(`${apiUrl()}/api/transcribe?lists=${encodeURIComponent(lists.join(", "))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "audio/mp4" },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `serveur ${res.status}`);
  return (await res.json()).text || "";
}
