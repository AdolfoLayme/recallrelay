import { ChevronRight } from "lucide-react";
import type { Plan, Recall } from "../api.ts";
import { Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";

function PlanIndexRow({ plan }: { plan: Plan }) {
  const [approval] = useLoad<{ approved: boolean }>(`/v1/plans/${plan.id}/approval`);
  const [recall] = useLoad<Recall>(`/v1/recalls/${plan.recallId}`);
  return (
    <tr>
      <td>
        <a href={`/plans/${plan.id}`}>Settlement plan for {recall.value?.title ?? plan.recallId}</a>
      </td>
      <td>{plan.items.length} orders</td>
      <td>
        {approval.value && (
          <Stamp
            text={approval.value.approved ? "Approved" : "Draft"}
            tone={approval.value.approved ? "green" : "neutral"}
          />
        )}
      </td>
      <td className="mono">{plan.planHash.slice(0, 8)}</td>
      <td>
        <a className="table-link" href={`/plans/${plan.id}`} aria-label="Open settlement plan">
          <ChevronRight size={16} />
        </a>
      </td>
    </tr>
  );
}

export function PlanIndex() {
  const [state, retry] = useLoad<Plan[]>("/v1/plans");
  return (
    <Shell active="Plans">
      <Header title="Plans" summary="Approved and draft settlement files." />
      <Result state={state} retry={retry} empty="No plans yet. Open a recall file and build one.">
        {(rows) => (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Orders</th>
                  <th>Status</th>
                  <th>Hash</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>{rows.map((row) => <PlanIndexRow key={row.id} plan={row} />)}</tbody>
            </table>
          </div>
        )}
      </Result>
    </Shell>
  );
}
