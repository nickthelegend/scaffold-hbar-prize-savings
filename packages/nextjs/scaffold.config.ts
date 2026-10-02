import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly [chains.Chain, ...chains.Chain[]];
  pollingInterval: number;
  rpcOverrides?: Record<number, string>;
  enableBurnerWallet: boolean;
  walletConnectProjectId: string;
};

/**
 * Hiero Local Node (consensus + mirror node + JSON-RPC relay in Docker). Unlike Anvil or Hardhat it runs the real
 * HTS, HSS and PRNG system contracts PrizePool depends on. Select it with NEXT_PUBLIC_HEDERA_NETWORK=local.
 */
export const hederaLocal = {
  id: 298,
  name: "Hedera Local",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:7546"] } },
  testnet: true,
} as const satisfies chains.Chain;

const targetNetworks =
  process.env.NEXT_PUBLIC_HEDERA_NETWORK === "local"
    ? ([hederaLocal] as const)
    : ([chains.hederaTestnet] as const satisfies readonly [chains.Chain, ...chains.Chain[]]);

const scaffoldConfig = {
  targetNetworks,

  pollingInterval: 10000,

  enableBurnerWallet: true,

  rpcOverrides: {
    [chains.hedera.id]: process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api",
    [chains.hederaTestnet.id]: process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api",
    [hederaLocal.id]: process.env.NEXT_PUBLIC_HEDERA_LOCAL_RPC_URL || "http://localhost:7546",
  },

  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
