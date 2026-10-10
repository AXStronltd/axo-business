# Axo for Business

A WhatsApp-native merchant platform — a telco-free alternative to M-PESA Business and EVC for shops, services and enterprises. A business claims its own Till, Paybill, QR and Pay-ID inside the Hub, then gets paid by any Axo customer over WhatsApp — no SIM to register, no POS to buy.

## What a business can do

Get paid (Till, Paybill with account lines, QR, Pay-ID, STK-style push-to-pay), pay staff (payroll) and suppliers, issue invoices, settle and reconcile, run reports, receive crypto, send globally, and manage risk & compliance — with role-based access for owners, managers, cashiers and accountants.

## Layout

```
frontend/   The merchant dashboard — a self-contained single-page app
            (open frontend/index.html in a browser).
backend/    The money engine the Hub runs on — TypeScript · Fastify · PostgreSQL
            (Prisma). A double-entry ledger, idempotency, pay-a-business, STK-style
            push, payment requests for POS/QR, signed merchant webhooks, refunds,
            daily settlement, cash-in/out ramps (agent, M-Pesa template, crypto),
            account recovery, risk controls, and the WhatsApp Cloud API gateway.
            See backend/README.md for the full feature list and tests.
docs/       POS-API.md — integrating a till / POS, webhooks, refunds, reports.
```

> The backend is the same money engine that powers the Axo for Individual app —
> each repo ships a standalone copy so it clones, runs and deploys on its own.

## Frontend

The Hub is a single self-contained HTML file — open `frontend/index.html` in a browser. No build step.

## Backend

```bash
cd backend
cp .env.example .env
docker compose up -d        # Postgres + Redis
npm install
npm run prisma:migrate
npm run seed                # demo merchant + wallets; agent AMRAN
npm run dev                 # http://localhost:4000/health
npm test                    # 216 tests (DB e2e tests skip without Postgres)
```

## Status

See **[AUDIT.md](AUDIT.md)** for the full capability matrix with evidence, and **[docs/POS-API.md](docs/POS-API.md)** for the POS / payments integration guide.

- **Proven in a test environment:** the customer → merchant flow runs end to end over HTTP against a real Postgres in automated tests. A business raises a payment request for a sale, the customer scans and pays with a PIN, the request settles exactly once on both ledgers, the merchant gets a signed webhook, and refunds and the daily settlement report reconcile. 216 tests pass (`npm test`). Money units: KES in whole shillings; Somalia in USD cents.
- **Not proven in production:** nothing has run against live money. Funding/withdrawal rails, WhatsApp production messaging, KYC/KYB, billers and crypto all need provider agreements and credentials. Holding customer funds needs an e-money licence or a licensed partner.
- **The Hub frontend is demo-only.** It makes no API calls, and it now says so in a banner.

---

© Axstron Group. All rights reserved.
