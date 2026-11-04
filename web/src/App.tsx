import { Start } from "./screens/Start.tsx";
import { Recalls } from "./screens/Recalls.tsx";
import { RecallFile } from "./screens/RecallFile.tsx";
import { PlanIndex } from "./screens/PlanIndex.tsx";
import { PlanPage } from "./screens/PlanPage.tsx";
import { RefundWindow } from "./screens/RefundWindow.tsx";
import { RunPage } from "./screens/RunPage.tsx";
import { ReviewPage } from "./screens/ReviewPage.tsx";
import { NoticePage } from "./screens/NoticePage.tsx";
import { BuyerPage } from "./screens/BuyerPage.tsx";
import { StorePage } from "./screens/StorePage.tsx";
import { AuditPage } from "./screens/AuditPage.tsx";
import { SourcesPage } from "./screens/SourcesPage.tsx";
import { Header } from "./ui.tsx";

export default function App() {
  const path = window.location.pathname;
  const parts = path.split("/").filter(Boolean);
  if (path === "/") return <Start />;
  if (path === "/recalls") return <Recalls />;
  if (parts[0] === "recalls" && parts[1]) return <RecallFile id={parts[1]} />;
  if (path === "/plans") return <PlanIndex />;
  if (parts[0] === "plans" && parts[1] && parts[2] === "window") return <RefundWindow id={parts[1]} />;
  if (parts[0] === "plans" && parts[1] && parts[2] === "run") return <RunPage id={parts[1]} />;
  if (parts[0] === "plans" && parts[1] && parts[2] === "notices") return <NoticePage id={parts[1]} />;
  if (parts[0] === "plans" && parts[1]) return <PlanPage id={parts[1]} />;
  if (path === "/review") return <ReviewPage />;
  if (parts[0] === "remedy" && parts[1]) return <BuyerPage token={parts[1]} />;
  if (path === "/store") return <StorePage />;
  if (path === "/audit") return <AuditPage />;
  if (path === "/sources") return <SourcesPage />;
  return (
    <div className="start-page">
      <Header title="File not found" summary="This page does not exist." />
      <a className="button primary" href="/">Go to start</a>
    </div>
  );
}
