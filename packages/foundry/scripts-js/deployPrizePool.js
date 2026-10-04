/**
 * Deploys PrizePool with the Hiero SDK and points the frontend at it.
 *
 * Usage: yarn foundry:deploy [--network testnet|mainnet|local] [--keystore <name>] [--node <id>]
 * Tunables (env): ROUND_SECONDS, DRAW_GRACE_SECONDS, KEEPER_BUFFER_HBAR, MIN_DEPOSIT_HBAR, MAX_PARTICIPANTS,
 *                 DRAW_GAS_LIMIT, TICKET_FEE_HBAR, KEEPER_SEED_HBAR, DEPLOYER_KEYSTORE_PASSWORD
 */
import { AccountId, PrivateKey } from "@hiero-ledger/sdk";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { mirrorGet, networkByName } from "./lib/networks.js";
import { writeFrontendContracts } from "./lib/frontendContracts.js";
import {
  deployPrizePool,
  gasPriceTinybars,
  maxDrawFee,
  prizePoolConfig,
} from "./lib/prizePool.js";
import { selectOrCreateKeystore } from "./selectOrCreateKeystore.js";

const FOUNDRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(FOUNDRY_ROOT, ".env") });

function parseArgs(argv) {
  const args = {
    network: "testnet",
    keystore: process.env.ETH_KEYSTORE_ACCOUNT || undefined,
    node: undefined,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--network") args.network = value;
    else if (flag === "--keystore") args.keystore = value;
    else if (flag === "--node") {
      if (!/^\d+$/.test(value ?? ""))
        throw new Error(
          `--node needs a consensus node id (e.g. --node 3), got '${
            value ?? ""
          }'`
        );
      args.node = Number(value);
    } else
      throw new Error(
        `Unknown option '${flag}'. Usage: yarn foundry:deploy [--network testnet] [--keystore name] [--node id]`
      );
  }
  return args;
}

async function promptHidden(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl._writeToOutput = () => {};
  process.stdout.write(question);
  const answer = await new Promise((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function loadDeployer(keystoreName) {
  const path = join(process.env.HOME, ".foundry", "keystores", keystoreName);
  if (!existsSync(path))
    throw new Error(
      `Keystore '${keystoreName}' not found in ~/.foundry/keystores`
    );
  const password =
    process.env.DEPLOYER_KEYSTORE_PASSWORD ??
    (await promptHidden(`🔐 Password for keystore '${keystoreName}': `));
  return ethers.Wallet.fromEncryptedJson(readFileSync(path, "utf8"), password);
}

/** Faucet and wallet accounts are created from their EVM alias; the mirror node maps it back to 0.0.x. */
async function accountIdFor(network, evmAddress) {
  const account = await mirrorGet(network, `/accounts/${evmAddress}`);
  if (!account?.account) {
    throw new Error(
      `No Hedera account for ${evmAddress} on ${network.name}. Fund it at https://portal.hedera.com/faucet first; ` +
        "the first transfer creates the account."
    );
  }
  return AccountId.fromString(account.account);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = networkByName(args.network);
  const stakedNodeId = args.node ?? network.defaultNode;
  const config = prizePoolConfig();

  const keystore = args.keystore ?? (await selectOrCreateKeystore());
  const wallet = await loadDeployer(keystore);
  const operatorId = await accountIdFor(network, wallet.address);
  const client = network
    .client()
    .setOperator(operatorId, PrivateKey.fromStringECDSA(wallet.privateKey));

  console.log(
    `\n🚀 Deploying PrizePool to Hedera ${network.name} as ${operatorId} (${wallet.address})`
  );
  console.log(
    `   round ${config.roundSeconds}s · grace ${config.drawGraceSeconds}s · max ${config.maxParticipants} savers · ` +
      `draw gas ${config.drawGasLimit}`
  );

  const drawFee = maxDrawFee(config, await gasPriceTinybars(network.rpc));
  if (config.keeperBuffer < 2n * drawFee) {
    // Inside a draw half the reserve stands in for that draw's up-front fee, and the other half must still pay the
    // next one before principal is touched (PrizePool._reserveToSchedule). Below two fees the pool could stall early
    // or dip into principal for a moment, and with no admin key that can't be fixed after deployment.
    throw new Error(
      `KEEPER_BUFFER_HBAR (${
        Number(config.keeperBuffer) / 1e8
      }) must cover two draws' up-front fees: ` +
        `2 × ${Number(drawFee) / 1e8} HBAR at DRAW_GAS_LIMIT ${
          config.drawGasLimit
        } and today's gas price. Raise it.`
    );
  }

  try {
    // Read before anything is created so event queries from this block include Initialized and the seed boost.
    const deployedOnBlock = await new ethers.providers.JsonRpcProvider(
      network.rpc
    ).getBlockNumber();
    const deployment = await deployPrizePool({ client, stakedNodeId, config });
    writeFrontendContracts(network, deployment, deployedOnBlock);

    console.log(
      `\n🎉 PrizePool ${deployment.contractId} (${deployment.address})`
    );
    if (network.hashscan)
      console.log(`   ${network.hashscan}/contract/${deployment.contractId}`);
    console.log(
      `   staking: ${network.mirror}/accounts/${deployment.contractId}\n`
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message ?? error}`);
  process.exit(1);
});
