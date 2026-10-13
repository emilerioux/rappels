-- Rappels — base D1 (SQLite). Toutes les dates en millisecondes UTC.

CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  due        INTEGER,            -- échéance (null = pas de notif)
  snooze     INTEGER,            -- « redis-le-moi » : remplace due pour la notif
  repeat     TEXT,               -- daily | weekdays | weekly | monthly | yearly | days:1,3
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    INTEGER,
  notified   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending ON reminders (done, notified);

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO lists (id, name, color, position, created_at) VALUES
  ('perso',    'Perso',    '#0A84FF', 0, 0),
  ('ecole',    'École',    '#FF9F0A', 1, 0),
  ('epicerie', 'Épicerie', '#30D158', 2, 0);
