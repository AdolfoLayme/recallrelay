import { useEffect, useState } from "react";
import { Check, CircleHelp, LoaderCircle } from "lucide-react";
import { api, money } from "../api.ts";
import type { Ledger, Order, Plan, Recall } from "../api.ts";
import { BusyButton, ErrorLine, Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";
import { SupplierInvoicePanel } from "./SupplierInvoicePanel.tsx";

export function RunPage({ id }: { id: string }) {
  const [run, reload] = useLoad<Ledger[]>(`/v1/plans/${id}/run`);
  const [plan] = useLoad<Plan>(`/v1/plans/${id}`);
  const [recall] = useLoad<Recall>(plan.value?.recallId ? `/v1/recalls/${plan.value.recallId}` : undefined);
  const [orders] = useLoad<Order[]>("/v1/orders");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!run.value?.some((row) => row.status === "UNKNOWN" || row.status === "SENDING")) return;
    const timer = window.setInterval(async () => {
      try {
        await api(`/v1/plans/${id}/execute`, {});
        reload();
      } catch { /* Keep checking. */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [run.value, id]);
  async function execute() {
    setBusy(true);
    setError("");
    try {
      await api(`/v1/plans/${id}/execute`, {});
      reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const totals: Record<string, number> = {};
  for (const row of run.value ?? []) {
    if (row.status === "SUCCEEDED" && ["REFUND", "PAYOUT"].includes(row.action)) {
      totals[row.currency] = (totals[row.currency] ?? 0) + row.amountMinor;
    }
  }
  const succeeded = run.value?.filter((row) => row.status === "SUCCEEDED").length ?? 0;
  const checkingCount = run.value?.filter((row) => row.status === "UNKNOWN" || row.status === "SENDING").length ?? 0;
  return (
    <Shell active="Plans">
      <Header
        title="Settlement run"
        summary={`${succeeded} of ${run.value?.length ?? 0} approved actions finished.${
          checkingCount ? ` ${checkingCount} ${checkingCount === 1 ? "is" : "are"} being checked with PayPal.` : ""
        }`}
      />
      <div
        className="run-progress"
        role="progressbar"
        aria-valuenow={succeeded}
        aria-valuemin={0}
        aria-valuemax={run.value?.length ?? 0}
        aria-label="Settlement progress"
      >
        <span style={{ width: `${run.value?.length ? succeeded / run.value.length * 100 : 0}%` }} />
      </div>
      <p className="run-progress-label">{succeeded} of {run.value?.length ?? 0} settled</p>
      <div className="run-grid">
        <section>
          <Result
            state={run}
            retry={reload}
            empty="No actions have run. Approve the plan, then start settlement."
          >
            {(rows) => (
              <div className="table-wrap">
                <table className="data-table run-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Action</th>
                      <th className="amount">Amount</th>
                      <th>Status</th>
                      <th>PayPal reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const order = orders.value?.find((item) => item.id === row.orderId);
                      const amount = row.action === "VOID_AUTHORIZATION" && order
                        ? order.lines.reduce(
                          (sum, line) => sum + line.quantity * line.unitPriceMinor + line.taxMinor,
                          0,
                        )
                        : row.amountMinor;
                      return (
                        <tr key={row.orderId}>
                          <td className="mono">#{row.orderId}</td>
                          <td>
                            {row.action === "VOID_AUTHORIZATION" ? "Void" : row.action[0] + row.action.slice(1).toLowerCase()}
                          </td>
                          <td className="amount">{money(amount, row.currency)}</td>
                          <td>
                            <Stamp
                              text={row.status === "SUCCEEDED" ? "Done" : row.status === "UNKNOWN" ? "Checking" : row.status}
                              tone={row.status === "SUCCEEDED" ? "green" : row.status === "UNKNOWN" ? "amber" : "red"}
                              icon={row.status === "SUCCEEDED" ? <Check /> : row.status === "UNKNOWN" ? <LoaderCircle /> : <CircleHelp />}
                            />
                          </td>
                          <td className="mono muted">
                            {row.paypalId ?? "—"}
                            {row.gateway === "sandbox" && (
                              <small>
                                <Stamp text="Real sandbox" tone="blue" />
                              </small>
                            )}
                            {row.reason && <small className="amber-text">{row.reason}</small>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Result>
          <p className="muted run-note">
            A timeout never means pay again. RecallRelay asks PayPal what happened before it does anything else.
          </p>
          <p className="simulation-note muted">All orders are simulated unless marked Real sandbox.</p>
          {!run.value?.length && <BusyButton busy={busy} onClick={execute}>Execute approved plan</BusyButton>}
          <ErrorLine text={error} />
        </section>
        <SupplierInvoicePanel id={id} plan={plan.value} totals={totals} intro={recall.value?.runSupplierIntro} />
      </div>
    </Shell>
  );
}
