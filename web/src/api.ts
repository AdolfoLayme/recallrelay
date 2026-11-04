export type Envelope<T> = { data: T; meta: { paypalMode: 'fake' | 'sandbox' } };
export class ApiFailure extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, body?: unknown): Promise<Envelope<T>> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json() as Envelope<T> & { error?: { code: string; message: string } };
  if (!response.ok) throw new ApiFailure(result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? 'Request failed', response.status);
  return result;
}

export type Recall = { id: string; source: string; sourceLabel?: string; country: string; publishedAt: string; title: string;
  rawText: string; url: string; hazard?: string; identifiers: string[]; soldOnline?: boolean; fileNumber?: string; supplier?: string;
  demoAsOf?: string; planSummary?: string; planNote?: string; fileSummary?: string; noticeCaption?: string;
  matchSummary?: string; saleBlockedAt?: string; runSupplierIntro?: string;
  reviewDescription?: string; reviewProductName?: string; reviewSold?: string; reviewScoreText?: string;
  displayFacts?: {hazard:string;remedy:string;sold:string};
  extraction?: { products: { model: string; sku: string; gtin?: string }[]; hazard: string; remedies: string[]; confidence: number; evidence: {field:string;quote:string}[] };
  matches?: { orderId: string; score: number; reason: string }[] };
export type Order = { id: string; gateway?: 'fake' | 'sandbox'; buyerCountry: string; buyerEmail: string; language: string; currency: string; paidAt: string;
  refundedMinor: number; lines: { sku: string; name: string; quantity: number; unitPriceMinor: number; taxMinor: number }[] };
export type PlanItem = { orderId: string; action: string; amountMinor: number; currency: string; reason: string; evidence: string; lineSkus: string[] };
export type Plan = { id: string; recallId: string; items: PlanItem[]; totals: Record<string, number>; planHash: string; suggestedBudgets?: Record<string,number> };
export type Ledger = { orderId: string; action: string; amountMinor: number; currency: string; status: string; paypalId?: string; gateway: 'fake' | 'sandbox'; reason?: string };
export type Review = { id: string; kind: string; status: string; body_json: string };
export type Timeline = { resourceId: string; label: string; startDate: string; deadline: string; daysLeft: number; asOf?: string; action: string; status: string };

export function money(minor: number, currency: string): string {
  const digits = ['JPY', 'KRW', 'TWD'].includes(currency) ? 0 : 2;
  const symbols: Record<string, string> = { USD: '$', CAD: 'C$', GBP: '£', AUD: 'A$', EUR: '€', JPY: '¥' };
  const amount = (minor / 10 ** digits).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${symbols[currency] ?? `${currency} `}${amount} ${currency}`;
}
export function shortDate(value: string): string { return new Date(value).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
export function fullDate(value: string): string { return new Date(value).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
