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

describe("PsycureInvoice", function () {
  async function deployFixture() {
    const Contract = await ethers.getContractFactory("PsycureInvoice");
    const contract = await Contract.deploy(100);
    await contract.waitForDeployment();
    return contract;
  }

  it("finalizes invoice only after all three HCS confirmations", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-001"));
    const hash = termsHash(20_000, 5_000, 1_000, 100);

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 100)).to.be.revertedWith(
      "Need all three confirmations"
    );

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@11", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@12", hash);

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 100)).to.be.revertedWith(
      "Need all three confirmations"
    );

    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@13", hash);

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 100))
      .to.emit(contract, "InvoiceFinalized")
      .withArgs(sessionId, 20_000, 6_500, 13_500, 200, 19_800);

    const invoiceResult = await contract.getInvoice(sessionId);
    const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];
    expect(invoice.finalized).to.equal(true);
    expect(invoice.patientAmount).to.equal(6_500);
    expect(invoice.insurerAmount).to.equal(13_500);
    expect(invoice.platformFeeAmount).to.equal(200);
    expect(invoice.therapistPayout).to.equal(19_800);
    expect(invoice.patientHcsMessageId).to.equal("0.0.12345@11");
    expect(invoice.therapistHcsMessageId).to.equal("0.0.12345@12");
    expect(invoice.insurerHcsMessageId).to.equal("0.0.12345@13");
  });

  it("supports a custom platform fee agreed by all three parties", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-002"));
    const hash = termsHash(15_000, 0, 1_000, 250);

    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@21", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@22", hash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@23", hash);

    await contract.finalizeInvoice(sessionId, 15_000, 0, 1_000, 250);

    const invoiceResult = await contract.getInvoice(sessionId);
    const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];
    expect(invoice.platformFeeBps).to.equal(250);
    expect(invoice.platformFeeAmount).to.equal(375);
    expect(invoice.therapistPayout).to.equal(14_625);
    expect(invoice.patientAmount).to.equal(1_500);
    expect(invoice.insurerAmount).to.equal(13_500);
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

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 100)).to.be.revertedWith(
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

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 100)).to.be.revertedWith(
      "Terms mismatch between parties"
    );
  });

  it("rejects finalize when the submitted numbers don't match the agreed hash", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-004"));

    // All three parties agreed on the same terms hash...
    const agreedHash = termsHash(20_000, 5_000, 1_000, 100);
    await contract.recordHcsConfirmation(sessionId, ROLE_PATIENT, "0.0.12345@41", agreedHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_THERAPIST, "0.0.12345@42", agreedHash);
    await contract.recordHcsConfirmation(sessionId, ROLE_INSURER, "0.0.12345@43", agreedHash);

    // ...but finalize is attempted with a different session rate than what was hashed.
    await expect(contract.finalizeInvoice(sessionId, 99_000, 5_000, 1_000, 100)).to.be.revertedWith(
      "Finalize terms do not match confirmed terms"
    );
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

  it("computeTermsHash matches ethers.solidityPackedKeccak256 off-chain", async function () {
    const contract = await deployFixture();
    const onChainHash = await contract.computeTermsHash(20_000, 5_000, 1_000, 100);
    expect(onChainHash).to.equal(termsHash(20_000, 5_000, 1_000, 100));
  });
});
