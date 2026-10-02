/**
 * End-to-end test of PrizePool on a real Hedera network: real HTS, HSS, PRNG and staking, no simulated contracts.
 *
 *   yarn foundry:test:e2e                              # Hiero Local Node (default)
 *   E2E_NETWORK=testnet HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x... yarn foundry:test:e2e
 *
 * Two pools are deployed through the same code path as `yarn foundry:deploy`, with rounds of a few seconds:
 *
 * 1. Self-scheduled round: an empty pool schedules nothing; the first deposit schedules the draw; tickets are frozen
 *    1:1; nobody but the schedule can call `draw`; `prize()` is balance − principal − reserve; the network executes
 *    the draw, pays its fee from the surplus and credits the winner; withdrawals return principal to the tinybar; an
 *    emptied pool stops scheduling (and paying for) draws.
 * 2. Manual trigger: a pool whose fee reserve is short schedules nothing; a saver without auto-association slots must
 *    associate first; `triggerDraw` opens only after `drawOpensAt()`, needs the reserve topped up, and only schedules
 *    the draw, which then runs as the contract's own transaction.
 *
 * Gas used by every entry point is printed at the end; README "Costs and sizing" and the frontend gas limits come from
 * these numbers.
 */
import {
  AccountCreateTransaction,
  AccountId,
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
const WEIBARS_PER_TINYBAR = 10_000_000_000n;
const DEPOSIT = 10n * TINYBARS;
const BOOST = 3n * TINYBARS;
/** `NotScheduledReason` in PrizePool.sol. */
const NO_PARTICIPANTS = 0;
const INSUFFICIENT_RESERVE = 1;
/** Hedera response code for a transfer to an account that is not associated with the token. */
const TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;

/** Gas used per entry point, printed after the suite. */
const gasUsed = {};

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

/** Creates an EVM-compatible saver (ECDSA key with alias) funded with `hbar`. */
async function createSaver(client, provider, hbar, autoAssociations = -1) {
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(new Hbar(hbar))
    .setMaxAutomaticTokenAssociations(autoAssociations)
    .execute(client);
  const { accountId } = await tx.getReceipt(client);
  const wallet = new ethers.Wallet(`0x${key.toStringRaw()}`, provider);
  return { accountId: accountId.toString(), wallet };
}

const entityId = (address) => `0.0.${BigInt(address).toString()}`;

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

function findEvent(contractId, iface, name, matches = () => true) {
  return waitFor(
    async () =>
      (await poolEvents(contractId, iface)).find(
        (e) => e.name === name && matches(e.args)
      ),
    { label: `${name} event` }
  );
}

/** Pool balance in tinybars. The relay reports weibars. */
async function balanceOf(provider, address) {
  return (await provider.getBalance(address)).toBigInt() / WEIBARS_PER_TINYBAR;
}

const SYSTEM_CONTRACTS = {
  "0x0000000000000000000000000000000000000167": "HTS",
  "0x0000000000000000000000000000000000000169": "PRNG",
  "0x000000000000000000000000000000000000016b": "HSS",
};

/** Gas each system-contract call inside a transaction used, from the mirror node's call trace. */
async function systemCallGas(hash) {
  const res = await waitFor(
    () => mirrorGet(network, `/contracts/results/${hash}/actions?limit=100`),
    { label: `actions of ${hash}` }
  );
  return (res?.actions ?? []).flatMap((a) => {
    const name = SYSTEM_CONTRACTS[a.to?.toLowerCase()];
    return name
      ? [
          `${name} ${a.input?.slice(0, 10)}: ${a.gas_used}/${a.gas} ${
            a.result_data_type
          }`,
        ]
      : [];
  });
}

/** Sends a transaction, waits for it and records its gas (and its system-contract calls) under `label`. */
async function send(label, sendTx) {
  const tx = await sendTx();
  const receipt = await tx.wait();
  gasUsed[label] = receipt.gasUsed.toNumber();
  gasUsed[`${label}: system calls`] = await systemCallGas(tx.hash);
  return receipt;
}

/**
 * Sends a transaction that must fail on-chain and returns the custom error name it reverted with, read from the
 * mirror node's record of the executed transaction (no simulation involved).
 */
async function expectRevert(iface, label, sendTx) {
  const tx = await sendTx();
  await assert.rejects(tx.wait(), `${label} should revert`);
  const result = await waitFor(
    async () => {
      const r = await mirrorGet(network, `/contracts/results/${tx.hash}`);
      return r?.error_message ? r : undefined;
    },
    { label: `${label} on the mirror node` }
  );
  try {
    const parsed = iface.parseError(result.error_message);
    return { name: parsed.name, args: parsed.args };
  } catch {
    return { name: result.error_message, args: [] };
  }
}

/**
 * Long-term schedules execute when the network handles a transaction at or after their expiry second. Public
 * networks always have traffic; an idle local node needs a nudge, so this sends a 1-tinybar transfer.
 */
async function heartbeat(client, to) {
  const tx = await new TransferTransaction()
    .addHbarTransfer(client.operatorAccountId, Hbar.fromTinybars(-1))
    .addHbarTransfer(to, Hbar.fromTinybars(1))
    .execute(client);
  await tx.getReceipt(client);
}

/** Waits (sending heartbeats) until `predicate` holds, explaining the pool's recent calls if it never does. */
async function waitOnChain(client, nudge, predicate, { label, timeoutMs }) {
  return waitFor(
    async () => {
      if (await predicate()) return true;
      await heartbeat(client, nudge);
      return false;
    },
    { timeoutMs, intervalMs: 3_000, label }
  );
}

/** The contract result of the latest `draw` the network executed for `contractId`. */
async function latestDrawResult(contractId, selector) {
  const res = await mirrorGet(
    network,
    `/contracts/${contractId}/results?order=desc&limit=25`
  );
  return (res?.results ?? []).find((r) =>
    r.function_parameters?.startsWith(selector)
  );
}

async function explainStall(contractId) {
  const results = await mirrorGet(
    network,
    `/contracts/${contractId}/results?order=desc&limit=8`
  );
  return JSON.stringify(
    (results?.results ?? []).map((r) => ({
      at: r.timestamp,
      from: r.from,
      selector: r.function_parameters?.slice(0, 10),
      result: r.result,
      error: r.error_message,
      gasUsed: r.gas_used,
      gasLimit: r.gas_limit,
    })),
    null,
    2
  );
}

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

describe(
  `PrizePool end-to-end on Hedera ${network.name}`,
  { timeout: 900_000 },
  () => {
    let client;
    let provider;
    let gasPrice;

    before(async () => {
      const operator = operatorFromEnv();
      client = network.client().setOperator(operator.id, operator.key);
      provider = new ethers.providers.JsonRpcProvider(network.rpc);
      gasPrice =
        (await provider.getGasPrice()).toBigInt() / WEIBARS_PER_TINYBAR;
    });

    after(() => {
      console.log(
        `gas price ${gasPrice} tinybar/gas; gas used per call:\n${JSON.stringify(
          gasUsed,
          null,
          2
        )}`
      );
      client?.close();
    });

    describe("self-scheduled round", () => {
      const ROUND_SECONDS = 60;
      const config = prizePoolConfig({
        ROUND_SECONDS,
        DRAW_GRACE_SECONDS: 20,
        KEEPER_BUFFER_HBAR: 10,
        KEEPER_SEED_HBAR: 11,
        DRAW_GAS_LIMIT: 6_000_000,
      });
      let deployment;
      let pool;
      let iface;
      let ticketId;
      let alice;
      let bob;
      let drawRound;
      let balanceBeforeDraw;

      before(async () => {
        // Savers first, so the deposits land early in the first round.
        [alice, bob] = await Promise.all([
          createSaver(client, provider, 60),
          createSaver(client, provider, 60),
        ]);
        deployment = await deployPrizePool({
          client,
          stakedNodeId: network.defaultNode,
          config,
          log: () => {},
        });
        iface = new ethers.utils.Interface(deployment.abi);
        pool = new ethers.Contract(
          deployment.address,
          deployment.abi,
          provider
        );
        ticketId = entityId(await pool.ticket());
      });

      it("is created with a native staking election and no admin key", async () => {
        const account = await waitFor(
          () => mirrorGet(network, `/accounts/${deployment.contractId}`),
          { label: "pool account on the mirror node" }
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

      it("does not schedule a draw while the pool is empty", async () => {
        assert.equal(
          await pool.nextDrawSchedule(),
          ethers.constants.AddressZero
        );
        assert.equal((await pool.scheduledRound()).toNumber(), 0);
        const skipped = await findEvent(
          deployment.contractId,
          iface,
          "DrawNotScheduled",
          (a) => a.round.toNumber() === 1
        );
        assert.equal(skipped.args.reason, NO_PARTICIPANTS);
      });

      it("schedules the draw when the first saver joins and issues frozen tickets 1:1", async () => {
        await send("deposit (first saver, schedules the draw)", () =>
          pool.connect(alice.wallet).deposit({
            value: DEPOSIT * WEIBARS_PER_TINYBAR,
            gasLimit: 8_000_000,
          })
        );
        drawRound = (await pool.currentRound()).toNumber();
        assert.equal((await pool.scheduledRound()).toNumber(), drawRound);
        const schedule = await pool.nextDrawSchedule();
        assert.notEqual(schedule, ethers.constants.AddressZero);
        const record = await waitFor(
          () => mirrorGet(network, `/schedules/${entityId(schedule)}`),
          { label: "schedule entity" }
        );
        assert.equal(record.executed_timestamp, null);

        await send("deposit (new saver)", () =>
          pool.connect(bob.wallet).deposit({
            value: DEPOSIT * WEIBARS_PER_TINYBAR,
            gasLimit: 1_500_000,
          })
        );
        await send("deposit (existing saver top-up)", () =>
          pool.connect(bob.wallet).deposit({
            value: DEPOSIT * WEIBARS_PER_TINYBAR,
            gasLimit: 1_500_000,
          })
        );
        assert.equal(
          await pool.nextDrawSchedule(),
          schedule,
          "later deposits do not schedule again"
        );
        assert.equal((await pool.totalPrincipal()).toBigInt(), DEPOSIT * 3n);

        for (const [saver, expected] of [
          [alice, DEPOSIT],
          [bob, DEPOSIT * 2n],
        ]) {
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

      it("prize() is the balance above principal and the fee reserve", async () => {
        await send("boostPrize (draw already scheduled)", () =>
          pool.connect(alice.wallet).boostPrize({
            value: BOOST * WEIBARS_PER_TINYBAR,
            gasLimit: 400_000,
          })
        );
        const balance = await balanceOf(provider, deployment.address);
        const principal = (await pool.totalPrincipal()).toBigInt();
        const prize = (await pool.prize()).toBigInt();
        assert.equal(prize, balance - principal - config.keeperBuffer);
        assert.ok(prize > 0n, "the seed and the boost create a prize");
        assert.equal((await pool.reserveShortfall()).toBigInt(), 0n);
        balanceBeforeDraw = balance;
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

      it("lets nobody but the schedule draw, so nobody can re-roll the winner", async () => {
        const direct = await expectRevert(iface, "draw from a saver", () =>
          pool.connect(alice.wallet).draw(drawRound, { gasLimit: 300_000 })
        );
        assert.equal(direct.name, "OnlyScheduled");

        const early = await expectRevert(
          iface,
          "triggerDraw while the schedule is live",
          () => pool.connect(alice.wallet).triggerDraw({ gasLimit: 300_000 })
        );
        assert.equal(early.name, "DrawNotOpen");
        assert.equal(
          (await balanceOf(provider, deployment.address)) - balanceBeforeDraw,
          0n,
          "failed calls leave the pool untouched"
        );
      });

      it("runs the scheduled draw, pays its fee from the surplus and credits the winner", async () => {
        const principalBefore = (await pool.totalPrincipal()).toBigInt();
        try {
          await waitOnChain(
            client,
            alice.accountId,
            async () => (await pool.currentRound()).toNumber() > drawRound,
            {
              label: "the network to execute the scheduled draw",
              timeoutMs: (ROUND_SECONDS + 90) * 1000,
            }
          );
        } catch (error) {
          console.error(await explainStall(deployment.contractId.toString()));
          throw error;
        }

        const draw = await findEvent(
          deployment.contractId,
          iface,
          "DrawExecuted",
          (a) => a.round.toNumber() === drawRound
        );
        const { winner } = draw.args;
        assert.ok(
          [alice.wallet.address, bob.wallet.address].includes(winner),
          "winner is a saver"
        );
        assert.notEqual(draw.args.seed, ethers.constants.HashZero);

        const prize = draw.args.prize.toBigInt();
        assert.ok(prize > 0n);
        const principalAfter = (await pool.totalPrincipal()).toBigInt();
        assert.equal(
          principalAfter,
          principalBefore + prize,
          "prize became principal"
        );
        const balanceAfter = await balanceOf(provider, deployment.address);
        assert.ok(
          balanceAfter >= principalAfter,
          "the draw fee came out of the surplus, never principal"
        );
        const fee = balanceBeforeDraw - balanceAfter;
        assert.ok(
          fee <= config.keeperBuffer,
          `the reserve covers a draw (fee ${fee} tinybars)`
        );
        assert.ok(
          prize <= balanceBeforeDraw - principalBefore - config.keeperBuffer,
          "prize never exceeds the surplus above the reserve"
        );

        const result = await waitFor(
          () =>
            latestDrawResult(deployment.contractId, iface.getSighash("draw")),
          { label: "draw contract result" }
        );
        gasUsed["draw (scheduled, 2 savers)"] = result.gas_used;
        gasUsed["draw (scheduled, 2 savers): system calls"] =
          await systemCallGas(result.hash);
        console.log(
          `scheduled draw: from ${result.from}, gas ${result.gas_used}/${result.gas_limit}, pool paid ${fee} tinybars, ` +
            `prize ${prize} (surplus above reserve before the draw ${
              balanceBeforeDraw - principalBefore - config.keeperBuffer
            })`
        );
        assert.equal(
          result.from.toLowerCase(),
          deployment.address.toLowerCase(),
          "the draw ran as the contract's own scheduled call"
        );
      });

      it("returns principal to the tinybar on withdraw and wipes the tickets", async () => {
        for (const saver of [alice, bob]) {
          const [balance] = await pool.accountOf(saver.wallet.address);
          const half = balance.toBigInt() / 2n;
          for (const [label, amount] of [
            ["withdraw (partial)", half],
            ["withdraw (full)", balance.toBigInt() - half],
          ]) {
            const poolBefore = await balanceOf(provider, deployment.address);
            await send(label, () =>
              pool
                .connect(saver.wallet)
                .withdraw(amount, { gasLimit: 1_500_000 })
            );
            const poolAfter = await balanceOf(provider, deployment.address);
            // A local node pays no staking rewards, so the pool's balance moves by exactly the amount withdrawn.
            if (network.name === "local") {
              assert.equal(poolBefore - poolAfter, amount);
            } else {
              assert.ok(poolBefore - poolAfter <= amount);
            }
          }

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

      it("stops scheduling, and paying for, draws once the pool is empty", async () => {
        const emptyRound = drawRound + 1;
        assert.equal(
          (await pool.scheduledRound()).toNumber(),
          emptyRound,
          "the draw scheduled the next round"
        );
        await waitOnChain(
          client,
          alice.accountId,
          async () => (await pool.currentRound()).toNumber() > emptyRound,
          {
            label: "the already-scheduled draw of the emptied round",
            timeoutMs: (ROUND_SECONDS + 90) * 1000,
          }
        );
        const rolled = await findEvent(
          deployment.contractId,
          iface,
          "RoundRolledOver",
          (a) => a.round.toNumber() === emptyRound
        );
        assert.equal(rolled.args.participants.toNumber(), 0);
        const skipped = await findEvent(
          deployment.contractId,
          iface,
          "DrawNotScheduled",
          (a) => a.round.toNumber() === emptyRound + 1
        );
        assert.equal(skipped.args.reason, NO_PARTICIPANTS);
        assert.equal(
          await pool.nextDrawSchedule(),
          ethers.constants.AddressZero
        );

        // A whole round later nothing has run and the pool has paid nothing.
        const balance = await balanceOf(provider, deployment.address);
        const idleUntil = Date.now() + (ROUND_SECONDS + 15) * 1000;
        await waitOnChain(
          client,
          alice.accountId,
          async () => Date.now() > idleUntil,
          { label: "an idle round", timeoutMs: (ROUND_SECONDS + 60) * 1000 }
        );
        assert.equal((await pool.currentRound()).toNumber(), emptyRound + 1);
        assert.equal(await balanceOf(provider, deployment.address), balance);
      });
    });

    describe("manual trigger and the fee reserve", () => {
      const config = prizePoolConfig({
        ROUND_SECONDS: 20,
        DRAW_GRACE_SECONDS: 10,
        KEEPER_BUFFER_HBAR: 30,
        KEEPER_SEED_HBAR: 0,
      });
      let deployment;
      let pool;
      let iface;
      let carol;

      before(async () => {
        // No auto-association slots: Carol must associate with the ticket before her first deposit.
        carol = await createSaver(client, provider, 80, 0);
        deployment = await deployPrizePool({
          client,
          stakedNodeId: network.defaultNode,
          config,
          log: () => {},
        });
        iface = new ethers.utils.Interface(deployment.abi);
        pool = new ethers.Contract(
          deployment.address,
          deployment.abi,
          provider
        );
        console.log(
          `initialize sent ${config.ticketFeeHbar} HBAR for the ticket token; ` +
            `${await balanceOf(
              provider,
              deployment.address
            )} tinybars stayed in the pool`
        );
      });

      it("refuses a deposit the tickets cannot reach, until the saver associates (HIP-719)", async () => {
        const refused = await expectRevert(
          iface,
          "deposit before associating",
          () =>
            pool.connect(carol.wallet).deposit({
              value: DEPOSIT * WEIBARS_PER_TINYBAR,
              gasLimit: 1_500_000,
            })
        );
        assert.equal(refused.name, "HtsCallFailed");
        assert.equal(Number(refused.args[0]), TOKEN_NOT_ASSOCIATED_TO_ACCOUNT);

        const ticket = new ethers.Contract(
          await pool.ticket(),
          ["function associate() returns (uint256)"],
          carol.wallet
        );
        await send("ticket.associate() (HIP-719)", () =>
          ticket.associate({ gasLimit: 1_000_000 })
        );
        await send("deposit (first saver, reserve short)", () =>
          pool.connect(carol.wallet).deposit({
            value: DEPOSIT * WEIBARS_PER_TINYBAR,
            gasLimit: 1_500_000,
          })
        );
        assert.equal((await pool.participantsCount()).toNumber(), 1);
      });

      it("schedules nothing while the fee reserve is short", async () => {
        const round = (await pool.currentRound()).toNumber();
        assert.notEqual((await pool.scheduledRound()).toNumber(), round);
        assert.ok((await pool.reserveShortfall()).toBigInt() > 0n);
        const skipped = await findEvent(
          deployment.contractId,
          iface,
          "DrawNotScheduled",
          (a) =>
            a.round.toNumber() === round && a.reason === INSUFFICIENT_RESERVE
        );
        assert.ok(skipped);
      });

      it("triggerDraw opens after drawOpensAt, needs the reserve, and only schedules the draw", async () => {
        const round = (await pool.currentRound()).toNumber();
        const opensAt = (await pool.drawOpensAt()).toNumber();
        const chainNow = async () =>
          (await provider.getBlock("latest")).timestamp;
        if ((await chainNow()) < opensAt - 5) {
          const early = await expectRevert(iface, "early triggerDraw", () =>
            pool.connect(carol.wallet).triggerDraw({ gasLimit: 300_000 })
          );
          assert.equal(early.name, "DrawNotOpen");
        }

        await waitOnChain(
          client,
          carol.accountId,
          async () => (await chainNow()) > opensAt + 2,
          { label: "drawOpensAt", timeoutMs: 120_000 }
        );
        const short = await expectRevert(
          iface,
          "triggerDraw without top-up",
          () => pool.connect(carol.wallet).triggerDraw({ gasLimit: 300_000 })
        );
        assert.equal(short.name, "InsufficientReserve");

        const topUp =
          (await pool.reserveShortfall()).toBigInt() + 5n * TINYBARS;
        await send("triggerDraw (schedules the draw)", () =>
          pool.connect(carol.wallet).triggerDraw({
            value: topUp * WEIBARS_PER_TINYBAR,
            gasLimit: 8_000_000,
          })
        );
        assert.equal((await pool.scheduledRound()).toNumber(), round);
        assert.equal(
          (await pool.currentRound()).toNumber(),
          round,
          "triggerDraw itself picks nobody"
        );
        await findEvent(
          deployment.contractId,
          iface,
          "DrawScheduled",
          (a) => a.round.toNumber() === round
        );

        const again = await expectRevert(iface, "second triggerDraw", () =>
          pool.connect(carol.wallet).triggerDraw({ gasLimit: 300_000 })
        );
        assert.equal(again.name, "DrawNotOpen", "one live schedule per round");

        await waitOnChain(
          client,
          carol.accountId,
          async () => (await pool.currentRound()).toNumber() > round,
          { label: "the triggered draw", timeoutMs: 120_000 }
        );
        const draw = await findEvent(
          deployment.contractId,
          iface,
          "DrawExecuted",
          (a) => a.round.toNumber() === round
        );
        assert.equal(draw.args.winner, carol.wallet.address);
        assert.ok(draw.args.prize.toBigInt() > 0n);
        const result = await waitFor(
          () =>
            latestDrawResult(deployment.contractId, iface.getSighash("draw")),
          { label: "draw contract result" }
        );
        gasUsed["draw (scheduled, 1 saver)"] = result.gas_used;
        gasUsed["draw (scheduled, 1 saver): system calls"] =
          await systemCallGas(result.hash);
        assert.equal(
          result.from.toLowerCase(),
          deployment.address.toLowerCase(),
          "the winner was picked in the contract's own scheduled call"
        );
      });
    });
  }
);
