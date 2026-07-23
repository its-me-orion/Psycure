# Psycure

Proof-of-concept Hedera dApp for transparent, privacy-preserving psychotherapy
invoicing between a patient, their therapist, and their insurer.

## What this PoC includes

1. **Session lifecycle logging via Hedera Consensus Service (HCS)**
   - `SESSION_CREATED` (therapist, includes the session rate), `SESSION_CONFIRMED`
     (patient, therapist and insurer, each with the settlement terms they agreed to),
     and `SESSION_ATTENDED` (patient and therapist, a separate attestation from
     agreeing to the cost) are written as immutable messages to a shared HCS topic.
2. **Three-way terms-hash binding, enforced on-chain (Hedera EVM compatible)**
   - `contracts/PsycureInvoice.sol` only finalizes an invoice once **all three**
     parties — patient, therapist and insurer — have confirmed on HCS with an
     *identical* settlement-terms hash, and **both** patient and therapist have
     attested attendance. This is what stops the operator from finalizing a
     session that wasn't actually agreed to, or one that never happened — see
     `test/PsycureInvoice.js` for the rejection cases.
   - The insurer is the authoritative source of the franchise remaining and
     co-pay rate; patient and therapist confirm by mirroring the insurer's
     exact numbers rather than typing their own.
3. **Invoice as a PDF, hash-anchored on-chain — no raw CHF figures on a public ledger**
   - The contract stores confirmation/attendance flags, HCS message IDs, terms
     hashes and a single `invoiceHash`. It never stores or emits the session
     rate, franchise, co-pay, fee or settled amounts.
   - `finalizeInvoice()` (in `src/psycureService.js`) renders the settled invoice
     as a deterministic PDF from the confirmed HCS terms and anchors only that
     document's `keccak256` hash on-chain.
   - Because generation is deterministic (same HCS data in → identical PDF bytes
     out), the invoice can be independently re-verified at any time by
     regenerating it and comparing hashes — `public/verify.html` exposes this
     check to anyone holding the PDF and the session ID, no login required.
4. **Platform micro-fee model** — a configurable fee (basis points), read from the
   contract's `defaultPlatformFeeBps()` so all sides use the same value without
   negotiating it by hand.
5. **Encrypted session chat** — a lightweight per-session chat (`public/chat-view.html`,
   `src/chatService.js`) between patient and therapist, stored locally as
   AES-256-CBC-encrypted JSON (`data/chat/<sessionId>.json`, gitignored). Session
   lifecycle events (created / confirmed / attended / finalized) are posted into
   the same thread automatically as system messages, so the chat doubles as a
   plain-language activity log next to the on-chain one.
6. **Two ways to drive the workflow**
   - `src/cli.js` — command line (see step-by-step usage below)
   - `src/server.js` + `public/` — separate **therapist**, **patient** and
     **insurer** browser pages, plus a role-independent **invoice verification**
     page

   Both call the same shared logic in `src/psycureService.js`, so they always
   behave identically.

## The flow (this is the important part)

The order matters and is enforced by what information each party actually has
access to:

1. **Therapist creates the session and sets the rate** (`create-session`). The
   web UI generates a random session ID for this; the CLI takes one explicitly.
   Logged to HCS as `SESSION_CREATED`.
2. **Insurer looks up the session** (reads the rate from HCS) and publishes the
   authoritative franchise-remaining and co-pay terms — this is the number
   patient and therapist will mirror, not invent themselves.
3. **Patient confirms**, mirroring the insurer's exact terms. This computes a
   terms hash (`keccak256` of rate + franchise + co-pay + fee) and submits it —
   along with the full terms, for transparency — to HCS.
4. **Therapist confirms** with the same terms, producing the same hash.
5. **After the session takes place**, patient and therapist each separately
   attest attendance (`SESSION_ATTENDED`) — independent of agreeing to the cost,
   since a no-show and a cost disagreement are different kinds of dispute.
6. **Finalize**: the contract requires all three parties' terms hashes to match
   each other, and both attendance attestations to exist. If satisfied, the
   backend renders the invoice PDF from the confirmed terms and anchors its
   hash on-chain; if not, the transaction reverts with a clear error instead of
   silently settling the wrong (or unearned) amount.
7. **Anyone holding the resulting PDF** can independently verify it wasn't
   altered via `verify.html`, without needing a role or login.

## Tech stack

- Node.js + JavaScript
- Express (web UI backend)
- Hardhat (compile/test/deploy)
- Solidity (`0.8.24`)
- Hedera JS SDK (`@hashgraph/sdk`)
- ethers v6 (EVM contract calls + `keccak256`/`solidityPackedKeccak256` for hashing)
- pdfkit (deterministic invoice PDF generation)

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
- `HEDERA_TOPIC_ID` and `CONTRACT_ADDRESS` — leave blank the first time; `HEDERA_TOPIC_ID`
  is printed the first time you create a session, `CONTRACT_ADDRESS` is printed
  by `npm run deploy` (see below)

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

`test/PsycureInvoice.js` covers the happy path (all three confirmations +
both attendances → finalize succeeds and anchors the invoice hash) and the
rejection cases: mismatched terms between parties, a zero terms/invoice hash,
finalizing twice, an invalid role code, and an insurer attempting to attest
attendance. `test/chatService.test.js` covers the encrypted chat storage
round-trip.

## Deploy contract (Hedera testnet via JSON-RPC relay)

```bash
npm run deploy
```

Copy the printed address into `CONTRACT_ADDRESS` in `.env` (not your account's own
EVM address — that's a different value, shown separately in the Hedera portal). If
you change `contracts/PsycureInvoice.sol`, you'll need to redeploy and update
`CONTRACT_ADDRESS` again.

## CLI usage

Three-party flow — the insurer is the authoritative source of franchise/co-pay;
patient and therapist mirror the insurer's terms rather than typing their own.

```bash
# 1) Therapist creates the session with the rate
npm run cli -- create-session --session-id S1 --date 2026-07-17 --start 09:00 --end 09:50 \
  --patient alice --therapist bob --insurer acme-insurance --rate 18000

# 2) Insurer looks up the session (to see the rate) and publishes the authoritative terms
npm run cli -- view-terms --session-id S1
npm run cli -- preview --rate 18000 --franchise 10000 --copay-bps 1000
npm run cli -- confirm-session --session-id S1 --role insurer --rate 18000 --franchise 10000 --copay-bps 1000

# 3) Patient confirms with the SAME terms — agreeing to the price BEFORE the session
#    happens (fails until the insurer has published terms)
npm run cli -- confirm-session --session-id S1 --role patient --rate 18000 --franchise 10000 --copay-bps 1000

# 4) Therapist confirms with the SAME terms (must match exactly or finalize will reject)
npm run cli -- confirm-session --session-id S1 --role therapist --rate 18000 --franchise 10000 --copay-bps 1000

# 5) After the session takes place, patient and therapist each attest they attended
#    (required before finalize will accept)
npm run cli -- attend-session --session-id S1 --role patient
npm run cli -- attend-session --session-id S1 --role therapist

# 6) Finalize on-chain (renders the invoice as a PDF off-chain, anchors only its
#    hash — the contract still re-checks the terms hash and both attendances itself)
npm run cli -- finalize-invoice --session-id S1

# 7) View the result (confirmation/attendance status, plus the recomputed CHF
#    split and hash-verification once finalized)
npm run cli -- view-invoice --session-id S1

# 8) Save the human-readable invoice locally (regenerated fresh each time, not
#    stored server-side)
npm run cli -- invoice-pdf --session-id S1 --out invoice.pdf
```

Run `npm run cli -- help` any time for this same usage summary.

If no `HEDERA_TOPIC_ID` is set, step 1 creates one and prints it — add it to `.env`.

## Web UI usage (recommended for the presentation)

```bash
npm run web
```

Then open:

- `http://localhost:3000` — landing page, choose a role
- `http://localhost:3000/therapist.html` — create session (random session ID
  generated for you), review the insurer's terms, confirm, attest attendance, finalize
- `http://localhost:3000/patient.html` — look up session, see the insurer's terms
  and a live cost preview, confirm, attest attendance
- `http://localhost:3000/insurer.html` — look up session, publish franchise/co-pay
  terms, confirm
- `http://localhost:3000/verify.html` — upload any invoice PDF + session ID to check
  it against the on-chain hash; usable by anyone, no role or login needed

Each role page shows a fixed role flag (which perspective you're viewing) and a
ledger trail of every write it makes to Hedera testnet, with copy/HashScan links
for session IDs, topic IDs and transaction hashes. Open two or three of the role
pages side by side (e.g. separate browser windows, or one on a phone) to demo the
full three-party flow — same backend and shared operator key underneath (see
Notes), but visually and procedurally separated by role. From the therapist or
patient page, "Open chat" links to the encrypted per-session chat.

The web UI reuses the exact same `.env` variables as the CLI — no separate
configuration needed.

## Notes

- This is intentionally a **course-project PoC** and not production-grade.
- All money values are treated as integer minor units (e.g., cents/rappen) off-chain;
  the contract itself never sees or stores them (see "Invoice as a PDF" above) —
  only the settlement-terms hash and the invoice-document hash.
- Session identifiers are hashed (`keccak256`) before use as contract storage
  keys, and HCS messages use pseudonymous aliases rather than legal names — a
  partial privacy mitigation appropriate to a PoC, not full anonymization.
- The web UI and CLI both act through a single backend-held operator/EVM key —
  patients, therapists and insurers write to HCS through this shared server
  rather than signing with their own keys. The terms-hash binding above closes
  the "operator finalizes different numbers than what was agreed" gap, but it
  does **not** by itself make the signing decentralized — a party could still,
  in principle, have the operator submit *a* confirmation on their behalf with
  any terms they typed in. Fully closing that gap would require each party to
  sign their own HCS message with their own Hedera wallet (e.g. HashPack)
  rather than the shared operator key. Worth stating explicitly in the report's
  critical overview, not glossed over.
- The chat feature is a local convenience layer, not part of the on-chain trust
  model: messages are encrypted at rest with a server-held key
  (`CHAT_MASTER_KEY`, falls back to a fixed dev key if unset) and decrypted
  server-side to serve to the browser — the server itself can read message
  content. Fine for a PoC demo; a production version would need
  client-side end-to-end encryption instead.
