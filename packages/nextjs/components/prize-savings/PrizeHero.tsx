"use client";

import { ClockIcon, UsersIcon, WalletIcon } from "@heroicons/react/24/outline";
import { formatDuration, useCountdown } from "~~/hooks/prize-savings/useCountdown";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { useScaffoldWriteContract, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { entityIdFromAddress } from "~~/utils/prize-savings/entities";
import { explorerLink, networkForChain } from "~~/utils/prize-savings/mirror";
import { formatTinybars } from "~~/utils/prize-savings/units";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Current prize, countdown to the self-scheduled draw, and pool totals. */
export const PrizeHero = () => {
  const pool = usePoolState();
  const { targetNetwork } = useTargetNetwork();
  const secondsLeft = useCountdown(pool.roundEnd);
  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "PrizePool" });

  const network = networkForChain(targetNetwork.id);
  const hasSchedule = pool.nextDrawSchedule && pool.nextDrawSchedule !== ZERO_ADDRESS;
  const overdueBy =
    secondsLeft !== undefined && pool.drawGrace !== undefined ? -secondsLeft - Number(pool.drawGrace) : 0;
  const drawing = secondsLeft !== undefined && secondsLeft <= 0;

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
          Deposit HBAR and never lose it. The pool&apos;s staking rewards and sponsor boosts go to one depositor each
          round, drawn by the network itself.
        </p>

        <div className="mt-4 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat icon={<ClockIcon className="h-5 w-5" />} label={drawing ? "Draw" : "Draw in"}>
            {secondsLeft === undefined ? "…" : drawing ? "In progress" : formatDuration(secondsLeft)}
          </Stat>
          <Stat icon={<WalletIcon className="h-5 w-5" />} label="Total saved">
            {pool.totalPrincipal === undefined ? "…" : `${formatTinybars(pool.totalPrincipal, 2)} HBAR`}
          </Stat>
          <Stat icon={<UsersIcon className="h-5 w-5" />} label="Savers">
            {pool.participants?.toString() ?? "…"}
          </Stat>
        </div>

        {hasSchedule && (
          <a
            className="mt-2 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm text-white/90 hover:bg-white/20"
            href={explorerLink(network, "schedule", entityIdFromAddress(pool.nextDrawSchedule!))}
            target="_blank"
            rel="noreferrer"
          >
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
            Draw scheduled on-chain as {entityIdFromAddress(pool.nextDrawSchedule!)}
          </a>
        )}

        {overdueBy > 0 && (
          <div className="mt-2 flex flex-col items-center gap-2 rounded-2xl bg-white/10 px-5 py-3 text-sm">
            <p className="m-0">The scheduled draw did not run. Anyone can close the round now.</p>
            <button
              className="btn btn-sm btn-secondary"
              disabled={isPending}
              onClick={() => writeContractAsync({ functionName: "draw" })}
            >
              {isPending ? <span className="loading loading-spinner loading-xs" /> : "Trigger draw"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

const Stat = ({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-center gap-1 rounded-2xl bg-white/10 px-4 py-3">
    <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/70">
      {icon}
      {label}
    </span>
    <span className="text-xl font-semibold tabular-nums">{children}</span>
  </div>
);
