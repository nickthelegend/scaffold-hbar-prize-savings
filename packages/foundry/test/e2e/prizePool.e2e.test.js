/**
 * End-to-end test of PrizePool on a real Hedera network: real HTS, HSS, PRNG and staking, no simulated contracts.
 *
 *   yarn foundry:test:e2e                              # Hiero Local Node (default)
 *   E2E_NETWORK=testnet HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x... yarn foundry:test:e2e
 *
 * The suite deploys a fresh pool with 30-second rounds through the same code path as `yarn foundry:deploy`,
 * creates two savers, and walks a full round: deposit → frozen tickets → boost → draw executed by the schedule the
 * contract created → prize credited → withdraw.
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
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  mirrorGet,
  networkByName,
  waitFor,
} from "../../scripts-js/lib/networks.js";
import {
  deployPrizePool,
  prizePoolConfig,
} from "../../scripts-js/lib/prizePool.js";

const network = networkByName(process.env.E2E_NETWORK ?? "local");

/** Genesis operator of a Hiero Local Node. Publicly documented, only valid on a local network. */
const LOCAL_GENESIS = {
  id: "0.0.2",
  key: "302e020100300506032b65700422042091132178e72057a1d7528025956fe39b0b847f200ab59b2fdd367017f3087137",
};

const TINYBARS = 100_000_000n;
const DEPOSIT_HBAR = "5";
const BOOST_HBAR = 3;
const ROUND_SECONDS = 30;

function operatorFromEnv() {
  if (network.name === "local") {
    return {
      id: AccountId.fromString(LOCAL_GENESIS.id),
      key: PrivateKey.fromStringDer(LOCAL_GENESIS.key),
    };
  }
  const id = process.env.HEDERA_OPERATOR_ID;
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!id || !key)
    throw new Error(
      "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (ECDSA) to run on a public network."
    );
  return { id: AccountId.fromString(id), key: PrivateKey.fromStringECDSA(key) };
}

/** Creates an EVM-compatible saver (ECDSA key with alias, unlimited auto-associations) funded with `hbar`. */
async function createSaver(client, provider, hbar) {
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(new Hbar(hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client);
  const { accountId } = await tx.getReceipt(client);
  const wallet = new ethers.Wallet(`0x${key.toStringRaw()}`, provider);
  return { accountId: accountId.toString(), wallet };
}

async function ticketHolding(accountId, tokenId) {
  const res = await mirrorGet(
    network,
    `/accounts/${accountId}/tokens?token.id=${tokenId}`
  );
  return res?.tokens?.[0];
}

async function poolEvents(contractId, iface) {
  const res = await mirrorGet(
    network,
    `/contracts/${contractId}/results/logs?order=desc&limit=100`
  );
  return (res?.logs ?? []).flatMap((log) => {
    try {
      return [
        {
          ...iface.parseLog({ topics: log.topics, data: log.data }),
          timestamp: log.timestamp,
        },
      ];
    } catch {
      return [];
    }
  });
}

const entityId = (address) => `0.0.${BigInt(address).toString()}`;

/**
 * A contract created without an admin key is immutable; the mirror node reports its admin key as a protobuf `Key`
 * holding the contract's own id (field 1 → ContractID, field 3 = contract number). Returns that number, or null.
 */
function selfKeyContractNum(adminKey) {
  if (!adminKey) return null;
  const bytes = Buffer.from(adminKey.key, "hex");
  if (bytes[0] !== 0x0a || bytes[2] !== 0x18) return null;
  let num = 0n;
  for (let i = 3, shift = 0n; i < bytes.length; i++, shift += 7n) {
    num |= BigInt(bytes[i] & 0x7f) << shift;
    if ((bytes[i] & 0x80) === 0) break;
  }
  return num;
}

/**
 * Long-term schedules execute when the network handles a transaction at or after their expiry second. Public
 * networks always have traffic; an idle local node needs a nudge, so this sends a 1-tinybar transfer.
 */
async function explainStall(contractId, scheduleAddress) {
  const schedule = await mirrorGet(
    network,
    `/schedules/${entityId(scheduleAddress)}`
  );
  const results = await mirrorGet(
    network,
    `/contracts/${contractId}/results?order=desc&limit=5`
  );
  const calls = (results?.results ?? []).map((r) => ({
    at: r.timestamp,
    from: r.from,
    selector: r.function_parameters?.slice(0, 10),
    result: r.result,
    error: r.error_message,
    gasUsed: r.gas_used,
    gasLimit: r.gas_limit,
  }));
  return JSON.stringify({ schedule, recentCalls: calls }, null, 2);
}

async function heartbeat(client, to) {
  const tx = await new TransferTransaction()
    .addHbarTransfer(client.operatorAccountId, Hbar.fromTinybars(-1))
    .addHbarTransfer(to, Hbar.fromTinybars(1))
    .execute(client);
  await tx.getReceipt(client);
}

describe(
  `PrizePool end-to-end on Hedera ${network.name}`,
  { timeout: 600_000 },
  () => {
    let client;
    let provider;
    let deployment;
    let pool;
    let iface;
    let ticketId;
    let alice;
    let bob;

    before(async () => {
      const operator = operatorFromEnv();
      client = network.client().setOperator(operator.id, operator.key);
      provider = new ethers.providers.JsonRpcProvider(network.rpc);

      deployment = await deployPrizePool({
        client,
        stakedNodeId: network.defaultNode,
        config: prizePoolConfig({
          ROUND_SECONDS: ROUND_SECONDS,
          DRAW_GRACE_SECONDS: 20,
          KEEPER_BUFFER_HBAR: 1,
          KEEPER_SEED_HBAR: 2,
        }),
        log: () => {},
      });
      iface = new ethers.utils.Interface(deployment.abi);
      pool = new ethers.Contract(deployment.address, deployment.abi, provider);
      ticketId = entityId(await pool.ticket());

      [alice, bob] = await Promise.all([
        createSaver(client, provider, 20),
        createSaver(client, provider, 20),
      ]);
    });

    after(() => client?.close());

    it("is created with a native staking election and no admin key", async () => {
      const account = await waitFor(
        () => mirrorGet(network, `/accounts/${deployment.contractId}`),
        {
          label: "pool account on the mirror node",
        }
      );
      assert.equal(account.staked_node_id, network.defaultNode);
      assert.equal(account.decline_reward, false);

      const contract = await mirrorGet(
        network,
        `/contracts/${deployment.contractId}`
      );
      const selfKey = selfKeyContractNum(contract.admin_key);
      assert.ok(
        contract.admin_key === null ||
          selfKey === BigInt(deployment.contractId.num.toString()),
        "no admin key: the contract is immutable"
      );
    });

    it("schedules its first draw through HSS at initialize", async () => {
      const schedule = await pool.nextDrawSchedule();
      assert.notEqual(schedule, ethers.constants.AddressZero);
      const record = await waitFor(
        () => mirrorGet(network, `/schedules/${entityId(schedule)}`),
        {
          label: "schedule entity",
        }
      );
      assert.equal(record.executed_timestamp, null);
    });

    it("issues frozen HTS tickets 1:1 for deposits", async () => {
      for (const saver of [alice, bob]) {
        const tx = await pool.connect(saver.wallet).deposit({
          value: ethers.utils.parseEther(DEPOSIT_HBAR),
          gasLimit: 1_500_000,
        });
        await tx.wait();
      }

      const expected = BigInt(DEPOSIT_HBAR) * TINYBARS;
      assert.equal((await pool.totalPrincipal()).toBigInt(), expected * 2n);

      for (const saver of [alice, bob]) {
        const holding = await waitFor(
          async () => {
            const h = await ticketHolding(saver.accountId, ticketId);
            return h && BigInt(h.balance) === expected ? h : undefined;
          },
          { label: `tickets for ${saver.accountId}` }
        );
        assert.equal(holding.freeze_status, "FROZEN");
      }
    });

    it("refuses ticket transfers because holdings are frozen", async () => {
      const ticket = new ethers.Contract(
        await pool.ticket(),
        ["function transfer(address to, uint256 amount) returns (bool)"],
        alice.wallet
      );
      await assert.rejects(async () => {
        const tx = await ticket.transfer(bob.wallet.address, 1, {
          gasLimit: 200_000,
        });
        await tx.wait();
      });
    });

    it("runs the scheduled draw, picks a saver with PRNG and credits the prize", async () => {
      const boost = await new ContractExecuteTransaction()
        .setContractId(deployment.contractId)
        .setGas(100_000)
        .setPayableAmount(new Hbar(BOOST_HBAR))
        .setFunction("boostPrize")
        .execute(client);
      await boost.getReceipt(client);
      const prizeBefore = (await pool.prize()).toBigInt();
      assert.ok(prizeBefore > 0n, "boost creates a prize");

      const firstSchedule = await pool.nextDrawSchedule();
      const roundEnd = (await pool.roundEnd()).toNumber();
      console.log(
        `round ends at ${roundEnd}, draw scheduled as ${entityId(
          firstSchedule
        )}`
      );
      try {
        await waitFor(
          async () => {
            if ((await pool.currentRound()).toNumber() >= 2) return true;
            await heartbeat(client, alice.accountId);
            return false;
          },
          {
            timeoutMs: (ROUND_SECONDS + 90) * 1000,
            intervalMs: 3_000,
            label: "the network to execute the scheduled draw",
          }
        );
      } catch (error) {
        console.error(
          await explainStall(deployment.contractId.toString(), firstSchedule)
        );
        throw error;
      }

      const executed = await waitFor(
        async () =>
          (
            await mirrorGet(network, `/schedules/${entityId(firstSchedule)}`)
          )?.executed_timestamp,
        { label: "schedule executed on the mirror node" }
      );
      assert.ok(executed);

      const draw = await waitFor(
        async () =>
          (
            await poolEvents(deployment.contractId, iface)
          ).find((e) => e.name === "DrawExecuted"),
        { label: "DrawExecuted event" }
      );
      const winner = draw.args.winner;
      assert.ok(
        [alice.wallet.address, bob.wallet.address].includes(winner),
        "winner is a saver"
      );
      assert.equal(draw.args.round.toNumber(), 1);
      assert.notEqual(
        draw.args.seed,
        ethers.constants.HashZero,
        "PRNG returned a seed"
      );

      const prize = draw.args.prize.toBigInt();
      const [winnerBalance] = await pool.accountOf(winner);
      assert.equal(
        winnerBalance.toBigInt(),
        BigInt(DEPOSIT_HBAR) * TINYBARS + prize
      );

      const nextSchedule = await pool.nextDrawSchedule();
      assert.notEqual(
        nextSchedule,
        firstSchedule,
        "the draw scheduled the next one"
      );
    });

    it("returns full principal (and prize) on withdraw and wipes the tickets", async () => {
      for (const saver of [alice, bob]) {
        const [balance] = await pool.accountOf(saver.wallet.address);
        const before = await provider.getBalance(saver.wallet.address);
        const tx = await pool
          .connect(saver.wallet)
          .withdraw(balance, { gasLimit: 1_500_000 });
        const receipt = await tx.wait();
        const after = await provider.getBalance(saver.wallet.address);

        // Balances over JSON-RPC are weibars: 1 tinybar = 1e10 weibar.
        const received = after
          .sub(before)
          .add(receipt.gasUsed.mul(receipt.effectiveGasPrice));
        assert.ok(
          received.gte(balance.mul(10_000_000_000).mul(99).div(100)),
          "received ~principal back"
        );

        const holding = await waitFor(
          async () => {
            const h = await ticketHolding(saver.accountId, ticketId);
            return h && BigInt(h.balance) === 0n ? h : undefined;
          },
          { label: `tickets wiped for ${saver.accountId}` }
        );
        assert.equal(holding.freeze_status, "UNFROZEN");
      }

      assert.equal((await pool.totalPrincipal()).toBigInt(), 0n);
      assert.equal((await pool.participantsCount()).toNumber(), 0);
    });
  }
);
