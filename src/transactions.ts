import { fromPayPalAmount } from './money.ts';
import type { Order, OrderLine } from './types.ts';

type Conversion = { order?: Order; reviewReason?: string; transactionId?: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const paymentCodes = new Set(['T0000', 'T0002', 'T0003', 'T0005', 'T0006', 'T0007', 'T0011', 'T0012', 'T0018', 'T0019', 'T0022', 'T0023']);

export function convertTransaction(raw: unknown, merchantId: string): Conversion {
  const source = object(raw);
  const info = object(source.transaction_info);
  const transactionId = string(info.transaction_id);
  const code = string(info.transaction_event_code);
  if (!paymentCodes.has(code) || info.transaction_status !== 'S') return { transactionId };
  const review = (reviewReason: string): Conversion => ({ transactionId, reviewReason });
  const amount = object(info.transaction_amount);
  const currency = string(amount.currency_code);
  const paidAt = string(info.transaction_initiation_date);
  const payer = object(source.payer_info);
  const country = string(payer.country_code);
  const email = string(payer.email_address);
  if (!transactionId || !merchantId || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Date.parse(paidAt)) || !/^[A-Z]{2}$/.test(country) || !/^\S+@\S+\.\S+$/.test(email))
    return review('MISSING_ORDER_FACTS');
  const details = object(source.cart_info).item_details;
  if (!Array.isArray(details) || details.length === 0) return review('MISSING_ITEM_DETAILS');
  let gross: number;
  try { gross = fromPayPalAmount(string(amount.value), currency); }
  catch { return review('INVALID_AMOUNT'); }
  const lines: OrderLine[] = [];
  for (const rawItem of details) {
    const item = object(rawItem);
    const sku = string(item.item_code);
    const name = string(item.item_name);
    const quantity = Number(item.item_quantity);
    const unit = object(item.item_unit_price);
    if (!sku || !name || !Number.isSafeInteger(quantity) || quantity <= 0 || unit.currency_code !== currency)
      return review('INVALID_ITEM_DETAILS');
    try {
      const unitPriceMinor = fromPayPalAmount(string(unit.value), currency);
      const total = object(item.total_item_amount);
      const totalMinor = total.value && total.currency_code === currency
        ? fromPayPalAmount(string(total.value), currency) : quantity * unitPriceMinor;
      const taxMinor = totalMinor - quantity * unitPriceMinor;
      if (unitPriceMinor < 0 || taxMinor < 0) return review('INVALID_ITEM_DETAILS');
      lines.push({ sku, name, quantity, unitPriceMinor, taxMinor });
    } catch { return review('INVALID_ITEM_DETAILS'); }
  }
  if (lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0) !== gross)
    return review('AMOUNT_MISMATCH');
  const payerName = object(payer.payer_name);
  const buyerName = [string(payerName.given_name), string(payerName.surname)].filter(Boolean).join(' ') || email;
  return { transactionId, order: {
    id: transactionId, merchantId, buyerName, buyerEmail: email, buyerCountry: country, language: 'en',
    currency, status: 'CAPTURED', shipped: true, paidAt: new Date(paidAt).toISOString(), captureId: transactionId,
    refundedMinor: 0, lines,
  } };
}
