/**
 * Improve route — deliverable (D).
 *
 * POST /api/improve
 *   Body: { benchmarkId: string, pineSource?: string, weights?: Weights }
 *   Returns: { proposals: Proposal[] }
 *
 * Proposal shape:
 * {
 *   id: string,
 *   title: string,
 *   hypothesis: string,
 *   targetBlock: string | null,
 *   weakestDimension: string,
 *   predictedDelta: { returns?, robustness?, cost?, regimes?, composite },
 *   pineDiff: { old: string, new: string } | null,
 * }
 *
 * The route calls Claude claude-sonnet-4-6 directly via the Anthropic SDK.
 * Requires ANTHROPIC_API_KEY env var.
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { loadResult } from '../../../scoring/store.js';

export const router = Router();

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

router.post('/', async (req, res) => {
  try {
    const { benchmarkId, pineSource, weights } = req.body;
    if (!benchmarkId) return res.status(400).json({ success: false, error: 'benchmarkId required' });

    const result = loadResult(benchmarkId);
    if (!result) return res.status(404).json({ success: false, error: 'Benchmark not found' });

    const prompt = buildPrompt(result, pineSource, weights);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content.find(b => b.type === 'text')?.text ?? '';
    const proposals = parseProposals(text);

    res.json({ success: true, proposals, rawResponse: text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Prompt construction ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a quantitative trading strategy analyst. You will be given:
1. A parsed representation of a Pine Script trading strategy (entry/exit/filter/sizing blocks)
2. A multi-dimensional benchmark result with scores and supporting evidence for each dimension
3. A request to identify the weakest area and propose concrete improvements

Your task:
- Identify the single weakest scoring dimension and explain WHY it scored low using the evidence
- Propose 1–3 specific, actionable Pine Script modifications
- Each proposal must include: a hypothesis, the specific block being modified, predicted score deltas, and a concrete before/after Pine diff
- Be precise about Pine v5 syntax — diffs must be valid Pine code
- Predicted deltas should be conservative estimates (not optimistic)

Respond ONLY with valid JSON matching this schema:
{
  "analysis": "string — 2-3 sentences identifying the weakest dimension and root cause",
  "weakestDimension": "returns" | "robustness" | "cost" | "regimes",
  "proposals": [
    {
      "id": "prop_0",
      "title": "short imperative title",
      "hypothesis": "mechanism explanation — why this change will improve the weak dimension",
      "targetBlockId": "block id from the parsed script, or null if it's a new block",
      "targetBlockType": "Entry" | "Exit" | "Filter" | "Sizing" | "Indicator" | null,
      "predictedDelta": {
        "returns": 0,
        "robustness": 0,
        "cost": 0,
        "regimes": 0,
        "composite": 0
      },
      "pineDiff": {
        "description": "one line describing the change",
        "old": "the existing Pine code being replaced (exact snippet, or null if adding new code)",
        "new": "the replacement Pine v5 code"
      }
    }
  ]
}`;

function buildPrompt(result, pineSource, weightOverrides) {
  const { scores, compositeScore, symbol, timeframe, dateRange } = result;
  const weights = weightOverrides ?? result.weights;

  const dimensionSummary = Object.entries(scores).map(([dim, s]) => {
    const key_metrics = summarizeDimension(dim, s);
    return `### ${dim.toUpperCase()} — score: ${s.score}/100 (weight: ${Math.round((weights[dim] ?? 0.25) * 100)}%)
${key_metrics}`;
  }).join('\n\n');

  const parsedNote = pineSource
    ? `\nPine source was provided but not parsed inline — see block list below.`
    : '\nNo Pine source provided — work from block descriptions only.';

  return `## Strategy Benchmark Result
Symbol: ${symbol} | Timeframe: ${timeframe} | Period: ${dateRange.start} → ${dateRange.end}
Composite Score: **${compositeScore}/100**
${parsedNote}

## Dimension Scores and Evidence

${dimensionSummary}

## Task
Identify the weakest dimension, diagnose the root cause using the evidence above, and propose 1–3 concrete Pine modifications. Respond with the JSON schema described in the system prompt.`;
}

function summarizeDimension(dim, s) {
  const c = s.components ?? {};
  switch (dim) {
    case 'returns':
      return [
        `  Sharpe: ${fmt(c.sharpe)} | Sortino: ${fmt(c.sortino)} | CAGR: ${pct(c.cagr)}`,
        `  MaxDD: ${pct(c.maxDrawdown)} | Calmar: ${fmt(c.calmar)} | Win Rate: ${pct(c.winRate)}`,
        `  Profit Factor: ${fmt(c.profitFactor)} | Trade Count: ${c.tradeCount}`,
      ].join('\n');
    case 'robustness':
      return [
        `  Walk-forward efficiency: ${fmt(c.wfe)}`,
        `  Monte Carlo P5/P50/P95: ${fmt(c.mcP5)} / ${fmt(c.mcP50)} / ${fmt(c.mcP95)}`,
        `  Ruin probability: ${pct(c.mcRuinProbability)} | Monthly consistency: ${pct(c.consistencyRatio)}`,
      ].join('\n');
    case 'cost':
      return [
        `  Net/gross return ratio: ${fmt(c.netReturnRatio)}`,
        `  Fee impact: ${pct(c.feeImpact)} | Slippage impact: ${pct(c.slippageImpact)}`,
        `  Break-even fee: ${pct(c.breakEvenFee)} | Avg cost/trade: ${pct(c.avgCostPerTrade)}`,
      ].join('\n');
    case 'regimes':
      if (!c.regimes) return '  No regime data';
      return Object.entries(c.regimes).map(([r, rs]) =>
        `  ${r.padEnd(5)}: ${rs.tradeCount} trades, winRate=${pct(rs.winRate)}, avgReturn=${pct(rs.avgReturn)} (${pct(rs.barPct)} of bars)`
      ).join('\n');
    default:
      return JSON.stringify(c, null, 2).slice(0, 400);
  }
}

function parseProposals(text) {
  // Extract JSON from the response
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return parsed.proposals ?? [];
  } catch {
    return [];
  }
}

function fmt(v) {
  if (v == null) return 'n/a';
  return typeof v === 'number' ? v.toFixed(2) : String(v);
}

function pct(v) {
  if (v == null) return 'n/a';
  return typeof v === 'number' ? (v * 100).toFixed(1) + '%' : String(v);
}
