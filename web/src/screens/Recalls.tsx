import { useEffect, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { shortDate } from "../api.ts";
import type { Recall } from "../api.ts";
import { Header, Result, Shell, Stamp, useLoad } from "../ui.tsx";
import { RecallsSourcesPanel } from "./RecallsSourcesPanel.tsx";
import { RecallTabs } from "./RecallTabs.tsx";
import type { RecallTab } from "./RecallTabs.tsx";
import { filterRecalls } from "./recall-filter.ts";

export function Recalls() {
  const [recalls, reload] = useLoad<Recall[]>("/v1/recalls");
  const [search, setSearch] = useState(new URLSearchParams(window.location.search).get("q") ?? "");
  const [country, setCountry] = useState("");
  const [hazard, setHazard] = useState("");
  const [tab, setTab] = useState<RecallTab>("All");
  const [menu, setMenu] = useState<"country" | "hazard" | null>(null);
  useEffect(() => {
    const listener = (event: Event) => setSearch((event as CustomEvent<string>).detail);
    window.addEventListener("recall-search", listener);
    return () => window.removeEventListener("recall-search", listener);
  }, []);
  const all = recalls.value ?? [];
  const countries = [...new Set(all.map((row) => row.country))].sort();
  const hazards = [
    ...new Set(all.map((row) => row.hazard?.toLowerCase().includes("fire") ? "Fire" : row.hazard ?? "")),
  ].filter(Boolean).sort();
  const rows = filterRecalls(all, search, country, hazard, tab);
  return (
    <Shell active="Recalls">
      <Header
        title="Recalls"
        summary="Official notices from around the world, checked against what you sold."
      />
      <div className="recalls-grid">
        <section>
          <RecallTabs value={tab} onChange={setTab} />
          <div className="filters">
            <div className="filter-menu">
              <button
                className="secondary"
                aria-expanded={menu === "country"}
                onClick={() => setMenu(menu === "country" ? null : "country")}
              >
                <Plus size={14} />
                {country || "Country"}
              </button>
              {menu === "country" && (
                <div className="filter-options">
                  <button
                    onClick={() => {
                      setCountry("");
                      setMenu(null);
                    }}
                  >
                    All countries
                  </button>
                  {countries.map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setCountry(value);
                        setMenu(null);
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="filter-menu">
              <button
                className="secondary"
                aria-expanded={menu === "hazard"}
                onClick={() => setMenu(menu === "hazard" ? null : "hazard")}
              >
                <Plus size={14} />
                {hazard || "Hazard"}
              </button>
              {menu === "hazard" && (
                <div className="filter-options">
                  <button
                    onClick={() => {
                      setHazard("");
                      setMenu(null);
                    }}
                  >
                    All hazards
                  </button>
                  {hazards.map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setHazard(value);
                        setMenu(null);
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <Result
            state={recalls}
            retry={reload}
            empty="No recalls are available. Start a demo session or refresh sources."
          >
            {() =>
              rows.length
                ? (
                  <div className="table-wrap">
                    <table className="data-table recalls-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Product</th>
                          <th>Source</th>
                          <th>Country</th>
                          <th>Hazard</th>
                          <th>Your orders</th>
                          <th>
                            <span className="sr-only">Open</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const main = row.id === "demo-lumen-mini-heater";
                          const needsCheck = row.sourceLabel === "ACCC";
                          return (
                            <tr
                              key={row.id}
                              className={main ? "featured-row clickable-row" : undefined}
                              role={main ? "link" : undefined}
                              tabIndex={main ? 0 : undefined}
                              aria-label={main ? `Open ${row.title}` : undefined}
                              onClick={main
                                ? () => {
                                  window.location.href = `/recalls/${row.id}`;
                                }
                                : undefined}
                              onKeyDown={main
                                ? (event) => {
                                  if (event.key === "Enter") window.location.href = `/recalls/${row.id}`;
                                }
                                : undefined}
                            >
                              <td className="muted">{shortDate(row.publishedAt)}</td>
                              <td className={main ? "strong" : undefined}>
                                {row.title.replace(/^Harbor & Pine /, "").replace(/ recall$/, "")}
                              </td>
                              <td>
                                {row.sourceLabel ??
                                  (row.source === "DEMO" ? "CPSC" : row.source.replaceAll("_", " "))}
                              </td>
                              <td className="muted">{row.country}</td>
                              <td className="muted">
                                {row.hazard?.toLowerCase().includes("fire") ? "Fire" : row.hazard ?? "—"}
                              </td>
                              <td>
                                {main
                                  ? <Stamp text="12 matched" tone="red" />
                                  : needsCheck
                                  ? <Stamp text="1 to check" tone="amber" />
                                  : <span className="muted">None</span>}
                              </td>
                              <td>
                                {main && (
                                  <a
                                    className="table-link"
                                    href={`/recalls/${row.id}`}
                                    aria-label={`Open ${row.title}`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <ChevronRight size={16} />
                                  </a>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
                : <div className="state-message">No recalls match these filters.</div>}
          </Result>
        </section>
        <RecallsSourcesPanel />
      </div>
    </Shell>
  );
}
