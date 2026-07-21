require("dotenv").config();

const { ethers } = require("ethers");
const {
  buildHederaClient,
  ensureTopicId,
  submitTopicMessage,
  fetchSessionCreated,
  fetchSessionConfirmations,
} = require("./hcsClient");

const ROLE_CODES = { patient: 0, therapist: 1, insurer: 2 };

const INVOICE_ABI = [
  "function recordHcsConfirmation(bytes32 sessionId, uint8 role, string hcsMessageId, bytes32 termsHash) external",
  "function finalizeInvoice(bytes32 sessionId, uint256 sessionRate, uint256 franchiseRemaining, uint16 copayBps, uint16 platformFeeBps) external",
  "function getInvoice(bytes32 sessionId) external view returns ((bool patientConfirmed,bool therapistConfirmed,bool insurerConfirmed,bool finalized,uint256 sessionRate,uint256 franchiseRemaining,uint16 copayBps,uint16 platformFeeBps,uint256 patientAmount,uint256 insurerAmount,uint256 platformFeeAmount,uint256 therapistPayout,string patientHcsMessageId,string therapistHcsMessageId,string insurerHcsMessageId,bytes32 patientTermsHash,bytes32 therapistTermsHash,bytes32 insurerTermsHash))",
  "function defaultPlatformFeeBps() external view returns (uint16)",
  "function computeTermsHash(uint256 sessionRate, uint256 franchiseRemaining, uint16 copayBps, uint16 platformFeeBps) external pure returns (bytes32)",
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
 * Deterministically computes the same terms hash the contract itself computes
 * (see PsycureInvoice.computeTermsHash). Both patient and therapist must arrive
 * at an identical hash before either is allowed to confirm.
 */
function computeTermsHash({ sessionRate, franchiseRemaining, copayBps, platformFeeBps }) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "uint256", "uint16", "uint16"],
    [BigInt(sessionRate), BigInt(franchiseRemaining), Number(copayBps), Number(platformFeeBps)]
  );
}

/**
 * Pure JS mirror of the contract's split arithmetic, used to show the patient a
 * live preview before they confirm anything on-chain. Uses the same truncating
 * integer division as Solidity so the preview always matches what finalize()
 * will actually compute.
 */
function previewSplit({ sessionRate, franchiseRemaining, copayBps, platformFeeBps }) {
  const rate = BigInt(sessionRate);
  const franchise = BigInt(franchiseRemaining);
  const copay = BigInt(copayBps);
  const fee = BigInt(platformFeeBps);

  const patientBeforeCopay = franchise >= rate ? rate : franchise;
  const remainder = rate - patientBeforeCopay;
  const copayAmount = (remainder * copay) / 10_000n;

  const patientAmount = patientBeforeCopay + copayAmount;
  const insurerAmount = rate - patientAmount;

  const platformFeeAmount = (rate * fee) / 10_000n;
  const therapistPayout = rate - platformFeeAmount;

  return {
    patientAmount: patientAmount.toString(),
    insurerAmount: insurerAmount.toString(),
    platformFeeAmount: platformFeeAmount.toString(),
    therapistPayout: therapistPayout.toString(),
  };
}

/**
 * Step 1 — Therapist creates the session, setting the session rate. Logs
 * SESSION_CREATED to the shared HCS topic.
 */
async function createSession({ sessionId, date, startTime, endTime, patient, therapist, insurer, sessionRate }) {
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
    insurer,
    sessionRate: String(sessionRate),
  });

  return {
    ...submitResult,
    topicIdUsed: topicId.toString(),
    topicIdWasFromEnv: Boolean(process.env.HEDERA_TOPIC_ID),
  };
}

/**
 * Reads the therapist-set session rate (and other creation details) back from HCS.
 * Used by the patient view before they enter their franchise/co-pay.
 */
async function getSessionTerms({ sessionId }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const created = await fetchSessionCreated(topicId, sessionId);
  if (!created) {
    throw new Error(`No SESSION_CREATED message found for session ${sessionId}`);
  }

  return {
    sessionId,
    date: created.payload.date,
    startTime: created.payload.startTime,
    endTime: created.payload.endTime,
    patient: created.payload.patient,
    therapist: created.payload.therapist,
    insurer: created.payload.insurer,
    sessionRate: created.payload.sessionRate,
  };
}

/**
 * Reads the contract's configured default platform fee (basis points), so both
 * sides can use a consistent, non-negotiable fee value without typing it in.
 */
async function getDefaultPlatformFeeBps() {
  const contract = getContract();
  const feeBps = await contract.defaultPlatformFeeBps();
  return Number(feeBps);
}

/**
 * Step 2/3/4 — A party confirms a session *with specific settlement terms*.
 * The terms hash is computed client-side (here, server-side on their behalf)
 * from the exact same parameters the contract will later re-hash at finalize.
 * The full terms are also included in the HCS message body (not just the hash)
 * so the other parties — and anyone auditing the topic — can see exactly what
 * was agreed, not just an opaque hash.
 *
 * The insurer is the authoritative source of franchiseRemaining/copayBps, so
 * patient and therapist cannot confirm until the insurer has already
 * published terms for this session — they mirror the insurer's numbers
 * rather than inventing their own.
 */
async function confirmSession({ sessionId, role, sessionRate, franchiseRemaining, copayBps, platformFeeBps }) {
  if (role !== "patient" && role !== "therapist" && role !== "insurer") {
    throw new Error("role must be one of patient, therapist or insurer");
  }

  if (role === "patient" || role === "therapist") {
    const topicId = process.env.HEDERA_TOPIC_ID;
    if (!topicId) {
      throw new Error("Missing HEDERA_TOPIC_ID environment variable");
    }
    const { insurerConfirmation } = await fetchSessionConfirmations(topicId, sessionId);
    if (!insurerConfirmation) {
      throw new Error(
        "Waiting for the insurer to publish terms before you can confirm — ask your insurer to load this session first."
      );
    }
  }

  const hash = computeTermsHash({ sessionRate, franchiseRemaining, copayBps, platformFeeBps });

  const client = buildHederaClient();
  const topicId = await ensureTopicId(client);

  const submitResult = await submitTopicMessage(client, topicId, {
    type: "SESSION_CONFIRMED",
    sessionId,
    role,
    confirmedAt: new Date().toISOString(),
    sessionRate: String(sessionRate),
    franchiseRemaining: String(franchiseRemaining),
    copayBps: Number(copayBps),
    platformFeeBps: Number(platformFeeBps),
    termsHash: hash,
  });

  return { ...submitResult, termsHash: hash };
}

/**
 * Reads current confirmation status AND the terms each party confirmed, directly
 * from the HCS mirror node. The therapist view uses the patient's submitted
 * franchise/co-pay from here to recompute a matching hash before confirming.
 */
async function getConfirmationStatus({ sessionId }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const confirmations = await fetchSessionConfirmations(topicId, sessionId);

  function summarize(confirmation) {
    if (!confirmation) return null;
    return {
      sessionRate: confirmation.payload.sessionRate,
      franchiseRemaining: confirmation.payload.franchiseRemaining,
      copayBps: confirmation.payload.copayBps,
      platformFeeBps: confirmation.payload.platformFeeBps,
      termsHash: confirmation.payload.termsHash,
      confirmedAt: confirmation.payload.confirmedAt,
    };
  }

  const patient = summarize(confirmations.patientConfirmation);
  const therapist = summarize(confirmations.therapistConfirmation);
  const insurer = summarize(confirmations.insurerConfirmation);

  return {
    sessionId,
    patientConfirmed: Boolean(patient),
    therapistConfirmed: Boolean(therapist),
    insurerConfirmed: Boolean(insurer),
    patient,
    therapist,
    insurer,
    termsMatch: Boolean(
      patient &&
        therapist &&
        insurer &&
        patient.termsHash === therapist.termsHash &&
        patient.termsHash === insurer.termsHash
    ),
  };
}

/**
 * Step 5 — Records all three HCS confirmations on-chain and finalizes the
 * invoice. The contract itself re-derives the terms hash from these
 * parameters and requires it to equal what all three parties confirmed —
 * this function also checks that off-chain first, so a mismatch fails fast
 * with a clear message instead of spending gas on a transaction that will
 * revert.
 */
async function finalizeInvoice({ sessionId, sessionRate, franchiseRemaining, copayBps, platformFeeBps }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const confirmations = await fetchSessionConfirmations(topicId, sessionId);
  if (!confirmations.patientConfirmation || !confirmations.therapistConfirmation || !confirmations.insurerConfirmation) {
    throw new Error("Cannot finalize invoice: patient, therapist and insurer HCS confirmations are all required");
  }

  const patientHash = confirmations.patientConfirmation.payload.termsHash;
  const therapistHash = confirmations.therapistConfirmation.payload.termsHash;
  const insurerHash = confirmations.insurerConfirmation.payload.termsHash;

  if (!patientHash || !therapistHash || !insurerHash) {
    throw new Error("Cannot finalize invoice: one or more confirmations are missing a terms hash (stale format?)");
  }

  if (patientHash !== therapistHash || patientHash !== insurerHash) {
    throw new Error(
      "Cannot finalize invoice: patient, therapist and insurer confirmed different terms (terms hash mismatch). " +
        "Ask all three parties to re-confirm using the same session rate, franchise remaining and co-pay."
    );
  }

  const expectedHash = computeTermsHash({ sessionRate, franchiseRemaining, copayBps, platformFeeBps });
  if (expectedHash !== patientHash) {
    throw new Error(
      "Cannot finalize invoice: the numbers submitted for finalization do not match what patient, therapist " +
        "and insurer actually confirmed. Use the confirmed session rate, franchise remaining, co-pay and fee exactly."
    );
  }

  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);

  const patientMessageId = `${topicId}@${confirmations.patientConfirmation.sequence_number}`;
  const therapistMessageId = `${topicId}@${confirmations.therapistConfirmation.sequence_number}`;
  const insurerMessageId = `${topicId}@${confirmations.insurerConfirmation.sequence_number}`;

  const recordPatientTx = await contract.recordHcsConfirmation(
    sessionHash,
    ROLE_CODES.patient,
    patientMessageId,
    patientHash
  );
  await recordPatientTx.wait();
  const recordTherapistTx = await contract.recordHcsConfirmation(
    sessionHash,
    ROLE_CODES.therapist,
    therapistMessageId,
    therapistHash
  );
  await recordTherapistTx.wait();
  const recordInsurerTx = await contract.recordHcsConfirmation(
    sessionHash,
    ROLE_CODES.insurer,
    insurerMessageId,
    insurerHash
  );
  await recordInsurerTx.wait();

  const finalizeTx = await contract.finalizeInvoice(
    sessionHash,
    BigInt(sessionRate),
    BigInt(franchiseRemaining),
    Number(copayBps),
    Number(platformFeeBps)
  );
  const finalizeReceipt = await finalizeTx.wait();

  return {
    sessionId,
    sessionHash,
    transactionHash: finalizeReceipt.hash,
    patientMessageId,
    therapistMessageId,
    insurerMessageId,
    termsHash: patientHash,
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
    insurerConfirmed: invoice.insurerConfirmed,
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
    insurerHcsMessageId: invoice.insurerHcsMessageId,
    patientTermsHash: invoice.patientTermsHash,
    therapistTermsHash: invoice.therapistTermsHash,
    insurerTermsHash: invoice.insurerTermsHash,
  };
}

module.exports = {
  toSessionHash,
  computeTermsHash,
  previewSplit,
  createSession,
  getSessionTerms,
  getDefaultPlatformFeeBps,
  confirmSession,
  getConfirmationStatus,
  finalizeInvoice,
  viewInvoice,
};
