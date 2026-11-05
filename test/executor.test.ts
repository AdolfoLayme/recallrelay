import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, savePlan, approvePlan } from '../src/db.ts';
import { buildPlan } from '../src/plan.ts';
import { executePlan, reconcilePlan } from '../src/executor.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { PayPalError } from '../src/paypal/gateway.ts';
import type { Order } from '../src/types.ts';

function setup(refundedMinor = 0, budget = 1000, merchantId = 'm', captureTotal = 1000) {
  const db = createDatabase(':memory:');
  db.prepare("INSERT INTO sessions(id, expires_at) VALUES('s', 9999999999999)").run();
  const order: Order = {
    id: 'o', merchantId: 'm', buyerName: 'Buyer', buyerEmail: 'buyer@example.test',
    buyerCountry: 'US', language: 'en', currency: 'USD', status: 'CAPTURED', shipped: true,
    paidAt: '2026-10-01T00:00:00Z', captureId: 'cap', refundedMinor,
    lines: [{ sku: 'S', name: 'Item', quantity: 1, unitPriceMinor: 1000, taxMinor: 0 }],
  };
  db.prepare('INSERT INTO orders(id,session_id,body_json) VALUES(?,?,?)').run(order.id, 's', JSON.stringify(order));
  const plan = buildPlan('r', [{ order, match: { score: 1, lineSkus: ['S'], reason: 'sku' }, evidence: 'Official' }], new Date('2026-11-03'));
  savePlan(db, 's', plan);
  approvePlan(db, 's', plan.id, plan.planHash, 'Human', { USD: budget });
  const paypal = new FakePayPal();
  paypal.registerCapture('cap', captureTotal, 'USD', refundedMinor, merchantId);
  return { db, plan, paypal };
}

test('repeat and parallel execution create only one PayPal refund', async () => {
  const { db, plan, paypal } = setup();
  await Promise.all([executePlan(db, paypal, 's', plan.id), executePlan(db, paypal, 's', plan.id)]);
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM outbox').get()?.n, 1);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'SUCCEEDED');
  db.close();
});

test('timeout after success stays unknown without a PayPal refund id and does not repost', async () => {
  const { db, plan, paypal } = setup();
  paypal.nextFailure = 'timeout-after-success';
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  await reconcilePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal(paypal.sentCount, 1);
  assert.equal((JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order).refundedMinor, 0);
  assert.match(String(db.prepare('SELECT body_json FROM review_queue').get()?.body_json), /refund ID unavailable/i);
  db.close();
});

test('a second recall cannot refund the same order line again', async () => {
  const { db, plan, paypal } = setup();
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order;
  order.lines.push({ sku: 'OTHER', name: 'Other item', quantity: 1, unitPriceMinor: 1000, taxMinor: 0 });
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify(order));
  const second = buildPlan('second-recall', [{ order, match: { score: 1, lineSkus: ['S'], reason: 'sku' }, evidence: 'Second notice' }], new Date('2026-11-03'));
  savePlan(db, 's', second);
  approvePlan(db, 's', second.id, second.planHash, 'Human', { USD: 2000 });
  await executePlan(db, paypal, 's', plan.id);
  await executePlan(db, paypal, 's', second.id);
  assert.equal(paypal.sentCount, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM outbox WHERE status=?').get('SUCCEEDED')?.n, 1);
  db.close();
});

test('the same PayPal capture cannot be refunded through two imported order ids', async () => {
  const { db, plan, paypal } = setup();
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order;
  const duplicate = { ...order, id: 'duplicate-order' };
  db.prepare('INSERT INTO orders(id,session_id,body_json) VALUES(?,?,?)').run(duplicate.id, 's', JSON.stringify(duplicate));
  const second = buildPlan('other-recall', [{ order: duplicate, match: { score: 1, lineSkus: ['S'], reason: 'sku' }, evidence: 'Notice' }], new Date('2026-11-03'));
  savePlan(db, 's', second);
  approvePlan(db, 's', second.id, second.planHash, 'Human', { USD: 1000 });
  await executePlan(db, paypal, 's', plan.id);
  await executePlan(db, paypal, 's', second.id);
  assert.equal(paypal.sentCount, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM outbox WHERE status='SUCCEEDED'").get()?.n, 1);
  db.close();
});

test('a separate approved plan can settle a different line within its own currency budget', async () => {
  const { db, plan, paypal } = setup(0, 1000, 'm', 2000);
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order;
  order.lines.push({ sku: 'OTHER', name: 'Other item', quantity: 1, unitPriceMinor: 1000, taxMinor: 0 });
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify(order));
  const second = buildPlan('other-recall', [{ order, match: { score: 1, lineSkus: ['OTHER'], reason: 'sku' }, evidence: 'Other notice' }], new Date('2026-11-03'));
  savePlan(db, 's', second);
  approvePlan(db, 's', second.id, second.planHash, 'Human', { USD: 1000 });
  await executePlan(db, paypal, 's', plan.id);
  await executePlan(db, paypal, 's', second.id);
  assert.equal(paypal.sentCount, 2);
  assert.equal(db.prepare("SELECT SUM(amount_minor) n FROM outbox WHERE status='SUCCEEDED'").get()?.n, 2000);
  db.close();
});

test('sandbox refund cannot be sent for a capture owned by a different merchant', async () => {
  const { db, plan, paypal } = setup(0, 1000, 'another-merchant');
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order;
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify({ ...order, gateway: 'sandbox' }));
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 0);
  assert.notEqual(db.prepare('SELECT status FROM outbox').get()?.status, 'SUCCEEDED');
  db.close();
});

test('a failed preflight capture read can retry because no refund was sent', async () => {
  const { db, plan, paypal } = setup();
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order;
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify({ ...order, gateway: 'sandbox' }));
  const originalGetCapture = paypal.getCapture.bind(paypal);
  let reads = 0;
  paypal.getCapture = async captureId => {
    if (++reads === 1) throw new PayPalError('Preflight read unavailable', 0, true);
    return originalGetCapture(captureId);
  };
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 0);
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 1);
  assert.equal(db.prepare("SELECT status FROM outbox WHERE action='REFUND'").get()?.status, 'SUCCEEDED');
  db.close();
});

test('an unrelated external refund cannot confirm an unknown refund with no PayPal id', async () => {
  const { db, plan, paypal } = setup();
  paypal.nextFailure = 'server-error';
  await executePlan(db, paypal, 's', plan.id);
  await paypal.refundCapture('cap', 1000, 'USD', 'external-refund');
  await reconcilePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal((JSON.parse((db.prepare('SELECT body_json FROM orders').get() as { body_json: string }).body_json) as Order).refundedMinor, 0);
  db.close();
});

test('a capture without a verified payee cannot settle an unknown refund', async () => {
  const { db, plan, paypal } = setup(0, 1000, '');
  paypal.nextFailure = 'timeout-after-success';
  await executePlan(db, paypal, 's', plan.id);
  await reconcilePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  db.close();
});

test('5xx stays unknown, then a later run does not post again', async () => {
  const { db, plan, paypal } = setup();
  paypal.nextFailure = 'server-error';
  await executePlan(db, paypal, 's', plan.id);
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal(paypal.sentCount, 1);
  db.close();
});

test('already-refunded order is skipped before posting', async () => {
  const { db, plan, paypal } = setup();
  const row = db.prepare('SELECT body_json FROM orders').get() as { body_json: string };
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify({ ...JSON.parse(row.body_json), status: 'REFUNDED' }));
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 0);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'SKIPPED');
  db.close();
});

test('budget stops the run if approval budget is exhausted', async () => {
  const { db, plan, paypal } = setup(0, 1000);
  db.prepare("UPDATE approvals SET budget_json = '{\"USD\":500}'").run();
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM outbox').get()?.n, 0);
  db.close();
});

test('demo session action cap blocks a fifty-first monetary send', async () => {
  const { db, plan, paypal } = setup();
  db.prepare("UPDATE sessions SET actions_count=50 WHERE id='s'").run();
  await executePlan(db, paypal, 's', plan.id);
  assert.equal(paypal.sentCount, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM outbox').get()?.n, 0);
  db.close();
});

test('changed plan after approval cannot execute', async () => {
  const { db, plan, paypal } = setup();
  db.prepare('UPDATE plans SET body_json=? WHERE id=?').run(JSON.stringify({ ...plan, items: [{ ...plan.items[0], amountMinor: 1 }] }), plan.id);
  await assert.rejects(executePlan(db, paypal, 's', plan.id), /hash/i);
  assert.equal(paypal.sentCount, 0);
  db.close();
});

test('fake gateway refuses a refund larger than the capture remaining balance', async () => {
  const paypal = new FakePayPal();
  paypal.registerCapture('capture', 1000, 'USD', 300);
  await assert.rejects(paypal.refundCapture('capture', 701, 'USD', 'too-large'), /remaining/i);
  assert.equal((await paypal.getCapture('capture')).refundedMinor, 300);
  await paypal.refundCapture('capture', 700, 'USD', 'exact');
  await paypal.refundCapture('capture', 700, 'USD', 'exact');
  assert.equal((await paypal.getCapture('capture')).refundedMinor, 1000);
  await assert.rejects(paypal.refundCapture('capture', 1, 'USD', 'new-key'), /remaining/i);
});

test('two isolated sessions can execute identical fictional obligations independently', async () => {
  const { db, plan, paypal } = setup();
  db.prepare("INSERT INTO sessions(id,expires_at) VALUES('other',9999999999999)").run();
  const original = db.prepare("SELECT body_json FROM orders WHERE id='o' AND session_id='s'").get() as { body_json: string };
  db.prepare('INSERT INTO orders(id,session_id,body_json) VALUES(?,?,?)').run('o', 'other', original.body_json);
  const otherPlan = { ...plan, id: 'other-plan' };
  savePlan(db, 'other', otherPlan);
  approvePlan(db, 'other', otherPlan.id, otherPlan.planHash, 'Human', { USD: 1000 });
  await executePlan(db, paypal, 's', plan.id);
  await executePlan(db, paypal, 'other', otherPlan.id);
  assert.equal(paypal.sentCount, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM outbox').get()?.n, 2);
  db.close();
});

test('pending PayPal refund stays unknown and is not counted as paid', async () => {
  const { db, plan } = setup();
  class PendingPayPal extends FakePayPal {
    async refundCapture(): Promise<{ id: string; status: string }> { return { id: 'pending-refund', status: 'PENDING' }; }
  }
  await executePlan(db, new PendingPayPal(), 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  db.close();
});

test('a completed refund with a different PayPal amount stays unknown and enters review', async () => {
  const { db, plan } = setup();
  class ShortRefund extends FakePayPal {
    async refundCapture(): Promise<{ id: string; status: string; amountMinor: number; currency: string }> {
      return { id: 'short-refund', status: 'COMPLETED', amountMinor: 900, currency: 'USD' };
    }
  }
  await executePlan(db, new ShortRefund(), 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal((JSON.parse((db.prepare('SELECT body_json FROM orders').get() as {body_json:string}).body_json) as Order).refundedMinor, 0);
  assert.match(String(db.prepare('SELECT body_json FROM review_queue').get()?.body_json), /amount mismatch/i);
  db.close();
});

test('a payout batch marked success does not settle an unclaimed item', async () => {
  const { db, plan } = setup();
  const orderRow = db.prepare('SELECT body_json FROM orders').get() as {body_json:string};
  const order = { ...JSON.parse(orderRow.body_json), payoutEmail: 'buyer@example.test' };
  db.prepare('UPDATE orders SET body_json=?').run(JSON.stringify(order));
  const payoutPlan = { ...plan, items: [{ ...plan.items[0], action: 'PAYOUT' as const }] };
  payoutPlan.planHash = (await import('../src/plan.ts')).hashPlan(payoutPlan);
  db.prepare('UPDATE plans SET body_json=?,plan_hash=? WHERE id=?').run(JSON.stringify(payoutPlan), payoutPlan.planHash, plan.id);
  db.prepare('UPDATE approvals SET plan_hash=? WHERE plan_id=?').run(payoutPlan.planHash, plan.id);
  class Unclaimed extends FakePayPal {
    async getPayoutItem(): Promise<{ id: string; status: string; reason: string }> {
      return { id: 'item-1', status: 'UNCLAIMED', reason: 'RECEIVER_UNREGISTERED' };
    }
  }
  const paypal = new Unclaimed();
  await executePlan(db, paypal, 's', plan.id);
  await reconcilePlan(db, paypal, 's', plan.id);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.match(String(db.prepare('SELECT body_json FROM review_queue').get()?.body_json), /RECEIVER_UNREGISTERED/);
  db.close();
});
