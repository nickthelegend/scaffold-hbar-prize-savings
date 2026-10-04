import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { POOL_REFRESH_MS, poolQueryKeys, readPool } from "~~/hooks/prize-savings/poolReads";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-hbar";

/** The connected depositor's principal and odds for the current round, in one batched read. */
export const usePosition = (user?: string) => {
  const { targetNetwork } = useTargetNetwork();
  const client = usePublicClient({ chainId: targetNetwork.id });
  const { data: deployment } = useDeployedContractInfo({ contractName: "PrizePool" });

  const { data } = useQuery({
    queryKey: poolQueryKeys.position(targetNetwork.id, deployment?.address, user as Address | undefined),
    enabled: Boolean(client && deployment && user),
    refetchInterval: POOL_REFRESH_MS,
    queryFn: async () => {
      const [account, odds] = (await readPool(client!, deployment!.address, deployment!.abi, [
        { functionName: "accountOf", args: [user] },
        { functionName: "oddsOf", args: [user] },
      ])) as [readonly [bigint, bigint], readonly [bigint, bigint]];
      return { balance: account[0], userWeight: odds[0], totalWeight: odds[1] };
    },
  });

  return { balance: data?.balance, userWeight: data?.userWeight, totalWeight: data?.totalWeight };
};
