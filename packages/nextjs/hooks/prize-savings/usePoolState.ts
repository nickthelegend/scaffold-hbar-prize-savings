import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { POOL_REFRESH_MS, poolQueryKeys, readPool } from "~~/hooks/prize-savings/poolReads";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-hbar";

const FIELDS = [
  "prize",
  "totalPrincipal",
  "currentRound",
  "roundStart",
  "roundEnd",
  "participantsCount",
  "nextDrawSchedule",
  "scheduledRound",
  "drawOpensAt",
  "reserveShortfall",
  "ticket",
  "minDeposit",
  "keeperBuffer",
] as const;

/**
 * Everything the pool dashboard shows about the current round, in one batched read shared by every component that
 * calls this hook (same query key), refreshed every 10 s and right after the visitor's own transactions. All amounts
 * are tinybars.
 */
export const usePoolState = () => {
  const { targetNetwork } = useTargetNetwork();
  const client = usePublicClient({ chainId: targetNetwork.id });
  const { data: deployment, isLoading: isDeploymentLoading } = useDeployedContractInfo({ contractName: "PrizePool" });

  const { data } = useQuery({
    queryKey: poolQueryKeys.state(targetNetwork.id, deployment?.address),
    enabled: Boolean(client && deployment),
    refetchInterval: POOL_REFRESH_MS,
    queryFn: async () => {
      const values = await readPool(
        client!,
        deployment!.address,
        deployment!.abi,
        FIELDS.map(functionName => ({ functionName })),
      );
      return Object.fromEntries(FIELDS.map((field, i) => [field, values[i]]));
    },
  });

  const big = (field: (typeof FIELDS)[number]) => data?.[field] as bigint | undefined;
  return {
    prize: big("prize"),
    totalPrincipal: big("totalPrincipal"),
    currentRound: big("currentRound"),
    roundStart: big("roundStart"),
    roundEnd: big("roundEnd"),
    participants: big("participantsCount"),
    nextDrawSchedule: data?.nextDrawSchedule as `0x${string}` | undefined,
    scheduledRound: big("scheduledRound"),
    drawOpensAt: big("drawOpensAt"),
    reserveShortfall: big("reserveShortfall"),
    ticket: data?.ticket as `0x${string}` | undefined,
    minDeposit: big("minDeposit"),
    keeperBuffer: big("keeperBuffer"),
    /** False once we know no PrizePool has code at the configured address on the target chain. */
    isDeployed: isDeploymentLoading || Boolean(deployment),
    isLoading: data === undefined,
  };
};
