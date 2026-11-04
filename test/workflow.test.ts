import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';
import { LINK_LIFETIME_MS, verifyRemedyToken } from '../src/remedy-link.ts';
import { cleanupExpiredSessions } from '../src/demo.ts';

function fixture() {
  const db = createDatabase(':memory:');
  const paypal = new FakePayPal();
  const config = loadConfig({});
  const app = createApp({ db, paypal, ai: new FakeAiProvider(), config });
  return { db, paypal, config, app };
}

async function post(app: ReturnType<typeof createApp>, path: string, cookie: string, value: unknown) {
  return app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

async function planned() {
  const f = fixture();
  const started = await f.app.request('/v1/demo/session', { method: 'POST' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0];
  const sid = (await started.json()).data.sessionId as string;
  const recall = 'demo-lumen-mini-heater';
  assert.equal((await post(f.app, `/v1/recalls/${recall}/extract`, cookie, {})).status, 200);
  assert.equal((await post(f.app, `/v1/recalls/${recall}/match`, cookie, {})).status, 200);
  const planned = await post(f.app, `/v1/recalls/${recall}/plan`, cookie, {});
  assert.equal(planned.status, 201);
  const plan = (await planned.json()).data;
  assert.equal((await post(f.app, `/v1/plans/${plan.id}/approve`, cookie, {
    planHash: plan.planHash, approver: 'Human', budget: { USD: 30000, CAD: 40000, GBP: 15000, AUD: 20000, EUR: 25000 },
  })).status, 200);
  return { ...f, cookie, sid, plan, recall };
}

test('POST creates a fixed 30-day buyer link only for an approved choice', async () => {
  const f = await planned();
  const before = Date.now();
  const response = await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId: '1051' });
  assert.equal(response.status, 201);
  const link = (await response.json()).data;
  const payload = verifyRemedyToken(link.token, f.config.linkSigningSecret);
  assert.equal(payload.orderId, '1051');
  assert.ok(payload.expiresAt >= before + LINK_LIFETIME_MS);
  assert.ok(payload.expiresAt <= Date.now() + LINK_LIFETIME_MS);
  assert.equal((await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId: '1051', expiresAt: Date.now() + 1 })).status, 400);
  assert.equal((await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId: '1042' })).status, 409);
  f.db.close();
});

test('EU refund choice executes the approved reservation once and repair can switch after due date', async () => {
  const f = await planned();
  for (const orderId of ['1051', '1060']) {
    const minted = await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId });
    const { token } = (await minted.json()).data;
    if (orderId === '1051') {
      const repair = await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'repair' });
      assert.equal(repair.status, 200);
      assert.equal((await repair.json()).data.choice, 'repair');
      assert.equal(f.db.prepare("SELECT status FROM fulfilment_tasks WHERE order_id='1051'").get()?.status, 'OPEN');
      assert.equal((await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund' })).status, 409);
      f.db.prepare("UPDATE fulfilment_tasks SET due_at=? WHERE order_id='1051'").run(Date.now() - 1);
    }
    const refund = await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund' });
    assert.equal(refund.status, 200);
    assert.equal((await refund.json()).data.action, 'REFUND');
    assert.equal((await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund' })).status, 200);
  }
  assert.equal(f.db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM outbox WHERE currency='EUR' AND status='SUCCEEDED'").get()?.n, 20800);
  assert.equal(f.paypal.sentCount, 2);
  assert.equal(f.db.prepare("SELECT status FROM fulfilment_tasks WHERE order_id='1051'").get()?.status, 'SWITCHED_TO_REFUND');
  f.db.close();
});

test('buyer refund request beyond 180 days becomes a payout and requires confirmed PayPal email', async () => {
  const f = await planned();
  const row = f.db.prepare("SELECT body_json FROM orders WHERE id='1051'").get() as { body_json: string };
  f.db.prepare("UPDATE orders SET body_json=? WHERE id='1051'").run(JSON.stringify({ ...JSON.parse(row.body_json), paidAt: new Date(Date.now() - 181 * 86_400_000).toISOString() }));
  const minted = await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId: '1051' });
  const { token } = (await minted.json()).data;
  assert.equal((await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund' })).status, 400);
  const payout = await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund', paypalEmail: 'confirmed@example.test' });
  assert.equal(payout.status, 200);
  assert.equal((await payout.json()).data.action, 'PAYOUT');
  assert.equal(f.db.prepare("SELECT action,status,amount_minor FROM outbox WHERE order_id='1051'").get()?.action, 'PAYOUT');
  assert.equal(f.paypal.sentCount, 1);
  f.db.close();
});

test('issued remedy link can switch an overdue repair after the demo login expires', async () => {
  const f = await planned();
  const minted = await post(f.app, '/v1/remedy-links', f.cookie, { planId: f.plan.id, orderId: '1051' });
  const { token } = (await minted.json()).data;
  assert.equal((await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'repair' })).status, 200);
  f.db.prepare("UPDATE fulfilment_tasks SET due_at=? WHERE order_id='1051'").run(Date.now() - 1);
  f.db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, f.sid);
  cleanupExpiredSessions(f.db);
  assert.equal((await f.app.request('/v1/orders', { headers: { Cookie: f.cookie } })).status, 401);
  assert.equal((await f.app.request(`/v1/remedy/${token}`)).status, 200);
  const switched = await post(f.app, `/v1/remedy/${token}/choice`, '', { choice: 'refund' });
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).data.status, 'SUCCEEDED');
  f.db.close();
});
