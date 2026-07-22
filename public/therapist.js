let loadedInsurerTerms = null; // { sessionRate, franchiseRemaining, copayBps, platformFeeBps, termsHash } in rappen/bps
let therapistAttendedLocally = false; // set immediately on successful attend — the mirror node lags a few seconds behind

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
      insurer: el("f-insurer").value,
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

// ---------- Step 2: load insurer's published terms ----------
// Independent of attendance — you can agree to the price before the session
// takes place.
async function loadInsurerTerms() {
  const sessionId = currentSessionId();
  const box = el("patientTermsBox");
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    if (!status.insurerConfirmed) {
      box.className = "terms-box terms-box--empty";
      box.textContent = "Insurer has not published terms yet.";
      loadedInsurerTerms = null;
      el("confirmBtn").disabled = true;
      return;
    }

    loadedInsurerTerms = status.insurer;
    box.className = "terms-box";
    box.innerHTML = `
      <div class="terms-box__row"><span>Session rate</span><strong>CHF ${rappenToChf(loadedInsurerTerms.sessionRate)}</strong></div>
      <div class="terms-box__row"><span>Franchise remaining</span><strong>CHF ${rappenToChf(loadedInsurerTerms.franchiseRemaining)}</strong></div>
      <div class="terms-box__row"><span>Co-pay</span><strong>${bpsToPercent(loadedInsurerTerms.copayBps)}%</strong></div>
      <div class="terms-box__row"><span>Platform fee</span><strong>${bpsToPercent(loadedInsurerTerms.platformFeeBps)}%</strong></div>
      <div class="terms-box__hash">terms hash: ${loadedInsurerTerms.termsHash}</div>
    `;
    el("confirmBtn").disabled = false;
    addLedgerEntry({
      title: "Loaded insurer's terms",
      meta: `hash ${loadedInsurerTerms.termsHash}`,
    });
  } catch (err) {
    box.className = "terms-box terms-box--empty";
    box.textContent = "Could not load insurer's terms yet.";
    addLedgerEntry({ title: "Load insurer's terms failed", meta: err.message, status: "error" });
  }
}

el("loadPatientBtn").addEventListener("click", loadInsurerTerms);
el("reloadInsurerTermsBtn").addEventListener("click", withSpin(el("reloadInsurerTermsBtn"), loadInsurerTerms));

// ---------- Step 2b: therapist confirms with the SAME terms ----------
el("confirmBtn").addEventListener("click", async () => {
  if (!loadedInsurerTerms) return;
  const sessionId = currentSessionId();
  const btn = el("confirmBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Submitting therapist confirmation…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      role: "therapist",
      sessionRate: loadedInsurerTerms.sessionRate,
      franchiseRemaining: loadedInsurerTerms.franchiseRemaining,
      copayBps: loadedInsurerTerms.copayBps,
      platformFeeBps: loadedInsurerTerms.platformFeeBps,
    });
    pendingEntry.remove();
    addLedgerEntry({
      title: "SESSION_CONFIRMED · therapist",
      meta: `hash ${result.termsHash}`,
    });
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Therapist confirmation failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 3: confirm attendance ----------
// Independent of step 2 — happens after the session actually takes place.
el("attendBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const btn = el("attendBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Submitting attendance attestation…", status: "pending" });
  try {
    await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/attend`, { role: "therapist" });
    pendingEntry.remove();
    addLedgerEntry({ title: "SESSION_ATTENDED · therapist" });

    // We know we just attested — show that immediately rather than waiting on
    // the mirror node, which can take a few seconds to index the new message.
    therapistAttendedLocally = true;
    renderAttendance(true);
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Attendance attestation failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

function renderAttendance(attended) {
  const box = el("attendanceBox");
  if (attended) {
    box.className = "terms-box";
    box.innerHTML = `<div class="terms-box__row"><span>Status</span><strong>Attended — attested to HCS</strong></div>`;
  } else {
    box.className = "terms-box terms-box--empty";
    box.textContent = "Not attested yet.";
  }
}

async function refreshAttendance() {
  const sessionId = currentSessionId();
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    // OR in our own local attestation — the mirror node may not have indexed
    // our attend yet, but we know it went through.
    renderAttendance(status.therapistAttended || therapistAttendedLocally);
  } catch {
    // no activity yet — fine
  }
}

// ---------- Step 4: finalize ----------
// This button is deliberately always enabled — clicking it with mismatched
// terms or missing attendance sends a real transaction that the *contract*
// rejects (PsycureInvoice.sol's own requires), rather than being silently
// blocked by this page. That's the point for a PoC demo: it proves the
// smart contract enforces these rules, not just the frontend.
el("finalizeBtn").addEventListener("click", async () => {
  if (!loadedInsurerTerms) {
    addLedgerEntry({ title: "Load insurer's terms first — nothing to finalize yet", status: "error" });
    return;
  }
  const sessionId = currentSessionId();
  const btn = el("finalizeBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Finalizing invoice on-chain…", status: "pending" });
  try {
    // No financial terms in the request body anymore — the backend derives
    // them itself from the confirmed HCS messages, renders the invoice PDF,
    // and anchors only its hash on-chain.
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/finalize`);
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
// Purely informational now — finalizeBtn is never disabled based on this
// (see the note on the finalize handler above), but refreshing status here
// still keeps the invoice box and attendance box up to date.
async function refreshFinalizeStatus() {
  const sessionId = currentSessionId();
  await refreshAttendance();
  try {
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoiceTable(el("invoiceResult"), invoice);
  } catch {
    // fine if nothing exists yet
  }
}

el("loadSessionBtn").addEventListener("click", refreshFinalizeStatus);
el("reloadFinalizeStatusBtn").addEventListener("click", withSpin(el("reloadFinalizeStatusBtn"), refreshFinalizeStatus));
el("reloadAttendanceBtn").addEventListener("click", withSpin(el("reloadAttendanceBtn"), refreshAttendance));
