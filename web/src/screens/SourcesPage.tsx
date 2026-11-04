import { useState } from "react";
import { api, shortDate } from "../api.ts";
import { BusyButton, ErrorLine, Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";

type SourceStatus = {
  ok: boolean;
  count: number;
  error?: string;
  displayName?: string;
  region?: string;
  refreshedAt?: string;
  sortOrder?: number;
};
const sourceNames: Record<string, string> = {
  CPSC: "CPSC",
  HEALTH_CANADA: "Health Canada",
  GOV_UK: "GOV.UK",
  EU_SAFETY_GATE: "Safety Gate",
  OECD_GLOBAL_RECALLS: "OECD portal",
};

export function SourcesPage() {
  const [state, retry] = useLoad<Record<string, SourceStatus>>("/v1/sources");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await api("/v1/sources/refresh", {});
      retry();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell active="Sources">
      <div className="page-title-actions">
        <Header
          title="Sources"
          summary="Each source updates independently. Original notices remain linked."
        />
        <BusyButton busy={busy} onClick={refresh}>Refresh sources</BusyButton>
      </div>
      <Result state={state} retry={retry}>
        {(value) => (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Region</th>
                  <th>Status</th>
                  <th>Last read</th>
                  <th className="amount">Records</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(value).sort(([a, left], [b, right]) => (left.sortOrder ?? 99) - (right.sortOrder ?? 99) || a.localeCompare(b)).map((
                  [name, detail],
                ) => (
                  <tr key={name}>
                    <td>
                      <span className={`status-dot${detail.ok ? "" : " danger"}`} />
                      {detail.displayName ?? sourceNames[name] ?? name}
                    </td>
                    <td className="muted">{detail.region ?? "—"}</td>
                    <td>
                      <Stamp
                        text={detail.ok ? "Available" : "Unavailable"}
                        tone={detail.ok ? "green" : "red"}
                      />
                    </td>
                    <td className="muted">
                      {detail.refreshedAt ? shortDate(detail.refreshedAt) : "Not checked"}
                    </td>
                    <td className="amount">{detail.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Result>
      <ErrorLine text={error} />
    </Shell>
  );
}
