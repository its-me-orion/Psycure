// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PsycureInvoice {
    struct SessionInvoice {
        bool patientConfirmed;
        bool therapistConfirmed;
        bool finalized;
        uint256 sessionRate;
        uint256 franchiseRemaining;
        uint16 copayBps;
        uint16 platformFeeBps;
        uint256 patientAmount;
        uint256 insurerAmount;
        uint256 platformFeeAmount;
        uint256 therapistPayout;
        bytes32 patientTermsHash;
        bytes32 therapistTermsHash;
        bytes32 finalizedTermsHash;
        string patientHcsMessageId;
        string therapistHcsMessageId;
    }

    mapping(bytes32 => SessionInvoice) private invoices;

    address public immutable owner;
    uint16 public defaultPlatformFeeBps;

    event HcsConfirmationRecorded(bytes32 indexed sessionId, bool indexed isPatient, string hcsMessageId, bytes32 termsHash);
    event InvoiceFinalized(
        bytes32 indexed sessionId,
        uint256 sessionRate,
        uint256 patientAmount,
        uint256 insurerAmount,
        uint256 platformFeeAmount,
        uint256 therapistPayout,
        bytes32 termsHash
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(uint16 initialDefaultPlatformFeeBps) {
        require(initialDefaultPlatformFeeBps <= 10_000, "Fee too high");
        owner = msg.sender;
        defaultPlatformFeeBps = initialDefaultPlatformFeeBps;
    }

    function setDefaultPlatformFeeBps(uint16 newDefaultFeeBps) external onlyOwner {
        require(newDefaultFeeBps <= 10_000, "Fee too high");
        defaultPlatformFeeBps = newDefaultFeeBps;
    }

    function computeTermsHash(
        bytes32 sessionId,
        uint256 sessionRate,
        uint256 franchiseRemaining,
        uint16 copayBps
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sessionId, sessionRate, franchiseRemaining, copayBps));
    }

    function recordHcsConfirmation(
        bytes32 sessionId,
        bool isPatient,
        string calldata hcsMessageId,
        bytes32 termsHash
    ) external onlyOwner {
        require(bytes(hcsMessageId).length > 0, "Missing HCS message ID");
        require(termsHash != bytes32(0), "Missing terms hash");
        SessionInvoice storage invoice = invoices[sessionId];
        if (isPatient) {
            if (invoice.therapistConfirmed) {
                require(invoice.therapistTermsHash == termsHash, "Terms hash mismatch");
            }
            invoice.patientConfirmed = true;
            invoice.patientHcsMessageId = hcsMessageId;
            invoice.patientTermsHash = termsHash;
        } else {
            if (invoice.patientConfirmed) {
                require(invoice.patientTermsHash == termsHash, "Terms hash mismatch");
            }
            invoice.therapistConfirmed = true;
            invoice.therapistHcsMessageId = hcsMessageId;
            invoice.therapistTermsHash = termsHash;
        }
        emit HcsConfirmationRecorded(sessionId, isPatient, hcsMessageId, termsHash);
    }

    function canFinalize(bytes32 sessionId) external view returns (bool) {
        SessionInvoice storage invoice = invoices[sessionId];
        return invoice.patientConfirmed && invoice.therapistConfirmed && !invoice.finalized;
    }

    function finalizeInvoice(
        bytes32 sessionId,
        uint256 sessionRate,
        uint256 franchiseRemaining,
        uint16 copayBps,
        uint16 platformFeeBps
    ) external onlyOwner {
        SessionInvoice storage invoice = invoices[sessionId];
        require(invoice.patientConfirmed && invoice.therapistConfirmed, "Need both confirmations");
        require(!invoice.finalized, "Already finalized");
        require(copayBps <= 10_000, "Copay too high");
        require(invoice.patientTermsHash != bytes32(0) && invoice.therapistTermsHash != bytes32(0), "Missing terms hash");
        require(invoice.patientTermsHash == invoice.therapistTermsHash, "Terms hash mismatch");

        bytes32 expectedTermsHash = computeTermsHash(sessionId, sessionRate, franchiseRemaining, copayBps);
        require(invoice.patientTermsHash == expectedTermsHash, "Terms hash mismatch");

        uint16 resolvedPlatformFeeBps = platformFeeBps == 0 ? defaultPlatformFeeBps : platformFeeBps;
        require(resolvedPlatformFeeBps <= 10_000, "Fee too high");

        uint256 patientBeforeCopay = franchiseRemaining >= sessionRate ? sessionRate : franchiseRemaining;
        uint256 remainder = sessionRate - patientBeforeCopay;
        uint256 copayAmount = (remainder * copayBps) / 10_000;

        uint256 patientAmount = patientBeforeCopay + copayAmount;
        uint256 insurerAmount = sessionRate - patientAmount;

        uint256 platformFeeAmount = (sessionRate * resolvedPlatformFeeBps) / 10_000;
        uint256 therapistPayout = sessionRate - platformFeeAmount;

        invoice.finalized = true;
        invoice.sessionRate = sessionRate;
        invoice.franchiseRemaining = franchiseRemaining;
        invoice.copayBps = copayBps;
        invoice.platformFeeBps = resolvedPlatformFeeBps;
        invoice.patientAmount = patientAmount;
        invoice.insurerAmount = insurerAmount;
        invoice.platformFeeAmount = platformFeeAmount;
        invoice.therapistPayout = therapistPayout;
        invoice.finalizedTermsHash = expectedTermsHash;

        emit InvoiceFinalized(sessionId, sessionRate, patientAmount, insurerAmount, platformFeeAmount, therapistPayout, expectedTermsHash);
    }

    function getInvoice(bytes32 sessionId) external view returns (SessionInvoice memory) {
        return invoices[sessionId];
    }
}
