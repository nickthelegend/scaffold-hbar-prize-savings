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

export type MirrorLog = {
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

type LogsPage = { logs: MirrorLog[]; links?: { next: string | null } };

/** Decodes mirror-node logs with `abi`, keeping their order and skipping logs the ABI does not describe. */
export function decodeLogs(logs: MirrorLog[], abi: Abi): DecodedPoolEvent[] {
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

/** The mirror node's `links.next` is a path from the host root (`/api/v1/...`); resolve it against the base URL. */
export const nextPageUrl = (baseUrl: string, links?: { next: string | null }) =>
  links?.next ? new URL(links.next, baseUrl).toString() : undefined;

export type EventQuery = {
  /** Only keep these events. Default: every event in the ABI. */
  eventNames?: string[];
  /** Stop once this many matching events are collected. */
  maxEvents?: number;
  /** Logs per mirror-node request (max 100). */
  pageSize?: number;
  /** Upper bound on requests, so a very busy contract cannot stall the page. */
  maxPages?: number;
};

/**
 * A contract's events, newest first, decoded with its ABI. The mirror node is the indexer: no subgraph or backend.
 * Topic filters need a timestamp range of at most 7 days, so this walks `links.next` instead and filters by name:
 * events that are not asked for (deposits, withdrawals…) can never crowd the wanted ones out of a single page.
 */
export async function fetchContractEvents(
  network: HederaNetwork,
  contract: string,
  abi: Abi,
  { eventNames, maxEvents = 50, pageSize = 100, maxPages = 20 }: EventQuery = {},
): Promise<DecodedPoolEvent[]> {
  const base = MIRROR_URLS[network];
  const events: DecodedPoolEvent[] = [];
  let url: string | undefined = `${base}/contracts/${contract}/results/logs?order=desc&limit=${pageSize}`;
  for (let page = 0; url && page < maxPages && events.length < maxEvents; page++) {
    const { logs, links }: LogsPage = await getJson<LogsPage>(url);
    for (const event of decodeLogs(logs, abi)) {
      if (!eventNames || eventNames.includes(event.eventName)) events.push(event);
    }
    url = nextPageUrl(base, links);
  }
  return events.slice(0, maxEvents);
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

/**
 * The Hedera account id behind an EVM address, or null if it has none yet. Testnet and mainnet go through this app's
 * `/api/hedera/account` route, which turns the mirror node's 404 for a brand-new address (every fresh burner wallet)
 * into `{ accountId: null }`, so visitors' consoles don't show a failed request. A local node's mirror is queried
 * directly.
 */
export async function resolveAccountId(network: HederaNetwork, evmAddress: string): Promise<string | null> {
  if (network === "local") return (await fetchAccount(network, evmAddress))?.account ?? null;
  const res = await fetch(`/api/hedera/account?network=${network}&evm=${evmAddress}`);
  if (!res.ok) throw new Error(`Account lookup failed (${res.status})`);
  return ((await res.json()) as { accountId: string | null }).accountId;
}

/**
 * Whether a deposit needs an explicit `associate()` first. The mirror node reports an account's auto-association limit
 * but not how many slots are used, so only an unlimited limit (-1) is trusted to cover a new token.
 */
export const needsAssociation = (
  account: Pick<MirrorAccount, "max_automatic_token_associations">,
  associated: boolean,
) => !associated && account.max_automatic_token_associations !== -1;

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
