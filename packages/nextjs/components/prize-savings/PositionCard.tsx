"use client";

import { useAccount } from "wagmi";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { usePosition } from "~~/hooks/prize-savings/usePosition";
import { formatShare, formatTinybars } from "~~/utils/prize-savings/units";

/** The connected saver's deposit and their chance of winning this round. */
export const PositionCard = () => {
  const { address } = useAccount();
  const { prize } = usePoolState();
  const { balance, userWeight, totalWeight } = usePosition(address);

  return (
    <div className="card bg-base-100 border border-base-300 shadow-md">
      <div className="card-body gap-4">
        <h2 className="card-title m-0 text-lg">Your savings</h2>
        {!address ? (
          <p className="m-0 text-sm text-base-content/70">Connect a wallet to see your deposit and odds.</p>
        ) : (
          <dl className="m-0 grid grid-cols-2 gap-4">
            <Item label="Deposited">{balance === undefined ? "…" : `${formatTinybars(balance)} HBAR`}</Item>
            <Item label="Chance this round">
              {userWeight === undefined || totalWeight === undefined ? "…" : formatShare(userWeight, totalWeight)}
            </Item>
            <Item label="Tickets (PST)">{balance === undefined ? "…" : formatTinybars(balance)}</Item>
            <Item label="If you win">{prize === undefined ? "…" : `+${formatTinybars(prize)} HBAR`}</Item>
          </dl>
        )}
        <p className="m-0 text-xs text-base-content/60">
          Odds are time-weighted: HBAR held for the whole round counts fully, a deposit made halfway counts half.
          Tickets are frozen in your account so they cannot be transferred; they are burned when you withdraw.
        </p>
      </div>
    </div>
  );
};

const Item = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-xs uppercase tracking-wider text-base-content/60">{label}</dt>
    <dd className="m-0 text-xl font-semibold tabular-nums">{children}</dd>
  </div>
);
