import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../api.ts";
import { BusyButton, ErrorLine, SandboxStrip } from "../ui.tsx";

export function Start() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      await api("/v1/demo/session", {});
      window.location.href = "/recalls";
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="cover-page">
      <SandboxStrip mode="fake" />
      <div className="cover-content">
        <section className="cover-intro">
          <span className="brand-mark" aria-label="RecallRelay">
            <ShieldCheck size={22} strokeWidth={1.75} />
          </span>
          <h1>Recall response for PayPal merchants</h1>
          <p>Follow the evidence, stop the sale, and settle every affected order with one clear approval.</p>
          <BusyButton busy={busy} onClick={start}>Start the demo</BusyButton>
          <ErrorLine text={error} />
          <small>Harbor &amp; Pine, simulated merchant</small>
        </section>
        <div className="cover-preview" aria-label="Preview of the Recalls dashboard">
          <img
            src="/recalls-preview.png"
            alt="RecallRelay Recalls dashboard with a list of official product recalls"
          />
        </div>
      </div>
    </main>
  );
}
