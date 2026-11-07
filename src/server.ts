import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z, ZodError } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { createDatabase, savePlan, approvePlan } from './db.ts';
import { createDemoSession, cleanupExpiredSessions, DEMO_REFERENCE_TIME, DEMO_BUDGETS, DEMO_NOTICE_WARNING_DE, DEMO_NOTICE_DRAFT_DE, DEMO_EXECUTION_ORDER } from './demo.ts';
import { loadConfig, redactLog } from './config.ts';
import type { Config } from './config.ts';
import type { PayPalGateway } from './paypal/gateway.ts';
import { FakePayPal } from './paypal/fake.ts';
import { SandboxPayPal } from './paypal/sandbox.ts';
import type { AiProvider, Extraction } from './ai/provider.ts';
import { FakeAiProvider } from './ai/fake.ts';

// The demo recall uses fixed notices so every judge sees the same check.
const DEMO_NOTICE_WRITER = new FakeAiProvider();
import { OpenAiCompatibleProvider } from './ai/provider.ts';
import type { RecallNotice } from './sources/types.ts';
import { loadSources } from './sources/index.ts';
import { matchOrder } from './matching.ts';
import { buildPlan, hashPlan } from './plan.ts';
import type { Plan } from './plan.ts';
import { classify } from './policy.ts';
import { executePlan, reconcilePlan } from './executor.ts';
import { createRemedyToken, verifyRemedyToken, recordBuyerChoice, LINK_LIFETIME_MS } from './remedy-link.ts';
import type { Order } from './types.ts';
import { convertTransaction } from './transactions.ts';
import { checkNotice } from './notice.ts';
import { fromPayPalAmount } from './money.ts';

type AppVariables = { sessionId: string };
type App = Hono<{ Variables: AppVariables }>;
type Dependencies = { db: DatabaseSync; paypal: PayPalGateway; ai: AiProvider; config: Config; sources?: typeof loadSources; sendNotice?: (address: string, text: string) => Promise<void> };
class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

const id = z.string().min(1).max(256);
const minor = z.number().int().nonnegative().safe();
const lineSchema = z.object({ sku: id, gtin: id.optional(), name: id, quantity: z.number().int().positive(), unitPriceMinor: minor, taxMinor: minor });
const orderSchema = z.object({
  id, merchantId: id, buyerName: id, buyerEmail: z.email(), buyerCountry: z.string().length(2), language: z.string().min(2).max(8),
  currency: z.string().length(3), status: z.enum(['AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED']),
  shipped: z.boolean(), paidAt: z.iso.datetime({ offset: true }), authorizationId: id.optional(), captureId: id.optional(),
  refundedMinor: minor, lines: z.array(lineSchema).min(1),
});

function data(c: Context, payload: unknown, status = 200): Response {
  return c.json({ data: payload, meta: { paypalMode: c.get('paypalMode' as never) } }, status as 200);
}
function failure(c: Context, code: string, message: string, status: number): Response {
  return c.json({ error: { code, message }, meta: { paypalMode: c.get('paypalMode' as never) } }, status as 400);
}
function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  return c.req.json().then(value => schema.parse(value));
}
function session(c: Context<{ Variables: AppVariables }>): string { return c.get('sessionId'); }
function record(db: DatabaseSync, table: 'recalls' | 'orders' | 'plans', sessionId: string, recordId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT body_json FROM ${table} WHERE id=? AND session_id=?`).get(recordId, sessionId) as { body_json: string } | undefined;
  if (!row) throw new ApiError('NOT_FOUND', 'Record not found', 404);
  return JSON.parse(row.body_json) as Record<string, unknown>;
}
function list(db: DatabaseSync, table: 'recalls' | 'orders' | 'plans', sessionId: string): Record<string, unknown>[] {
  return (db.prepare(`SELECT body_json FROM ${table} WHERE session_id=? ORDER BY rowid`).all(sessionId) as { body_json: string }[]).map(row => JSON.parse(row.body_json) as Record<string, unknown>);
}
function audit(db: DatabaseSync, sessionId: string, actor: string, entity: string, after: unknown, before: unknown = {}): void {
  db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
    .run(sessionId, actor, Date.now(), entity, JSON.stringify(before), JSON.stringify(after));
}
function setInvoiceState(db: DatabaseSync, sessionId: string, invoiceId: string, actor: string, status: string, paypalId?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = db.prepare('SELECT status,paypal_id FROM supplier_invoices WHERE id=? AND session_id=?')
      .get(invoiceId, sessionId) as { status: string; paypal_id: string | null };
    db.prepare('UPDATE supplier_invoices SET status=?,paypal_id=COALESCE(?,paypal_id) WHERE id=? AND session_id=?')
      .run(status, paypalId ?? null, invoiceId, sessionId);
    audit(db, sessionId, actor, `invoice:${invoiceId}`, { status, paypalId: paypalId ?? before.paypal_id },
      { status: before.status, paypalId: before.paypal_id });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function review(db: DatabaseSync, sessionId: string, kind: string, detail: unknown): void {
  const reviewId = crypto.randomUUID();
  db.prepare('INSERT INTO review_queue(id,session_id,kind,body_json) VALUES(?,?,?,?)')
    .run(reviewId, sessionId, kind, JSON.stringify(detail));
  audit(db, sessionId, 'system', `review:${reviewId}`, { kind, status: 'PENDING' });
}
function remedyPayload(token: string, secret: string): ReturnType<typeof verifyRemedyToken> {
  try { return verifyRemedyToken(token, secret); }
  catch { throw new ApiError('INVALID_REMEDY_LINK', 'Remedy link is invalid or expired', 400); }
}
function suggestedBudgets(totals: Record<string,number>): Record<string,number> {
  const ordered = [...Object.keys(DEMO_BUDGETS).filter(currency=>currency in totals), ...Object.keys(totals).filter(currency=>!(currency in DEMO_BUDGETS))];
  return Object.fromEntries(ordered.map(currency=>[currency,Math.max((DEMO_BUDGETS as Record<string,number>)[currency]??0,Math.ceil(totals[currency]*1.05/5000)*5000)]));
}

export function createApp(deps: Dependencies): App {
  const app: App = new Hono();
  const fakePaypal = deps.config.paypalMode === 'sandbox' ? new FakePayPal() : deps.paypal;
  const gatewayForOrder = (order: Order): PayPalGateway => order.gateway === 'sandbox' ? deps.paypal : fakePaypal;
  const limits = new Map<string, { count: number; resetAt: number }>();
  app.use('*', async (c, next) => {
    c.set('paypalMode' as never, deps.config.paypalMode as never);
    const origin = c.req.header('origin');
    if (origin && deps.config.allowedOrigins.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', c.req.path.startsWith('/v1/') || c.req.path === '/health' || c.req.path.startsWith('/webhooks/')
      ? "default-src 'none'"
      : "default-src 'self'; script-src 'self' https://www.sandbox.paypal.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self' https://www.sandbox.paypal.com; frame-src https://www.sandbox.paypal.com");
    c.header('Cache-Control', 'no-store');
    if (c.req.path.startsWith('/v1/') || c.req.path.startsWith('/webhooks/')) {
      const cookie = getCookie(c, 'rr_session') ?? '';
      // Keep authenticated sessions independent; public endpoints use a conservative shared local bucket.
      const sessionRoute = cookie && c.req.path !== '/v1/demo/session' && !c.req.path.startsWith('/webhooks/') &&
        z.uuid().safeParse(cookie).success && Boolean(deps.db.prepare('SELECT 1 FROM sessions WHERE id=? AND expires_at>?').get(cookie, Date.now()));
      const key = sessionRoute ? `session:${cookie}` : 'public:local';
      const previous = limits.get(key);
      const entry = !previous || previous.resetAt < Date.now() ? { count: 0, resetAt: Date.now() + 60_000 } : previous;
      entry.count++;
      limits.set(key, entry);
      if (entry.count > 120) return failure(c, 'RATE_LIMIT', 'Rate limit exceeded', 429);
    }
    if (c.req.method === 'OPTIONS') return data(c, {});
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 1_048_576, onError: c => failure(c, 'BODY_TOO_LARGE', 'Request body exceeds 1 MB', 413) }));
  app.onError((error, c) => {
    if (error instanceof ApiError) return failure(c, error.code, error.message, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return failure(c, 'INVALID_INPUT', 'Invalid request input', 400);
    console.error(redactLog({ event: 'unhandled_request_error', kind: error.name, status: 500 }));
    return failure(c, 'REQUEST_FAILED', 'Request could not be completed', 500);
  });
  app.notFound(c => failure(c, 'NOT_FOUND', 'Route not found', 404));

  app.get('/health', c => data(c, { status: 'ok', paypalMode: deps.config.paypalMode }));
  app.get('/v1/sources', async c => {
    const sid = getCookie(c, 'rr_session');
    if (sid && deps.db.prepare('SELECT 1 FROM sessions WHERE id=? AND expires_at>?').get(sid, Date.now())) {
      const rows = deps.db.prepare('SELECT source,body_json FROM source_status WHERE session_id=?').all(sid) as { source: string; body_json: string }[];
      if (rows.length) return data(c, Object.fromEntries(rows.map(row => [row.source, JSON.parse(row.body_json)])));
    }
    return data(c, (await (deps.sources ?? loadSources)()).status);
  });
  app.post('/v1/demo/session', c => {
    cleanupExpiredSessions(deps.db);
    const sessionId = createDemoSession(deps.db, Date.now(), deps.config.paypalMode === 'fake' ? DEMO_REFERENCE_TIME : undefined);
    if (fakePaypal instanceof FakePayPal) for (const value of list(deps.db, 'orders', sessionId)) {
      const order = value as Order;
      if (order.captureId) fakePaypal.registerCapture(order.captureId,
        order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0), order.currency, order.refundedMinor, order.merchantId);
    }
    setCookie(c, 'rr_session', sessionId, { httpOnly: true, sameSite: 'Lax', secure: deps.config.production, maxAge: 7200, path: '/' });
    return data(c, { sessionId, expiresInSeconds: 7200 }, 201);
  });

  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/demo/session' || c.req.path === '/v1/sources' || c.req.path.startsWith('/v1/remedy/')) return next();
    const sessionId = getCookie(c, 'rr_session');
    if (!sessionId || !z.uuid().safeParse(sessionId).success) return failure(c, 'SESSION_REQUIRED', 'Valid session required', 401);
    const active = deps.db.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?').get(sessionId, Date.now());
    if (!active) return failure(c, 'SESSION_REQUIRED', 'Valid session required', 401);
    c.set('sessionId', sessionId);
    return next();
  });

  app.get('/v1/recalls', c => {
    const query = z.object({ source: z.string().optional(), country: z.string().optional(), q: z.string().optional() }).parse(c.req.query());
    return data(c, list(deps.db, 'recalls', session(c)).filter(row =>
      (!query.source || row.source === query.source) && (!query.country || row.country === query.country) &&
      (!query.q || String(row.title).toLowerCase().includes(query.q.toLowerCase()))));
  });
  app.post('/v1/sources/refresh', async c => {
    const sid = session(c);
    const loaded = await (deps.sources ?? loadSources)();
    let imported = 0;
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      for (const notice of loaded.notices) {
        const inserted = deps.db.prepare('INSERT OR IGNORE INTO recalls(id,session_id,body_json) VALUES(?,?,?)')
          .run(notice.id, sid, JSON.stringify(notice));
        imported += Number(inserted.changes);
      }
      for (const [source, status] of Object.entries(loaded.status)) deps.db.prepare('INSERT INTO source_status(session_id,source,body_json,refreshed_at) VALUES(?,?,?,?) ON CONFLICT(session_id,source) DO UPDATE SET body_json=excluded.body_json,refreshed_at=excluded.refreshed_at')
        .run(sid, source, JSON.stringify(status), Date.now());
      audit(deps.db, sid, 'operator', 'sources:refresh', { imported, sources: Object.keys(loaded.status) });
      deps.db.exec('COMMIT');
    } catch (error) { deps.db.exec('ROLLBACK'); throw error; }
    return data(c, { imported, status: loaded.status });
  });
  app.get('/v1/recalls/:id', c => data(c, record(deps.db, 'recalls', session(c), id.parse(c.req.param('id')))));
  app.post('/v1/recalls/:id/extract', async c => {
    const sid = session(c); const recallId = id.parse(c.req.param('id'));
    const notice = record(deps.db, 'recalls', sid, recallId) as RecallNotice;
    const result = deps.db.prepare('UPDATE sessions SET ai_calls_count=ai_calls_count+1 WHERE id=? AND ai_calls_count<?')
      .run(sid, deps.config.aiMaxCallsPerSession);
    if (!result.changes) throw new ApiError('AI_LIMIT', 'AI call limit reached', 429);
    try {
      const extraction = await deps.ai.extractRecall(notice);
      deps.db.prepare('UPDATE recalls SET body_json=? WHERE id=? AND session_id=?').run(JSON.stringify({ ...notice, extraction }), recallId, sid);
      audit(deps.db, sid, 'operator', `recall-extraction:${recallId}`, { confidence: extraction.confidence, products: extraction.products.length });
      return data(c, extraction);
    } catch {
      review(deps.db, sid, 'AI_EXTRACTION', { recallId });
      return data(c, { action: 'MANUAL_REVIEW' });
    }
  });
  app.post('/v1/recalls/:id/match', c => {
    const sid = session(c); const recallId = id.parse(c.req.param('id'));
    const notice = record(deps.db, 'recalls', sid, recallId) as RecallNotice & { extraction?: Extraction };
    if (!notice.extraction) throw new ApiError('EXTRACTION_REQUIRED', 'Extract recall first', 409);
    const matches = list(deps.db, 'orders', sid).map(value => {
      const order = value as Order;
      return { orderId: order.id, ...matchOrder(notice.extraction!.products, order) };
    });
    deps.db.prepare('UPDATE recalls SET body_json=? WHERE id=? AND session_id=?').run(JSON.stringify({ ...notice, matches }), recallId, sid);
    audit(deps.db, sid, 'operator', `recall-matches:${recallId}`, { orders: matches.length });
    return data(c, matches);
  });
  app.post('/v1/recalls/:id/plan', c => {
    const sid = session(c); const recallId = id.parse(c.req.param('id'));
    const notice = record(deps.db, 'recalls', sid, recallId) as RecallNotice & { demoAsOf?: string; extraction?: Extraction; matches?: { orderId: string; score: number; lineSkus: string[]; reason: string }[] };
    if (!notice.extraction) throw new ApiError('EXTRACTION_REQUIRED', 'Extract recall first', 409);
    const entries = list(deps.db, 'orders', sid).map(value => {
      const order = value as Order;
      return { order, match: matchOrder(notice.extraction!.products, order), evidence: notice.url };
    });
    const plan = buildPlan(recallId, entries, new Date(notice.demoAsOf ?? Date.now()));
    plan.suggestedBudgets = suggestedBudgets(plan.totals);
    savePlan(deps.db, sid, plan);
    audit(deps.db, sid, 'operator', `plan:${plan.id}`, { planHash: plan.planHash, orders: plan.items.length });
    for (const item of plan.items.filter(value => value.action === 'MANUAL_REVIEW')) {
      const exists = deps.db.prepare("SELECT 1 FROM review_queue WHERE session_id=? AND kind='ORDER_MATCH' AND json_extract(body_json,'$.orderId')=? AND status='PENDING'")
        .get(sid, item.orderId);
      if (!exists) {
        const order = record(deps.db, 'orders', sid, item.orderId) as Order;
        const gross = order.lines.reduce((sum,line)=>sum+line.quantity*line.unitPriceMinor+line.taxMinor,0)-order.refundedMinor;
        review(deps.db, sid, 'ORDER_MATCH', { recallId, planId: plan.id, orderId: item.orderId, reason: item.reason, amountMinor: gross, currency: item.currency });
      } else {
        const row = deps.db.prepare("SELECT id,body_json FROM review_queue WHERE session_id=? AND kind='ORDER_MATCH' AND json_extract(body_json,'$.orderId')=? AND status='PENDING'")
          .get(sid, item.orderId) as {id:string;body_json:string};
        deps.db.prepare('UPDATE review_queue SET body_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.body_json),planId:plan.id}),row.id);
      }
    }
    return data(c, plan, 201);
  });
  app.post('/v1/recalls/:id/block', async c => {
    const sid = session(c); const recallId = id.parse(c.req.param('id'));
    record(deps.db, 'recalls', sid, recallId);
    const input = await body(c, z.object({ skus: z.array(id).min(1), gtin: id.optional(), country: z.string().length(2).optional() }));
    const insert = deps.db.prepare('INSERT OR IGNORE INTO blocklist(session_id,recall_id,sku,gtin,country) VALUES(?,?,?,?,?)');
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sku of input.skus) insert.run(sid, recallId, sku, input.gtin ?? null, input.country ?? null);
      audit(deps.db, sid, 'operator', `sale-block:${recallId}`, { skus: input.skus, country: input.country ?? null });
      deps.db.exec('COMMIT');
    } catch (error) { deps.db.exec('ROLLBACK'); throw error; }
    return data(c, { blocked: input.skus.length });
  });
  app.post('/v1/checkout/check', async c => {
    const input = await body(c, z.object({ sku: id, gtin: id.optional(), country: z.string().length(2) }));
    const row = deps.db.prepare('SELECT recall_id FROM blocklist WHERE session_id=? AND (sku=? OR gtin=?) AND (country IS NULL OR country=?) LIMIT 1')
      .get(session(c), input.sku, input.gtin ?? '', input.country) as { recall_id: string } | undefined;
    return data(c, row ? { allowed: false, recallId: row.recall_id, reason: 'Product is blocked by a recall' } : { allowed: true });
  });
  app.get('/v1/paypal/client-config', c => data(c, deps.config.paypalMode === 'sandbox'
    ? { clientId: deps.config.paypalClientId, mode: 'sandbox' } : { mode: 'fake' }));
  app.get('/v1/store/status', c => {
    const row = deps.db.prepare('SELECT recall_id FROM blocklist WHERE session_id=? AND sku=? AND (country IS NULL OR country=?) LIMIT 1')
      .get(session(c), 'HP-LMH-015', 'US') as {recall_id:string} | undefined;
    return data(c, row ? { allowed: false, recallId: row.recall_id, reason: 'Product is blocked by a recall' } : { allowed: true });
  });
  app.post('/v1/store/orders', async c => {
    if (deps.config.paypalMode !== 'sandbox') throw new ApiError('PAYPAL_OFF', 'PayPal checkout is off in fake mode', 409);
    const input = z.object({ country: z.literal('US').default('US') }).parse(await c.req.json().catch(() => ({})));
    const blocked = deps.db.prepare('SELECT recall_id FROM blocklist WHERE session_id=? AND sku=? AND (country IS NULL OR country=?) LIMIT 1')
      .get(session(c), 'HP-LMH-015', input.country);
    if (blocked) throw new ApiError('PRODUCT_RECALLED', 'This product cannot be sold', 409);
    const requestId = createHash('sha256').update(`${session(c)}:store:${crypto.randomUUID()}`).digest('hex');
    const created = await deps.paypal.createOrder('CAPTURE', [{ name: 'Lumen Mini Space Heater', sku: 'HP-LMH-015', quantity: 1, unitPriceMinor: 12900, currency: 'USD' }], requestId) as { id?: string };
    if (!created.id) throw new ApiError('PAYPAL_ORDER_UNKNOWN', 'PayPal did not return an order ID', 502);
    deps.db.prepare('INSERT INTO store_orders(paypal_order_id,session_id,country,status) VALUES(?,?,?,?)')
      .run(created.id, session(c), input.country, 'CREATED');
    audit(deps.db, session(c), 'store', `store-order:${created.id}`, { status: 'CREATED' });
    return data(c, { id: created.id }, 201);
  });
  app.post('/v1/store/orders/:id/capture', async c => {
    if (deps.config.paypalMode !== 'sandbox') throw new ApiError('PAYPAL_OFF', 'PayPal checkout is off in fake mode', 409);
    const paypalOrderId = id.parse(c.req.param('id'));
    const row = deps.db.prepare('SELECT country,capture_id,order_id,status FROM store_orders WHERE paypal_order_id=? AND session_id=?')
      .get(paypalOrderId, session(c)) as { country: string; capture_id: string | null; order_id: string | null; status: string } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Store order not found', 404);
    if (row.status === 'CAPTURED') return data(c, { orderId: row.order_id, captureId: row.capture_id, status: 'CAPTURED' });
    const blocked = deps.db.prepare('SELECT 1 FROM blocklist WHERE session_id=? AND sku=? AND (country IS NULL OR country=?) LIMIT 1')
      .get(session(c), 'HP-LMH-015', row.country);
    if (blocked) throw new ApiError('PRODUCT_RECALLED', 'This product cannot be sold', 409);
    const requestId = createHash('sha256').update(`${session(c)}:capture:${paypalOrderId}`).digest('hex');
    const result = await deps.paypal.captureOrder(paypalOrderId, requestId) as {
      id?: string; status?: string; payer?: { email_address?: string; name?: { given_name?: string; surname?: string }; address?: { country_code?: string } };
      purchase_units?: { payee?: { merchant_id?: string }; payments?: { captures?: { id?: string; status?: string; amount?: { currency_code?: string; value?: string } }[] } }[];
    };
    const unit = result.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const amount = capture?.amount;
    const amountMinor = amount?.value && amount.currency_code ? fromPayPalAmount(amount.value, amount.currency_code) : -1;
    if (result.id !== paypalOrderId || capture?.status !== 'COMPLETED' || amountMinor !== 12900 || amount?.currency_code !== 'USD' ||
      !capture.id || !unit?.payee?.merchant_id || !result.payer?.email_address) {
      review(deps.db, session(c), 'STORE_CAPTURE', { paypalOrderId, reason: 'Capture details need review' });
      throw new ApiError('CAPTURE_REVIEW', 'Capture details need review before importing the order', 502);
    }
    const order: Order = { id: `store-${capture.id}`, gateway: 'sandbox', merchantId: unit.payee.merchant_id,
      buyerName: [result.payer.name?.given_name, result.payer.name?.surname].filter(Boolean).join(' ') || 'PayPal buyer',
      buyerEmail: result.payer.email_address, buyerCountry: result.payer.address?.country_code ?? row.country,
      language: 'en', currency: 'USD', status: 'CAPTURED', shipped: true, paidAt: new Date().toISOString(),
      captureId: capture.id, refundedMinor: 0,
      lines: [{ sku: 'HP-LMH-015', name: 'Lumen Mini Space Heater', quantity: 1, unitPriceMinor: 12900, taxMinor: 0 }] };
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      deps.db.prepare('INSERT OR IGNORE INTO orders(id,session_id,body_json) VALUES(?,?,?)').run(order.id, session(c), JSON.stringify(order));
      deps.db.prepare("UPDATE store_orders SET capture_id=?,order_id=?,status='CAPTURED' WHERE paypal_order_id=? AND session_id=?")
        .run(capture.id, order.id, paypalOrderId, session(c));
      deps.db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
        .run(session(c), 'store', Date.now(), `store-order:${paypalOrderId}`, JSON.stringify({ status: row.status }), JSON.stringify({ status: 'CAPTURED', captureId: capture.id }));
      deps.db.exec('COMMIT');
    } catch (error) { deps.db.exec('ROLLBACK'); throw error; }
    return data(c, { orderId: order.id, captureId: capture.id, status: 'CAPTURED' });
  });
  app.get('/v1/plans', c => data(c, list(deps.db, 'plans', session(c))));
  app.get('/v1/plans/:id', c => data(c, record(deps.db, 'plans', session(c), id.parse(c.req.param('id')))));
  app.get('/v1/plans/:id/approval', c => {
    const plan = record(deps.db, 'plans', session(c), id.parse(c.req.param('id'))) as Plan;
    const row = deps.db.prepare('SELECT approver,budget_json,plan_hash FROM approvals WHERE plan_id=? AND session_id=?').get(plan.id, session(c)) as {approver:string;budget_json:string;plan_hash:string} | undefined;
    return data(c, row ? { approved: true, approver: row.approver, budget: JSON.parse(row.budget_json), planHash: row.plan_hash } : { approved: false });
  });
  app.get('/v1/plans/:id/order', c => {
    const plan = record(deps.db, 'plans', session(c), id.parse(c.req.param('id'))) as Plan;
    const row = deps.db.prepare('SELECT order_ids_json FROM plan_order WHERE plan_id=? AND session_id=?').get(plan.id, session(c)) as {order_ids_json:string} | undefined;
    const defaults = plan.recallId === 'demo-lumen-mini-heater'
      ? [...DEMO_EXECUTION_ORDER.filter(orderId => plan.items.some(item => item.orderId === orderId)),
        ...plan.items.map(item => item.orderId).filter(orderId => !DEMO_EXECUTION_ORDER.includes(orderId))]
      : plan.items.map(item => item.orderId);
    return data(c, { orderIds: row ? JSON.parse(row.order_ids_json) as string[] : defaults, custom: Boolean(row) });
  });
  app.post('/v1/plans/:id/order', async c => {
    const plan = record(deps.db, 'plans', session(c), id.parse(c.req.param('id'))) as Plan;
    const input = await body(c, z.strictObject({ orderIds: z.array(id) }));
    if (input.orderIds.length !== plan.items.length || new Set(input.orderIds).size !== plan.items.length ||
      input.orderIds.some(orderId => !plan.items.some(item => item.orderId === orderId)))
      throw new ApiError('INVALID_ORDER', 'Execution order must include every plan order exactly once', 400);
    const before = deps.db.prepare('SELECT order_ids_json FROM plan_order WHERE plan_id=? AND session_id=?').get(plan.id, session(c)) as {order_ids_json:string} | undefined;
    deps.db.prepare('INSERT INTO plan_order(plan_id,session_id,order_ids_json) VALUES(?,?,?) ON CONFLICT(plan_id) DO UPDATE SET order_ids_json=excluded.order_ids_json')
      .run(plan.id, session(c), JSON.stringify(input.orderIds));
    deps.db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(session(c), 'operator', Date.now(), `plan-order:${plan.id}`, before?.order_ids_json ?? '[]', JSON.stringify(input.orderIds));
    return data(c, { orderIds: input.orderIds, planHash: plan.planHash });
  });
  app.post('/v1/plans/:id/approve', async c => {
    const input = await body(c, z.object({ planHash: z.string().length(64), approver: id, budget: z.record(z.string().length(3), minor) }));
    try { return data(c, approvePlan(deps.db, session(c), id.parse(c.req.param('id')), input.planHash, input.approver, input.budget)); }
    catch { throw new ApiError('APPROVAL_REJECTED', 'Plan hash or budget invalid', 409); }
  });
  app.post('/v1/plans/:id/execute', async c => {
    const planId = id.parse(c.req.param('id'));
    await executePlan(deps.db, gatewayForOrder, session(c), planId);
    await reconcilePlan(deps.db, gatewayForOrder, session(c), planId);
    return data(c, deps.db.prepare('SELECT order_id,action,amount_minor,currency,status FROM outbox WHERE session_id=? AND plan_id=?').all(session(c), planId));
  });
  app.get('/v1/plans/:id/run', c => {
    const plan = record(deps.db, 'plans', session(c), id.parse(c.req.param('id'))) as Plan;
    const rows = deps.db.prepare('SELECT order_id,action,amount_minor,currency,status,paypal_id FROM outbox WHERE session_id=? AND plan_id=? ORDER BY id')
      .all(session(c), plan.id) as {order_id:string;action:string;amount_minor:number;currency:string;status:string;paypal_id:string|null}[];
    return data(c, rows.map(row => {
      const order = record(deps.db, 'orders', session(c), row.order_id) as Order;
      const issue = deps.db.prepare("SELECT body_json FROM review_queue WHERE session_id=? AND kind='PAYMENT' AND json_extract(body_json,'$.batchId')=? ORDER BY rowid DESC LIMIT 1")
        .get(session(c), row.paypal_id ?? '') as {body_json:string} | undefined;
      return { orderId: row.order_id, action: row.action, amountMinor: row.amount_minor, currency: row.currency, status: row.status,
        paypalId: row.paypal_id, gateway: order.gateway ?? 'fake', reason: issue ? (JSON.parse(issue.body_json) as {problem:string}).problem : undefined };
    }));
  });
  app.get('/v1/plans/:id/timeline', c => {
    const plan = record(deps.db, 'plans', session(c), id.parse(c.req.param('id'))) as Plan;
    const recall = record(deps.db, 'recalls', session(c), plan.recallId) as RecallNotice & { demoAsOf?: string };
    const asOf = recall.demoAsOf ?? new Date().toISOString();
    return data(c, plan.items.map(item => {
      const order = record(deps.db, 'orders', session(c), item.orderId) as Order;
      const deadline = new Date(Date.parse(order.paidAt) + 180 * 86_400_000);
      const ledger = deps.db.prepare('SELECT status FROM outbox WHERE session_id=? AND plan_id=? AND order_id=?').get(session(c), plan.id, item.orderId) as { status: string } | undefined;
      return { resourceId: item.orderId, label: item.reason, startDate: order.paidAt, deadline: deadline.toISOString(),
        daysLeft: Math.ceil((deadline.getTime() - Date.parse(asOf)) / 86_400_000), asOf,
        action: item.action, status: ledger?.status ?? 'PENDING' };
    }));
  });
  app.get('/v1/review-queue', c => data(c, deps.db.prepare('SELECT id,kind,status,body_json FROM review_queue WHERE session_id=?').all(session(c))));
  app.post('/v1/notices/check', async c => {
    const input = await body(c, z.strictObject({ recallId: id, orderId: id, contact: z.union([z.email(), z.url()]), text: z.string().max(20000).optional() }));
    const recall = record(deps.db, 'recalls', session(c), input.recallId) as RecallNotice;
    const order = record(deps.db, 'orders', session(c), input.orderId) as Order;
    const affected = order.lines.filter(line => recall.identifiers.includes(line.sku) || Boolean(line.gtin && recall.identifiers.includes(line.gtin)));
    if (!affected.length) throw new ApiError('NOTICE_REVIEW', 'No affected order line found', 409);
    const productName = affected[0].name;
    const brand = productName.startsWith('Harbor & Pine') ? 'Harbor & Pine' : productName.split(' ')[0];
    const demoGerman = recall.id === 'demo-lumen-mini-heater' && order.language === 'de' && input.contact === 'https://help.harborpine.example';
    const draftInput = { productName, brand, identifiers: affected.map(line => line.sku), hazard: recall.hazard ?? '',
      remedies: demoGerman ? ['free refund', 'free replacement'] : ['free refund', 'free repair', 'free replacement'], contact: input.contact,
      imageReference: recall.imageUrls[0] ?? '', soldWhere: recall.soldOnline ? 'online' : undefined };
    const text = input.text ?? (demoGerman ? DEMO_NOTICE_DRAFT_DE : await (recall.id === 'demo-lumen-mini-heater' && deps.config.paypalMode === 'sandbox' ? DEMO_NOTICE_WRITER : deps.ai).draftNotice(draftInput, order.language));
    const checked = checkNotice(text, { ...draftInput, language: order.language,
      euBuyer: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO'].includes(order.buyerCountry) });
    return data(c, { text, ...checked, language: order.language, orderId: order.id,
      demoWarning: recall.id === 'demo-lumen-mini-heater' && order.language === 'de'
        ? DEMO_NOTICE_WARNING_DE : undefined });
  });
  app.post('/v1/notices/send', async c => {
    const input = await body(c, z.strictObject({ recallId: id, orderId: id, contact: z.union([z.email(), z.url()]), text: z.string().max(20000).optional() }));
    const sid = session(c);
    const existing = deps.db.prepare('SELECT id,status FROM notice_deliveries WHERE session_id=? AND recall_id=? AND order_id=?')
      .get(sid, input.recallId, input.orderId) as { id: string; status: string } | undefined;
    if (existing) return data(c, existing);
    const recall = record(deps.db, 'recalls', sid, input.recallId) as RecallNotice;
    const order = record(deps.db, 'orders', sid, input.orderId) as Order;
    const affected = order.lines.filter(line => recall.identifiers.includes(line.sku) || Boolean(line.gtin && recall.identifiers.includes(line.gtin)));
    if (!affected.length) throw new ApiError('NOTICE_REVIEW', 'No affected order line found', 409);
    const productName = affected[0].name;
    const brand = productName.startsWith('Harbor & Pine') ? 'Harbor & Pine' : productName.split(' ')[0];
    const demoGerman = recall.id === 'demo-lumen-mini-heater' && order.language === 'de' && input.contact === 'https://help.harborpine.example';
    const draftInput = { productName, brand, identifiers: affected.map(line => line.sku), hazard: recall.hazard ?? '',
      remedies: demoGerman ? ['free refund', 'free replacement'] : ['free refund', 'free repair', 'free replacement'], contact: input.contact,
      imageReference: recall.imageUrls[0] ?? '', soldWhere: recall.soldOnline ? 'online' : undefined };
    let text: string;
    try { text = input.text ?? (demoGerman ? DEMO_NOTICE_DRAFT_DE : await (recall.id === 'demo-lumen-mini-heater' && deps.config.paypalMode === 'sandbox' ? DEMO_NOTICE_WRITER : deps.ai).draftNotice(draftInput, order.language)); }
    catch { review(deps.db, sid, 'NOTICE', { recallId: input.recallId, orderId: input.orderId, problems: ['Draft unavailable'] });
      throw new ApiError('NOTICE_REVIEW', 'Notice requires manual review', 409); }
    const checked = checkNotice(text, { ...draftInput, language: order.language, euBuyer: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO'].includes(order.buyerCountry) });
    if (!checked.ok) {
      review(deps.db, sid, 'NOTICE', { recallId: input.recallId, orderId: input.orderId, problems: checked.problems, draft: text });
      throw new ApiError('NOTICE_REVIEW', 'Notice requires manual review', 409);
    }
    if (deps.config.paypalMode === 'sandbox' && !deps.sendNotice) {
      review(deps.db, sid, 'NOTICE', { recallId: input.recallId, orderId: input.orderId, problems: ['Sender unavailable'], draft: text });
      throw new ApiError('NOTICE_REVIEW', 'Notice sender unavailable', 409);
    }
    const deliveryId = crypto.randomUUID();
    deps.db.prepare('INSERT INTO notice_deliveries(id,session_id,recall_id,order_id,body_json,status) VALUES(?,?,?,?,?,?)')
      .run(deliveryId, sid, input.recallId, input.orderId, JSON.stringify({ text, deliveryMode: deps.sendNotice ? 'configured' : 'fake' }), 'SENDING');
    try {
      await deps.sendNotice?.(order.buyerEmail, text);
      deps.db.prepare("UPDATE notice_deliveries SET status='SENT' WHERE id=? AND session_id=?").run(deliveryId, sid);
      audit(deps.db, sid, 'operator', `notice:${deliveryId}`, { status: 'SENT', recallId: input.recallId, orderId: input.orderId });
    } catch {
      deps.db.prepare("UPDATE notice_deliveries SET status='UNKNOWN' WHERE id=? AND session_id=?").run(deliveryId, sid);
      audit(deps.db, sid, 'system', `notice:${deliveryId}`, { status: 'UNKNOWN', recallId: input.recallId, orderId: input.orderId });
      review(deps.db, sid, 'NOTICE', { recallId: input.recallId, orderId: input.orderId, problems: ['Send outcome unknown'] });
      throw new ApiError('NOTICE_SEND_UNKNOWN', 'Notice send outcome requires review', 502);
    }
    return data(c, { id: deliveryId, status: 'SENT', deliveryMode: deps.sendNotice ? 'configured' : 'fake' });
  });
  app.post('/v1/review-queue/:id/resolve', async c => {
    const input = await body(c, z.strictObject({ resolution: id, actor: id.optional() }));
    const reviewId = id.parse(c.req.param('id'));
    const old = deps.db.prepare('SELECT kind,status,body_json FROM review_queue WHERE id=? AND session_id=?')
      .get(reviewId, session(c)) as {kind:string;status:string;body_json:string} | undefined;
    if (!old || old.status !== 'PENDING') throw new ApiError('NOT_FOUND', 'Open review item not found', 404);
    let nextPlan: Plan | undefined;
    if (old.kind === 'ORDER_MATCH' && ['Add to plan','Not affected'].includes(input.resolution)) {
      const detail = JSON.parse(old.body_json) as {planId:string;orderId:string};
      const parent = record(deps.db, 'plans', session(c), detail.planId) as Plan;
      const order = record(deps.db, 'orders', session(c), detail.orderId) as Order;
      const original = parent.items.find(item=>item.orderId===detail.orderId);
      if (!original) throw new ApiError('NOT_FOUND', 'Reviewed order not found in plan', 404);
      const nextItem = input.resolution === 'Not affected'
        ? { ...original, action: 'NO_ACTION' as const, amountMinor: 0, reason: 'Human confirmed not affected' }
        : (() => {
          const match = { score:1, lineSkus:order.lines.map(line=>line.sku), reason:'Human confirmed product match' };
          const decision = classify(order, match, {now:new Date()});
          if (decision.action === 'MANUAL_REVIEW') throw new ApiError('REVIEW_REQUIRED', 'This order still needs a separate settlement decision', 409);
          return { ...original, action:decision.action, amountMinor:decision.amountMinor, reason:decision.reason, lineSkus:match.lineSkus };
        })();
      const items = parent.items.map(item=>item.orderId===detail.orderId?nextItem:item);
      const totals:Record<string,number>={};
      for (const item of items) if(item.amountMinor>0) totals[item.currency]=(totals[item.currency]??0)+item.amountMinor;
      nextPlan = {id:crypto.randomUUID(),recallId:parent.recallId,items,totals,planHash:''};
      nextPlan.planHash=hashPlan(nextPlan);
      nextPlan.suggestedBudgets=suggestedBudgets(totals);
    }
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      if(nextPlan) savePlan(deps.db,session(c),nextPlan);
      deps.db.prepare("UPDATE review_queue SET status='RESOLVED',body_json=? WHERE id=? AND session_id=?")
        .run(JSON.stringify({...JSON.parse(old.body_json),resolution:input.resolution,actor:input.actor??'operator'}),reviewId,session(c));
      deps.db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
        .run(session(c),input.actor??'operator',Date.now(),`review:${reviewId}`,old.body_json,JSON.stringify({resolution:input.resolution,planId:nextPlan?.id}));
      deps.db.exec('COMMIT');
    } catch(error){deps.db.exec('ROLLBACK');throw error;}
    return data(c, { status: 'RESOLVED', planId:nextPlan?.id });
  });
  app.get('/v1/orders', c => data(c, list(deps.db, 'orders', session(c))));
  app.post('/v1/orders/sync', async c => {
    const input = await body(c, z.strictObject({ merchantId: id, start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }));
    const start = new Date(input.start); const end = new Date(input.end);
    if (start >= end || end.getTime() - start.getTime() > 366 * 86_400_000 || end.getTime() > Date.now() + 60_000)
      throw new ApiError('INVALID_RANGE', 'Invalid transaction search range', 400);
    const transactions = await deps.paypal.searchTransactions(start, end);
    let imported = 0; let manualReview = 0; let skipped = 0;
    for (const raw of transactions) {
      const converted = convertTransaction(raw, input.merchantId);
      if (converted.order) {
        converted.order.gateway = deps.config.paypalMode;
        const inserted = deps.db.prepare('INSERT OR IGNORE INTO orders(id,session_id,body_json) VALUES(?,?,?)')
          .run(converted.order.id, session(c), JSON.stringify(converted.order));
        if (inserted.changes) {
          if (deps.paypal instanceof FakePayPal) deps.paypal.registerCapture(converted.order.captureId!,
            converted.order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0), converted.order.currency, 0, converted.order.merchantId);
          imported++;
        } else skipped++;
      } else if (converted.reviewReason) {
        review(deps.db, session(c), 'ORDER_IMPORT', { transactionId: converted.transactionId, reason: converted.reviewReason });
        manualReview++;
      } else skipped++;
    }
    audit(deps.db, session(c), 'operator', 'orders:sync', { imported, manualReview, skipped });
    return data(c, { imported, manualReview, skipped });
  });
  app.post('/v1/orders/import', async c => {
    const input = await body(c, z.object({ orders: z.array(orderSchema).min(1).max(100) }));
    const insert = deps.db.prepare('INSERT INTO orders(id,session_id,body_json) VALUES(?,?,?)');
    for (const order of input.orders) {
      if (order.captureId && deps.config.paypalMode === 'sandbox') {
        const capture = await deps.paypal.getCapture(order.captureId);
        const gross = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
        if (capture.id !== order.captureId || capture.payeeMerchantId !== order.merchantId ||
          capture.amountMinor !== gross || capture.currency !== order.currency)
          throw new ApiError('CAPTURE_MISMATCH', 'Capture does not match the imported order', 409);
      }
      insert.run(order.id, session(c), JSON.stringify({ ...order, gateway: deps.config.paypalMode }));
      if (order.captureId && deps.paypal instanceof FakePayPal) deps.paypal.registerCapture(order.captureId,
        order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0), order.currency, order.refundedMinor, order.merchantId);
    }
    audit(deps.db, session(c), 'operator', 'orders:import', { imported: input.orders.length });
    return data(c, { imported: input.orders.length }, 201);
  });
  app.post('/v1/remedy-links', async c => {
    const input = await body(c, z.strictObject({ planId: id, orderId: id }));
    const sid = session(c);
    const plan = record(deps.db, 'plans', sid, input.planId) as Plan;
    const item = plan.items.find(value => value.orderId === input.orderId && value.action === 'AWAIT_BUYER_CHOICE');
    const approval = deps.db.prepare('SELECT plan_hash FROM approvals WHERE plan_id=? AND session_id=?').get(plan.id, sid) as { plan_hash: string } | undefined;
    if (!item || !approval || approval.plan_hash !== hashPlan(plan)) throw new ApiError('CHOICE_NOT_APPROVED', 'Approved buyer choice required', 409);
    record(deps.db, 'orders', sid, input.orderId);
    const existing = deps.db.prepare('SELECT token,expires_at FROM remedy_links WHERE session_id=? AND recall_id=? AND order_id=?')
      .get(sid, plan.recallId, input.orderId) as { token: string; expires_at: number } | undefined;
    if (existing) return data(c, { token: existing.token, expiresAt: new Date(existing.expires_at).toISOString() }, 201);
    const expiresAt = Date.now() + LINK_LIFETIME_MS;
    const token = createRemedyToken({ sessionId: sid, recallId: plan.recallId, orderId: input.orderId, expiresAt }, deps.config.linkSigningSecret);
    deps.db.prepare('INSERT INTO remedy_links(session_id,recall_id,order_id,plan_id,token,expires_at) VALUES(?,?,?,?,?,?)')
      .run(sid, plan.recallId, input.orderId, plan.id, token, expiresAt);
    audit(deps.db, sid, 'operator', `remedy-link:${input.orderId}`, { planId: plan.id, expiresAt });
    return data(c, { token, expiresAt: new Date(expiresAt).toISOString() }, 201);
  });
  app.get('/v1/remedy/:token', c => {
    const token = id.parse(c.req.param('token'));
    const payload = remedyPayload(token, deps.config.linkSigningSecret);
    const active = deps.db.prepare('SELECT 1 FROM sessions WHERE id=? AND expires_at>?').get(payload.sessionId, Date.now());
    const issued = deps.db.prepare('SELECT 1 FROM remedy_links WHERE session_id=? AND recall_id=? AND order_id=? AND token=? AND expires_at>=?')
      .get(payload.sessionId, payload.recallId, payload.orderId, token, Date.now());
    if (!active && !issued) throw new ApiError('SESSION_EXPIRED', 'Remedy session expired', 401);
    const order = record(deps.db, 'orders', payload.sessionId, payload.orderId) as Order;
    const recall = record(deps.db, 'recalls', payload.sessionId, payload.recallId) as RecallNotice & {
      buyerDisplayName?: string; buyerStopTitle?: string; buyerInstruction?: string; buyerSoldText?: string;
      buyerHelpText?: string; buyerOptions?: string[] };
    const affected = order.lines.filter(line => recall.identifiers.includes(line.sku));
    const gross = order.lines.reduce((n, line) => n + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
    const affectedMinor = affected.reduce((n, line) => n + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
    const choice = deps.db.prepare('SELECT choice FROM remedy_choices WHERE token_hash=? AND session_id=?')
      .get(createHash('sha256').update(token).digest('hex'), payload.sessionId) as {choice:string} | undefined;
    const settled = deps.db.prepare("SELECT status,paypal_id,amount_minor FROM outbox WHERE session_id=? AND order_id=? AND plan_id LIKE 'choice-%' ORDER BY id DESC LIMIT 1")
      .get(payload.sessionId, order.id) as {status:string;paypal_id:string|null;amount_minor:number} | undefined;
    return data(c, { product: recall.buyerDisplayName ?? (affected.map(x => x.name).join(', ') || recall.title), hazard: recall.hazard,
      stopTitle: recall.buyerStopTitle ?? 'Stop using this product now.',
      instruction: recall.buyerInstruction ?? recall.hazard ?? 'Follow the official recall instructions.',
      helpText: recall.buyerHelpText ?? 'Contact the seller for free help.',
      options: recall.buyerOptions ?? ['refund', 'repair', 'replacement'], amount: Math.min(affectedMinor, Math.max(0, gross - order.refundedMinor)), currency: order.currency,
      orderId: order.id, paidAt: order.paidAt, sku: affected[0]?.sku, soldText: recall.buyerSoldText ?? '',
      choice: choice?.choice, settlementStatus: settled?.status, paypalReference: settled?.paypal_id, settledAmountMinor: settled?.amount_minor });
  });
  app.post('/v1/remedy/:token/choice', async c => {
    const input = await body(c, z.object({ choice: z.enum(['refund', 'repair', 'replacement']), paypalEmail: z.email().optional() }));
    const token = id.parse(c.req.param('token'));
    const payload = remedyPayload(token, deps.config.linkSigningSecret);
    const link = deps.db.prepare('SELECT plan_id FROM remedy_links WHERE session_id=? AND recall_id=? AND order_id=? AND token=?')
      .get(payload.sessionId, payload.recallId, payload.orderId, token) as { plan_id: string } | undefined;
    if (!link) throw new ApiError('INVALID_REMEDY_LINK', 'Remedy link was not issued', 404);
    const parent = record(deps.db, 'plans', payload.sessionId, link.plan_id) as Plan;
    const approved = deps.db.prepare('SELECT plan_hash,approver,budget_json FROM approvals WHERE plan_id=? AND session_id=?')
      .get(parent.id, payload.sessionId) as { plan_hash: string; approver: string; budget_json: string } | undefined;
    const item = parent.items.find(value => value.orderId === payload.orderId && value.action === 'AWAIT_BUYER_CHOICE');
    if (!approved || approved.plan_hash !== hashPlan(parent) || !item) throw new ApiError('CHOICE_NOT_APPROVED', 'Approved buyer choice required', 409);
    const childId = `choice-${createHash('sha256').update(token).digest('hex')}`;
    const previousChoice = deps.db.prepare('SELECT choice FROM remedy_choices WHERE token_hash=? AND session_id=?')
      .get(createHash('sha256').update(token).digest('hex'), payload.sessionId) as { choice: string } | undefined;
    if (previousChoice?.choice === 'refund' && input.choice === 'refund') {
      const savedPlan = record(deps.db, 'plans', payload.sessionId, childId) as Plan;
      await executePlan(deps.db, gatewayForOrder, payload.sessionId, childId, true);
      await reconcilePlan(deps.db, gatewayForOrder, payload.sessionId, childId, true);
      const status = deps.db.prepare('SELECT status FROM outbox WHERE session_id=? AND plan_id=?').get(payload.sessionId, childId) as { status: string } | undefined;
      return data(c, { choice: 'refund', action: savedPlan.items[0].action, planId: childId, status: status?.status ?? 'PENDING' });
    }
    const order = record(deps.db, 'orders', payload.sessionId, payload.orderId) as Order;
    const decision = classify(order, { score: 1, lineSkus: item.lineSkus, reason: item.reason }, { now: new Date(), choice: input.choice });
    if (input.choice === 'refund' && (!['REFUND', 'PAYOUT'].includes(decision.action) || decision.amountMinor > item.amountMinor))
      throw new ApiError('CHOICE_REVIEW', 'Choice requires manual review', 409);
    if (decision.action === 'PAYOUT' && !input.paypalEmail) throw new ApiError('PAYOUT_EMAIL_REQUIRED', 'Confirm a PayPal email for payout', 400);
    let choice;
    try { choice = recordBuyerChoice(deps.db, payload.sessionId, token, input.choice, deps.config.linkSigningSecret, Date.now(), input.paypalEmail); }
    catch { throw new ApiError('CHOICE_CONFLICT', 'Choice already recorded or session expired', 409); }
    if (input.choice !== 'refund') return data(c, { ...choice, action: 'FULFILMENT_TASK' });
    const childItem = { ...item, action: decision.action, amountMinor: decision.amountMinor, reason: decision.reason };
    const child: Plan = { id: childId, recallId: parent.recallId, items: [childItem], totals: { [item.currency]: decision.amountMinor }, planHash: '' };
    child.planHash = hashPlan(child);
    const saved = deps.db.prepare('SELECT plan_hash FROM plans WHERE id=? AND session_id=?').get(childId, payload.sessionId) as { plan_hash: string } | undefined;
    if (!saved) {
      savePlan(deps.db, payload.sessionId, child);
      approvePlan(deps.db, payload.sessionId, childId, child.planHash, approved.approver, JSON.parse(approved.budget_json), true);
    } else if (saved.plan_hash !== child.planHash) throw new ApiError('CHOICE_CONFLICT', 'Choice plan changed', 409);
    await executePlan(deps.db, gatewayForOrder, payload.sessionId, childId, true);
    await reconcilePlan(deps.db, gatewayForOrder, payload.sessionId, childId, true);
    const ledger = deps.db.prepare('SELECT status FROM outbox WHERE session_id=? AND plan_id=?').get(payload.sessionId, childId) as { status: string } | undefined;
    return data(c, { ...choice, action: decision.action, planId: childId, status: ledger?.status ?? 'PENDING' });
  });
  app.get('/v1/audit', c => data(c, deps.db.prepare('SELECT id,actor,at,entity,before_json,after_json FROM audit_log WHERE session_id=? ORDER BY id').all(session(c))));

  const settledInvoiceAmount = (sid: string, planId: string, currency: string) =>
    (deps.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS total FROM outbox WHERE session_id=? AND plan_id=? AND currency=? AND action IN ('REFUND','PAYOUT') AND status='SUCCEEDED'")
      .get(sid, planId, currency) as { total: number }).total;
  app.post('/v1/supplier-invoices/approve', async c => {
    const input = await body(c, z.strictObject({ planId: id, planHash: id, currency: z.string().length(3),
      recipientEmail: z.email(), approver: id, budgetMinor: minor }));
    const sid = session(c);
    const plan = record(deps.db, 'plans', sid, input.planId) as Plan;
    if (input.planHash !== plan.planHash || input.planHash !== hashPlan(plan))
      throw new ApiError('PLAN_CHANGED', 'Plan changed before invoice approval', 409);
    const amount = settledInvoiceAmount(sid, plan.id, input.currency);
    if (amount <= 0 || amount > input.budgetMinor)
      throw new ApiError('INVOICE_APPROVAL_REJECTED', 'No settled amount or invoice budget exceeded', 409);
    const approvalId = crypto.randomUUID();
    const inserted = deps.db.prepare('INSERT OR IGNORE INTO supplier_invoice_approvals(id,session_id,plan_id,currency,plan_hash,amount_minor,recipient_email,approver,budget_minor,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(approvalId, sid, plan.id, input.currency, input.planHash, amount, input.recipientEmail, input.approver, input.budgetMinor, Date.now());
    if (!inserted.changes) throw new ApiError('INVOICE_ALREADY_APPROVED', 'Invoice approval already exists for this currency', 409);
    deps.db.prepare('INSERT INTO audit_log(session_id,actor,at,entity,before_json,after_json) VALUES(?,?,?,?,?,?)')
      .run(sid, input.approver, Date.now(), `invoice-approval:${approvalId}`, '{}', JSON.stringify({ planId: plan.id, planHash: input.planHash, currency: input.currency, amountMinor: amount }));
    return data(c, { id: approvalId, amountMinor: amount, currency: input.currency, planHash: input.planHash }, 201);
  });
  app.post('/v1/supplier-invoices', async c => {
    const input = await body(c, z.strictObject({ approvalId: id }));
    const sid = session(c);
    const approval = deps.db.prepare('SELECT plan_id,currency,plan_hash,amount_minor,recipient_email,approver FROM supplier_invoice_approvals WHERE id=? AND session_id=?')
      .get(input.approvalId, sid) as { plan_id: string; currency: string; plan_hash: string; amount_minor: number; recipient_email: string; approver: string } | undefined;
    if (!approval) throw new ApiError('INVOICE_APPROVAL_REQUIRED', 'A separate invoice approval is required', 409);
    const plan = record(deps.db, 'plans', sid, approval.plan_id) as Plan;
    if (approval.plan_hash !== plan.planHash || approval.plan_hash !== hashPlan(plan) ||
      approval.amount_minor !== settledInvoiceAmount(sid, plan.id, approval.currency))
      throw new ApiError('INVOICE_APPROVAL_STALE', 'Plan or settled amount changed after invoice approval', 409);
    const invoiceId = crypto.randomUUID();
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = deps.db.prepare('INSERT OR IGNORE INTO supplier_invoices(id,session_id,plan_id,currency,amount_minor,status) VALUES(?,?,?,?,?,?)')
        .run(invoiceId, sid, plan.id, approval.currency, approval.amount_minor, 'APPROVED');
      if (!inserted.changes) throw new ApiError('INVOICE_EXISTS', 'Invoice already created for this plan and currency', 409);
      audit(deps.db, sid, approval.approver, `invoice:${invoiceId}`, { status: 'APPROVED', planHash: approval.plan_hash, amountMinor: approval.amount_minor });
      deps.db.exec('COMMIT');
    } catch (error) { deps.db.exec('ROLLBACK'); throw error; }
    try {
      const invoice = await deps.paypal.createInvoice(approval.recipient_email, approval.currency, approval.amount_minor, `Recall reimbursement for ${plan.recallId}`);
      setInvoiceState(deps.db, sid, invoiceId, approval.approver, 'CREATED', invoice.id);
      await deps.paypal.sendInvoice(invoice.id);
      setInvoiceState(deps.db, sid, invoiceId, approval.approver, 'SENT');
    } catch {
      setInvoiceState(deps.db, sid, invoiceId, 'system', 'UNKNOWN');
      review(deps.db, sid, 'INVOICE', { invoiceId, planId: plan.id, reason: 'Invoice send outcome unknown' });
      throw new ApiError('INVOICE_SEND_FAILED', 'Invoice status requires manual review', 502);
    }
    return data(c, { id: invoiceId, amountMinor: approval.amount_minor, currency: approval.currency, status: 'SENT', planHash: approval.plan_hash }, 201);
  });

  app.post('/webhooks/paypal', async c => {
    if (deps.config.paypalMode === 'sandbox' && deps.config.paypalWebhookId === 'pending')
      return failure(c, 'WEBHOOK_DISABLED', 'PayPal webhooks are not configured', 503);
    const rawBody = await c.req.text();
    const event = z.object({ id, event_type: id, resource: z.object({ id: id.optional(), sender_item_id: id.optional() }).passthrough() }).passthrough().parse(JSON.parse(rawBody));
    const verified = await deps.paypal.verifyWebhook(c.req.raw.headers, rawBody);
    console.log(JSON.stringify({ event: 'paypal_webhook', type: event.event_type, verified }));
    if (!verified) return failure(c, 'INVALID_SIGNATURE', 'Webhook signature invalid', 400);
    const resourceId = event.resource.id ?? '';
    const key = event.resource.sender_item_id ?? '';
    const row = deps.db.prepare("SELECT id,session_id,plan_id,action,status FROM outbox WHERE (paypal_id=? AND ?<>'') OR (substr(idempotency_key,1,63)=? AND ?<>'') LIMIT 1")
      .get(resourceId, resourceId, key, key) as { id: number; session_id: string; plan_id: string; action: string; status: string } | undefined;
    if (!row) return data(c, { accepted: true, changed: false });
    const inserted = deps.db.prepare('INSERT OR IGNORE INTO webhooks(event_id,session_id,received_at) VALUES(?,?,?)').run(event.id, row.session_id, Date.now());
    if (!inserted.changes) return data(c, { accepted: true, duplicate: true });
    const expectedAction: Record<string, string> = {
      'PAYMENT.CAPTURE.REFUNDED': 'REFUND',
      'PAYMENT.AUTHORIZATION.VOIDED': 'VOID_AUTHORIZATION',
      'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'PAYOUT',
      'PAYMENT.PAYOUTS-ITEM.FAILED': 'PAYOUT',
    };
    if (expectedAction[event.event_type] === row.action && row.status !== 'SUCCEEDED')
      await reconcilePlan(deps.db, gatewayForOrder, row.session_id, row.plan_id, true);
    const current = deps.db.prepare('SELECT status FROM outbox WHERE id=? AND session_id=?').get(row.id, row.session_id) as { status: string };
    return data(c, { accepted: true, changed: current.status !== row.status });
  });
  app.get('/assets/*', serveStatic({ root: './web/dist' }));
  app.get('/recalls-preview.png', serveStatic({ path: './web/dist/recalls-preview.png' }));
  app.get('/v1/*', c => failure(c, 'NOT_FOUND', 'Route not found', 404));
  app.get('*', serveStatic({ path: './web/dist/index.html' }));
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const paypal = config.paypalMode === 'sandbox'
    ? new SandboxPayPal({ clientId: config.paypalClientId!, clientSecret: config.paypalClientSecret!, webhookId: config.paypalWebhookId! })
    : new FakePayPal();
  const ai = config.aiBaseUrl && config.aiApiKey && config.aiModel
    ? new OpenAiCompatibleProvider({ baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, model: config.aiModel })
    : new FakeAiProvider();
  const app = createApp({ db, paypal, ai, config });
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
  console.log(`RecallRelay listening in ${config.paypalMode} mode`);
}
