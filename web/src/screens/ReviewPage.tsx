import { useState } from "react";
import { api, money } from "../api.ts";
import type { Order, Recall, Review } from "../api.ts";
import { BusyButton, ErrorLine, Header, Result, Shell, useLoad } from "../ui.tsx";

type ReviewDetail = {
  recallId?: string;
  orderId?: string;
  reason?: string;
  score?: number;
  currency?: string;
  amountMinor?: number;
};

export function ReviewPage() {
  const [reviews, reload] = useLoad<Review[]>("/v1/review-queue");
  const [orders] = useLoad<Order[]>("/v1/orders");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const items = (reviews.value ?? []).filter((row) => row.status === "PENDING");
  const current = items.find((row) => row.id === selected) ?? items[0];
  const detail = current ? JSON.parse(current.body_json) as ReviewDetail : undefined;
  const [recall] = useLoad<Recall>(detail?.recallId ? `/v1/recalls/${detail.recallId}` : undefined);
  const order = orders.value?.find((row) => row.id === detail?.orderId);

  async function resolve(resolution: string) {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ planId?: string }>(`/v1/review-queue/${current.id}/resolve`, {
        resolution,
        actor: "Demo operator",
      });
      if (result.data.planId) {
        window.location.href = `/plans/${result.data.planId}`;
        return;
      }
      setMessage(`Review saved: ${resolution}.`);
      reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell active="Review queue">
      <Header
        title="Review queue"
        summary={`${items.length} orders need a person. Nothing here moves any money yet.`}
        file={recall.value?.fileNumber}
      />
      <Result state={reviews} retry={reload} empty="No orders need review.">
        {() =>
          items.length
            ? (
              <div className="review-grid">
                <div className="review-list">
                  {items.map((row) => {
                    const data = JSON.parse(row.body_json) as ReviewDetail;
                    return (
                      <button
                        className={current?.id === row.id ? "selected" : ""}
                        key={row.id}
                        onClick={() => setSelected(row.id)}
                      >
                        <span className="review-item-top">
                          <strong className="mono">#{data.orderId ?? row.kind}</strong>
                          <span className="muted">
                            {data.currency ? money(data.amountMinor ?? 0, data.currency) : ""}
                          </span>
                        </span>
                        <span className="red-text">{data.reason ?? row.kind.replaceAll("_", " ")}</span>
                      </button>
                    );
                  })}
                </div>
                <section>
                  <h2>Is this the recalled product?</h2>
                  <p className="muted">
                    {recall.value?.reviewDescription ?? detail?.reason ??
                      "Compare the order with the official recall before deciding."}
                  </p>
                  <table className="data-table compare-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Recall notice</th>
                        <th>Order #{order?.id}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th>Name</th>
                        <td>{recall.value?.reviewProductName ?? recall.value?.title ?? "—"}</td>
                        <td>{order?.lines[0]?.name ?? "—"}</td>
                      </tr>
                      <tr>
                        <th>Model or SKU</th>
                        <td className="mono">{recall.value?.identifiers[0] ?? "—"}</td>
                        <td className="mono red-text">{order?.lines[0]?.sku ?? "—"}</td>
                      </tr>
                      <tr>
                        <th>Sold</th>
                        <td>
                          {recall.value?.reviewSold ?? (recall.value?.soldOnline ? "Online" : "Not stated")}
                        </td>
                        <td>
                          {order
                            ? new Date(order.paidAt).toLocaleDateString("en-US", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              timeZone: "UTC",
                            })
                            : "—"}
                        </td>
                      </tr>
                      <tr>
                        <th>Buyer</th>
                        <td>Not stated</td>
                        <td>
                          {order?.buyerCountry ? new Intl.DisplayNames(["en"], { type: "region" }).of(order.buyerCountry) : "—"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="muted small">
                    {recall.value?.reviewScoreText ?? (detail?.score !== undefined ? `Match score ${detail.score.toFixed(2)}.` : detail?.reason)}
                  </p>
                  <p className="muted">Your decision is saved with your name and time in the audit log.</p>
                  <div className="button-row">
                    <BusyButton busy={busy} onClick={() => resolve("Add to plan")}>
                      Add to the plan
                    </BusyButton>
                    <BusyButton
                      busy={busy}
                      className="secondary"
                      onClick={() => resolve("Not affected")}
                    >
                      Not affected
                    </BusyButton>
                    <BusyButton busy={busy} className="secondary" onClick={() => resolve("Ask the supplier")}>
                      Ask the supplier
                    </BusyButton>
                  </div>
                  <p className="amber-text small">
                    Adding this order changes the plan, so you will approve it again.
                  </p>
                  <p role="status" className="green-text">{message}</p>
                  <ErrorLine text={error} />
                </section>
              </div>
            )
            : <div className="state-message">No open review items.</div>}
      </Result>
    </Shell>
  );
}
