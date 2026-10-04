"use client";

import { ClockIcon, UsersIcon, WalletIcon } from "@heroicons/react/24/outline";
import { formatDuration, useNow } from "~~/hooks/prize-savings/useNow";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { useSingleFlight } from "~~/hooks/prize-savings/useSingleFlight";
import { useScaffoldWriteContract, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { type DrawStatus, drawStatus } from "~~/utils/prize-savings/drawStatus";
import { entityIdFromAddress } from "~~/utils/prize-savings/entities";
import { GAS } from "~~/utils/prize-savings/gas";
import { explorerLink, networkForChain } from "~~/utils/prize-savings/mirror";
import { formatTinybars, tinybarsToWeibars } from "~~/utils/prize-savings/units";

/** Current prize, countdown to the self-scheduled draw, and pool totals. */
export const PrizeHero = () => {
  const pool = usePoolState();
  const now = useNow();
  const secondsLeft = pool.roundEnd === undefined ? undefined : Number(pool.roundEnd) - now;
  const roundOver = secondsLeft !== undefined && secondsLeft <= 0;
  // An empty pool has no running round: the next deposit opens a fresh one (and schedules its draw).
  const waitingForSaver = pool.participants === 0n;

  const status =
    pool.currentRound === undefined ||
    pool.scheduledRound === undefined ||
    pool.nextDrawSchedule === undefined ||
    pool.drawOpensAt === undefined ||
    pool.participants === undefined ||
    pool.reserveShortfall === undefined
      ? undefined
      : drawStatus({
          now,
          currentRound: pool.currentRound,
          scheduledRound: pool.scheduledRound,
          nextDrawSchedule: pool.nextDrawSchedule,
          drawOpensAt: pool.drawOpensAt,
          participants: pool.participants,
          reserveShortfall: pool.reserveShortfall,
        });

  return (
    <section className="hedera-gradient dark:bg-none dark:bg-hedera-charcoal w-full px-5 pt-12 pb-20 text-white">
      <div className="max-w-4xl mx-auto flex flex-col items-center text-center gap-3">
        <p className="m-0 text-sm uppercase tracking-[0.2em] text-white/70">
          Round {pool.currentRound?.toString() ?? "…"} prize
        </p>
        <h1 className="m-0 text-5xl sm:text-6xl font-bold tabular-nums" aria-live="polite">
          {pool.prize === undefined ? (
            <span className="inline-block h-14 w-56 rounded-lg bg-white/20 animate-pulse" aria-label="Loading prize" />
          ) : (
            <>
              {formatTinybars(pool.prize)} <span className="text-3xl font-semibold text-white/80">HBAR</span>
            </>
          )}
        </h1>
        <p className="m-0 max-w-xl text-white/80">
          Deposit HBAR and withdraw it whenever you like. Deposits are reserved: they are never used for prizes or fees.
          The pool&apos;s staking rewards and sponsor boosts go to one depositor each round, drawn by the network
          itself.
        </p>

        <div className="mt-4 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            icon={<ClockIcon className="h-5 w-5" />}
            label={roundOver || waitingForSaver ? "Round" : "Round ends in"}
          >
            {secondsLeft === undefined || pool.participants === undefined
              ? "…"
              : waitingForSaver
                ? "Not started"
                : roundOver
                  ? "Ended"
                  : formatDuration(secondsLeft)}
          </Stat>
          <Stat icon={<WalletIcon className="h-5 w-5" />} label="Total saved">
            {pool.totalPrincipal === undefined ? "…" : `${formatTinybars(pool.totalPrincipal, 2)} HBAR`}
          </Stat>
          <Stat icon={<UsersIcon className="h-5 w-5" />} label="Savers">
            {pool.participants?.toString() ?? "…"}
          </Stat>
        </div>

        {status && <DrawState status={status} now={now} />}
      </div>
    </section>
  );
};

/** What the round's draw is waiting for, with a link to the on-chain schedule or a button to schedule it. */
const DrawState = ({ status, now }: { status: DrawStatus; now: number }) => {
  const { targetNetwork } = useTargetNetwork();
  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "PrizePool" });
  const { run, running } = useSingleFlight();
  const network = networkForChain(targetNetwork.id);

  const trigger = (topUp: bigint) =>
    run(async () => {
      try {
        await writeContractAsync({
          functionName: "triggerDraw",
          value: tinybarsToWeibars(topUp),
          gas: GAS.triggerDraw,
        });
      } catch {
        // useTransactor already showed the error (including a rejected signature).
      }
    });

  switch (status.kind) {
    case "scheduled": {
      const id = entityIdFromAddress(status.schedule);
      return (
        <a
          className="mt-2 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm text-white/90 hover:bg-white/20"
          href={explorerLink(network, "schedule", id)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
          Draw scheduled on-chain as {id}
        </a>
      );
    }
    case "awaiting-saver":
      return <Note>No savers yet. The first deposit starts the round and schedules its draw.</Note>;
    case "reserve-short":
      return (
        <Note>
          No draw is scheduled: the pool needs {formatTinybars(status.shortfall)} HBAR more to cover its fee reserve.
          Any boost that covers it schedules the draw.
        </Note>
      );
    case "waiting":
      return (
        <Note>
          {status.missed ? "The scheduled draw did not complete." : "The network had no capacity to schedule the draw."}{" "}
          Anyone can schedule it in {formatDuration(status.opensAt - now)}.
        </Note>
      );
    case "triggerable":
      return (
        <div className="mt-2 flex flex-col items-center gap-2 rounded-2xl bg-white/10 px-5 py-3 text-sm">
          <p className="m-0">
            {status.missed ? "The scheduled draw did not run." : "This round's draw is not scheduled."} Anyone can
            schedule it now; the network picks the winner a few seconds later.
            {status.topUp > 0n && ` This adds ${formatTinybars(status.topUp)} HBAR to cover the fee reserve.`}
          </p>
          <button
            className="btn btn-sm btn-secondary"
            disabled={isPending || running}
            onClick={() => trigger(status.topUp)}
          >
            {isPending || running ? <span className="loading loading-spinner loading-xs" /> : "Schedule draw"}
          </button>
        </div>
      );
  }
};

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="m-0 mt-2 max-w-xl rounded-2xl bg-white/10 px-5 py-3 text-sm text-white/90">{children}</p>
);

const Stat = ({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-center gap-1 rounded-2xl bg-white/10 px-4 py-3">
    <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/70">
      {icon}
      {label}
    </span>
    <span className="text-xl font-semibold tabular-nums">{children}</span>
  </div>
);
