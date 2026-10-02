// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// Subset of the Hedera Schedule Service system contract at 0x16b (HIP-1215).
/// A contract can schedule a call to any contract, including itself, for a future consensus second.
interface IHederaScheduleService {
    /// @param to Contract to call when the schedule executes.
    /// @param expirySecond Consensus second at which the call executes.
    /// @param gasLimit Gas available to the scheduled call.
    /// @param value Tinybars sent with the call.
    /// @param callData ABI-encoded call.
    /// @return responseCode SUCCESS is 22.
    /// @return scheduleAddress Address of the created schedule entity.
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    /// Whether `expirySecond` still has throttle capacity for a call with `gasLimit`.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);
}
