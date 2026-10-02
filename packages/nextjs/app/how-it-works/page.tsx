import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "How it works",
  description: "How Prize Savings composes Hedera staking, the Schedule Service, PRNG and the Token Service.",
});

const SERVICES = [
  {
    name: "Native staking",
    where: "deployPrizePool.js → ContractCreateFlow.setStakedNodeId",
    what: "The pool contract is created with a staking election, so every HBAR it holds earns network staking rewards. They land in the contract's balance once per 24-hour period, with no claim transaction.",
    evm: "Lend the deposits to a protocol and inherit its risk (Bonzo Lend was drained and paused in July 2026).",
  },
  {
    name: "Schedule Service (HSS, 0x16b)",
    where: "PrizePool._scheduleDraw",
    what: "Each draw schedules the next one with scheduleCall. The network executes it at the round's end and the contract pays the fee from its surplus.",
    evm: "Run a keeper bot or pay an automation network.",
  },
  {
    name: "PRNG (0x169)",
    where: "PrizePool.draw",
    what: "The winner comes from getPseudorandomSeed(), derived from the running hash of a recent transaction record.",
    evm: "Subscribe to a VRF oracle and wait for an asynchronous callback.",
  },
  {
    name: "Token Service (HTS, 0x167)",
    where: "PrizePool._createTicket / _issueTickets / _burnTickets",
    what: "Deposits are mirrored 1:1 as PST tickets. The pool holds the supply, freeze and wipe keys and freezes every holding, so tickets show up in wallets but cannot be transferred.",
    evm: "Write a custom non-transferable ERC-20.",
  },
  {
    name: "Mirror node",
    where: "utils/prize-savings/mirror.ts",
    what: "Draw history, the staking election and token associations are read from the mirror node REST API.",
    evm: "Run a subgraph or your own indexer.",
  },
];

const STEPS = [
  "You deposit HBAR. The pool records your balance, mints the same amount of PST tickets into your account and freezes them.",
  "Your weight for the round grows every second: balance × seconds held. A deposit in the last minute barely counts, so nobody can snipe a draw.",
  "Staking rewards and boosts accumulate above the principal. Everything above principal + a small fee buffer is the prize.",
  "At the round's end the network runs the scheduled draw. The PRNG picks a point on the weight line; whoever's slice it lands in wins.",
  "The prize is added to the winner's deposit (more tickets, better odds next round) and the next draw is scheduled. Anyone can withdraw principal at any time.",
];

const HowItWorks: NextPage = () => (
  <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-5 py-12">
    <header className="flex flex-col gap-3">
      <h1 className="m-0 text-4xl font-bold">How Prize Savings works</h1>
      <p className="m-0 text-lg text-base-content/75">
        A no-loss savings game: nobody can lose their deposit, and the yield it earns is paid out as one prize per
        round. On Hedera every moving part is native to the network.
      </p>
    </header>

    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-2xl font-semibold">A round, step by step</h2>
      <ol className="m-0 flex flex-col gap-3 pl-0">
        {STEPS.map((step, i) => (
          <li key={step} className="flex gap-4 rounded-2xl border border-base-300 bg-base-100 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-content">
              {i + 1}
            </span>
            <span className="text-base-content/85">{step}</span>
          </li>
        ))}
      </ol>
    </section>

    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-2xl font-semibold">Hedera services used</h2>
      <div className="overflow-x-auto rounded-2xl border border-base-300 bg-base-100">
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>What it does here</th>
              <th>Without it (other EVM chains)</th>
            </tr>
          </thead>
          <tbody>
            {SERVICES.map(service => (
              <tr key={service.name}>
                <td className="align-top">
                  <p className="m-0 font-semibold">{service.name}</p>
                  <code className="text-xs text-base-content/60">{service.where}</code>
                </td>
                <td className="align-top text-sm">{service.what}</td>
                <td className="align-top text-sm text-base-content/70">{service.evm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>

    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-2xl font-semibold">Trust model and limits</h2>
      <ul className="m-0 flex flex-col gap-2 pl-5 text-base-content/85">
        <li>
          The contract has no owner and no admin key. Nobody can pause it, change its parameters or move deposits.
        </li>
        <li>
          Principal is plain HBAR held by the contract, so it is not exposed to any lending or DEX protocol. The
          invariant <code>balance ≥ totalPrincipal</code> is fuzz-tested.
        </li>
        <li>
          Testnet staking pays about 0.2% a year, so testnet prizes come mostly from boosts. On mainnet the reward rate
          is higher, but prizes still scale with deposits.
        </li>
        <li>
          PRNG output is unpredictable before consensus but is not a VRF. For high-value prizes, add a commit-reveal
          step or a VRF provider.
        </li>
        <li>
          A draw scans every saver, so the pool caps participants (default 100) to keep the scheduled call within its
          gas limit.
        </li>
      </ul>
    </section>
  </div>
);

export default HowItWorks;
