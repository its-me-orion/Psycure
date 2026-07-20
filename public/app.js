const el = (id) => document.getElementById(id);

// Contract stores everything in integer minor units (rappen) and basis points.
// These helpers keep the UI in familiar CHF / % while the API stays unchanged.
function chfToRappen(chfValue) {
  return Math.round(parseFloat(chfValue || "0") * 100);
}

function rappenToChf(rappenValue) {
  return (Number(rappenValue) / 100).toFixed(2);
}

function percentToBps(percentValue) {
  return Math.round(parseFloat(percentValue || "0") * 100);
}

function bpsToPercent(bpsValue) {
  return (Number(bpsValue) / 100).toFixed(2);
}

function currentSessionId() {
  return el("sessionId").value.trim();
}

function addLedgerEntry({ title, meta, status = "ok" }) {
  const container = el("ledgerEntries");
  const empty = container.querySelector(".ledger__empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = `ledger-entry ${status === "pending" ? "pending" : ""} ${status === "error" ? "error" : ""}`.trim();

  const titleEl = document.createElement("div");
  titleEl.className = "ledger-entry__title";
  titleEl.textContent = title;
  entry.appendChild(titleEl);

  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "ledger-entry__meta";
    metaEl.textContent = meta;
    entry.appendChild(metaEl);
  }

  container.prepend(entry);
  return entry;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function checkNetwork() {
  const dot = el("netDot");
  const label = el("netLabel");
  try {
    const res = await fetch("/api/sessions/__ping__/confirmations");
    if (res.status >= 200 && res.status < 600) {
      dot.classList.add("ok");
      label.textContent = "server reachable";
    }
  } catch {
    dot.classList.add("err");
    label.textContent = "server unreachable — is `npm run web` running?";
  }
}

async function refreshConfirmationStatus() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  try {
    const status = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/confirmations`);
    setConfirmState("patient", status.patientConfirmed);
    setConfirmState("therapist", status.therapistConfirmed);
  } catch (err) {
    // Topic may not exist yet for a brand-new session — that's expected, stay quiet.
  }
}

function setConfirmState(role, confirmed) {
  const stateEl = el(role === "patient" ? "patientState" : "therapistState");
  stateEl.textContent = confirmed ? "confirmed" : "not confirmed";
  stateEl.classList.toggle("confirmed", Boolean(confirmed));
}

function renderInvoice(invoice) {
  const container = el("invoiceResult");
  if (!invoice.finalized) {
    container.className = "invoice-result invoice-result--empty";
    container.textContent = "No invoice finalized yet for this session.";
    return;
  }

  const rows = [
    ["Session rate", `CHF ${rappenToChf(invoice.sessionRate)}`],
    ["Franchise remaining", `CHF ${rappenToChf(invoice.franchiseRemaining)}`],
    ["Co-pay", `${bpsToPercent(invoice.copayBps)}%`],
    ["Platform fee", `${bpsToPercent(invoice.platformFeeBps)}%`],
    ["Patient pays", `CHF ${rappenToChf(invoice.patientAmount)}`],
    ["Insurer pays", `CHF ${rappenToChf(invoice.insurerAmount)}`],
    ["Platform fee amount", `CHF ${rappenToChf(invoice.platformFeeAmount)}`],
    ["Therapist payout", `CHF ${rappenToChf(invoice.therapistPayout)}`],
  ];

  container.className = "invoice-result";
  container.innerHTML = `
    <table class="invoice-table">
      ${rows
        .map(
          ([label, value], i) =>
            `<tr class="${i === 4 || i === 5 ? "highlight" : ""}"><td>${label}</td><td>${value}</td></tr>`
        )
        .join("")}
    </table>
  `;
}

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
    });
    pendingEntry.remove();
    addLedgerEntry({
      title: `SESSION_CREATED · ${sessionId}`,
      meta: `topic ${result.topicId} · seq #${result.sequenceNumber}`,
    });
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Create session failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 2: confirm session ----------
document.querySelectorAll(".confirm-card button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const role = btn.dataset.role;
    const sessionId = currentSessionId();
    btn.disabled = true;
    const pendingEntry = addLedgerEntry({ title: `Submitting ${role} confirmation…`, status: "pending" });
    try {
      const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, { role });
      pendingEntry.remove();
      addLedgerEntry({
        title: `SESSION_CONFIRMED · ${role}`,
        meta: `seq #${result.sequenceNumber}`,
      });
      setConfirmState(role, true);
    } catch (err) {
      pendingEntry.remove();
      addLedgerEntry({ title: `${role} confirmation failed`, meta: err.message, status: "error" });
    } finally {
      btn.disabled = false;
    }
  });
});

// ---------- Step 3: finalize invoice ----------
el("finalizeBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  const btn = el("finalizeBtn");
  btn.disabled = true;
  const pendingEntry = addLedgerEntry({ title: "Finalizing invoice on-chain…", status: "pending" });
  try {
    const result = await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/finalize`, {
      sessionRate: chfToRappen(el("f-rate").value),
      franchiseRemaining: chfToRappen(el("f-franchise").value),
      copayBps: percentToBps(el("f-copay").value),
      platformFeeBps: percentToBps(el("f-fee").value),
    });
    pendingEntry.remove();
    addLedgerEntry({
      title: "Invoice finalized",
      meta: `tx ${result.transactionHash}`,
    });
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoice(invoice);
  } catch (err) {
    pendingEntry.remove();
    addLedgerEntry({ title: "Finalize failed", meta: err.message, status: "error" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 4: view invoice ----------
el("viewBtn").addEventListener("click", async () => {
  const sessionId = currentSessionId();
  try {
    const invoice = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}/invoice`);
    renderInvoice(invoice);
  } catch (err) {
    addLedgerEntry({ title: "View invoice failed", meta: err.message, status: "error" });
  }
});

// ---------- Load status button ----------
el("loadSessionBtn").addEventListener("click", refreshConfirmationStatus);

checkNetwork();