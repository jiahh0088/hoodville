import { DatabaseSync, StatementSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'invite-log.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS presets (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL UNIQUE,
    invite_link       TEXT NOT NULL,
    role_ids          TEXT NOT NULL DEFAULT '[]',
    message_template  TEXT NOT NULL,
    created_at TEXT   NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invited_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    source_guild_id TEXT NOT NULL,
    preset_name     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent',
    error           TEXT,
    invited_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, source_guild_id)
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_name TEXT NOT NULL,
    source_guild_id  TEXT NOT NULL,
    initiator_id     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'running',
    total_eligible   INTEGER NOT NULL DEFAULT 0,
    total_sent       INTEGER NOT NULL DEFAULT 0,
    total_failed     INTEGER NOT NULL DEFAULT 0,
    total_skipped    INTEGER NOT NULL DEFAULT 0,
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at      TEXT
  );
`);

export interface Preset {
  id: number;
  name: string;
  invite_link: string;
  role_ids: string;
  message_template: string;
  created_at: string;
  updated_at: string;
}

export interface InvitedUser {
  id: number;
  user_id: string;
  username: string;
  source_guild_id: string;
  preset_name: string;
  status: string;
  error: string | null;
  invited_at: string;
}

export interface Campaign {
  id: number;
  preset_name: string;
  source_guild_id: string;
  initiator_id: string;
  status: string;
  total_eligible: number;
  total_sent: number;
  total_failed: number;
  total_skipped: number;
  started_at: string;
  finished_at: string | null;
}

export const presetRepo = {
  create(name: string, invite_link: string, role_ids: string[], message_template: string): Preset {
    db.prepare(
      `INSERT INTO presets (name, invite_link, role_ids, message_template) VALUES (?, ?, ?, ?)`
    ).run(name, invite_link, JSON.stringify(role_ids), message_template);
    return db.prepare('SELECT * FROM presets WHERE name = ?').get(name) as unknown as Preset;
  },

  update(name: string, fields: Partial<Pick<Preset, 'invite_link' | 'role_ids' | 'message_template'>>): void {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (fields.invite_link !== undefined)      { updates.push('invite_link = ?');       values.push(fields.invite_link); }
    if (fields.role_ids !== undefined)         { updates.push('role_ids = ?');           values.push(fields.role_ids); }
    if (fields.message_template !== undefined) { updates.push('message_template = ?');  values.push(fields.message_template); }
    if (updates.length === 0) return;
    updates.push("updated_at = datetime('now')");
    values.push(name);
    db.prepare(`UPDATE presets SET ${updates.join(', ')} WHERE name = ?`).run(...(values as Parameters<StatementSync['run']>));
  },

  get(name: string): Preset | undefined {
    return db.prepare('SELECT * FROM presets WHERE name = ?').get(name) as unknown as Preset | undefined;
  },

  list(): Preset[] {
    return db.prepare('SELECT * FROM presets ORDER BY name').all() as unknown as Preset[];
  },

  delete(name: string): boolean {
    const result = db.prepare('DELETE FROM presets WHERE name = ?').run(name);
    return (result.changes as number) > 0;
  },
};

export const inviteLogRepo = {
  hasBeenInvited(userId: string, sourceGuildId: string): boolean {
    const row = db.prepare(
      'SELECT 1 FROM invited_users WHERE user_id = ? AND source_guild_id = ?'
    ).get(userId, sourceGuildId);
    return !!row;
  },

  record(userId: string, username: string, sourceGuildId: string, presetName: string, status: 'sent' | 'failed', error?: string): void {
    db.prepare(`
      INSERT OR IGNORE INTO invited_users (user_id, username, source_guild_id, preset_name, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, username, sourceGuildId, presetName, status, error ?? null);
  },

  getStats(sourceGuildId: string): { total: number; sent: number; failed: number } {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM invited_users WHERE source_guild_id = ?
    `).get(sourceGuildId) as { total: number; sent: number; failed: number };
  },

  clearLog(sourceGuildId: string): number {
    const result = db.prepare('DELETE FROM invited_users WHERE source_guild_id = ?').run(sourceGuildId);
    return result.changes as number;
  },
};

export const campaignRepo = {
  create(presetName: string, sourceGuildId: string, initiatorId: string, totalEligible: number): number {
    const result = db.prepare(`
      INSERT INTO campaigns (preset_name, source_guild_id, initiator_id, total_eligible)
      VALUES (?, ?, ?, ?)
    `).run(presetName, sourceGuildId, initiatorId, totalEligible);
    return result.lastInsertRowid as number;
  },

  increment(id: number, field: 'total_sent' | 'total_failed' | 'total_skipped'): void {
    db.prepare(`UPDATE campaigns SET ${field} = ${field} + 1 WHERE id = ?`).run(id);
  },

  finish(id: number, status: 'completed' | 'cancelled'): void {
    db.prepare(`UPDATE campaigns SET status = ?, finished_at = datetime('now') WHERE id = ?`).run(status, id);
  },

  getLatest(sourceGuildId: string): Campaign | undefined {
    return db.prepare(`
      SELECT * FROM campaigns WHERE source_guild_id = ? ORDER BY id DESC LIMIT 1
    `).get(sourceGuildId) as Campaign | undefined;
  },

  getActive(): Campaign | undefined {
    return db.prepare(
      `SELECT * FROM campaigns WHERE status = 'running' ORDER BY id DESC LIMIT 1`
    ).get() as Campaign | undefined;
  },
};

export default db;
