const el = (id) => document.getElementById(id);

// Contract stores everything in integer minor units (rappen) and basis points.
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
    const res = await fetch("/api/default-fee");
    if (res.status >= 200 && res.status < 600) {
      dot.classList.add("ok");
      label.textContent = "server reachable";
    }
  } catch {
    dot.classList.add("err");
    label.textContent = "server unreachable — is `npm run web` running?";
  }
}

function renderInvoiceTable(container, invoice) {
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

checkNetwork();
