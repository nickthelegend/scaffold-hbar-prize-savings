import { friendlyTxError } from "./errors";
import { describe, expect, it } from "vitest";

describe("friendlyTxError", () => {
  it("explains a withdrawal above the deposit, in HBAR", () => {
    expect(friendlyTxError('"withdraw" reverted with the following reason:\nInsufficientBalance(600000000)')).toBe(
      "You can withdraw at most 6 HBAR, your current deposit.",
    );
  });

  it("names the HTS response code behind HtsCallFailed", () => {
    expect(friendlyTxError("reverted with the following reason: HtsCallFailed(184)")).toMatch(/isn't associated/);
    expect(friendlyTxError("reverted with the following reason: HtsCallFailed(999)")).toMatch(/response code 999/);
  });

  it("recognises a rejected signature", () => {
    expect(friendlyTxError("User rejected the request.")).toBe("You cancelled the transaction in your wallet.");
  });

  it("leaves errors it doesn't know unchanged", () => {
    expect(friendlyTxError("Nonce too low")).toBe("Nonce too low");
    expect(friendlyTxError("reverted with the following reason: SomethingElse(1)")).toMatch(/SomethingElse/);
  });
});
