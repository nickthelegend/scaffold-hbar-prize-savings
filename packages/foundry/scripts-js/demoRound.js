/**
 * Plays one real round against your deployed PrizePool and prints a HashScan link for every step, so a fresh
 * deployment comes with verifiable proof that it works end to end:
 *
 *   1. the deployer deposits (the round's first deposit schedules its draw through the Hedera Schedule Service)
 *   2. a second saver is created (ECDSA alias, unlimited auto-association) and deposits
 *   3. the deployer boosts the prize
 *   4. the second saver tries to transfer a ticket, which reverts because holdings are frozen
 *   5. waits for the network to execute the scheduled draw (PRNG picks the winner)
 *   6. the second saver withdraws part of their deposit (tickets are wiped)
 *
 * Usage: yarn foundry:demo [--network testnet] [--keystore name]
 * Env:   DEMO_DEPOSIT_HBAR (default 12), DEMO_SAVER_DEPOSIT_HBAR (10), DEMO_BOOST_HBAR (5), DEPLOYER_KEYSTORE_PASSWORD
 *
 * Progress (including the second saver's key, which only ever holds testnet HBAR) is kept in the gitignored
 * `deployments/demo-<chainId>.json`, so an interrupted run resumes where it stopped instead of repeating steps.
 * The proof itself is written to `deployments/proof-<chainId>.json`.
 */
import {
  AccountCreateTransaction,
  AccountId,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { mirrorGet, networkByName, waitFor } from "./lib/networks.js";

const FOUNDRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(FOUNDRY_ROOT, ".env") });

const WEIBARS_PER_TINYBAR = 10_000_000_000n;
const TINYBARS_PER_HBAR = 100_000_000n;
/** Same limits the frontend sends (packages/nextjs/utils/prize-savings/gas.ts). */
const GAS = {
  depositNewSaver: 1_100_000,
  scheduling: 1_800_000,
  withdraw: 200_000,
  boostPrize: 100_000,
};

const log = (message) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

function parseArgs(argv) {
  const args = {
    network: "testnet",
    keystore: process.env.ETH_KEYSTORE_ACCOUNT || undefined,
  };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--network") args.network = argv[i + 1];
    else if (argv[i] === "--keystore") args.keystore = argv[i + 1];
    else
      throw new Error(
        `Unknown option '${argv[i]}'. Usage: yarn foundry:demo [--network testnet] [--keystore name]`
      );
  }
  if (!args.keystore)
    throw new Error("Pass --keystore <name> (see yarn foundry:account)");
  return args;
}

const hbarToWeibars = (hbar) =>
  BigInt(Math.round(hbar * 1e8)) * WEIBARS_PER_TINYBAR;

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** HashScan link for an EVM transaction: the mirror node maps its hash to the consensus timestamp. */
async function linkForHash(network, hash) {
  const result = await waitFor(
    () => mirrorGet(network, `/contracts/results/${hash}`),
    { label: `mirror record of ${hash}` }
  );
  return {
    hash,
    timestamp: result.timestamp,
    status: result.result,
    gasUsed: result.gas_used,
    url: `${network.hashscan}/transaction/${result.timestamp}`,
  };
}

const entityId = (address) => `0.0.${BigInt(address).toString()}`;

/** Decoded PrizePool logs from the mirror node, newest first. */
async function poolEvents(network, contractId, iface) {
  const page = await mirrorGet(
    network,
    `/contracts/${contractId}/results/logs?order=desc&limit=100`
  );
  return (page?.logs ?? []).flatMap((entry) => {
    try {
      const parsed = iface.parseLog({ topics: entry.topics, data: entry.data });
      return [{ ...parsed, timestamp: entry.timestamp, entry }];
    } catch {
      return [];
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = networkByName(args.network);
  const deployment = readJson(
    join(FOUNDRY_ROOT, "deployments", `${network.chainId}.json`),
    null
  );
  if (!deployment?.contractId)
    throw new Error(
      `No deployment for ${network.name}; run yarn foundry:deploy --network ${network.name} first`
    );
  const address = Object.keys(deployment).find((key) => key.startsWith("0x"));
  const artifact = JSON.parse(
    readFileSync(join(FOUNDRY_ROOT, "out/PrizePool.sol/PrizePool.json"), "utf8")
  );
  const iface = new ethers.utils.Interface(artifact.abi);

  const statePath = join(
    FOUNDRY_ROOT,
    "deployments",
    `demo-${network.chainId}.json`
  );
  const proofPath = join(
    FOUNDRY_ROOT,
    "deployments",
    `proof-${network.chainId}.json`
  );
  const state = readJson(statePath, { pool: deployment.contractId });
  if (state.pool !== deployment.contractId)
    throw new Error(
      `${statePath} belongs to pool ${state.pool}; move it away to demo the new pool ${deployment.contractId}`
    );
  const proof = readJson(proofPath, {
    network: network.name,
    pool: deployment.contractId,
    poolUrl: `${network.hashscan}/contract/${deployment.contractId}`,
    steps: {},
  });
  const save = () => {
    writeJson(statePath, state);
    writeJson(proofPath, proof);
  };

  const password = process.env.DEPLOYER_KEYSTORE_PASSWORD;
  if (!password)
    throw new Error(
      "Set DEPLOYER_KEYSTORE_PASSWORD (the demo runs unattended for about one round)"
    );
  const keystore = readFileSync(
    join(process.env.HOME, ".foundry", "keystores", args.keystore),
    "utf8"
  );
  // "testnet" is a reserved network name in ethers v5, so name it explicitly.
  const provider = new ethers.providers.StaticJsonRpcProvider(network.rpc, {
    chainId: network.chainId,
    name: `hedera-${network.name}`,
  });
  const deployer = (
    await ethers.Wallet.fromEncryptedJson(keystore, password)
  ).connect(provider);
  const deployerAccount = await mirrorGet(
    network,
    `/accounts/${deployer.address}`
  );
  const client = network
    .client()
    .setOperator(
      AccountId.fromString(deployerAccount.account),
      PrivateKey.fromStringECDSA(deployer.privateKey)
    );
  const pool = new ethers.Contract(address, artifact.abi, provider);
  // ethers v5's EIP-1559 estimate can land below Hedera's minimum gas price; send the relay's own price instead.
  const gasPrice = await provider.getGasPrice();
  log(
    `PrizePool ${deployment.contractId} on ${network.name}, deployer ${deployerAccount.account}`
  );

  try {
    const round = (await pool.currentRound()).toNumber();
    state.round ??= round;

    if (!proof.steps.deposit) {
      const value = Number(process.env.DEMO_DEPOSIT_HBAR ?? 12);
      const tx = await pool.connect(deployer).deposit({
        value: hbarToWeibars(value),
        gasLimit: GAS.depositNewSaver + GAS.scheduling,
        gasPrice,
      });
      await tx.wait();
      proof.steps.deposit = {
        what: `${deployerAccount.account} deposits ${value} HBAR; the round's first deposit schedules its draw`,
        ...(await linkForHash(network, tx.hash)),
      };
      save();
      log(`deposit ${proof.steps.deposit.url}`);
    }

    if (!proof.steps.schedule) {
      const scheduled = (
        await poolEvents(network, deployment.contractId, iface)
      ).find((event) => event.name === "DrawScheduled");
      if (scheduled) {
        const scheduleId = entityId(scheduled.args.schedule);
        proof.steps.schedule = {
          what: `round ${
            scheduled.args.round
          } draw scheduled by the contract itself (HIP-1215), due at ${new Date(
            scheduled.args.expirySecond.toNumber() * 1000
          ).toISOString()}`,
          scheduleId,
          url: `${network.hashscan}/schedule/${scheduleId}`,
        };
        save();
        log(`schedule ${proof.steps.schedule.url}`);
      }
    }

    if (!state.saver) {
      const key = PrivateKey.generateECDSA();
      const deposit = Number(process.env.DEMO_SAVER_DEPOSIT_HBAR ?? 10);
      const response = await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(key)
        .setInitialBalance(new Hbar(deposit + 2))
        .setMaxAutomaticTokenAssociations(-1)
        .execute(client);
      const { accountId } = await response.getReceipt(client);
      state.saver = {
        accountId: accountId.toString(),
        privateKey: `0x${key.toStringRaw()}`,
        deposit,
      };
      proof.steps.saverCreated = {
        what: `second saver ${accountId} created with an ECDSA alias and unlimited auto-association`,
        transactionId: response.transactionId.toString(),
        url: `${network.hashscan}/account/${accountId}`,
      };
      save();
      log(`saver ${accountId}`);
    }
    const saver = new ethers.Wallet(state.saver.privateKey, provider);
    // The JSON-RPC relay resolves senders through the mirror node, which lags account creation by a few seconds.
    await waitFor(() => mirrorGet(network, `/accounts/${saver.address}`), {
      label: `mirror record of ${state.saver.accountId}`,
    });

    if (!proof.steps.saverDeposit) {
      const tx = await pool.connect(saver).deposit({
        value: hbarToWeibars(state.saver.deposit),
        gasLimit: GAS.depositNewSaver,
        gasPrice,
      });
      await tx.wait();
      proof.steps.saverDeposit = {
        what: `${state.saver.accountId} deposits ${state.saver.deposit} HBAR and receives frozen PST tickets 1:1`,
        ...(await linkForHash(network, tx.hash)),
      };
      save();
      log(`saver deposit ${proof.steps.saverDeposit.url}`);
    }

    if (!proof.steps.boost) {
      const value = Number(process.env.DEMO_BOOST_HBAR ?? 5);
      const tx = await pool.connect(deployer).boostPrize({
        value: hbarToWeibars(value),
        gasLimit: GAS.boostPrize,
        gasPrice,
      });
      await tx.wait();
      proof.steps.boost = {
        what: `${deployerAccount.account} boosts the round's prize by ${value} HBAR`,
        ...(await linkForHash(network, tx.hash)),
      };
      save();
      log(`boost ${proof.steps.boost.url}`);
    }

    if (!proof.steps.frozenTransfer) {
      const ticket = new ethers.Contract(
        await pool.ticket(),
        ["function transfer(address to, uint256 amount) returns (bool)"],
        saver
      );
      const tx = await ticket.transfer(deployer.address, 1, {
        gasLimit: 100_000,
        gasPrice,
      });
      const receipt = await tx.wait().catch((error) => error.receipt);
      if (receipt?.status !== 0)
        throw new Error(
          `the ticket transfer ${tx.hash} succeeded; holdings should be frozen`
        );
      proof.steps.frozenTransfer = {
        what: `${state.saver.accountId} tries to transfer a ticket: reverted, the holding is frozen`,
        ...(await linkForHash(network, tx.hash)),
      };
      save();
      log(`frozen transfer reverted ${proof.steps.frozenTransfer.url}`);
    }

    if (!proof.steps.draw) {
      const roundEnd = (await pool.roundEnd()).toNumber();
      const grace = (await pool.drawOpensAt()).toNumber() - roundEnd;
      log(
        `waiting for the network to execute round ${
          state.round
        }'s draw (round ends ${new Date(roundEnd * 1000).toISOString()})`
      );
      const event = await waitFor(
        async () =>
          (
            await poolEvents(network, deployment.contractId, iface)
          ).find(
            (e) =>
              (e.name === "DrawExecuted" || e.name === "RoundRolledOver") &&
              e.args.round.toNumber() === state.round
          ),
        {
          timeoutMs:
            Math.max(0, roundEnd - Date.now() / 1000) * 1000 +
            (grace + 600) * 1000,
          intervalMs: 30_000,
          label: `round ${state.round}'s scheduled draw`,
        }
      );
      const winner = event.args.winner;
      proof.steps.draw = {
        what:
          event.name === "DrawExecuted"
            ? `the network executes the scheduled draw: PRNG seed picks ${winner}, who wins ${ethers.utils.formatUnits(
                event.args.prize,
                8
              )} HBAR`
            : `the network executes the scheduled draw: no prize, round rolled over`,
        event: event.name,
        timestamp: event.timestamp,
        transactionHash: event.entry.transaction_hash,
        url: `${network.hashscan}/transaction/${event.timestamp}`,
      };
      save();
      log(`draw ${proof.steps.draw.url}`);
    }

    if (!proof.steps.withdraw) {
      const amount = (BigInt(state.saver.deposit) * TINYBARS_PER_HBAR) / 2n;
      const tx = await pool
        .connect(saver)
        .withdraw(amount, { gasLimit: GAS.withdraw, gasPrice });
      await tx.wait();
      proof.steps.withdraw = {
        what: `${state.saver.accountId} withdraws ${ethers.utils.formatUnits(
          amount,
          8
        )} HBAR of principal; the matching tickets are wiped`,
        ...(await linkForHash(network, tx.hash)),
      };
      save();
      log(`withdraw ${proof.steps.withdraw.url}`);
    }

    console.log("\n| Step | Transaction |\n|---|---|");
    for (const step of Object.values(proof.steps))
      console.log(`| ${step.what} | [HashScan](${step.url}) |`);
    console.log(`\nProof written to ${proofPath}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message ?? error}`);
  process.exit(1);
});
