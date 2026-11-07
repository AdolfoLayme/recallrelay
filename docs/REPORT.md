# RecallRelay implementation report — 2026-11-04

## What changed

The frontend now follows the case-file layout in `docs/design/`: a fixed 216 px desktop rail, the specified type and colour palette, square controls, aligned tables and stamps, a single-wordmark start cover, and 390 × 844 buyer screens. `App.tsx` is a route dispatcher; screens live in `web/src/screens/`. `web/src/styles.css` uses named palette variables and readable declarations. The recall file, plan, refund window, run, review, notice, checkout, buyer, source, audit, and plan-index routes use the existing API. The store calls `POST /v1/checkout/check` before mounting a sandbox PayPal button and the server also checks the SKU before creating an order.

`pnpm design:diff` builds and runs the isolated fake-mode merchant and buyer journey, captures the boards at their stated sizes, prints ImageMagick normalized RMSE, and writes each reference/actual pair to `docs/design/diff/`. The same journey checks the twelve plan rows, execution order, five budgets and moves, EUR reserve, JPY void, two initial review cases, notice warning and correction, checkout blocking, and the buyer refund without a merchant cookie. The end-to-end harness uses a new temporary browser profile and an ephemeral HTTP port. It does not connect to a user's browser or port 9223. `pnpm test` also builds first because its static-serving test needs the current `web/dist` assets; a deliberately overlapping build and test briefly produced a 404, then the sequential command passed.

The demo seed now supplies source display names and order, two initial review cases, the board's plan ordering and budget increments, a German example notice, and the notice's 0.96 confidence. Fake mode replays the board's 3 Nov 2026 reference date for order ages and the refund chart; session expiry still uses actual time. The notice checker accepts factual German phrasing while still rejecting a missing hazard, remedy, or the risk-softening sentence. A sandbox capture lookup now exposes `payee.merchant_id`; an unknown refund reconciles only when the capture payee matches the order's merchant. Tests cover both a missing payee and a matching one. `render.yaml` defines one Render web service with a health check and no auto deploy. The README includes a fake and sandbox demo walkthrough with placeholders only.

## Continuation fixes in this run

The plan table now uses the demo recall's `demoAsOf` time instead of the live clock. A new end-to-end assertion first failed on the old 13-day age, then passed at 12 days with the correct two-day refund deadline. The plan response itself remains unchanged; the screen loads the reference time and demo copy from the recall endpoint. The buyer notice also reads its product, warning, help text and available remedy options from the API, with board-specific content in the seed. The screenshot harness moves its pointer away before captures so hover colour does not contaminate a board comparison.

The demo-specific recall, plan, review, supplier and buyer copy now lives in the seed; those screens read it from the API. The Audit page presents short summaries with expandable raw records. A new HTTP test reproduced the shared rate-limit failure before the per-session fix; separate tests now cover CORS and the AI-call cap. Safety-critical writes now add audit entries, and unexpected server errors log redacted metadata.

The Bryntum trial install was retried with an in-repo pnpm store and `--ignore-scripts`. It failed before installation with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` and a read-only `pnpm-store-operation-locks` location, so the React scheduler fallback remains. No licence text became available. Impeccable's manual detector returned `[]` on the changed UI files. The final verification below includes a fresh isolated-profile end-to-end run under `env -i`; no user browser or port 9223 was used.

## Commands observed in this checkout

| Command | Result in this run |
|---|---|
| `pnpm typecheck` | Exit 0; root and web TypeScript checks. |
| `pnpm install --frozen-lockfile --ignore-scripts` | Blocked before installation by `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` with an in-repo store. |
| `pnpm test` | 79 tests passed, 0 failed. |
| `pnpm build` | Exit 0; Vite built 40 modules. |
| `pnpm test:e2e` | Exit 0; 7 settled fake actions and 16 screenshots. It also passed under `env -i` with HOME and XDG paths inside this repo. |
| `pnpm design:diff` | Exit 0; all 11 board pairs compared. |
| `pnpm evals` | 40 cases; identifier precision 1.000 and recall 0.538. |
| `pnpm check:secrets` | Passed; 136 files checked. The ignored `.env` was not opened. `git check-ignore -v .env` confirmed that the scanner excludes it. |
| `pnpm demo` | Exit 0; budgets USD 300, CAD 400, GBP 150, AUD 200, EUR 250; moved USD 258, CAD 358, GBP 99, AUD 189; reserved EUR 208; released JPY 12,800. |
| `pnpm start` | A process started with an explicit fake-mode environment; `/health`, `/`, and the built JS asset each returned HTTP 200. The process was stopped afterward. |

A frozen pnpm install with scripts disabled and an in-repo store was attempted in this run; it failed before dependency resolution with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` at `pnpm-store-operation-locks` (read-only file system). A clean-copy install is therefore not verified in this environment. The real sandbox checkout and refund path was not exercised here: it needs interactive buyer approval and credentials, and no command was run that loads `.env`.

## Board-by-board visual review

The values below are normalized RMSE from the final `pnpm design:diff`. Both sides of every generated pair were opened and inspected. RMSE includes text rasterization and dynamic content, so it is not a pass threshold.

| Board | RMSE | Result and remaining visible difference |
|---|---:|---|
| 01 Recalls | 0.103484 | Rail, filter controls, first-row fill, source panel and amber ACCC state match the structure. There is no “Read today” label, per the correction brief. Font rasterization and small spacing remain different. |
| 02 Recall file | 0.157848 | Red heading, 520 × 540 notice panel, red evidence emphasis, confidence, extraction rows, counts and sale-block state are present. The notice paragraphs now align more closely; font rasterization and a few pixels of wrapping still differ. The brief's corrected “11 exact matches … 2 orders go to review” is shown. |
| 03 Settlement plan | 0.133102 | Twelve rows, seeded ages, the two-day deadline, order, action colours, review and void amounts, five moves and budgets match the specified data. The plan hash is generated per session, so its characters differ; the required simulated-order note adds a line below the table. |
| 04 Refund window | 0.104436 | Eight bars, 3 Nov today line, label clearance and suggestion panel are present. The chart range was extended four days to bring later bars and the today line closer to the board. Small type and bar offsets remain. A navigation link sits below the suggestion panel. |
| 05 Settlement run | 0.107415 | Seven rows, action order, void amount and supplier panel align. The fake gateway finishes 7/7, while the board shows one `Checking` and 6/7. The board uses example sandbox IDs; this run generates fake IDs. CAD is consequently settled and listed for invoicing here, whereas the board waits for CAD. These reflect actual run state, not a static illustrated state. |
| 06 Review queue | 0.108015 | Two cases, comparison table, 17 Oct date, action buttons and audit warning are present. The table header height was corrected; small type and column spacing differences remain. |
| 07 Buyer notice | 0.134688 | German/French tabs, the board's German example, one flagged sentence in bold red, eight checks and blocked send button work; removing the sentence rechecks to all-pass, and sending to both buyers succeeds in the fake journey. Type rasterization, paragraph wraps and small vertical gaps remain different. |
| 08 Buyer notice | 0.160237 | Mobile header, warning, product, 24 Sep paid date and fixed-width action match the layout. Font metrics and several vertical gaps differ slightly. |
| 09 Remedy choice | 0.169255 | Choice cards, radio states, copy and action position match the structure. Card borders and type rasterization differ slightly. The captured primary button now has its normal ink fill; the earlier hover tint came from Playwright leaving the pointer on it. |
| 10 Remedy confirmed | 0.156663 | Amount box, safety copy and confirmation control match the layout. The fake refund ID necessarily differs from the example PayPal reference; typography and vertical spacing differ slightly. |
| 11 Checkout blocked | 0.127210 | The corrected 108 px red box, disabled payment button and “No order was created” state are present. The old reference image still has the taller box; current actual follows the written correction. |

The start cover was checked separately at 1440 × 900. It has one visible wordmark, a short introduction, and the ruled four-step sample sheet. Store, Sources, Audit, and Plans index were also captured and opened; they share the shell or buyer layout. Source names are human-readable and ordered; the plan index shows its true approval state. The audit page now shows concise event summaries in the same ruled table and keeps complete JSON inside expandable details.

## Accessibility and interaction check

Form inputs on the buyer choice and notice editor have labels, status is conveyed with words, and the notice preview can enter edit mode with Enter or Space. Focus has a 3 px blue outline and reduced-motion users receive the stylesheet's reduced-motion rule. Keyboard order follows the document order. The used foreground/background pairs were calculated in this run: ink/paper 16.47:1, muted/paper 6.53:1, red/paper 5.44:1, green/green fill 5.66:1, amber/amber fill 5.50:1, and ink/sheet 18.10:1. This is a manual check, not a full automated accessibility audit.

## Dependencies, deployment, and PayPal

The requested Bryntum alias was attempted earlier and again in this run with `pnpm add @bryntum/scheduler@npm:@bryntum/scheduler-trial --ignore-scripts`, including repository-local pnpm store and XDG settings. Every attempt failed before installation with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` and “Failed to open the store operation lock at pnpm-store-operation-locks: Read-only file system (os error 30).” No Bryntum package or licence text was available to inspect. Board 04 therefore uses the permitted plain React scheduler fallback. No install scripts were approved.

The store's sandbox integration follows PayPal's [JavaScript SDK v6 checkout quick start](https://developer.paypal.com/checkout/integrate): eligible methods, a one-time payment session, a server-created order, and server capture. Fake mode deliberately shows no live payment button. The real store route is covered by injected gateway tests, but was not run against PayPal in this session. `render.yaml` was added and not deployed. Its fields were checked against the [Render Blueprint spec](https://render.com/docs/blueprint-spec) and [health-check documentation](https://render.com/docs/health-checks); no local YAML parser was available.

A human-side sandbox run documented on 2026-11-03 had passed OAuth, an order and capture, partial refund idempotency, authorization void, payout to a registered account, an unclaimed payout to an unregistered address, and invoice send. Transaction Search returned 403 `NOT_AUTHORIZED`. That run was historical and was not repeated here. The implementation now checks refund amount, polls payout-item outcomes, exposes `RECEIVER_UNREGISTERED`, and treats `PAYPAL_WEBHOOK_ID=pending` as webhooks unavailable. [PayPal's capture definition](https://developer.paypal.com/sdk/payment/v2/definitions/capture/) documents the payee field used for the added reconciliation check.

## Remaining limits

- The real sandbox flow needs a PayPal sandbox buyer to approve the payment. A purchase and its refund were run on the hosted demo on Nov 5, 2026. Transaction Search returned 403 until the app was granted access; it now answers 200 and returned item codes for this sandbox account. The order import's merchant ID is supplied by its caller. Capture status alone does not reveal every partial-refund total, so uncertain reconciliation stays `UNKNOWN` for review.
- The demo German notice matches the board's prose, but the general fake drafting provider still has only partial localization for arbitrary products. A fully localized source-backed draft and validation for other cases need separate work.
- Audit records now cover extraction, matching, sale blocking, plan creation, approvals, imports, notice delivery, review, buyer choices, order changes, invoices, and outbox transitions. Some maintenance mutations still lack a dedicated record. Authenticated sessions now have separate rate-limit buckets; public requests still use one conservative local bucket because no trusted proxy address is configured. CORS, AI-call cap, and rate-limit policies have direct HTTP tests. Unexpected request errors are logged centrally as redacted metadata. Supplier invoice approval is separately persisted and bound to the plan hash and settled amount.
- Expired demo sessions keep data while active remedy links or immutable audit records require it. The idempotency key includes the session ID so isolated demo sessions can reuse fictional order numbers. The 40 evaluation cases are correlated fixtures and synthetic adversarial text, not production estimates. OECD retention and terms review remains open.

No commit, push, remote, deployment, or real-money action was made.

## Commercial redesign

The rejected case-file presentation was replaced with a white payments dashboard: Inter, one Lucide icon set, cool neutral surfaces, indigo actions, semantic status fills, compact tables, a 232 px merchant rail, and a 28 px sandbox strip. The Recalls search, tabs, and country/hazard menus work; the plan keeps budgets by currency and the refund timeline marks urgent work. Buyer pages now use a hosted-checkout layout with a clear hazard alert, radio-card remedies, and a key/value confirmation receipt. The start screen uses a cropped capture of the real Recalls route at `web/public/recalls-preview.png`. All routes and the existing financial decisions remain intact. The old `design:diff` target and script were removed; `web/e2e.ts` now captures the store and 768 px Recalls view as well.

All 17 current capture files in `docs/design/actual/` were opened in two inspection rounds. The first round led to fixes for the 768 px table, whole-row recall navigation, buyer receipt and placeholder, preview crop, and notice checklist status; the second showed those changes in place. `pnpm typecheck`, `pnpm test` (79 passed), `pnpm build`, `pnpm test:e2e` (7 settled actions and 18 capture operations), `pnpm evals` (40 cases), `pnpm check:secrets` (145 files), and `pnpm demo` passed. The Impeccable detector reported the brief-mandated Inter font and minor shape/type-scale advisories; it found no new unpinned visual direction to adopt. The real PayPal sandbox journey and localization limits described above remain unverified or unresolved in this run. No `.env` file was opened or loaded.

## Money audit and submission update — 2026-11-05

The audit corrected cross-plan budget accounting, duplicate settlement through another recall or another imported order ID for the same PayPal capture, and a missing capture ownership and amount check before sandbox refunds. Sandbox imports now retain their gateway and reject captures whose merchant, currency, or gross amount differs from the imported order. A failed capture read before a refund does not consume an outbox obligation. Completed refunds update the order and outbox in one transaction, including after a verified webhook; an unrelated external refund cannot confirm an unknown obligation. Invoice creation, send, and uncertain results now leave an audit entry for each state transition. An uncertain invoice cannot be created again through the approval.

The README and `docs/submission/` contain the English judge walkthrough, Devpost copy, and a 166-second silent video script. `DEMO_URL_PENDING` remains until a hosted URL exists. From a short copy at `/home/adolfo/.cache/rrc.yaqUZd`, with `PAYPAL_MODE=fake` and no `.env` loaded, `pnpm typecheck` passed, `pnpm test` passed 88/88, `pnpm evals` ran 40 cases (identifier precision 1.000; recall 0.538), `pnpm demo` passed with the specified USD 258, CAD 358, GBP 99, AUD 189 moved, EUR 208 reserved, and JPY 12,800 released, and `pnpm test:e2e` passed with seven settled actions and 18 screenshots.

A refund whose PayPal ID was lost after a timeout remains `UNKNOWN` for manual review. A capture's aggregate refunded amount cannot prove which refund caused it, so the executor will not infer success from that amount or repost with a new key. A real PayPal sandbox run, hosted demo URL, and recorded video were not part of this offline audit.
