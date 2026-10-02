import { describe, expect, it } from "vitest";
import { entityIdFromAddress, isLongZeroAddress } from "~~/utils/prize-savings/entities";

describe("entity ids", () => {
  it("decodes long-zero addresses", () => {
    expect(entityIdFromAddress("0x00000000000000000000000000000000000004d2")).toBe("0.0.1234");
    expect(entityIdFromAddress("0x0000000000000000000000000000000000a53193")).toBe("0.0.10826131");
  });

  it("rejects EVM-alias addresses", () => {
    expect(() => entityIdFromAddress("0x63eB1dd1F2E763F6DEA42B165B776A72FE75188D")).toThrow();
    expect(isLongZeroAddress("0x63eB1dd1F2E763F6DEA42B165B776A72FE75188D")).toBe(false);
    expect(isLongZeroAddress("0x00000000000000000000000000000000000004d2")).toBe(true);
  });
});
