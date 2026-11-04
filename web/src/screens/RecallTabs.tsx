export type RecallTab = "All" | "My products" | "Needs action";

export function RecallTabs({ value, onChange }: { value: RecallTab; onChange: (tab: RecallTab) => void }) {
  return (
    <div className="recall-tabs" role="tablist" aria-label="Recall views">
      {(["All", "My products", "Needs action"] as const).map((tab) => (
        <button key={tab} role="tab" aria-selected={value === tab} onClick={() => onChange(tab)}>{tab}</button>
      ))}
    </div>
  );
}
