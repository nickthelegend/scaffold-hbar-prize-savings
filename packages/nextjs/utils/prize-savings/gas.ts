/**
 * Gas limits for PrizePool writes. Hedera bills at least 80% of the limit, so these are measured values plus a ~25%
 * margin rather than generous round numbers. HTS system-contract calls dominate: each costs hundreds of thousands of
 * gas on a real network. Measured by `yarn foundry:test:e2e` on a Hiero Local Node (see README "Costs and sizing").
 * Wallet estimates are not used: they can come back short for calls that create HTS child transactions.
 */
export const GAS = {
  /** Worst case: an existing saver's top-up (unfreeze, mint, transfer, freeze) that also schedules the draw. */
  deposit: 1_500_000n,
  /** Unfreeze, wipe and refreeze the tickets, then send the HBAR. */
  withdraw: 1_000_000n,
  /** A boost that makes the reserve sufficient schedules the draw through HSS. */
  boostPrize: 600_000n,
  /** Schedules the draw through HSS. */
  triggerDraw: 600_000n,
  /** HIP-719 `associate()` on the ticket token. */
  associate: 1_000_000n,
} as const;
