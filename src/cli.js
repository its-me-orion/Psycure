#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const {
  createSession,
  getSessionTerms,
  getDefaultPlatformFeeBps,
  previewSplit,
  confirmSession,
  attendSession,
  generateInvoicePdf,
  finalizeInvoice,
  viewInvoice,
} = require("./psycureService");

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      parsed[args[i].slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function getRequiredArg(parsedArgs, key) {
  const value = parsedArgs[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

async function handleCreateSession(parsedArgs) {
  const result = await createSession({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
    date: getRequiredArg(parsedArgs, "date"),
    startTime: getRequiredArg(parsedArgs, "start"),
    endTime: getRequiredArg(parsedArgs, "end"),
    patient: getRequiredArg(parsedArgs, "patient"),
    therapist: getRequiredArg(parsedArgs, "therapist"),
    insurer: getRequiredArg(parsedArgs, "insurer"),
    sessionRate: getRequiredArg(parsedArgs, "rate"),
  });

  console.log("Session created (with rate) and logged on HCS:");
  console.log(result);
  if (!result.topicIdWasFromEnv) {
    console.log(`Remember to set HEDERA_TOPIC_ID=${result.topicId} in your .env`);
  }
}

async function handleViewTerms(parsedArgs) {
  const terms = await getSessionTerms({ sessionId: getRequiredArg(parsedArgs, "session-id") });
  console.log(terms);
}

async function handlePreview(parsedArgs) {
  const defaultFeeBps = await getDefaultPlatformFeeBps();
  const preview = previewSplit({
    sessionRate: getRequiredArg(parsedArgs, "rate"),
    franchiseRemaining: getRequiredArg(parsedArgs, "franchise"),
    copayBps: getRequiredArg(parsedArgs, "copay-bps"),
    platformFeeBps: parsedArgs["platform-fee-bps"] || defaultFeeBps,
  });
  console.log({ platformFeeBpsUsed: parsedArgs["platform-fee-bps"] || defaultFeeBps, ...preview });
}

async function handleAttendSession(parsedArgs) {
  const result = await attendSession({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
    role: getRequiredArg(parsedArgs, "role"),
  });

  console.log("Attendance attestation submitted to HCS:");
  console.log(result);
}

async function handleConfirmSession(parsedArgs) {
  const defaultFeeBps = await getDefaultPlatformFeeBps();
  const result = await confirmSession({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
    role: getRequiredArg(parsedArgs, "role"),
    sessionRate: getRequiredArg(parsedArgs, "rate"),
    franchiseRemaining: getRequiredArg(parsedArgs, "franchise"),
    copayBps: getRequiredArg(parsedArgs, "copay-bps"),
    platformFeeBps: parsedArgs["platform-fee-bps"] || defaultFeeBps,
  });

  console.log("Session confirmation (with terms hash) submitted to HCS:");
  console.log(result);
}

async function handleFinalizeInvoice(parsedArgs) {
  const result = await finalizeInvoice({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
  });

  console.log("Invoice finalized on-chain (invoice hash anchored, terms hash verified):");
  console.log(result);
}

async function handleViewInvoice(parsedArgs) {
  const result = await viewInvoice({ sessionId: getRequiredArg(parsedArgs, "session-id") });
  console.log(result);
}

async function handleInvoicePdf(parsedArgs) {
  const sessionId = getRequiredArg(parsedArgs, "session-id");
  const outPath = parsedArgs.out || `${sessionId}-invoice.pdf`;
  const pdfBuffer = await generateInvoicePdf({ sessionId });
  fs.writeFileSync(outPath, pdfBuffer);
  console.log(`Invoice PDF written to ${outPath}`);
}

function printUsage() {
  console.log(`Usage (three-party flow — the insurer is the authoritative source of franchise/co-pay;
patient and therapist mirror the insurer's terms rather than typing their own):

  1) Therapist creates the session with the rate:
     npm run cli -- create-session --session-id S1 --date 2026-07-17 --start 09:00 --end 09:50 --patient alice --therapist bob --insurer acme-insurance --rate 18000

  2) Insurer looks up the session (to see the rate) and publishes the authoritative terms:
     npm run cli -- view-terms --session-id S1
     npm run cli -- preview --rate 18000 --franchise 10000 --copay-bps 1000
     npm run cli -- confirm-session --session-id S1 --role insurer --rate 18000 --franchise 10000 --copay-bps 1000

  3) Patient confirms with the SAME terms — agreeing to the price BEFORE the session happens
     (fails until the insurer has published terms):
     npm run cli -- confirm-session --session-id S1 --role patient --rate 18000 --franchise 10000 --copay-bps 1000

  4) Therapist confirms with the SAME terms (must match exactly or finalize will reject):
     npm run cli -- confirm-session --session-id S1 --role therapist --rate 18000 --franchise 10000 --copay-bps 1000

  5) After the session takes place, patient and therapist each attest they attended
     (a separate record from agreeing to the cost — required before finalize will accept):
     npm run cli -- attend-session --session-id S1 --role patient
     npm run cli -- attend-session --session-id S1 --role therapist

  6) Finalize on-chain (renders the invoice as a PDF off-chain, anchors only its
     hash — contract still re-checks the terms hash and both attendances itself):
     npm run cli -- finalize-invoice --session-id S1

  7) View the result (confirmation/attendance status, plus the recomputed CHF split
     once finalized):
     npm run cli -- view-invoice --session-id S1

  8) Save the human-readable invoice locally (regenerated fresh each time, not stored
     server-side):
     npm run cli -- invoice-pdf --session-id S1 --out invoice.pdf

  Or run "npm run web" for the browser UI (separate insurer/patient/therapist pages).`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "create-session") return handleCreateSession(args);
  if (command === "view-terms") return handleViewTerms(args);
  if (command === "preview") return handlePreview(args);
  if (command === "attend-session") return handleAttendSession(args);
  if (command === "confirm-session") return handleConfirmSession(args);
  if (command === "finalize-invoice") return handleFinalizeInvoice(args);
  if (command === "view-invoice") return handleViewInvoice(args);
  if (command === "invoice-pdf") return handleInvoicePdf(args);

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
