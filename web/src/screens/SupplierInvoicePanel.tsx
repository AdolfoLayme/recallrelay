import { useState } from "react";
import { api, money } from "../api.ts";
import type { Plan } from "../api.ts";
import { BusyButton, ErrorLine } from "../ui.tsx";

export function SupplierInvoicePanel({ id, plan, totals, intro }: {
  id: string;
  plan?: Plan;
  totals: Record<string, number>;
  intro?: string;
}) {
  const [showInvoice, setShowInvoice] = useState(false);
  const [email, setEmail] = useState("supplier@example.test");
  const [invoiceCurrency, setInvoiceCurrency] = useState("");
  const [invoiceStatus, setInvoiceStatus] = useState("");
  const [invoiceApproval, setInvoiceApproval] = useState<{ id: string; currency: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function approveInvoice() {
    const currency = invoiceCurrency || Object.keys(totals)[0];
    if (!currency || !plan) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/v1/supplier-invoices/approve", {
        planId: id,
        planHash: plan.planHash,
        currency,
        recipientEmail: email,
        approver: "Demo operator",
        budgetMinor: totals[currency],
      });
      setInvoiceApproval({ id: result.data.id, currency });
      setInvoiceStatus(`${currency} invoice approved. Send it when ready.`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendInvoice() {
    if (!invoiceApproval) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/v1/supplier-invoices", { approvalId: invoiceApproval.id });
      setInvoiceStatus(`Invoice ${result.data.id} sent for ${invoiceApproval.currency}.`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside>
      <div className="outline-panel supplier-panel">
        <h2>Bill the supplier</h2>
        <p>{intro ?? "Send one PayPal invoice per currency for the amount paid out."}</p>
        <div className="ruled-list">
          {Object.entries(totals).map(([currency, amount]) => (
            <div key={currency}>
              <span>{currency}</span>
              <strong>{money(amount, currency)}</strong>
            </div>
          ))}
        </div>
        <p className="muted">Invoices need their own approval. The supplier may refuse to pay, so this is shown as money owed, not money received.</p>
        <button onClick={() => setShowInvoice((value) => !value)}>Review invoices</button>
      </div>
      {showInvoice && (
        <div className="invoice-form">
          <label className="field">
            Supplier email<input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setInvoiceApproval(undefined);
              }}
            />
          </label>
          <label className="field">
            Currency<select
              value={invoiceCurrency}
              onChange={(event) => {
                setInvoiceCurrency(event.target.value);
                setInvoiceApproval(undefined);
              }}
            >
              <option value="">Choose currency</option>
              {Object.keys(totals).map((currency) => <option key={currency}>{currency}</option>)}
            </select>
          </label>
          <div className="button-row">
            <BusyButton busy={busy} onClick={approveInvoice} disabled={!Object.keys(totals).length || !plan}>Approve invoice</BusyButton>
            <BusyButton busy={busy} onClick={sendInvoice} disabled={!invoiceApproval}>Send approved invoice</BusyButton>
          </div>
          <p role="status" className="green-text">{invoiceStatus}</p>
          <ErrorLine text={error} />
        </div>
      )}
    </aside>
  );
}
