import { useEffect, useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { api, money } from "../api.ts";
import { BusyButton, BuyerFooter, ErrorLine, Result, useLoad } from "../ui.tsx";
import { BuyerConfirmation } from "./BuyerConfirmation.tsx";

export type Remedy = {
  product: string;
  hazard: string;
  stopTitle: string;
  instruction: string;
  helpText: string;
  options: string[];
  amount: number;
  currency: string;
  orderId: string;
  paidAt: string;
  sku: string;
  soldText: string;
  choice?: string;
  settlementStatus?: string;
  paypalReference?: string;
  settledAmountMinor?: number;
};

export function BuyerHeader() {
  return (
    <div className="buyer-top">
      <span className="brand-mark">
        <ShieldCheck size={15} strokeWidth={1.75} />
      </span>
      <strong>Harbor &amp; Pine</strong>
    </div>
  );
}

export function BuyerPage({ token }: { token: string }) {
  const [remedy, reload] = useLoad<Remedy>(`/v1/remedy/${token}`);
  const [step, setStep] = useState<"notice" | "choose" | "confirmed">("notice");
  const [choice, setChoice] = useState<"refund" | "repair" | "replacement">("refund");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (remedy.value?.choice) setStep("confirmed");
  }, [remedy.value?.choice]);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/v1/remedy/${token}/choice`, { choice, paypalEmail: email || undefined });
      reload();
      setStep("confirmed");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!remedy.value) return;
    const lines = [
      "RecallRelay confirmation",
      `Order #${remedy.value.orderId}`,
      `Choice: ${remedy.value.choice ?? choice}`,
      `Reference: ${remedy.value.paypalReference ?? "Pending"}`,
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `recallrelay-${remedy.value.orderId}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="buyer-page">
      <BuyerHeader />
      <Result state={remedy} retry={reload}>
        {(value) => (
          <main className="buyer-main">
            {step === "notice" && (
              <>
                <h1 className="hazard-title">Product safety recall</h1>
                <h2 className="buyer-product">{value.product}</h2>
                <p className="muted">Model {value.sku}. Your order #{value.orderId}.</p>
                <div className="danger-box">
                  <TriangleAlert size={20} strokeWidth={1.75} />
                  <div>
                    <h2>{value.stopTitle}</h2>
                    <p>{value.instruction}</p>
                  </div>
                </div>
                <p className="buyer-paid">
                  You paid {money(value.amount, value.currency)} on {new Date(value.paidAt).toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    timeZone: "UTC",
                  })}. Your remedy is free.
                </p>
                {value.soldText && <p className="muted">{value.soldText}</p>}
                <hr />
                <p className="muted">Please tell others who may use this heater.</p>
                <div className="buyer-bottom">
                  <button onClick={() => setStep("choose")}>Choose your remedy</button>
                  <small>{value.helpText}</small>
                </div>
              </>
            )}
            {step === "choose" && (
              <>
                <h1>Choose your remedy</h1>
                <p className="muted">Order #{value.orderId}. You can choose one.</p>
                <div className="choice-list">
                  <label className={choice === "refund" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="remedy"
                      checked={choice === "refund"}
                      onChange={() => setChoice("refund")}
                    />
                    <span>
                      <strong>Refund</strong>
                      <small>
                        {money(value.amount, value.currency)} back to the PayPal payment you used. No need to send the heater first.
                      </small>
                    </span>
                  </label>
                  {value.options.includes("repair") && (
                    <label className={choice === "repair" ? "selected" : ""}>
                      <input
                        type="radio"
                        name="remedy"
                        checked={choice === "repair"}
                        onChange={() => setChoice("repair")}
                      />
                      <span>
                        <strong>Repair</strong>
                        <small>The product will be repaired for free.</small>
                      </span>
                    </label>
                  )}
                  <label className={choice === "replacement" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="remedy"
                      checked={choice === "replacement"}
                      onChange={() => setChoice("replacement")}
                    />
                    <span>
                      <strong>Replacement</strong>
                      <small>A safe heater of the same type and value, delivered for free.</small>
                    </span>
                  </label>
                </div>
                <p className="muted">If a replacement is late, you can still switch to a refund.</p>
                {choice === "refund" &&
                  Math.floor((Date.now() - Date.parse(value.paidAt)) / 86400000) > 180 && (
                  <label className="field">
                    Confirm your PayPal email<input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                )}
                <div className="buyer-bottom">
                  <BusyButton busy={busy} onClick={confirm}>Confirm {choice}</BusyButton>
                  <small>Your choice cannot be used twice.</small>
                  <ErrorLine text={error} />
                </div>
              </>
            )}
            {step === "confirmed" && <BuyerConfirmation value={value} choice={choice} onSave={save} />}
          </main>
        )}
      </Result>
      <BuyerFooter />
    </div>
  );
}
