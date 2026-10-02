import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAccount, fetchContractEvents, networkForChain } from "~~/utils/prize-savings/mirror";

const abi = parseAbi([
  "event DrawExecuted(uint256 indexed round, address indexed winner, uint256 prize, bytes32 seed, uint256 participants)",
]);
const winner = "0x63eB1dd1F2E763F6DEA42B165B776A72FE75188D";

const drawLog = {
  address: "0x0000000000000000000000000000000000a53193",
  topics: encodeEventTopics({ abi, eventName: "DrawExecuted", args: { round: 7n, winner } }),
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
    [42_000_000n, `0x${"ab".repeat(32)}`, 3n],
  ),
  timestamp: "1790970000.123456789",
  transaction_hash: "0xfeed",
  block_number: 1,
};
const foreignLog = { ...drawLog, topics: [`0x${"11".repeat(32)}`], data: "0x" };

afterEach(() => vi.unstubAllGlobals());

describe("mirror node client", () => {
  it("decodes known events and skips logs the ABI does not describe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ logs: [drawLog, foreignLog] }))),
    );
    const events = await fetchContractEvents("testnet", drawLog.address, abi);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("DrawExecuted");
    expect(events[0].args).toMatchObject({ round: 7n, winner, prize: 42_000_000n, participants: 3n });
    expect(events[0].timestamp).toBeCloseTo(1790970000.123);
  });

  it("returns null for addresses without a Hedera account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    await expect(fetchAccount("testnet", winner)).resolves.toBeNull();
  });

  it("surfaces mirror node outages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    await expect(fetchContractEvents("testnet", drawLog.address, abi)).rejects.toThrow(/503/);
  });

  it("maps chain ids to networks", () => {
    expect(networkForChain(295)).toBe("mainnet");
    expect(networkForChain(296)).toBe("testnet");
    expect(networkForChain(298)).toBe("local");
  });
});

describe("explorer links", () => {
  it("uses HashScan on public networks and the mirror node locally", async () => {
    const { explorerLink } = await import("~~/utils/prize-savings/mirror");
    expect(explorerLink("testnet", "schedule", "0.0.42")).toBe("https://hashscan.io/testnet/schedule/0.0.42");
    expect(explorerLink("local", "transaction", "0xabc")).toBe("http://localhost:5551/api/v1/contracts/results/0xabc");
  });
});
