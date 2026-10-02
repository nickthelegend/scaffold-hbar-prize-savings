# Prize Savings: product brief for agents

## What exists

A no-loss prize pool (`packages/foundry/contracts/PrizePool.sol`) and its frontend (`packages/nextjs`).

- Savers `deposit()` HBAR (min 10 HBAR by default) and can `withdraw()` any part at any time.
- The contract is staked to a consensus node at creation (Hiero SDK), so staking rewards accumulate in its balance.
  Anyone can `boostPrize()`. `prize() = balance − totalPrincipal − keeperBuffer`.
- Each round, `draw(round)` (scheduled by the contract itself through the Hedera Schedule Service, and callable only by
  that schedule) picks a winner using the PRNG system contract, weighted by balance × seconds held, adds the prize to
  the winner's deposit, opens the next round and schedules the next draw. Draws are scheduled only while there are
  savers and the balance covers principal + `keeperBuffer` (the fee reserve). If a round has no live schedule, anyone
  can `triggerDraw()` after `drawOpensAt()`, which only schedules the draw (with an optional reserve top-up).
- Deposits are mirrored 1:1 as PST HTS tickets that the pool freezes in each holder's account.
- The frontend shows the prize, countdown, scheduled-draw entity, the saver's deposit and odds, past draws (from the
  mirror node) and the pool's staking status.

## Non-negotiables

Read `AGENTS.md` → "Invariants you must preserve". In short: principal is never spent or moved except back to its
owner; fees come only from the reserve above principal; only the contract's own schedule can draw; ticket failures
never block a draw or withdrawal; no owner/admin powers; HSS failure never reverts a draw; amounts inside contracts are
tinybars.

## Acceptance

`acceptance-contract.json` is the gate. A change is done when `yarn foundry:test`, `yarn next:test`, lint and build
pass and every critical assertion holds against the running app on Hedera testnet.
