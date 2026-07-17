#!/usr/bin/env node
require("dotenv").config();

const { ethers } = require("ethers");
const {
  buildHederaClient,
  ensureTopicId,
  submitTopicMessage,
  fetchSessionConfirmations,
} = require("./hcsClient");

const INVOICE_ABI = [
  "function recordHcsConfirmation(bytes32 sessionId, bool isPatient, string hcsMessageId) external",
  "function finalizeInvoice(bytes32 sessionId, uint256 sessionRate, uint256 franchiseRemaining, uint16 copayBps, uint16 platformFeeBps) external",
  "function getInvoice(bytes32 sessionId) external view returns ((bool patientConfirmed,bool therapistConfirmed,bool finalized,uint256 sessionRate,uint256 franchiseRemaining,uint16 copayBps,uint16 platformFeeBps,uint256 patientAmount,uint256 insurerAmount,uint256 platformFeeAmount,uint256 therapistPayout,string patientHcsMessageId,string therapistHcsMessageId))",
];

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

function getContract() {
  const rpcUrl = process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api";
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.EVM_PRIVATE_KEY;

  if (!contractAddress) {
    throw new Error("Missing CONTRACT_ADDRESS environment variable");
  }
  if (!privateKey) {
    throw new Error("Missing EVM_PRIVATE_KEY environment variable");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  return new ethers.Contract(contractAddress, INVOICE_ABI, wallet);
}

function toSessionHash(sessionId) {
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

async function handleCreateSession(parsedArgs) {
  const sessionId = getRequiredArg(parsedArgs, "session-id");
  const date = getRequiredArg(parsedArgs, "date");
  const startTime = getRequiredArg(parsedArgs, "start");
  const endTime = getRequiredArg(parsedArgs, "end");
  const patient = getRequiredArg(parsedArgs, "patient");
  const therapist = getRequiredArg(parsedArgs, "therapist");

  const client = buildHederaClient();
  const topicId = await ensureTopicId(client);

  const submitResult = await submitTopicMessage(client, topicId, {
    type: "SESSION_CREATED",
    sessionId,
    date,
    startTime,
    endTime,
    patient,
    therapist,
  });

  console.log("Session created and logged on HCS:");
  console.log(submitResult);
  if (!process.env.HEDERA_TOPIC_ID) {
    console.log(`Remember to set HEDERA_TOPIC_ID=${submitResult.topicId} in your .env`);
  }
}

async function handleConfirmSession(parsedArgs) {
  const sessionId = getRequiredArg(parsedArgs, "session-id");
  const role = getRequiredArg(parsedArgs, "role");

  if (role !== "patient" && role !== "therapist") {
    throw new Error("--role must be either patient or therapist");
  }

  const client = buildHederaClient();
  const topicId = await ensureTopicId(client);

  const submitResult = await submitTopicMessage(client, topicId, {
    type: "SESSION_CONFIRMED",
    sessionId,
    role,
    confirmedAt: new Date().toISOString(),
  });

  console.log("Session confirmation submitted to HCS:");
  console.log(submitResult);
}

async function handleFinalizeInvoice(parsedArgs) {
  const sessionId = getRequiredArg(parsedArgs, "session-id");
  const sessionRate = BigInt(getRequiredArg(parsedArgs, "rate"));
  const franchiseRemaining = BigInt(getRequiredArg(parsedArgs, "franchise"));
  const copayBps = Number(getRequiredArg(parsedArgs, "copay-bps"));
  const platformFeeBps = Number(parsedArgs["platform-fee-bps"] || "0");

  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const confirmations = await fetchSessionConfirmations(topicId, sessionId);
  if (!confirmations.patientConfirmation || !confirmations.therapistConfirmation) {
    throw new Error("Cannot finalize invoice: both patient and therapist HCS confirmations are required");
  }

  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);

  const patientMessageId = `${topicId}@${confirmations.patientConfirmation.sequence_number}`;
  const therapistMessageId = `${topicId}@${confirmations.therapistConfirmation.sequence_number}`;

  const recordPatientTx = await contract.recordHcsConfirmation(sessionHash, true, patientMessageId);
  await recordPatientTx.wait();
  const recordTherapistTx = await contract.recordHcsConfirmation(sessionHash, false, therapistMessageId);
  await recordTherapistTx.wait();

  const finalizeTx = await contract.finalizeInvoice(
    sessionHash,
    sessionRate,
    franchiseRemaining,
    copayBps,
    platformFeeBps
  );
  const finalizeReceipt = await finalizeTx.wait();

  console.log("Invoice finalized on-chain:");
  console.log({
    sessionId,
    sessionHash,
    transactionHash: finalizeReceipt.hash,
    patientMessageId,
    therapistMessageId,
  });
}

async function handleViewInvoice(parsedArgs) {
  const sessionId = getRequiredArg(parsedArgs, "session-id");
  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);
  const invoiceResult = await contract.getInvoice(sessionHash);
  const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];

  console.log({
    sessionId,
    sessionHash,
    patientConfirmed: invoice.patientConfirmed,
    therapistConfirmed: invoice.therapistConfirmed,
    finalized: invoice.finalized,
    sessionRate: invoice.sessionRate.toString(),
    franchiseRemaining: invoice.franchiseRemaining.toString(),
    copayBps: Number(invoice.copayBps),
    platformFeeBps: Number(invoice.platformFeeBps),
    patientAmount: invoice.patientAmount.toString(),
    insurerAmount: invoice.insurerAmount.toString(),
    platformFeeAmount: invoice.platformFeeAmount.toString(),
    therapistPayout: invoice.therapistPayout.toString(),
    patientHcsMessageId: invoice.patientHcsMessageId,
    therapistHcsMessageId: invoice.therapistHcsMessageId,
  });
}

function printUsage() {
  console.log(`Usage:
  npm run cli -- create-session --session-id S1 --date 2026-07-17 --start 09:00 --end 09:50 --patient alice --therapist bob
  npm run cli -- confirm-session --session-id S1 --role patient
  npm run cli -- confirm-session --session-id S1 --role therapist
  npm run cli -- finalize-invoice --session-id S1 --rate 18000 --franchise 10000 --copay-bps 1000 --platform-fee-bps 100
  npm run cli -- view-invoice --session-id S1`);
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
