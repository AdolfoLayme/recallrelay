import { PayPalError } from './gateway.ts';
import type { CaptureState, PayPalGateway, PayPalResult } from './gateway.ts';

export class FakePayPal implements PayPalGateway {
  sentCount = 0;
  nextFailure?: 'timeout-after-success' | 'server-error' | 'already-refunded' | 'too-high';
  private captures = new Map<string, { totalMinor: number; refundedMinor: number; currency: string; merchantId?: string }>();
  private results = new Map<string, PayPalResult>();

  async searchTransactions(): Promise<unknown[]> { return []; }
  async createOrder(_intent: 'CAPTURE' | 'AUTHORIZE', _items: { name: string; sku: string; quantity: number; unitPriceMinor: number; currency: string }[], _requestId: string): Promise<unknown> { throw new PayPalError('PayPal checkout is off in fake mode', 409); }
  async captureOrder(_orderId: string, _requestId: string): Promise<unknown> { throw new PayPalError('PayPal checkout is off in fake mode', 409); }

  registerCapture(id: string, totalMinor: number, currency: string, refundedMinor = 0, merchantId?: string): void {
    if (!id || !Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !Number.isSafeInteger(refundedMinor) || refundedMinor < 0 || refundedMinor > totalMinor)
      throw new Error('Invalid fake capture');
    const prior = this.captures.get(id);
    if (prior && (prior.totalMinor !== totalMinor || prior.currency !== currency || prior.refundedMinor !== refundedMinor))
      throw new Error('Fake capture already registered differently');
    if (!prior) this.captures.set(id, { totalMinor, refundedMinor, currency, merchantId });
  }

  async refundCapture(captureId: string, amountMinor: number, currency: string, requestId: string): Promise<PayPalResult> {
    const previous = this.results.get(requestId);
    if (previous) return previous;
    this.sentCount++;
    const failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure === 'server-error') throw new PayPalError('Simulated server error', 500, true);
    if (failure === 'already-refunded') throw new PayPalError('Already refunded', 422);
    const capture = this.captures.get(captureId);
    if (!capture) throw new PayPalError('Capture not found', 404);
    if (currency !== capture.currency || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > capture.totalMinor - capture.refundedMinor || failure === 'too-high')
      throw new PayPalError('Refund exceeds remaining capture balance', 422);
    const result = { id: `fake-refund-${requestId.slice(0, 12)}`, status: 'COMPLETED', amountMinor, currency };
    capture.refundedMinor += amountMinor;
    this.results.set(requestId, result);
    if (failure === 'timeout-after-success') throw new PayPalError('Simulated timeout after success', 0, true);
    return result;
  }

  async voidAuthorization(_authorizationId: string, requestId: string): Promise<PayPalResult> {
    const previous = this.results.get(requestId);
    if (previous) return previous;
    this.sentCount++;
    const result = { id: `fake-void-${requestId.slice(0, 12)}`, status: 'VOIDED' };
    this.results.set(requestId, result);
    return result;
  }

  async createPayout(_email: string, _amountMinor: number, _currency: string, requestId: string): Promise<PayPalResult> {
    const previous = this.results.get(requestId);
    if (previous) return previous;
    this.sentCount++;
    const result = { id: `fake-batch-${requestId.slice(0, 12)}`, status: 'SUCCESS', itemId: `fake-item-${requestId.slice(0, 12)}` };
    this.results.set(requestId, result);
    return result;
  }

  async getCapture(captureId: string): Promise<CaptureState> {
    const capture = this.captures.get(captureId);
    if (!capture) throw new PayPalError('Capture not found', 404);
    return { id: captureId, refundedMinor: capture.refundedMinor,
      status: capture.refundedMinor === capture.totalMinor ? 'REFUNDED' : capture.refundedMinor > 0 ? 'PARTIALLY_REFUNDED' : 'COMPLETED',
      payeeMerchantId: capture.merchantId };
  }

  async getAuthorization(authorizationId: string): Promise<PayPalResult> {
    return { id: authorizationId, status: [...this.results.values()].some(result => result.status === 'VOIDED') ? 'VOIDED' : 'CREATED' };
  }

  async getPayout(batchId: string): Promise<PayPalResult> {
    const result = [...this.results.values()].find(result => result.id === batchId);
    return result ?? { id: batchId, status: 'PENDING' };
  }

  async getPayoutItem(itemId: string): Promise<PayPalResult> {
    return { id: itemId, status: [...this.results.values()].some(result => result.itemId === itemId) ? 'SUCCESS' : 'PENDING' };
  }

  async getRefund(refundId: string): Promise<PayPalResult> {
    return [...this.results.values()].find(result => result.id === refundId) ?? { id: refundId, status: 'PENDING' };
  }

  async createInvoice(_recipientEmail: string, _currency: string, _amountMinor: number, _description: string): Promise<{ id: string }> {
    return { id: `fake-invoice-${this.results.size + 1}` };
  }

  async sendInvoice(_invoiceId: string): Promise<void> { }

  async verifyWebhook(headers: Headers): Promise<boolean> {
    return headers.get('x-fake-signature') === 'valid';
  }
}
