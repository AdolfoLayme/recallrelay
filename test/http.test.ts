import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';
import { cleanupExpiredSessions } from '../src/demo.ts';
import { createRemedyToken } from '../src/remedy-link.ts';
import { hashPlan } from '../src/plan.ts';
import type { Plan } from '../src/plan.ts';

function setup() {
  const db = createDatabase(':memory:');
  const paypal = new FakePayPal();
  const app = createApp({ db, paypal, ai: new FakeAiProvider(), config: loadConfig({}) });
  return { db, app, paypal };
}

test('health and error responses expose fake mode and security headers', async () => {
  const { db, app } = setup();
  const health = await app.request('/health');
  assert.equal((await health.json()).meta.paypalMode, 'fake');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const missing = await app.request('/v1/plans/missing');
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).meta.paypalMode, 'fake');
  db.close();
});

test('demo sessions are isolated and reject another session cookie', async () => {
  const { db, app } = setup();
  const a = await app.request('/v1/demo/session', { method: 'POST' });
  const b = await app.request('/v1/demo/session', { method: 'POST' });
  const cookieA = a.headers.get('set-cookie')?.split(';')[0] ?? '';
  const cookieB = b.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.notEqual(cookieA, cookieB);
  const ordersA = await app.request('/v1/orders', { headers: { Cookie: cookieA } });
  const ordersB = await app.request('/v1/orders', { headers: { Cookie: cookieB } });
  assert.equal((await ordersA.json()).data.length, 12);
  assert.equal((await ordersB.json()).data.length, 12);
  const id = (await (await app.request('/v1/plans/missing', { headers: { Cookie: cookieA } })).json()).error.code;
  assert.equal(id, 'NOT_FOUND');
  db.close();
});

test('sandbox order import binds the capture to its merchant and routes it to sandbox', async () => {
  const db = createDatabase(':memory:');
  const paypal = new FakePayPal();
  paypal.registerCapture('import-capture', 1000, 'USD', 0, 'actual-merchant');
  const config = loadConfig({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret', PAYPAL_WEBHOOK_ID: 'test-webhook', LINK_SIGNING_SECRET: 'test-signing' });
  const app = createApp({ db, paypal, ai: new FakeAiProvider(), config });
  const started = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0];
  const sid = (await started.json()).data.sessionId;
  const order = { id: 'import-test', merchantId: 'wrong-merchant', buyerName: 'Buyer', buyerEmail: 'buyer@example.test',
    buyerCountry: 'US', language: 'en', currency: 'USD', status: 'CAPTURED', shipped: true,
    paidAt: new Date().toISOString(), captureId: 'import-capture', refundedMinor: 0,
    lines: [{ sku: 'S', name: 'Item', quantity: 1, unitPriceMinor: 1000, taxMinor: 0 }] };
  const send = (value: unknown) => app.request('/v1/orders/import', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ orders: [value] }) });
  assert.equal((await send(order)).status, 409);
  assert.equal((await send({ ...order, merchantId: 'actual-merchant', lines: [{ ...order.lines[0], unitPriceMinor: 900 }] })).status, 409);
  assert.equal((await send({ ...order, merchantId: 'actual-merchant', currency: 'CAD' })).status, 409);
  assert.equal((await send({ ...order, merchantId: 'actual-merchant' })).status, 201);
  const saved = db.prepare('SELECT body_json FROM orders WHERE id=? AND session_id=?').get(order.id, sid) as { body_json: string };
  assert.equal(JSON.parse(saved.body_json).gateway, 'sandbox');
  db.close();
});

test('checkout blocklist checks SKU before an order exists', async () => {
  const { db, app } = setup();
  const session = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
  const recallId = (await (await app.request('/v1/recalls', { headers: { Cookie: cookie } })).json()).data[0].id;
  await app.request(`/v1/recalls/${recallId}/block`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ skus: ['HP-LMH-015'] }) });
  const check = await app.request('/v1/checkout/check', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'HP-LMH-015', country: 'US' }) });
  assert.equal((await check.json()).data.allowed, false);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE entity='sale-block:demo-lumen-mini-heater'").get()?.n, 1);
  db.close();
});

test('expired demo session cannot read data', async () => {
  const { db, app } = setup();
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
  const sid = (await created.json()).data.sessionId;
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, sid);
  const response = await app.request('/v1/orders', { headers: { Cookie: cookie } });
  assert.equal(response.status, 401);
  db.close();
});

test('PayPal webhooks reject invalid signatures and deduplicate verified events', async () => {
  const { db, app } = setup();
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const sid = (await created.json()).data.sessionId;
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders WHERE session_id=? AND id=?').get(sid, '1042') as {body_json:string}).body_json);
  const plan: Plan = { id: 'p', recallId: 'r', items: [{orderId:order.id,merchantId:order.merchantId,action:'REFUND',amountMinor:100,currency:order.currency,reason:'Test',evidence:'Test',lineSkus:[order.lines[0].sku]}], totals: {USD:100}, planHash:'' };
  plan.planHash = hashPlan(plan);
  db.prepare('INSERT INTO plans(id,session_id,recall_id,body_json,plan_hash,created_at) VALUES(?,?,?,?,?,?)').run('p', sid, 'r', JSON.stringify(plan), plan.planHash, Date.now());
  db.prepare('INSERT INTO approvals(plan_id,session_id,plan_hash,approver,budget_json,created_at) VALUES(?,?,?,?,?,?)').run('p',sid,plan.planHash,'Human',JSON.stringify({USD:100}),Date.now());
  db.prepare('INSERT INTO outbox(session_id,plan_id,order_id,action,amount_minor,currency,idempotency_key,status,paypal_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid, 'p', order.id, 'REFUND', 100, 'USD', 'key', 'UNKNOWN', 'refund1', Date.now(), Date.now());
  const event = { id: 'event1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'refund1' } };
  const send = (valid: boolean) => app.request('/webhooks/paypal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fake-signature': valid ? 'valid' : 'invalid' }, body: JSON.stringify(event) });
  assert.equal((await send(false)).status, 400);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal((await send(true)).status, 200);
  assert.equal((await send(true)).status, 200);
  assert.equal(db.prepare('SELECT status FROM outbox').get()?.status, 'UNKNOWN');
  assert.equal(JSON.parse((db.prepare('SELECT body_json FROM orders WHERE session_id=? AND id=?').get(sid,order.id) as {body_json:string}).body_json).refundedMinor, order.refundedMinor);
  assert.equal(db.prepare('SELECT count(*) n FROM webhooks').get()?.n, 1);
  db.close();
});

test('verified refund webhook settles only a matching PayPal refund and updates the order once', async () => {
  const { db, app, paypal } = setup();
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const sid = (await created.json()).data.sessionId;
  const order = JSON.parse((db.prepare('SELECT body_json FROM orders WHERE session_id=? AND id=?').get(sid, '1042') as {body_json:string}).body_json);
  const plan: Plan = { id: 'webhook-plan', recallId: 'r', items: [{orderId:order.id,merchantId:order.merchantId,action:'REFUND',amountMinor:100,currency:'USD',reason:'Test',evidence:'Test',lineSkus:[order.lines[0].sku]}], totals:{USD:100}, planHash:'' };
  plan.planHash = hashPlan(plan);
  db.prepare('INSERT INTO plans(id,session_id,recall_id,body_json,plan_hash,created_at) VALUES(?,?,?,?,?,?)').run(plan.id,sid,'r',JSON.stringify(plan),plan.planHash,Date.now());
  db.prepare('INSERT INTO approvals(plan_id,session_id,plan_hash,approver,budget_json,created_at) VALUES(?,?,?,?,?,?)').run(plan.id,sid,plan.planHash,'Human',JSON.stringify({USD:100}),Date.now());
  const refund = await paypal.refundCapture(order.captureId,100,'USD','webhook-key');
  db.prepare('INSERT INTO outbox(session_id,plan_id,order_id,action,amount_minor,currency,idempotency_key,status,paypal_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,plan.id,order.id,'REFUND',100,'USD','webhook-key','UNKNOWN',refund.id,Date.now(),Date.now());
  const event = {id:'webhook-event',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:refund.id}};
  const send = () => app.request('/webhooks/paypal',{method:'POST',headers:{'Content-Type':'application/json','x-fake-signature':'valid'},body:JSON.stringify(event)});
  assert.equal((await send()).status,200);
  assert.equal((await send()).status,200);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE plan_id=?').get(plan.id)?.status,'SUCCEEDED');
  assert.equal(JSON.parse((db.prepare('SELECT body_json FROM orders WHERE session_id=? AND id=?').get(sid,order.id) as {body_json:string}).body_json).refundedMinor,order.refundedMinor+100);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE entity=?").get(`order:${order.id}`)?.n,1);
  db.close();
});

test('cleanup removes expired demo data after it has audit history', async () => {
  const { db, app } = setup();
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const sid = (await created.json()).data.sessionId;
  db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
    .run(sid, 'test', Date.now(), 'session', '{}', '{}');
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, sid);
  assert.equal(cleanupExpiredSessions(db), 1);
  assert.equal(db.prepare('SELECT count(*) n FROM orders WHERE session_id=?').get(sid)?.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM audit_log WHERE session_id=?').get(sid)?.n, 1);
  assert.equal(cleanupExpiredSessions(db), 0);
  db.close();
});

test('supplier invoice approval creates and sends the settled amount through PayPal', async () => {
  const db = createDatabase(':memory:');
  class InvoiceFake extends FakePayPal {
    async createInvoice(): Promise<{ id: string }> { return { id: 'paypal-invoice-1' }; }
    async sendInvoice(): Promise<void> { }
  }
  const app = createApp({ db, paypal: new InvoiceFake(), ai: new FakeAiProvider(), config: loadConfig({}) });
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const sid = (await created.json()).data.sessionId;
  const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
  const plan = { id: 'p', recallId: 'r', items: [], totals: {}, planHash: '' };
  const planHash = hashPlan(plan);
  db.prepare('INSERT INTO plans(id,session_id,recall_id,body_json,plan_hash,created_at) VALUES(?,?,?,?,?,?)').run('p', sid, 'r', JSON.stringify({ ...plan, planHash }), planHash, Date.now());
  db.prepare('INSERT INTO outbox(session_id,plan_id,order_id,action,amount_minor,currency,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(sid, 'p', 'o', 'REFUND', 12900, 'USD', 'invoice-key', 'SUCCEEDED', Date.now(), Date.now());
  const invoiceHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
  assert.equal((await app.request('/v1/supplier-invoices', { method: 'POST', headers: invoiceHeaders, body: '{}' })).status, 400);
  assert.equal((await app.request('/v1/supplier-invoices/approve', { method: 'POST', headers: invoiceHeaders,
    body: JSON.stringify({ planId: 'p', planHash: 'wrong', currency: 'USD', recipientEmail: 'supplier@example.test', approver: 'Human', budgetMinor: 12900 }) })).status, 409);
  const approvalResponse = await app.request('/v1/supplier-invoices/approve', { method: 'POST', headers: invoiceHeaders,
    body: JSON.stringify({ planId: 'p', planHash, currency: 'USD', recipientEmail: 'supplier@example.test', approver: 'Human', budgetMinor: 12900 }) });
  assert.equal(approvalResponse.status, 201);
  const approvalId = (await approvalResponse.json()).data.id;
  assert.equal(db.prepare('SELECT plan_hash FROM supplier_invoice_approvals WHERE id=?').get(approvalId)?.plan_hash, planHash);
  db.prepare('UPDATE outbox SET amount_minor=13000 WHERE idempotency_key=?').run('invoice-key');
  assert.equal((await app.request('/v1/supplier-invoices', { method: 'POST', headers: invoiceHeaders,
    body: JSON.stringify({ approvalId }) })).status, 409);
  db.prepare('UPDATE outbox SET amount_minor=12900 WHERE idempotency_key=?').run('invoice-key');
  const result = await app.request('/v1/supplier-invoices', { method: 'POST', headers: invoiceHeaders, body: JSON.stringify({ approvalId }) });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).data.status, 'SENT');
  const invoice = db.prepare('SELECT status,paypal_id FROM supplier_invoices WHERE session_id=?').get(sid);
  assert.equal(invoice?.status, 'SENT');
  assert.equal(invoice?.paypal_id, 'paypal-invoice-1');
  const repeated = await app.request('/v1/supplier-invoices', { method: 'POST', headers: invoiceHeaders, body: JSON.stringify({ approvalId }) });
  assert.equal(repeated.status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM supplier_invoices').get()?.n, 1);
  const transitions = db.prepare("SELECT before_json,after_json FROM audit_log WHERE session_id=? AND entity LIKE 'invoice:%' ORDER BY id").all(sid) as {before_json:string;after_json:string}[];
  assert.deepEqual(transitions.map(row => [JSON.parse(row.before_json).status ?? null, JSON.parse(row.after_json).status]),
    [[null, 'APPROVED'], ['APPROVED', 'CREATED'], ['CREATED', 'SENT']]);
  db.close();
});

test('an uncertain invoice send remains recorded for review with its PayPal id', async () => {
  class UncertainInvoice extends FakePayPal {
    async createInvoice(): Promise<{id:string}> { return {id:'paypal-uncertain'}; }
    async sendInvoice(): Promise<void> { throw new Error('timeout after send'); }
  }
  const db = createDatabase(':memory:');
  const app = createApp({db,paypal:new UncertainInvoice(),ai:new FakeAiProvider(),config:loadConfig({})});
  const created = await app.request('/v1/demo/session',{method:'POST'});
  const sid = (await created.json()).data.sessionId;
  const headers = {Cookie:created.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json'};
  const plan = {id:'invoice-plan',recallId:'r',items:[],totals:{},planHash:''};
  plan.planHash=hashPlan(plan);
  db.prepare('INSERT INTO plans(id,session_id,recall_id,body_json,plan_hash,created_at) VALUES(?,?,?,?,?,?)').run(plan.id,sid,'r',JSON.stringify(plan),plan.planHash,Date.now());
  db.prepare('INSERT INTO outbox(session_id,plan_id,order_id,action,amount_minor,currency,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(sid,plan.id,'o','REFUND',100,'USD','invoice-uncertain-key','SUCCEEDED',Date.now(),Date.now());
  const approval = await app.request('/v1/supplier-invoices/approve',{method:'POST',headers,body:JSON.stringify({planId:plan.id,planHash:plan.planHash,currency:'USD',recipientEmail:'supplier@example.test',approver:'Human',budgetMinor:100})});
  const approvalId = (await approval.json()).data.id;
  assert.equal((await app.request('/v1/supplier-invoices',{method:'POST',headers,body:JSON.stringify({approvalId})})).status,502);
  const invoice = db.prepare('SELECT status,paypal_id FROM supplier_invoices').get();
  assert.equal(invoice?.status,'UNKNOWN');
  assert.equal(invoice?.paypal_id,'paypal-uncertain');
  const transitions = db.prepare("SELECT before_json,after_json FROM audit_log WHERE entity LIKE 'invoice:%' ORDER BY id").all() as {before_json:string;after_json:string}[];
  assert.deepEqual(transitions.map(row => [JSON.parse(row.before_json).status ?? null, JSON.parse(row.after_json).status]),
    [[null, 'APPROVED'], ['APPROVED', 'CREATED'], ['CREATED', 'UNKNOWN']]);
  assert.equal((await app.request('/v1/supplier-invoices',{method:'POST',headers,body:JSON.stringify({approvalId})})).status,409);
  db.close();
});

test('remedy lookup cannot read an expired demo session', async () => {
  const db = createDatabase(':memory:');
  const config = loadConfig({});
  const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config });
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const sid = (await created.json()).data.sessionId;
  const token = createRemedyToken({ sessionId: sid, orderId: '1042', recallId: 'demo-lumen-mini-heater', expiresAt: Date.now() + 86_400_000 }, config.linkSigningSecret);
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, sid);
  assert.equal((await app.request(`/v1/remedy/${token}`)).status, 401);
  db.close();
});

test('oversized request error includes fake mode metadata', async () => {
  const { db, app } = setup();
  const response = await app.request('/v1/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(1_048_577) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).meta.paypalMode, 'fake');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  db.close();
});

test('pending webhook ID disables only the webhook endpoint', async () => {
  const db = createDatabase(':memory:');
  const config = loadConfig({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'pending', LINK_SIGNING_SECRET: 'local-test-key' });
  const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config });
  const response = await app.request('/webhooks/paypal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'event', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {} }) });
  assert.equal(response.status, 503);
  assert.equal((await app.request('/health')).status, 200);
  db.close();
});

test('execution priority changes without changing approved plan or amounts', async () => {
  const { db, app } = setup();
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  await app.request('/v1/recalls/demo-lumen-mini-heater/extract', { method: 'POST', headers });
  const plan = (await (await app.request('/v1/recalls/demo-lumen-mini-heater/plan', { method: 'POST', headers })).json()).data;
  const reordered = await app.request(`/v1/plans/${plan.id}/order`, { method: 'POST', headers, body: JSON.stringify({ orderIds: ['0994', ...plan.items.map((item: {orderId:string}) => item.orderId).filter((id: string) => id !== '0994')] }) });
  assert.equal(reordered.status, 200);
  assert.equal((await reordered.json()).data.orderIds[0], '0994');
  const after = (await (await app.request(`/v1/plans/${plan.id}`, { headers })).json()).data;
  assert.deepEqual(after, plan);
  db.close();
});

test('static page loads do not consume the API rate limit', async () => {
  const {db,app}=setup();
  for(let index=0;index<125;index++) assert.equal((await app.request('/')).status,200);
  assert.equal((await app.request('/health')).status,200);
  db.close();
});

test('active sessions have independent API rate limits', async () => {
  const {db,app}=setup();
  const one=(await app.request('/v1/demo/session',{method:'POST'})).headers.get('set-cookie')!.split(';')[0];
  const two=(await app.request('/v1/demo/session',{method:'POST'})).headers.get('set-cookie')!.split(';')[0];
  for(let index=0;index<119;index++) {
    assert.equal((await app.request('/v1/orders',{headers:{Cookie:one}})).status,200);
    assert.equal((await app.request('/v1/orders',{headers:{Cookie:two}})).status,200);
  }
  assert.equal((await app.request('/v1/orders',{headers:{Cookie:one}})).status,200);
  assert.equal((await app.request('/v1/orders',{headers:{Cookie:two}})).status,200);
  assert.equal((await app.request('/v1/orders',{headers:{Cookie:one}})).status,429);
  assert.equal((await app.request('/v1/orders',{headers:{Cookie:two}})).status,429);
  db.close();
});

test('CORS allows only configured origins', async () => {
  const db=createDatabase(':memory:');
  const app=createApp({db,paypal:new FakePayPal(),ai:new FakeAiProvider(),config:loadConfig({ALLOWED_ORIGINS:'https://operator.example'})});
  const allowed=await app.request('/v1/orders',{method:'OPTIONS',headers:{Origin:'https://operator.example'}});
  assert.equal(allowed.headers.get('access-control-allow-origin'),'https://operator.example');
  assert.equal(allowed.headers.get('access-control-allow-credentials'),'true');
  const denied=await app.request('/v1/orders',{method:'OPTIONS',headers:{Origin:'https://other.example'}});
  assert.equal(denied.headers.get('access-control-allow-origin'),null);
  db.close();
});

test('AI extraction cap returns a clear HTTP error', async () => {
  const db=createDatabase(':memory:');
  const app=createApp({db,paypal:new FakePayPal(),ai:new FakeAiProvider(),config:loadConfig({AI_MAX_CALLS_PER_SESSION:'1'})});
  const session=await app.request('/v1/demo/session',{method:'POST'});
  const headers={Cookie:session.headers.get('set-cookie')!.split(';')[0]};
  assert.equal((await app.request('/v1/recalls/demo-lumen-mini-heater/extract',{method:'POST',headers})).status,200);
  const limited=await app.request('/v1/recalls/demo-lumen-mini-heater/extract',{method:'POST',headers});
  assert.equal(limited.status,429);
  assert.equal((await limited.json()).error.code,'AI_LIMIT');
  db.close();
});

test('human product-match decision creates a new unapproved plan and audits the actor', async () => {
  const {db,app}=setup();
  const started=await app.request('/v1/demo/session',{method:'POST'});
  const headers={Cookie:started.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json'};
  await app.request('/v1/recalls/demo-lumen-mini-heater/extract',{method:'POST',headers});
  const plan=(await (await app.request('/v1/recalls/demo-lumen-mini-heater/plan',{method:'POST',headers})).json()).data;
  await app.request(`/v1/plans/${plan.id}/approve`,{method:'POST',headers,body:JSON.stringify({planHash:plan.planHash,approver:'Human',budget:{USD:30000,CAD:40000,GBP:15000,AUD:20000,EUR:25000}})});
  const queue=(await (await app.request('/v1/review-queue',{headers})).json()).data as {id:string;body_json:string}[];
  const weak=queue.find(row=>JSON.parse(row.body_json).orderId==='1077')!;
  const response=await app.request(`/v1/review-queue/${weak.id}/resolve`,{method:'POST',headers,body:JSON.stringify({resolution:'Add to plan',actor:'Case operator'})});
  assert.equal(response.status,200);
  const nextId=(await response.json()).data.planId as string;
  assert.notEqual(nextId,plan.id);
  const next=(await (await app.request(`/v1/plans/${nextId}`,{headers})).json()).data;
  assert.equal(next.items.find((item:{orderId:string})=>item.orderId==='1077').action,'REFUND');
  assert.equal(next.items.find((item:{orderId:string})=>item.orderId==='1077').amountMinor,12900);
  assert.equal((await (await app.request(`/v1/plans/${nextId}/approval`,{headers})).json()).data.approved,false);
  assert.equal((await (await app.request(`/v1/plans/${plan.id}`,{headers})).json()).data.planHash,plan.planHash);
  assert.match(String(db.prepare("SELECT actor FROM audit_log WHERE entity LIKE 'review:%'").get()?.actor),/Case operator/);
  db.close();
});
