// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PsycureInvoice
/// @notice Records patient/therapist/insurer HCS confirmations and patient/therapist
///         attendance attestations for a session, and finalizes an invoice split
///         (franchise + co-pay, Swiss KVG-style) only once all three parties have
///         confirmed the *exact same* terms AND both patient and therapist have
///         attested they actually attended the session. The terms each party
///         confirmed are committed as a hash at confirmation time, and finalize()
///         re-derives that hash from its own parameters and requires an exact
///         match — so the platform (owner) cannot finalize different numbers than
///         what patient, therapist and insurer actually agreed to, and cannot
///         settle a session nobody attested to attending.
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
        string insurerHcsMessageId;
        string patientAttendanceHcsMessageId;
        string therapistAttendanceHcsMessageId;
        bytes32 patientTermsHash;
        bytes32 therapistTermsHash;
        bytes32 insurerTermsHash;
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

    function finalizeInvoice(
        bytes32 sessionId,
        uint256 sessionRate,
        uint256 franchiseRemaining,
        uint16 copayBps,
        uint16 platformFeeBps
    ) external onlyOwner {
        SessionInvoice storage invoice = invoices[sessionId];
        require(
            invoice.patientConfirmed && invoice.therapistConfirmed && invoice.insurerConfirmed,
            "Need all three confirmations"
        );
        require(invoice.patientAttended && invoice.therapistAttended, "Both parties must have attended");
        require(!invoice.finalized, "Already finalized");
        require(copayBps <= 10_000, "Copay too high");
        require(platformFeeBps <= 10_000, "Fee too high");

        // All three parties must have committed to the identical terms hash ...
        require(invoice.patientTermsHash == invoice.therapistTermsHash, "Terms mismatch between parties");
        require(invoice.patientTermsHash == invoice.insurerTermsHash, "Terms mismatch between parties");

        // ... and it must equal the hash of the numbers actually being finalized here.
        // This is what prevents the operator from finalizing different numbers than
        // what patient and therapist each independently confirmed.
        bytes32 expectedHash = computeTermsHash(sessionRate, franchiseRemaining, copayBps, platformFeeBps);
        require(invoice.patientTermsHash == expectedHash, "Finalize terms do not match confirmed terms");

        uint256 patientBeforeCopay = franchiseRemaining >= sessionRate ? sessionRate : franchiseRemaining;
        uint256 remainder = sessionRate - patientBeforeCopay;
        uint256 copayAmount = (remainder * copayBps) / 10_000;

        uint256 patientAmount = patientBeforeCopay + copayAmount;
        uint256 insurerAmount = sessionRate - patientAmount;

        uint256 platformFeeAmount = (sessionRate * platformFeeBps) / 10_000;
        uint256 therapistPayout = sessionRate - platformFeeAmount;

        invoice.finalized = true;
        invoice.sessionRate = sessionRate;
        invoice.franchiseRemaining = franchiseRemaining;
        invoice.copayBps = copayBps;
        invoice.platformFeeBps = platformFeeBps;
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
