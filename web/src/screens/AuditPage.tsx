import { Header, Result, Shell, useLoad } from "../ui.tsx";

type AuditRow = {
  id: number;
  actor: string;
  at: number;
  entity: string;
  before_json: string;
  after_json: string;
};

function summarize(row: AuditRow): string {
  let change: Record<string, unknown> = {};
  try {
    change = JSON.parse(row.after_json) as Record<string, unknown>;
  } catch {
    return "Recorded change";
  }
  if (row.entity.startsWith("sale-block:")) {
    return `Sale blocked for ${Array.isArray(change.skus) ? change.skus.join(", ") : "recalled product"}`;
  }
  if (row.entity.startsWith("recall-extraction:")) {
    return `Evidence extracted · confidence ${change.confidence ?? "unknown"}`;
  }
  if (row.entity.startsWith("recall-matches:")) return `${change.orders ?? "—"} orders checked`;
  if (row.entity.startsWith("plan:")) return `${change.orders ?? "—"} orders planned`;
  if (row.entity.startsWith("plan-order:")) return "Execution order updated";
  if (row.entity.startsWith("notice:")) return `Notice ${String(change.status ?? "recorded").toLowerCase()}`;
  if (row.entity.startsWith("outbox:")) return `Payment ${String(change.status ?? "updated").toLowerCase()}`;
  if (row.entity.startsWith("approval:")) return "Plan and budgets approved";
  if (row.entity.startsWith("invoice:")) {
    return `Supplier invoice ${String(change.status ?? "updated").toLowerCase()}`;
  }
  if (row.entity.startsWith("review:")) {
    return `Review ${String(change.status ?? change.resolution ?? "recorded").toLowerCase()}`;
  }
  if (row.entity === "sources:refresh") return `${change.imported ?? 0} notices imported`;
  if (row.entity === "orders:sync" || row.entity === "orders:import") {
    return `${change.imported ?? 0} orders imported`;
  }
  return "Recorded change";
}

export function AuditPage() {
  const [state, retry] = useLoad<AuditRow[]>("/v1/audit");
  return (
    <Shell active="Audit log">
      <Header
        title="Audit log"
        summary="A permanent record of approvals, choices, and payment state changes."
      />
      <Result state={state} retry={retry} empty="No audit entries yet. Approve a plan to start the record.">
        {(rows) => (
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Record</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {new Date(row.at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>{row.actor}</td>
                    <td className="mono">{row.entity}</td>
                    <td>
                      <details className="audit-change">
                        <summary>{summarize(row)}</summary>
                        <pre>{row.after_json}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Result>
    </Shell>
  );
}
