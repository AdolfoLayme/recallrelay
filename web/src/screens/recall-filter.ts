import type { Recall } from "../api.ts";
import type { RecallTab } from "./RecallTabs.tsx";

export function filterRecalls(all: Recall[], search: string, country: string, hazard: string, tab: RecallTab): Recall[] {
  return all.filter((row) => {
    const rowHazard = row.hazard?.toLowerCase().includes("fire") ? "Fire" : row.hazard ?? "";
    const mine = row.identifiers.includes("HP-LMH-015");
    const action = mine || row.sourceLabel === "ACCC";
    return (!search || `${row.title} ${row.sourceLabel ?? row.source} ${row.identifiers.join(" ")}`.toLowerCase().includes(search.toLowerCase())) &&
      (!country || row.country === country) &&
      (!hazard || rowHazard === hazard) &&
      (tab === "All" || (tab === "My products" ? mine : action));
  });
}
