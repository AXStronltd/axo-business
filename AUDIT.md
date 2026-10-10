# Axo Business — Codebase Audit

**Date:** 2026-10-10 · **Scope:** this repository only (`frontend/`, `backend/`) · **Baseline:** commit `77503fc` plus the uncommitted work in the tree at audit time.

The audit was done by reading the code, not the README. "Implemented" means the code path exists and was read end to end. "Tested" means an automated test exercises it. Unit tests over pure helpers do not count as testing the HTTP route or the database path.

## Status legend

| # | Meaning |
|---|---|
| **1** | Implemented and tested (HTTP + database, or a meaningful service test) |
| **2** | Implemented but not fully verified (code exists; only pure helpers are tested, or no test) |
| **3** | Partially implemented |
| **4** | Demo/mock only |
| **5** | Missing |
| **6** | Blocked by an external dependency (provider, contract, credentials, licence) |

## Baseline build health (at audit start)

| Check | Result |
|---|---|
| `npm run typecheck` | **Failed.** 9 errors in `src/modules/whatsapp/whatsapp.routes.ts` |
| `npm run build` | **Failed** (same errors) |
| `npm test` | 165 / 165 passed (18 files). Only `test/c2m.e2e.test.ts` (10 tests) hits HTTP + Postgres; the other 155 test pure functions or mocks. |
| Migrations | One migration, `prisma/migrations/20261010174024_init` (uncommitted) |
| CI / Dockerfile / monitoring | None in the repo |

The typecheck errors hid a real bug. A customer who replied to a WhatsApp payment prompt with a bare PIN (`1234`) was routed to the OTP handler and told "That code is not right", so PIN-confirmed WhatsApp payments could not complete. This is fixed (see §4).

## 1. Critical security and financial-correctness findings

These outrank every feature gap. Each one either lets money move without the owner's consent or makes the ledger wrong.

| ID | Finding | Where | Impact |
|---|---|---|---|
| **S1** | **Pay, then reverse.** `REVERSE` on WhatsApp (and `POST /transfers/:id/reverse`) reverses the customer's last completed send. For a merchant payment, that send is the wallet → `@axo_clearing_*` leg. The reversal refunds the customer from the clearing wallet, but the merchant ledger keeps the credit. | `p2p/reversal.service.ts`, `whatsapp.routes.ts` (`reverse_txn`) | The customer gets the goods *and* the money back. Clearing goes out of balance. |
| **S2** | **Staff tokens move any customer's money.** Several routes take `customerId`/`senderId`/`byCustomerId` from the request body under any merchant token: `POST /payments/customer` (any cashier can debit any wallet into their own business), `/transfers/to-phone`, `/transfers/:id/reverse`, `/cash/in`, `/cash/out` (withdraw anyone's wallet to any destination), `/collect/scan`, `/claims/:code/claim-by-identity`, `/claims/repoint`, `/claims/:code/recall`, `/agents/:code/cash-in` and `/agents/:code/cash-out`. | `p2p/p2p.routes.ts`, `p2p/extras.routes.ts`, `cash/cash.routes.ts`, `collect/collect.routes.ts`, `agent/agent.routes.ts` | Theft of customer funds by any merchant staff account. |
| **S3** | **Money minting via agents.** Any merchant owner can `POST /agents` to create an agent and `POST /agents/:code/float` to top up its float with no funding source, then cash that float into any wallet. Agents have no identity or auth of their own. | `agent/agent.routes.ts`, `agent/agent.service.ts` | Unbacked money enters the network. |
| **S4** | **Forgeable payment webhooks in live.** `/webhooks/:provider` with `axo` or `sandbox` verifies against a hard-coded secret (`'sandbox-webhook-secret'`), and `axo` is mapped to the sandbox provider in every environment. The handler also verifies a re-serialised body, not the raw bytes. | `providers/sandbox.ts`, `payments/payments.service.ts`, `payments/payments.routes.ts` | Anyone can confirm any pending charge and credit a merchant with money that never arrived. |
| **S5** | **Unauthenticated push approval.** `POST /collect/push/:ref/approve` has no auth and no PIN. Refs come from `Math.random()`. On WhatsApp, `YES` approves a push without the PIN even when one is set. | `collect/collect.routes.ts`, `collect/collect.lib.ts`, `whatsapp.routes.ts` | Charging a customer without their consent. |
| **S6** | **Refunds are repeatable and never reach the customer.** `refundPayment` leaves the original `confirmed`, so it can be refunded again with each new idempotency key. For Axo-wallet payments it debits the merchant but never credits the customer wallet. | `payouts/payouts.service.ts` | Merchant over-refunds; the customer is never repaid. |
| **S7** | **Live mode boots with dev secrets.** `JWT_SECRET`, `JWT_REFRESH_SECRET`, `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` silently fall back to public defaults even when `APP_ENV=live`. | `config/env.ts` | Forged staff/customer tokens and forged WhatsApp webhooks. |
| **S8** | **Idempotency keys are global, not per merchant.** A key chosen by merchant A replays merchant B's stored response. | `middleware/idempotency.ts` | Cross-tenant data leak; the request is wrongly skipped. |
| **S9** | **Fake biller in the money path.** `buyBiller` debits the real wallet and returns a *randomly generated* electricity token. No biller provider is integrated. | `billers/billers.service.ts` | In live, customers pay for tokens that don't exist. |
| **S10** | **`payMerchant` skips risk screening** (the docstring says it doesn't), and its merchant `Transaction` is not linked to the customer transfer. An idempotent replay therefore can't return the merchant transaction id. | `p2p/p2p.service.ts` | Merchant payments bypass fraud and limit controls; receipts can't be traced across ledgers. |

## 2. Feature matrix

### 2.1 Merchant onboarding, identity and access

| Capability | Status | Evidence |
|---|---|---|
| Business sign-up (merchant + owner + ledger accounts) | 1 | `POST /merchants` (`merchants/merchants.routes.ts`); exercised in `test/c2m.e2e.test.ts` |
| Merchant login / refresh (JWT, argon2id) | 1 | `auth/auth.routes.ts`; e2e test |
| Refresh / customer tokens refused on staff routes | 1 | `middleware/auth.ts` `requireAuth` `typ` check; e2e test "refuses a customer token on a merchant route…" |
| Roles owner / manager / cashier / accountant | 2 | `requireRole` used per route; only cashier-can't-issue-Till is tested |
| Staff invites / user management API | 5 | No route creates a non-owner user (e2e test inserts the cashier directly) |
| KYB verification | 3 | `Merchant.kybTier/kybStatus` fields exist; nothing sets or enforces them. Needs a KYB provider (6) |
| MFA | 5 | `User.mfaEnabled` column only |
| Audit log | 3 | `AuditLog` model exists; nothing writes to it |

### 2.2 Merchant identifiers, QR, payment requests

| Capability | Status | Evidence |
|---|---|---|
| Till / Paybill / Pay-ID issuance (owner only) | 1 | `POST /paynumbers` (`merchants/paynumbers.routes.ts`); e2e "issues a Till… owner only" |
| Paybill account lines | 2 | `POST /paynumbers/:id/lines`; no test |
| Number bands overlap (till 100000–999999 contains the paybill/payid bands) | 3 | Uniqueness is per `(kind, number)`, so the same digits can be a Till of one business and a Paybill of another |
| QR payload encode/parse | 1 (lib) / 2 (route) | `collect/collect.lib.ts`; `test/collect.test.ts`. `GET /collect/qr` untested |
| QR scan → pay | 3 | `/collect/scan` takes `customerId` from the body (S2) |
| Payment request tied to a **sale reference** | 5 | Nothing links a payment to a merchant's sale/order id |
| STK-style push to a customer | 3 | `collect/collect.service.ts` `pushPrompt`/`approvePush`; approval unauthenticated (S5); no route tests |
| Payment links (`axo.money/pay/…`) | 4 | Frontend-only random slugs; no backend link resolution |

### 2.3 Customer → merchant payment (the core flow)

| Capability | Status | Evidence |
|---|---|---|
| Customer login with PIN (argon2id, lock after 5 failures) | 1 | `POST /customer/auth/login` (`customer/customer.routes.ts`), `p2p/pin.service.ts`; e2e |
| Resolve Till/Paybill → business name before paying | 1 | `POST /customer/pay-numbers/resolve`; e2e |
| Pay by Till/Paybill from the authenticated wallet with PIN + Idempotency-Key | 1 | `POST /customer/payments/by-number` → `payByNumber` → `payMerchant`; e2e asserts both ledgers balance and clearing legs net to zero |
| Idempotent replay (no second charge) | 1 | e2e "replaying the same Idempotency-Key…" |
| Insufficient funds leaves balances untouched | 1 | e2e |
| Pay over WhatsApp (`PAY TILL …` → PIN) | 2 | `whatsapp.routes.ts`; PIN step was broken until this audit; only the intent parser is tested |
| First-contact pay (unregistered WhatsApp number) | 3 | `startPayOnboarding` hard-codes `KES` and doesn't convert to minor units (`parseFloat(amount) * 1`) |
| Risk screening on merchant payments | 5 | S10 |
| Merchant fee / MDR | 5 | Merchant payments post `feeMinor: 0`; there is no fee schedule |
| Merchant notification of a payment | 5 | Customer gets a WhatsApp reply; the merchant gets nothing (no WhatsApp, no webhook, no push) |
| Business dashboard shows the payment | 3 | API `GET /transactions?since=` works (e2e); **the Hub frontend never calls it** (see 2.9). *Since fixed — see §5.* |

### 2.4 Ledger, idempotency, webhooks

| Capability | Status | Evidence |
|---|---|---|
| Double-entry merchant ledger (debits = credits, cached balance in the same tx) | 1 | `ledger/ledger.service.ts`; `test/ledger.test.ts` (mocked) + e2e |
| Customer ledger (same invariant) | 1 | `postCustomerLedger` in `p2p/p2p.service.ts`; e2e |
| Serializable DB transactions for money moves | 2 | `db/client.ts` `inTransaction`; no concurrency test |
| Idempotency-Key middleware | 3 | `middleware/idempotency.ts`; global key space (S8); not atomic (check then insert) |
| Provider webhook verification | 3 | Sandbox HMAC with a hard-coded secret (S4); the M-Pesa adapter models a shared-secret HMAC; WhatsApp HMAC is correct (`whatsapp.lib.ts`, tested) |
| Webhook event de-dup | 2 | `WebhookEvent` table; `claimWebhookEvent` / `claimEvent` |
| Reconciliation of merchant ↔ customer clearing | 5 | The e2e test checks it for one payment; no runtime job or report |

### 2.5 Refunds, reversals, disputes

| Capability | Status | Evidence |
|---|---|---|
| Merchant refund of a payment | 3 | `POST /transactions/:id/refund`: repeatable, never credits the customer (S6) |
| Customer self-reversal of a P2P send (10-minute window) | 3 | `reversal.service.ts`; also reverses merchant payments (S1) |
| Business pays a customer (refund-to-wallet, payout) | 2 | `POST /payments/to-customer` → `businessPayCustomer`; no route test |
| Disputes | 4 | Frontend `openDispute` only; no backend model |

### 2.6 Funding, withdrawals, settlement

| Capability | Status | Evidence |
|---|---|---|
| Ramp interface (cash-in/out, pending → webhook-confirmed) | 2 | `providers/ramp.ts`, `cash/cash.service.ts`; `test/ramp.test.ts` covers the sandbox adapter |
| Sandbox ramp | 1 (sandbox only) | `providers/ramp.sandbox.ts`; not registered in live |
| M-Pesa ramp | 6 | `providers/ramp.mpesa.ts` throws "not implemented" by design; needs Daraja credentials and a Safaricom agreement. (Using M-Pesa as a funding rail is allowed by the brief; making it the *foundation* is not.) |
| Crypto ramp | 6 | `providers/ramp.crypto.ts`; needs a custody/VASP partner |
| Agent cash-in/out network | 3 | Ledger logic tested (`test/agent.test.ts`); auth model unsafe (S2, S3) |
| Merchant payouts (maker-checker) | 2 | `payouts.service.ts`; sandbox provider only, so live is (6) |
| Bulk / payroll batches | 2 | `batches/*`; CSV parsing tested only |
| Provider settlement-file import + matching | 1 (matcher) / 2 (import) | `reconciliation.service.ts` `reconcile`; `test/reconciliation.test.ts` |
| Daily settlement report (gross, fees, refunds, net, status) | 5 | — |
| Airtime / bills | 4 | S9; needs biller aggregator (6) |

### 2.7 Tills, cashiers, branches, POS

| Capability | Status | Evidence |
|---|---|---|
| Branches | 4 | Frontend `openAddBranch` only; no backend model |
| Cashier shifts / till sessions | 4 | Frontend `openShift` only |
| Cashier scoped to a branch/till | 5 | Roles are merchant-wide |
| POS API (create request, poll status) | 5 | No API keys for machines; only staff JWTs |
| Outbound merchant webhooks (signed, retried) | 5 | — |
| API docs (OpenAPI) | 5 | — |

### 2.8 WhatsApp

| Capability | Status | Evidence |
|---|---|---|
| Webhook handshake + HMAC verification + event de-dup | 1 | `whatsapp.lib.ts`; `test/whatsapp.test.ts` |
| Intent parser (send, pay till/bill, request, claim, …) | 1 | `test/whatsapp.test.ts`, `test/chat.test.ts` |
| Router (state machine) | 2 | `whatsapp.routes.ts` `routeMessage` has no tests; it was the source of the PIN bug |
| Outbound sender | 2 | `whatsapp.sender.ts`; becomes available with `WHATSAPP_TOKEN` (6 for live: Meta Business verification + templates) |
| Send-to-unregistered + claim | 2 | `claim.service.ts`; service-tested with mocks |
| Merchant-side WhatsApp notifications | 5 | — |

### 2.9 Frontend (Business Hub, `frontend/index.html`)

| Capability | Status | Evidence |
|---|---|---|
| Every Hub screen (sales, collect, invoices, payroll, POS, stock, branches, credit, crypto, reports) | **4** | The file contains **no `fetch` calls**. Data is in-page arrays and `Math.random()` values. 14 "Simulate …" buttons fake payments. |
| Demo labelling | 3 | Some new invoice-link copy says "demo link"; the dashboard itself isn't labelled as demo |

### 2.10 Operations

| Capability | Status | Evidence |
|---|---|---|
| Refuse to run live with unsafe config | 5 | S7 |
| Structured logging | 3 | Fastify logger only when `APP_ENV=live` |
| Metrics / tracing / alerting | 5 | — |
| Rate limiting | 5 | `REDIS_URL` configured, Redis unused |
| CI pipeline, Dockerfile, deploy config | 5 | — |

## 3. External dependencies (status 6) — need your decision or a partner

1. **Funding / withdrawal rails:** bank or mobile-money aggregator, M-Pesa Daraja (as a funding rail only), card acquirer. Needs a contract, credentials and settlement terms.
2. **E-money / payment-institution licence** (or a licensed partner) in each market before holding customer funds. Axo's own ledger can run in sandbox; it can't hold real customer money without this.
3. **WhatsApp Business Platform:** Meta business verification, a production number, approved message templates.
4. **KYC/KYB provider** for identity checks and tiered limits.
5. **Biller aggregator** for airtime and utility tokens.
6. **Crypto custody / VASP partner.**
7. **Sanctions-screening data feed** (the denylist is currently manual).

## 4. Prioritised implementation checklist

Order is by dependency and risk. Fix the money-safety holes first, then complete the smallest secure customer → merchant flow, then broaden.

**P0 — stop unsafe money movement** — all done; each one is asserted as "money did not move" in `test/payment-requests.e2e.test.ts` or `test/hardening.test.ts`
- [x] Fix the typecheck/build; fix WhatsApp bare-PIN confirmation being parsed as an OTP.
- [x] Fix `npm start`: the build emitted `dist/src/server.js` while start ran `dist/server.js` (new `tsconfig.build.json`).
- [x] S7: refuse to boot in `live` with missing, default or weak secrets (`liveConfigProblems`).
- [x] S4: sandbox webhook secret from env; the sandbox charge provider is not registered in live and the `axo` alias is gone; the raw body is verified; unknown provider → 404.
- [x] S1: a P2P reversal can never reverse a leg that touches a clearing wallet; WhatsApp `REVERSE` only considers person-to-person sends.
- [x] S2: customer money routes moved to `/customer/*` (customer token, PIN step-up on debits, per-customer idempotency). The merchant-token versions are removed.
- [x] S3: agents, float, agent cash-in and the operator claim tools need `X-Ops-Key` (`OPS_API_KEY`); they refuse when unset. Agent cash-out is customer-authorised (`/customer/agents/:code/withdraw`).
- [x] S5: approval requires the customer's token + PIN (or the WhatsApp PIN confirmation; `YES` only without a PIN and with a live session). Refs come from `crypto.randomBytes`. The unauthenticated approve/decline/scan routes are removed.
- [x] S6: refunds are capped by `Transaction.refundedMinor` (compare-and-set), credit the customer wallet, and are refused for external-rail payments until a rail refund API exists.
- [x] S8: idempotency keys are scoped by merchant + endpoint (customer keys by customer).
- [x] S9: billers refuse in live; the sandbox token is labelled `[SANDBOX — not a real token]`.
- [x] S10: `payMerchant` runs the risk screen and links `Transaction.transferId` ↔ `P2PTransfer`.
- [x] Also: `RECALL` checks the caller is the sender (claim codes are short and guessable); first-contact WhatsApp pay uses the number's currency and minor units.

**P1 — smallest complete customer → merchant flow** — done and proven end to end against Postgres
- [x] Payment request with a unique per-merchant `saleRef`, extending `PushPrompt` (open QR/POS requests and targeted pushes). `POST /payment-requests`, list/read/cancel.
- [x] The customer pays with token + PIN. The request is marked paid (compare-and-set) and both ledgers posted in one serializable transaction. Tested for replay, a second payer, and a three-way race.
- [x] Merchant notification: transactional outbox (`WebhookDelivery`) → HMAC-signed webhook (`t.body`, 5-minute window) with backoff retries; dispatcher runs in `server.ts`. Plus WhatsApp to owner/managers when configured.
- [x] Request status API for POS polling; `/transactions?since=` for the dashboard feed.
- [x] Daily settlement report with cross-ledger reconciliation (`GET /reports/settlement`).

**P2 — merchant operations**
- [x] POS API keys (hashed, fixed `cashier`/`manager` role, can't mint keys or edit webhooks).
- [ ] Branches and tills; cashiers scoped to a branch.
- [ ] Staff invite / user management.
- [x] Wire the Hub frontend to the live API: sign-in, balance, payment requests with real QR, live payment notifications, transactions + refunds, settlements, Till/Paybill, API keys/webhooks (`frontend/live.js`). Demo-only tools are hidden in live mode.
- [x] POS + webhook documentation: `docs/POS-API.md` (an OpenAPI file is still to do).

**P3 — production**
- [ ] Rate limiting, structured logs with redaction, metrics, CI, container image.
- [ ] Audit-log writes for every privileged action.

## 5. Status after this round of work

Rows from §2 that changed. Evidence: `backend/test/payment-requests.e2e.test.ts` (30 HTTP + Postgres tests) and `backend/test/hardening.test.ts` (16 unit tests).

| Capability | Before | Now |
|---|---|---|
| Payment request tied to a sale reference | 5 | **1** |
| Customer pays a request / QR scan → pay | 3 | **1** |
| STK-style push (approval needs PIN) | 3 | **1** (WhatsApp PIN approval, NO-decline) |
| Merchant notification (signed webhook outbox) | 5 | **1** (delivery, signature and retry tested with an injected HTTP client; never against a real merchant endpoint) |
| Merchant WhatsApp notification | 5 | **2** (best-effort; needs WhatsApp credentials for live) |
| Risk screening on merchant payments | 5 | **2** (wired; no test triggers a block on a merchant payment) |
| Merchant refund | 3 | **1** |
| Pay-then-reverse hole | broken | **1** (fixed, tested over HTTP and WhatsApp) |
| Daily settlement report + cross-ledger reconciliation | 5 | **1** |
| POS API keys | 5 | **1** |
| Pay over WhatsApp (`PAY TILL` → PIN) | 2 | **1** |
| Idempotency key scoping | 3 | **1** |
| Refuse to run live with unsafe config | 5 | **1** (unit-tested, and the built server refuses to start) |
| Hub frontend | 4 | **2** for the connected screens (driven end to end in headless Chrome against the sandbox API; no automated frontend test in the repo yet); **4** for the tools still on sample data, now hidden in live mode |
| QR codes | 4 (random squares) | **1**: real, scannable SVG rendered by the backend (`/payment-requests/:id/qr.svg`, `/collect/qr`) |

**Still open (P2/P3):** connect the remaining Hub tools (stock, orders, invoices, payroll…) and the onboarding flow (`POST /merchants`); an automated frontend test; branches/tills/shifts with branch-scoped cashiers; staff invites; merchant fees (MDR); disputes; MFA; audit-log writes; rate limiting; metrics/alerting; CI and a container image; OpenAPI spec; agent self-login (agents run through the operator key today).

**Currency units — decided (Oct 2026):** KES (and UGX, TZS, RWF, SOS) are kept in **whole shillings**: 1 minor unit = 1 shilling, no cents. Every other currency uses its normal decimals. **Somalia transacts in USD, in cents** (a +252 number gets a USD wallet). The single rule is `currencyDecimals` in `chat.lib.ts`. An amount with more precision than its currency (e.g. `KES 12.50`) is refused, never rounded. Following the decision, the WhatsApp HISTORY and MINI statements and the credit notification were fixed: they printed USD amounts without cents (`USD 1250` instead of `USD 12.50`).

**Engine sync (Oct 2026):** the customer send-to-@tag route (`POST /customer/transfers`), the "pay me" QR (`GET /customer/receive-qr.svg`) and a `sendP2P` guard that refuses the internal clearing wallets (it also closes a WhatsApp `SEND … to @axo_clearing_kes` hole) were added with the wallet frontend in `axo-individual-repo-new` and synced here, so both repos' `backend/src` are identical.

**Same code elsewhere:** `axo-individual` and `axo-individual-repo-new` carry their own copies of this engine with the same S1–S9 holes. They weren't touched; they need the same fixes.
