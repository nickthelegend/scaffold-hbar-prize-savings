"use client";

import { usePoolStaking } from "~~/hooks/prize-savings/usePoolStaking";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { explorerLink, networkForChain } from "~~/utils/prize-savings/mirror";
import { formatTinybars } from "~~/utils/prize-savings/units";

/** Where the prize comes from: the pool's own native staking election, verifiable on the mirror node. */
export const StakingCard = () => {
  const { targetNetwork } = useTargetNetwork();
  const { data: staking } = usePoolStaking();
  const { keeperBuffer } = usePoolState();
  const network = networkForChain(targetNetwork.id);

  return (
    <div className="card bg-base-100 border border-base-300 shadow-md">
      <div className="card-body gap-3">
        <h2 className="card-title m-0 text-lg">Where the prize comes from</h2>
        <ul className="m-0 flex flex-col gap-2 pl-0 text-sm">
          <li className="flex justify-between gap-4">
            <span className="text-base-content/70">Pool contract</span>
            {staking?.contractId ? (
              <a
                className="link link-primary"
                href={explorerLink(network, "contract", staking.contractId)}
                target="_blank"
                rel="noreferrer"
              >
                {staking.contractId}
              </a>
            ) : (
              <span>…</span>
            )}
          </li>
          <li className="flex justify-between gap-4">
            <span className="text-base-content/70">Staked to</span>
            <span>
              {staking === undefined
                ? "…"
                : staking.stakedNodeId === null
                  ? "Not staked"
                  : `Node ${staking.stakedNodeId}`}
            </span>
          </li>
          <li className="flex justify-between gap-4">
            <span className="text-base-content/70">Staking rewards pending</span>
            <span className="tabular-nums">
              {staking === undefined ? "…" : `${formatTinybars(staking.pendingReward, 8)} HBAR`}
            </span>
          </li>
          <li className="flex justify-between gap-4">
            <span className="text-base-content/70">Kept for schedule fees</span>
            <span className="tabular-nums">
              {keeperBuffer === undefined ? "…" : `${formatTinybars(keeperBuffer)} HBAR`}
            </span>
          </li>
        </ul>
        <p className="m-0 text-xs text-base-content/60">
          All deposits stay in the pool contract as HBAR, staked to a consensus node. The network pays staking rewards
          once per 24-hour period into the contract&apos;s balance; together with boosts they form the prize. A deposit
          only ever leaves the contract back to the saver who made it.
        </p>
      </div>
    </div>
  );
};
