// All data contracts for the Quant Dashboard.
// These mirror the shapes produced by scoring/index.js and src/parser/index.js.

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface Trade {
  entry_time: string | number;
  exit_time: string | number;
  entry_price: number;
  exit_price: number;
  qty?: number;
  profit?: number;
  profit_pct: number;
  side?: 'long' | 'short';
}

export interface EquityPoint {
  time: string | number;
  equity: number;
  drawdown?: number;
}

export interface Bar {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CostModel {
  fee_pct: number;
  slippage_pct: number;
  fill_model?: 'best' | 'avg' | 'worst';
}

export interface Weights {
  returns: number;
  robustness: number;
  cost: number;
  regimes: number;
}

export interface ReturnsComponents {
  sharpe: number;
  sortino: number;
  cagr: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  calmar: number;
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  tradeCount: number;
}

export interface RobustnessComponents {
  wfe: number;
  mcP5: number;
  mcP50: number;
  mcP95: number;
  mcRuinProbability: number;
  consistencyRatio: number;
}

export interface CostComponents {
  grossReturn: number;
  netReturn: number;
  netReturnRatio: number;
  feeImpact: number;
  slippageImpact: number;
  breakEvenFee: number;
  avgCostPerTrade: number;
  stressNetReturnRatio: number;
  modelUsed: CostModel;
  slippageCurve: Array<{ multiplier: number; netReturn: number }>;
}

export interface RegimeStats {
  tradeCount: number;
  winRate: number | null;
  avgReturn: number;
  sharpe: number;
  barCount: number;
  barPct: number;
}

export interface RegimesComponents {
  regimes: Record<'bull' | 'bear' | 'chop', RegimeStats>;
  barDistribution: Record<'bull' | 'bear' | 'chop', number>;
  totalBars: number;
  totalTrades: number;
}

export interface DimensionResult {
  score: number;
  components: ReturnsComponents | RobustnessComponents | CostComponents | RegimesComponents;
  evidence: Record<string, unknown>;
}

export interface BenchmarkResult {
  id?: string;
  algoHash: string;
  symbol: string;
  timeframe: string;
  dateRange: { start: string; end: string };
  costModel: CostModel;
  compositeScore: number;
  weights: Weights;
  scores: {
    returns: DimensionResult;
    robustness: DimensionResult;
    cost: DimensionResult;
    regimes: DimensionResult;
  };
  createdAt: string;
}

export interface BenchmarkSummary {
  id: string;
  algo_hash: string;
  symbol: string;
  timeframe: string;
  date_start: string;
  date_end: string;
  composite_score: number;
  score_returns: number;
  score_robustness: number;
  score_cost: number;
  score_regimes: number;
  created_at: string;
}

// ─── Parser / Blocks ──────────────────────────────────────────────────────────

export type BlockType = 'Entry' | 'Exit' | 'Filter' | 'Sizing' | 'Indicator' | 'RawPine';
export type Side = 'long' | 'short' | 'unknown';

export interface EntryBlock {
  type: 'Entry';
  id: string;
  side: Side;
  label: string;
  conditions: string[];
  conditionRaw: string | null;
  qtyExpr: string | null;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export interface ExitBlock {
  type: 'Exit';
  id: string;
  label: string;
  fromEntry: string | null;
  stopExpr: string | null;
  limitExpr: string | null;
  trailExpr: string | null;
  closeSignal: string | null;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export interface FilterBlock {
  type: 'Filter';
  id: string;
  label: string;
  variableName: string | null;
  expression: string;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export interface SizingBlock {
  type: 'Sizing';
  id: string;
  label: string;
  method: 'fixed' | 'pct_equity' | 'atr_based' | 'expression';
  expression: string;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export interface IndicatorBlock {
  type: 'Indicator';
  id: string;
  variableName: string;
  function: string;
  args: string[];
  expression: string;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export interface RawPineBlock {
  type: 'RawPine';
  id: string;
  note: string;
  sourceLines: [number, number] | number[];
  rawSource: string;
}

export type Block = EntryBlock | ExitBlock | FilterBlock | SizingBlock | IndicatorBlock | RawPineBlock;

export interface ParsedScript {
  version: number;
  scriptType: 'strategy' | 'indicator' | 'library';
  name: string;
  params: Record<string, string>;
  blocks: Block[];
  blockCount: number;
}

// ─── Improve ─────────────────────────────────────────────────────────────────

export interface PineDiff {
  description: string;
  old: string | null;
  new: string;
}

export interface Proposal {
  id: string;
  title: string;
  hypothesis: string;
  targetBlockId: string | null;
  targetBlockType: BlockType | null;
  weakestDimension: keyof Weights;
  predictedDelta: Partial<Weights & { composite: number }>;
  pineDiff: PineDiff | null;
}

export interface ImproveResponse {
  analysis: string;
  weakestDimension: keyof Weights;
  proposals: Proposal[];
}
