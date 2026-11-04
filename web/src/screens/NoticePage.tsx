import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Order, Plan } from "../api.ts";
import { BusyButton, ErrorLine, Header, Shell, Stamp, useLoad } from "../ui.tsx";
import { NoticeChecklist } from "./NoticeChecklist.tsx";

type Preview = {
  text: string;
  ok: boolean;
  problems: string[];
  language: string;
  orderId: string;
  demoWarning?: string;
};

export function NoticePage({ id }: { id: string }) {
  const [orders] = useLoad<Order[]>("/v1/orders");
  const [plan] = useLoad<Plan>(`/v1/plans/${id}`);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [warning, setWarning] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const buyers = (plan.value?.items ?? []).filter((item) => item.action === "AWAIT_BUYER_CHOICE")
    .map((item) => orders.value?.find((order) => order.id === item.orderId))
    .filter((order): order is Order => Boolean(order));
  const orderId = selected || buyers[0]?.id;
  const request = (order: string, draft?: string) =>
    api<Preview>("/v1/notices/check", {
      recallId: plan.value?.recallId,
      orderId: order,
      contact: "https://help.harborpine.example",
      ...(draft === undefined ? {} : { text: draft }),
    });

  useEffect(() => {
    if (!orderId || !plan.value?.recallId) return;
    let live = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setEditing(false);
    request(orderId).then(async (result) => {
      let next = result.data;
      let draft = next.text;
      if (next.demoWarning) {
        draft = draft.replace(/\n(Verwenden Sie)/, `\n\n${next.demoWarning}\n\n$1`);
        if (draft === next.text) draft = `${next.text}\n\n${next.demoWarning}`;
        next = (await request(orderId, draft)).data;
      }
      if (live) {
        setText(draft);
        setPreview(next);
        setWarning(result.data.demoWarning ?? "");
      }
    }).catch((cause) => {
      if (live) setError((cause as Error).message);
    })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [orderId, plan.value?.recallId]);

  async function check(draft = text) {
    if (!orderId) return;
    setBusy(true);
    setError("");
    try {
      const result = await request(orderId, draft);
      setPreview(result.data);
      setText(draft);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeWarning() {
    await check(text.replace(warning, "").replace(/\n{3,}/g, "\n\n"));
  }
  async function send() {
    if (!orderId || !preview?.ok) return;
    setBusy(true);
    setError("");
    try {
      for (const buyer of buyers) {
        await api("/v1/notices/send", {
          recallId: plan.value?.recallId,
          orderId: buyer.id,
          contact: "https://help.harborpine.example",
          ...(buyer.id === orderId ? { text } : {}),
        });
      }
      setStatus(`Notice sent to ${buyers.length} buyers.`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const flagged = preview?.problems.includes("Contains banned risk-minimizing wording") ?? false;
  return (
    <Shell active="Plans">
      <Header
        title="Buyer notice"
        summary="Written for EU buyers in their own language. It cannot be sent until every check passes."
        file="RR-2026-0417"
      />
      <div className="notice-grid">
        <div>
          <div className="button-row notice-tabs">
            {buyers.map((order) => (
              <button
                key={order.id}
                className={order.id === orderId ? "primary" : "secondary"}
                onClick={() => setSelected(order.id)}
              >
                {order.language === "de" ? "German" : order.language === "fr" ? "French" : order.language}, 1 buyer
              </button>
            ))}
          </div>
          {buyers.length
            ? editing
              ? (
                <>
                  <label className="sr-only" htmlFor="notice-text">Buyer notice text</label>
                  <textarea
                    id="notice-text"
                    className="notice-editor"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                </>
              )
              : (
                <div
                  className="notice-editor notice-preview"
                  role="button"
                  tabIndex={0}
                  aria-label="Edit buyer notice"
                  onClick={() => setEditing(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditing(true);
                    }
                  }}
                >
                  {text.split(/\n+/).filter(Boolean).map((line, index) => <p key={index} className={line === warning && flagged ? "flagged" : undefined}>{line}</p>)}
                </div>
              )
            : <div className="state-message">No buyer-choice notices in this plan.</div>}
        </div>
        <section>
          <div className="section-heading">
            <h2>Article 36 check</h2>
            <strong className={preview?.ok ? "green-text" : "red-text"}>
              {preview ? preview.ok ? "All checks pass" : `${preview.problems.length} problem${preview.problems.length === 1 ? "" : "s"}` : "Checking"}
            </strong>
          </div>
          <NoticeChecklist problems={preview?.problems} />
          {flagged && (
            <p className="notice-explanation">
              “vorsorglich” means precautionary. Regulation (EU) 2023/988 says a notice must avoid terms like this.
            </p>
          )}
          {preview?.problems.filter((problem) => problem !== "Contains banned risk-minimizing wording").map(
            (problem) => <p key={problem} className="red-text">{problem}</p>,
          )}
          <div className="button-row">
            {flagged ? <BusyButton busy={busy} onClick={removeWarning}>Remove the sentence</BusyButton> : (
              <BusyButton busy={busy} className="secondary" onClick={() => check()}>
                Check wording
              </BusyButton>
            )}
            <BusyButton
              busy={busy}
              className={flagged ? "secondary" : undefined}
              disabled={!preview?.ok || text !== preview.text}
              onClick={send}
            >
              Send to {buyers.length} buyers
            </BusyButton>
          </div>
          <p className="small muted">This check supports your review. It is not legal advice.</p>
          <p role="status" className="green-text">{status}</p>
          <ErrorLine text={error} />
        </section>
      </div>
    </Shell>
  );
}
