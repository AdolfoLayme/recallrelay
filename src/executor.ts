import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPlan } from './plan.ts';
import type { Plan, PlanItem } from './plan.ts';
import type { Order } from './types.ts';
import { PayPalError } from './paypal/gateway.ts';
import type { PayPalGateway } from './paypal/gateway.ts';
import type { PayPalResult } from './paypal/gateway.ts';

type Ledger = { id: number; order_id: string; action: string; amount_minor: number; currency: string; status: string; paypal_id: string | null; idempotency_key: string };

function changeState(db: DatabaseSync, sessionId: string, rowId: number, state: string, paypalId?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = db.prepare('SELECT status, paypal_id FROM outbox WHERE id=? AND session_id=?').get(rowId, sessionId);
    db.prepare('UPDATE outbox SET status=?, paypal_id=COALESCE(?,paypal_id), updated_at=? WHERE id=? AND session_id=?')
      .run(state, paypalId ?? null, Date.now(), rowId, sessionId);
    db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, 'executor', Date.now(), `outbox:${rowId}`, JSON.stringify(before), JSON.stringify({ status: state, paypalId }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function settleRefund(db: DatabaseSync, sessionId: string, row: Ledger, paypalId?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = db.prepare('SELECT status, paypal_id FROM outbox WHERE id=? AND session_id=?').get(row.id, sessionId) as { status: string; paypal_id: string | null };
    if (before.status === 'SUCCEEDED') { db.exec('COMMIT'); return; }
    const orderRow = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(row.order_id, sessionId) as { body_json: string };
    const order = JSON.parse(orderRow.body_json) as Order;
    const refundedMinor = order.refundedMinor + row.amount_minor;
    const gross = order.lines.reduce((n, line) => n + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
    if (refundedMinor > gross) throw new Error('Refund exceeds order balance');
    const next = { ...order, refundedMinor, status: refundedMinor === gross ? 'REFUNDED' : 'PARTIALLY_REFUNDED' };
    db.prepare('UPDATE orders SET body_json=? WHERE id=? AND session_id=?').run(JSON.stringify(next), row.order_id, sessionId);
    db.prepare('UPDATE outbox SET status=?, paypal_id=COALESCE(?,paypal_id), updated_at=? WHERE id=? AND session_id=?')
      .run('SUCCEEDED', paypalId ?? null, Date.now(), row.id, sessionId);
    db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, 'executor', Date.now(), `outbox:${row.id}`, JSON.stringify(before), JSON.stringify({ status: 'SUCCEEDED', paypalId }));
    db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, 'executor', Date.now(), `order:${row.order_id}`, JSON.stringify({ status: order.status, refundedMinor: order.refundedMinor }), JSON.stringify({ status: next.status, refundedMinor }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function flagReview(db: DatabaseSync, sessionId: string, rowId: number, problem: string, detail: Record<string, unknown> = {}): void {
  const body = { outboxId: rowId, problem, ...detail };
  const existing = db.prepare("SELECT 1 FROM review_queue WHERE session_id=? AND kind='PAYMENT' AND body_json=? LIMIT 1")
    .get(sessionId, JSON.stringify(body));
  if (!existing) db.prepare('INSERT INTO review_queue(id,session_id,kind,body_json) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), sessionId, 'PAYMENT', JSON.stringify(body));
}

async function payoutItem(gateway: PayPalGateway, batch: PayPalResult): Promise<PayPalResult | undefined> {
  const itemId = batch.itemId ?? (await gateway.getPayout(batch.id)).itemId;
  return itemId ? gateway.getPayoutItem(itemId) : undefined;
}
type GatewaySource = PayPalGateway | ((order: Order) => PayPalGateway);
function forOrder(source: GatewaySource, order: Order): PayPalGateway {
  return typeof source === 'function' ? source(order) : source;
}

function getPlanAndBudget(db: DatabaseSync, sessionId: string, planId: string, allowExpiredRemedy = false): { plan: Plan; budget: Record<string, number> } {
  const row = db.prepare(`SELECT p.body_json, p.plan_hash, a.plan_hash approved_hash, a.budget_json
    FROM plans p JOIN approvals a ON a.plan_id=p.id AND a.session_id=p.session_id
    JOIN sessions s ON s.id=p.session_id WHERE p.id=? AND p.session_id=? AND (?=1 OR s.expires_at>?)`)
    .get(planId, sessionId, Number(allowExpiredRemedy), Date.now()) as { body_json: string; plan_hash: string; approved_hash: string; budget_json: string } | undefined;
  if (!row) throw new Error('Approved plan not found or session expired');
  const plan = JSON.parse(row.body_json) as Plan;
  if (hashPlan(plan) !== row.plan_hash || row.approved_hash !== row.plan_hash) throw new Error('Plan hash changed after approval');
  return { plan, budget: JSON.parse(row.budget_json) as Record<string, number> };
}

function reserve(db: DatabaseSync, sessionId: string, planId: string, recallId: string, item: PlanItem, budget: Record<string, number>): Ledger | undefined {
  const key = createHash('sha256').update(`${sessionId}:${recallId}:${item.orderId}:${item.action}:${item.lineSkus.join(',')}`).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = db.prepare('SELECT * FROM outbox WHERE idempotency_key=?').get(key) as Ledger | undefined;
    if (old) { db.exec('COMMIT'); return undefined; }
    const prior = db.prepare(`SELECT o.action, o.status, p.body_json FROM outbox o JOIN plans p ON p.id=o.plan_id
      WHERE o.session_id=? AND o.order_id=? AND o.status IN ('SENDING','UNKNOWN','SUCCEEDED')`).all(sessionId, item.orderId) as { action: string; status: string; body_json: string }[];
    if (prior.some(entry => {
      const previous = (JSON.parse(entry.body_json) as Plan).items.find(value => value.orderId === item.orderId && value.action === entry.action);
      return previous?.lineSkus.some(sku => item.lineSkus.includes(sku));
    })) { db.exec('COMMIT'); return undefined; }
    const orderRow = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(item.orderId, sessionId) as { body_json: string } | undefined;
    if (!orderRow) throw new Error('Order not found in session');
    const order = JSON.parse(orderRow.body_json) as Order & { payoutEmail?: string };
    const paymentId = item.action === 'VOID_AUTHORIZATION' ? order.authorizationId : order.captureId;
    const paymentField = item.action === 'VOID_AUTHORIZATION' ? '$.authorizationId' : '$.captureId';
    if (paymentId && db.prepare(`SELECT 1 FROM outbox o JOIN orders x ON x.id=o.order_id AND x.session_id=o.session_id
      WHERE o.session_id=? AND o.order_id<>? AND o.status IN ('SENDING','UNKNOWN','SUCCEEDED')
      AND json_extract(x.body_json, ?) = ? LIMIT 1`).get(sessionId, item.orderId, paymentField, paymentId)) {
      db.exec('COMMIT'); return undefined;
    }
    const spent = db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS amount FROM outbox WHERE session_id=? AND plan_id=? AND currency=? AND status IN ('SENDING','UNKNOWN','SUCCEEDED')`)
      .get(sessionId, planId, item.currency) as { amount: number };
    if (item.amountMinor > 0 && spent.amount + item.amountMinor > (budget[item.currency] ?? -1)) { db.exec('COMMIT'); return undefined; }
    const session = db.prepare('SELECT actions_count FROM sessions WHERE id=?').get(sessionId) as { actions_count: number } | undefined;
    if (!session || session.actions_count >= 50) { db.exec('COMMIT'); return undefined; }
    const skip = order.merchantId !== item.merchantId || order.status === 'REFUNDED' || order.status === 'VOIDED' ||
      (item.action === 'REFUND' && (!order.captureId || order.refundedMinor + item.amountMinor > order.lines.reduce((n, l) => n + l.quantity * l.unitPriceMinor + l.taxMinor, 0))) ||
      (item.action === 'VOID_AUTHORIZATION' && !order.authorizationId) ||
      (item.action === 'PAYOUT' && !order.payoutEmail);
    const status = skip ? 'SKIPPED' : 'SENDING';
    if (!skip) db.prepare('UPDATE sessions SET actions_count=actions_count+1 WHERE id=?').run(sessionId);
    const result = db.prepare(`INSERT INTO outbox(session_id,plan_id,order_id,action,amount_minor,currency,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sessionId, planId, item.orderId, item.action, item.amountMinor, item.currency, key, status, Date.now(), Date.now());
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sessionId, 'executor', Date.now(), `outbox:${id}`, '{}', JSON.stringify({ status }));
    db.exec('COMMIT');
    return { id, order_id: item.orderId, action: item.action, amount_minor: item.amountMinor, currency: item.currency, status, paypal_id: null, idempotency_key: key };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function executePlan(db: DatabaseSync, source: GatewaySource, sessionId: string, planId: string, allowExpiredRemedy = false): Promise<void> {
  const { plan, budget } = getPlanAndBudget(db, sessionId, planId, allowExpiredRemedy);
  const preferred = db.prepare('SELECT order_ids_json FROM plan_order WHERE plan_id=? AND session_id=?').get(planId, sessionId) as {order_ids_json:string} | undefined;
  const positions = new Map<string, number>((preferred ? JSON.parse(preferred.order_ids_json) as string[] : []).map((orderId, index) => [orderId, index]));
  const items = [...plan.items].sort((a, b) => (positions.get(a.orderId) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.orderId) ?? Number.MAX_SAFE_INTEGER));
  for (const item of items) {
    if (!['REFUND', 'VOID_AUTHORIZATION', 'PAYOUT'].includes(item.action)) continue;
    let capture: Awaited<ReturnType<PayPalGateway['getCapture']>> | undefined;
    if (item.action === 'REFUND') {
      const current = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(item.orderId, sessionId) as { body_json: string } | undefined;
      const order = current && JSON.parse(current.body_json) as Order;
      if (order?.gateway === 'sandbox' && order.captureId) {
        try { capture = await forOrder(source, order).getCapture(order.captureId); }
        catch { continue; }
      }
    }
    const row = reserve(db, sessionId, planId, plan.recallId, item, budget);
    if (!row || row.status === 'SKIPPED') continue;
    const orderRow = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(item.orderId, sessionId) as { body_json: string };
    const order = JSON.parse(orderRow.body_json) as Order & { payoutEmail?: string };
    const gateway = forOrder(source, order);
    try {
      if (item.action === 'REFUND' && order.gateway === 'sandbox') {
        const gross = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
        if (!capture || capture.id !== order.captureId || capture.payeeMerchantId !== order.merchantId ||
          capture.amountMinor !== gross || capture.currency !== order.currency) {
          flagReview(db, sessionId, row.id, 'Capture does not match the order');
          changeState(db, sessionId, row.id, 'FAILED');
          continue;
        }
      }
      const response = item.action === 'REFUND'
        ? await gateway.refundCapture(order.captureId!, item.amountMinor, item.currency, row.idempotency_key)
        : item.action === 'VOID_AUTHORIZATION'
          ? await gateway.voidAuthorization(order.authorizationId!, row.idempotency_key)
          : await gateway.createPayout(order.payoutEmail!, item.amountMinor, item.currency, row.idempotency_key);
      const refundMatches = response.amountMinor === item.amountMinor && response.currency === item.currency;
      if (item.action === 'REFUND' && response.status === 'COMPLETED' && !refundMatches)
        flagReview(db, sessionId, row.id, 'PayPal refund amount mismatch', { requestedMinor: item.amountMinor, returnedMinor: response.amountMinor ?? null });
      const payout = item.action === 'PAYOUT' ? await payoutItem(gateway, response) : undefined;
      if (payout?.status === 'UNCLAIMED' || payout?.reason)
        flagReview(db, sessionId, row.id, payout.reason ?? 'Payout not claimed yet', { status: payout.status, batchId: response.id });
      const completed = item.action === 'REFUND' ? response.status === 'COMPLETED' && refundMatches
        : item.action === 'VOID_AUTHORIZATION' ? response.status === 'VOIDED' : payout?.status === 'SUCCESS';
      if (completed && item.action === 'REFUND') settleRefund(db, sessionId, row, response.id);
      else changeState(db, sessionId, row.id, completed ? 'SUCCEEDED' : 'UNKNOWN', response.id);
    } catch (error) {
      changeState(db, sessionId, row.id, error instanceof PayPalError && error.status < 500 && !error.uncertain ? 'FAILED' : 'UNKNOWN');
    }
  }
}

export async function reconcilePlan(db: DatabaseSync, source: GatewaySource, sessionId: string, planId: string, allowExpiredRemedy = false): Promise<void> {
  getPlanAndBudget(db, sessionId, planId, allowExpiredRemedy);
  const rows = db.prepare("SELECT * FROM outbox WHERE session_id=? AND plan_id=? AND status IN ('UNKNOWN','SENDING')").all(sessionId, planId) as unknown as Ledger[];
  for (const row of rows) {
    const orderRow = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(row.order_id, sessionId) as { body_json: string } | undefined;
    if (!orderRow) continue;
    const order = JSON.parse(orderRow.body_json) as Order;
    const gateway = forOrder(source, order);
    try {
      if (row.action === 'REFUND' && order.captureId) {
        if (row.paypal_id) {
          const refund = await gateway.getRefund(row.paypal_id);
          if (refund.status === 'COMPLETED' && refund.amountMinor === row.amount_minor && refund.currency === row.currency)
            settleRefund(db, sessionId, row);
          else if (refund.status === 'COMPLETED') flagReview(db, sessionId, row.id, 'PayPal refund amount mismatch', { requestedMinor: row.amount_minor, returnedMinor: refund.amountMinor ?? null });
        } else flagReview(db, sessionId, row.id, 'Refund outcome unknown; PayPal refund ID unavailable');
      } else if (row.action === 'VOID_AUTHORIZATION' && order.authorizationId) {
        const state = await gateway.getAuthorization(order.authorizationId);
        if (state.status === 'VOIDED') changeState(db, sessionId, row.id, 'SUCCEEDED');
      } else if (row.action === 'PAYOUT' && row.paypal_id) {
        const batch = await gateway.getPayout(row.paypal_id);
        const item = await payoutItem(gateway, batch);
        if (item?.status === 'SUCCESS') changeState(db, sessionId, row.id, 'SUCCEEDED');
        else if (item?.status === 'UNCLAIMED' || item?.reason)
          flagReview(db, sessionId, row.id, item.reason ?? 'Payout not claimed yet', { status: item.status, batchId: row.paypal_id });
      }
    } catch { /* Keep UNKNOWN until the upstream status can be verified. */ }
  }
}
