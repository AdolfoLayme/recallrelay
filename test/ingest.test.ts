import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';
import { convertTransaction } from '../src/transactions.ts';
import type { RecallNotice } from '../src/sources/types.ts';

const sale = {
  transaction_info: { transaction_id: 'capture-123', transaction_event_code: 'T0006', transaction_status: 'S',
    transaction_initiation_date: '2026-10-01T00:00:00Z', transaction_amount: { currency_code: 'USD', value: '12.34' } },
  payer_info: { email_address: 'buyer@example.test', payer_name: { given_name: 'Test', surname: 'Buyer' }, country_code: 'US' },
  cart_info: { item_details: [{ item_code: 'SKU-1', item_name: 'Fictional heater', item_quantity: '2', item_unit_price: { currency_code: 'USD', value: '6.17' } }] },
};

test('transaction conversion accepts complete sales and reviews missing items', () => {
  const converted = convertTransaction(sale, 'merchant-1');
  assert.equal(converted.order?.captureId, 'capture-123');
  assert.equal(converted.order?.lines[0].unitPriceMinor, 617);
  assert.equal(converted.order?.lines[0].quantity, 2);
  assert.equal(convertTransaction({ ...sale, cart_info: {} }, 'merchant-1').reviewReason, 'MISSING_ITEM_DETAILS');
  assert.equal(convertTransaction({ ...sale, transaction_info: { ...sale.transaction_info, transaction_event_code: 'T1107' } }, 'merchant-1').order, undefined);
});

test('transaction sync imports only complete records and puts missing items into review', async () => {
  class SearchFake extends FakePayPal {
    async searchTransactions(): Promise<unknown[]> { return [sale, { ...sale, transaction_info: { ...sale.transaction_info, transaction_id: 'capture-456' }, cart_info: {} }]; }
  }
  const db = createDatabase(':memory:');
  const app = createApp({ db, paypal: new SearchFake(), ai: new FakeAiProvider(), config: loadConfig({}) });
  const session = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const result = await app.request('/v1/orders/sync', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId: 'merchant-1', start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }) });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data, { imported: 1, manualReview: 1, skipped: 0 });
  assert.equal(db.prepare("SELECT count(*) n FROM orders WHERE id='capture-123'").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM review_queue WHERE kind='ORDER_IMPORT'").get()?.n, 1);
  db.close();
});

test('source refresh persists official notices for listing, extraction, matching and planning', async () => {
  const notice: RecallNotice = { id: 'official-1', source: 'CPSC', country: 'US', publishedAt: '2026-10-01',
    title: 'Fictional heater notice', rawText: 'Harbor heater model HP-LMH-015 has a fire hazard. SKU HP-LMH-015.',
    url: 'https://www.cpsc.gov/Recalls/example', language: 'en', imageUrls: [], identifiers: ['HP-LMH-015'], hazard: 'fire hazard' };
  const db = createDatabase(':memory:');
  const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config: loadConfig({}),
    sources: async () => ({ notices: [notice], status: { CPSC: { ok: true, count: 1 }, HEALTH_CANADA: { ok: false, count: 0, error: 'Source unavailable' },
      GOV_UK: { ok: true, count: 0 }, EU_SAFETY_GATE: { ok: true, count: 0 }, OECD_GLOBAL_RECALLS: { ok: true, count: 0 } } }) });
  const session = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const call = (path: string) => app.request(path, { method: 'POST', headers: { Cookie: cookie } });
  const refreshed = await call('/v1/sources/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).data.imported, 1);
  const status = await app.request('/v1/sources', { headers: { Cookie: cookie } });
  assert.equal((await status.json()).data.HEALTH_CANADA.ok, false);
  const listed = await app.request('/v1/recalls?source=CPSC', { headers: { Cookie: cookie } });
  assert.deepEqual((await listed.json()).data.map((x: RecallNotice) => x.id), ['official-1']);
  assert.equal((await call('/v1/recalls/official-1/extract')).status, 200);
  assert.equal((await call('/v1/recalls/official-1/match')).status, 200);
  assert.equal((await call('/v1/recalls/official-1/plan')).status, 201);
  assert.equal((await call('/v1/sources/refresh')).status, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM recalls WHERE id='official-1'").get()?.n, 1);
  db.close();
});
