import {
  ContractCreateFlow,
  ContractExecuteTransaction,
  Hbar,
} from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const FOUNDRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadPrizePoolArtifact() {
  const path = join(FOUNDRY_ROOT, "out", "PrizePool.sol", "PrizePool.json");
  if (!existsSync(path))
    throw new Error(
      "PrizePool artifact missing; run `yarn foundry:compile` first."
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Deployment parameters. HBAR amounts are converted to tinybars, the unit the contract works in. */
export function prizePoolConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const hbar = (name, fallback) =>
    BigInt(Math.round(Number(env[name] ?? fallback) * 1e8));
  const int = (name, fallback) => BigInt(env[name] ?? fallback);
  return {
    roundSeconds: int("ROUND_SECONDS", 86_400),
    drawGraceSeconds: int("DRAW_GRACE_SECONDS", 600),
    keeperBuffer: hbar("KEEPER_BUFFER_HBAR", 5),
    minDeposit: hbar("MIN_DEPOSIT_HBAR", 10),
    maxParticipants: int("MAX_PARTICIPANTS", 100),
    drawGasLimit: int("DRAW_GAS_LIMIT", 3_000_000),
    ticketFeeHbar: Number(env.TICKET_FEE_HBAR ?? 15),
    keeperSeedHbar: Number(env.KEEPER_SEED_HBAR ?? 10),
  };
}

/**
 * Most a scheduled draw can cost the pool, in tinybars: the full gas limit at the network gas price. Hedera charges at
 * least 80% of the limit, and the payer must cover all of it up front.
 */
export function maxDrawFee(config, gasPriceTinybars) {
  return config.drawGasLimit * gasPriceTinybars;
}

/** Network gas price in tinybars. The JSON-RPC relay reports weibars (1 tinybar = 1e10 weibar). */
export async function gasPriceTinybars(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_gasPrice",
      params: [],
    }),
  });
  const { result } = await res.json();
  return BigInt(result) / 10_000_000_000n;
}

/**
 * Creates a staked PrizePool with no admin key, creates its ticket token, and seeds the schedule-fee reserve.
 *
 * A staking election can only be set by the HAPI ContractCreate transaction, which is why this uses the SDK
 * instead of a JSON-RPC deployment. Without an admin key, nobody can ever update or delete the contract.
 */
export async function deployPrizePool({
  client,
  stakedNodeId,
  config,
  log = console.log,
}) {
  const artifact = loadPrizePoolArtifact();
  const constructorArgs = ethers.utils.defaultAbiCoder.encode(
    ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [
      config.roundSeconds,
      config.drawGraceSeconds,
      config.keeperBuffer,
      config.minDeposit,
      config.maxParticipants,
      config.drawGasLimit,
    ]
  );

  const create = await new ContractCreateFlow()
    .setBytecode(artifact.bytecode.object.replace(/^0x/, ""))
    .setConstructorParameters(ethers.utils.arrayify(constructorArgs))
    .setGas(4_000_000)
    .setStakedNodeId(stakedNodeId)
    .setDeclineStakingReward(false)
    .execute(client);
  const { contractId } = await create.getReceipt(client);
  log(
    `   ✅ contract ${contractId} created, staked to node ${stakedNodeId}, no admin key`
  );

  const init = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(3_000_000)
    .setPayableAmount(new Hbar(config.ticketFeeHbar))
    .setFunction("initialize")
    .execute(client);
  await init.getReceipt(client);
  log(
    `   ✅ ticket token created, round 1 open; its draw is scheduled once someone deposits (${init.transactionId})`
  );

  if (config.keeperSeedHbar > 0) {
    const seed = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(100_000)
      .setPayableAmount(new Hbar(config.keeperSeedHbar))
      .setFunction("boostPrize")
      .execute(client);
    await seed.getReceipt(client);
    log(
      `   ✅ seeded ${config.keeperSeedHbar} HBAR towards the schedule-fee reserve (${seed.transactionId})`
    );
  }

  return {
    contractId,
    address: `0x${contractId.toSolidityAddress()}`,
    abi: artifact.abi,
  };
}
