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
        string patientHcsMessageId;
        string therapistHcsMessageId;
    }

    mapping(bytes32 => SessionInvoice) private invoices;

    address public immutable owner;
    uint16 public defaultPlatformFeeBps;

    event HcsConfirmationRecorded(bytes32 indexed sessionId, bool indexed isPatient, string hcsMessageId);
    event InvoiceFinalized(
        bytes32 indexed sessionId,
        uint256 sessionRate,
        uint256 patientAmount,
        uint256 insurerAmount,
        uint256 platformFeeAmount,
        uint256 therapistPayout
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

    function recordHcsConfirmation(bytes32 sessionId, bool isPatient, string calldata hcsMessageId) external onlyOwner {
        SessionInvoice storage invoice = invoices[sessionId];
        if (isPatient) {
            invoice.patientConfirmed = true;
            invoice.patientHcsMessageId = hcsMessageId;
        } else {
            invoice.therapistConfirmed = true;
            invoice.therapistHcsMessageId = hcsMessageId;
        }
        emit HcsConfirmationRecorded(sessionId, isPatient, hcsMessageId);
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

        emit InvoiceFinalized(sessionId, sessionRate, patientAmount, insurerAmount, platformFeeAmount, therapistPayout);
    }

    function getInvoice(bytes32 sessionId) external view returns (SessionInvoice memory) {
        return invoices[sessionId];
    }
}
