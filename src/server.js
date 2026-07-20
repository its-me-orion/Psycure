require("dotenv").config();

const path = require("path");
const express = require("express");
const {
  createSession,
  confirmSession,
  getConfirmationStatus,
  finalizeInvoice,
  viewInvoice,
} = require("./psycureService");

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

// Create a session and log SESSION_CREATED to HCS
app.post(
  "/api/sessions",
  asyncRoute(async (req, res) => {
    const { sessionId, date, startTime, endTime, patient, therapist } = req.body;
    const result = await createSession({ sessionId, date, startTime, endTime, patient, therapist });
    res.json(result);
  })
);

// Submit a patient/therapist confirmation to HCS
app.post(
  "/api/sessions/:sessionId/confirm",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const { role } = req.body;
    const result = await confirmSession({ sessionId, role });
    res.json(result);
  })
);

// Poll current confirmation status from the HCS mirror node
app.get(
  "/api/sessions/:sessionId/confirmations",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const result = await getConfirmationStatus({ sessionId });
    res.json(result);
  })
);

// Record confirmations on-chain and finalize the invoice split
app.post(
  "/api/sessions/:sessionId/finalize",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const { sessionRate, franchiseRemaining, copayBps, platformFeeBps } = req.body;
    const result = await finalizeInvoice({
      sessionId,
      sessionRate,
      franchiseRemaining,
      copayBps,
      platformFeeBps,
    });
    res.json(result);
  })
);

// Read the finalized (or pending) invoice from the contract
app.get(
  "/api/sessions/:sessionId/invoice",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params;
    const result = await viewInvoice({ sessionId });
    res.json(result);
  })
);

app.listen(PORT, () => {
  console.log(`Psycure web UI running at http://localhost:${PORT}`);
});