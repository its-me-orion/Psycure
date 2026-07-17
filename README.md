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
4. **CLI workflow**
   - Create session
   - Patient + therapist confirm
   - Finalize invoice
   - View invoice details

## Tech stack

- Node.js + JavaScript
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

## Notes

- This is intentionally a **course-project PoC** and not production-grade.
- All money values are treated as integer minor units (e.g., cents/rappen).
