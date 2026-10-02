import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-hbar";

/** Everything the pool dashboard shows about the current round. All amounts are tinybars. */
export const usePoolState = () => {
  const { data: deployment, isLoading: isDeploymentLoading } = useDeployedContractInfo({ contractName: "PrizePool" });

  const { data: prize } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "prize" });
  const { data: totalPrincipal } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "totalPrincipal",
  });
  const { data: currentRound } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "currentRound" });
  const { data: roundStart } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "roundStart" });
  const { data: roundEnd } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "roundEnd" });
  const { data: participants } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "participantsCount",
  });
  const { data: nextDrawSchedule } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "nextDrawSchedule",
  });
  const { data: scheduledRound } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "scheduledRound",
  });
  const { data: drawOpensAt } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "drawOpensAt" });
  const { data: reserveShortfall } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "reserveShortfall",
  });
  // Immutable after deployment: read once.
  const { data: ticket } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "ticket", watch: false });
  const { data: minDeposit } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "minDeposit",
    watch: false,
  });
  const { data: keeperBuffer } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "keeperBuffer",
    watch: false,
  });

  return {
    prize,
    totalPrincipal,
    currentRound,
    roundStart,
    roundEnd,
    participants,
    nextDrawSchedule,
    scheduledRound,
    drawOpensAt,
    reserveShortfall,
    ticket,
    minDeposit,
    keeperBuffer,
    /** False once we know no PrizePool has code at the configured address on the target chain. */
    isDeployed: isDeploymentLoading || Boolean(deployment),
    isLoading: roundEnd === undefined,
  };
};
