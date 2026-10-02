import { describe, expect, it } from "vitest";
import {
  formatShare,
  formatTinybars,
  hbarToTinybars,
  hbarToWeibars,
  isValidHbarAmount,
} from "~~/utils/prize-savings/units";

describe("HBAR units", () => {
  it("converts the same HBAR amount to tinybars for contract args and weibars for tx value", () => {
    expect(hbarToTinybars("1.5")).toBe(150_000_000n);
    expect(hbarToWeibars("1.5")).toBe(1_500_000_000_000_000_000n);
  });

  it("formats tinybars with grouping and trimmed decimals", () => {
    expect(formatTinybars(123_456_789_000n)).toBe("1,234.5678");
    expect(formatTinybars(100_000_000n)).toBe("1");
    expect(formatTinybars(1n, 8)).toBe("0.00000001");
    expect(formatTinybars(0n)).toBe("0");
  });

  it("validates user input", () => {
    expect(isValidHbarAmount("10")).toBe(true);
    expect(isValidHbarAmount("0.00000001")).toBe(true);
    expect(isValidHbarAmount("0.000000001")).toBe(false);
    expect(isValidHbarAmount("0")).toBe(false);
    expect(isValidHbarAmount("-1")).toBe(false);
    expect(isValidHbarAmount("1e3")).toBe(false);
    expect(isValidHbarAmount("")).toBe(false);
  });

  it("formats shares", () => {
    expect(formatShare(1n, 3n)).toBe("33.3%");
    expect(formatShare(1n, 1_000n)).toBe("0.10%");
    expect(formatShare(5n, 0n)).toBe("0%");
  });
});
