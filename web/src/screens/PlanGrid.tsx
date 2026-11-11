import { useMemo, useRef, useState } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { ColDef, RowClassRules } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { money } from "../api.ts";
import type { Order, PlanItem } from "../api.ts";
import { ActionStamp, Stamp } from "../ui.tsx";
import { displayAmount, ruleText } from "./plan-display.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid's Quartz theme set to the app's own tokens (styles.css).
const theme = themeQuartz.withParams({
  fontFamily: "'Inter Variable', Inter, sans-serif",
  fontSize: 14,
  foregroundColor: "#1a1f36",
  backgroundColor: "#ffffff",
  headerBackgroundColor: "#ffffff",
  headerTextColor: "#697386",
  headerFontSize: 12,
  headerFontWeight: 500,
  borderColor: "#ebeef1",
  rowBorder: { color: "#ebeef1" },
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHoverColor: "#f6f8fa",
  accentColor: "#4a4fe0",
  rowHeight: 44,
  headerHeight: 38,
  cellHorizontalPadding: 12,
  oddRowBackgroundColor: "#ffffff",
});

type Row = {
  orderId: string;
  country: string;
  ageDays: number | null;
  action: PlanItem["action"] | "";
  rule: string;
  amountMinor: number;
  currency: string;
  sandbox: boolean;
  urgent: boolean;
  total?: boolean;
};

const actionLabel: Record<string, string> = {
  REFUND: "Refund",
  PAYOUT: "Payout",
  VOID_AUTHORIZATION: "Void",
  AWAIT_BUYER_CHOICE: "Buyer choice",
  MANUAL_REVIEW: "Review",
  NO_ACTION: "No action",
};

export function PlanGrid({ planId, items, byId, position, asOf }: {
  planId: string;
  items: PlanItem[];
  byId: Map<string, Order>;
  position: Map<string, number>;
  asOf: number;
}) {
  const grid = useRef<AgGridReact<Row>>(null);
  const [query, setQuery] = useState("");

  const rows = useMemo<Row[]>(() =>
    [...items]
      .sort((a, b) => (position.get(a.orderId) ?? 999) - (position.get(b.orderId) ?? 999))
      .map((item) => {
        const order = byId.get(item.orderId);
        const rule = ruleText(item, order, asOf);
        return {
          orderId: item.orderId,
          country: order?.buyerCountry ?? "—",
          ageDays: order ? Math.floor((asOf - Date.parse(order.paidAt)) / 86400000) : null,
          action: item.action,
          rule,
          amountMinor: displayAmount(item, order),
          currency: item.currency,
          sandbox: order?.gateway === "sandbox",
          urgent: item.action === "MANUAL_REVIEW" || (item.action === "REFUND" && rule.includes("days left")),
        };
      }), [items, byId, position, asOf]);

  // What leaves the business now, per currency. Currencies are never added together.
  const totals = useMemo<Row[]>(() => {
    const moving = new Map<string, number>();
    for (const row of rows) {
      if (row.action === "REFUND" || row.action === "PAYOUT") moving.set(row.currency, (moving.get(row.currency) ?? 0) + row.amountMinor);
    }
    return [...moving].map(([currency, amountMinor]) => ({
      orderId: "", country: "", ageDays: null, action: "", rule: `Moves now in ${currency}`, amountMinor, currency, sandbox: false, urgent: false, total: true,
    }));
  }, [rows]);

  const columns = useMemo<ColDef<Row>[]>(() => [
    {
      field: "orderId", headerName: "Order", width: 92, cellClass: "mono", filter: "agTextColumnFilter",
      // store orders carry the full PayPal capture id, too long for this column: shorten it, full id on hover and in the CSV
      valueFormatter: (p) => (p.data?.total ? "" : String(p.value).startsWith("store-") ? `#${String(p.value).slice(6, 12)}…` : `#${p.value}`),
      tooltipValueGetter: (p) => (p.data?.total ? undefined : `#${p.value}`),
    },
    { field: "country", headerName: "Country", width: 92, filter: "agTextColumnFilter" },
    {
      field: "ageDays", headerName: "Age", width: 80, filter: "agNumberColumnFilter", cellClass: "muted",
      valueFormatter: (p) => (p.value == null ? (p.data?.total ? "" : "—") : `${p.value} d`),
    },
    {
      colId: "action", headerName: "Action", width: 136, filter: "agTextColumnFilter",
      valueGetter: (p) => actionLabel[p.data?.action ?? ""] ?? p.data?.action ?? "",
      cellRenderer: (p: { data?: Row }) => {
        const row = p.data;
        if (!row || row.total || !row.action) return null;
        return row.action === "REFUND" && row.rule.includes("days left")
          ? <Stamp text="Refund" tone="red" />
          : <ActionStamp action={row.action} />;
      },
    },
    {
      field: "rule", headerName: "Rule", flex: 1, minWidth: 150, filter: "agTextColumnFilter", tooltipField: "rule",
      // the real sandbox purchase is marked here; in Amount the stamp cut the figure off
      cellRenderer: (p: { data?: Row; value?: string }) => (
        <span>
          {p.value}
          {p.data?.sandbox && <small> <Stamp text="Real sandbox" tone="blue" /></small>}
        </span>
      ),
      cellClassRules: { "red-text": (p) => !!p.data?.urgent, muted: (p) => !p.data?.urgent && !p.data?.total, "grid-total-label": (p) => !!p.data?.total },
    },
    // currency shows inside Amount; the quick filter finds it too
    { field: "currency", headerName: "Currency", hide: true },
    {
      colId: "amount", headerName: "Amount", width: 160, type: "rightAligned", filter: "agNumberColumnFilter",
      valueGetter: (p) => (p.data ? p.data.amountMinor / 100 : 0),
      // amounts in different currencies sort by currency first, then by size
      comparator: (_a, _b, nodeA, nodeB) =>
        (nodeA.data?.currency ?? "").localeCompare(nodeB.data?.currency ?? "") || (nodeA.data?.amountMinor ?? 0) - (nodeB.data?.amountMinor ?? 0),
      cellRenderer: (p: { data?: Row }) => {
        const row = p.data;
        if (!row) return null;
        return (
          <span className={row.total ? "grid-total" : undefined}>
            {money(row.amountMinor, row.currency)}
          </span>
        );
      },
    },
  ], []);

  const rowClassRules = useMemo<RowClassRules<Row>>(() => ({ "grid-attention": (p) => !!p.data?.urgent }), []);

  function exportCsv() {
    grid.current?.api.exportDataAsCsv({
      fileName: `settlement-plan-${planId}.csv`,
      columnKeys: ["orderId", "country", "ageDays", "action", "rule", "currency", "amount"],
      processCellCallback: (p) => {
        if (p.column.getColId() === "amount" && p.node?.data) return (p.node.data.amountMinor / 100).toFixed(2);
        if (p.column.getColId() === "orderId" && p.node?.data && !p.node.data.total) return `#${p.value}`;
        return p.value ?? "";
      },
    });
  }

  return (
    <div className="plan-ag">
      <div className="plan-ag-tools">
        <label className="plan-ag-search">
          <span className="sr-only">Filter orders</span>
          <input type="search" placeholder="Filter orders, countries, rules…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="button secondary" onClick={exportCsv}>Export CSV</button>
      </div>
      <div className="plan-table-grid">
        <AgGridReact<Row>
          ref={grid}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          pinnedBottomRowData={totals}
          quickFilterText={query}
          rowClassRules={rowClassRules}
          defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: false, floatingFilter: false }}
          getRowId={(p) => (p.data.total ? `total-${p.data.currency}` : p.data.orderId)}
          domLayout="autoHeight"
          suppressMovableColumns
          tooltipShowDelay={300}
          ensureDomOrder
          suppressCellFocus={false}
        />
      </div>
    </div>
  );
}
