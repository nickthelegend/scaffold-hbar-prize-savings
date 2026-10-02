import { useScaffoldReadContract } from "~~/hooks/scaffold-hbar";

/** The connected depositor's principal and odds for the current round. */
export const usePosition = (address?: string) => {
  const { data: account } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "accountOf",
    args: [address],
  });
  const { data: odds } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "oddsOf",
    args: [address],
  });

  return {
    balance: account?.[0],
    userWeight: odds?.[0],
    totalWeight: odds?.[1],
  };
};
