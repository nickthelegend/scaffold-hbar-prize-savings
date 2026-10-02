// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IPrngSystemContract } from "./interfaces/IPrngSystemContract.sol";
import { PrizeLedger } from "./PrizeLedger.sol";

/// @title PrizePool
/// @notice No-loss prize savings on Hedera. Depositors keep 100% of their HBAR; the yield the pool earns
///         (native staking rewards plus sponsor boosts) is awarded each round to one depositor, picked at random
///         with odds proportional to balance multiplied by time held during the round.
/// @dev Hedera-native building blocks:
///      - Staking: the pool is created with a staking election (`stakedNodeId`) through the Hedera SDK, so the HBAR
///        it holds earns network staking rewards that land directly in its balance. Solidity cannot set this; see
///        `scripts-js/deployPrizePool.js`.
///      - HSS (0x16b): every draw schedules the next one, so rounds advance without an off-chain keeper.
///      - PRNG (0x169): the winner is picked from a consensus-derived seed, no VRF subscription needed.
///      - HTS (0x167): deposits are mirrored as a non-transferable ticket token (frozen in holders' accounts).
///      All amounts are tinybars (1 HBAR = 1e8), which is the unit `msg.value` and `address.balance` use inside
///      Hedera contracts. Ticket units equal tinybars.
contract PrizePool is ReentrancyGuard {
    using PrizeLedger for PrizeLedger.Ledger;

    address internal constant HTS = address(0x167);
    address internal constant PRNG = address(0x169);
    address internal constant HSS = address(0x16b);
    int64 internal constant HTS_SUCCESS = 22;

    /// HTS key type bits: freeze (4) + wipe (8) + supply (16), all held by this contract.
    uint256 internal constant TICKET_KEY_TYPES = 4 | 8 | 16;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000;
    uint8 internal constant TICKET_DECIMALS = 8;
    /// Seconds after `roundEnd` at which the draw is scheduled. Gives the round's last second time to close.
    uint256 internal constant SCHEDULE_DELAY = 5;
    /// Consecutive seconds tried when the preferred schedule second has no capacity left.
    uint256 internal constant SCHEDULE_ATTEMPTS = 5;

    address public immutable deployer;
    uint256 public immutable roundDuration;
    uint256 public immutable drawGrace;
    uint256 public immutable keeperBuffer;
    uint256 public immutable minDeposit;
    uint256 public immutable maxParticipants;
    uint256 public immutable drawGasLimit;

    address public ticket;
    address public nextDrawSchedule;

    PrizeLedger.Ledger internal _ledger;

    event Initialized(address indexed ticket, uint256 firstRoundEnd);
    event Deposited(address indexed user, uint256 amount, uint256 indexed round);
    event Withdrawn(address indexed user, uint256 amount, uint256 indexed round);
    event PrizeBoosted(address indexed sponsor, uint256 amount, uint256 indexed round);
    event DrawExecuted(
        uint256 indexed round, address indexed winner, uint256 prize, bytes32 seed, uint256 participants
    );
    event RoundRolledOver(uint256 indexed round, uint256 prize, uint256 participants);
    event DrawScheduled(uint256 indexed round, address schedule, uint256 expirySecond);
    event ScheduleFailed(uint256 indexed round, int64 responseCode);

    error AlreadyInitialized();
    error NotInitialized();
    error NotDeployer();
    error InvalidConfig();
    error BelowMinDeposit(uint256 minDeposit);
    error ZeroAmount();
    error DrawNotOpen(uint256 opensAt);
    error HtsCallFailed(int64 responseCode);
    error HbarTransferFailed();

    constructor(
        uint256 roundDuration_,
        uint256 drawGrace_,
        uint256 keeperBuffer_,
        uint256 minDeposit_,
        uint256 maxParticipants_,
        uint256 drawGasLimit_
    ) {
        if (roundDuration_ == 0 || minDeposit_ == 0 || maxParticipants_ == 0 || drawGasLimit_ == 0) {
            revert InvalidConfig();
        }
        deployer = msg.sender;
        roundDuration = roundDuration_;
        drawGrace = drawGrace_;
        keeperBuffer = keeperBuffer_;
        minDeposit = minDeposit_;
        maxParticipants = maxParticipants_;
        drawGasLimit = drawGasLimit_;
    }

    /// @notice Creates the ticket token, opens round 1 and schedules its draw.
    /// @dev `msg.value` pays the HTS token-creation fee (about $1 in HBAR); anything left over stays in the pool
    ///      as surplus, which is what the scheduled draws pay their fees from.
    function initialize() external payable {
        if (msg.sender != deployer) revert NotDeployer();
        if (ticket != address(0)) revert AlreadyInitialized();

        ticket = _createTicket();
        _openRound(1);
        emit Initialized(ticket, _ledger.roundEnd);
    }

    /// @notice Deposit HBAR. It joins the current round immediately, with odds weighted by time held.
    function deposit() external payable nonReentrant {
        if (ticket == address(0)) revert NotInitialized();
        if (msg.value < minDeposit) revert BelowMinDeposit(minDeposit);

        bool wasHolder = _ledger.credit(msg.sender, msg.value, maxParticipants);
        _issueTickets(msg.sender, msg.value, wasHolder);
        emit Deposited(msg.sender, msg.value, _ledger.currentRound);
    }

    /// @notice Withdraw any part of your principal at any time.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        bool stillHolder = _ledger.debit(msg.sender, amount);
        _burnTickets(msg.sender, amount, stillHolder);
        emit Withdrawn(msg.sender, amount, _ledger.currentRound);

        (bool sent,) = msg.sender.call{ value: amount }("");
        if (!sent) revert HbarTransferFailed();
    }

    /// @notice Add HBAR to the prize without receiving odds or principal.
    function boostPrize() public payable {
        if (msg.value == 0) revert ZeroAmount();
        emit PrizeBoosted(msg.sender, msg.value, _ledger.currentRound);
    }

    /// @notice Pick this round's winner and open the next round.
    /// @dev Normally executed by the schedule this contract created through HSS, in which case the caller is the
    ///      contract itself. Anyone may call once `drawGrace` has passed, so a missed schedule never stalls the pool.
    function draw() external nonReentrant {
        if (ticket == address(0)) revert NotInitialized();
        uint256 roundEnd_ = _ledger.roundEnd;
        uint256 opensAt = msg.sender == address(this) ? roundEnd_ : roundEnd_ + drawGrace;
        if (block.timestamp < opensAt) revert DrawNotOpen(opensAt);

        uint256 round = _ledger.currentRound;
        uint256 prizeAmount = prize();
        uint256 count = _ledger.participants.length;
        (uint256[] memory weights, uint256 totalWeight) = _ledger.roundWeights();

        if (prizeAmount == 0 || totalWeight == 0) {
            _openRound(round + 1);
            emit RoundRolledOver(round, prizeAmount, count);
            return;
        }

        bytes32 seed = IPrngSystemContract(PRNG).getPseudorandomSeed();
        address winner = _ledger.pickWinner(weights, totalWeight, uint256(keccak256(abi.encode(seed, round))));

        // Open the next round first so the prize counts toward it from its first second.
        _openRound(round + 1);
        _ledger.credit(winner, prizeAmount, maxParticipants);
        _issueTickets(winner, prizeAmount, true);

        emit DrawExecuted(round, winner, prizeAmount, seed, count);
    }

    /// @notice HBAR available to award: everything above principal, minus the buffer kept for schedule fees.
    function prize() public view returns (uint256) {
        uint256 balance = address(this).balance;
        uint256 reserved = _ledger.totalPrincipal + keeperBuffer;
        // Schedule fees are paid from this contract's balance; if they ever exceed the surplus there is no prize.
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice A depositor's principal and their weight projected to the end of the round.
    function accountOf(address user) external view returns (uint256 balance, uint256 projectedWeight) {
        return (_ledger.balanceOf(user), _ledger.projectedWeight(user));
    }

    /// @notice Odds of `user` winning the current round if no balances change before it ends.
    function oddsOf(address user) external view returns (uint256 userWeight, uint256 totalWeight) {
        userWeight = _ledger.projectedWeight(user);
        (, totalWeight) = _ledger.roundWeights();
    }

    function currentRound() external view returns (uint256) {
        return _ledger.currentRound;
    }

    function roundStart() external view returns (uint256) {
        return _ledger.roundStart;
    }

    function roundEnd() external view returns (uint256) {
        return _ledger.roundEnd;
    }

    function totalPrincipal() external view returns (uint256) {
        return _ledger.totalPrincipal;
    }

    function participantsCount() external view returns (uint256) {
        return _ledger.participants.length;
    }

    function participants() external view returns (address[] memory) {
        return _ledger.participants;
    }

    receive() external payable {
        boostPrize();
    }

    function _openRound(uint256 round) internal {
        _ledger.openRound(round, roundDuration);
        _scheduleDraw(round);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hedera Schedule Service
    // ---------------------------------------------------------------------------------------------------------

    /// Schedules `draw()` shortly after `roundEnd`. Failure never reverts the caller: the permissionless
    /// fallback in `draw()` keeps the pool live, and the event tells operators to investigate.
    function _scheduleDraw(uint256 round) internal {
        bytes memory callData = abi.encodeCall(this.draw, ());
        uint256 expiry = _ledger.roundEnd + SCHEDULE_DELAY;

        for (uint256 i; i < SCHEDULE_ATTEMPTS; ++i) {
            (bool ok, bytes memory result) =
                HSS.staticcall(abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (expiry + i, drawGasLimit)));
            if (!ok || !abi.decode(result, (bool))) continue;

            (ok, result) = HSS.call(
                abi.encodeCall(
                    IHederaScheduleService.scheduleCall, (address(this), expiry + i, drawGasLimit, 0, callData)
                )
            );
            if (!ok) break;
            (int64 rc, address schedule) = abi.decode(result, (int64, address));
            if (rc != HTS_SUCCESS) {
                emit ScheduleFailed(round, rc);
                nextDrawSchedule = address(0);
                return;
            }
            nextDrawSchedule = schedule;
            emit DrawScheduled(round, schedule, expiry + i);
            return;
        }
        nextDrawSchedule = address(0);
        emit ScheduleFailed(round, -1);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hedera Token Service: non-transferable tickets
    // ---------------------------------------------------------------------------------------------------------

    function _createTicket() internal returns (address token) {
        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: TICKET_KEY_TYPES,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        IHederaTokenService.HederaToken memory token_ = IHederaTokenService.HederaToken({
            name: "Prize Savings Ticket",
            symbol: "PST",
            treasury: address(this),
            memo: "1 PST = 1 tinybar deposited in PrizePool",
            tokenSupplyType: false,
            maxSupply: 0,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0, autoRenewAccount: address(this), autoRenewPeriod: AUTO_RENEW_PERIOD
            })
        });

        int64 rc;
        (rc, token) = IHederaTokenService(HTS).createFungibleToken{ value: msg.value }(
            token_, 0, int32(uint32(TICKET_DECIMALS))
        );
        _check(rc);
    }

    /// Mints tickets to the treasury, moves them to `user` and freezes the holding so it cannot be transferred.
    /// `frozen` tells whether `user` already holds (frozen) tickets that must be unfrozen first.
    function _issueTickets(address user, uint256 amount, bool frozen) internal {
        int64 units = _toInt64(amount);
        (int64 rc,,) = IHederaTokenService(HTS).mintToken(ticket, units, new bytes[](0));
        _check(rc);
        if (frozen) _check(IHederaTokenService(HTS).unfreezeToken(ticket, user));
        _check(IHederaTokenService(HTS).transferToken(ticket, address(this), user, units));
        _check(IHederaTokenService(HTS).freezeToken(ticket, user));
    }

    /// Wipes tickets from `user`. HTS refuses to wipe a frozen holding, so it is unfrozen first and refrozen when
    /// tickets remain.
    function _burnTickets(address user, uint256 amount, bool stillHolder) internal {
        _check(IHederaTokenService(HTS).unfreezeToken(ticket, user));
        _check(IHederaTokenService(HTS).wipeTokenAccount(ticket, user, _toInt64(amount)));
        if (stillHolder) _check(IHederaTokenService(HTS).freezeToken(ticket, user));
    }

    function _check(int64 rc) internal pure {
        if (rc != HTS_SUCCESS) revert HtsCallFailed(rc);
    }

    function _toInt64(uint256 amount) internal pure returns (int64) {
        // Total HBAR supply (5e18 tinybars) fits in int64, so this only guards against nonsense input.
        if (amount > uint256(uint64(type(int64).max))) revert InvalidConfig();
        return int64(uint64(amount));
    }
}
