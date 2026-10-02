import { NextResponse } from "next/server";
import deployedContracts from "~~/contracts/deployedContracts";

/** Liveness probe for hosting and the harness smoke test. Reports which network the pool is deployed on. */
export function GET() {
  const deployments = Object.entries(deployedContracts).map(([chainId, contracts]) => ({
    chainId: Number(chainId),
    prizePool: contracts.PrizePool.address,
  }));
  return NextResponse.json({ ok: true, deployments });
}
