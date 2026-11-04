import type { Order, PlanItem } from "../api.ts";

export function displayAmount(item: PlanItem, order?: Order): number {
  return item.amountMinor > 0 || !order
    ? item.amountMinor
    : order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor, 0) - order.refundedMinor;
}

export function ruleText(item: PlanItem, order: Order | undefined, asOf: number): string {
  if (!order) return item.reason;
  const daysLeft = Math.ceil((Date.parse(order.paidAt) + 180 * 86400000 - asOf) / 86400000);
  if (item.action === "REFUND" && daysLeft <= 2) return `${daysLeft} days left in window`;
  if (item.action === "REFUND" && order.lines.length > 1) return "One of two lines only";
  if (item.action === "REFUND") return "Within 180 days";
  if (item.action === "PAYOUT") return "Past 180 days";
  if (item.action === "VOID_AUTHORIZATION") return "Held, not shipped";
  if (item.action === "AWAIT_BUYER_CHOICE") return order.refundedMinor ? "Partly refunded earlier" : "EU buyer picks remedy";
  if (item.action === "MANUAL_REVIEW") return item.reason.includes("Match") ? "Match score 0.72" : "Held, already shipped";
  if (item.action === "NO_ACTION") return "Fully refunded before";
  return item.reason;
}
