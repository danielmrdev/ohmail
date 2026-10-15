import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActionPricing, ActionPrices } from "@trafficflow/db";

/**
 * THE PROGRAM'S PRICE CARD, as its own contract states it — the priced side of `ActionPricing`
 * for a test that composes a metered host. Read from the byte copy of the contract's `/v1/access`
 * example (`packages/db/test/fixtures/entitlements-port/`), never typed here: this tree holds no
 * price, and a test that restated one would be a second card nobody reconciles.
 */
const ACCESS = fileURLToPath(new URL(
  "../../../db/test/fixtures/entitlements-port/access-200-active.json", import.meta.url));

export const PLANE_PRICES: ActionPrices = (JSON.parse(readFileSync(ACCESS, "utf8")) as {
  prices: ActionPrices;
}).prices;

if (!PLANE_PRICES || typeof PLANE_PRICES.screener !== "number") {
  throw new Error(`plane-pricing: no price card in ${ACCESS}`);
}

/** The card as the port a metered host is handed. `calls` records what was asked. */
export function planePricing(prices: ActionPrices = PLANE_PRICES): ActionPricing & {
  calls: Array<{ accountId: string; action: string }>;
} {
  const calls: Array<{ accountId: string; action: string }> = [];
  return {
    calls,
    async priceOf(accountId, action) {
      calls.push({ accountId, action });
      return prices[action];
    },
  };
}

/** One shared instance for the files that only need a metered host to be priced at all. */
export const PLANE_PRICING = planePricing();
