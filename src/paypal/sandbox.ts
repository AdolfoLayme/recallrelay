import { toPayPalAmount, fromPayPalAmount } from '../money.ts';
import { PayPalError } from './gateway.ts';
import type { PayPalGateway, PayPalResult, CaptureState } from './gateway.ts';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SandboxConfig = { clientId: string; clientSecret: string; webhookId: string; baseUrl?: string; fetcher?: Fetcher };

export class SandboxPayPal implements PayPalGateway {
  private readonly fetcher: Fetcher;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId: string;
  private token = '';
  private tokenExpiresAt = 0;

  constructor(config: SandboxConfig) {
    if ((config.baseUrl ?? SANDBOX_BASE_URL) !== SANDBOX_BASE_URL) throw new Error('Only PayPal sandbox is allowed');
    if (!config.clientId || !config.clientSecret || !config.webhookId) throw new Error('Sandbox credentials required');
    this.fetcher = config.fetcher ?? fetch;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.webhookId = config.webhookId;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    let response: Response;
    try {
      response = await this.fetcher(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new PayPalError('PayPal token request failed', 0, true); }
    if (!response.ok) throw new PayPalError('PayPal token request failed', response.status);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token || !Number.isFinite(body.expires_in)) throw new PayPalError('Invalid PayPal token response', 502);
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000;
    return this.token;
  }

  async checkConnection(): Promise<void> {
    await this.accessToken();
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid sandbox path');
    const url = new URL(path, SANDBOX_BASE_URL);
    if (url.origin !== SANDBOX_BASE_URL) throw new Error('Only PayPal sandbox is allowed');
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new PayPalError('PayPal request outcome unknown', 0, true); }
    if (!response.ok) throw new PayPalError('PayPal request failed', response.status, response.status >= 500);
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch { throw new PayPalError('Invalid PayPal response', 502, true); }
  }

  async refundCapture(captureId: string, amountMinor: number, currency: string, requestId: string): Promise<PayPalResult> {
    const body = { amount: { currency_code: currency, value: toPayPalAmount(amountMinor, currency) } };
    return this.refundResult(await this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, requestId));
  }

  private refundResult(value: unknown): PayPalResult {
    const result = value as { id: string; status: string; amount?: { currency_code: string; value: string } };
    return { id: result.id, status: result.status,
      ...(result.amount ? { amountMinor: fromPayPalAmount(result.amount.value, result.amount.currency_code), currency: result.amount.currency_code } : {}) };
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalResult> {
    await this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, requestId);
    return { id: authorizationId, status: 'VOIDED' };
  }

  async createPayout(email: string, amountMinor: number, currency: string, requestId: string): Promise<PayPalResult> {
    const key = requestId.slice(0, 63);
    const result = await this.request('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: key, recipient_type: 'EMAIL' },
      items: [{ recipient_type: 'EMAIL', amount: { currency: currency, value: toPayPalAmount(amountMinor, currency) }, receiver: email, sender_item_id: key }],
    }, requestId) as { batch_header?: { payout_batch_id?: string; batch_status?: string } };
    return { id: result.batch_header?.payout_batch_id ?? '', status: result.batch_header?.batch_status ?? 'PENDING' };
  }

  async getCapture(captureId: string): Promise<CaptureState> {
    const result = await this.request('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`) as {
      id: string; status: string; amount?: { value: string; currency_code: string }; payee?: { merchant_id?: string };
    };
    return { id: result.id, status: result.status,
      ...(result.amount ? { amountMinor: fromPayPalAmount(result.amount.value, result.amount.currency_code), currency: result.amount.currency_code } : {}),
      refundedMinor: result.status === 'REFUNDED' && result.amount ? fromPayPalAmount(result.amount.value, result.amount.currency_code) : 0,
      payeeMerchantId: result.payee?.merchant_id };
  }

  async getAuthorization(authorizationId: string): Promise<PayPalResult> {
    return this.request('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`) as Promise<PayPalResult>;
  }

  async getRefund(refundId: string): Promise<PayPalResult> {
    return this.refundResult(await this.request('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`));
  }

  async getPayout(batchId: string): Promise<PayPalResult> {
    const result = await this.request('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`) as { batch_header?: { payout_batch_id?: string; batch_status?: string }; items?: { payout_item_id?: string }[] };
    return { id: result.batch_header?.payout_batch_id ?? batchId, status: result.batch_header?.batch_status ?? 'PENDING', ...(result.items?.[0]?.payout_item_id ? { itemId: result.items[0].payout_item_id } : {}) };
  }

  async getPayoutItem(itemId: string): Promise<PayPalResult> {
    const result = await this.request('GET', `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`) as { payout_item_id?: string; transaction_status?: string; errors?: { name?: string } };
    return { id: result.payout_item_id ?? itemId, status: result.transaction_status ?? 'PENDING', ...(result.errors?.name ? { reason: result.errors.name } : {}) };
  }

  async searchTransactions(start: Date, end: Date): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let from = start.getTime(); from < end.getTime(); from += 31 * 86_400_000) {
      const to = Math.min(end.getTime(), from + 31 * 86_400_000 - 1);
      const query = new URLSearchParams({ start_date: new Date(from).toISOString(), end_date: new Date(to).toISOString(), fields: 'all', page_size: '500', page: '1' });
      const result = await this.request('GET', `/v1/reporting/transactions?${query}`) as { transaction_details?: unknown[]; total_pages?: number };
      all.push(...(result.transaction_details ?? []));
      for (let page = 2; page <= (result.total_pages ?? 1); page++) {
        query.set('page', String(page));
        const next = await this.request('GET', `/v1/reporting/transactions?${query}`) as { transaction_details?: unknown[] };
        all.push(...(next.transaction_details ?? []));
      }
    }
    return all;
  }

  async createOrder(intent: 'CAPTURE' | 'AUTHORIZE', items: { name: string; sku: string; quantity: number; unitPriceMinor: number; currency: string }[], requestId: string): Promise<unknown> {
    const currency = items[0]?.currency;
    if (!currency || items.some(item => item.currency !== currency)) throw new Error('Order needs one currency');
    const total = items.reduce((n, item) => n + item.quantity * item.unitPriceMinor, 0);
    return this.request('POST', '/v2/checkout/orders', {
      intent, purchase_units: [{ amount: { currency_code: currency, value: toPayPalAmount(total, currency), breakdown: { item_total: { currency_code: currency, value: toPayPalAmount(total, currency) } } }, items: items.map(item => ({ name: item.name, sku: item.sku, quantity: String(item.quantity), unit_amount: { currency_code: currency, value: toPayPalAmount(item.unitPriceMinor, currency) } })) }],
    }, requestId);
  }

  async captureOrder(orderId: string, requestId: string): Promise<unknown> {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<unknown> {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId);
  }

  async createInvoice(recipientEmail: string, currency: string, amountMinor: number, description: string): Promise<{ id: string }> {
    const result = await this.request('POST', '/v2/invoicing/invoices', {
      detail: { currency_code: currency }, primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
      items: [{ name: description, quantity: '1', unit_amount: { currency_code: currency, value: toPayPalAmount(amountMinor, currency) } }],
    }) as { id?: string; href?: string };
    // PayPal answers with a link to the draft, not with the invoice itself.
    const id = result.id ?? result.href?.split('/').pop();
    if (!id) throw new PayPalError('Invoice ID missing from PayPal response', 502);
    return { id };
  }

  async sendInvoice(invoiceId: string): Promise<void> {
    await this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, { send_to_recipient: true });
  }

  async verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
    const result = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers.get('paypal-auth-algo'), cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'), transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'), webhook_id: this.webhookId, webhook_event: event,
    }) as { verification_status?: string };
    return result.verification_status === 'SUCCESS';
  }
}
