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
            push, cash-in/out ramps (agent, M-Pesa template, crypto), airtime &
            bills, account recovery, risk controls, and the WhatsApp Cloud API
            gateway. See backend/README.md for the full feature list and tests.
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
npm test                    # 155 tests
```

## Status

Built and covered by automated tests (155 passing). It has **not** yet run against a real database or a live payment rail, and moving customer money is regulated. Going live needs the rails, a security audit, and licensing (or a licensed partner). See `backend/README.md`.

---

© Axstron Group. All rights reserved.
