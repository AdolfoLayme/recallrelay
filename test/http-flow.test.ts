import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';

test('full HTTP flow settles the EU buyer choice and sends the supplier invoice', async () => {
  const db = createDatabase(':memory:');
  const paypal = new FakePayPal();
  const app = createApp({ db, paypal, ai: new FakeAiProvider(), config: loadConfig({}) });
  const started = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, value?: unknown) => {
    const response = await app.request(path, { method: value === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  };
  const recallId = 'demo-lumen-mini-heater';
  assert.equal((await request(`/v1/recalls/${recallId}`)).body.data.id, recallId);
  assert.equal((await request(`/v1/recalls/${recallId}/extract`, {})).status, 200);
  assert.equal((await request(`/v1/recalls/${recallId}/match`, {})).body.data.length, 12);
  const plan = (await request(`/v1/recalls/${recallId}/plan`, {})).body.data;
  assert.equal((await request(`/v1/plans/${plan.id}`)).body.data.planHash, plan.planHash);
  assert.equal((await request(`/v1/plans/${plan.id}/timeline`)).body.data.length, 12);
  assert.equal((await request(`/v1/plans/${plan.id}/approve`, { planHash: plan.planHash, approver: 'Human',
    budget: { USD: 30000, CAD: 40000, GBP: 15000, AUD: 20000, EUR: 25000 } })).status, 200);
  const executed = (await request(`/v1/plans/${plan.id}/execute`, {})).body.data;
  assert.equal(executed.filter((row: { status: string }) => row.status === 'SUCCEEDED').length, 7);
  const link = (await request('/v1/remedy-links', { planId: plan.id, orderId: '1051' })).body.data;
  const lookup = await app.request(`/v1/remedy/${link.token}`);
  const lookupBody = await lookup.json();
  assert.equal(lookup.status, 200);
  assert.equal(lookupBody.data.currency, 'EUR');
  assert.ok(!JSON.stringify(lookupBody).includes('buyerEmail'));
  assert.equal((await app.request(`/v1/remedy/${link.token}x`)).status, 400);
  const choice = await app.request(`/v1/remedy/${link.token}/choice`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'refund' }) });
  assert.equal(choice.status, 200);
  const choicePlanId = (await choice.json()).data.planId as string;
  assert.equal(db.prepare("SELECT amount_minor FROM outbox WHERE plan_id=? AND action='REFUND'").get(choicePlanId)?.amount_minor, 11900);
  const choicePlan = await request(`/v1/plans/${choicePlanId}`);
  const invoiceApproval = await request('/v1/supplier-invoices/approve', { planId: choicePlanId,
    planHash: choicePlan.body.data.planHash, currency: 'EUR', recipientEmail: 'supplier@example.test',
    approver: 'Human', budgetMinor: 11900 });
  assert.equal(invoiceApproval.status, 201);
  const invoice = await request('/v1/supplier-invoices', { approvalId: invoiceApproval.body.data.id });
  assert.equal(invoice.status, 201);
  assert.equal(invoice.body.data.amountMinor, 11900);
  assert.equal(invoice.body.data.status, 'SENT');
  assert.ok((await request('/v1/audit')).body.data.length > 0);
  const french = (await request('/v1/remedy-links', { planId: plan.id, orderId: '1060' })).body.data;
  assert.equal((await (await app.request(`/v1/remedy/${french.token}`)).json()).data.amount, 8900);
  db.close();
});

test('direct order import and review resolution routes validate and persist', async () => {
  const db = createDatabase(':memory:');
  const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config: loadConfig({}) });
  const started = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const order = { id: 'import-1', merchantId: 'harbor-pine', buyerName: 'Example Buyer', buyerEmail: 'import@example.test',
    buyerCountry: 'US', language: 'en', currency: 'USD', status: 'CAPTURED', shipped: true,
    paidAt: new Date().toISOString(), captureId: 'import-capture-1', refundedMinor: 0,
    lines: [{ sku: 'HP-LMH-015', name: 'Harbor & Pine Lumen Mini Space Heater', quantity: 1, unitPriceMinor: 12900, taxMinor: 0 }] };
  const imported = await app.request('/v1/orders/import', { method: 'POST', headers, body: JSON.stringify({ orders: [order] }) });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).data.imported, 1);
  assert.equal((await (await app.request('/v1/orders', { headers })).json()).data.length, 13);
  assert.equal((await app.request('/v1/orders/import', { method: 'POST', headers, body: JSON.stringify({ orders: [{ ...order, buyerEmail: 'bad' }] }) })).status, 400);
  const sid = (await started.json()).data.sessionId;
  db.prepare('INSERT INTO review_queue(id,session_id,kind,body_json) VALUES(?,?,?,?)').run('review-1', sid, 'TEST', '{}');
  const queueBefore = (await (await app.request('/v1/review-queue', { headers })).json()).data;
  assert.equal(queueBefore.length, 3);
  assert.equal(queueBefore.filter((item: { id: string }) => item.id === 'review-1').length, 1);
  const resolved = await app.request('/v1/review-queue/review-1/resolve', { method: 'POST', headers, body: JSON.stringify({ resolution: 'checked' }) });
  assert.equal(resolved.status, 200);
  const queueAfter = (await (await app.request('/v1/review-queue', { headers })).json()).data;
  assert.equal(queueAfter.find((item: { id: string }) => item.id === 'review-1').status, 'RESOLVED');
  assert.equal(queueAfter.filter((item: { status: string }) => item.status === 'PENDING').length, 2);
  db.close();
});
