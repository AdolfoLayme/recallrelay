import { useState } from "react";
import { ClipboardCheck, HelpCircle, Inbox, Radio, ScrollText, Search, ShieldCheck, Siren } from "lucide-react";
import type { Review } from "./api.ts";
import { useLoad } from "./load.tsx";
export { BusyButton, ErrorLine, Result, useLoad } from "./load.tsx";

export function Header({ title, summary, file, hazard = false, breadcrumb }: {
  title: string;
  summary: string;
  file?: string;
  hazard?: boolean;
  breadcrumb?: { label: string; href: string };
}) {
  return (
    <header className="page-header">
      {breadcrumb && (
        <div className="breadcrumb">
          <a href={breadcrumb.href}>{breadcrumb.label}</a>
          <span aria-hidden="true">/</span>
          <span>{file ?? title}</span>
        </div>
      )}
      <div className="header-line">
        <h1 className={hazard ? "hazard-title" : undefined}>{title}</h1>
        {file && <span className="file-number">{file}</span>}
      </div>
      <p>{summary}</p>
    </header>
  );
}

export function Stamp({ text, tone = "neutral", icon }: {
  text: string;
  tone?: "red" | "green" | "amber" | "blue" | "neutral";
  icon?: React.ReactNode;
}) {
  return <span className={`stamp ${tone}`}>{icon}{text}</span>;
}

export function ActionStamp({ action }: { action: string }) {
  const names: Record<string, string> = {
    REFUND: "Refund",
    PAYOUT: "Payout",
    VOID_AUTHORIZATION: "Void",
    AWAIT_BUYER_CHOICE: "Buyer choice",
    MANUAL_REVIEW: "Needs review",
    NO_ACTION: "No action",
    FULFILMENT_TASK: "Task",
  };
  const tones: Record<string, "red" | "green" | "amber" | "blue" | "neutral"> = {
    REFUND: "green",
    PAYOUT: "blue",
    VOID_AUTHORIZATION: "neutral",
    AWAIT_BUYER_CHOICE: "amber",
    MANUAL_REVIEW: "red",
    NO_ACTION: "neutral",
    FULFILMENT_TASK: "amber",
  };
  return <Stamp text={names[action] ?? action} tone={tones[action] ?? "neutral"} />;
}

export function SandboxStrip({ mode }: { mode: string }) {
  return (
    <div className="sandbox-strip">
      Sandbox: no real money moves <span aria-hidden="true">·</span> {mode === "sandbox" ? "PayPal sandbox" : "simulated orders"}
    </div>
  );
}

export function BuyerFooter() {
  return (
    <footer className="buyer-footer">
      <ShieldCheck size={14} aria-hidden="true" /> Secured by RecallRelay
    </footer>
  );
}

export function Shell({ children, active }: { children: React.ReactNode; active: string }) {
  const [queue] = useLoad<Review[]>("/v1/review-queue");
  const [health] = useLoad<{ paypalMode: string }>("/health");
  const reviewCount = queue.value?.filter((row) => row.status === "PENDING").length ?? 0;
  const [query, setQuery] = useState(new URLSearchParams(window.location.search).get("q") ?? "");
  const items = [
    { label: "Recalls", href: "/recalls", Icon: Siren },
    { label: "Plans", href: "/plans", Icon: ClipboardCheck },
    { label: "Review queue", href: "/review", Icon: Inbox },
    { label: "Audit log", href: "/audit", Icon: ScrollText },
    { label: "Sources", href: "/sources", Icon: Radio },
  ];
  return (
    <div className="app-frame">
      <SandboxStrip mode={health.value?.paypalMode ?? "fake"} />
      <div className="shell">
        <aside className="rail">
          <a className="brand" href="/recalls">
            <span className="brand-mark">
              <ShieldCheck size={18} strokeWidth={1.75} />
            </span>
            <span>
              <strong>Harbor &amp; Pine</strong>
              <small>RecallRelay</small>
            </span>
          </a>
          <nav aria-label="Main navigation">
            {items.map(({ label, href, Icon }) => (
              <a key={label} href={href} aria-current={active === label ? "page" : undefined}>
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{label}</span>
                {label === "Review queue" && reviewCount > 0 && <span className="nav-count">{reviewCount}</span>}
              </a>
            ))}
          </nav>
        </aside>
        <div className="main-column">
          <div className="topbar">
            <form className="top-search" action="/recalls">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <input
                name="q"
                aria-label="Search product, model, or source"
                placeholder="Search product, model, or source"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (active === "Recalls") {
                    window.dispatchEvent(
                      new CustomEvent("recall-search", { detail: event.target.value }),
                    );
                  }
                }}
              />
            </form>
            <div className="topbar-right">
              <a className="icon-button" href="/sources" aria-label="Help and sources">
                <HelpCircle size={16} strokeWidth={1.75} />
              </a>
              <span className="avatar" title="Harbor & Pine">HP</span>
            </div>
          </div>
          <main className="workarea">
            <div className="content">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
