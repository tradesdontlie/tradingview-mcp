/**
 * Support/resistance zone detection by clustering zigzag pivots.
 * A zone needs >=2 touches within `tolerancePct` of each other to count —
 * a single untested swing point is not a level, it's noise.
 */
export function findSrZones(pivots, tolerancePct = 0.015) {
  const zones = [];

  for (const p of pivots) {
    let zone = zones.find(z => Math.abs(z.price - p.price) / z.price <= tolerancePct);
    if (zone) {
      zone.touches += 1;
      zone.price = (zone.price * (zone.touches - 1) + p.price) / zone.touches; // running average
      zone.lastIndex = Math.max(zone.lastIndex, p.index);
      if (p.type === 'high') zone.highTouches++; else zone.lowTouches++;
    } else {
      zones.push({
        price: p.price,
        touches: 1,
        highTouches: p.type === 'high' ? 1 : 0,
        lowTouches: p.type === 'low' ? 1 : 0,
        firstIndex: p.index,
        lastIndex: p.index,
      });
    }
  }

  return zones
    .filter(z => z.touches >= 2)
    .map(z => ({ ...z, type: z.highTouches >= z.lowTouches ? 'resistance' : 'support' }))
    .sort((a, b) => b.touches - a.touches);
}

/** Nearest resistance zone strictly above `price`, or null. */
export function nearestResistanceAbove(zones, price) {
  const above = zones.filter(z => z.price > price).sort((a, b) => a.price - b.price);
  return above[0] || null;
}

/** Nearest support zone strictly below `price`, or null. */
export function nearestSupportBelow(zones, price) {
  const below = zones.filter(z => z.price < price).sort((a, b) => b.price - a.price);
  return below[0] || null;
}
