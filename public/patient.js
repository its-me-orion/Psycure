let loadedSessionTerms = null; // { sessionRate } in rappen, from HCS
let insurerTerms = null; // { franchiseRemaining, copayBps, platformFeeBps, termsHash } from the insurer's confirmation
let patientConfirmedLocally = false; // set immediately on successful confirm — the mirror node lags a few seconds behind

// ---------- Step 1: load session ----------
el("loadSessionBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const box = el("sessionDetailsBox");
  try {
    const terms = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/terms`);
    loadedSessionTerms = terms;

    box.className = "terms-box";
    box.innerHTML = `
      <div class="terms-box__row"><span>Session rate (set by therapist)</span><strong>CHF ${rappenToChf(terms.sessionRate)}</strong></div>
      <div class="terms-box__row"><span>Date</span><strong>${terms.date || "—"}</strong></div>
      <div class="terms-box__row"><span>Time</span><strong>${terms.startTime || "—"} – ${terms.endTime || "—"}</strong></div>
    `;
    addLedgerEntry({ title: `Loaded session ${sessionId}`, meta: `rate CHF ${rappenToChf(terms.sessionRate)}` });

    await loadInsurerTerms();
  } catch (err) {
    box.className = "terms-box terms-box--empty";
    box.textContent = "Could not load this session — check the Session ID with your therapist.";
    addLedgerEntry({ title: "Load session failed", meta: err.message, status: "error" });
  }
});

// ---------- Step 2: check for the insurer's published terms & preview ----------
async function loadInsurerTerms() {
  const sessionId = currentSessionId();
  const termsBox = el("insurerTermsBox");
  const previewBox = el("previewBox");

  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);

    if (!status.insurerConfirmed) {
      termsBox.className = "terms-box terms-box--empty";
      termsBox.textContent = "Waiting for your insurer to publish your franchise remaining & co-pay terms.";
      previewBox.className = "invoice-result invoice-result--empty";
      previewBox.textContent = "Your cost breakdown will appear here once your insurer has published terms.";
      el("confirmBtn").disabled = true;
      return;
    }

    insurerTerms = status.insurer;
    termsBox.className = "terms-box";
    termsBox.innerHTML = `
      <div class="terms-box__row"><span>Franchise remaining</span><strong>CHF ${rappenToChf(insurerTerms.franchiseRemaining)}</strong></div>
      <div class="terms-box__row"><span>Co-pay</span><strong>${bpsToPercent(insurerTerms.copayBps)}%</strong></div>
    `;

    const preview = await api("POST", "/api/preview", {
      sessionRate: insurerTerms.sessionRate,
      franchiseRemaining: insurerTerms.franchiseRemaining,
      copayBps: insurerTerms.copayBps,
      platformFeeBps: insurerTerms.platformFeeBps,
    });

    previewBox.className = "invoice-result";
    previewBox.innerHTML = `
      <table class="invoice-table">
        <tr class="highlight"><td>You would pay</td><td>CHF ${rappenToChf(preview.patientAmount)}</td></tr>
        <tr><td>Insurer would pay</td><td>CHF ${rappenToChf(preview.insurerAmount)}</td></tr>
        <tr><td>Platform fee (from therapist's side)</td><td>CHF ${rappenToChf(preview.platformFeeAmount)}</td></tr>
      </table>
    `;

    el("confirmBtn").disabled = false;
    addLedgerEntry({ title: "Loaded insurer's published terms", meta: `hash ${insurerTerms.termsHash}` });

    await refreshStatus();
  } catch (err) {
    termsBox.className = "terms-box terms-box--empty";
    termsBox.textContent = "Could not check insurer terms yet.";
    addLedgerEntry({ title: "Load insurer terms failed", meta: err.message, status: "error" });
  }
}

// ---------- Step 3: confirm ----------
el("confirmBtn").addEventListener("click", async () => {
  if (!insurerTerms) return;
  const sessionId = currentSessionId();
  const btn = el("confirmBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Submitting patient confirmation…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      role: "patient",
      sessionRate: insurerTerms.sessionRate,
      franchiseRemaining: insurerTerms.franchiseRemaining,
      copayBps: insurerTerms.copayBps,
      platformFeeBps: insurerTerms.platformFeeBps,
    });
    pendingEntry.remove();
    addLedgerEntry({ title: "SESSION_CONFIRMED · patient", meta: `hash ${result.termsHash}` });

    // We know we just confirmed — show that immediately rather than waiting on
    // the mirror node, which can take a few seconds to index the new message.
    patientConfirmedLocally = true;
    renderStatus(true, false);
    await refreshStatus();
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

function renderStatus(patientConfirmed, therapistConfirmed) {
  if (!patientConfirmed) return;
  el("statusBox").className = "terms-box";
  el("statusBox").innerHTML = `<div class="terms-box__row"><span>Status</span><strong>${
    therapistConfirmed ? "All parties confirmed" : "Confirmed — waiting on therapist"
  }</strong></div>`;
}

async function refreshStatus() {
  const sessionId = currentSessionId();
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    // OR in our own local confirmation — the mirror node may not have indexed
    // our confirm yet, but we know it went through.
    renderStatus(status.patientConfirmed || patientConfirmedLocally, status.therapistConfirmed);
  } catch {
    // no confirmations yet — fine
  }
}

// ---------- Reload icons ----------
el("reloadInsurerTermsBtn").addEventListener("click", withSpin(el("reloadInsurerTermsBtn"), loadInsurerTerms));
el("reloadStatusBtn").addEventListener("click", withSpin(el("reloadStatusBtn"), refreshStatus));
