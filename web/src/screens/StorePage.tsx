import { useEffect, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { api, money } from "../api.ts";
import { BuyerFooter, ErrorLine, useLoad } from "../ui.tsx";
import { BuyerHeader } from "./BuyerPage.tsx";
import { PayPalButton } from "./PayPalButton.tsx";

export function StorePage() {
  const [config] = useLoad<{ mode: "fake" | "sandbox"; clientId?: string }>("/v1/paypal/client-config");
  const [check, setCheck] = useState<{ loading: boolean; allowed?: boolean; error?: string }>({
    loading: true,
  });
  const [blocked, setBlocked] = useState(false);
  const [captureId, setCaptureId] = useState("");
  const [error, setError] = useState("");
  async function recheck() {
    setCheck({ loading: true });
    try {
      const result = await api<{ allowed: boolean }>("/v1/checkout/check", {
        sku: "HP-LMH-015",
        country: "US",
      });
      setCheck({ loading: false, allowed: result.data.allowed });
    } catch (cause) {
      setCheck({ loading: false, error: (cause as Error).message });
    }
  }
  useEffect(() => {
    void recheck();
  }, []);
  const isBlocked = blocked || check.allowed === false;
  return (
    <div className="buyer-page">
      <BuyerHeader />
      <main className="buyer-main store-main">
        <h1>Your cart</h1>
        <div className="cart-line">
          <div>
            <strong>Lumen Mini Space Heater</strong>
            <span className="mono muted">HP-LMH-015</span>
          </div>
          <strong>{money(12900, "USD")}</strong>
        </div>
        {check.loading && (
          <div className="skeleton-stack">
            <div />
            <div />
          </div>
        )}
        {check.error && (
          <div className="state-message" role="alert">
            {check.error}
            <button className="secondary" onClick={recheck}>Try again</button>
          </div>
        )}
        {isBlocked && (
          <div className="danger-box">
            <TriangleAlert size={20} strokeWidth={1.75} />
            <div>
              <h2>This product cannot be sold</h2>
              <p>It is under a safety recall, so we removed it before any payment was taken.</p>
            </div>
          </div>
        )}
        {captureId && (
          <div className="success-box">
            <CircleCheck size={20} strokeWidth={1.75} />
            <strong>Payment captured</strong>
            <p>PayPal reference {captureId}. This order is now in the recall file.</p>
            <a href="/recalls">Open recall</a>
          </div>
        )}
        {!isBlocked && !captureId && config.value?.mode === "fake" && (
          <p className="muted">
            PayPal checkout is off in fake mode. Start the demo to inspect the recall and stop the sale.
          </p>
        )}
        {!check.loading && !check.error && !isBlocked && !captureId && config.value?.mode === "sandbox" &&
          config.value.clientId &&
          (
            <PayPalButton
              clientId={config.value.clientId}
              onCaptured={setCaptureId}
              onBlocked={() => {
                setBlocked(true);
                void recheck();
              }}
              onError={setError}
            />
          )}
        <ErrorLine text={error} />
        <div className="buyer-bottom">
          {isBlocked ? <button disabled>Pay with PayPal</button> : config.value?.mode === "fake" ? <button disabled>PayPal off in fake mode</button> : null}
          <small>
            {isBlocked ? "No order was created." : captureId ? "Your payment is recorded." : "Sandbox checkout only."}
          </small>
        </div>
      </main>
      <BuyerFooter />
    </div>
  );
}
