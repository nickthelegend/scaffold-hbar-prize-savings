import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  type MirrorLog,
  decodeLogs,
  explorerLink,
  fetchAccount,
  fetchContractEvents,
  needsAssociation,
  networkForChain,
  nextPageUrl,
} from "~~/utils/prize-savings/mirror";

const abi = parseAbi([
  "event DrawExecuted(uint256 indexed round, address indexed winner, uint256 prize, bytes32 seed, uint256 participants)",
]);
const winner = "0x63eB1dd1F2E763F6DEA42B165B776A72FE75188D";

const drawLog: MirrorLog = {
  address: "0x0000000000000000000000000000000000a53193",
  topics: encodeEventTopics({ abi, eventName: "DrawExecuted", args: { round: 7n, winner } }) as string[],
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
    [42_000_000n, `0x${"ab".repeat(32)}`, 3n],
  ),
  timestamp: "1790970000.123456789",
  transaction_hash: "0xfeed",
  block_number: 1,
};
const foreignLog: MirrorLog = { ...drawLog, topics: [`0x${"11".repeat(32)}`], data: "0x" };

describe("log decoding", () => {
  it("decodes known events and skips logs the ABI does not describe", () => {
    const events = decodeLogs([drawLog, foreignLog], abi);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("DrawExecuted");
    expect(events[0].args).toMatchObject({ round: 7n, winner, prize: 42_000_000n, participants: 3n });
    expect(events[0].timestamp).toBeCloseTo(1790970000.123);
  });

  it("resolves the mirror node's next-page path against the API base", () => {
    expect(
      nextPageUrl("https://testnet.mirrornode.hedera.com/api/v1", {
        next: "/api/v1/contracts/0.0.1/results/logs?limit=2&timestamp=lt:1.2",
      }),
    ).toBe("https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.1/results/logs?limit=2&timestamp=lt:1.2");
    expect(nextPageUrl("http://localhost:5551/api/v1", { next: null })).toBeUndefined();
  });
});

describe("token association", () => {
  it("trusts only unlimited auto-association, since the mirror node does not report used slots", () => {
    expect(needsAssociation({ max_automatic_token_associations: -1 }, false)).toBe(false);
    expect(needsAssociation({ max_automatic_token_associations: 10 }, false)).toBe(true);
    expect(needsAssociation({ max_automatic_token_associations: 0 }, false)).toBe(true);
    expect(needsAssociation({ max_automatic_token_associations: 0 }, true)).toBe(false);
  });
});

describe("networks and links", () => {
  it("maps chain ids to networks", () => {
    expect(networkForChain(295)).toBe("mainnet");
    expect(networkForChain(296)).toBe("testnet");
    expect(networkForChain(298)).toBe("local");
  });

  it("uses HashScan on public networks and the mirror node locally", () => {
    expect(explorerLink("testnet", "schedule", "0.0.42")).toBe("https://hashscan.io/testnet/schedule/0.0.42");
    expect(explorerLink("local", "transaction", "0xabc")).toBe("http://localhost:5551/api/v1/contracts/results/0xabc");
  });
});

/** Live checks against the public testnet mirror node: real responses, nothing stubbed. Need network access. */
describe("mirror node client (live testnet)", { timeout: 30_000 }, () => {
  // USDC on Hedera testnet: an HTS token whose ERC-20 Transfer logs the mirror node indexes under its contract id.
  const TESTNET_USDC = "0.0.5449";
  const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

  it("follows links.next across pages until it has enough events", async () => {
    const events = await fetchContractEvents("testnet", TESTNET_USDC, transferAbi, {
      eventNames: ["Transfer"],
      maxEvents: 5,
      pageSize: 2,
    });
    expect(events).toHaveLength(5);
    expect(events.every(e => e.eventName === "Transfer")).toBe(true);
    const timestamps = events.map(e => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("returns null for an address with no Hedera account", async () => {
    const random = `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, "0")).join("")}`;
    await expect(fetchAccount("testnet", random)).resolves.toBeNull();
  });
});
