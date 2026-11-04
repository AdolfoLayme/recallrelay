import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../src/config.ts';
import { SandboxPayPal } from '../src/paypal/sandbox.ts';

type OrderResponse = { id?: string; links?: { rel?: string; href?: string }[]; purchase_units?: { payments?: { captures?: { id?: string }[]; authorizations?: { id?: string }[] } }[] };

export function approvalUrl(order: unknown): string {
  const links = (order as OrderResponse).links ?? [];
  const href = links.find(link => ['payer-action', 'approve'].includes(link.rel ?? ''))?.href;
  if (!href) throw new Error('PayPal approval URL was not returned');
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com') throw new Error('Only a PayPal sandbox approval URL is allowed');
  return url.toString();
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.paypalMode !== 'sandbox') throw new Error('Smoke test requires PAYPAL_MODE=sandbox');
  const payoutEmail = process.env.SMOKE_PAYOUT_EMAIL;
  const invoiceEmail = process.env.SMOKE_INVOICE_EMAIL;
  if (!payoutEmail || !invoiceEmail) throw new Error('SMOKE_PAYOUT_EMAIL and SMOKE_INVOICE_EMAIL are required');
  const paypal = new SandboxPayPal({ clientId: config.paypalClientId!, clientSecret: config.paypalClientSecret!, webhookId: config.paypalWebhookId!, baseUrl: process.env.PAYPAL_BASE_URL });
  const prompt = createInterface({ input: stdin, output: stdout });
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    try { const value = await action(); console.log(`PASS ${name}`); return value; }
    catch { console.error(`FAIL ${name}`); throw new Error(`${name} failed; inspect the sandbox dashboard without copying credentials into logs`); }
  };
  const waitForApproval = async (order: OrderResponse): Promise<void> => {
    console.log(`Approve in sandbox: ${approvalUrl(order)}`);
    await prompt.question('Press Enter after buyer approval: ');
  };
  try {
    await step('token', () => paypal.checkConnection());
    const captureOrder = await step('create capture order with items', () => paypal.createOrder('CAPTURE', [{ name: 'Fictional Lumen Mini Space Heater', sku: 'HP-LMH-015', quantity: 1, unitPriceMinor: 129, currency: 'USD' }], randomUUID())) as OrderResponse;
    await waitForApproval(captureOrder);
    const captured = await step('capture order', () => paypal.captureOrder(captureOrder.id!, randomUUID())) as OrderResponse;
    const captureId = captured.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!captureId) throw new Error('Capture ID missing from PayPal response');
    const refundKey = randomUUID();
    const refund = await step('refund capture', () => paypal.refundCapture(captureId, 129, 'USD', refundKey));
    const repeated = await step('repeat refund with same key', () => paypal.refundCapture(captureId, 129, 'USD', refundKey));
    if (refund.id !== repeated.id) throw new Error('Repeated refund returned a different ID');
    const authOrder = await step('create authorize order with items', () => paypal.createOrder('AUTHORIZE', [{ name: 'Fictional Lumen Mini Space Heater', sku: 'HP-LMH-015', quantity: 1, unitPriceMinor: 129, currency: 'USD' }], randomUUID())) as OrderResponse;
    await waitForApproval(authOrder);
    const authorized = await step('authorize order', () => paypal.authorizeOrder(authOrder.id!, randomUUID())) as OrderResponse;
    const authId = authorized.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
    if (!authId) throw new Error('Authorization ID missing from PayPal response');
    await step('void authorization', () => paypal.voidAuthorization(authId, randomUUID()));
    const transactions = await step('search transactions', () => paypal.searchTransactions(new Date(Date.now() - 7 * 86_400_000), new Date()));
    console.log(`Transaction item_details: ${transactions.some((item: any) => Array.isArray(item.cart_info?.item_details)) ? 'present' : 'absent'}`);
    await step('create payout', () => paypal.createPayout(payoutEmail, 129, 'USD', randomUUID()));
    const invoice = await step('create invoice', () => paypal.createInvoice(invoiceEmail, 'USD', 129, 'Fictional recall reimbursement'));
    await step('send invoice', () => paypal.sendInvoice(invoice.id));
  } finally { prompt.close(); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Smoke test failed'); process.exitCode = 1; });
