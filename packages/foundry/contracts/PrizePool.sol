// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IPrngSystemContract } from "./interfaces/IPrngSystemContract.sol";
import { PrizeLedger } from "./PrizeLedger.sol";

/// @title PrizePool
/// @notice No-loss prize savings on Hedera. Principal is reserved: it is never used for prizes or fees and leaves the
///         contract only through `withdraw`. The yield the pool earns (native staking rewards plus sponsor boosts) is
///         awarded each round to one depositor, picked at random with odds proportional to balance × time held.
/// @dev Hedera-native building blocks:
///      - Staking: the pool is created with a staking election (`stakedNodeId`) through the Hedera SDK, so the HBAR
///        it holds earns network staking rewards that land directly in its balance. Solidity cannot set this; see
///        `scripts-js/deployPrizePool.js`.
///      - HSS (0x16b): the contract schedules its own `draw`, so rounds advance without an off-chain keeper. A
///        scheduled call is paid from this contract's balance, so a draw is only scheduled while the surplus above
///        principal covers `keeperBuffer` (see `_scheduleDraw`).
///      - PRNG (0x169): the winner is picked from a consensus-derived seed, no VRF subscription needed. `draw` only runs
///        as a scheduled transaction, so nobody can call it and revert until they like the outcome.
///      - HTS (0x167): deposits are mirrored as a non-transferable ticket token (frozen in holders' accounts). The
///        ledger is the source of truth; on the draw and withdraw paths a failed ticket operation is reported with
///        `TicketSyncFailed` instead of reverting.
///      All amounts are tinybars (1 HBAR = 1e8), which is the unit `msg.value` and `address.balance` use inside
///      Hedera contracts. Ticket units equal tinybars.
contract PrizePool is ReentrancyGuard {
    using PrizeLedger for PrizeLedger.Ledger;

    address internal constant HTS = address(0x167);
    address internal constant PRNG = address(0x169);
    address internal constant HSS = address(0x16b);
    int64 internal constant SUCCESS = 22;
    /// Reported when a system contract call reverted or returned too little data to carry a response code.
    int64 internal constant NO_RESPONSE_CODE = -1;

    /// HTS key type bits: freeze (4) + wipe (8) + supply (16), all held by this contract.
    uint256 internal constant TICKET_KEY_TYPES = 4 | 8 | 16;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000;
    uint8 internal constant TICKET_DECIMALS = 8;
    /// Seconds after `roundEnd` (or after now, for a late schedule) at which the draw is scheduled.
    uint256 internal constant SCHEDULE_DELAY = 5;
    /// Consecutive seconds tried when the preferred schedule second has no capacity left.
    uint256 internal constant SCHEDULE_ATTEMPTS = 5;

    enum NotScheduledReason {
        NoParticipants,
        InsufficientReserve,
        NoCapacity
    }

    enum TicketOp {
        Mint,
        Unfreeze,
        Transfer,
        Freeze,
        Wipe
    }

    address public immutable deployer;
    uint256 public immutable roundDuration;
    uint256 public immutable drawGrace;
    uint256 public immutable keeperBuffer;
    uint256 public immutable minDeposit;
    uint256 public immutable maxParticipants;
    uint256 public immutable drawGasLimit;

    address public ticket;
    /// Latest schedule entity created for a draw, and the round and consensus second it was created for.
    address public nextDrawSchedule;
    uint256 public scheduledRound;
    uint256 public scheduledFor;

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
    event DrawNotScheduled(uint256 indexed round, NotScheduledReason reason);
    event ScheduleFailed(uint256 indexed round, int64 responseCode);
    event TicketSyncFailed(address indexed account, TicketOp op, int64 responseCode);

    error AlreadyInitialized();
    error NotInitialized();
    error NotDeployer();
    error InvalidConfig();
    error BelowMinDeposit(uint256 minDeposit);
    error ZeroAmount();
    error AmountTooLarge(uint256 amount);
    error OnlyScheduled();
    error StaleDraw(uint256 round);
    error DrawNotOpen(uint256 opensAt);
    error NoParticipants();
    error InsufficientReserve(uint256 shortfall);
    error SchedulingFailed();
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
        if (
            roundDuration_ == 0 || keeperBuffer_ == 0 || minDeposit_ == 0 || maxParticipants_ == 0 || drawGasLimit_ == 0
        ) {
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

    /// @notice Creates the ticket token and opens round 1. Its draw is scheduled once someone deposits.
    /// @dev `msg.value` is forwarded to HTS for the token-creation fee (about $1 in HBAR). None of it comes back to
    ///      this contract (measured in `test/e2e`), so send little more than the fee; the fee reserve is funded
    ///      separately with `boostPrize`.
    function initialize() external payable {
        if (msg.sender != deployer) revert NotDeployer();
        if (ticket != address(0)) revert AlreadyInitialized();

        ticket = _createTicket();
        _openRound(1);
        emit Initialized(ticket, _ledger.roundEnd);
    }

    /// @notice Deposit HBAR. It joins the current round immediately, with odds weighted by time held.
    /// @dev Reverts if the tickets cannot be issued (usually: the account is not associated with the ticket token and
    ///      has no free auto-association slot). The saver can associate and retry, and the ledger never holds a
    ///      deposit that has no tickets.
    function deposit() external payable nonReentrant {
        if (ticket == address(0)) revert NotInitialized();
        if (msg.value < minDeposit) revert BelowMinDeposit(minDeposit);

        // A round that ended with nobody in it and no draw on the way has nothing to draw: start a fresh round with
        // this deposit instead of paying for an empty draw.
        uint256 round = _ledger.currentRound;
        if (_ledger.participants.length == 0 && block.timestamp >= _ledger.roundEnd && scheduledRound != round) {
            emit RoundRolledOver(round, _surplusAbove(_ledger.totalPrincipal + keeperBuffer + msg.value), 0);
            _ledger.openRound(round + 1, roundDuration);
        }

        bool wasHolder = _ledger.credit(msg.sender, msg.value, maxParticipants);
        _issueTickets(msg.sender, msg.value, wasHolder, true);
        emit Deposited(msg.sender, msg.value, _ledger.currentRound);
        _scheduleIfUnscheduled();
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

    /// @notice Add HBAR to the prize without receiving odds or principal. Schedules the round's draw if the boost is
    ///         what makes the fee reserve sufficient.
    function boostPrize() public payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        emit PrizeBoosted(msg.sender, msg.value, _ledger.currentRound);
        _scheduleIfUnscheduled();
    }

    /// @notice Schedules a draw for a round whose own schedule never ran (or was never created). Anyone may call once
    ///         `drawOpensAt()` has passed; `msg.value` tops up the fee reserve and anything beyond it joins the prize.
    /// @dev This only schedules the draw a few seconds out. The winner is picked in that separate scheduled
    ///      transaction, which the caller cannot revert, so retrying until a favourable seed comes up is impossible.
    function triggerDraw() external payable nonReentrant {
        if (ticket == address(0)) revert NotInitialized();
        uint256 opensAt = drawOpensAt();
        if (block.timestamp < opensAt) revert DrawNotOpen(opensAt);
        if (_ledger.participants.length == 0) revert NoParticipants();
        uint256 shortfall = reserveShortfall();
        if (shortfall > 0) revert InsufficientReserve(shortfall);

        if (msg.value > 0) emit PrizeBoosted(msg.sender, msg.value, _ledger.currentRound);
        if (!_scheduleDraw(_ledger.currentRound)) revert SchedulingFailed();
    }

    /// @notice Picks this round's winner and opens the next round.
    /// @dev Only the schedule this contract created through HSS may call it (the caller is then the contract itself).
    ///      A public draw would let anyone revert the transaction until the PRNG picked them.
    function draw(uint256 round) external nonReentrant {
        if (msg.sender != address(this)) revert OnlyScheduled();
        if (round != _ledger.currentRound) revert StaleDraw(round);
        if (block.timestamp < _ledger.roundEnd) revert DrawNotOpen(_ledger.roundEnd);

        uint256 prizeAmount = prize();
        uint256 count = _ledger.participants.length;
        (uint256[] memory weights, uint256 totalWeight) = _ledger.roundWeights();

        if (prizeAmount == 0 || totalWeight == 0) {
            emit RoundRolledOver(round, prizeAmount, count);
            _openRound(round + 1);
            return;
        }

        bytes32 seed = IPrngSystemContract(PRNG).getPseudorandomSeed();
        address winner = _ledger.pickWinner(weights, totalWeight, uint256(keccak256(abi.encode(seed, round))));

        // The prize is added to the winner's principal before the next round opens, so it counts toward that round
        // from its first second and the next schedule's reserve check sees it as principal.
        _ledger.openRound(round + 1, roundDuration);
        _ledger.credit(winner, prizeAmount, maxParticipants);
        _issueTickets(winner, prizeAmount, true, false);
        emit DrawExecuted(round, winner, prizeAmount, seed, count);
        _scheduleDraw(round + 1);
    }

    /// @notice HBAR available to award: everything above principal and the fee reserve (`keeperBuffer`).
    function prize() public view returns (uint256) {
        return _surplusAbove(_ledger.totalPrincipal + keeperBuffer);
    }

    /// @notice HBAR the balance lacks to cover principal plus the fee reserve. A draw is only scheduled at 0.
    function reserveShortfall() public view returns (uint256) {
        uint256 needed = _ledger.totalPrincipal + keeperBuffer;
        uint256 balance = address(this).balance;
        return balance >= needed ? 0 : needed - balance;
    }

    /// @notice Earliest time `triggerDraw` may be called for the current round: `drawGrace` after the round ends, or
    ///         after the second its own schedule was due, whichever is later.
    function drawOpensAt() public view returns (uint256 opensAt) {
        opensAt = _ledger.roundEnd + drawGrace;
        if (scheduledRound == _ledger.currentRound) {
            uint256 afterSchedule = scheduledFor + drawGrace;
            if (afterSchedule > opensAt) opensAt = afterSchedule;
        }
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

    function _surplusAbove(uint256 reserved) internal view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > reserved ? balance - reserved : 0;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hedera Schedule Service
    // ---------------------------------------------------------------------------------------------------------

    /// Schedules the current round's draw if no schedule was created for it yet (a deposit or boost made it drawable).
    function _scheduleIfUnscheduled() internal {
        if (scheduledRound != _ledger.currentRound) _scheduleDraw(_ledger.currentRound);
    }

    /// Schedules `draw(round)` shortly after `roundEnd` (or shortly after now if the round already ended). Never
    /// reverts: when it does not schedule, it says why in an event and returns false.
    ///
    /// The scheduled call is paid from this contract's balance, so it is only created when that balance covers all
    /// principal plus `keeperBuffer`, which must exceed one draw's fee. An empty round is never scheduled: the next
    /// deposit restarts it instead. Together this keeps `balance >= totalPrincipal` no matter how many rounds run.
    function _scheduleDraw(uint256 round) internal returns (bool) {
        if (_ledger.participants.length == 0) return _notScheduled(round, NotScheduledReason.NoParticipants);
        if (reserveShortfall() > 0) return _notScheduled(round, NotScheduledReason.InsufficientReserve);

        uint256 roundEnd_ = _ledger.roundEnd;
        uint256 expiry = (block.timestamp > roundEnd_ ? block.timestamp : roundEnd_) + SCHEDULE_DELAY;
        bytes memory callData = abi.encodeCall(this.draw, (round));

        for (uint256 i; i < SCHEDULE_ATTEMPTS; ++i) {
            (bool ok, bytes memory result) =
                HSS.staticcall(abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (expiry + i, drawGasLimit)));
            if (!ok || result.length < 32) return _scheduleFailed(round, _responseCode(result));
            if (!abi.decode(result, (bool))) continue;

            (ok, result) = HSS.call(
                abi.encodeCall(
                    IHederaScheduleService.scheduleCall, (address(this), expiry + i, drawGasLimit, 0, callData)
                )
            );
            if (!ok || result.length < 64) return _scheduleFailed(round, _responseCode(result));
            (int64 rc, address schedule) = abi.decode(result, (int64, address));
            if (rc != SUCCESS) return _scheduleFailed(round, rc);

            nextDrawSchedule = schedule;
            scheduledRound = round;
            scheduledFor = expiry + i;
            emit DrawScheduled(round, schedule, expiry + i);
            return true;
        }
        return _notScheduled(round, NotScheduledReason.NoCapacity);
    }

    function _notScheduled(uint256 round, NotScheduledReason reason) internal returns (bool) {
        nextDrawSchedule = address(0);
        emit DrawNotScheduled(round, reason);
        return false;
    }

    function _scheduleFailed(uint256 round, int64 rc) internal returns (bool) {
        nextDrawSchedule = address(0);
        emit ScheduleFailed(round, rc);
        return false;
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
    /// `frozen` tells whether `user` already holds (frozen) tickets that must be unfrozen first. With `strict`, any
    /// failure reverts; otherwise it emits `TicketSyncFailed` and stops, leaving the ledger as the source of truth.
    function _issueTickets(address user, uint256 amount, bool frozen, bool strict) internal {
        int64 units = _toInt64(amount);
        if (!_mint(user, units, strict)) return;
        if (frozen && !_unfreeze(user, strict)) return;
        bool sent = _transfer(user, units, strict);
        // Refreeze even after a failed transfer, so a holding we unfroze never stays transferable.
        if (sent || frozen) _freeze(user, strict);
    }

    /// Wipes tickets from `user`. HTS refuses to wipe a frozen holding, so it is unfrozen first and refrozen when
    /// tickets remain. Never reverts: a saver's principal must not depend on the ticket mirror.
    function _burnTickets(address user, uint256 amount, bool stillHolder) internal {
        if (!_unfreeze(user, false)) return;
        bool wiped = _wipe(user, _toInt64(amount));
        if (stillHolder || !wiped) _freeze(user, false);
    }

    function _mint(address user, int64 units, bool strict) internal returns (bool) {
        bytes memory data = abi.encodeCall(IHederaTokenService.mintToken, (ticket, units, new bytes[](0)));
        return _ticketOp(user, TicketOp.Mint, data, strict);
    }

    function _transfer(address user, int64 units, bool strict) internal returns (bool) {
        bytes memory data = abi.encodeCall(IHederaTokenService.transferToken, (ticket, address(this), user, units));
        return _ticketOp(user, TicketOp.Transfer, data, strict);
    }

    function _freeze(address user, bool strict) internal returns (bool) {
        bytes memory data = abi.encodeCall(IHederaTokenService.freezeToken, (ticket, user));
        return _ticketOp(user, TicketOp.Freeze, data, strict);
    }

    function _unfreeze(address user, bool strict) internal returns (bool) {
        bytes memory data = abi.encodeCall(IHederaTokenService.unfreezeToken, (ticket, user));
        return _ticketOp(user, TicketOp.Unfreeze, data, strict);
    }

    function _wipe(address user, int64 units) internal returns (bool) {
        bytes memory data = abi.encodeCall(IHederaTokenService.wipeTokenAccount, (ticket, user, units));
        return _ticketOp(user, TicketOp.Wipe, data, false);
    }

    /// Calls HTS. Every function used here returns the response code as its first word.
    function _ticketOp(address user, TicketOp op, bytes memory data, bool strict) internal returns (bool) {
        (bool ok, bytes memory result) = HTS.call(data);
        int64 rc = ok && result.length >= 32 ? _toResponseCode(result) : _responseCode(result);
        if (rc == SUCCESS) return true;
        if (strict) revert HtsCallFailed(rc);
        emit TicketSyncFailed(user, op, rc);
        return false;
    }

    /// Best-effort response code from a failed system-contract call: a single ABI word if that is what came back.
    function _responseCode(bytes memory result) internal pure returns (int64) {
        return result.length == 32 ? _toResponseCode(result) : NO_RESPONSE_CODE;
    }

    /// Response codes are small enums; the first ABI word is read as int256 so malformed data cannot revert here.
    function _toResponseCode(bytes memory result) internal pure returns (int64) {
        int256 code = abi.decode(result, (int256));
        return code < type(int64).min || code > type(int64).max ? NO_RESPONSE_CODE : int64(code);
    }

    function _check(int64 rc) internal pure {
        if (rc != SUCCESS) revert HtsCallFailed(rc);
    }

    function _toInt64(uint256 amount) internal pure returns (int64) {
        // Total HBAR supply (5e18 tinybars) fits in int64, so this only guards against nonsense input.
        if (amount > uint256(uint64(type(int64).max))) revert AmountTooLarge(amount);
        return int64(uint64(amount));
    }
}
