import { formatUnits, parseEther, parseUnits } from "viem";

/**
 * Hedera uses two HBAR units on the EVM side, and mixing them up is the most common bug:
 * - Inside contracts (`msg.value`, `address.balance`, every PrizePool number) amounts are tinybars, 8 decimals.
 * - Over JSON-RPC (wallets, `value` on a transaction) amounts are weibars, 18 decimals, like ETH.
 */
export const TINYBAR_DECIMALS = 8;

/** Contract amount (tinybars) to a human HBAR string. */
export const formatTinybars = (tinybars: bigint, maxFractionDigits = 4) => {
  const [whole, fraction = ""] = formatUnits(tinybars, TINYBAR_DECIMALS).split(".");
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return trimmed ? `${Number(whole).toLocaleString("en-US")}.${trimmed}` : Number(whole).toLocaleString("en-US");
};

/** Human HBAR input to the tinybar amount a contract argument expects. */
export const hbarToTinybars = (hbar: string) => parseUnits(hbar, TINYBAR_DECIMALS);

/** Human HBAR input to the weibar `value` a wallet must send. */
export const hbarToWeibars = (hbar: string) => parseEther(hbar);

/** Whether `input` is a positive HBAR amount with at most 8 decimals. */
export const isValidHbarAmount = (input: string) => /^\d+(\.\d{1,8})?$/.test(input.trim()) && Number(input) > 0;

/** Share of `total` as a percentage string, e.g. "33.3%". */
export const formatShare = (part: bigint, total: bigint) => {
  if (total === 0n) return "0%";
  const basisPoints = Number((part * 10_000n) / total);
  return `${(basisPoints / 100).toFixed(basisPoints >= 1_000 ? 1 : 2)}%`;
};
