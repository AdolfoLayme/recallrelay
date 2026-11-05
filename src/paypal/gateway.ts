export class PayPalError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  constructor(message: string, status: number, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}

export type PayPalResult = { id: string; status: string; amountMinor?: number; currency?: string; itemId?: string; reason?: string };
export type CaptureState = { id: string; status: string; refundedMinor: number; amountMinor?: number; currency?: string; payeeMerchantId?: string };

export interface PayPalGateway {
  createOrder(intent: 'CAPTURE' | 'AUTHORIZE', items: { name: string; sku: string; quantity: number; unitPriceMinor: number; currency: string }[], requestId: string): Promise<unknown>;
  captureOrder(orderId: string, requestId: string): Promise<unknown>;
  searchTransactions(start: Date, end: Date): Promise<unknown[]>;
  refundCapture(captureId: string, amountMinor: number, currency: string, requestId: string): Promise<PayPalResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalResult>;
  createPayout(email: string, amountMinor: number, currency: string, requestId: string): Promise<PayPalResult>;
  getCapture(captureId: string): Promise<CaptureState>;
  getAuthorization(authorizationId: string): Promise<PayPalResult>;
  getPayout(batchId: string): Promise<PayPalResult>;
  getPayoutItem(itemId: string): Promise<PayPalResult>;
  getRefund(refundId: string): Promise<PayPalResult>;
  createInvoice(recipientEmail: string, currency: string, amountMinor: number, description: string): Promise<{ id: string }>;
  sendInvoice(invoiceId: string): Promise<void>;
  verifyWebhook(headers: Headers, event: unknown): Promise<boolean>;
}
