import { useEffect, useState } from "react";
import { api, ApiFailure } from "../api.ts";

type PayPalGlobal = {
  createInstance: (
    options: { clientId: string; components: string[] },
  ) => Promise<
    {
      findEligibleMethods: (
        options?: { currencyCode: string },
      ) => Promise<{ isEligible: (name: string) => boolean }>;
      createPayPalOneTimePaymentSession: (
        options: {
          onApprove: (data: { orderId: string }) => Promise<void>;
          onCancel: () => void;
          onError: (error: Error) => void;
        },
      ) => Promise<
        {
          start: (
            options: { presentationMode: string },
            order: Promise<{ orderId: string }>,
          ) => Promise<void>;
        }
      >;
    }
  >;
};
declare global {
  interface Window {
    paypal?: PayPalGlobal;
  }
}
export function PayPalButton(
  { onCaptured, onBlocked, onError, clientId }: {
    onCaptured: (captureId: string) => void;
    onBlocked: () => void;
    onError: (message: string) => void;
    clientId: string;
  },
) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!container) return;
    let live = true;
    let button: HTMLElement | undefined;
    async function init() {
      let script = document.getElementById("paypal-v6") as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement("script");
        script.id = "paypal-v6";
        script.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
        script.async = true;
        document.head.append(script);
      }
      if (!window.paypal) {
        await new Promise<void>((resolve, reject) => {
          script!.addEventListener("load", () => resolve(), { once: true });
          script!.addEventListener("error", () => reject(new Error("PayPal could not load")), { once: true });
        });
      }
      if (!live || !window.paypal) return;
      const instance = await window.paypal.createInstance({ clientId, components: ["paypal-payments"] });
      const eligible = await instance.findEligibleMethods({ currencyCode: "USD" });
      if (!eligible.isEligible("paypal")) {
        onError("PayPal is not available for this buyer.");
        return;
      }
      const session = await instance.createPayPalOneTimePaymentSession({
        onApprove: async (data) => {
          try {
            const result = await api<{ captureId: string }>(
              `/v1/store/orders/${encodeURIComponent(data.orderId)}/capture`,
              {},
            );
            onCaptured(result.data.captureId);
          } catch (cause) {
            onError((cause as Error).message);
          }
        },
        onCancel: () => onError("Payment cancelled. No capture was made."),
        onError: (error) => onError(error.message),
      });
      if (!live) return;
      button = document.createElement("paypal-button");
      button.setAttribute("aria-label", "Pay with PayPal");
      button.addEventListener("click", async () => {
        try {
          const order = api<{ id: string }>("/v1/store/orders", { country: "US" }).then((result) => ({
            orderId: result.data.id,
          })).catch((error) => {
            if (error instanceof ApiFailure && error.code === "PRODUCT_RECALLED") onBlocked();
            throw error;
          });
          await session.start({ presentationMode: "auto" }, order);
        } catch (cause) {
          onError((cause as Error).message);
        }
      });
      container?.append(button);
    }
    void init().catch((cause) => onError((cause as Error).message));
    return () => {
      live = false;
      button?.remove();
    };
  }, [container, clientId]);
  return <div ref={setContainer} className="paypal-slot" aria-label="PayPal checkout" />;
}
