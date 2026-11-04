import test from 'node:test';
import assert from 'node:assert/strict';
import { fromPayPalAmount, toPayPalAmount } from '../src/money.ts';
import { matchOrder } from '../src/matching.ts';
import { classify } from '../src/policy.ts';
import type { Order } from '../src/types.ts';

const now = new Date('2026-11-03T00:00:00.000Z');
function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1', merchantId: 'm1', buyerName: 'A', buyerEmail: 'a@example.test',
    buyerCountry: 'US', language: 'en', currency: 'USD', status: 'CAPTURED',
    shipped: true, paidAt: '2026-05-07T00:00:00.000Z', captureId: 'c1',
    refundedMinor: 0,
    lines: [
      { sku: 'HOT', name: 'Harbor Heater', quantity: 1, unitPriceMinor: 1000, taxMinor: 80 },
      { sku: 'SAFE', name: 'Harbor Lamp', quantity: 2, unitPriceMinor: 500, taxMinor: 40 },
    ], ...overrides,
  };
}

test('money emits PayPal strings without rounding or floats', () => {
  assert.equal(toPayPalAmount(1234, 'EUR'), '12.34');
  assert.equal(toPayPalAmount(125, 'JPY'), '125');
  assert.equal(fromPayPalAmount('12.34', 'EUR'), 1234);
  assert.equal(fromPayPalAmount('125', 'JPY'), 125);
  assert.throws(() => fromPayPalAmount('1.234', 'EUR'));
  assert.throws(() => toPayPalAmount(1.5, 'USD'));
});

test('matching uses exact sku and rejects weak name similarity', () => {
  const products = [{ brand: 'Harbor', model: 'Heater', sku: 'HOT', gtin: '', aliases: [] }];
  assert.equal(matchOrder(products, order()).score, 1);
  assert.equal(matchOrder([{ ...products[0], sku: 'OTHER' }], order()).score, 0.95);
  assert.equal(matchOrder([{ ...products[0], sku: 'OTHER' }], order({ lines: [{ ...order().lines[0], name: 'Compact Harbor Heater blue' }] })).score, 0.85);
  assert.ok(matchOrder([{ brand: 'Other', model: 'Heater', sku: '', gtin: '', aliases: [] }], order()).score < 0.85);
});

test('policy applies each ordered row and only prices the affected line', () => {
  const hit = { score: 1, lineSkus: ['HOT'], reason: 'sku' };
  assert.equal(classify(order(), { ...hit, score: 0.84 }, { now }).action, 'MANUAL_REVIEW');
  assert.equal(classify(order({ status: 'REFUNDED' }), hit, { now }).action, 'NO_ACTION');
  assert.equal(classify(order({ status: 'VOIDED' }), hit, { now }).action, 'NO_ACTION');
  assert.equal(classify(order({ status: 'AUTHORIZED', shipped: false }), hit, { now }).action, 'VOID_AUTHORIZATION');
  assert.equal(classify(order({ status: 'AUTHORIZED', shipped: true }), hit, { now }).action, 'MANUAL_REVIEW');
  assert.equal(classify(order({ refundedMinor: 2120 }), hit, { now }).action, 'NO_ACTION');
  assert.equal(classify(order({ buyerCountry: 'DE' }), hit, { now }).action, 'AWAIT_BUYER_CHOICE');
  assert.deepEqual(classify(order(), hit, { now }), { action: 'REFUND', amountMinor: 1080, reason: 'Within refund window' });
  assert.equal(classify(order({ paidAt: '2026-05-06T00:00:00.000Z' }), hit, { now }).action, 'PAYOUT');
  assert.equal(classify(order({ refundedMinor: 1700 }), hit, { now }).amountMinor, 420);
});

test('buyer refund choice resumes 180-day policy and repair creates a task', () => {
  const hit = { score: 1, lineSkus: ['HOT'], reason: 'sku' };
  assert.equal(classify(order({ buyerCountry: 'FR' }), hit, { now, choice: 'refund' }).action, 'REFUND');
  assert.equal(classify(order({ buyerCountry: 'FR' }), hit, { now, choice: 'repair' }).action, 'FULFILMENT_TASK');
  assert.equal(classify(order({ buyerCountry: 'FR', paidAt: '2026-05-06T00:00:00.000Z' }), hit, { now, choice: 'refund' }).action, 'PAYOUT');
});
