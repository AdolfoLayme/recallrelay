import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../src/db.ts';
import { createDemoSession, DEMO_RECALL_ID } from '../src/demo.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { matchOrder } from '../src/matching.ts';
import { classify } from '../src/policy.ts';
import type { Order } from '../src/types.ts';
import type { RecallNotice } from '../src/sources/types.ts';

test('demo completes an offline recall flow in under ten seconds', () => {
  const started = Date.now();
  const run = spawnSync(process.execPath, ['scripts/demo.ts'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 10_000);
  assert.match(run.stdout, /Timeline/);
  assert.match(run.stdout, /Totals/);
  assert.match(run.stdout, /fake mode/);
  assert.match(run.stdout, /Budget USD 30000/);
  assert.match(run.stdout, /Moved USD 25800/);
  assert.match(run.stdout, /Moved CAD 35800/);
  assert.match(run.stdout, /Moved GBP 9900/);
  assert.match(run.stdout, /Moved AUD 18900/);
  assert.match(run.stdout, /Reserved EUR 20800/);
  assert.match(run.stdout, /Released JPY 12800/);
});

test('demo seed has every specified order, scenario and amount', async () => {
  const db = createDatabase(':memory:');
  const now = Date.parse('2026-11-03T12:00:00.000Z');
  const sid = createDemoSession(db, now);
  const recall = JSON.parse((db.prepare('SELECT body_json FROM recalls WHERE id=? AND session_id=?').get(DEMO_RECALL_ID, sid) as { body_json: string }).body_json) as RecallNotice & { fileNumber?: string; supplier?: string };
  assert.equal(recall.source, 'DEMO');
  assert.equal(recall.fileNumber, 'RR-2026-0417');
  assert.equal(recall.supplier, 'Kestrel Appliance Co.');
  assert.equal(recall.rawText, 'Harbor & Pine recalls about 3,400 Lumen Mini Space Heaters, model HP-LMH-015. The power cord can overheat, posing fire and burn hazards. Consumers should immediately stop using the\nrecalled heaters and contact Harbor & Pine for a full\nrefund. The heaters were sold online from January 2026 through October 2026 for about $129.');
  const extraction = await new FakeAiProvider().extractRecall(recall);
  const rows = db.prepare('SELECT body_json FROM orders WHERE session_id=?').all(sid) as { body_json: string }[];
  const actual: Record<string, { country: string; age: number; status: string; action: string; amount: number; score: number }> = {};
  for (const row of rows) {
    const order = JSON.parse(row.body_json) as Order;
    const match = matchOrder(extraction.products, order);
    const decision = classify(order, match, { now: new Date(now) });
    actual[order.id] = { country: order.buyerCountry, age: Math.floor((now - Date.parse(order.paidAt)) / 86_400_000), status: order.status, action: decision.action, amount: order.lines.filter(line => line.sku !== 'HP-LAMP-001').reduce((n, line) => n + line.quantity * line.unitPriceMinor + line.taxMinor, 0) - order.refundedMinor, score: match.score };
  }
  assert.deepEqual(Object.keys(actual).sort(), ['0866','0871','0994','1019','1038','1042','1051','1060','1071','1077','1088','1103']);
  const expected = [
    ['1042','US',12,'CAPTURED','REFUND',12900,1], ['1071','AU',31,'CAPTURED','REFUND',18900,1],
    ['1019','CA',150,'CAPTURED','REFUND',17900,1], ['0994','GB',178,'CAPTURED','REFUND',9900,1],
    ['0871','US',212,'CAPTURED','PAYOUT',12900,1], ['0866','CA',241,'CAPTURED','PAYOUT',17900,1],
    ['1103','JP',2,'AUTHORIZED','VOID_AUTHORIZATION',12800,1],
    ['1051','DE',40,'CAPTURED','AWAIT_BUYER_CHOICE',11900,1],
    ['1060','FR',28,'PARTIALLY_REFUNDED','AWAIT_BUYER_CHOICE',8900,1],
    ['1088','GB',9,'AUTHORIZED','MANUAL_REVIEW',9900,1],
    ['1077','US',17,'CAPTURED','MANUAL_REVIEW',12900,0.72],
    ['1038','US',96,'REFUNDED','NO_ACTION',0,1],
  ] as const;
  for (const [id, country, age, status, action, amount, score] of expected) {
    assert.deepEqual(actual[id], { country, age, status, action, amount, score }, id);
  }
  const orders = rows.map(row => JSON.parse(row.body_json) as Order);
  assert.equal(orders.find(order => order.id === '1071')?.lines.length, 2);
  const moved: Record<string, number> = {};
  const reserved: Record<string, number> = {};
  const released: Record<string, number> = {};
  for (const order of orders) {
    const decision = classify(order, matchOrder(extraction.products, order), { now: new Date(now) });
    const remaining = order.lines.reduce((n, line) => n + line.quantity * line.unitPriceMinor + line.taxMinor, 0) - order.refundedMinor;
    if (decision.action === 'REFUND' || decision.action === 'PAYOUT') moved[order.currency] = (moved[order.currency] ?? 0) + decision.amountMinor;
    if (decision.action === 'AWAIT_BUYER_CHOICE') reserved[order.currency] = (reserved[order.currency] ?? 0) + remaining;
    if (decision.action === 'VOID_AUTHORIZATION') released[order.currency] = (released[order.currency] ?? 0) + remaining;
  }
  assert.deepEqual(moved, { USD: 25800, CAD: 35800, GBP: 9900, AUD: 18900 });
  assert.deepEqual(reserved, { EUR: 20800 });
  assert.deepEqual(released, { JPY: 12800 });
  db.close();
});
