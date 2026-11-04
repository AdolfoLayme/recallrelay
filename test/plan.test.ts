import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, savePlan, approvePlan } from '../src/db.ts';
import { buildPlan, hashPlan } from '../src/plan.ts';
import type { Order } from '../src/types.ts';

const order: Order = {
  id: 'one', merchantId: 'merchant', buyerName: 'Buyer', buyerEmail: 'buyer@example.test',
  buyerCountry: 'US', language: 'en', currency: 'USD', status: 'CAPTURED', shipped: true,
  paidAt: '2026-10-01T00:00:00Z', captureId: 'capture', refundedMinor: 0,
  lines: [{ sku: 'A', name: 'A', quantity: 1, unitPriceMinor: 1000, taxMinor: 0 }],
};

test('plan hash is stable and totals stay separated by currency', () => {
  const inputs = [
    { order, match: { score: 1, lineSkus: ['A'], reason: 'SKU' }, evidence: 'Official notice' },
    { order: { ...order, id: 'two', currency: 'EUR' }, match: { score: 1, lineSkus: ['A'], reason: 'SKU' }, evidence: 'Official notice' },
  ];
  const first = buildPlan('recall', inputs, new Date('2026-11-03T00:00:00Z'));
  const second = buildPlan('recall', inputs, new Date('2026-11-03T00:00:00Z'));
  assert.equal(hashPlan(first), hashPlan(second));
  assert.deepEqual(first.totals, { USD: 1000, EUR: 1000 });
});

test('approval rejects wrong hash, absent currency and exceeded budget', () => {
  const db = createDatabase(':memory:');
  db.prepare("INSERT INTO sessions(id, expires_at) VALUES('s', 9999999999999)").run();
  const plan = buildPlan('recall', [{ order, match: { score: 1, lineSkus: ['A'], reason: 'SKU' }, evidence: 'Notice' }], new Date('2026-11-03T00:00:00Z'));
  savePlan(db, 's', plan);
  assert.throws(() => approvePlan(db, 's', plan.id, 'wrong', 'Alice', { USD: 1000 }), /hash/i);
  assert.throws(() => approvePlan(db, 's', plan.id, plan.planHash, 'Alice', {}), /budget/i);
  assert.throws(() => approvePlan(db, 's', plan.id, plan.planHash, 'Alice', { USD: 999 }), /budget/i);
  assert.equal(approvePlan(db, 's', plan.id, plan.planHash, 'Alice', { USD: 1000 }).approver, 'Alice');
  db.prepare('UPDATE plans SET body_json = ? WHERE id = ?').run(JSON.stringify({ ...plan, totals: { USD: 9999 } }), plan.id);
  assert.throws(() => approvePlan(db, 's', plan.id, plan.planHash, 'Alice', { USD: 10000 }), /hash/i);
  db.close();
});

test('session lookup and audit immutability are enforced by SQLite', () => {
  const db = createDatabase(':memory:');
  db.prepare("INSERT INTO sessions(id, expires_at) VALUES('s1', 9999999999999),('s2', 9999999999999)").run();
  const plan = buildPlan('recall', [{ order, match: { score: 1, lineSkus: ['A'], reason: 'SKU' }, evidence: 'Notice' }], new Date('2026-11-03T00:00:00Z'));
  savePlan(db, 's1', plan);
  assert.throws(() => approvePlan(db, 's2', plan.id, plan.planHash, 'Alice', { USD: 1000 }));
  db.prepare("INSERT INTO audit_log(session_id, actor, at, entity, before_json, after_json) VALUES('s1','Alice',1,'plan','{}','{}')").run();
  assert.throws(() => db.prepare('UPDATE audit_log SET actor = ?').run('Bob'));
  assert.throws(() => db.prepare('DELETE FROM audit_log').run());
  db.close();
});
