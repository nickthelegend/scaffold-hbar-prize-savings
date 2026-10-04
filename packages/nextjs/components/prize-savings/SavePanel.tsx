"use client";

import { useEffect, useState } from "react";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { formatEther } from "viem";
import { useAccount, useBalance, useWriteContract } from "wagmi";
import { usePoolState } from "~~/hooks/prize-savings/usePoolState";
import { usePosition } from "~~/hooks/prize-savings/usePosition";
import { useSingleFlight } from "~~/hooks/prize-savings/useSingleFlight";
import { useTicketAssociation } from "~~/hooks/prize-savings/useTicketAssociation";
import { useScaffoldWriteContract, useTransactor } from "~~/hooks/scaffold-hbar";
import { GAS, boostGas, depositGas, willScheduleDraw } from "~~/utils/prize-savings/gas";
import { formatTinybars, hbarToTinybars, hbarToWeibars, isValidHbarAmount } from "~~/utils/prize-savings/units";

type Mode = "deposit" | "withdraw" | "boost";

const HRC719_ABI = [
  { type: "function", name: "associate", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "deposit", label: "Deposit", help: "Your HBAR joins this round right away. Odds grow with time held." },
  { id: "withdraw", label: "Withdraw", help: "Take back any part of your deposit, any time. Only the network fee." },
  {
    id: "boost",
    label: "Boost prize",
    help: "Donate HBAR to the prize. Boosts are not withdrawable and earn no odds.",
  },
];

/** Deposit, withdraw and boost forms. Handles the Hedera-specific unit conversion and token association. */
export const SavePanel = () => {
  const { address } = useAccount();
  const pool = usePoolState();
  const { ticket, minDeposit } = pool;
  const { balance } = usePosition(address);
  // The relay reports wallet balances in weibars (18 decimals), the same unit a transaction's `value` is sent in.
  const { data: wallet } = useBalance({ address, query: { refetchInterval: 15_000 } });
  const [awaitingAssociation, setAwaitingAssociation] = useState(false);
  const association = useTicketAssociation(address, ticket, { pollFast: awaitingAssociation });
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "PrizePool" });
  const { writeContractAsync: writeToken, isPending: isAssociating } = useWriteContract();
  const transactor = useTransactor();
  const { run, running } = useSingleFlight();

  // Stop fast polling once the mirror node reports the association.
  useEffect(() => {
    if (awaitingAssociation && association.data && !association.data.needsAssociation) setAwaitingAssociation(false);
  }, [awaitingAssociation, association.data]);

  const valid = isValidHbarAmount(amount);
  const tinybars = valid ? hbarToTinybars(amount) : 0n;
  const sendsValue = mode === "deposit" || mode === "boost";
  const error = !amount
    ? undefined
    : !valid
      ? "Enter a positive HBAR amount, with up to 8 decimals."
      : mode === "deposit" && minDeposit !== undefined && tinybars < minDeposit
        ? `Minimum deposit is ${formatTinybars(minDeposit)} HBAR.`
        : mode === "withdraw" && balance !== undefined && tinybars > balance
          ? `You have ${formatTinybars(balance)} HBAR deposited.`
          : sendsValue && wallet !== undefined && hbarToWeibars(amount) >= wallet.value
            ? `Your wallet holds ${Number(formatEther(wallet.value)).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })} HBAR; keep some for the network fee.`
            : undefined;

  // Explicit gas limits: HTS-heavy calls are sized from measurements (see utils/prize-savings/gas.ts).
  const submit = () =>
    run(async () => {
      if (!valid || error) return;
      try {
        // Wallets send `value` in weibars (18 decimals); the contract receives tinybars (8 decimals).
        if (mode === "deposit") {
          const gas = depositGas(balance !== undefined && balance > 0n, willScheduleDraw(pool));
          await writeContractAsync({ functionName: "deposit", value: hbarToWeibars(amount), gas });
        }
        if (mode === "boost")
          await writeContractAsync({ functionName: "boostPrize", value: hbarToWeibars(amount), gas: boostGas(pool) });
        if (mode === "withdraw")
          await writeContractAsync({ functionName: "withdraw", args: [tinybars], gas: GAS.withdraw });
        setAmount("");
      } catch {
        // useTransactor already showed the error (including a rejected signature).
      }
    });

  const associate = () =>
    run(async () => {
      try {
        await transactor(() =>
          writeToken({ address: ticket!, abi: HRC719_ABI, functionName: "associate", gas: GAS.associate }),
        );
        setAwaitingAssociation(true);
      } catch {
        // Notified by useTransactor.
      }
    });

  const active = MODES.find(m => m.id === mode)!;
  const checkingAssociation = mode === "deposit" && !association.data;
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
              onClick={() => {
                // An amount typed for one action must never carry over into another (a deposit into a boost).
                if (m.id !== mode) setAmount("");
                setMode(m.id);
              }}
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
        ) : checkingAssociation ? (
          <button className="btn btn-primary" disabled>
            {association.isError ? "Could not reach the mirror node. Retrying…" : "Checking ticket association…"}
          </button>
        ) : association.data && !association.data.accountExists ? (
          <div className="flex flex-col items-center gap-1 text-center text-sm">
            <p className="m-0">This address has no Hedera account yet. Fund it to create one:</p>
            <HederaPortalFaucet variant="link" label="portal.hedera.com/faucet" showIcon={false} />
          </div>
        ) : needsAssociation ? (
          <button
            className="btn btn-secondary"
            disabled={running || isAssociating || awaitingAssociation}
            onClick={associate}
          >
            {isAssociating || awaitingAssociation ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              "Associate ticket token (once)"
            )}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!valid || Boolean(error) || isPending || running}
            onClick={submit}
          >
            {isPending || running ? <span className="loading loading-spinner loading-sm" /> : active.label}
          </button>
        )}
      </div>
    </div>
  );
};
