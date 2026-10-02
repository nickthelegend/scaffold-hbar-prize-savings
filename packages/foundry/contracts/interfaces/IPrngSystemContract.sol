// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// Hedera pseudorandom number generator system contract at 0x169 (HIP-351).
/// The seed is derived from the running hash of a recent transaction record, so it is not
/// predictable before the transaction reaches consensus.
interface IPrngSystemContract {
    function getPseudorandomSeed() external returns (bytes32 seed);
}
