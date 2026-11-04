export type OrderStatus = 'AUTHORIZED' | 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'VOIDED';

export type OrderLine = {
  sku: string;
  gtin?: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  taxMinor: number;
};

export type Order = {
  id: string;
  gateway?: 'fake' | 'sandbox';
  merchantId: string;
  buyerName: string;
  buyerEmail: string;
  buyerCountry: string;
  language: string;
  currency: string;
  status: OrderStatus;
  shipped: boolean;
  paidAt: string;
  authorizationId?: string;
  captureId?: string;
  refundedMinor: number;
  lines: OrderLine[];
};

export type ExtractedProduct = {
  brand: string;
  model: string;
  sku: string;
  gtin: string;
  aliases: string[];
};

export type OrderMatch = { score: number; lineSkus: string[]; reason: string };

export type Action = 'MANUAL_REVIEW' | 'NO_ACTION' | 'VOID_AUTHORIZATION' |
  'AWAIT_BUYER_CHOICE' | 'REFUND' | 'PAYOUT' | 'FULFILMENT_TASK';

export type PolicyDecision = { action: Action; amountMinor: number; reason: string };
