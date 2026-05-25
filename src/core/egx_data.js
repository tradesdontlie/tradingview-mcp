// EGX (Egyptian Exchange) reference data — compact subset.
// Full constituent lists for the 6 main EGX indices are large; we ship
// EGX30 inline (the most-queried) and rely on TV's server-side filter for the
// rest (queryable via screener with exchange=EGX + name filters).

export const EGX_INDICES = ['EGX30', 'EGX70', 'EGX100', 'SHARIAH33', 'EGX35LV', 'TAMAYUZ'];

export const EGX30_CONSTITUENTS = [
  'ISPH', 'ABUK', 'EMFD', 'AMOC', 'COMI', 'EAST', 'EGCH', 'RMDA',
  'ARCC', 'CCAP', 'ETEL', 'ORWE', 'ORAS', 'OIH', 'ORHD', 'EFIH',
  'EFID', 'PHDC', 'BTFH', 'JUFO', 'GBCO', 'RAYA', 'VLMR', 'VLMRA',
  'FWRY', 'HRHO', 'TMGH', 'HELI', 'MCQE', 'EGAL', 'ADIB',
];

export const EGX_SECTORS = [
  'banks',
  'basic_resources',
  'healthcare_and_pharma',
  'industrial_goods_and_services',
  'real_estate',
  'travel_and_leisure',
  'food_and_beverages',
  'telecommunications',
  'construction_materials',
  'financial_services',
  'utilities',
  'energy',
  'technology',
  'media',
  'retail',
];

// Sector → sample symbols (top constituents only; expand via TV screener with
// extra filters when deeper coverage is needed).
export const EGX_SECTOR_SAMPLES = {
  banks: ['COMI', 'ADIB', 'HRHO', 'CIEB'],
  basic_resources: ['EGAL', 'AMOC', 'EFIH'],
  healthcare_and_pharma: ['ISPH', 'RMDA', 'PHAR'],
  industrial_goods_and_services: ['EAST', 'EGCH', 'ORAS'],
  real_estate: ['EMFD', 'PHDC', 'TMGH', 'HELI', 'ORHD'],
  travel_and_leisure: ['EGTS'],
  food_and_beverages: ['JUFO', 'EFID'],
  telecommunications: ['ETEL', 'OIH'],
  construction_materials: ['ARCC', 'MCQE'],
  financial_services: ['FWRY', 'CCAP', 'BTFH', 'GBCO', 'RAYA'],
  utilities: ['ORWE'],
};

/** Resolve symbols for a given EGX index name. EGX30 ships inline; others
 *  return null so the caller falls back to TV server-side screener filter. */
export function constituentsForIndex(name) {
  const upper = (name || '').toUpperCase().replace(/[\s_-]/g, '');
  if (upper === 'EGX30') return EGX30_CONSTITUENTS;
  return null;
}
