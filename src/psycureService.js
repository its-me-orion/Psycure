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

/**
 * Creates a session and logs a SESSION_CREATED message to the shared HCS topic.
 */
async function createSession({ sessionId, date, startTime, endTime, patient, therapist }) {
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

  return {
    ...submitResult,
    topicIdUsed: topicId.toString(),
    topicIdWasFromEnv: Boolean(process.env.HEDERA_TOPIC_ID),
  };
}

/**
 * Submits a patient or therapist confirmation for an existing session to HCS.
 */
async function confirmSession({ sessionId, role }) {
  if (role !== "patient" && role !== "therapist") {
    throw new Error("role must be either patient or therapist");
  }

  const client = buildHederaClient();
  const topicId = await ensureTopicId(client);

  const submitResult = await submitTopicMessage(client, topicId, {
    type: "SESSION_CONFIRMED",
    sessionId,
    role,
    confirmedAt: new Date().toISOString(),
  });

  return submitResult;
}

/**
 * Reads current confirmation status for a session directly from the HCS mirror node,
 * without touching the contract. Used by the UI to enable/disable the finalize step.
 */
async function getConfirmationStatus({ sessionId }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const confirmations = await fetchSessionConfirmations(topicId, sessionId);

  return {
    sessionId,
    patientConfirmed: Boolean(confirmations.patientConfirmation),
    therapistConfirmed: Boolean(confirmations.therapistConfirmation),
  };
}

/**
 * Records both HCS confirmations on-chain and finalizes the invoice split.
 */
async function finalizeInvoice({ sessionId, sessionRate, franchiseRemaining, copayBps, platformFeeBps }) {
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
    BigInt(sessionRate),
    BigInt(franchiseRemaining),
    Number(copayBps),
    Number(platformFeeBps || 0)
  );
  const finalizeReceipt = await finalizeTx.wait();

  return {
    sessionId,
    sessionHash,
    transactionHash: finalizeReceipt.hash,
    patientMessageId,
    therapistMessageId,
  };
}

/**
 * Reads the finalized (or in-progress) invoice state from the contract.
 */
async function viewInvoice({ sessionId }) {
  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);
  const invoiceResult = await contract.getInvoice(sessionHash);
  const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];

  return {
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
  };
}

module.exports = {
  toSessionHash,
  createSession,
  confirmSession,
  getConfirmationStatus,
  finalizeInvoice,
  viewInvoice,
};