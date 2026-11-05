# RecallRelay

RecallRelay helps a PayPal merchant respond to a product recall. It connects an official notice to affected orders, blocks another sale, and prepares a settlement plan. A person approves the exact plan and a budget for each currency before any refund, authorization void, or payout is sent. AI extracts product facts and drafts buyer notices; deterministic code matches orders, chooses actions, and computes amounts.

**Demo video:** https://youtu.be/8U0CaLVPSB4

**Live demo:** https://recallrelay.onrender.com — a free Render service can take about a minute to wake after inactivity. It runs against the PayPal sandbox with simulated orders, labeled in the app: no real money moves.

## Judge walkthrough: under three minutes

1. Open the demo and select **Start the demo**. Open the Lumen Mini Space Heater recall. Read the official notice and select **Stop sale**.
2. Select **Review settlement plan**. Inspect the 12 fictional orders, the plan hash, and the separate currency budgets. Approve the plan and budgets.
3. Open **Refund window** and move the urgent order to the front. Open **Settlement run** and execute the approved plan. Inspect PayPal references, the review queue, and the supplier invoice approval. The simulated run settles seven actions: refunds, payouts, and an authorization void.
4. Open the buyer notice. Remove the flagged risk-softening sentence to pass the checker. Visit the store to see checkout blocked for the recalled product. The buyer remedy link also demonstrates a signed choice and settlement.

The fake demo's money totals are USD 258, CAD 358, GBP 99, and AUD 189 moved; EUR 208 reserved for buyer choice; and a JPY 12,800 authorization released. These are fictional sandbox-style examples, not customer transactions.

## Run locally

Requires Node 26 and pnpm 12. In a clean checkout:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm evals
pnpm demo
pnpm start
```

Open `http://localhost:3000`. No credentials are needed; `PAYPAL_MODE=fake` is the default. `pnpm test:e2e` runs the browser journey in an isolated headless profile. If your checkout path is long, copy it to a short path before running the browser test because the browser's socket path has a length limit.

## PayPal and AI

| Capability | Use in RecallRelay |
|---|---|
| Orders API and JavaScript checkout SDK | Create and capture a sandbox checkout order; check the recall blocklist before order creation. |
| Transaction Search | Import merchant transactions when item details are available; incomplete records enter human review. |
| Payments API | Refund captures and void authorizations. |
| Payouts API | Pay an eligible buyer when a capture can no longer be refunded; confirm the payout item outcome. |
| Invoicing API | Create and send a supplier reimbursement invoice only after a separate approval bound to the plan hash and settled amount. |
| Webhook signature verification | Verify PayPal events, deduplicate them, and reconcile the corresponding action against PayPal before recording success. |

The optional OpenAI-compatible provider extracts product identifiers with verbatim evidence from a notice and drafts buyer text. A deterministic fake provider supports the keyless demo. Invalid or unsupported extraction goes to review. The AI cannot approve a plan, set a budget, choose a payment action, or compute an amount.

## Architecture and safety

The Node/TypeScript server exposes a Hono JSON API and serves a React dashboard. SQLite stores private demo sessions, orders, plans, approvals, an outbox, buyer choices, and an immutable audit log. The policy and money modules use integer minor units, with no currency conversion. An outbox row is reserved before a PayPal call and carries a stable idempotency key; uncertain outcomes stay `UNKNOWN` until a PayPal read confirms them. If a refund times out without returning its PayPal ID, it stays open for manual review because a capture's aggregate refunded amount cannot identify that refund. Signed buyer links expire after 30 days. Demo sessions expire after two hours and cap money sends and AI calls. PayPal's live host is refused; sandbox credentials stay on the server.

## Honest limits

The automated test suite uses fake PayPal and fake AI. The hosted demo runs in PayPal sandbox mode with simulated orders. A real sandbox purchase in `/store` needs a PayPal sandbox buyer and is outside the offline browser suite; a purchase and its refund were run on the hosted demo on Nov 5, 2026, with sandbox capture `71548971N7998571T` and refund `2CF057992G592873B`. PayPal Transaction Search item detail availability varies; it returned item codes for this sandbox account after the app was granted access. Some recall matches require human review. The fake notice writer is only partly localized for arbitrary products. This prototype gives no legal advice and does not claim compliance. See [the implementation report](docs/REPORT.md) and [backend specification](docs/SPEC.md) for the detailed contract and verified limits.

MIT licensed; see [LICENSE](LICENSE).
