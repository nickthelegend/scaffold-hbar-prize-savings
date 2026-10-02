import { useQuery } from "@tanstack/react-query";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { fetchAccount, networkForChain } from "~~/utils/prize-savings/mirror";

/** The pool contract's native staking election and rewards accrued but not yet paid out (tinybars). */
export const usePoolStaking = () => {
  const { targetNetwork } = useTargetNetwork();
  const { data: pool } = useDeployedContractInfo({ contractName: "PrizePool" });
  const network = networkForChain(targetNetwork.id);

  return useQuery({
    queryKey: ["prize-pool-staking", network, pool?.address],
    enabled: Boolean(pool),
    refetchInterval: 60_000,
    queryFn: async () => {
      const account = await fetchAccount(network, pool!.address);
      return {
        contractId: account?.account,
        stakedNodeId: account?.staked_node_id ?? null,
        pendingReward: BigInt(account?.pending_reward ?? 0),
        declineReward: account?.decline_reward ?? false,
      };
    },
  });
};
