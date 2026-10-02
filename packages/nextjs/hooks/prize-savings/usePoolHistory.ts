import { useQuery } from "@tanstack/react-query";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { fetchContractEvents, networkForChain } from "~~/utils/prize-savings/mirror";

export type DrawRecord = {
  round: bigint;
  kind: "won" | "rolled-over";
  winner?: string;
  prize: bigint;
  participants: bigint;
  timestamp: number;
  transactionHash: string;
};

/** Past draws, newest first, read from the mirror node. */
export const usePoolHistory = () => {
  const { targetNetwork } = useTargetNetwork();
  const { data: pool } = useDeployedContractInfo({ contractName: "PrizePool" });
  const network = networkForChain(targetNetwork.id);

  return useQuery({
    queryKey: ["prize-pool-history", network, pool?.address],
    enabled: Boolean(pool),
    refetchInterval: 15_000,
    queryFn: async (): Promise<DrawRecord[]> => {
      const events = await fetchContractEvents(network, pool!.address, pool!.abi, {
        eventNames: ["DrawExecuted", "RoundRolledOver"],
        maxEvents: 50,
      });
      return events.flatMap(({ eventName, args, timestamp, transactionHash }): DrawRecord[] => {
        if (eventName === "DrawExecuted") {
          return [
            {
              round: args.round as bigint,
              kind: "won",
              winner: args.winner as string,
              prize: args.prize as bigint,
              participants: args.participants as bigint,
              timestamp,
              transactionHash,
            },
          ];
        }
        if (eventName === "RoundRolledOver") {
          return [
            {
              round: args.round as bigint,
              kind: "rolled-over",
              prize: args.prize as bigint,
              participants: args.participants as bigint,
              timestamp,
              transactionHash,
            },
          ];
        }
        return [];
      });
    },
  });
};
