const { expect } = require("chai");
const { ethers } = require("hardhat");

const ROLE_PATIENT = 0;
const ROLE_THERAPIST = 1;
const ROLE_INSURER = 2;

function termsHash(sessionRate, franchiseRemaining, copayBps, platformFeeBps) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "uint256", "uint16", "uint16"],
    [sessionRate, franchiseRemaining, copayBps, platformFeeBps]
  );
}

// Stand-in for keccak256(generatedPdfBytes) — the tests don't generate a real
// PDF, they just need a plausible non-zero bytes32 to anchor.
function invoiceHashFor(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(`invoice-pdf:${label}`));
}

describe("PsycureInvoice", function () {
  async function deployFixture() {
    const Contract = await ethers.getContractFactory("PsycureInvoice");
    const contract = await Contract.deploy(100);
    await contract.waitForDeployment();
    return contract;
  }

  it("finalizes only after all three HCS confirmations AND both attendances, anchoring the invoice hash", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-001"));
    const hash = termsHash(20_000, 5_000, 1_000, 100);
    const pdfHash = invoiceHashFor("session-001");

    await expect(contract.finalizeInvoice(sessionId, pdfHash)).to.be.revertedWith(
      "Need all three confirmations"
    );

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@11", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@12", hash);

    await expect(contract.finalizeInvoice(sessionId, pdfHash)).to.be.revertedWith(
      "Need all three confirmations"
    );

    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@13", hash);

    // All three confirmed, but nobody has attested attendance yet.
    await expect(contract.finalizeInvoice(sessionId, pdfHash)).to.be.revertedWith(
      "Both parties must have attended"
    );

    await contract.recordAttendance(sessionId, ROLE_PATIENT, "0.0.12345@14");

    // Only the patient has attested so far.
    await expect(contract.finalizeInvoice(sessionId, pdfHash)).to.be.revertedWith(
      "Both parties must have attended"
    );

    await contract.recordAttendance(sessionId, ROLE_THERAPIST, "0.0.12345@15");

    await expect(contract.finalizeInvoice(sessionId, pdfHash))
      .to.emit(contract, "InvoiceFinalized")
      .withArgs(sessionId, pdfHash);

    const invoiceResult = await contract.getInvoice(sessionId);
    const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];
    expect(invoice.finalized).to.equal(true);
    expect(invoice.invoiceHash).to.equal(pdfHash);
    expect(invoice.patientHcsMessageId).to.equal("0.0.12345@11");
    expect(invoice.therapistHcsMessageId).to.equal("0.0.12345@12");
    expect(invoice.insurerHcsMessageId).to.equal("0.0.12345@13");
    expect(invoice.patientAttended).to.equal(true);
    expect(invoice.therapistAttended).to.equal(true);
    expect(invoice.patientAttendanceHcsMessageId).to.equal("0.0.12345@14");
    expect(invoice.therapistAttendanceHcsMessageId).to.equal("0.0.12345@15");
  });

  it("rejects finalize when patient and therapist confirmed different terms", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-003"));

    // Patient confirmed a CHF 200 session, therapist confirmed CHF 250 — a real
    // mismatch that must never be allowed to settle.
    const patientHash = termsHash(20_000, 5_000, 1_000, 100);
    const therapistHash = termsHash(25_000, 5_000, 1_000, 100);

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@31", patientHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@32", therapistHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@33", patientHash);
    await contract.recordAttendance(sessionId, ROLE_PATIENT, "0.0.12345@31a");
    await contract.recordAttendance(sessionId, ROLE_THERAPIST, "0.0.12345@32a");

    await expect(contract.finalizeInvoice(sessionId, invoiceHashFor("session-003"))).to.be.revertedWith(
      "Terms mismatch between parties"
    );
  });

  it("rejects finalize when the insurer's terms don't match patient/therapist", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-003b"));

    // Patient and therapist agree, but the insurer published different franchise terms.
    const agreedHash = termsHash(20_000, 5_000, 1_000, 100);
    const insurerHash = termsHash(20_000, 8_000, 1_000, 100);

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@34", agreedHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@35", agreedHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@36", insurerHash);
    await contract.recordAttendance(sessionId, ROLE_PATIENT, "0.0.12345@34a");
    await contract.recordAttendance(sessionId, ROLE_THERAPIST, "0.0.12345@35a");

    await expect(contract.finalizeInvoice(sessionId, invoiceHashFor("session-003b"))).to.be.revertedWith(
      "Terms mismatch between parties"
    );
  });

  it("rejects finalize with a zero invoice hash", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-004"));
    const hash = termsHash(20_000, 5_000, 1_000, 100);

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@41", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@42", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@43", hash);
    await contract.recordAttendance(sessionId, ROLE_PATIENT, "0.0.12345@41a");
    await contract.recordAttendance(sessionId, ROLE_THERAPIST, "0.0.12345@42a");

    await expect(contract.finalizeInvoice(sessionId, ethers.ZeroHash)).to.be.revertedWith(
      "Invoice hash required"
    );
  });

  it("rejects finalizing the same session twice", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-004b"));
    const hash = termsHash(20_000, 5_000, 1_000, 100);

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@44", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@45", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@46", hash);
    await contract.recordAttendance(sessionId, ROLE_PATIENT, "0.0.12345@44a");
    await contract.recordAttendance(sessionId, ROLE_THERAPIST, "0.0.12345@45a");

    await contract.finalizeInvoice(sessionId, invoiceHashFor("session-004b"));

    await expect(
      contract.finalizeInvoice(sessionId, invoiceHashFor("session-004b-again"))
    ).to.be.revertedWith("Already finalized");
  });

  it("rejects a zero terms hash", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-005"));

    await expect(
      contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@51", ethers.ZeroHash)
    ).to.be.revertedWith("Terms hash required");
  });

  it("rejects an invalid role code", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-006"));
    const hash = termsHash(20_000, 5_000, 1_000, 100);

    await expect(
      contract.recordHcsConfirmation(sessionId, 3, "0.0.12345@61", hash)
    ).to.be.revertedWith("Invalid role");
  });

  it("rejects an insurer attendance attestation (only patient/therapist can attend)", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-007"));

    await expect(
      contract.recordAttendance(sessionId, ROLE_INSURER, "0.0.12345@71")
    ).to.be.revertedWith("Invalid attendance role");
  });

  it("computeTermsHash matches ethers.solidityPackedKeccak256 off-chain", async function () {
    const contract = await deployFixture();
    const onChainHash = await contract.computeTermsHash(20_000, 5_000, 1_000, 100);
    expect(onChainHash).to.equal(termsHash(20_000, 5_000, 1_000, 100));
  });
});
