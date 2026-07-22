require("dotenv").config();

const { ethers } = require("ethers");
const PDFDocument = require("pdfkit");
const {
  buildHederaClient,
  ensureTopicId,
  submitTopicMessage,
  fetchSessionCreated,
  fetchSessionActivity,
} = require("./hcsClient");
const { createConversation, sendMessage } = require("./chatService");

const ROLE_CODES = { patient: 0, therapist: 1, insurer: 2 };

function capitalize(role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Appends a system entry to the session's chat history — a timeline of
 * create/confirm/attend/finalize events, separate from the patient<->therapist
 * messages themselves. `patientAlias`/`therapistAlias` seed the conversation's
 * participant record the first time it's written (createConversation is a
 * no-op on later calls), so the chat isn't stuck with placeholder names.
 * Deliberately never throws: the underlying HCS/on-chain action this is
 * logging has already succeeded by the time this runs, and a local chat-file
 * write failing must not make that action look like it failed too.
 */
function logChatEvent({ sessionId, content, patientAlias, therapistAlias }) {
  try {
    createConversation({
      sessionId,
      patientId: patientAlias || "patient",
      therapistId: therapistAlias || "therapist",
      patientAlias: patientAlias || "Patient",
      therapistAlias: therapistAlias || "Therapist",
    });
    sendMessage({ sessionId, senderRole: "system", senderId: "system", content });
  } catch (err) {
    console.error(`Failed to log chat event for session ${sessionId}:`, err.message || err);
  }
}

const INVOICE_ABI = [
  "function recordHcsConfirmation(bytes32 sessionId, uint8 role, string hcsMessageId, bytes32 termsHash) external",
  "function recordAttendance(bytes32 sessionId, uint8 role, string hcsMessageId) external",
  "function finalizeInvoice(bytes32 sessionId, bytes32 invoiceHash) external",
  "function getInvoice(bytes32 sessionId) external view returns ((bool patientConfirmed,bool therapistConfirmed,bool insurerConfirmed,bool patientAttended,bool therapistAttended,bool finalized,string patientHcsMessageId,string therapistHcsMessageId,string insurerHcsMessageId,string patientAttendanceHcsMessageId,string therapistAttendanceHcsMessageId,bytes32 patientTermsHash,bytes32 therapistTermsHash,bytes32 insurerTermsHash,bytes32 invoiceHash))",
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

  logChatEvent({
    sessionId,
    patientAlias: patient,
    therapistAlias: therapist,
    content: `Session created by ${therapist}. Rate CHF ${(Number(sessionRate) / 100).toFixed(2)}, scheduled ${date} ${startTime}-${endTime}.`,
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
    const activity = await fetchSessionActivity(topicId, sessionId);
    if (!activity.insurerConfirmation) {
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

  logChatEvent({
    sessionId,
    content: `${capitalize(role)} confirmed the session terms (CHF ${(Number(sessionRate) / 100).toFixed(2)}, co-pay ${(Number(copayBps) / 100).toFixed(2)}%).`,
  });

  return { ...submitResult, termsHash: hash };
}

/**
 * Attendance attestation — patient and therapist each independently confirm
 * the session actually took place, separately from agreeing to the cost
 * split. This is deliberately its own HCS message type rather than folded
 * into SESSION_CONFIRMED: a missing attendance record is evidence of a
 * different kind of dispute (a no-show) than a missing/mismatched terms
 * hash (a cost disagreement).
 *
 * Attendance is independent of confirmSession — a patient can (and should be
 * able to) agree to the price before the session happens. It's finalizeInvoice
 * that requires both attendance records to exist, since that's the step that
 * actually settles money and is where "did this session happen" matters.
 */
async function attendSession({ sessionId, role }) {
  if (role !== "patient" && role !== "therapist") {
    throw new Error("role must be either patient or therapist — the insurer does not attend a session");
  }

  const client = buildHederaClient();
  const topicId = await ensureTopicId(client);

  const submitResult = await submitTopicMessage(client, topicId, {
    type: "SESSION_ATTENDED",
    sessionId,
    role,
    attendedAt: new Date().toISOString(),
  });

  logChatEvent({
    sessionId,
    content: `${capitalize(role)} confirmed attendance for this session.`,
  });

  return submitResult;
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

  const activity = await fetchSessionActivity(topicId, sessionId);

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

  const patient = summarize(activity.patientConfirmation);
  const therapist = summarize(activity.therapistConfirmation);
  const insurer = summarize(activity.insurerConfirmation);

  return {
    sessionId,
    patientConfirmed: Boolean(patient),
    therapistConfirmed: Boolean(therapist),
    insurerConfirmed: Boolean(insurer),
    patient,
    therapist,
    insurer,
    patientAttended: Boolean(activity.patientAttendance),
    therapistAttended: Boolean(activity.therapistAttendance),
    patientAttendedAt: activity.patientAttendance?.payload.attendedAt || null,
    therapistAttendedAt: activity.therapistAttendance?.payload.attendedAt || null,
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
 * Gathers everything needed to render or re-verify a session's invoice: the
 * session metadata from SESSION_CREATED, the confirmed financial terms (the
 * insurer is the authoritative source — patient/therapist only ever mirror
 * its exact hash, so any of the three confirmations has identical figures),
 * and the resulting split via the same previewSplit() math used for the
 * live preview during confirmation. This is the single source of truth for
 * "what does this invoice actually say" now that the contract itself no
 * longer computes or stores it.
 */
async function getFinalizedInvoiceData({ sessionId }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const [created, activity] = await Promise.all([
    fetchSessionCreated(topicId, sessionId),
    fetchSessionActivity(topicId, sessionId),
  ]);

  if (!created) {
    throw new Error(`No SESSION_CREATED message found for session ${sessionId}`);
  }
  if (!activity.insurerConfirmation) {
    throw new Error(`No insurer SESSION_CONFIRMED message found for session ${sessionId}`);
  }

  const terms = activity.insurerConfirmation.payload;
  const split = previewSplit({
    sessionRate: terms.sessionRate,
    franchiseRemaining: terms.franchiseRemaining,
    copayBps: terms.copayBps,
    platformFeeBps: terms.platformFeeBps,
  });

  return {
    sessionId,
    date: created.payload.date,
    startTime: created.payload.startTime,
    endTime: created.payload.endTime,
    patient: created.payload.patient,
    therapist: created.payload.therapist,
    insurer: created.payload.insurer,
    sessionRate: terms.sessionRate,
    franchiseRemaining: terms.franchiseRemaining,
    copayBps: Number(terms.copayBps),
    platformFeeBps: Number(terms.platformFeeBps),
    ...split,
  };
}

/**
 * Renders the human-facing invoice as a PDF — CHF amounts, dates and aliases
 * only, no hex hashes or HCS message IDs in the body. Deliberately
 * deterministic (no "generated at" timestamp) so the same finalized session
 * always produces byte-identical output: that's what lets the on-chain
 * invoiceHash be re-verified later by simply regenerating and re-hashing.
 */
async function generateInvoicePdf({ sessionId }) {
  const data = await getFinalizedInvoiceData({ sessionId });
  const sessionHash = toSessionHash(sessionId);

  // pdfkit requires a real Date for its internal file-ID generation — using
  // "now" would make regenerated output non-deterministic (different hash
  // every time), so this pins it to the session's own date instead, which is
  // itself immutable HCS data. Same session in -> same PDF bytes out, always.
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    info: { CreationDate: new Date(`${data.date}T00:00:00Z`) },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const chf = (rappen) => `CHF ${(Number(rappen) / 100).toFixed(2)}`;
  const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

  doc.fontSize(20).text("Psycure - Session Invoice", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#55655F").text(`Session ${data.sessionId}`);
  doc.fillColor("#000000");
  doc.moveDown(1.2);

  doc.fontSize(12).text(`Date: ${data.date}    Time: ${data.startTime} - ${data.endTime}`);
  doc.moveDown(0.6);
  doc.text(`Patient: ${data.patient}`);
  doc.text(`Therapist: ${data.therapist}`);
  doc.text(`Insurer: ${data.insurer}`);
  doc.moveDown(1);

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor("#D7DED3").stroke();
  doc.moveDown(1);

  doc.fontSize(13).text("Terms", { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(12);
  doc.text(`Session rate: ${chf(data.sessionRate)}`);
  doc.text(`Franchise remaining: ${chf(data.franchiseRemaining)}`);
  doc.text(`Co-pay: ${pct(data.copayBps)}`);
  doc.text(`Platform fee: ${pct(data.platformFeeBps)}`);
  doc.moveDown(1);

  doc.fontSize(13).text("Settlement", { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(12);
  doc.text(`Patient pays: ${chf(data.patientAmount)}`);
  doc.text(`Insurer pays: ${chf(data.insurerAmount)}`);
  doc.text(`Platform fee amount: ${chf(data.platformFeeAmount)}`);
  doc.font("Helvetica-Bold").text(`Therapist payout: ${chf(data.therapistPayout)}`);
  doc.font("Helvetica");
  doc.moveDown(1.5);

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor("#D7DED3").stroke();
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor("#55655F");
  doc.text(
    "This invoice is anchored on Hedera testnet: the smart contract records a hash of this exact " +
      "document once all three parties confirmed matching terms and both patient and therapist " +
      `attested attendance. Session hash: ${sessionHash}`
  );

  doc.end();
  return done;
}

/**
 * Step 5 — Records whatever confirmations and attendance attestations exist
 * for this session on-chain, then attempts to finalize.
 *
 * Deliberately NOT pre-validated off-chain: this used to fail fast with a JS
 * error if the terms hashes mismatched or attendance was missing, before ever
 * reaching the contract. That made the PoC's actual enforcement invisible —
 * the contract's own requires (hash-matching, both-attended) never got
 * exercised, only this function's copy of the same logic did. Now this just
 * records what's actually there and calls the contract's finalizeInvoice,
 * letting a genuinely invalid attempt revert *on-chain* — which is the point
 * for a PoC meant to demonstrate that the smart contract itself enforces
 * these rules, not just the frontend.
 *
 * The only things still checked here are structural, not business-rule:
 * patient/therapist/insurer confirmations must actually exist, because
 * without them there's no termsHash to record on-chain at all. The invoice
 * itself — the actual CHF split — is computed and rendered off-chain as a
 * PDF (see generateInvoicePdf); only a hash of that PDF is sent on-chain.
 */
async function finalizeInvoice({ sessionId }) {
  const topicId = process.env.HEDERA_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing HEDERA_TOPIC_ID environment variable");
  }

  const activity = await fetchSessionActivity(topicId, sessionId);
  if (!activity.patientConfirmation || !activity.therapistConfirmation || !activity.insurerConfirmation) {
    throw new Error("Cannot finalize invoice: patient, therapist and insurer HCS confirmations are all required");
  }

  const patientHash = activity.patientConfirmation.payload.termsHash;
  const therapistHash = activity.therapistConfirmation.payload.termsHash;
  const insurerHash = activity.insurerConfirmation.payload.termsHash;

  if (!patientHash || !therapistHash || !insurerHash) {
    throw new Error("Cannot finalize invoice: one or more confirmations are missing a terms hash (stale format?)");
  }

  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);

  const patientMessageId = `${topicId}@${activity.patientConfirmation.sequence_number}`;
  const therapistMessageId = `${topicId}@${activity.therapistConfirmation.sequence_number}`;
  const insurerMessageId = `${topicId}@${activity.insurerConfirmation.sequence_number}`;

  await (
    await contract.recordHcsConfirmation(sessionHash, ROLE_CODES.patient, patientMessageId, patientHash)
  ).wait();
  await (
    await contract.recordHcsConfirmation(sessionHash, ROLE_CODES.therapist, therapistMessageId, therapistHash)
  ).wait();
  await (
    await contract.recordHcsConfirmation(sessionHash, ROLE_CODES.insurer, insurerMessageId, insurerHash)
  ).wait();

  // Only record attendance that actually exists — recordAttendance requires a
  // real HCS message id, so a missing attestation simply isn't recorded, and
  // the contract's own "Both parties must have attended" check will catch it
  // at finalize.
  let patientAttendanceMessageId = null;
  if (activity.patientAttendance) {
    patientAttendanceMessageId = `${topicId}@${activity.patientAttendance.sequence_number}`;
    await (await contract.recordAttendance(sessionHash, ROLE_CODES.patient, patientAttendanceMessageId)).wait();
  }
  let therapistAttendanceMessageId = null;
  if (activity.therapistAttendance) {
    therapistAttendanceMessageId = `${topicId}@${activity.therapistAttendance.sequence_number}`;
    await (await contract.recordAttendance(sessionHash, ROLE_CODES.therapist, therapistAttendanceMessageId)).wait();
  }

  // Generate the invoice PDF from the same confirmed terms just recorded
  // above, and anchor only its hash on-chain.
  const pdfBuffer = await generateInvoicePdf({ sessionId });
  const invoiceHash = ethers.keccak256(pdfBuffer);

  const finalizeTx = await contract.finalizeInvoice(sessionHash, invoiceHash);
  const finalizeReceipt = await finalizeTx.wait();

  logChatEvent({
    sessionId,
    content: `Invoice finalized. PDF invoice generated and its hash anchored on-chain (tx ${finalizeReceipt.hash}).`,
  });

  return {
    sessionId,
    sessionHash,
    transactionHash: finalizeReceipt.hash,
    patientMessageId,
    therapistMessageId,
    insurerMessageId,
    patientAttendanceMessageId,
    therapistAttendanceMessageId,
    termsHash: patientHash,
    invoiceHash,
  };
}

/**
 * Reads the finalized (or in-progress) invoice state from the contract. The
 * contract itself only ever stores confirmation/attendance flags, message
 * IDs, terms hashes and the invoiceHash — no raw CHF figures. If the session
 * is finalized, this also recomputes the split off-chain (the same path
 * generateInvoicePdf uses) purely so the browser UI can keep showing an
 * inline CHF summary, and verifies it against the on-chain invoiceHash by
 * regenerating the PDF and re-hashing it — a genuine tamper-evidence check,
 * not just a display convenience.
 */
async function viewInvoice({ sessionId }) {
  const contract = getContract();
  const sessionHash = toSessionHash(sessionId);
  const invoiceResult = await contract.getInvoice(sessionHash);
  const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];

  const result = {
    sessionId,
    sessionHash,
    patientConfirmed: invoice.patientConfirmed,
    therapistConfirmed: invoice.therapistConfirmed,
    insurerConfirmed: invoice.insurerConfirmed,
    patientAttended: invoice.patientAttended,
    therapistAttended: invoice.therapistAttended,
    finalized: invoice.finalized,
    patientHcsMessageId: invoice.patientHcsMessageId,
    therapistHcsMessageId: invoice.therapistHcsMessageId,
    insurerHcsMessageId: invoice.insurerHcsMessageId,
    patientAttendanceHcsMessageId: invoice.patientAttendanceHcsMessageId,
    therapistAttendanceHcsMessageId: invoice.therapistAttendanceHcsMessageId,
    patientTermsHash: invoice.patientTermsHash,
    therapistTermsHash: invoice.therapistTermsHash,
    insurerTermsHash: invoice.insurerTermsHash,
    invoiceHash: invoice.invoiceHash,
  };

  if (invoice.finalized) {
    const data = await getFinalizedInvoiceData({ sessionId });
    const pdfBuffer = await generateInvoicePdf({ sessionId });
    const regeneratedHash = ethers.keccak256(pdfBuffer);

    result.sessionRate = data.sessionRate;
    result.franchiseRemaining = data.franchiseRemaining;
    result.copayBps = data.copayBps;
    result.platformFeeBps = data.platformFeeBps;
    result.patientAmount = data.patientAmount;
    result.insurerAmount = data.insurerAmount;
    result.platformFeeAmount = data.platformFeeAmount;
    result.therapistPayout = data.therapistPayout;
    result.invoiceVerified = regeneratedHash === invoice.invoiceHash;
  }

  return result;
}

module.exports = {
  toSessionHash,
  computeTermsHash,
  previewSplit,
  createSession,
  getSessionTerms,
  getDefaultPlatformFeeBps,
  confirmSession,
  attendSession,
  getConfirmationStatus,
  generateInvoicePdf,
  finalizeInvoice,
  viewInvoice,
};
