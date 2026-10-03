/**
 * Seeds a demo PrizePool on a Hiero Local Node: real HTS, HSS, PRNG and mirror node, no mocks. Used by
 * `.github/workflows/screens.yaml` to capture the README screenshots, and handy for poking at a lived-in pool locally.
 *
 *   npx @hashgraph/hedera-local start -d
 *   yarn foundry:compile && yarn foundry:seed-demo [--keep-alive]
 *   NEXT_PUBLIC_HEDERA_NETWORK=local yarn next:dev
 *
 * It deploys a pool with short rounds (ROUND_SECONDS, default 90) through the same code path as `yarn foundry:deploy`,
 * points the frontend at it, has four savers deposit different amounts, boosts the prize, and waits (sending
 * heartbeats, which an idle local node needs to execute due schedules) until SEED_DRAWS scheduled draws (default 2)
 * have run. With `--keep-alive` it then keeps the pool going until killed: it boosts each new round's prize and
 * keeps sending heartbeats, so there is always an open round with a live countdown and a growing draw history.
 *
 * Progress is written to `deployments/demo-298.json` (gitignored), including the savers' throwaway local-node keys so
 * a browser test can connect as one of them with the burner wallet.
 */
import {
  AccountCreateTransaction,
  AccountId,
  ContractExecuteTransaction,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFrontendContracts } from "./lib/frontendContracts.js";
import { networkByName, waitFor } from "./lib/networks.js";
import { deployPrizePool, prizePoolConfig } from "./lib/prizePool.js";

const FOUNDRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = networkByName("local");
const STATE_FILE = join(
  FOUNDRY_ROOT,
  "deployments",
  `demo-${network.chainId}.json`
);

/** Genesis operator of a Hiero Local Node. Publicly documented, only valid on a local network. */
const LOCAL_GENESIS = {
  id: "0.0.2",
  key: "302e020100300506032b65700422042091132178e72057a1d7528025956fe39b0b847f200ab59b2fdd367017f3087137",
};

const WEIBARS_PER_TINYBAR = 10_000_000_000n;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS ?? 90);
const DRAWS = Number(process.env.SEED_DRAWS ?? 2);
const KEEP_ALIVE = process.argv.includes("--keep-alive");

/** Savers and their deposits in HBAR. The last one joins in round 2, so the rounds differ. */
const SAVERS = [
  { name: "alice", deposit: 250 },
  { name: "bob", deposit: 120 },
  { name: "carol", deposit: 60 },
  { name: "dave", deposit: 35, laterRound: true },
];
/** Sponsor boost per round, in HBAR, cycled while the pool is kept alive. */
const BOOSTS = [42, 27, 55, 33, 48, 38];

/** Gas limits from packages/nextjs/utils/prize-savings/gas.ts, as the frontend sends them. */
const GAS = {
  depositNewSaver: 1_100_000,
  scheduling: 1_800_000,
  boostPrize: 100_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function createSaver(client, provider, { name, deposit }) {
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(new Hbar(deposit + 25))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client);
  const { accountId } = await tx.getReceipt(client);
  const privateKey = `0x${key.toStringRaw()}`;
  const wallet = new ethers.Wallet(privateKey, provider);
  log(`saver ${name}: ${accountId} (${wallet.address})`);
  return {
    name,
    deposit,
    accountId: accountId.toString(),
    address: wallet.address,
    privateKey,
    wallet,
  };
}

/** Long-term schedules execute when the network handles a transaction at or after their expiry second. */
async function heartbeat(client, to) {
  const tx = await new TransferTransaction()
    .addHbarTransfer(client.operatorAccountId, Hbar.fromTinybars(-1))
    .addHbarTransfer(to, Hbar.fromTinybars(1))
    .execute(client);
  await tx.getReceipt(client);
}

/** Sponsor boost from the genesis account. The gas covers scheduling, in case the round's draw is not scheduled yet. */
async function boost(client, contractId, hbar) {
  const tx = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(GAS.boostPrize + GAS.scheduling)
    .setPayableAmount(new Hbar(hbar))
    .setFunction("boostPrize")
    .execute(client);
  await tx.getReceipt(client);
  log(`boosted the prize by ${hbar} HBAR`);
}

async function deposit(pool, saver, schedules) {
  const tx = await pool.connect(saver.wallet).deposit({
    value: BigInt(saver.deposit) * 100_000_000n * WEIBARS_PER_TINYBAR,
    gasLimit: GAS.depositNewSaver + (schedules ? GAS.scheduling : 0),
  });
  await tx.wait();
  log(`${saver.name} deposited ${saver.deposit} HBAR`);
}

/** Sends heartbeats until the pool moves past `round`, i.e. the network has executed that round's scheduled draw. */
async function waitForDraw(client, pool, round, nudge) {
  await waitFor(
    async () => {
      if ((await pool.currentRound()).toNumber() > round) return true;
      await heartbeat(client, nudge);
      return false;
    },
    {
      timeoutMs: (ROUND_SECONDS + 150) * 1000,
      intervalMs: 3_000,
      label: `the scheduled draw of round ${round}`,
    }
  );
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const client = network
    .client()
    .setOperator(
      AccountId.fromString(LOCAL_GENESIS.id),
      PrivateKey.fromStringDer(LOCAL_GENESIS.key)
    );
  const provider = new ethers.providers.StaticJsonRpcProvider(network.rpc, {
    chainId: network.chainId,
    name: network.name,
  });
  // A freshly started local node can accept SDK transactions before its JSON-RPC relay answers.
  await waitFor(() => provider.getGasPrice().catch(() => undefined), {
    timeoutMs: 180_000,
    intervalMs: 5_000,
    label: "the JSON-RPC relay",
  });

  const savers = await Promise.all(
    SAVERS.map((s) => createSaver(client, provider, s))
  );

  const config = prizePoolConfig({
    ROUND_SECONDS,
    DRAW_GRACE_SECONDS: 20,
    KEEPER_BUFFER_HBAR: 6,
    KEEPER_SEED_HBAR: 7,
  });
  const deployedOnBlock = await provider.getBlockNumber();
  const deployment = await deployPrizePool({
    client,
    stakedNodeId: network.defaultNode,
    config,
    log,
  });
  writeFrontendContracts(network, deployment, deployedOnBlock);
  const pool = new ethers.Contract(
    deployment.address,
    deployment.abi,
    provider
  );
  log(
    `PrizePool ${deployment.contractId} (${deployment.address}), ${ROUND_SECONDS}s rounds`
  );

  const state = {
    contractId: deployment.contractId.toString(),
    address: deployment.address,
    roundSeconds: ROUND_SECONDS,
    draws: 0,
    savers: savers.map(({ wallet, ...saver }) => saver),
  };
  writeState(state);

  // Round 1: three savers (the first deposit schedules the draw) and a sponsor boost.
  const [first, ...others] = savers.filter((s) => !s.laterRound);
  await deposit(pool, first, true);
  for (const saver of others) await deposit(pool, saver, false);
  let boosts = 0;
  await boost(client, deployment.contractId, BOOSTS[boosts++ % BOOSTS.length]);

  let round = (await pool.currentRound()).toNumber();
  const afterDraw = async () => {
    state.draws += 1;
    state.round = round;
    writeState(state);
    log(
      `round ${round - 1} drawn; round ${round} open, ${(
        await pool.participantsCount()
      ).toString()} savers`
    );
  };

  for (let i = 0; i < DRAWS; i++) {
    await waitForDraw(client, pool, round, first.accountId);
    round = (await pool.currentRound()).toNumber();
    if (i === 0) {
      for (const saver of savers.filter((s) => s.laterRound))
        await deposit(pool, saver, false);
    }
    await boost(
      client,
      deployment.contractId,
      BOOSTS[boosts++ % BOOSTS.length]
    );
    await afterDraw();
  }
  log(
    `seeded: ${
      state.draws
    } draws, round ${round} open with prize ${ethers.utils.formatUnits(
      await pool.prize(),
      8
    )} HBAR`
  );

  if (!KEEP_ALIVE) {
    client.close();
    return;
  }
  log("keeping the pool alive (heartbeats + a boost per round) until killed");
  for (;;) {
    await heartbeat(client, first.accountId);
    const current = (await pool.currentRound()).toNumber();
    if (current > round) {
      round = current;
      await boost(
        client,
        deployment.contractId,
        BOOSTS[boosts++ % BOOSTS.length]
      );
      await afterDraw();
    }
    await sleep(3_000);
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.stack ?? error}`);
  process.exit(1);
});
