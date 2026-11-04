import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, shortDate } from "../api.ts";
import type { Timeline } from "../api.ts";
import { BusyButton, ErrorLine, Header, Result, Shell, useLoad } from "../ui.tsx";

export function RefundWindow({ id }: { id: string }) {
  const [timeline, reload] = useLoad<Timeline[]>(`/v1/plans/${id}/timeline`);
  const [priority, refreshPriority] = useLoad<{ orderIds: string[]; custom: boolean }>(
    `/v1/plans/${id}/order`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const rows = useMemo(() => {
    const order = priority.value?.orderIds ?? [];
    return [...(timeline.value ?? [])]
      .filter((row) => ["REFUND", "PAYOUT", "AWAIT_BUYER_CHOICE"].includes(row.action))
      .sort((a, b) => priority.value?.custom ? order.indexOf(a.resourceId) - order.indexOf(b.resourceId) : a.daysLeft - b.daysLeft);
  }, [timeline.value, priority.value]);
  const urgent = rows.filter((row) => row.action === "REFUND" && row.daysLeft >= 0)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
  async function save(ids: string[], message: string) {
    setBusy(true);
    setError("");
    try {
      const all = priority.value?.orderIds ?? [];
      await api(`/v1/plans/${id}/order`, {
        orderIds: [...ids, ...all.filter((value) => !ids.includes(value))],
      });
      setStatus(message);
      refreshPriority();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const asOf = timeline.value?.[0]?.asOf ?? new Date().toISOString();
  const start = new Date(asOf);
  start.setMonth(start.getMonth() - 8, 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 14);
  end.setDate(end.getDate() + 4);
  const span = end.getTime() - start.getTime();
  const pct = (date: string) => Math.max(0, Math.min(100, (Date.parse(date) - start.getTime()) / span * 100));
  const today = pct(asOf);
  return (
    <Shell active="Plans">
      <Header
        title="Refund window"
        summary="PayPal refunds normally work for 180 days. After that, RecallRelay pays the buyer out instead."
        file="RR-2026-0417"
      />
      <Result state={timeline} retry={reload}>
        {() => (
          <>
            <div className="timeline-scroll">
              <div className="timeline">
                <div className="timeline-months">
                  <span />
                  {Array.from({ length: 14 }, (_, index) => {
                    const date = new Date(start);
                    date.setMonth(date.getMonth() + index);
                    return (
                      <span key={index}>
                        {date.getMonth() === 0 ? `Jan ${String(date.getFullYear()).slice(-2)}` : date.toLocaleDateString("en-US", { month: "short" })}
                      </span>
                    );
                  })}
                </div>
                <div className="timeline-body">
                  <div
                    className="today-line"
                    style={{ left: `calc(94px + (100% - 94px) * ${today / 100})` }}
                  />
                  <p
                    className="today-caption"
                    style={{ left: `calc(94px + (100% - 94px) * ${today / 100} - 45px)` }}
                  >
                    Today, {shortDate(asOf)}
                  </p>
                  <div className="timeline-rows">
                    {rows.map((row) => {
                      const left = pct(row.startDate);
                      const right = pct(row.deadline);
                      const labelCrossesToday = left < today && right > today && today - left < 15;
                      return (
                        <div
                          className="timeline-row"
                          key={row.resourceId}
                          draggable
                          onDragStart={(event) => event.dataTransfer.setData("text/plain", row.resourceId)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => {
                            event.preventDefault();
                            const moved = event.dataTransfer.getData("text/plain");
                            if (moved && moved !== row.resourceId) {
                              const ids = rows.map((item) => item.resourceId).filter((value) => value !== moved);
                              ids.splice(ids.indexOf(row.resourceId), 0, moved);
                              void save(ids, `Moved #${moved} in the execution order.`);
                            }
                          }}
                        >
                          <strong className="mono">#{row.resourceId}</strong>
                          <div className="timeline-track">
                            <div
                              className={`timeline-event ${row.action === "PAYOUT" ? "past" : row.action === "AWAIT_BUYER_CHOICE" ? "choice" : row.daysLeft <= 2 ? "urgent" : ""}`}
                              style={{
                                left: `${left}%`,
                                width: `${Math.max(2, right - left)}%`,
                                paddingLeft: labelCrossesToday ? `calc(${today - left}% + 10px)` : undefined,
                              }}
                            >
                              {row.action === "PAYOUT"
                                ? `Payout route, closed ${Math.abs(row.daysLeft)} days ago`
                                : row.action === "AWAIT_BUYER_CHOICE"
                                ? `${row.daysLeft} days left, buyer chooses`
                                : `${row.daysLeft} days left`}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div className="outline-panel window-panel">
              <div>
                <h2>
                  <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" /> {urgent ? `Send #${urgent.resourceId} first` : "Execution order"}
                </h2>
                <p>
                  {urgent
                    ? `Its refund window closes on ${shortDate(urgent.deadline)}. AI suggests the order of work only. Amounts and actions stay as you approved them.`
                    : "Move rows to set the execution order. Amounts and actions stay approved."}
                </p>
              </div>
              <div className="button-row">
                <BusyButton
                  busy={busy}
                  onClick={() => urgent && save([urgent.resourceId], `#${urgent.resourceId} will run first.`)}
                  disabled={!urgent}
                >
                  Move to front
                </BusyButton>
                <BusyButton
                  busy={busy}
                  className="secondary"
                  onClick={() => save(rows.map((row) => row.resourceId), "Current order saved.")}
                >
                  Keep this order
                </BusyButton>
              </div>
            </div>
            <a className="window-next" href={`/plans/${id}/run`}>Continue to settlement run</a>
            <p role="status" className="green-text">{status}</p>
            <ErrorLine text={error} />
          </>
        )}
      </Result>
    </Shell>
  );
}
