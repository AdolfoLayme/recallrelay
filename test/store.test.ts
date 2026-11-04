import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';

class StoreGateway extends FakePayPal {
  creates = 0;
  captureCalls = 0;
  async createOrder(_intent: 'CAPTURE' | 'AUTHORIZE', items: {name:string;sku:string;quantity:number;unitPriceMinor:number;currency:string}[]): Promise<unknown> {
    this.creates++;
    assert.deepEqual(items, [{ name: 'Lumen Mini Space Heater', sku: 'HP-LMH-015', quantity: 1, unitPriceMinor: 12900, currency: 'USD' }]);
    return { id: 'paypal-order-1' };
  }
  async captureOrder(): Promise<unknown> {
    this.captureCalls++;
    return { id: 'paypal-order-1', status: 'COMPLETED', payer: { name: { given_name: 'Test', surname: 'Buyer' }, email_address: 'buyer@example.test' },
      purchase_units: [{ payee: { merchant_id: 'sandbox-merchant' }, payments: { captures: [{ id: 'capture-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '129.00' } }] } }] };
  }
}

test('store checks blocked SKU before creating an order and fixes price on the server', async () => {
  const db = createDatabase(':memory:');
  const paypal = new StoreGateway();
  const config = loadConfig({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'public-id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'pending', LINK_SIGNING_SECRET: 'test-key' });
  const app = createApp({ db, paypal, ai: new FakeAiProvider(), config });
  const started = await app.request('/v1/demo/session', { method: 'POST' });
  const headers = { Cookie: started.headers.get('set-cookie')!.split(';')[0], 'Content-Type': 'application/json' };
  assert.deepEqual((await (await app.request('/v1/paypal/client-config', { headers })).json()).data, { clientId: 'public-id', mode: 'sandbox' });
  assert.equal((await (await app.request('/v1/store/status', { headers })).json()).data.allowed, true);
  const created = await app.request('/v1/store/orders', { method: 'POST', headers, body: JSON.stringify({ country: 'US', price: 1 }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.id, 'paypal-order-1');
  assert.equal(paypal.creates, 1);
  const captured = await app.request('/v1/store/orders/paypal-order-1/capture', { method: 'POST', headers });
  assert.equal(captured.status, 200);
  assert.equal((await captured.json()).data.captureId, 'capture-1');
  assert.equal((await (await app.request('/v1/orders', { headers })).json()).data.length, 13);
  await app.request('/v1/store/orders/paypal-order-1/capture', { method: 'POST', headers });
  assert.equal(paypal.captureCalls, 1);
  await app.request('/v1/recalls/demo-lumen-mini-heater/block', { method: 'POST', headers, body: JSON.stringify({ skus: ['HP-LMH-015'] }) });
  const blocked = await app.request('/v1/store/orders', { method: 'POST', headers, body: JSON.stringify({ country: 'US' }) });
  assert.equal(blocked.status, 409);
  assert.equal((await (await app.request('/v1/store/status', { headers })).json()).data.allowed, false);
  assert.equal(paypal.creates, 1);
  db.close();
});

test('fake mode exposes no PayPal button configuration', async () => {
  const db = createDatabase(':memory:');
  const app = createApp({ db, paypal: new StoreGateway(), ai: new FakeAiProvider(), config: loadConfig({}) });
  const started = await app.request('/v1/demo/session', { method: 'POST' });
  const headers = { Cookie: started.headers.get('set-cookie')!.split(';')[0] };
  assert.deepEqual((await (await app.request('/v1/paypal/client-config', { headers })).json()).data, { mode: 'fake' });
  assert.equal((await app.request('/v1/store/orders', { method: 'POST', headers })).status, 409);
  db.close();
});
