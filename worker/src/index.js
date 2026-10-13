/* ============================================================
   Rappels — serveur (Cloudflare Worker + D1).

   - fetch     : l'API JSON utilisée par l'app et par le skill
                 /rappel de Claude (protégée par une clé).
   - scheduled : toutes les minutes, envoie une notif pour chaque
                 rappel arrivé à échéance.
   ============================================================ */

import { sendPush } from "./push.js";
import { nextDue } from "./recur.js";

const COLORS = ["#0A84FF", "#FF9F0A", "#30D158", "#FF375F", "#BF5AF2", "#64D2FF", "#FFD60A", "#AC8E68"];
const REPEATS = /^(daily|weekdays|weekly|monthly|yearly|days:[0-6](,[0-6])*)$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const fail = (status, error) => json({ error }, status);

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const uid = () => crypto.randomUUID();

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/api/vapid") return json({ key: env.VAPID_PUBLIC });
    if (!path.startsWith("/api/")) return fail(404, "introuvable");

    const auth = req.headers.get("Authorization") || "";
    if (!env.TOKEN || auth !== `Bearer ${env.TOKEN}`) return fail(401, "clé invalide");

    if (path === "/api/transcribe" && req.method === "POST") {
      try { return await transcribe(req, env); } catch (e) { return fail(502, `transcription impossible : ${e.message}`); }
    }

    let body = {};
    if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
      try { body = await req.json(); } catch (_) { body = {}; }
    }
    try {
      return await route(req.method, path.split("/").slice(2), body, env);
    } catch (e) {
      return fail(e.status || 500, e.message || "erreur");
    }
  },

  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(notifyDue(env));
  },
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function route(method, seg, body, env) {
  const db = env.DB;
  const [res, id, action] = seg;

  if (res === "state" && method === "GET") return json(await state(db));

  if (res === "reminders") {
    if (!id && method === "POST") return json(await createReminder(db, body));
    if (id && !action && method === "PATCH") return json(await patchReminder(db, id, body));
    if (id && !action && method === "DELETE") {
      await db.prepare("DELETE FROM reminders WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (id && action === "complete" && method === "POST") return json(await complete(db, id, body));
    if (id && action === "uncomplete" && method === "POST") return json(await uncomplete(db, id));
    if (id && action === "snooze" && method === "POST") {
      const until = Number(body.until);
      if (!until) throw new HttpError(400, "until manquant");
      await db.prepare("UPDATE reminders SET snooze = ?, notified = 0, updated_at = ? WHERE id = ?")
        .bind(until, Date.now(), id).run();
      return json(await getReminder(db, id));
    }
  }

  if (res === "lists") {
    if (!id && method === "POST") return json(await createList(db, body));
    if (id && method === "PATCH") {
      const cur = await db.prepare("SELECT * FROM lists WHERE id = ?").bind(id).first();
      if (!cur) throw new HttpError(404, "liste introuvable");
      await db.prepare("UPDATE lists SET name = ?, color = ? WHERE id = ?")
        .bind(body.name?.trim() || cur.name, body.color || cur.color, id).run();
      return json({ ok: true });
    }
    if (id && method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM reminders WHERE list_id = ?").bind(id),
        db.prepare("DELETE FROM lists WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if (res === "subscribe") {
    if (method === "POST") {
      const { endpoint, keys } = body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, "abonnement incomplet");
      await db.prepare(`INSERT INTO subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
        .bind(endpoint, keys.p256dh, keys.auth, Date.now()).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(body.endpoint || "").run();
      return json({ ok: true });
    }
  }

  if (res === "test-push" && method === "POST") {
    const n = await broadcast(env, { title: "Ça marche 🎉", body: "Les notifications de Rappels sont activées.", tag: "test" });
    return json({ sent: n });
  }

  throw new HttpError(404, "route inconnue");
}

/* ── Lecture ─────────────────────────────────────────────── */

async function state(db) {
  const weekAgo = Date.now() - 7 * 864e5;
  const [lists, reminders] = await db.batch([
    db.prepare("SELECT * FROM lists ORDER BY position, created_at"),
    db.prepare("SELECT * FROM reminders WHERE done = 0 OR done_at > ? ORDER BY COALESCE(snooze, due) IS NULL, COALESCE(snooze, due), created_at").bind(weekAgo),
  ]);
  return { lists: lists.results, reminders: reminders.results, now: Date.now() };
}

const getReminder = (db, id) => db.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first();

/* `list` peut être un id ou un nom (« école », « Ecole ») — c'est
   ce qui permet au skill de Claude d'écrire juste le nom. Un nom
   inconnu crée la liste. */
async function resolveList(db, ref) {
  const lists = (await db.prepare("SELECT * FROM lists ORDER BY position").all()).results;
  if (!ref) return lists[0]?.id || (await createList(db, { name: "Perso" })).id;
  const hit = lists.find((l) => l.id === ref) || lists.find((l) => norm(l.name) === norm(ref));
  if (hit) return hit.id;
  return (await createList(db, { name: ref })).id;
}

async function createList(db, { id, name, color }) {
  name = String(name || "").trim();
  if (!name) throw new HttpError(400, "nom de liste manquant");
  const n = (await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS p FROM lists").first());
  const list = { id: id || uid(), name, color: color || COLORS[n.n % COLORS.length], position: n.p + 1, created_at: Date.now() };
  await db.prepare("INSERT INTO lists (id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(list.id, list.name, list.color, list.position, list.created_at).run();
  return list;
}

/* ── Écriture ────────────────────────────────────────────── */

function cleanRepeat(r) {
  if (r === undefined) return undefined;
  if (!r) return null;
  if (!REPEATS.test(r)) throw new HttpError(400, `répétition inconnue : ${r}`);
  return r;
}

async function createReminder(db, b) {
  const title = String(b.title || "").trim();
  if (!title) throw new HttpError(400, "titre manquant");
  const now = Date.now();
  const due = b.due ? Number(b.due) : null;
  const r = {
    id: b.id || uid(),
    list_id: await resolveList(db, b.list_id || b.list),
    title,
    notes: String(b.notes || ""),
    due,
    repeat: due ? cleanRepeat(b.repeat) ?? null : null,
    created_at: b.created_at || now,
  };
  /* Rejouer la même création (file d'attente hors ligne) ne crée
     pas de doublon : l'id vient du client. */
  await db.prepare(`INSERT INTO reminders (id, list_id, title, notes, due, repeat, notified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(r.id, r.list_id, r.title, r.notes, r.due, r.repeat, due && due <= now - 60000 ? 1 : 0, r.created_at, now).run();
  return getReminder(db, r.id);
}

async function patchReminder(db, id, b) {
  const cur = await getReminder(db, id);
  if (!cur) throw new HttpError(404, "rappel introuvable");
  const next = { ...cur };
  if (b.title !== undefined) next.title = String(b.title).trim() || cur.title;
  if (b.notes !== undefined) next.notes = String(b.notes);
  if (b.list_id !== undefined || b.list !== undefined) next.list_id = await resolveList(db, b.list_id || b.list);
  if (b.due !== undefined) {
    next.due = b.due ? Number(b.due) : null;
    if (next.due !== cur.due) { next.snooze = null; next.notified = next.due && next.due <= Date.now() - 60000 ? 1 : 0; }
  }
  const rep = cleanRepeat(b.repeat);
  if (rep !== undefined) next.repeat = rep;
  if (!next.due) next.repeat = null;
  await db.prepare(`UPDATE reminders SET title = ?, notes = ?, list_id = ?, due = ?, snooze = ?, repeat = ?, notified = ?, updated_at = ? WHERE id = ?`)
    .bind(next.title, next.notes, next.list_id, next.due, next.snooze, next.repeat, next.notified, Date.now(), id).run();
  return getReminder(db, id);
}

/* Cocher. Un rappel récurrent ne disparaît pas : il saute à sa
   prochaine occurrence. `body.due` = l'échéance que le client a
   cochée ; si elle ne correspond plus (requête rejouée), on ne
   saute pas deux fois. */
async function complete(db, id, body) {
  const cur = await getReminder(db, id);
  if (!cur) throw new HttpError(404, "rappel introuvable");
  const now = Date.now();
  if (cur.repeat && cur.due) {
    if (body.due !== undefined && Number(body.due) !== cur.due) return { ...cur, rolled: false };
    const nd = nextDue(cur.due, cur.repeat, now);
    if (nd) {
      await db.prepare("UPDATE reminders SET due = ?, snooze = NULL, notified = 0, done_at = ?, updated_at = ? WHERE id = ?")
        .bind(nd, now, now, id).run();
      return { ...(await getReminder(db, id)), rolled: true };
    }
  }
  await db.prepare("UPDATE reminders SET done = 1, done_at = ?, snooze = NULL, updated_at = ? WHERE id = ?")
    .bind(now, now, id).run();
  return getReminder(db, id);
}

async function uncomplete(db, id) {
  const now = Date.now();
  await db.prepare(`UPDATE reminders SET done = 0, done_at = NULL,
      notified = CASE WHEN due IS NOT NULL AND due > ? THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?`)
    .bind(now, now, id).run();
  return getReminder(db, id);
}

/* ── Notifications ───────────────────────────────────────── */

async function broadcast(env, message) {
  const subs = (await env.DB.prepare("SELECT * FROM subscriptions").all()).results;
  let ok = 0;
  for (const s of subs) {
    try {
      const status = await sendPush(s, message, env);
      if (status === 404 || status === 410) {
        await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(s.endpoint).run();
      } else if (status < 300) ok++;
      else console.log("push refusé", status, new URL(s.endpoint).host);
    } catch (e) {
      console.log("push en erreur", e.message);
    }
  }
  return ok;
}

export async function notifyDue(env) {
  const db = env.DB;
  const now = Date.now();
  /* 20 s d'avance : le cron part au début de la minute, un rappel
     de 15 h 00 sonne donc à 15 h 00 et pas à 15 h 01. */
  const due = (await db.prepare(`SELECT r.*, l.name AS list_name FROM reminders r
      LEFT JOIN lists l ON l.id = r.list_id
      WHERE r.done = 0 AND r.notified = 0 AND COALESCE(r.snooze, r.due) IS NOT NULL
        AND COALESCE(r.snooze, r.due) <= ?`).bind(now + 20000).all()).results;
  if (!due.length) return 0;

  const overdue = (await db.prepare(`SELECT COUNT(*) AS n FROM reminders
      WHERE done = 0 AND COALESCE(snooze, due) IS NOT NULL AND COALESCE(snooze, due) <= ?`).bind(now + 20000).first()).n;

  /* On marque d'abord : si l'envoi plante, on ne bombarde pas le
     téléphone en boucle à chaque minute. */
  await db.batch(due.map((r) => db.prepare("UPDATE reminders SET notified = 1 WHERE id = ?").bind(r.id)));
  for (const r of due) {
    await broadcast(env, {
      id: r.id,
      title: r.title,
      body: r.notes || r.list_name || "Rappel",
      tag: r.id,
      badge: overdue,
    });
  }
  return due.length;
}

/* ── Dictée ──────────────────────────────────────────────────
   L'app envoie l'enregistrement brut (mp4/AAC sur iPhone, webm
   ailleurs) ; Whisper le transcrit en français. Rien n'est gardé. */

const PROMPT = "Rappel : demain à 15 h, appeler maman. Chaque mardi soir, sortir le recyclage. Acheter du lait à l'épicerie.";

async function transcribe(req, env) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, "audio vide");
  if (buf.length > 5e6) return fail(413, "enregistrement trop long");
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: btoa(bin), task: "transcribe", language: "fr", initial_prompt: PROMPT,
  });
  return json({ text: String(out?.text || "").trim() });
}
