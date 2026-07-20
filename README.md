# Psycure

Proof-of-concept Hedera dApp for transparent psychotherapy invoicing between patient, therapist, and insurer.

## What this PoC includes

1. **Appointment logging via Hedera Consensus Service (HCS)**
   - `src/cli.js` writes immutable `SESSION_CREATED` and `SESSION_CONFIRMED` messages to a shared HCS topic.
   - Patient and therapist each submit a confirmation for the same `sessionId`.
2. **Invoice smart contract (Hedera EVM compatible)**
   - `contracts/PsycureInvoice.sol` only finalizes an invoice after both HCS confirmations are recorded.
   - Calculates patient/insurer split from:
     - session rate
     - remaining franchise
     - co-payment (basis points)
   - Emits `InvoiceFinalized` when finalized.
3. **Platform micro-fee model**
   - Contract applies a platform fee (basis points) on each finalized invoice.
4. **Two ways to drive the workflow**
   - `src/cli.js` — command line
   - `src/server.js` + `public/` — a small browser UI (recommended for demos/presentation)

   Both call the same shared logic in `src/psycureService.js`, so they always behave identically.

## Tech stack

- Node.js + JavaScript
- Express (web UI backend)
- Hardhat (compile/test/deploy)
- Solidity (`0.8.24`)
- Hedera JS SDK (`@hashgraph/sdk`)

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env` with Hedera testnet credentials:

- `OPERATOR_ACCOUNT_ID`, `OPERATOR_PRIVATE_KEY` for HCS operations
- `EVM_PRIVATE_KEY` for EVM deployment/transactions
- `HEDERA_JSON_RPC_URL` (default `https://testnet.hashio.io/api`)

## Compile and test

```bash
npm run compile
npm test
```

## Deploy contract (Hedera testnet via JSON-RPC relay)

```bash
npm run deploy
```

Copy the printed address into `CONTRACT_ADDRESS` in `.env`.

## CLI usage

### 1) Create session (and log to HCS)

```bash
npm run cli -- create-session \
  --session-id S1 \
  --date 2026-07-17 \
  --start 09:00 \
  --end 09:50 \
  --patient patient-alias \
  --therapist therapist-alias
```

If no `HEDERA_TOPIC_ID` is set, this command creates one and prints it. Add it to `.env`.

### 2) Submit both confirmations

```bash
npm run cli -- confirm-session --session-id S1 --role patient
npm run cli -- confirm-session --session-id S1 --role therapist
```

### 3) Finalize invoice

```bash
npm run cli -- finalize-invoice \
  --session-id S1 \
  --rate 18000 \
  --franchise 10000 \
  --copay-bps 1000 \
  --platform-fee-bps 100
```

### 4) View invoice split

```bash
npm run cli -- view-invoice --session-id S1
```

## Web UI usage (recommended for the presentation)

Once `.env` is filled in and the contract is deployed (see Setup/Deploy above):

```bash
npm run web
```

Then open `http://localhost:3000`. The page walks through the same four steps as the
CLI — create session, confirm as patient/therapist, finalize, view invoice — and shows
a live "ledger trail" of every HCS message and on-chain transaction as it happens, so
you can narrate the immutability story directly from the browser instead of a terminal.

The web UI reuses the exact same `.env` variables as the CLI (`OPERATOR_ACCOUNT_ID`,
`OPERATOR_PRIVATE_KEY`, `EVM_PRIVATE_KEY`, `CONTRACT_ADDRESS`, `HEDERA_TOPIC_ID`, etc.) —
no separate configuration needed.

## Notes

- This is intentionally a **course-project PoC** and not production-grade.
- All money values are treated as integer minor units (e.g., cents/rappen).
- The web UI and CLI both act through a single backend-held operator/EVM key (see the
  "limitations" discussion in the report) — patients and therapists write to HCS
  through this shared server rather than signing with their own keys, which is a
  simplification worth naming explicitly in your report's critical overview.