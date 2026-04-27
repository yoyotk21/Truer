import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "sessions.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'New chat',
      total_cost  REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idx         INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, idx);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);
  _db = d;
  return d;
}

export type SessionRow = {
  id: string;
  title: string;
  total_cost: number;
  created_at: number;
  updated_at: number;
};

export type StoredMessage = {
  role: "user" | "assistant";
  content: unknown;
};

export function ensureSession(id: string, now: number): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, title, total_cost, created_at, updated_at)
       VALUES (?, 'New chat', 0, ?, ?)`,
    )
    .run(id, now, now);
}

export function setTitle(sessionId: string, title: string): void {
  db().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
}

export function addCost(sessionId: string, delta: number): void {
  db()
    .prepare(`UPDATE sessions SET total_cost = total_cost + ? WHERE id = ?`)
    .run(delta, sessionId);
}

export function nextIdx(sessionId: string): number {
  const row = db()
    .prepare<[string], { n: number | null }>(
      `SELECT MAX(idx) AS n FROM messages WHERE session_id = ?`,
    )
    .get(sessionId);
  return (row?.n ?? -1) + 1;
}

export function appendMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: unknown,
  now: number,
): void {
  const tx = db().transaction(() => {
    const idx = nextIdx(sessionId);
    db()
      .prepare(
        `INSERT INTO messages (session_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, idx, role, JSON.stringify(content), now);
    db().prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId);
  });
  tx();
}

export function listSessions(): SessionRow[] {
  return db()
    .prepare<[], SessionRow>(
      `SELECT id, title, total_cost, created_at, updated_at FROM sessions ORDER BY updated_at DESC`,
    )
    .all();
}

export function searchSessions(q: string): SessionRow[] {
  const escaped = q.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c);
  const like = `%${escaped}%`;
  return db()
    .prepare<[string, string], SessionRow>(
      `SELECT s.id, s.title, s.total_cost, s.created_at, s.updated_at
         FROM sessions s
        WHERE LOWER(s.title) LIKE ? ESCAPE '\\'
           OR EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.session_id = s.id
                   AND LOWER(m.content) LIKE ? ESCAPE '\\'
              )
        ORDER BY s.updated_at DESC`,
    )
    .all(like, like);
}

export type LoadedSession = {
  id: string;
  title: string;
  total_cost: number;
  created_at: number;
  updated_at: number;
  messages: StoredMessage[];
};

export function loadSession(id: string): LoadedSession | null {
  const session = db()
    .prepare<[string], SessionRow>(
      `SELECT id, title, total_cost, created_at, updated_at FROM sessions WHERE id = ?`,
    )
    .get(id);
  if (!session) return null;
  const rows = db()
    .prepare<[string], { role: string; content: string }>(
      `SELECT role, content FROM messages WHERE session_id = ? ORDER BY idx ASC`,
    )
    .all(id);
  const messages: StoredMessage[] = rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: JSON.parse(r.content),
  }));
  return { ...session, messages };
}

export function deleteSession(id: string): void {
  db().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
