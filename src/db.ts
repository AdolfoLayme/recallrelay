import { DatabaseSync } from 'node:sqlite';
import type { Plan } from './plan.ts';
import { hashPlan } from './plan.ts';

export function createDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, cleaned_at INTEGER, actions_count INTEGER NOT NULL DEFAULT 0,
      ai_calls_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS recalls (
      id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), body_json TEXT NOT NULL,
      PRIMARY KEY(id, session_id)
    );
    CREATE TABLE IF NOT EXISTS source_status (
      session_id TEXT NOT NULL REFERENCES sessions(id), source TEXT NOT NULL, body_json TEXT NOT NULL,
      refreshed_at INTEGER NOT NULL, PRIMARY KEY(session_id, source)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), body_json TEXT NOT NULL,
      PRIMARY KEY(id, session_id)
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), recall_id TEXT NOT NULL,
      body_json TEXT NOT NULL, plan_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      plan_id TEXT PRIMARY KEY REFERENCES plans(id), session_id TEXT NOT NULL REFERENCES sessions(id),
      plan_hash TEXT NOT NULL, approver TEXT NOT NULL, budget_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_order (
      plan_id TEXT PRIMARY KEY REFERENCES plans(id), session_id TEXT NOT NULL REFERENCES sessions(id),
      order_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_orders (
      paypal_order_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      country TEXT NOT NULL, capture_id TEXT, order_id TEXT, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), plan_id TEXT NOT NULL REFERENCES plans(id),
      order_id TEXT NOT NULL, action TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, paypal_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), actor TEXT NOT NULL,
      at INTEGER NOT NULL, entity TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
    CREATE TABLE IF NOT EXISTS webhooks (
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remedy_choices (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), order_id TEXT NOT NULL,
      recall_id TEXT NOT NULL, choice TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remedy_links (
      session_id TEXT NOT NULL REFERENCES sessions(id), recall_id TEXT NOT NULL, order_id TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES plans(id), token TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, recall_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS fulfilment_tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), recall_id TEXT NOT NULL,
      order_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE(session_id,recall_id,order_id)
    );
    CREATE TABLE IF NOT EXISTS blocklist (
      session_id TEXT NOT NULL REFERENCES sessions(id), recall_id TEXT NOT NULL, sku TEXT NOT NULL,
      gtin TEXT, country TEXT, PRIMARY KEY(session_id, recall_id, sku)
    );
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
      body_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
    );
    CREATE TABLE IF NOT EXISTS notice_deliveries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), recall_id TEXT NOT NULL,
      order_id TEXT NOT NULL, body_json TEXT NOT NULL, status TEXT NOT NULL,
      UNIQUE(session_id,recall_id,order_id)
    );
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), plan_id TEXT NOT NULL REFERENCES plans(id), currency TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, status TEXT NOT NULL, paypal_id TEXT,
      UNIQUE(session_id, plan_id, currency)
    );
    CREATE TABLE IF NOT EXISTS supplier_invoice_approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), plan_id TEXT NOT NULL REFERENCES plans(id),
      currency TEXT NOT NULL, plan_hash TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      recipient_email TEXT NOT NULL, approver TEXT NOT NULL, budget_minor INTEGER NOT NULL, approved_at INTEGER NOT NULL,
      UNIQUE(session_id, plan_id, currency)
    );
  `);
  return db;
}

export function savePlan(db: DatabaseSync, sessionId: string, plan: Plan): void {
  db.prepare('INSERT INTO plans(id, session_id, recall_id, body_json, plan_hash, created_at) VALUES(?,?,?,?,?,?)')
    .run(plan.id, sessionId, plan.recallId, JSON.stringify(plan), plan.planHash, Date.now());
}

export type Approval = { planId: string; planHash: string; approver: string; budget: Record<string, number> };

export function approvePlan(
  db: DatabaseSync, sessionId: string, planId: string, suppliedHash: string,
  approver: string, budget: Record<string, number>, allowExpiredRemedy = false,
): Approval {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT p.body_json, p.plan_hash FROM plans p JOIN sessions s ON s.id = p.session_id WHERE p.id = ? AND p.session_id = ? AND (?=1 OR s.expires_at > ?)')
      .get(planId, sessionId, Number(allowExpiredRemedy), Date.now()) as { body_json: string; plan_hash: string } | undefined;
    if (!row) throw new Error('Plan not found or session expired');
    const plan = JSON.parse(row.body_json) as Plan;
    if (suppliedHash !== row.plan_hash || suppliedHash !== hashPlan(plan)) throw new Error('Plan hash differs');
    if (!approver.trim()) throw new Error('Approver required');
    for (const [currency, total] of Object.entries(plan.totals)) {
      if (!Number.isSafeInteger(budget[currency]) || budget[currency] < total) throw new Error(`Missing or exceeded budget for ${currency}`);
    }
    db.prepare('INSERT INTO approvals(plan_id, session_id, plan_hash, approver, budget_json, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET plan_hash=excluded.plan_hash, approver=excluded.approver, budget_json=excluded.budget_json, created_at=excluded.created_at')
      .run(planId, sessionId, suppliedHash, approver, JSON.stringify(budget), Date.now());
    db.prepare('INSERT INTO audit_log(session_id, actor, at, entity, before_json, after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, approver, Date.now(), `approval:${planId}`, '{}', JSON.stringify({ planHash: suppliedHash, budget }));
    db.exec('COMMIT');
    return { planId, planHash: suppliedHash, approver, budget };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
