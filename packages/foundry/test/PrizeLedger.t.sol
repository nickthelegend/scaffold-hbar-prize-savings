// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { PrizeLedger } from "../contracts/PrizeLedger.sol";

/// Exposes the library's internal functions so tests drive the exact code PrizePool runs.
contract PrizeLedgerHarness {
    using PrizeLedger for PrizeLedger.Ledger;

    PrizeLedger.Ledger internal ledger;
    uint256 public immutable maxParticipants;

    constructor(uint256 maxParticipants_) {
        maxParticipants = maxParticipants_;
    }

    function openRound(uint256 round, uint256 duration) external {
        ledger.openRound(round, duration);
    }

    function credit(address user, uint256 amount) external returns (bool) {
        return ledger.credit(user, amount, maxParticipants);
    }

    function debit(address user, uint256 amount) external returns (bool) {
        return ledger.debit(user, amount);
    }

    function pick(uint256 random) external view returns (address) {
        (uint256[] memory weights, uint256 total) = ledger.roundWeights();
        return ledger.pickWinner(weights, total, random);
    }

    function weights() external view returns (uint256[] memory, uint256) {
        return ledger.roundWeights();
    }

    function projectedWeight(address user) external view returns (uint256) {
        return ledger.projectedWeight(user);
    }

    function balanceOf(address user) external view returns (uint256) {
        return ledger.balanceOf(user);
    }

    function totalPrincipal() external view returns (uint256) {
        return ledger.totalPrincipal;
    }

    function participants() external view returns (address[] memory) {
        return ledger.participants;
    }

    function roundEnd() external view returns (uint256) {
        return ledger.roundEnd;
    }

    function currentRound() external view returns (uint256) {
        return ledger.currentRound;
    }
}

contract PrizeLedgerTest is Test {
    uint256 internal constant HBAR = 1e8;
    uint256 internal constant ROUND = 1 days;

    PrizeLedgerHarness internal ledger;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        ledger = new PrizeLedgerHarness(3);
        ledger.openRound(1, ROUND);
    }

    // ------------------------------------------------------------------------------------------------- principal

    function test_credit_tracksBalancesAndParticipants() public {
        assertFalse(ledger.credit(alice, 10 * HBAR), "first deposit: not yet a holder");
        assertTrue(ledger.credit(alice, 5 * HBAR), "second deposit: already a holder");
        ledger.credit(bob, 1 * HBAR);

        assertEq(ledger.balanceOf(alice), 15 * HBAR);
        assertEq(ledger.totalPrincipal(), 16 * HBAR);
        assertEq(ledger.participants().length, 2);
    }

    function test_credit_enforcesParticipantCap() public {
        ledger.credit(alice, HBAR);
        ledger.credit(bob, HBAR);
        ledger.credit(carol, HBAR);
        ledger.credit(carol, HBAR); // existing holders can always top up

        vm.expectRevert(abi.encodeWithSelector(PrizeLedger.TooManyParticipants.selector, 3));
        ledger.credit(makeAddr("dave"), HBAR);
    }

    function test_debit_partialAndFull() public {
        ledger.credit(alice, 10 * HBAR);
        assertTrue(ledger.debit(alice, 4 * HBAR));
        assertEq(ledger.balanceOf(alice), 6 * HBAR);
        assertFalse(ledger.debit(alice, 6 * HBAR));
        assertEq(ledger.participants().length, 0);
        assertEq(ledger.totalPrincipal(), 0);
    }

    function test_debit_revertsAboveBalance() public {
        ledger.credit(alice, 10 * HBAR);
        vm.expectRevert(abi.encodeWithSelector(PrizeLedger.InsufficientBalance.selector, 10 * HBAR));
        ledger.debit(alice, 10 * HBAR + 1);
    }

    function test_debit_swapAndPopKeepsOrderConsistent() public {
        ledger.credit(alice, HBAR);
        ledger.credit(bob, HBAR);
        ledger.credit(carol, HBAR);

        ledger.debit(alice, HBAR);
        address[] memory list = ledger.participants();
        assertEq(list.length, 2);
        assertEq(list[0], carol);
        assertEq(list[1], bob);

        ledger.debit(carol, HBAR);
        list = ledger.participants();
        assertEq(list.length, 1);
        assertEq(list[0], bob);

        // A freed slot can be reused under the cap.
        ledger.credit(alice, HBAR);
        ledger.credit(carol, HBAR);
        assertEq(ledger.participants().length, 3);
    }

    // ------------------------------------------------------------------------------------------------- odds

    function test_weight_isBalanceTimesSecondsHeld() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(block.timestamp + ROUND / 2);
        ledger.credit(bob, 10 * HBAR);

        assertEq(ledger.projectedWeight(alice), 10 * HBAR * ROUND);
        assertEq(ledger.projectedWeight(bob), 10 * HBAR * (ROUND / 2));
    }

    function test_weight_partialWithdrawCountsBothSegments() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(block.timestamp + ROUND / 4);
        ledger.debit(alice, 6 * HBAR);
        assertEq(ledger.projectedWeight(alice), 10 * HBAR * (ROUND / 4) + 4 * HBAR * (ROUND * 3 / 4));
    }

    function test_weight_lastSecondDepositBarelyCounts() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(ledger.roundEnd() - 1);
        ledger.credit(bob, 10_000 * HBAR);

        assertEq(ledger.projectedWeight(bob), 10_000 * HBAR);
        assertGt(ledger.projectedWeight(alice), ledger.projectedWeight(bob) * 8);
    }

    function test_weight_afterRoundEndCountsNothingThisRound() public {
        vm.warp(ledger.roundEnd() + 30);
        ledger.credit(alice, 10 * HBAR);
        assertEq(ledger.projectedWeight(alice), 0);
    }

    function test_weight_carriesFullyIntoNextRound() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(block.timestamp + ROUND / 2);
        ledger.credit(bob, 10 * HBAR);

        vm.warp(ledger.roundEnd() + 5);
        ledger.openRound(2, ROUND);
        assertEq(ledger.projectedWeight(alice), 10 * HBAR * ROUND);
        assertEq(ledger.projectedWeight(bob), 10 * HBAR * ROUND);
    }

    function test_weight_prizeCreditedAtRoundStartCountsFully() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(ledger.roundEnd() + 5);
        ledger.openRound(2, ROUND);
        ledger.credit(alice, 3 * HBAR); // what PrizePool does for a winner
        assertEq(ledger.projectedWeight(alice), 13 * HBAR * ROUND);
    }

    // ------------------------------------------------------------------------------------------------- winner selection

    function test_pick_mapsRandomOntoCumulativeWeights() public {
        ledger.credit(alice, 10 * HBAR);
        vm.warp(block.timestamp + ROUND / 2);
        ledger.credit(bob, 10 * HBAR);
        (, uint256 total) = ledger.weights();
        uint256 aliceWeight = ledger.projectedWeight(alice);

        assertEq(ledger.pick(0), alice);
        assertEq(ledger.pick(aliceWeight - 1), alice);
        assertEq(ledger.pick(aliceWeight), bob);
        assertEq(ledger.pick(total - 1), bob);
        assertEq(ledger.pick(total), alice, "wraps modulo total");
    }

    function test_pick_frequencyMatchesOdds() public {
        ledger.credit(alice, 30 * HBAR);
        ledger.credit(bob, 10 * HBAR);

        uint256 aliceWins;
        uint256 draws = 2_000;
        for (uint256 i; i < draws; ++i) {
            if (ledger.pick(uint256(keccak256(abi.encode(i)))) == alice) ++aliceWins;
        }
        // Expected 75%; allow ±4 percentage points.
        assertApproxEqAbs(aliceWins, (draws * 3) / 4, draws / 25);
    }

    function testFuzz_pick_alwaysReturnsAParticipantWithWeight(uint256 random, uint96 a, uint96 b, uint32 delay)
        public
    {
        a = uint96(bound(a, 1, 1e18));
        b = uint96(bound(b, 1, 1e18));
        ledger.credit(alice, a);
        vm.warp(block.timestamp + bound(delay, 0, ROUND - 1));
        ledger.credit(bob, b);

        address winner = ledger.pick(random);
        assertTrue(winner == alice || winner == bob);
        assertGt(ledger.projectedWeight(winner), 0);
    }
}
