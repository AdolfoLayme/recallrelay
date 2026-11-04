import { useState } from "react";
import { api, fullDate } from "../api.ts";
import type { Order, Plan, Recall } from "../api.ts";
import { BusyButton, ErrorLine, Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";

function NoticeText({ notice }: { notice: Recall }) {
  const hazard = notice.hazard?.match(/posing (.+?)\./i)?.[1];
  const remedy = notice.rawText.match(/full\s+refund|free replacement|free repair/i)?.[0];
  const sold = notice.rawText.match(/sold online from .*? (?:through|to) .*? \d{4}/i)?.[0];
  const phrases = [notice.extraction?.products[0]?.model, hazard, remedy, sold].filter((
    value,
  ): value is string => Boolean(value));
  const paragraphs = notice.rawText.replace(/\. (Consumers should|The heaters were)/g, ".\n\n$1").split(
    "\n\n",
  );
  return (
    <div className="notice-copy">
      {paragraphs.map((paragraph, index) => {
        const parts: React.ReactNode[] = [];
        let remaining = paragraph;
        while (remaining.length) {
          const match = phrases.map((phrase) => ({
            phrase,
            index: remaining.toLowerCase().indexOf(phrase.toLowerCase()),
          }))
            .filter((item) => item.index >= 0).sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length)[0];
          if (!match) {
            parts.push(remaining);
            break;
          }
          if (match.index) parts.push(remaining.slice(0, match.index));
          parts.push(
            <strong className="evidence-quote" key={`${index}-${parts.length}`}>
              {remaining.slice(match.index, match.index + match.phrase.length)}
            </strong>,
          );
          remaining = remaining.slice(match.index + match.phrase.length);
        }
        return <p key={index}>{parts}</p>;
      })}
    </div>
  );
}

export function RecallFile({ id }: { id: string }) {
  const [recall, reload] = useLoad<Recall>(`/v1/recalls/${id}`);
  const [orders] = useLoad<Order[]>("/v1/orders");
  const [store, reloadStore] = useLoad<{ allowed: boolean }>("/v1/store/status");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(name: string, task: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await task();
      reload();
      reloadStore();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function build() {
    setBusy("plan");
    setError("");
    try {
      const result = await api<Plan>(`/v1/recalls/${id}/plan`, {});
      window.location.href = `/plans/${result.data.id}`;
    } catch (cause) {
      setError((cause as Error).message);
      setBusy("");
    }
  }
  const value = recall.value;
  const blocked = store.value?.allowed === false;
  return (
    <Shell active="Recalls">
      <Header
        title="Product safety recall"
        summary={value?.fileSummary ?? value?.title ?? "Loading recall…"}
        file={value?.fileNumber}
        breadcrumb={{ label: "Recalls", href: "/recalls" }}
      />
      <Result state={recall} retry={reload}>
        {(notice) => (
          <div className="file-grid">
            <article className="outline-panel official-notice">
              <h2>Official notice</h2>
              <p className="small muted">
                {notice.noticeCaption ?? "Official notice."} {fullDate(notice.publishedAt)}
              </p>
              <NoticeText notice={notice} />
              <p className="small muted footnote">
                Red text is the evidence AI quoted. Any field without an exact quote is dropped.
              </p>
            </article>
            <section className="file-right">
              <div className="section-heading">
                <h2>Match result</h2>
                <span className="muted small">
                  Confidence {notice.extraction?.confidence?.toFixed(2) ?? "—"}
                </span>
              </div>
              {notice.extraction
                ? (
                  <div className="fact-list">
                    {[
                      ["Model", notice.extraction.products[0]?.model, true],
                      [
                        "Hazard",
                        notice.displayFacts?.hazard ?? notice.extraction.hazard,
                        Boolean(notice.extraction.hazard),
                      ],
                      [
                        "Remedy",
                        notice.displayFacts?.remedy ?? notice.extraction.remedies.join(", "),
                        Boolean(notice.displayFacts?.remedy || notice.extraction.remedies.length),
                      ],
                      [
                        "Sold",
                        notice.displayFacts?.sold ?? (notice.soldOnline ? "Online" : ""),
                        Boolean(notice.displayFacts?.sold || notice.soldOnline),
                      ],
                      [
                        "Barcode",
                        notice.extraction.products[0]?.gtin || "Not in the notice",
                        Boolean(notice.extraction.products[0]?.gtin),
                      ],
                    ].map(([label, detail, found]) => (
                      <div className="fact-row" key={String(label)}>
                        <span>{label}</span>
                        <strong>{detail || "Not found"}</strong>
                        <Stamp text={found ? "Found" : "Missing"} tone={found ? "green" : "neutral"} />
                      </div>
                    ))}
                  </div>
                )
                : <div className="state-message compact">Read the notice to extract cited facts.</div>}
              <h2 className="section-title">Matched in your sales</h2>
              <div className="large-counts">
                <div>
                  <strong>{orders.value?.length ?? 0} orders</strong>
                </div>
                <div>
                  <strong>{new Set(orders.value?.map((order) => order.buyerCountry)).size} countries</strong>
                </div>
                <div>
                  <strong>{new Set(orders.value?.map((order) => order.currency)).size} currencies</strong>
                </div>
              </div>
              <p className="muted">{notice.matchSummary ?? "Review the order matches before settlement."}</p>
              <div className="sale-row">
                {blocked ? <Stamp text="Sale stopped" tone="red" /> : <Stamp text="Sale active" tone="amber" />}
                <span>
                  SKU {notice.identifiers[0] ?? "—"} {blocked ? `blocked at checkout${notice.saleBlockedAt ? ` at ${notice.saleBlockedAt}` : ""}.` : "must be blocked before settlement."}
                </span>
              </div>
              <div className="file-actions">
                {!notice.extraction && (
                  <BusyButton
                    busy={busy === "extract"}
                    onClick={() =>
                      act("extract", async () => {
                        await api(`/v1/recalls/${id}/extract`, {});
                        await api(`/v1/recalls/${id}/match`, {});
                      })}
                  >
                    Read notice
                  </BusyButton>
                )}
                {!blocked && (
                  <BusyButton
                    busy={busy === "block"}
                    onClick={() => act("block", () => api(`/v1/recalls/${id}/block`, { skus: notice.identifiers }))}
                  >
                    Stop sale
                  </BusyButton>
                )}
                <BusyButton busy={busy === "plan"} disabled={!notice.extraction || !blocked} onClick={build}>
                  Review settlement plan
                </BusyButton>
                <a className="button secondary" href={notice.url} target="_blank" rel="noopener noreferrer">
                  Read original notice
                </a>
              </div>
              <ErrorLine text={error} />
            </section>
          </div>
        )}
      </Result>
    </Shell>
  );
}
