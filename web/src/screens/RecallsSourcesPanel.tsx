import { Result, useLoad } from "../ui.tsx";

type SourceStatus = {
  ok: boolean;
  count: number;
  displayName?: string;
  region?: string;
  refreshedAt?: string;
  sortOrder?: number;
  updatedLabel?: string;
};

function ago(value?: string): string {
  if (!value) return "Not checked";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)} h ago` : `${minutes} min ago`;
}

export function RecallsSourcesPanel() {
  const [sources, reload] = useLoad<Record<string, SourceStatus>>("/v1/sources");
  return (
    <aside className="outline-panel sources-panel">
      <h2>Sources</h2>
      <p>A failed source never stops the others.</p>
      <Result state={sources} retry={reload}>
        {(value) => (
          <div>
            {Object.entries(value)
              .sort((a, b) => (a[1].sortOrder ?? 99) - (b[1].sortOrder ?? 99))
              .map(([name, detail]) => (
                <div className="source-row" key={name}>
                  <div>
                    <strong>
                      <span className={`status-dot${detail.ok ? "" : " danger"}`} />
                      {detail.displayName ?? name.replaceAll("_", " ")}
                    </strong>
                    <span>{detail.region ?? ""}</span>
                  </div>
                  <span className={detail.ok ? "green-text" : "red-text"}>{detail.ok ? ago(detail.refreshedAt) : "Unavailable"}</span>
                </div>
              ))}
          </div>
        )}
      </Result>
      <p className="source-note">
        {Object.values(sources.value ?? {})[0]?.updatedLabel ?? "Sources update independently."} Notices link to the original source.
      </p>
    </aside>
  );
}
