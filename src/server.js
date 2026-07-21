require("dotenv").config();

const path = require("path");
const express = require("express");
const {
  createSession,
  getSessionTerms,
  getDefaultPlatformFeeBps,
  previewSplit,
  confirmSession,
  getConfirmationStatus,
  finalizeInvoice,
  viewInvoice,
} = require("./psycureService");
const { createConversation, sendMessage, listMessages } = require("./chatService");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      console.error(error);
      res.status(400).json({ error: error.message || String(error) });
    });
  };
}

// Read the platform's configured default fee (basis points) — both sides use this
// so nobody has to manually agree on a fee.
app.get(
  "/api/default-fee",
  asyncRoute(async (_req, res) => {
    const platformFeeBps = await getDefaultPlatformFeeBps();
    res.json({ platformFeeBps });
  })
);

// Therapist: create a session, including the rate.
app.post(
  "/api/sessions",
  asyncRoute(async (req, res) => {
    const { sessionId, date, startTime, endTime, patient, therapist, insurer, sessionRate } = req.body;
    const result = await createSession({ sessionId, date, startTime, endTime, patient, therapist, insurer, sessionRate });
    res.json(result);
  })
);

// Patient: look up a session's therapist-set terms (mainly the rate) before confirming.
app.get(
  "/api/sessions/:sessionId/terms",
  asyncRoute(async (req, res) => {
    const terms = await getSessionTerms({ sessionId: req.params.sessionId });
    res.json(terms);
  })
);

// Either side: compute a preview split without writing anything on-chain.
app.post(
  "/api/preview",
  asyncRoute(async (req, res) => {
    const { sessionRate, franchiseRemaining, copayBps, platformFeeBps } = req.body;
    const preview = previewSplit({ sessionRate, franchiseRemaining, copayBps, platformFeeBps });
    res.json(preview);
  })
);

// Either party: confirm a session with specific settlement terms (hash-bound).
app.post(
  "/api/sessions/:sessionId/confirm",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const { role, sessionRate, franchiseRemaining, copayBps, platformFeeBps } = req.body;
    const result = await confirmSession({ sessionId, role, sessionRate, franchiseRemaining, copayBps, platformFeeBps });
    res.json(result);
  })
);

// Poll confirmation status AND the terms each side confirmed, from the HCS mirror node.
app.get(
  "/api/sessions/:sessionId/confirmations",
  asyncRoute(async (req, res) => {
    const result = await getConfirmationStatus({ sessionId: req.params.sessionId });
    res.json(result);
  })
);

// Finalize on-chain — contract re-verifies the terms hash itself.
app.post(
  "/api/sessions/:sessionId/finalize",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const { sessionRate, franchiseRemaining, copayBps, platformFeeBps } = req.body;
    const result = await finalizeInvoice({ sessionId, sessionRate, franchiseRemaining, copayBps, platformFeeBps });
    res.json(result);
  })
);

// Read the finalized (or pending) invoice from the contract.
app.get(
  "/api/sessions/:sessionId/invoice",
  asyncRoute(async (req, res) => {
    const result = await viewInvoice({ sessionId: req.params.sessionId });
    res.json(result);
  })
);

app.get(
  "/api/chat/:sessionId",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.sessionId;
    createConversation({
      sessionId,
      patientId: "patient-1",
      therapistId: "therapist-1",
      patientAlias: "Patient",
      therapistAlias: "Therapist",
    });
    res.json({ sessionId, messages: listMessages(sessionId) });
  })
);

app.post(
  "/api/chat/:sessionId",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.sessionId;
    const { senderRole, senderId, content } = req.body;

    if (!senderRole || !senderId || !content) {
      return res.status(400).json({ error: "senderRole, senderId and content are required" });
    }

    createConversation({
      sessionId,
      patientId: "patient-1",
      therapistId: "therapist-1",
      patientAlias: "Patient",
      therapistAlias: "Therapist",
    });

    const message = sendMessage({ sessionId, senderRole, senderId, content });
    res.json({ message });
  })
);

app.listen(PORT, () => {
  console.log(`Psycure web UI running at http://localhost:${PORT}`);
  console.log(`  Therapist view: http://localhost:${PORT}/therapist.html`);
  console.log(`  Patient view:   http://localhost:${PORT}/patient.html`);
});
