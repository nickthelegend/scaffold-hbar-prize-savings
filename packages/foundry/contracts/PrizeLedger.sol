// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PrizeLedger
/// @notice Pure bookkeeping for a prize-savings pool: principal per saver, rounds, and time-weighted odds.
/// @dev Holds no HBAR and calls nothing, so every rule here is unit- and fuzz-tested in plain Foundry. PrizePool owns
///      one `Ledger` and wraps it with the Hedera services (HTS, HSS, PRNG) that are tested on a real network.
///
///      Odds: a saver's weight for a round is balance × seconds held within the round. Weights are settled lazily:
///      an account is only written when its balance changes, and an account untouched this round implicitly weighs
///      `balance × roundDuration`.
library PrizeLedger {
    struct Account {
        uint128 balance;
        uint64 lastUpdated;
        uint64 round;
        uint256 weight;
    }

    struct Ledger {
        uint256 currentRound;
        uint256 roundStart;
        uint256 roundEnd;
        uint256 totalPrincipal;
        mapping(address => Account) accounts;
        address[] participants;
        mapping(address => uint256) participantIndex; // index + 1; 0 means absent
    }

    error InsufficientBalance(uint256 balance);
    error TooManyParticipants(uint256 maxParticipants);

    /// Starts round `round` now, lasting `duration` seconds.
    function openRound(Ledger storage self, uint256 round, uint256 duration) internal {
        self.currentRound = round;
        self.roundStart = block.timestamp;
        self.roundEnd = block.timestamp + duration;
    }

    /// Adds `amount` to `user`'s principal. Returns whether the user already had a balance before.
    function credit(Ledger storage self, address user, uint256 amount, uint256 maxParticipants)
        internal
        returns (bool wasHolder)
    {
        Account storage account = _accrue(self, user);
        wasHolder = account.balance > 0;
        if (!wasHolder) {
            if (self.participants.length >= maxParticipants) revert TooManyParticipants(maxParticipants);
            self.participants.push(user);
            self.participantIndex[user] = self.participants.length;
        }
        account.balance += uint128(amount);
        self.totalPrincipal += amount;
    }

    /// Removes `amount` from `user`'s principal. Returns whether the user still has a balance afterwards.
    function debit(Ledger storage self, address user, uint256 amount) internal returns (bool stillHolder) {
        Account storage account = _accrue(self, user);
        if (amount > account.balance) revert InsufficientBalance(account.balance);
        account.balance -= uint128(amount);
        self.totalPrincipal -= amount;
        stillHolder = account.balance > 0;
        if (!stillHolder) _removeParticipant(self, user);
    }

    /// Every participant's weight projected to the end of the round, in `participants` order.
    function roundWeights(Ledger storage self) internal view returns (uint256[] memory weights, uint256 totalWeight) {
        uint256 count = self.participants.length;
        weights = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            uint256 weight = projectedWeight(self, self.participants[i]);
            weights[i] = weight;
            totalWeight += weight;
        }
    }

    /// The participant whose cumulative-weight slice contains `random % totalWeight`. `totalWeight` must be > 0.
    function pickWinner(Ledger storage self, uint256[] memory weights, uint256 totalWeight, uint256 random)
        internal
        view
        returns (address)
    {
        uint256 target = random % totalWeight;
        uint256 cumulative;
        for (uint256 i; i < weights.length; ++i) {
            cumulative += weights[i];
            if (target < cumulative) return self.participants[i];
        }
        // Unreachable: target < totalWeight == sum(weights).
        return self.participants[weights.length - 1];
    }

    /// `user`'s weight for the current round, assuming no further balance changes before it ends.
    function projectedWeight(Ledger storage self, address user) internal view returns (uint256) {
        Account storage account = self.accounts[user];
        if (account.round != self.currentRound) return account.balance * (self.roundEnd - self.roundStart);
        return account.weight + account.balance * (self.roundEnd - account.lastUpdated);
    }

    function balanceOf(Ledger storage self, address user) internal view returns (uint256) {
        return self.accounts[user].balance;
    }

    /// Settles `user`'s weight up to now (capped at `roundEnd`) before their balance changes.
    function _accrue(Ledger storage self, address user) private returns (Account storage account) {
        account = self.accounts[user];
        uint256 at = block.timestamp < self.roundEnd ? block.timestamp : self.roundEnd;
        if (account.round != self.currentRound) {
            // The balance has not changed since before this round started.
            account.weight = account.balance * (at - self.roundStart);
            account.round = uint64(self.currentRound);
        } else {
            account.weight += account.balance * (at - account.lastUpdated);
        }
        account.lastUpdated = uint64(at);
    }

    function _removeParticipant(Ledger storage self, address user) private {
        uint256 index = self.participantIndex[user] - 1;
        address last = self.participants[self.participants.length - 1];
        self.participants[index] = last;
        self.participantIndex[last] = index + 1;
        self.participants.pop();
        delete self.participantIndex[user];
    }
}
