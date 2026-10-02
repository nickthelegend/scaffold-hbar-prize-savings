import { useScaffoldReadContract } from "~~/hooks/scaffold-hbar";

/** Everything the pool dashboard shows about the current round. All amounts are tinybars. */
export const usePoolState = () => {
  const { data: prize } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "prize" });
  const { data: totalPrincipal } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "totalPrincipal",
  });
  const { data: currentRound } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "currentRound" });
  const { data: roundStart } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "roundStart" });
  const { data: roundEnd } = useScaffoldReadContract({ contractName: "PrizePool", functionName: "roundEnd" });
  const { data: drawGrace } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "drawGrace",
    watch: false,
  });
  const { data: participants } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "participantsCount",
  });
  const { data: nextDrawSchedule } = useScaffoldReadContract({
    contractName: "PrizePool",
    functionName: "nextDrawSchedule",
  });
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
    drawGrace,
    participants,
    nextDrawSchedule,
    ticket,
    minDeposit,
    keeperBuffer,
    isLoading: roundEnd === undefined,
  };
};
