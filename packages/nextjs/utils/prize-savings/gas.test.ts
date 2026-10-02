import { describe, expect, it } from "vitest";
import { GAS, boostGas, depositGas, willScheduleDraw } from "~~/utils/prize-savings/gas";

describe("gas limits", () => {
  it("adds scheduling headroom only when the call will schedule the draw", () => {
    expect(willScheduleDraw({ currentRound: 3n, scheduledRound: 3n, reserveShortfall: 0n })).toBe(false);
    expect(willScheduleDraw({ currentRound: 3n, scheduledRound: 2n, reserveShortfall: 0n })).toBe(true);
    expect(willScheduleDraw({ currentRound: 3n, scheduledRound: 2n, reserveShortfall: 1n })).toBe(false);
    expect(willScheduleDraw({ currentRound: undefined, scheduledRound: 2n, reserveShortfall: 0n })).toBe(true);
  });

  it("sizes deposits by holder status and scheduling", () => {
    expect(depositGas(true, false)).toBe(GAS.depositHolder);
    expect(depositGas(false, true)).toBe(GAS.depositNewSaver + GAS.scheduling);
  });

  it("gives an unscheduled round's boost room to schedule", () => {
    expect(boostGas({ currentRound: 3n, scheduledRound: 3n })).toBe(GAS.boostPrize);
    expect(boostGas({ currentRound: 3n, scheduledRound: 0n })).toBe(GAS.boostPrize + GAS.scheduling);
  });
});
