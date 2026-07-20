let loadedSessionTerms = null; // { sessionRate } in rappen, from HCS
let defaultFeeBps = 0;
let lastPreview = null; // { franchiseRemaining, copayBps, platformFeeBps } in rappen/bps, matching the shown preview

// ---------- Step 1: load session ----------
el("loadSessionBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const box = el("sessionDetailsBox");
  try {
    const [terms, fee] = await Promise.all([
      api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/terms`),
      api("GET", "/api/default-fee"),
    ]);
    loadedSessionTerms = terms;
    defaultFeeBps = fee.platformFeeBps;

    box.className = "terms-box";
    box.innerHTML = `
      <div class="terms-box__row"><span>Session rate (set by therapist)</span><strong>CHF ${rappenToChf(terms.sessionRate)}</strong></div>
      <div class="terms-box__row"><span>Date</span><strong>${terms.date || "—"}</strong></div>
      <div class="terms-box__row"><span>Time</span><strong>${terms.startTime || "—"} – ${terms.endTime || "—"}</strong></div>
    `;
    addLedgerEntry({ title: `Loaded session ${sessionId}`, meta: `rate CHF ${rappenToChf(terms.sessionRate)}` });

    // Also refresh confirmation status in case the patient already confirmed earlier.
    await refreshStatus();
  } catch (err) {
    box.className = "terms-box terms-box--empty";
    box.textContent = "Could not load this session — check the Session ID with your therapist.";
    addLedgerEntry({ title: "Load session failed", meta: err.message, status: "error" });
  }
});

// ---------- Step 2: preview ----------
el("previewBtn").addEventListener("click", async () => {
  if (!loadedSessionTerms) {
    addLedgerEntry({ title: "Load a session first", status: "error" });
    return;
  }
  const box = el("previewBox");
  const franchiseRemaining = chfToRappen(el("f-franchise").value);
  const copayBps = percentToBps(el("f-copay").value);
  const platformFeeBps = defaultFeeBps;

  try {
    const preview = await api("POST", "/api/preview", {
      sessionRate: loadedSessionTerms.sessionRate,
      franchiseRemaining,
      copayBps,
      platformFeeBps,
    });

    lastPreview = { franchiseRemaining, copayBps, platformFeeBps };

    box.className = "invoice-result";
    box.innerHTML = `
      <table class="invoice-table">
        <tr class="highlight"><td>You would pay</td><td>CHF ${rappenToChf(preview.patientAmount)}</td></tr>
        <tr><td>Insurer would pay</td><td>CHF ${rappenToChf(preview.insurerAmount)}</td></tr>
        <tr><td>Platform fee (from therapist's side)</td><td>CHF ${rappenToChf(preview.platformFeeAmount)}</td></tr>
      </table>
    `;
    el("confirmBtn").disabled = false;
  } catch (err) {
    box.className = "invoice-result invoice-result--empty";
    box.textContent = "Could not compute preview.";
    addLedgerEntry({ title: "Preview failed", meta: err.message, status: "error" });
  }
});

// ---------- Step 3: confirm ----------
el("confirmBtn").addEventListener("click", async () => {
  if (!loadedSessionTerms || !lastPreview) return;
  const sessionId = currentSessionId();
  const btn = el("confirmBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Submitting patient confirmation…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      role: "patient",
      sessionRate: loadedSessionTerms.sessionRate,
      franchiseRemaining: lastPreview.franchiseRemaining,
      copayBps: lastPreview.copayBps,
      platformFeeBps: lastPreview.platformFeeBps,
    });
    pendingEntry.remove();
    addLedgerEntry({ title: "SESSION_CONFIRMED · patient", meta: `hash ${result.termsHash}` });
    el("statusBox").className = "terms-box";
    el("statusBox").innerHTML = `<div class="terms-box__row"><span>Status</span><strong>Confirmed — waiting on therapist</strong></div>`;
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Confirmation failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 4: view invoice ----------
el("viewBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  try {
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoiceTable(el("invoiceResult"), invoice);
  } catch (err) {
    addLedgerEntry({ title: "View invoice failed", meta: err.message, status: "error" });
  }
});

async function refreshStatus() {
  const sessionId = currentSessionId();
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    if (status.patientConfirmed) {
      el("statusBox").className = "terms-box";
      el("statusBox").innerHTML = `<div class="terms-box__row"><span>Status</span><strong>${
        status.therapistConfirmed ? "Both parties confirmed" : "Confirmed — waiting on therapist"
      }</strong></div>`;
    }
  } catch {
    // no confirmations yet — fine
  }
}
