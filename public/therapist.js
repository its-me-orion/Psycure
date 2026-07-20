let loadedPatientTerms = null; // { sessionRate, franchiseRemaining, copayBps, platformFeeBps, termsHash } in rappen/bps

// ---------- Step 1: create session ----------
el("createBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const btn = el("createBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: `Creating session ${sessionId}…`, status: "pending" });
  try {
    const result = await api("POST", "/api/sessions", {
      sessionId,
      date: el("f-date").value,
      startTime: el("f-start").value,
      endTime: el("f-end").value,
      patient: el("f-patient").value,
      therapist: el("f-therapist").value,
      sessionRate: chfToRappen(el("f-rate").value),
    });
    pendingEntry.remove();
    addLedgerEntry({
      title: `SESSION_CREATED · ${sessionId} · CHF ${el("f-rate").value}`,
      meta: `topic ${result.topicId} · seq #${result.sequenceNumber}`,
    });
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Create session failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 2: load patient's submission ----------
el("loadPatientBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const box = el("patientTermsBox");
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    if (!status.patientConfirmed) {
      box.className = "terms-box terms-box--empty";
      box.textContent = "Patient has not submitted their terms yet.";
      el("confirmBtn").disabled = true;
      return;
    }

    loadedPatientTerms = status.patient;
    box.className = "terms-box";
    box.innerHTML = `
      <div class="terms-box__row"><span>Session rate</span><strong>CHF ${rappenToChf(loadedPatientTerms.sessionRate)}</strong></div>
      <div class="terms-box__row"><span>Franchise remaining</span><strong>CHF ${rappenToChf(loadedPatientTerms.franchiseRemaining)}</strong></div>
      <div class="terms-box__row"><span>Co-pay</span><strong>${bpsToPercent(loadedPatientTerms.copayBps)}%</strong></div>
      <div class="terms-box__row"><span>Platform fee</span><strong>${bpsToPercent(loadedPatientTerms.platformFeeBps)}%</strong></div>
      <div class="terms-box__hash">terms hash: ${loadedPatientTerms.termsHash}</div>
    `;
    el("confirmBtn").disabled = false;
    addLedgerEntry({
      title: "Loaded patient submission",
      meta: `hash ${loadedPatientTerms.termsHash}`,
    });
  } catch (err) {
    box.className = "terms-box terms-box--empty";
    box.textContent = "Could not load patient submission yet.";
    addLedgerEntry({ title: "Load patient submission failed", meta: err.message, status: "error" });
  }
});

// ---------- Step 2b: therapist confirms with the SAME terms ----------
el("confirmBtn").addEventListener("click", async () => {
  if (!loadedPatientTerms) return;
  const sessionId = currentSessionId();
  const btn = el("confirmBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Submitting therapist confirmation…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      role: "therapist",
      sessionRate: loadedPatientTerms.sessionRate,
      franchiseRemaining: loadedPatientTerms.franchiseRemaining,
      copayBps: loadedPatientTerms.copayBps,
      platformFeeBps: loadedPatientTerms.platformFeeBps,
    });
    pendingEntry.remove();
    addLedgerEntry({
      title: "SESSION_CONFIRMED · therapist",
      meta: `hash ${result.termsHash}`,
    });
    el("finalizeBtn").disabled = false;
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Therapist confirmation failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 3: finalize ----------
el("finalizeBtn").addEventListener("click", async () => {
  if (!loadedPatientTerms) return;
  const sessionId = currentSessionId();
  const btn = el("finalizeBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Finalizing invoice on-chain…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/finalize`, {
      sessionRate: loadedPatientTerms.sessionRate,
      franchiseRemaining: loadedPatientTerms.franchiseRemaining,
      copayBps: loadedPatientTerms.copayBps,
      platformFeeBps: loadedPatientTerms.platformFeeBps,
    });
    pendingEntry.remove();
    addLedgerEntry({ title: "Invoice finalized (terms hash verified on-chain)", meta: `tx ${result.transactionHash}` });
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoiceTable(el("invoiceResult"), invoice);
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Finalize failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Load status ----------
el("loadSessionBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    if (status.patientConfirmed && status.therapistConfirmed) {
      el("finalizeBtn").disabled = !status.termsMatch;
    }
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoiceTable(el("invoiceResult"), invoice);
  } catch {
    // fine if nothing exists yet
  }
});
