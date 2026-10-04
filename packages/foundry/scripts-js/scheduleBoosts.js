/**
 * Pre-signs future `boostPrize` calls with the Hedera Schedule Service, so a demo pool keeps drawing while you are away.
 *
 * Each boost is a HAPI `ScheduleCreate` with `waitForExpiry`: you sign it now, the network executes it at the given
 * time and charges your account then. No server, cron job or keeper stays online. Every draw that schedules the next
 * one costs the pool about 1.4 HBAR of gas on testnet, and with boost-only funding that comes out of the fee reserve
 * (see "The fee reserve" in the README), so a few boosts spread over the period keep the reserve above half.
 *
 * Usage: yarn foundry:schedule-boosts [--network testnet] [--keystore name] [--amount 3] --at 2026-10-08T07:00Z [--at …]
 * Env:   DEPLOYER_KEYSTORE_PASSWORD
 *
 * A boost lands in the prize when it pushes the balance above principal plus the reserve, so schedule them a few hours
 * before a draw and keep them small if you only mean to top up the reserve. Your account needs the HBAR at execution
 * time, not now; a schedule that can't pay fails then and nothing else happens.
 */
import {
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  Timestamp,
} from "@hiero-ledger/sdk";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mirrorGet, networkByName } from "./lib/networks.js";

const FOUNDRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(FOUNDRY_ROOT, ".env") });

/** Hedera keeps a scheduled transaction for at most 62 days. */
const MAX_SCHEDULE_DAYS = 62;
/** Same limit the frontend sends (packages/nextjs/utils/prize-savings/gas.ts). A draw is already scheduled. */
const BOOST_GAS = 100_000;
const USAGE =
  "Usage: yarn foundry:schedule-boosts [--network testnet] [--keystore name] [--amount 3] --at <ISO time> [--at …]";

function parseArgs(argv) {
  const args = {
    network: "testnet",
    keystore: process.env.ETH_KEYSTORE_ACCOUNT || undefined,
    amount: 3,
    at: [],
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--network") args.network = value;
    else if (flag === "--keystore") args.keystore = value;
    else if (flag === "--amount") args.amount = Number(value);
    else if (flag === "--at") args.at.push(new Date(value ?? ""));
    else throw new Error(`Unknown option '${flag}'. ${USAGE}`);
  }
  if (!args.keystore) throw new Error(`Pass --keystore. ${USAGE}`);
  if (!(args.amount > 0))
    throw new Error(`--amount must be a positive HBAR amount. ${USAGE}`);
  if (args.at.length === 0) throw new Error(`Pass at least one --at. ${USAGE}`);
  const latest = Date.now() + MAX_SCHEDULE_DAYS * 86_400_000;
  for (const at of args.at) {
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now())
      throw new Error(`--at needs a future ISO time. ${USAGE}`);
    if (at.getTime() > latest)
      throw new Error(
        `${at.toISOString()} is more than ${MAX_SCHEDULE_DAYS} days away`
      );
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = networkByName(args.network);
  const deployment = JSON.parse(
    readFileSync(
      join(FOUNDRY_ROOT, "deployments", `${network.chainId}.json`),
      "utf8"
    )
  );
  const password = process.env.DEPLOYER_KEYSTORE_PASSWORD;
  if (!password) throw new Error("Set DEPLOYER_KEYSTORE_PASSWORD");
  const wallet = await ethers.Wallet.fromEncryptedJson(
    readFileSync(
      join(process.env.HOME, ".foundry", "keystores", args.keystore),
      "utf8"
    ),
    password
  );
  const account = await mirrorGet(network, `/accounts/${wallet.address}`);
  if (!account?.account)
    throw new Error(`No Hedera account for ${wallet.address}`);
  const operatorId = AccountId.fromString(account.account);
  const client = network
    .client()
    .setOperator(operatorId, PrivateKey.fromStringECDSA(wallet.privateKey));

  console.log(
    `\n⏰ Scheduling ${args.at.length} × ${args.amount} HBAR boosts of PrizePool ${deployment.contractId}, paid by ${operatorId}`
  );
  try {
    for (const at of args.at) {
      const boost = new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(deployment.contractId))
        .setGas(BOOST_GAS)
        .setPayableAmount(new Hbar(args.amount))
        .setFunction("boostPrize");
      const response = await new ScheduleCreateTransaction()
        .setScheduledTransaction(boost)
        .setPayerAccountId(operatorId)
        .setExpirationTime(Timestamp.fromDate(at))
        .setWaitForExpiry(true)
        .setScheduleMemo(`PrizePool boost ${at.toISOString()}`)
        .execute(client);
      const { scheduleId } = await response.getReceipt(client);
      console.log(
        `   ✅ ${at.toISOString()}  schedule ${scheduleId}${
          network.hashscan ? `  ${network.hashscan}/schedule/${scheduleId}` : ""
        }`
      );
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message ?? error}`);
  process.exit(1);
});
