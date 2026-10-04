import type { Abi, Address, PublicClient } from "viem";

/**
 * Canonical Multicall3, deployed at the same address on Hedera testnet and mainnet. A Hiero Local Node doesn't have
 * it, so reads fall back to one call each there.
 */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const HAS_MULTICALL = new Set([295, 296]);

/** How often the dashboard re-reads the pool. A Hedera block is ~2 s; nothing on screen needs that cadence. */
export const POOL_REFRESH_MS = 10_000;

export const poolQueryKeys = {
  all: ["prize-pool"] as const,
  state: (chainId: number, address?: Address) => ["prize-pool", "state", chainId, address] as const,
  position: (chainId: number, address?: Address, user?: Address) =>
    ["prize-pool", "position", chainId, address, user] as const,
};

type Call = { functionName: string; args?: readonly unknown[] };

/** Reads several view functions in one JSON-RPC request where Multicall3 exists, otherwise in parallel. */
export async function readPool(client: PublicClient, address: Address, abi: Abi, calls: readonly Call[]) {
  const contracts = calls.map(call => ({ address, abi, functionName: call.functionName, args: call.args }));
  const chainId = client.chain?.id;
  if (chainId !== undefined && HAS_MULTICALL.has(chainId)) {
    return client.multicall({ contracts, allowFailure: false, multicallAddress: MULTICALL3 }) as Promise<unknown[]>;
  }
  return Promise.all(contracts.map(contract => client.readContract(contract)));
}
