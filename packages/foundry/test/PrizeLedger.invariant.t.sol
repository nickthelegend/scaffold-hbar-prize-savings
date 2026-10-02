// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { PrizeLedgerHarness } from "./PrizeLedger.t.sol";

/// Random deposits, withdrawals, prize credits, time jumps and round changes against the real library code.
contract PrizeLedgerHandler is Test {
    uint256 internal constant ROUND = 1 days;

    PrizeLedgerHarness public immutable ledger;
    address[] public actors;
    /// Last round in which each actor's balance changed, to check the lazy weight accounting.
    mapping(address => uint256) public lastTouchedRound;

    constructor(PrizeLedgerHarness ledger_) {
        ledger = ledger_;
        for (uint256 i; i < 6; ++i) {
            actors.push(address(uint160(0xA11CE + i)));
        }
    }

    function credit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        if (ledger.balanceOf(actor) == 0 && ledger.participants().length >= ledger.maxParticipants()) return;
        ledger.credit(actor, bound(amount, 1, 1e14));
        lastTouchedRound[actor] = ledger.currentRound();
    }

    function debit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = ledger.balanceOf(actor);
        if (balance == 0) return;
        ledger.debit(actor, bound(amount, 1, balance));
        lastTouchedRound[actor] = ledger.currentRound();
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 days));
    }

    function nextRound() external {
        if (block.timestamp < ledger.roundEnd()) vm.warp(ledger.roundEnd());
        ledger.openRound(ledger.currentRound() + 1, ROUND);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract PrizeLedgerInvariantTest is Test {
    uint256 internal constant ROUND = 1 days;

    PrizeLedgerHarness internal ledger;
    PrizeLedgerHandler internal handler;

    function setUp() public {
        ledger = new PrizeLedgerHarness(5);
        ledger.openRound(1, ROUND);
        handler = new PrizeLedgerHandler(ledger);
        targetContract(address(handler));
    }

    /// Balances always sum to the principal the pool must hold.
    function invariant_balancesSumToPrincipal() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += ledger.balanceOf(handler.actors(i));
        }
        assertEq(sum, ledger.totalPrincipal());
    }

    /// Participants are exactly the accounts with a balance, without duplicates, within the cap.
    function invariant_participantsAreTheHolders() public view {
        address[] memory list = ledger.participants();
        uint256 holders;
        for (uint256 i; i < handler.actorCount(); ++i) {
            if (ledger.balanceOf(handler.actors(i)) > 0) ++holders;
        }
        assertEq(list.length, holders);
        assertLe(list.length, ledger.maxParticipants());
        for (uint256 i; i < list.length; ++i) {
            assertGt(ledger.balanceOf(list[i]), 0);
            for (uint256 j = i + 1; j < list.length; ++j) {
                assertTrue(list[i] != list[j]);
            }
        }
    }

    /// Lazy accounting: anyone whose balance has not changed this round weighs exactly balance × round length,
    /// and the reported total is the sum of individual weights.
    function invariant_untouchedHoldersWeighFullRound() public view {
        (uint256[] memory weights, uint256 total) = ledger.weights();
        uint256 sum;
        for (uint256 i; i < weights.length; ++i) {
            sum += weights[i];
        }
        assertEq(sum, total);

        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            if (handler.lastTouchedRound(actor) < ledger.currentRound()) {
                assertEq(ledger.projectedWeight(actor), ledger.balanceOf(actor) * ROUND);
            }
        }
    }
}
