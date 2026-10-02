"use client";

import { useState } from "react";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { useAccount, useWriteContract } from "wagmi";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { usePosition } from "~~/hooks/prize-savings/usePosition";
import { useTicketAssociation } from "~~/hooks/prize-savings/useTicketAssociation";
import { useScaffoldWriteContract, useTransactor } from "~~/hooks/scaffold-hbar";
import { formatTinybars, hbarToTinybars, hbarToWeibars, isValidHbarAmount } from "~~/utils/prize-savings/units";

type Mode = "deposit" | "withdraw" | "boost";

const HRC719_ABI = [
  { type: "function", name: "associate", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "deposit", label: "Deposit", help: "Your HBAR joins this round right away. Odds grow with time held." },
  { id: "withdraw", label: "Withdraw", help: "Take back any part of your deposit, any time. No fees." },
  {
    id: "boost",
    label: "Boost prize",
    help: "Donate HBAR to the prize. Boosts are not withdrawable and earn no odds.",
  },
];

/** Deposit, withdraw and boost forms. Handles the Hedera-specific unit conversion and token association. */
export const SavePanel = () => {
  const { address } = useAccount();
  const { ticket, minDeposit } = usePoolState();
  const { balance } = usePosition(address);
  const association = useTicketAssociation(address, ticket);
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "PrizePool" });
  const { writeContractAsync: writeToken, isPending: isAssociating } = useWriteContract();
  const transactor = useTransactor();

  const valid = isValidHbarAmount(amount);
  const tinybars = valid ? hbarToTinybars(amount) : 0n;
  const error = !amount
    ? undefined
    : !valid
      ? "Enter an HBAR amount with up to 8 decimals."
      : mode === "deposit" && minDeposit !== undefined && tinybars < minDeposit
        ? `Minimum deposit is ${formatTinybars(minDeposit)} HBAR.`
        : mode === "withdraw" && balance !== undefined && tinybars > balance
          ? `You have ${formatTinybars(balance)} HBAR deposited.`
          : undefined;

  const submit = async () => {
    if (!valid || error) return;
    // Wallets send `value` in weibars (18 decimals); the contract receives tinybars (8 decimals).
    if (mode === "deposit") await writeContractAsync({ functionName: "deposit", value: hbarToWeibars(amount) });
    if (mode === "boost") await writeContractAsync({ functionName: "boostPrize", value: hbarToWeibars(amount) });
    if (mode === "withdraw") await writeContractAsync({ functionName: "withdraw", args: [tinybars] });
    setAmount("");
  };

  const associate = async () => {
    await transactor(() => writeToken({ address: ticket!, abi: HRC719_ABI, functionName: "associate" }));
    await association.refetch();
  };

  const active = MODES.find(m => m.id === mode)!;
  const needsAssociation = mode === "deposit" && association.data?.needsAssociation;

  return (
    <div className="card bg-base-100 border border-base-300 shadow-md">
      <div className="card-body gap-4">
        <div role="tablist" className="tabs tabs-box">
          {MODES.map(m => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={`tab flex-1 ${mode === m.id ? "tab-active" : ""}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="m-0 text-sm text-base-content/70">{active.help}</p>

        <label className="form-control w-full">
          <span className="label-text mb-1 text-sm font-medium">Amount</span>
          <div className="join w-full">
            <input
              className={`input input-bordered join-item w-full tabular-nums ${error ? "input-error" : ""}`}
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby="amount-error"
            />
            <span className="btn join-item no-animation pointer-events-none">HBAR</span>
            {mode === "withdraw" && balance !== undefined && balance > 0n && (
              <button className="btn join-item" onClick={() => setAmount(formatTinybars(balance, 8).replace(/,/g, ""))}>
                Max
              </button>
            )}
          </div>
          <span id="amount-error" className="mt-1 min-h-5 text-sm text-error">
            {error}
          </span>
        </label>

        {!address ? (
          <p className="m-0 text-center text-sm text-base-content/70">Connect a wallet to start saving.</p>
        ) : association.data && !association.data.accountExists ? (
          <div className="flex flex-col items-center gap-1 text-center text-sm">
            <p className="m-0">This address has no Hedera account yet. Fund it to create one:</p>
            <HederaPortalFaucet variant="link" label="portal.hedera.com/faucet" showIcon={false} />
          </div>
        ) : needsAssociation ? (
          <button className="btn btn-secondary" disabled={isAssociating} onClick={associate}>
            {isAssociating ? <span className="loading loading-spinner loading-sm" /> : "Associate ticket token (once)"}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!valid || Boolean(error) || isPending} onClick={submit}>
            {isPending ? <span className="loading loading-spinner loading-sm" /> : active.label}
          </button>
        )}
      </div>
    </div>
  );
};
