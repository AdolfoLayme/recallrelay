import { useEffect, useState } from "react";
import { api, ApiFailure, money } from "../api.ts";
import type { Order, Plan, Recall } from "../api.ts";
import { ActionStamp, BusyButton, ErrorLine, Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";
import { displayAmount, ruleText } from "./plan-display.ts";

export function PlanPage({ id }: { id: string }) {
  const [plan, reload] = useLoad<Plan>(`/v1/plans/${id}`);
  const [orders] = useLoad<Order[]>("/v1/orders");
  const [approval, refreshApproval] = useLoad<{ approved: boolean; budget?: Record<string, number> }>(
    `/v1/plans/${id}/approval`,
  );
  const [recall] = useLoad<Recall>(plan.value?.recallId ? `/v1/recalls/${plan.value.recallId}` : undefined);
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (plan.value) {
      setBudgets(
        Object.fromEntries(
          Object.entries(plan.value.totals).map((
            [currency, total],
          ) => [
            currency,
            ((plan.value!.suggestedBudgets?.[currency] ?? Math.ceil(total * 1.05 / 10000) * 10000) / 100)
              .toFixed(2),
          ]),
        ),
      );
    }
  }, [plan.value?.id]);
  const byId = new Map((orders.value ?? []).map((order) => [order.id, order]));
  const position = new Map((orders.value ?? []).map((order, index) => [order.id, index]));
  const asOf = Date.parse(recall.value?.demoAsOf ?? new Date().toISOString());
  async function approve() {
    if (!plan.value) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/plans/${id}/approve`, {
        planHash: plan.value.planHash,
        approver: "Demo operator",
        budget: Object.fromEntries(
          Object.entries(budgets).map(([currency, value]) => [currency, Math.round(Number(value) * 100)]),
        ),
      });
      refreshApproval();
    } catch (cause) {
      const failure = cause as ApiFailure;
      setError(
        failure.code === "APPROVAL_REJECTED" ? "The plan changed or a currency budget is too low. Review the amounts and approve again." : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell active="Plans">
      <Header
        title="Settlement plan"
        summary={recall.value?.planSummary ?? (recall.value
          ? `${recall.value.title}. ${plan.value?.items.length ?? 0} orders in this plan. Nothing moves until you approve.`
          : "Loading settlement plan…")}
        file={recall.value?.fileNumber}
        breadcrumb={{ label: "Recalls", href: `/recalls/${plan.value?.recallId ?? ""}` }}
      />
      <Result state={plan} retry={reload}>
        {(value) => {
          const moving: Record<string, number> = {};
          for (const item of value.items) {
            if (["REFUND", "PAYOUT"].includes(item.action)) {
              moving[item.currency] = (moving[item.currency] ?? 0) + item.amountMinor;
            }
          }
          const currencies = Object.keys(value.suggestedBudgets ?? value.totals);
          return (
            <div className="plan-grid">
              <div className="table-wrap">
                <table className="data-table plan-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Country</th>
                      <th>Age</th>
                      <th>Action</th>
                      <th>Rule</th>
                      <th className="amount">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...value.items].sort((a, b) => (position.get(a.orderId) ?? 999) - (position.get(b.orderId) ?? 999)).map((item) => {
                      const order = byId.get(item.orderId);
                      return (
                        <tr key={item.orderId}>
                          <td className="mono">#{item.orderId}</td>
                          <td>{order?.buyerCountry ?? "—"}</td>
                          <td className="muted">
                            {order ? Math.floor((asOf - Date.parse(order.paidAt)) / 86400000) : "—"} d
                          </td>
                          <td>
                            {item.action === "REFUND" && ruleText(item, order, asOf).includes("days left")
                              ? <Stamp text="Refund" tone="red" />
                              : <ActionStamp action={item.action} />}
                          </td>
                          <td
                            className={item.action === "MANUAL_REVIEW" ||
                                (item.action === "REFUND" && ruleText(item, order, asOf).includes("days left"))
                              ? "red-text"
                              : "muted"}
                          >
                            {ruleText(item, order, asOf)}
                          </td>
                          <td className="amount">
                            {money(displayAmount(item, order), item.currency)}
                            {order?.gateway === "sandbox" && (
                              <small>
                                <Stamp text="Real sandbox" tone="blue" />
                              </small>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="simulation-note muted">All orders are simulated unless marked Real sandbox.</p>
              </div>
              <aside className="outline-panel approve-panel">
                <h2>Approve plan</h2>
                <p>
                  You approve the whole plan with a budget per currency. Amounts come from fixed rules, not from AI. Currencies are never added together.
                </p>
                <table className="budget-table">
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th className="amount">Moves now</th>
                      <th className="amount">Budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currencies.map((currency) => (
                      <tr key={currency}>
                        <td>{currency}</td>
                        <td className="amount">{money(moving[currency] ?? 0, currency)}</td>
                        <td>
                          <label>
                            <span className="sr-only">{currency} budget in major units</span>
                            <input
                              type="number"
                              min={value.totals[currency] / 100}
                              step="0.01"
                              value={budgets[currency] ?? ""}
                              onChange={(event) => setBudgets({ ...budgets, [currency]: event.target.value })}
                            />
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted budget-note">
                  {recall.value?.planNote ?? "Review each currency and unresolved order before approving."}
                </p>
                <div className="approve-foot">
                  <p className="mono small muted">
                    Plan hash {value.planHash.slice(0, 4)}…{value.planHash.slice(-4)}. Any change cancels this approval.
                  </p>
                  {approval.value?.approved
                    ? (
                      <>
                        <Stamp text="Approved" tone="green" />
                        <div className="button-row">
                          <a className="button primary" href={`/plans/${id}/window`}>View refund window</a>
                          <a className="button secondary" href={`/plans/${id}/run`}>Run settlement</a>
                        </div>
                      </>
                    )
                    : <BusyButton busy={busy} onClick={approve}>Approve plan and budget</BusyButton>}
                  <ErrorLine text={error} />
                </div>
              </aside>
            </div>
          );
        }}
      </Result>
    </Shell>
  );
}
