"use client";

import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { networkForChain } from "~~/utils/prize-savings/mirror";

/** Renders the dashboard only when a PrizePool exists on the target chain; otherwise explains how to get one. */
export const PoolGate = ({ children }: { children: React.ReactNode }) => {
  const { isDeployed } = usePoolState();
  const { targetNetwork } = useTargetNetwork();
  if (isDeployed) return <>{children}</>;

  const network = networkForChain(targetNetwork.id);
  return (
    <div className="flex w-full grow flex-col items-center px-5 py-16">
      <div className="card max-w-xl border border-base-300 bg-base-100 shadow-md">
        <div className="card-body gap-3">
          <h1 className="card-title m-0 text-2xl">No prize pool on {targetNetwork.name} yet</h1>
          <p className="m-0 text-base-content/80">
            <code>packages/nextjs/contracts/deployedContracts.ts</code> has no PrizePool with code on chain{" "}
            {targetNetwork.id}. Deploy one, which also regenerates that file:
          </p>
          <pre className="m-0 overflow-x-auto rounded-xl bg-base-200 p-3 text-sm">
            <code>{`yarn foundry:compile\nyarn foundry:deploy --network ${network}`}</code>
          </pre>
          <p className="m-0 text-sm text-base-content/70">
            Or switch the app to the network your pool lives on with <code>NEXT_PUBLIC_HEDERA_NETWORK</code>.
          </p>
        </div>
      </div>
    </div>
  );
};
