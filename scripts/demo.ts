import { createDatabase } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { FakePayPal } from '../src/paypal/fake.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { loadConfig } from '../src/config.ts';
import { DEMO_BUDGETS } from '../src/demo.ts';
import type { Order } from '../src/types.ts';

const db = createDatabase(':memory:');
const app = createApp({ db, paypal: new FakePayPal(), ai: new FakeAiProvider(), config: loadConfig({ PAYPAL_MODE: 'fake' }) });

async function request(path: string, cookie = '', payload?: unknown): Promise<unknown> {
  const response = await app.request(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const json = await response.json() as { data?: unknown; error?: { code: string; message: string } };
  if (!response.ok) throw new Error(`${path}: ${json.error?.code ?? response.status}`);
  return json.data;
}

try {
  const sessionResponse = await app.request('/v1/demo/session', { method: 'POST' });
  if (!sessionResponse.ok) throw new Error('Could not create demo session');
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Demo cookie missing');
  const recalls = await request('/v1/recalls', cookie) as { id: string }[];
  const recallId = recalls[0]?.id;
  if (!recallId) throw new Error('Demo recall missing');
  await request(`/v1/recalls/${recallId}/extract`, cookie, {});
  await request(`/v1/recalls/${recallId}/match`, cookie, {});
  const plan = await request(`/v1/recalls/${recallId}/plan`, cookie, {}) as { id: string; planHash: string; totals: Record<string, number>; items: { orderId: string; action: string }[] };
  const orders = await request('/v1/orders', cookie) as Order[];
  await request(`/v1/plans/${plan.id}/approve`, cookie, { planHash: plan.planHash, approver: 'Demo operator', budget: DEMO_BUDGETS });
  const settled = await request(`/v1/plans/${plan.id}/execute`, cookie, {}) as { action: string; amount_minor: number; currency: string; status: string }[];
  const timeline = await request(`/v1/plans/${plan.id}/timeline`, cookie) as { resourceId: string; action: string; status: string }[];
  console.log('RecallRelay fake mode demo');
  console.log('Timeline');
  for (const row of timeline) console.log(`${row.resourceId}: ${row.action} → ${row.status}`);
  console.log('Totals');
  for (const [currency, amount] of Object.entries(DEMO_BUDGETS)) console.log(`Budget ${currency} ${amount}`);
  const moved = new Map<string, number>();
  for (const entry of settled.filter(entry => entry.status === 'SUCCEEDED' && ['REFUND', 'PAYOUT'].includes(entry.action)))
    moved.set(entry.currency, (moved.get(entry.currency) ?? 0) + entry.amount_minor);
  for (const [currency, amount] of moved) console.log(`Moved ${currency} ${amount}`);
  const orderById = new Map(orders.map(order => [order.id, order]));
  const remaining = (order: Order) => order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0) - order.refundedMinor;
  const reserved = new Map<string, number>();
  for (const item of plan.items.filter(item => item.action === 'AWAIT_BUYER_CHOICE')) {
    const order = orderById.get(item.orderId)!;
    reserved.set(order.currency, (reserved.get(order.currency) ?? 0) + remaining(order));
  }
  for (const [currency, amount] of reserved) console.log(`Reserved ${currency} ${amount}`);
  for (const item of plan.items.filter(item => item.action === 'VOID_AUTHORIZATION')) {
    const order = orderById.get(item.orderId)!;
    if (timeline.some(row => row.resourceId === item.orderId && row.status === 'SUCCEEDED')) console.log(`Released ${order.currency} ${remaining(order)}`);
  }
} finally {
  db.close();
}
