import { Client } from "@hiero-ledger/sdk";

/**
 * Hedera networks this template targets. `local` is a Hiero Local Node (consensus node + mirror node + JSON-RPC
 * relay in Docker): it runs the real HTS, HSS and PRNG system contracts with prefunded accounts, which makes it the
 * place to run the integration suite without spending testnet HBAR.
 */
export const NETWORKS = {
  testnet: {
    name: "testnet",
    chainId: 296,
    rpc: "https://testnet.hashio.io/api",
    mirror: "https://testnet.mirrornode.hedera.com/api/v1",
    hashscan: "https://hashscan.io/testnet",
    defaultNode: 3,
    client: () => Client.forTestnet(),
  },
  mainnet: {
    name: "mainnet",
    chainId: 295,
    rpc: "https://mainnet.hashio.io/api",
    mirror: "https://mainnet-public.mirrornode.hedera.com/api/v1",
    hashscan: "https://hashscan.io/mainnet",
    defaultNode: 3,
    client: () => Client.forMainnet(),
  },
  local: {
    name: "local",
    chainId: 298,
    rpc: process.env.LOCAL_RPC_URL ?? "http://localhost:7546",
    mirror: process.env.LOCAL_MIRROR_URL ?? "http://localhost:5551/api/v1",
    hashscan: undefined,
    defaultNode: 0,
    client: () =>
      Client.forNetwork({
        [process.env.LOCAL_NODE_ADDRESS ?? "127.0.0.1:50211"]: "0.0.3",
      }),
  },
};

export function networkByName(name) {
  const network = NETWORKS[name];
  if (!network)
    throw new Error(
      `Unknown network '${name}' (use ${Object.keys(NETWORKS).join(", ")})`
    );
  return network;
}

export async function mirrorGet(network, path) {
  const res = await fetch(`${network.mirror}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. Mirror data lags consensus by a few seconds. */
export async function waitFor(
  fn,
  { timeoutMs = 120_000, intervalMs = 1_500, label = "condition" } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
