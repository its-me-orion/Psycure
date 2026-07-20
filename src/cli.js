#!/usr/bin/env node
require("dotenv").config();

const {
  createSession,
  confirmSession,
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
  });

  console.log("Session created and logged on HCS:");
  console.log(result);
  if (!result.topicIdWasFromEnv) {
    console.log(`Remember to set HEDERA_TOPIC_ID=${result.topicId} in your .env`);
  }
}

async function handleConfirmSession(parsedArgs) {
  const result = await confirmSession({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
    role: getRequiredArg(parsedArgs, "role"),
  });

  console.log("Session confirmation submitted to HCS:");
  console.log(result);
}

async function handleFinalizeInvoice(parsedArgs) {
  const result = await finalizeInvoice({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
    sessionRate: getRequiredArg(parsedArgs, "rate"),
    franchiseRemaining: getRequiredArg(parsedArgs, "franchise"),
    copayBps: getRequiredArg(parsedArgs, "copay-bps"),
    platformFeeBps: parsedArgs["platform-fee-bps"] || "0",
  });

  console.log("Invoice finalized on-chain:");
  console.log(result);
}

async function handleViewInvoice(parsedArgs) {
  const result = await viewInvoice({
    sessionId: getRequiredArg(parsedArgs, "session-id"),
  });

  console.log(result);
}

function printUsage() {
  console.log(`Usage:
  npm run cli -- create-session --session-id S1 --date 2026-07-17 --start 09:00 --end 09:50 --patient alice --therapist bob
  npm run cli -- confirm-session --session-id S1 --role patient
  npm run cli -- confirm-session --session-id S1 --role therapist
  npm run cli -- finalize-invoice --session-id S1 --rate 18000 --franchise 10000 --copay-bps 1000 --platform-fee-bps 100
  npm run cli -- view-invoice --session-id S1

  Or run "npm run web" to use the browser-based frontend instead.`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "create-session") {
    await handleCreateSession(args);
    return;
  }

  if (command === "confirm-session") {
    await handleConfirmSession(args);
    return;
  }

  if (command === "finalize-invoice") {
    await handleFinalizeInvoice(args);
    return;
  }

  if (command === "view-invoice") {
    await handleViewInvoice(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});