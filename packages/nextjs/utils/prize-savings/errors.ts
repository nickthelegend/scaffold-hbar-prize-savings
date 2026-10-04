import { formatTinybars } from "./units";

/** HTS response codes PrizePool can surface through `HtsCallFailed`, from the Hiero SDK's `Status` enum. */
const HTS_STATUS: Record<number, string> = {
  165: "the ticket holding is frozen",
  178: "the account doesn't hold enough tickets",
  184: "your account isn't associated with the ticket token yet. Associate it (one click in the deposit panel) and try again",
  194: "your account is already associated with the ticket token",
  262: "your account has no automatic token association slots left. Associate the ticket token (one click in the deposit panel) and try again",
};

const amount = (raw: string) => {
  try {
    return `${formatTinybars(BigInt(raw))} HBAR`;
  } catch {
    return raw;
  }
};

/** PrizePool and PrizeLedger custom errors, in words a saver can act on. `arg` is the error's first argument. */
const POOL_ERRORS: Record<string, (arg: string) => string> = {
  InsufficientBalance: arg => `You can withdraw at most ${amount(arg)}, your current deposit.`,
  BelowMinDeposit: arg => `The minimum deposit is ${amount(arg)}.`,
  TooManyParticipants: arg => `The pool is full (${arg} savers). Try again after someone withdraws.`,
  ZeroAmount: () => "Enter an amount above zero.",
  AmountTooLarge: () => "That amount is too large for the Hedera Token Service.",
  DrawNotOpen: arg =>
    `This round's draw can't be scheduled by hand until ${new Date(Number(arg) * 1000).toLocaleTimeString()}.`,
  NoParticipants: () => "Nobody is saving this round, so there is no draw to schedule.",
  InsufficientReserve: arg => `The pool needs ${amount(arg)} more in its fee reserve. Boost the prize to cover it.`,
  SchedulingFailed: () => "The network couldn't schedule the draw right now. Try again in a few seconds.",
  OnlyScheduled: () => "Only the contract's own scheduled transaction can run the draw.",
  HbarTransferFailed: () => "The HBAR transfer to your account failed.",
  HtsCallFailed: arg =>
    `The Hedera Token Service refused the ticket update: ${HTS_STATUS[Number(arg)] ?? `response code ${arg}`}.`,
};

/**
 * Turns a parsed transaction error (e.g. `"withdraw" reverted with the following reason: InsufficientBalance(6)`)
 * into a sentence, or returns it unchanged when it isn't one of ours.
 */
export const friendlyTxError = (message: string): string => {
  if (/user (rejected|denied)|rejected the request/i.test(message)) return "You cancelled the transaction in your wallet.";
  const match = /\b([A-Z][A-Za-z]+)\((-?\d*)/.exec(message);
  const describe = match && POOL_ERRORS[match[1]];
  return describe ? describe(match[2]) : message;
};
