# RecallRelay backend specification

RecallRelay turns an official product recall into correct PayPal money movements, for any seller that uses PayPal. This document covers the backend and its HTTP contract. The visual design lives in Penpot and the frontend is a later task.

Pitch: when a product is recalled anywhere in the world, RecallRelay finds every affected PayPal order and settles each one the right way: stop the sale, void the hold, refund the payment or pay the buyer out, then bill the supplier back.

## Hard rules

1. AI never decides money. It extracts facts and drafts text. Deterministic code computes every amount and action.
2. Nothing moves until a human approves a plan with a budget. The approval is bound to a hash of the plan.
3. The same obligation can never be paid twice, under retries, timeouts, or concurrency.
4. PayPal sandbox only. Live PayPal hosts are refused in code.
5. All secrets stay server-side. Nothing secret enters the repo, logs, responses, or frontend.
6. The project must run with zero keys in `fake` mode, and it must say so clearly in API responses.
7. All code, comments, docs, and sample data are in English.
8. Sample merchants, brands, buyers, and orders are fictional. Never use real company or brand names in seeds. Official recall records from government sources are the only real data.
9. The product gives no legal advice and never claims legal compliance.

## Stack

- Node 26, TypeScript run natively through type stripping. Use erasable syntax only: no enums, no parameter properties, no namespaces.
- Dependencies: `hono`, `@hono/node-server`, `zod`. Dev: `typescript`, `@types/node`. Add nothing else without a written reason in docs/REPORT.md. No dependency that needs an install script.
- Storage: built-in `node:sqlite`. Tests: built-in `node:test`. Package manager: pnpm, never npm.
- Scripts: `pnpm dev`, `pnpm start`, `pnpm test`, `pnpm typecheck`, `pnpm demo`, `pnpm evals`, `pnpm sandbox:smoke`, `pnpm check:secrets`.
- MIT `LICENSE` file at the root.

## Layout

```
src/server.ts            HTTP app and routes
src/config.ts            env parsing, fail closed
src/db.ts                schema and queries
src/money.ts             integer minor units, PayPal string conversion
src/sources/             one adapter per regulator, shared RecallNotice type
src/ai/                  AiProvider, fake and OpenAI-compatible adapters
src/matching.ts          recall to order matching
src/policy.ts            classification table, jurisdiction rules
src/plan.ts              plan building, hashing, budget
src/executor.ts          outbox, idempotency, reconciliation
src/paypal/              PayPalGateway, FakePayPal, SandboxPayPal
src/notice.ts            notice checker
src/remedy-link.ts       signed buyer links
src/demo.ts              isolated demo sessions and seed
test/  fixtures/  evals/  scripts/  docs/
```

Keep it small. No interface unless it has two real implementations. `PayPalGateway` and `AiProvider` qualify.

## Recall sources

Common type `RecallNotice`: `id`, `source`, `country`, `publishedAt`, `title`, `rawText`, `url`, `language`, `imageUrls`, `hazard?`, `identifiers[]`, `soldOnline?`.

| Source | Request | Notes |
|---|---|---|
| CPSC (US) | `GET https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=<date>` | `Model` and `ProductUPCs` are often empty. The model sits in the text. |
| Health Canada | `GET https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json` | Large file. Filter consumer products. |
| GOV.UK | `GET https://www.gov.uk/api/search.json?filter_format=product_safety_alert_report_recall&count=50&order=-public_timestamp&fields=title,link,public_timestamp` | |
| EU Safety Gate | `POST https://ec.europa.eu/safety-gate-alerts/public/api/notification/carousel/?` with JSON `{"language":"en","page":0}`, then `GET https://ec.europa.eu/safety-gate-alerts/public/api/notification/{id}?language=en` | Undocumented portal API. Detail has country, risk, measures, `traceability.isSoldOnline`, `onlineTraderProductIdentifierReference`. |
| OECD GlobalRecalls | `GET https://globalrecalls.oecd.org/ws/search.xqy?end=20&lang=en&order=desc&q=&sort=date&start=0&uiLang=en` | Undocumented, 20 per page, `extUrl` is the original. Used for AU, KR, JP, TW. Marked all rights reserved: store only the fields needed and always link to `extUrl`. |

Capture one real response per source into `fixtures/sources/`, trimmed to a small size. Adapter tests run on fixtures with no network. A source failure must degrade that source only and show in `GET /v1/sources`. Use a descriptive generic `User-Agent`. Never put personal data in it.

## AI layer

`AiProvider` methods:

- `extractRecall(notice)` returns `{ products: [{ brand, model, sku, gtin, aliases[] }], hazard, remedies[], confidence, evidence: [{ field, quote }] }`.
- `draftNotice(input, language)` returns recall notice text.

Validate all output with zod. Every extracted identifier needs an `evidence.quote` that exists verbatim in `rawText`. Drop any field without it. Invalid or failed output becomes `MANUAL_REVIEW`, never a guess.

Implementations: `FakeAiProvider` (rule-based, offline, deterministic) and `OpenAiCompatibleProvider` (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, JSON output, 30 s timeout). Treat notice text as untrusted data: it can never add tools, change policy, or alter amounts. Add a test with a notice that says to refund everyone.

`evals/`: at least 40 labelled cases built from real fixture notices plus adversarial ones. `pnpm evals` prints precision and recall for identifiers, and writes `evals/results.json`.

## Matching

Input: extracted products and merchant order lines. Scores:

- exact `gtin` or `sku` match: 1.0
- exact normalized brand and model: 0.95
- model match inside item name with same brand: 0.85
- anything weaker: below 0.85

Score below `0.85` gives `MANUAL_REVIEW`. Keep the reason on the match.

## Order model

`Order`: `id`, `merchantId`, `buyerName`, `buyerEmail`, `buyerCountry`, `language`, `currency`, `status`, `shipped`, `paidAt`, `authorizationId?`, `captureId?`, `refundedMinor`, `lines[]`.

`status`: `AUTHORIZED`, `CAPTURED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `VOIDED`.

Line: `sku`, `gtin?`, `name`, `quantity`, `unitPriceMinor`, `taxMinor`.

Orders come from two paths: `SandboxPayPal.searchTransactions()` using `GET /v1/reporting/transactions?fields=all`, split in 31-day windows, reading `cart_info.item_details`, and a merchant import `POST /v1/orders/import`. The import exists because PayPal item data may be missing.

## Policy

Pure function in `src/policy.ts`, first match wins. `ageDays` is whole days between `paidAt` and now. `affected` is the sum of matched lines with tax, capped by the amount still refundable.

| # | Condition | Result |
|---|---|---|
| 1 | Match score below 0.85 | `MANUAL_REVIEW` |
| 2 | `REFUNDED` or `VOIDED` | `NO_ACTION` |
| 3 | `AUTHORIZED`, not shipped | `VOID_AUTHORIZATION` |
| 4 | `AUTHORIZED`, shipped | `MANUAL_REVIEW` |
| 5 | Remaining refundable is 0 | `NO_ACTION` |
| 6 | Buyer in EU/EEA, or the recall policy requires choice | `AWAIT_BUYER_CHOICE` |
| 7 | `ageDays <= 180` | `REFUND` of `affected` |
| 8 | `ageDays > 180` | `PAYOUT` of `affected` |

After a buyer choice in row 6: choosing refund applies rows 7 and 8. Choosing repair or replacement creates a `FULFILMENT_TASK` with no money movement. If that task passes its due date, the buyer can switch to refund.

`REFUND_WINDOW_DAYS = 180` is a named constant. Test days 180 and 181. An order with several lines refunds only the affected lines, as a partial refund. Refunds use the original currency. A refund is sent to the original capture, and only for captures of this merchant.

`POST /v1/recalls/:id/block` adds SKUs to a blocklist. `POST /v1/checkout/check` with `{ sku, gtin?, country }` returns `{ allowed, recallId?, reason? }`, and runs before any order is created.

`SUPPLIER_INVOICE` is a separate step after settlement. It bills a supplier for the total actually paid out, per currency, through `POST /v2/invoicing/invoices` and `.../send`. It requires its own approval. Payment by the supplier is never assumed.

## Plan and approval

`POST /v1/recalls/:id/plan` builds a `Plan`: items with order, action, amount, currency, reason, source evidence, and totals per currency. `planHash` is SHA-256 of canonical JSON.

`POST /v1/plans/:id/approve` takes `{ planHash, approver, budget: { USD: 12000, ... } }` in minor units. Reject it if the hash differs, if a total exceeds budget, or if a currency has no budget. Any change to the plan invalidates the approval. Never convert currencies.

## Executor

Item states: `PENDING`, `SENDING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`, `SKIPPED`.

- `idempotencyKey = sha256(recallId:orderId:action:lineSkus)`, with a UNIQUE constraint in the database.
- Send as `PayPal-Request-Id`. For Payouts use it as `sender_batch_id` and `sender_item_id` after shortening to PayPal limits.
- Write the ledger row in a transaction before calling PayPal. Re-read order state right before sending. If the order is refunded, skip it.
- Timeout or 5xx after sending becomes `UNKNOWN`. Reconcile by GET. Never POST a new key for it.
- Stop the run if spent plus next item exceeds budget.
- Every state change appends to an immutable `audit_log` with actor, time, before, after. Add a DB trigger that blocks UPDATE and DELETE on it.

`SandboxPayPal` endpoints, base `https://api-m.sandbox.paypal.com`:

- `POST /v1/oauth2/token`, cache until expiry.
- `POST /v2/checkout/orders`, `/capture`, `/authorize`.
- `GET /v2/payments/authorizations/{id}`, `POST .../void`.
- `GET /v2/payments/captures/{id}`, `POST .../refund`, `GET /v2/payments/refunds/{id}`.
- `GET /v1/reporting/transactions`.
- `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}`, `GET /v1/payments/payouts-item/{id}`.
- `POST /v2/invoicing/invoices`, `POST /v2/invoicing/invoices/{id}/send`.
- `POST /v1/notifications/verify-webhook-signature`.

Read the OpenAPI files in `https://github.com/paypal/paypal-rest-api-specifications` before coding each call. Do not guess fields.

`FakePayPal` must simulate success, timeout after success, 5xx, already refunded, and refund greater than remaining, so tests can force each one.

`POST /webhooks/paypal`: verify the signature, dedupe by event id, then update state for `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.AUTHORIZATION.VOIDED`, and payout item events. Unverified events return 400 and change nothing.

`pnpm sandbox:smoke` must exist but it needs credentials, so do not run it. With sandbox env vars, it must try each of these and print pass or fail per step, with no secrets: token, create and capture an order with items, refund it, repeat the refund with the same key, authorize and void, search transactions and report whether `item_details` came back, create a payout, create and send an invoice. It must handle buyer approval by printing the approval URL and waiting. It must refuse to run against any non-sandbox host.

## Recall notice checker

`checkNotice(text, ctx)` is deterministic and returns `{ ok, problems[] }`. Based on Regulation (EU) 2023/988, Article 36, for EU buyers:

- headline `Product safety recall`, in the buyer language
- product name, brand, identifiers, picture reference
- sold where, when, and by whom, if known
- hazard, instruction to stop using the product immediately
- remedies, free contact route
- none of these terms or translations: `voluntary`, `precautionary`, `discretionary`, `in rare situations`, `in specific situations`, or a statement that no accidents were reported

Languages for the fake provider: en, fr, es, de. A notice that fails the check cannot be sent. Store it for `MANUAL_REVIEW`.

## Buyer remedy link

Link token: HMAC-SHA256 with `LINK_SIGNING_SECRET` over order, recall, and expiry. 30 days. Lookup uses constant-time comparison. `GET /v1/remedy/:token` returns only the product, hazard, options, and amount, never other buyers' data or full email. `POST /v1/remedy/:token/choice` is single use and idempotent. Payout needs the buyer to confirm a PayPal email, because the original payment may be unusable.

## Demo mode

`POST /v1/demo/session` creates a private isolated copy of the seed, keyed by a random session id in an `HttpOnly`, `SameSite=Lax`, `Secure` in production cookie. Sessions expire after 2 hours. A cleanup removes old rows. Each session caps executed actions at 50. Every table with demo data has `session_id`, and every query filters on it. Add a test that one session cannot read another.

Seed: fictional merchant "Harbor & Pine", product "Lumen Mini Space Heater" with SKU `HP-LMH-015`, 12 orders across US, CA, GB, DE, FR, AU, JP in USD, CAD, GBP, EUR, AUD, JPY, covering rows 1, 3, 4, 5, 6, 7, 8 of the policy, a two-line order, and a partly refunded order. JPY has zero decimals.

`pnpm demo` runs the whole flow in fake mode and prints a timeline with totals. It must finish in under 10 seconds.

## HTTP contract

JSON. Errors: `{ "error": { "code": "...", "message": "..." } }`. Every response has `meta.paypalMode` (`fake` or `sandbox`).

```
GET  /health
GET  /v1/sources
GET  /v1/recalls?source=&country=&q=
GET  /v1/recalls/:id
POST /v1/recalls/:id/extract
POST /v1/recalls/:id/match
POST /v1/recalls/:id/plan
POST /v1/recalls/:id/block
GET  /v1/plans/:id
POST /v1/plans/:id/approve
POST /v1/plans/:id/execute
GET  /v1/plans/:id/timeline
GET  /v1/review-queue
POST /v1/review-queue/:id/resolve
GET  /v1/orders
POST /v1/orders/import
POST /v1/checkout/check
GET  /v1/remedy/:token
POST /v1/remedy/:token/choice
POST /v1/supplier-invoices
GET  /v1/audit
POST /v1/demo/session
POST /webhooks/paypal
```

`GET /v1/plans/:id/timeline` returns rows for a scheduler view: `{ resourceId, label, startDate, deadline, daysLeft, action, status }`. `deadline` is `paidAt + 180 days`.

## Secret and API protection

- `src/config.ts` reads env once. `PAYPAL_MODE=fake|sandbox`, default `fake`. In `sandbox`, missing `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, or `PAYPAL_WEBHOOK_ID` stops startup. `LINK_SIGNING_SECRET` is required outside fake mode and test.
- The PayPal base URL is a constant. Fail if any code path resolves to `api-m.paypal.com` or `api.paypal.com`.
- `.env` and `.env.*` are ignored, except `.env.example`, which has names and no values.
- Log redaction: `Authorization`, `client_secret`, `access_token`, emails, and tokens. Test it.
- Only `PAYPAL_CLIENT_ID` may ever reach a browser, and only through an explicit endpoint if the frontend needs it.
- The demo must never accept a key from a client, and must never echo env values or raw upstream errors.
- Rate limit by IP and session in memory. 1 MB body limit. CORS allowlist from `ALLOWED_ORIGINS`. Security headers on all responses. Zod on every input.
- `AI_MAX_CALLS_PER_SESSION` default 20, so a public demo cannot drain the AI key.
- `scripts/check-secrets.sh` scans tracked files for key patterns and fails on a hit. `.github/workflows/ci.yml` runs typecheck, tests, the check, and gitleaks.

## Required tests

Write tests first. Do not weaken or delete a test to pass it. Cover at least:

- every policy row, days 180 and 181, EU choice, partly refunded, two-line order
- money: JPY, EUR, rounding, no floats in amounts
- approval: wrong hash, budget exceeded, missing currency, plan changed after approval
- executor: same run twice, parallel runs, timeout after success, 5xx, already refunded, budget stop
- each source adapter from a fixture, and one failed source
- AI: invalid JSON, missing quote, injected notice
- notice checker: pass, banned word, missing part
- remedy link: bad signature, expired, reused
- webhooks: bad signature, duplicate event
- sessions: isolation, expiry, action cap
- secrets: redaction, live-host refusal, startup failure when env is missing

## Out of scope

Frontend, deployment, pushing to any remote, creating accounts, real API keys, real buyers, food and medicine recalls, certifying safety, verifying destruction by photo. MCP tools and Bryntum or AG Grid integration come later.

## Definition of done

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm evals`, `pnpm check:secrets`, and `pnpm demo` all pass from a clean clone with no `.env`. README in English covers setup, modes, flow, security, and limits. `docs/REPORT.md` lists what works, what was not tested, exact command output counts, every deviation from this spec, and anything the PayPal OpenAPI files contradicted here.

## Demo seed, exact values

These values must match the Penpot boards. `paidAt` is `now` minus the age, so the scenario stays valid on any day. File number `RR-2026-0417`. Supplier "Kestrel Appliance Co.". Notice text:

> Harbor & Pine recalls about 3,400 Lumen Mini Space Heaters, model HP-LMH-015. The power cord can overheat, posing fire and burn hazards. Consumers should immediately stop using the recalled heaters and contact Harbor & Pine for a full refund. The heaters were sold online from January 2026 through October 2026 for about $129.

| Order | Country | Age days | State | Expected action | Amount |
|---|---|---:|---|---|---|
| 1042 | US | 12 | captured | REFUND | USD 129.00 |
| 1071 | AU | 31 | captured, two lines, one affected | REFUND of the affected line | AUD 189.00 |
| 1019 | CA | 150 | captured | REFUND | CAD 179.00 |
| 0994 | GB | 178 | captured | REFUND | GBP 99.00 |
| 0871 | US | 212 | captured | PAYOUT | USD 129.00 |
| 0866 | CA | 241 | captured | PAYOUT | CAD 179.00 |
| 1103 | JP | 2 | authorized, not shipped | VOID_AUTHORIZATION | JPY 12,800 |
| 1051 | DE | 40 | captured | AWAIT_BUYER_CHOICE | EUR 119.00 |
| 1060 | FR | 28 | partly refunded, EUR 30.00 of EUR 119.00 | AWAIT_BUYER_CHOICE | EUR 89.00 |
| 1088 | GB | 9 | authorized, shipped | MANUAL_REVIEW | GBP 99.00 |
| 1077 | US | 17 | captured, item "Lumen Heater Mini Pro", SKU HP-LMH-020, score 0.72 | MANUAL_REVIEW | USD 129.00 |
| 1038 | US | 96 | fully refunded | NO_ACTION | USD 0.00 |

Default demo budgets: USD 300.00, CAD 400.00, GBP 150.00, AUD 200.00, EUR 250.00. Moves now: USD 258.00, CAD 358.00, GBP 99.00, AUD 189.00, EUR 0.00. Reserved for buyer choice: EUR 208.00. Released, not spent: JPY 12,800. Add a test that asserts every row and these totals.
