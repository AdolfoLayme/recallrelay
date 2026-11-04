# RecallRelay

RecallRelay turns product recall notices into reviewable settlement plans. The merchant dashboard follows the evidence from the official notice through blocked checkout, approval, execution, review, and buyer remedy. AI extracts facts and drafts text; policy code decides actions and amounts. A human must approve a plan hash and per-currency budget before the executor sends a money action.

## Setup

Requires Node 26 and pnpm 12. Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. No credentials are needed for fake mode. `pnpm demo` runs an isolated fictional 12-order scenario in memory and prints its timeline and totals. `pnpm start` serves the app and API on port 3000; `pnpm dev` watches code changes. The API reports `meta.paypalMode` on every response.

## Test the demo

Run `pnpm start`, open `http://localhost:3000`, and select **Start the demo**. In fake mode, open the recall file, read the notice, stop the sale, review the settlement plan, approve each currency budget, move the urgent order to the front, and run settlement. Review the two flagged orders and the buyer notice. The store shows that checkout is blocked after the sale stop. `pnpm test:e2e` runs this journey and the buyer remedy journey in an isolated headless browser and writes screenshots to `docs/design/actual/`.

For a real sandbox checkout, configure the server with PayPal sandbox credentials through the deployment environment and use a sandbox buyer account. Enter the buyer's **placeholder email** `<sandbox-buyer@example.test>` and **placeholder password** `<sandbox-buyer-password>` in PayPal's sandbox approval screen. The real test credentials belong only in private testing notes. Open `/store` before stopping the sale, pay for the Lumen Mini Space Heater, then follow the recall flow. The captured order should appear with a Real sandbox badge and its PayPal reference. Stop the sale and verify that `/store` blocks a second checkout before order creation. A human buyer must approve the checkout, so the automated suite uses an injected fake gateway for this path.

## Modes

`PAYPAL_MODE=fake` is the default. It uses deterministic fake AI and PayPal adapters and needs no keys. `PAYPAL_MODE=sandbox` requires `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and `LINK_SIGNING_SECRET` on the server. The sandbox gateway refuses any base URL other than `https://api-m.sandbox.paypal.com`. `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` select an OpenAI-compatible extractor; otherwise fake extraction is used. See `.env.example` for variable names only. Never put credentials in an HTTP request or source file.

`pnpm sandbox:smoke` is an interactive credentialed test. It requires `PAYPAL_MODE=sandbox`, the PayPal and signing variables above, and `SMOKE_PAYOUT_EMAIL` and `SMOKE_INVOICE_EMAIL`. It creates and captures an order, refunds with an idempotency retry, authorizes and voids another order, searches reporting transactions, creates a payout, and creates and sends an invoice. It prints PayPal sandbox buyer approval links and waits for you to approve each order. It prints a pass or fail for each attempted step. It cannot run in fake mode.

## Flow

Create a private demo session with `POST /v1/demo/session` and retain its `HttpOnly` cookie. `POST /v1/sources/refresh` fetches official notices into that session; `POST /v1/orders/sync` searches PayPal reporting transactions, imports complete sale records, and sends records without item details to review. `POST /v1/orders/import` accepts merchant-provided orders. Retrieve recalls, extract facts, match orders, build a plan, then approve its `planHash` and integer minor-unit budgets. Execute the plan and inspect its timeline and audit. Checkout checks a recall blocklist before order creation.

For an approved `AWAIT_BUYER_CHOICE` item, `POST /v1/remedy-links` takes `{ "planId": "...", "orderId": "..." }` and returns a signed link valid for 30 days. The buyer chooses refund, repair, or replacement through the link. A refund request becomes a refund within 180 days or a payout afterward; payout requires a confirmed PayPal email. Repair and replacement create a task due after 14 days, after which the link can switch to refund. `POST /v1/notices/send` drafts and checks a buyer notice before sending; failing drafts enter review. Fake mode simulates sending, while sandbox mode requires a configured sender. See `docs/SPEC.md` and `docs/REPORT.md` for the contract and current limits.

## Security and limits

The API limits bodies to 1 MB and requests by IP and session, applies security headers and an origin allowlist, and caps demo AI calls and money actions. Environment files are ignored; `pnpm check:secrets` scans nonignored worktree files and CI also runs gitleaks. Fake demo sessions expire after two hours. PayPal requests go only to the sandbox host.

Sandbox API actions require real sandbox credentials and buyer approval and are outside the offline browser suite. Recall matching can require human review; official source availability and transaction item details vary. The app does not provide legal advice or claim legal compliance. Read `docs/REPORT.md` for verified behavior and known gaps before using it with any real merchant data.
