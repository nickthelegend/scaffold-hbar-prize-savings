"use client";

import { HederaAddress } from "~~/components/scaffold-hbar";
import { type DrawRecord, usePoolHistory } from "~~/hooks/prize-savings/usePoolHistory";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { explorerLink, networkForChain } from "~~/utils/prize-savings/mirror";
import { formatTinybars } from "~~/utils/prize-savings/units";

const CHART_ROUNDS = 12;

/** Prize chart and table of past draws, indexed from the mirror node. */
export const DrawHistory = () => {
  const { targetNetwork } = useTargetNetwork();
  const { data: draws, isLoading, error } = usePoolHistory();
  const network = networkForChain(targetNetwork.id);

  return (
    <div className="card bg-base-100 border border-base-300 shadow-md">
      <div className="card-body gap-4">
        <h2 className="card-title m-0 text-lg">Past draws</h2>
        {isLoading ? (
          <div className="h-40 rounded-xl bg-base-200 animate-pulse" aria-label="Loading draws" />
        ) : !draws ? (
          // Only when nothing has loaded yet: a failed background refetch keeps showing the last good data.
          <p className={`m-0 text-sm ${error ? "text-error" : "text-base-content/70"}`}>
            {error ? "Could not load draws from the mirror node. Retrying…" : "Loading draws…"}
          </p>
        ) : !draws.length ? (
          <p className="m-0 text-sm text-base-content/70">
            No draws yet. The first one runs after the first round ends.
          </p>
        ) : (
          <>
            <PrizeChart draws={draws.slice(0, CHART_ROUNDS).reverse()} />
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Result</th>
                    <th className="text-right">Prize</th>
                    <th className="text-right">Savers</th>
                    <th className="text-right">Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {draws.map(draw => (
                    <tr key={`${draw.round}-${draw.transactionHash}`}>
                      <td className="tabular-nums">{draw.round.toString()}</td>
                      <td>
                        {draw.kind === "won" ? (
                          <div className="inline-flex">
                            <HederaAddress address={draw.winner as `0x${string}`} chain={targetNetwork} />
                          </div>
                        ) : (
                          <span className="text-base-content/60">Rolled over</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">{formatTinybars(draw.prize)} HBAR</td>
                      <td className="text-right tabular-nums">{draw.participants.toString()}</td>
                      <td className="text-right">
                        <a
                          className="link link-primary text-xs"
                          href={explorerLink(network, "transaction", draw.transactionHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          HashScan
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Bar per round: filled bars are prizes paid, outlined bars are prizes carried into the next round. */
const PrizeChart = ({ draws }: { draws: DrawRecord[] }) => {
  const max = draws.reduce((m, d) => (d.prize > m ? d.prize : m), 1n);
  return (
    // A div, not a <figure>: daisyUI lays out figures inside a card as a centred flex row.
    <div>
      <div className="flex h-32 justify-center gap-1.5" role="img" aria-label="Prize per round">
        {draws.map(draw => {
          const height = Math.max(4, Number((draw.prize * 100n) / max));
          return (
            <div
              key={`${draw.round}-${draw.transactionHash}`}
              className="flex h-full max-w-20 flex-1 flex-col items-center gap-1"
            >
              {/* The bar is positioned in a box of definite height, so its percentage height resolves. */}
              <div className="relative w-full flex-1">
                <div
                  className={`absolute inset-x-0 bottom-0 rounded-t-md ${draw.kind === "won" ? "bg-primary" : "border-2 border-dashed border-base-300"}`}
                  style={{ height: `${height}%` }}
                  title={`Round ${draw.round}: ${formatTinybars(draw.prize)} HBAR`}
                />
              </div>
              <span className="text-[10px] tabular-nums text-base-content/60">{draw.round.toString()}</span>
            </div>
          );
        })}
      </div>
      <p className="m-0 mt-1 text-center text-xs text-base-content/60">
        Prize per round (dashed = no winner, carried over)
      </p>
    </div>
  );
};
