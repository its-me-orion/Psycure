// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PsycureInvoice
/// @notice Records patient/therapist/insurer HCS confirmations and patient/therapist
///         attendance attestations for a session, and finalizes a session only
///         once all three parties have confirmed the *exact same* terms AND both
///         patient and therapist have attested they actually attended. The terms
///         each party confirmed are committed as a hash at confirmation time, and
///         finalize() requires all three to be identical — so the platform (owner)
///         cannot finalize a session where patient, therapist and insurer never
///         actually agreed, and cannot settle a session nobody attested to
///         attending. The invoice itself (session rate, franchise/co-pay split,
///         final CHF amounts) is computed and rendered off-chain as a PDF;
///         finalize() only anchors a hash of that document on-chain, so no raw
///         financial figures are stored in contract state or emitted in events.
contract PsycureInvoice {
    // Role codes used by recordHcsConfirmation / HcsConfirmationRecorded.
    uint8 public constant ROLE_PATIENT = 0;
    uint8 public constant ROLE_THERAPIST = 1;
    uint8 public constant ROLE_INSURER = 2;

    struct SessionInvoice {
        bool patientConfirmed;
        bool therapistConfirmed;
        bool insurerConfirmed;
        bool patientAttended;
        bool therapistAttended;
        bool finalized;
        string patientHcsMessageId;
        string therapistHcsMessageId;
        string insurerHcsMessageId;
        string patientAttendanceHcsMessageId;
        string therapistAttendanceHcsMessageId;
        bytes32 patientTermsHash;
        bytes32 therapistTermsHash;
        bytes32 insurerTermsHash;
        bytes32 invoiceHash;
    }

    mapping(bytes32 => SessionInvoice) private invoices;

    address public immutable owner;
    uint16 public defaultPlatformFeeBps;

    event HcsConfirmationRecorded(
        bytes32 indexed sessionId,
        uint8 indexed role,
        string hcsMessageId,
        bytes32 termsHash
    );
    event AttendanceRecorded(bytes32 indexed sessionId, uint8 indexed role, string hcsMessageId);
    event InvoiceFinalized(bytes32 indexed sessionId, bytes32 invoiceHash);

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

    /// @notice Computes the terms hash a client must independently derive and match
    ///         before confirming, given the exact settlement parameters.
    function computeTermsHash(
        uint256 sessionRate,
        uint256 franchiseRemaining,
        uint16 copayBps,
        uint16 platformFeeBps
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sessionRate, franchiseRemaining, copayBps, platformFeeBps));
    }

    /// @param role One of ROLE_PATIENT / ROLE_THERAPIST / ROLE_INSURER.
    /// @param termsHash Must equal computeTermsHash(...) of the terms this party is confirming.
    function recordHcsConfirmation(
        bytes32 sessionId,
        uint8 role,
        string calldata hcsMessageId,
        bytes32 termsHash
    ) external onlyOwner {
        require(termsHash != bytes32(0), "Terms hash required");
        require(role <= ROLE_INSURER, "Invalid role");

        SessionInvoice storage invoice = invoices[sessionId];
        require(!invoice.finalized, "Already finalized");

        if (role == ROLE_PATIENT) {
            invoice.patientConfirmed = true;
            invoice.patientHcsMessageId = hcsMessageId;
            invoice.patientTermsHash = termsHash;
        } else if (role == ROLE_THERAPIST) {
            invoice.therapistConfirmed = true;
            invoice.therapistHcsMessageId = hcsMessageId;
            invoice.therapistTermsHash = termsHash;
        } else {
            invoice.insurerConfirmed = true;
            invoice.insurerHcsMessageId = hcsMessageId;
            invoice.insurerTermsHash = termsHash;
        }
        emit HcsConfirmationRecorded(sessionId, role, hcsMessageId, termsHash);
    }

    /// @param role Must be ROLE_PATIENT or ROLE_THERAPIST — the insurer does not
    ///        attend a session, so it is not a valid attendance role.
    function recordAttendance(
        bytes32 sessionId,
        uint8 role,
        string calldata hcsMessageId
    ) external onlyOwner {
        require(role == ROLE_PATIENT || role == ROLE_THERAPIST, "Invalid attendance role");

        SessionInvoice storage invoice = invoices[sessionId];
        require(!invoice.finalized, "Already finalized");

        if (role == ROLE_PATIENT) {
            invoice.patientAttended = true;
            invoice.patientAttendanceHcsMessageId = hcsMessageId;
        } else {
            invoice.therapistAttended = true;
            invoice.therapistAttendanceHcsMessageId = hcsMessageId;
        }
        emit AttendanceRecorded(sessionId, role, hcsMessageId);
    }

    function canFinalize(bytes32 sessionId) external view returns (bool) {
        SessionInvoice storage invoice = invoices[sessionId];
        return
            invoice.patientConfirmed &&
            invoice.therapistConfirmed &&
            invoice.insurerConfirmed &&
            invoice.patientAttended &&
            invoice.therapistAttended &&
            !invoice.finalized &&
            invoice.patientTermsHash == invoice.therapistTermsHash &&
            invoice.patientTermsHash == invoice.insurerTermsHash;
    }

    /// @param invoiceHash keccak256 of the off-chain-generated invoice PDF —
    ///        the actual session rate, franchise/co-pay split and settled CHF
    ///        amounts are computed and rendered off-chain and never touch
    ///        contract state; this anchors that specific document as
    ///        tamper-evident without putting the raw figures on a public ledger.
    function finalizeInvoice(bytes32 sessionId, bytes32 invoiceHash) external onlyOwner {
        SessionInvoice storage invoice = invoices[sessionId];
        require(
            invoice.patientConfirmed && invoice.therapistConfirmed && invoice.insurerConfirmed,
            "Need all three confirmations"
        );
        require(invoice.patientAttended && invoice.therapistAttended, "Both parties must have attended");
        require(!invoice.finalized, "Already finalized");
        require(invoiceHash != bytes32(0), "Invoice hash required");

        // All three parties must have committed to the identical terms hash —
        // this is what prevents the operator from finalizing a session that
        // patient, therapist and insurer never actually agreed to, and it
        // never required raw numbers on-chain to check.
        require(invoice.patientTermsHash == invoice.therapistTermsHash, "Terms mismatch between parties");
        require(invoice.patientTermsHash == invoice.insurerTermsHash, "Terms mismatch between parties");

        invoice.finalized = true;
        invoice.invoiceHash = invoiceHash;

        emit InvoiceFinalized(sessionId, invoiceHash);
    }

    function getInvoice(bytes32 sessionId) external view returns (SessionInvoice memory) {
        return invoices[sessionId];
    }
}
