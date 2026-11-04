import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';

test('checked EU notice sends once; failing draft enters review without sending', async () => {
  const db = createDatabase(':memory:');
  const sent: string[] = [];
  const ai = new FakeAiProvider();
  const app = createApp({ db, paypal: new FakePayPal(), ai, config: loadConfig({}),
    sendNotice: async (_address, text) => { sent.push(text); } });
  const created = await app.request('/v1/demo/session', { method: 'POST' });
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const call = () => app.request('/v1/notices/send', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recallId: 'demo-lumen-mini-heater', orderId: '1051', contact: 'support@example.test' }) });
  const good = await call();
  assert.equal(good.status, 200);
  assert.equal((await good.json()).data.status, 'SENT');
  assert.equal(sent.length, 1);
  assert.equal((await call()).status, 200);
  assert.equal(sent.length, 1);
  const broken = createApp({ db, paypal: new FakePayPal(), ai: { ...ai,
    extractRecall: notice => ai.extractRecall(notice), draftNotice: async () => 'Voluntary recall. No accidents reported.' },
    config: loadConfig({}), sendNotice: async () => { sent.push('bad'); } });
  const failed = await broken.request('/v1/notices/send', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recallId: 'demo-lumen-mini-heater', orderId: '1060', contact: 'support@example.test' }) });
  assert.equal(failed.status, 409);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM review_queue WHERE kind='NOTICE'").get()?.n, 1);
  db.close();
});

test('notice preview shows checker results without delivering', async () => {
  const db = createDatabase(':memory:');
  const sent: string[] = [];
  const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config: loadConfig({}), sendNotice: async (_address,text)=>{sent.push(text);} });
  const started = await app.request('/v1/demo/session', {method:'POST'});
  const headers = { Cookie: started.headers.get('set-cookie')!.split(';')[0], 'Content-Type': 'application/json' };
  const response = await app.request('/v1/notices/check', {method:'POST',headers,body:JSON.stringify({recallId:'demo-lumen-mini-heater',orderId:'1051',contact:'support@example.test'})});
  assert.equal(response.status,200);
  const result=(await response.json()).data;
  assert.equal(result.ok,true);
  assert.match(result.text,/Produktsicherheitsrückruf/);
  assert.equal(sent.length,0);
  db.close();
});
