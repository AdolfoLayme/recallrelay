import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Order } from './types.ts';

export type RemedyPayload = { sessionId: string; orderId: string; recallId: string; expiresAt: number };
export type BuyerChoice = 'refund' | 'repair' | 'replacement';
export const LINK_LIFETIME_MS = 30 * 86_400_000;
export const FULFILMENT_DUE_MS = 14 * 86_400_000;

function signature(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function createRemedyToken(payload: RemedyPayload, secret: string): string {
  if (!secret) throw new Error('Signing secret required');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`;
}

export function verifyRemedyToken(token: string, secret: string, now = Date.now()): RemedyPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) throw new Error('Invalid remedy token');
  let supplied: Buffer;
  try { supplied = Buffer.from(parts[1], 'base64url'); }
  catch { throw new Error('Invalid remedy token'); }
  const expected = signature(parts[0], secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid remedy token');
  let payload: RemedyPayload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as RemedyPayload; }
  catch { throw new Error('Invalid remedy token'); }
  if (!payload.sessionId || !payload.orderId || !payload.recallId || !Number.isSafeInteger(payload.expiresAt)) throw new Error('Invalid remedy token');
  if (payload.expiresAt < now) throw new Error('Remedy token expired');
  return payload;
}

export function recordBuyerChoice(
  db: DatabaseSync, sessionId: string, token: string, choice: BuyerChoice,
  secret: string, now = Date.now(), paypalEmail?: string,
): { choice: BuyerChoice; dueAt?: number } {
  if (!['refund', 'repair', 'replacement'].includes(choice)) throw new Error('Invalid buyer choice');
  const payload = verifyRemedyToken(token, secret, now);
  if (payload.sessionId !== sessionId) throw new Error('Wrong session');
  const session = db.prepare('SELECT expires_at FROM sessions WHERE id=?').get(sessionId) as { expires_at: number } | undefined;
  const issued = db.prepare('SELECT 1 FROM remedy_links WHERE session_id=? AND recall_id=? AND order_id=? AND token=? AND expires_at>=?')
    .get(sessionId, payload.recallId, payload.orderId, token, now);
  if (!session || (session.expires_at <= now && !issued)) throw new Error('Session expired');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = db.prepare('SELECT choice, created_at FROM remedy_choices WHERE token_hash=? AND session_id=?').get(tokenHash, sessionId) as { choice: BuyerChoice; created_at: number } | undefined;
    const task = db.prepare('SELECT due_at FROM fulfilment_tasks WHERE session_id=? AND recall_id=? AND order_id=?')
      .get(sessionId, payload.recallId, payload.orderId) as { due_at: number } | undefined;
    if (old) {
      if (old.choice === choice) { db.exec('COMMIT'); return { choice, dueAt: task?.due_at }; }
      if (old.choice === 'refund' || choice !== 'refund' || !task || now <= task.due_at) throw new Error('Choice already recorded');
      db.prepare('UPDATE remedy_choices SET choice=?, created_at=? WHERE token_hash=? AND session_id=?').run(choice, now, tokenHash, sessionId);
      db.prepare("UPDATE fulfilment_tasks SET status='SWITCHED_TO_REFUND' WHERE session_id=? AND recall_id=? AND order_id=?")
        .run(sessionId, payload.recallId, payload.orderId);
    } else {
      db.prepare('INSERT INTO remedy_choices(token_hash,session_id,order_id,recall_id,choice,created_at) VALUES(?,?,?,?,?,?)')
        .run(tokenHash, sessionId, payload.orderId, payload.recallId, choice, now);
      if (choice !== 'refund') db.prepare('INSERT INTO fulfilment_tasks(id,session_id,recall_id,order_id,kind,due_at,status) VALUES(?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), sessionId, payload.recallId, payload.orderId, choice, now + FULFILMENT_DUE_MS, 'OPEN');
    }
    if (choice === 'refund' && paypalEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) throw new Error('Invalid PayPal email');
      const row = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(payload.orderId, sessionId) as { body_json: string } | undefined;
      if (row) {
        const order = JSON.parse(row.body_json) as Order;
        db.prepare('UPDATE orders SET body_json=? WHERE id=? AND session_id=?').run(JSON.stringify({ ...order, payoutEmail: paypalEmail }), payload.orderId, sessionId);
      }
    }
    db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, 'buyer', now, `remedy:${payload.recallId}:${payload.orderId}`, JSON.stringify({ choice: old?.choice ?? null }), JSON.stringify({ choice }));
    db.exec('COMMIT');
    return { choice, dueAt: choice === 'refund' ? undefined : now + FULFILMENT_DUE_MS };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
