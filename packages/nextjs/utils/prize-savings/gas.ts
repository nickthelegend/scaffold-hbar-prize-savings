/**
 * Gas limits for PrizePool writes, measured by `yarn foundry:test:e2e` on a Hiero Local Node (gas used, with ~25%
 * margin; the suite sends these exact limits, so it proves they suffice). See README "Costs and sizing".
 *
 * What dominates is not the EVM work but system-contract calls, which are priced from their HAPI fees:
 * - HSS `scheduleCall`: ~1.41M gas, whatever the scheduled call's own gas limit.
 * - HTS `transferToken` to an account that is auto-associating with the token on the way: ~721k. To an associated
 *   account, and every mint/freeze/unfreeze/wipe: ~15k.
 * - HIP-719 `associate()`: ~705k.
 */
export const GAS = {
  /** Existing saver: mint, unfreeze, transfer, freeze. Measured 143k. */
  depositHolder: 200_000n,
  /** First deposit, including the auto-association of the ticket token. Measured 879k. */
  depositNewSaver: 1_100_000n,
  /** Added when the call will schedule the round's draw (`hasScheduleCapacity` + `scheduleCall`). Measured 1.41M. */
  scheduling: 1_800_000n,
  /** Unfreeze, wipe (and refreeze), then send the HBAR. Measured 129k. */
  withdraw: 200_000n,
  /** A boost that does not schedule. Measured 30k. */
  boostPrize: 100_000n,
  /** Schedules the draw through HSS. Measured 1.53M. */
  triggerDraw: 1_900_000n,
  /** HIP-719 `associate()` on the ticket token. Measured 729k. */
  associate: 900_000n,
} as const;

/**
 * Whether a deposit or boost made now will schedule the round's draw: no schedule was created for this round yet and
 * the balance covers principal plus the fee reserve (deposits do not change that; a boost may only add to it).
 */
export const willScheduleDraw = (pool: { currentRound?: bigint; scheduledRound?: bigint; reserveShortfall?: bigint }) =>
  pool.currentRound === undefined ||
  pool.scheduledRound === undefined ||
  pool.reserveShortfall === undefined ||
  (pool.scheduledRound !== pool.currentRound && pool.reserveShortfall === 0n);

/** Gas for a deposit: an existing saver's top-up is cheap, a first deposit pays for the token auto-association. */
export const depositGas = (isHolder: boolean, schedules: boolean) =>
  (isHolder ? GAS.depositHolder : GAS.depositNewSaver) + (schedules ? GAS.scheduling : 0n);

/** Gas for a boost; one that may refill the reserve of an unscheduled round gets room to schedule the draw. */
export const boostGas = (pool: { currentRound?: bigint; scheduledRound?: bigint }) =>
  pool.currentRound !== undefined && pool.scheduledRound === pool.currentRound
    ? GAS.boostPrize
    : GAS.boostPrize + GAS.scheduling;
