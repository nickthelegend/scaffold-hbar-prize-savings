import { type Abi, decodeEventLog } from "viem";

export type HederaNetwork = "testnet" | "mainnet" | "local";

export const MIRROR_URLS: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com/api/v1",
  mainnet: "https://mainnet-public.mirrornode.hedera.com/api/v1",
  local: process.env.NEXT_PUBLIC_HEDERA_LOCAL_MIRROR_URL || "http://localhost:5551/api/v1",
};

type ExplorerEntity = "contract" | "transaction" | "schedule" | "account";

const MIRROR_PATHS: Record<ExplorerEntity, (id: string) => string> = {
  contract: id => `/contracts/${id}`,
  transaction: hash => `/contracts/results/${hash}`,
  schedule: id => `/schedules/${id}`,
  account: id => `/accounts/${id}`,
};

/** HashScan link on public networks; the raw mirror node record on a local node, which HashScan cannot index. */
export const explorerLink = (network: HederaNetwork, entity: ExplorerEntity, id: string) =>
  network === "local"
    ? `${MIRROR_URLS.local}${MIRROR_PATHS[entity](id)}`
    : `https://hashscan.io/${network}/${entity}/${id}`;

export const networkForChain = (chainId: number): HederaNetwork =>
  chainId === 295 ? "mainnet" : chainId === 298 ? "local" : "testnet";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mirror node request failed (${res.status}): ${url}`);
  return res.json() as Promise<T>;
}

type MirrorLog = {
  address: string;
  data: string;
  topics: string[];
  timestamp: string;
  transaction_hash: string;
  block_number: number;
};

export type DecodedPoolEvent = {
  eventName: string;
  args: Record<string, unknown>;
  timestamp: number;
  transactionHash: string;
};

/**
 * Recent events of a contract, newest first, decoded with its ABI. The mirror node is the indexer: no subgraph or
 * backend needed. Topic filters require a timestamp range, so we fetch the latest page and decode client-side.
 */
export async function fetchContractEvents(
  network: HederaNetwork,
  contract: string,
  abi: Abi,
  limit = 100,
): Promise<DecodedPoolEvent[]> {
  const { logs } = await getJson<{ logs: MirrorLog[] }>(
    `${MIRROR_URLS[network]}/contracts/${contract}/results/logs?order=desc&limit=${limit}`,
  );
  return logs.flatMap(log => {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      return [
        {
          eventName: String(decoded.eventName),
          args: (decoded.args ?? {}) as Record<string, unknown>,
          timestamp: Number(log.timestamp),
          transactionHash: log.transaction_hash,
        },
      ];
    } catch {
      return [];
    }
  });
}

export type MirrorAccount = {
  account: string;
  evm_address: string;
  max_automatic_token_associations: number;
  staked_node_id: number | null;
  pending_reward: number;
  decline_reward: boolean;
  balance: { balance: number; tokens: { token_id: string; balance: number }[] };
};

/** Account or contract by entity id or EVM address. Returns null for addresses with no Hedera account yet. */
export async function fetchAccount(network: HederaNetwork, idOrAddress: string): Promise<MirrorAccount | null> {
  const res = await fetch(`${MIRROR_URLS[network]}/accounts/${idOrAddress}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node account lookup failed (${res.status})`);
  return res.json() as Promise<MirrorAccount>;
}

/** Whether an account already holds a relationship with `tokenId` (i.e. is associated). */
export async function isAssociated(network: HederaNetwork, accountId: string, tokenId: string): Promise<boolean> {
  const { tokens } = await getJson<{ tokens: { token_id: string }[] }>(
    `${MIRROR_URLS[network]}/accounts/${accountId}/tokens?token.id=${tokenId}`,
  );
  return tokens.length > 0;
}

export type MirrorSchedule = {
  schedule_id: string;
  executed_timestamp: string | null;
  deleted: boolean;
  expiration_time: string | null;
};

export async function fetchSchedule(network: HederaNetwork, scheduleId: string): Promise<MirrorSchedule | null> {
  const res = await fetch(`${MIRROR_URLS[network]}/schedules/${scheduleId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node schedule lookup failed (${res.status})`);
  return res.json() as Promise<MirrorSchedule>;
}
