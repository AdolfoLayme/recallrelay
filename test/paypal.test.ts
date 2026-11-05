import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxPayPal } from '../src/paypal/sandbox.ts';

test('sandbox gateway refuses every non-sandbox host', () => {
  assert.throws(() => new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', baseUrl: 'https://api-m.paypal.com' }), /sandbox/i);
  assert.throws(() => new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', baseUrl: 'https://api.paypal.com' }), /sandbox/i);
});

test('refund uses OAuth, original capture, decimal string, and one request id', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'sensitive', expires_in: 3600 });
    return Response.json({ id: 'refund1', status: 'COMPLETED' });
  };
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', fetcher });
  assert.deepEqual(await paypal.refundCapture('capture1', 1234, 'EUR', 'key1'), { id: 'refund1', status: 'COMPLETED' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api-m.sandbox.paypal.com/v2/payments/captures/capture1/refund');
  assert.equal(new Headers(calls[1].init.headers).get('PayPal-Request-Id'), 'key1');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { amount: { currency_code: 'EUR', value: '12.34' } });
});

test('sandbox smoke can verify OAuth without making a payment', async () => {
  const paths: string[] = [];
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', fetcher: async input => {
    paths.push(String(input));
    return Response.json({ access_token: 'redacted-test-token', expires_in: 3600 });
  } });
  await paypal.checkConnection();
  await paypal.checkConnection();
  assert.deepEqual(paths, ['https://api-m.sandbox.paypal.com/v1/oauth2/token']);
});

test('sandbox order, payout and invoice requests use documented JSON fields', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', fetcher: async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (url.endsWith('/v1/payments/payouts')) return Response.json({ batch_header: { payout_batch_id: 'batch1', batch_status: 'PENDING' } }, { status: 201 });
    if (url.endsWith('/v2/invoicing/invoices')) return Response.json({ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/invoice1', method: 'GET' }, { status: 201 });
    if (url.endsWith('/send')) return Response.json({}, { status: 202 });
    return Response.json({ id: 'order1', links: [] }, { status: 201 });
  } });
  await paypal.createOrder('CAPTURE', [{ name: 'Fictional Heater', sku: 'HP-LMH-015', quantity: 2, unitPriceMinor: 129, currency: 'USD' }], 'order-key');
  await paypal.createPayout('buyer@example.test', 129, 'USD', 'a'.repeat(64));
  const invoice = await paypal.createInvoice('supplier@example.test', 'USD', 129, 'Recall reimbursement');
  await paypal.sendInvoice(invoice.id);
  const order = JSON.parse(String(calls[1].init.body));
  assert.equal(order.intent, 'CAPTURE');
  assert.equal(order.purchase_units[0].amount.breakdown.item_total.value, '2.58');
  assert.equal(order.purchase_units[0].items[0].sku, 'HP-LMH-015');
  const payout = JSON.parse(String(calls[2].init.body));
  assert.equal(payout.sender_batch_header.sender_batch_id.length, 63);
  assert.equal(payout.items[0].sender_item_id.length, 63);
  assert.equal(payout.items[0].amount.value, '1.29');
  const invoiceBody = JSON.parse(String(calls[3].init.body));
  assert.equal(invoiceBody.detail.currency_code, 'USD');
  assert.equal(invoiceBody.primary_recipients[0].billing_info.email_address, 'supplier@example.test');
  assert.equal(invoiceBody.items[0].unit_amount.value, '1.29');
  assert.equal(calls[4].url, 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/invoice1/send');
});

test('transaction search requests all fields and preserves cart item details', async () => {
  const urls: string[] = [];
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'hook', fetcher: async input => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    return Response.json({ transaction_details: [{ transaction_info: { transaction_id: 'one' }, cart_info: { item_details: [{ item_code: 'SKU-1' }] } }], total_pages: 1 });
  } });
  const result = await paypal.searchTransactions(new Date('2026-01-01T00:00:00Z'), new Date('2026-02-02T00:00:00Z')) as { cart_info?: { item_details?: { item_code: string }[] } }[];
  assert.equal(urls.length, 3);
  assert.ok(urls.slice(1).every(url => new URL(url).searchParams.get('fields') === 'all'));
  assert.equal(result[0].cart_info?.item_details?.[0].item_code, 'SKU-1');
});

test('sandbox maps the refund amount and payout item outcome', async () => {
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'pending', fetcher: async input => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (url.endsWith('/refund')) return Response.json({ id: 'refund-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '9.00' } });
    if (url.endsWith('/v1/payments/payouts/batch-1')) return Response.json({ batch_header: { payout_batch_id: 'batch-1', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'item-1', transaction_status: 'UNCLAIMED', errors: { name: 'RECEIVER_UNREGISTERED' } }] });
    if (url.endsWith('/v1/payments/payouts-item/item-1')) return Response.json({ payout_item_id: 'item-1', transaction_status: 'UNCLAIMED', errors: { name: 'RECEIVER_UNREGISTERED' } });
    return Response.json({});
  } });
  assert.deepEqual(await paypal.refundCapture('cap', 1000, 'USD', 'key'), { id: 'refund-1', status: 'COMPLETED', amountMinor: 900, currency: 'USD' });
  assert.deepEqual(await paypal.getPayout('batch-1'), { id: 'batch-1', status: 'SUCCESS', itemId: 'item-1' });
  assert.deepEqual(await paypal.getPayoutItem('item-1'), { id: 'item-1', status: 'UNCLAIMED', reason: 'RECEIVER_UNREGISTERED' });
});

test('capture lookup exposes the verified sandbox payee for reconciliation', async () => {
  const paypal = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'pending', fetcher: async input => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (url.endsWith('/v2/payments/captures/cap-1')) return Response.json({
      id: 'cap-1', status: 'REFUNDED', amount: { currency_code: 'USD', value: '12.00' },
      payee: { merchant_id: 'merchant-1' },
    });
    throw new Error(`Unexpected request: ${url}`);
  } });
  assert.deepEqual(await paypal.getCapture('cap-1'), {
    id: 'cap-1', status: 'REFUNDED', refundedMinor: 1200, amountMinor: 1200, currency: 'USD', payeeMerchantId: 'merchant-1',
  });
});
