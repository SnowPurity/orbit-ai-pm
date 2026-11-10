import { randomBytes } from 'node:crypto';
import type { Db } from './db/index.js';
import type { Actor } from './types.js';
import { nowIso, newId, sha256 } from './lib/util.js';
import { unauthorized } from './lib/errors.js';

interface ActorRow {
  id: string;
  name: string;
  kind: Actor['kind'];
  title: string | null;
}

export interface IssuedToken {
  token: string;
  actorId: string;
  hint: string;
}

export function generateToken(kind: Actor['kind']): string {
  const prefix = kind === 'agent' ? 'orb_a_' : 'orb_h_';
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

export function issueToken(db: Db, actorId: string): IssuedToken {
  const actor = db.prepare('SELECT id, kind FROM actors WHERE id = ?').get(actorId) as
    | { id: string; kind: Actor['kind'] }
    | undefined;
  if (!actor) throw new Error(`Actor ${actorId} does not exist`);
  const token = generateToken(actor.kind);
  const hint = token.slice(-4);
  db.prepare(
    `INSERT INTO actor_tokens (id, actor_id, token_hash, token_hint, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId('tok'), actorId, sha256(token), hint, nowIso());
  return { token, actorId, hint };
}

export function authenticate(db: Db, authorization: string | undefined): Actor {
  if (!authorization?.startsWith('Bearer ')) {
    throw unauthorized();
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw unauthorized();

  const actor = db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.title
       FROM actor_tokens t JOIN actors a ON a.id = t.actor_id
       WHERE t.token_hash = ?`,
    )
    .get(sha256(token)) as ActorRow | undefined;

  if (!actor) throw unauthorized();

  db.prepare('UPDATE actor_tokens SET last_used_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  return actor;
}

export function findActor(db: Db, ref: string): Actor | null {
  const row = db
    .prepare(
      `SELECT id, name, kind, title FROM actors
       WHERE id = ? OR name = ? COLLATE NOCASE`,
    )
    .get(ref, ref) as ActorRow | undefined;
  return row ?? null;
}
