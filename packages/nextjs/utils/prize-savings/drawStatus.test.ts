import { describe, expect, it } from "vitest";
import { type DrawStatusInput, drawStatus } from "~~/utils/prize-savings/drawStatus";

const schedule = "0x00000000000000000000000000000000000004d2";
const base: DrawStatusInput = {
  now: 1_000,
  currentRound: 3n,
  scheduledRound: 3n,
  nextDrawSchedule: schedule,
  drawOpensAt: 1_100n,
  participants: 2n,
  reserveShortfall: 0n,
};

describe("drawStatus", () => {
  it("links the schedule while it can still run", () => {
    expect(drawStatus(base)).toEqual({ kind: "scheduled", schedule });
  });

  it("drops the schedule link once the schedule is past its grace period", () => {
    expect(drawStatus({ ...base, now: 1_100 })).toEqual({ kind: "triggerable", topUp: 0n, missed: true });
  });

  it("ignores a schedule left over from an earlier round", () => {
    expect(drawStatus({ ...base, scheduledRound: 2n })).toEqual({ kind: "waiting", opensAt: 1_100, missed: false });
  });

  it("waits for a saver when the pool is empty", () => {
    expect(drawStatus({ ...base, scheduledRound: 0n, participants: 0n, now: 5_000 })).toEqual({
      kind: "awaiting-saver",
    });
  });

  it("reports a short fee reserve before the trigger opens", () => {
    expect(drawStatus({ ...base, scheduledRound: 2n, reserveShortfall: 7n })).toEqual({
      kind: "reserve-short",
      shortfall: 7n,
    });
  });

  it("asks the trigger caller to top up the reserve", () => {
    expect(drawStatus({ ...base, scheduledRound: 2n, reserveShortfall: 7n, now: 2_000 })).toEqual({
      kind: "triggerable",
      topUp: 7n,
      missed: false,
    });
  });

  it("treats a zero schedule address as unscheduled", () => {
    expect(drawStatus({ ...base, nextDrawSchedule: `0x${"0".repeat(40)}` }).kind).toBe("waiting");
  });
});
