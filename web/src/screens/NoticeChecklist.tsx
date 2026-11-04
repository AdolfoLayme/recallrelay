import { Check, CircleHelp, X } from "lucide-react";

const checks = [
  { label: "Recall headline in buyer language", matches: ["Missing product safety recall headline"] },
  { label: "Product, brand, and model", matches: ["Missing product name", "Missing brand", "Missing identifier", "Missing picture reference"] },
  { label: "Sold where, when, and by whom", matches: ["Missing sold where", "Missing sold when", "Missing sold by"] },
  { label: "Hazard stated plainly", matches: ["Missing hazard"] },
  { label: "Tells the buyer to stop using it", matches: ["Missing immediate stop-use instruction"] },
  { label: "Remedies listed", matches: ["Missing remedies"] },
  { label: "Free help route", matches: ["Missing contact route"] },
  { label: "No wording that softens the risk", matches: ["Contains banned risk-minimizing wording"] },
];

export function NoticeChecklist({ problems }: { problems?: string[] }) {
  return (
    <div className="check-list">
      {checks.map(({ label, matches }) => {
        const failed = problems?.some((problem) => matches.some((match) => problem.startsWith(match))) ?? false;
        const waiting = !problems;
        return (
          <div key={label}>
            <span className={failed ? "flagged" : undefined}>{label}</span>
            <span className={waiting ? "muted" : failed ? "red-text" : "green-text"}>
              {waiting ? <CircleHelp size={16} aria-hidden="true" /> : failed ? <X size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {waiting ? "Checking" : failed ? "Fix" : "Pass"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
