import { CircleCheck } from "lucide-react";
import { money } from "../api.ts";
import type { Remedy } from "./BuyerPage.tsx";

export function BuyerConfirmation({ value, choice, onSave }: { value: Remedy; choice: string; onSave: () => void }) {
  return (
    <>
      <h1>
        {value.choice === "replacement" ? "Replacement requested" : value.settlementStatus === "SUCCEEDED" ? "Refund on its way" : "Your choice is recorded"}
      </h1>
      <div className="success-box">
        <CircleCheck size={22} strokeWidth={1.75} />
        <p>
          {value.choice === "replacement"
            ? "A safe replacement has been requested."
            : value.settlementStatus === "SUCCEEDED"
            ? "Sent to your original PayPal payment."
            : "Payment status is being checked."}
        </p>
      </div>
      <dl className="receipt-list">
        <div>
          <dt>Order</dt>
          <dd className="mono">#{value.orderId}</dd>
        </div>
        <div>
          <dt>Remedy</dt>
          <dd>{(value.choice ?? choice).replace(/^./, (letter) => letter.toUpperCase())}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{money(value.settledAmountMinor ?? value.amount, value.currency)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{value.settlementStatus === "SUCCEEDED" ? "Sent" : "Pending"}</dd>
        </div>
        <div>
          <dt>PayPal reference</dt>
          <dd className="mono">{value.paypalReference ?? "Pending"}</dd>
        </div>
      </dl>
      <p>
        <strong>Keep the heater unplugged. Do not give it to anyone else.</strong>
      </p>
      <p className="muted">Banks can take a few days to show a refund. Keep this page for your records.</p>
      <div className="buyer-bottom">
        <button className="secondary" onClick={onSave}>Save confirmation</button>
      </div>
    </>
  );
}
