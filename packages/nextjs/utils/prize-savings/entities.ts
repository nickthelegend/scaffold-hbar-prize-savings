/**
 * Hedera entities (accounts, contracts, tokens, schedules) have a "long-zero" EVM address that encodes the entity
 * number: 0.0.1234 <-> 0x00000000000000000000000000000000000004d2.
 */
export const entityIdFromAddress = (address: string) => {
  const num = BigInt(address);
  if (num >> 64n !== 0n) throw new Error(`${address} is not a long-zero entity address`);
  return `0.0.${num.toString()}`;
};

export const isLongZeroAddress = (address: string) => /^0x0{24}[0-9a-fA-F]{16}$/.test(address);
