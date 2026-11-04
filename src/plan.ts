import { createHash, randomUUID } from 'node:crypto';
import { classify } from './policy.ts';
import type { Order, OrderMatch, Action } from './types.ts';

export type PlanItem = {
  orderId: string;
  merchantId: string;
  action: Action;
  amountMinor: number;
  currency: string;
  reason: string;
  evidence: string;
  lineSkus: string[];
};

export type Plan = { id: string; recallId: string; items: PlanItem[]; totals: Record<string, number>; planHash: string; suggestedBudgets?: Record<string, number> };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashPlan(plan: Plan): string {
  return createHash('sha256').update(canonical({ recallId: plan.recallId, items: plan.items, totals: plan.totals })).digest('hex');
}

export function buildPlan(
  recallId: string,
  entries: { order: Order; match: OrderMatch; evidence: string }[],
  now: Date,
): Plan {
  const items: PlanItem[] = entries.map(({ order, match, evidence }) => {
    const decision = classify(order, match, { now });
    return {
      orderId: order.id, merchantId: order.merchantId, action: decision.action,
      amountMinor: decision.amountMinor, currency: order.currency, reason: decision.reason,
      evidence, lineSkus: [...match.lineSkus].sort(),
    };
  }).sort((a, b) => a.orderId.localeCompare(b.orderId));
  const totals: Record<string, number> = {};
  for (const item of items) if (item.amountMinor > 0) totals[item.currency] = (totals[item.currency] ?? 0) + item.amountMinor;
  const plan: Plan = { id: randomUUID(), recallId, items, totals, planHash: '' };
  plan.planHash = hashPlan(plan);
  return plan;
}
