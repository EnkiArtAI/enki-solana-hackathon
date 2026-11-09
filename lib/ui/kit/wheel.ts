/**
 * The phone count's balance lock (plan D18). The drum it once served is gone (DEC-387).
 */
import { overBalance } from "./price";

/**
 * Whether `count` images at `price` USD each cost more than the balance: the
 * count is locked (greyed, its reason in its title). Each image is priced
 * in whole micro-USDC first (overBalance), so 3 × $0.10 fits $0.30.
 */
export const lockedFor = (price: number, count: number, balance: number) => overBalance(balance, count * Math.round(price * 1_000_000));
