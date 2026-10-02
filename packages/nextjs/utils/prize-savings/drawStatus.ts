/**
 * What the next draw of the current round is waiting for, derived from PrizePool's scheduling state. Pure, so every
 * branch is unit-tested; `PrizeHero` only renders it.
 */
export type DrawStatusInput = {
  /** Current unix time, seconds. */
  now: number;
  currentRound: bigint;
  scheduledRound: bigint;
  nextDrawSchedule: string;
  drawOpensAt: bigint;
  participants: bigint;
  reserveShortfall: bigint;
};

export type DrawStatus =
  /** The network will run the draw this contract scheduled for the current round. */
  | { kind: "scheduled"; schedule: string }
  /** Nobody is saving. The next deposit starts the round and schedules its draw. */
  | { kind: "awaiting-saver" }
  /** Savers are in, but the balance does not cover principal plus the fee reserve, so no draw is scheduled. */
  | { kind: "reserve-short"; shortfall: bigint }
  /** No live schedule (it was never created, or it ran and failed); `triggerDraw` opens at `opensAt`. */
  | { kind: "waiting"; opensAt: number; missed: boolean }
  /** Anyone can call `triggerDraw` now, sending `topUp` tinybars to cover the fee reserve. */
  | { kind: "triggerable"; topUp: bigint; missed: boolean };

const ZERO_ADDRESS = /^0x0{40}$/i;

export const drawStatus = (input: DrawStatusInput): DrawStatus => {
  const opensAt = Number(input.drawOpensAt);
  const scheduledThisRound = input.scheduledRound === input.currentRound && !ZERO_ADDRESS.test(input.nextDrawSchedule);
  if (scheduledThisRound && input.now < opensAt) return { kind: "scheduled", schedule: input.nextDrawSchedule };
  if (input.participants === 0n) return { kind: "awaiting-saver" };

  const missed = input.scheduledRound === input.currentRound;
  if (input.now >= opensAt) return { kind: "triggerable", topUp: input.reserveShortfall, missed };
  if (input.reserveShortfall > 0n) return { kind: "reserve-short", shortfall: input.reserveShortfall };
  return { kind: "waiting", opensAt, missed };
};
