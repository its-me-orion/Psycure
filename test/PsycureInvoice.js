const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PsycureInvoice", function () {
  async function deployFixture() {
    const Contract = await ethers.getContractFactory("PsycureInvoice");
    const contract = await Contract.deploy(100);
    await contract.waitForDeployment();
    return contract;
  }

  it("finalizes invoice only after both HCS confirmations", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-001"));
    const termsHash = await contract.computeTermsHash(sessionId, 20_000, 5_000, 1_000);

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 0)).to.be.revertedWith(
      "Need both confirmations"
    );

    await contract.recordHcsConfirmation(sessionId, true, "0.0.12345@11", termsHash);
    await contract.recordHcsConfirmation(sessionId, false, "0.0.12345@12", termsHash);

    await expect(contract.finalizeInvoice(sessionId, 20_000, 5_000, 1_000, 0))
      .to.emit(contract, "InvoiceFinalized")
      .withArgs(sessionId, 20_000, 6_500, 13_500, 200, 19_800, termsHash);

    const invoiceResult = await contract.getInvoice(sessionId);
    const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];
    expect(invoice.finalized).to.equal(true);
    expect(invoice.patientAmount).to.equal(6_500);
    expect(invoice.insurerAmount).to.equal(13_500);
    expect(invoice.platformFeeAmount).to.equal(200);
    expect(invoice.therapistPayout).to.equal(19_800);
    expect(invoice.patientTermsHash).to.equal(termsHash);
    expect(invoice.therapistTermsHash).to.equal(termsHash);
    expect(invoice.finalizedTermsHash).to.equal(termsHash);
    expect(invoice.patientHcsMessageId).to.equal("0.0.12345@11");
    expect(invoice.therapistHcsMessageId).to.equal("0.0.12345@12");
  });

  it("supports overriding platform fee per invoice", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-002"));
    const termsHash = await contract.computeTermsHash(sessionId, 15_000, 0, 1_000);

    await contract.recordHcsConfirmation(sessionId, true, "0.0.12345@21", termsHash);
    await contract.recordHcsConfirmation(sessionId, false, "0.0.12345@22", termsHash);

    await contract.finalizeInvoice(sessionId, 15_000, 0, 1_000, 250);

    const invoiceResult = await contract.getInvoice(sessionId);
    const invoice = invoiceResult.finalized !== undefined ? invoiceResult : invoiceResult[0];
    expect(invoice.platformFeeBps).to.equal(250);
    expect(invoice.platformFeeAmount).to.equal(375);
    expect(invoice.therapistPayout).to.equal(14_625);
    expect(invoice.patientAmount).to.equal(1_500);
    expect(invoice.insurerAmount).to.equal(13_500);
  });

  it("rejects finalization when confirmed hash doesn't match submitted values", async function () {
    const contract = await deployFixture();
    const sessionId = ethers.keccak256(ethers.toUtf8Bytes("session-003"));
    const termsHash = await contract.computeTermsHash(sessionId, 18_000, 8_000, 1_000);

    await contract.recordHcsConfirmation(sessionId, true, "0.0.12345@31", termsHash);
    await contract.recordHcsConfirmation(sessionId, false, "0.0.12345@32", termsHash);

    await expect(contract.finalizeInvoice(sessionId, 18_000, 7_000, 1_000, 0)).to.be.revertedWith("Terms hash mismatch");
  });
});
