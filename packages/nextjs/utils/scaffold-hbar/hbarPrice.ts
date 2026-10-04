export const HBAR_PRICE_CACHE_DURATION_MS = 60 * 1000;
/**
 * The network's own HBAR/USD exchange rate (the one Hedera prices fees in), from the mainnet mirror node. Unlike public
 * price APIs it is CORS-enabled and not rate-limited per browser.
 */
export const HBAR_PRICE_URL = "https://mainnet-public.mirrornode.hedera.com/api/v1/network/exchangerate";

type ExchangeRate = { cent_equivalent: number; hbar_equivalent: number };

type HbarPriceCache = {
  price: number;
  timestamp: number;
};

let cache: HbarPriceCache | null = null;

/** USD per HBAR, or the last known price (0 before the first success) if the mirror node can't be reached. */
export async function fetchHbarPrice(): Promise<number> {
  const now = Date.now();
  if (cache && now - cache.timestamp < HBAR_PRICE_CACHE_DURATION_MS) {
    return cache.price;
  }

  try {
    const response = await fetch(HBAR_PRICE_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rate: ExchangeRate | undefined = (await response.json())?.current_rate;
    if (!rate?.hbar_equivalent) throw new Error("no current_rate in the response");
    const price = rate.cent_equivalent / rate.hbar_equivalent / 100;
    cache = { price, timestamp: now };
    return price;
  } catch (error) {
    console.warn("HBAR price unavailable, keeping the last known value:", error);
    return cache?.price ?? 0;
  }
}
