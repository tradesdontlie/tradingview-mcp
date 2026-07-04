/**
 * Laddering (price-ladder order construction) — pure functions over plain
 * numbers, no chart/exchange calls of their own. Encodes Chapter 1 (1.9.2,
 * "Laddering"), the only concept in that chapter with a complete, precise,
 * self-contained mechanical spec rather than a discretionary principle:
 *
 *   "Laddering refers to a strategy where you can place multiple buy or sell
 *   orders when wanting to enter a trade setup and get an average entry
 *   price... you can use price ladder trading to distribute 5 different buy
 *   orders, each valued at $2k, across a price range of $25k to $26k."
 *
 * That worked example is exact and reproducible: N equally-sized orders
 * ($10k / 5 = $2k each) at N equally-spaced price levels spanning the range
 * ($25000, $25250, ..., $26000) — mechanically: priceLow + i * (priceHigh -
 * priceLow) / (numOrders - 1) for i in [0, numOrders). "This approach allows
 * you to lower the average buying price" is the stated payoff — encoded here
 * as the resulting average fill price assuming full execution of every rung.
 *
 * Deliberately NOT encoded from this chapter: Evolving R ("when the evolving
 * R is less than 0.5, that's when you START TO CONSIDER an early exit" — a
 * discretionary trigger to "consider", not a rule to act on) and the ATR
 * safety-stop technique ("place your stop that much above/below the high/low"
 * leaves the multiplier to feel/context). Both are live judgment, not a
 * codeable mechanic — the same reasoning that kept Engulfing out of pinbar.js.
 */

function requirePositiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a finite number greater than 0, got: ${value}`);
  return n;
}

/**
 * Build a price ladder: numOrders equally-sized orders at numOrders equally
 * spaced price levels spanning [priceLow, priceHigh] inclusive — the exact
 * mechanic of the curriculum's worked example, generalized to any size/range/
 * count. Returns the order list plus the resulting average fill price (the
 * curriculum's stated reason to ladder at all: "lower the average buying
 * price").
 */
export function buildLadderOrders({ side, totalSize, priceLow, priceHigh, numOrders }) {
  const dir = String(side).toLowerCase();
  if (!['buy', 'sell'].includes(dir)) throw new Error('side must be "buy" or "sell"');

  const size = requirePositiveNumber(totalSize, 'totalSize');
  const low = requirePositiveNumber(priceLow, 'priceLow');
  const high = requirePositiveNumber(priceHigh, 'priceHigh');
  if (high <= low) throw new Error(`priceHigh (${high}) must be greater than priceLow (${low})`);

  const count = Number(numOrders);
  if (!Number.isInteger(count) || count < 2) throw new Error('numOrders must be an integer of at least 2 — laddering means "multiple" orders');

  const step = (high - low) / (count - 1);
  const sizePerOrder = size / count;
  const orders = [];
  for (let i = 0; i < count; i++) {
    orders.push({ price: low + i * step, size: sizePerOrder });
  }

  const averagePrice = orders.reduce((sum, o) => sum + o.price, 0) / orders.length;

  return { side: dir, orders, sizePerOrder, averagePrice };
}
