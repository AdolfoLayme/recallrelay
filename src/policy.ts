import type { Order, OrderMatch, PolicyDecision, Action } from './types.ts';

export const REFUND_WINDOW_DAYS = 180;
const EU_EEA = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '));

export function classify(
  order: Order,
  match: OrderMatch,
  context: { now: Date; requiresChoice?: boolean; choice?: 'refund' | 'repair' | 'replacement' },
): PolicyDecision {
  const result = (action: Action, reason: string, amountMinor = 0): PolicyDecision => ({ action, amountMinor, reason });
  if (match.score < 0.85) return result('MANUAL_REVIEW', 'Match below 0.85');
  if (order.status === 'REFUNDED' || order.status === 'VOIDED') return result('NO_ACTION', 'Already settled');
  if (order.status === 'AUTHORIZED' && !order.shipped) return result('VOID_AUTHORIZATION', 'Unshipped authorization');
  if (order.status === 'AUTHORIZED') return result('MANUAL_REVIEW', 'Shipped authorization');
  const totalMinor = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0);
  const remainingMinor = Math.max(0, totalMinor - order.refundedMinor);
  if (remainingMinor === 0) return result('NO_ACTION', 'Nothing remains refundable');
  const affectedMinor = Math.min(remainingMinor, order.lines.filter(line => match.lineSkus.includes(line.sku))
    .reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0));
  if (affectedMinor === 0) return result('MANUAL_REVIEW', 'Matched lines have no amount');
  if (context.choice === 'repair' || context.choice === 'replacement') return result('FULFILMENT_TASK', 'Buyer chose fulfilment');
  if ((EU_EEA.has(order.buyerCountry) || context.requiresChoice) && !context.choice) return result('AWAIT_BUYER_CHOICE', 'Buyer choice required', affectedMinor);
  const ageDays = Math.floor((context.now.getTime() - Date.parse(order.paidAt)) / 86_400_000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return result('MANUAL_REVIEW', 'Invalid payment date');
  if (ageDays <= REFUND_WINDOW_DAYS) return result('REFUND', 'Within refund window', affectedMinor);
  return result('PAYOUT', 'Outside refund window', affectedMinor);
}
