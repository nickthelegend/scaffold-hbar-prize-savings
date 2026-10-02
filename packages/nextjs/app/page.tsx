import type { NextPage } from "next";
import { DrawHistory } from "~~/components/prize-savings/DrawHistory";
import { PoolGate } from "~~/components/prize-savings/PoolGate";
import { PositionCard } from "~~/components/prize-savings/PositionCard";
import { PrizeHero } from "~~/components/prize-savings/PrizeHero";
import { SavePanel } from "~~/components/prize-savings/SavePanel";
import { StakingCard } from "~~/components/prize-savings/StakingCard";

const Home: NextPage = () => (
  <PoolGate>
    <div className="flex grow flex-col items-center">
      <PrizeHero />
      <div className="-mt-10 grid w-full max-w-5xl grid-cols-1 gap-6 px-5 pb-16 lg:grid-cols-2">
        <SavePanel />
        <PositionCard />
        <div className="lg:col-span-2">
          <DrawHistory />
        </div>
        <div className="lg:col-span-2">
          <StakingCard />
        </div>
      </div>
    </div>
  </PoolGate>
);

export default Home;
