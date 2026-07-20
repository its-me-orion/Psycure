# Psycure

Proof-of-concept Hedera dApp for transparent psychotherapy invoicing between patient, therapist, and insurer.

## What this PoC includes

1. **Appointment logging via Hedera Consensus Service (HCS)**
   - `SESSION_CREATED` (therapist, includes the session rate) and `SESSION_CONFIRMED`
     (patient and therapist, each with their agreed settlement terms) are written as
     immutable messages to a shared HCS topic.
2. **Invoice smart contract with on-chain terms-hash binding (Hedera EVM compatible)**
   - `contracts/PsycureInvoice.sol` only finalizes an invoice once both HCS
     confirmations are recorded **and** their terms hashes match each other **and**
     match the numbers actually being finalized (`computeTermsHash` is re-derived
     on-chain and compared with `require`). This is what prevents the operator from
     finalizing different numbers than what patient and therapist each independently
     confirmed — see `test/PsycureInvoice.js` for the mismatch-rejection tests.
   - Calculates the patient/insurer split from session rate, remaining franchise, and
     co-payment (basis points) — the Swiss franchise/Selbstbehalt model.
3. **Platform micro-fee model** — a configurable fee (basis points), read from the
   contract's `defaultPlatformFeeBps()` so both parties use the same value without
   negotiating it by hand.
4. **Two ways to drive the workflow**
   - `src/cli.js` — command line (see step-by-step usage below)
   - `src/server.js` + `public/` — separate **therapist** and **patient** browser pages

   Both call the same shared logic in `src/psycureService.js`, so they always behave identically.

## The flow (this is the important part)

The order matters and is enforced by what information each party actually has access to:

1. **Therapist creates the session and sets the rate** (`create-session`). This is
   logged to HCS as `SESSION_CREATED`.
2. **Patient looks up the session** (reads the rate back from HCS), enters their own
   franchise remaining and co-pay rate, and sees a **live preview** of exactly what
   they'd owe — before agreeing to anything.
3. **Patient confirms** with those specific terms. This computes a terms hash
   (`keccak256` of rate + franchise + co-pay + fee) and submits it — along with the
   full terms, for transparency — to HCS.
4. **Therapist loads the patient's submitted terms**, sees the same numbers, and
   confirms with the **identical** terms — producing the same hash.
5. **Finalize**: the contract requires both parties' hashes to match each other, and
   to match the numbers being finalized. If anything was tampered with or
   miscommunicated between steps 3 and 4, finalize reverts with a clear error
   instead of silently settling the wrong amount.

## Tech stack

- Node.js + JavaScript
- Express (web UI backend)
- Hardhat (compile/test/deploy)
- Solidity (`0.8.24`)
- Hedera JS SDK (`@hashgraph/sdk`)
- ethers v6 (EVM contract calls + `solidityPackedKeccak256` for terms hashing)

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env` with Hedera testnet credentials:

- `OPERATOR_ACCOUNT_ID`, `OPERATOR_PRIVATE_KEY` (**ECDSA** key type — see note below)
  for HCS operations
- `EVM_PRIVATE_KEY` for EVM deployment/transactions
- `HEDERA_JSON_RPC_URL` (default `https://testnet.hashio.io/api`)

> **Key type matters.** If your Hedera testnet account is ECDSA (check the badge in
> the Hedera portal), `OPERATOR_PRIVATE_KEY` must be parsed with
> `PrivateKey.fromStringECDSA(...)` in `src/hcsClient.js` — using the wrong key type
> (e.g. `fromStringED25519`) will sign with a mismatched key and every HCS call will
> fail with `INVALID_SIGNATURE`, even though the key bytes themselves are correct.

## Compile and test

```bash
npm run compile
npm test
```

`test/PsycureInvoice.js` covers the happy path, a custom platform fee, and — importantly
— two rejection cases: patient/therapist confirming different terms, and finalize being
called with numbers that don't match what was actually agreed.

## Deploy contract (Hedera testnet via JSON-RPC relay)

**The contract changed (added terms-hash binding) — you must redeploy and update
`CONTRACT_ADDRESS`, even if you deployed an earlier version before.**

```bash
npm run deploy
```

Copy the printed address into `CONTRACT_ADDRESS` in `.env` (not your account's own EVM
address — that's a different value, shown separately in the Hedera portal).

## CLI usage

### 1) Therapist creates the session, with the rate

```bash
npm run cli -- create-session \
  --session-id S1 --date 2026-07-17 --start 09:00 --end 09:50 \
  --patient patient-alias --therapist therapist-alias --rate 18000
```

If no `HEDERA_TOPIC_ID` is set, this creates one and prints it — add it to `.env`.

### 2) Patient looks up the rate and previews their cost

```bash
npm run cli -- view-terms --session-id S1
npm run cli -- preview --rate 18000 --franchise 10000 --copay-bps 1000
```

### 3) Patient confirms with their terms

```bash
npm run cli -- confirm-session --session-id S1 --role patient \
  --rate 18000 --franchise 10000 --copay-bps 1000
```

### 4) Therapist confirms with the SAME terms

```bash
npm run cli -- confirm-session --session-id S1 --role therapist \
  --rate 18000 --franchise 10000 --copay-bps 1000
```

### 5) Finalize (contract re-verifies the terms hash itself)

```bash
npm run cli -- finalize-invoice --session-id S1 --rate 18000 --franchise 10000 --copay-bps 1000
```

### 6) View invoice split

```bash
npm run cli -- view-invoice --session-id S1
```

## Web UI usage (recommended for the presentation)

```bash
npm run web
```

Then open:

- `http://localhost:3000` — landing page, choose a role
- `http://localhost:3000/therapist.html` — create session, review patient terms, confirm, finalize
- `http://localhost:3000/patient.html` — look up session, preview cost, confirm

Open both pages side by side (e.g. two browser windows, or one on a phone) to demo the
two-party flow — same backend and shared operator key underneath (see Notes), but now
visually and procedurally separated by role.

The web UI reuses the exact same `.env` variables as the CLI — no separate configuration needed.

## Notes

- This is intentionally a **course-project PoC** and not production-grade.
- All money values are treated as integer minor units (e.g., cents/rappen).
- The web UI and CLI both act through a single backend-held operator/EVM key — patients
  and therapists write to HCS through this shared server rather than signing with their
  own keys. The terms-hash binding above closes the "operator finalizes different
  numbers than what was agreed" gap, but it does **not** by itself make the signing
  decentralized — a patient or therapist could still, in principle, have the operator
  submit *a* confirmation on their behalf with any terms they typed in. Fully closing
  that gap would require each party to sign their own HCS message with their own
  Hedera wallet (e.g. HashPack) rather than the shared operator key. Worth stating
  explicitly in the report's critical overview, not glossed over.
