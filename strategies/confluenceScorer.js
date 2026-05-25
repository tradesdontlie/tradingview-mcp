/**
 * Scores a setup by mapping engine outputs to the A+/A/B/C/Reject grading system
 * defined in rules.json confidence_grades.
 *
 * @module confluenceScorer
 */

/**
 * @typedef {{ grade: "A+"|"A"|"B"|"C"|"Reject",
 *             score: number,
 *             factors: string[],
 *             missing: string[] }} ScoreResult
 */

/**
 * Scores the current setup and returns a confidence grade.
 *
 * Blocking conditions → immediate Reject (checked before scoring):
 *   - HTF bias permission is "none" (4H/1H conflict)
 *   - No sweep detected
 *   - Sweep detected but reclaim failed
 *   - Reclaim confirmed but no 5m MSS
 *
 * Grade thresholds (after Reject check passes):
 *   A+  — 4H+1H+15m all aligned, reclaim ≤ 3 candles, volume expansion, displacement present
 *   A   — 4H+1H aligned, sweep+reclaim+MSS confirmed, one minor factor absent
 *   B   — 4H+1H aligned, sweep+reclaim confirmed (MSS present but other factors thin)
 *   C   — only 1 HTF aligned or partial setup
 *
 * @param {{ biasResult: object,
 *            sweepResult: object,
 *            reclaimResult: object,
 *            mssResult: object,
 *            displacementCandle: object|null,
 *            volumeResult: object,
 *            allThreeHtfAligned: boolean }} inputs
 * @returns {ScoreResult}
 */
export function scoreSetup(inputs) {
  const { biasResult, sweepResult, reclaimResult, mssResult,
          displacementCandle, volumeResult, allThreeHtfAligned } = inputs;

  // ── Blocking reject conditions ───────────────────────────────────────────
  if (!biasResult || biasResult.permission === 'none') {
    return { grade: 'Reject', score: 0, factors: [], missing: ['htf_bias_conflict'] };
  }
  if (!sweepResult?.swept) {
    return { grade: 'Reject', score: 0, factors: [], missing: ['sweep_not_detected'] };
  }
  if (!reclaimResult?.reclaimed) {
    return { grade: 'Reject', score: 0, factors: ['sweep_confirmed'], missing: ['reclaim_failed'] };
  }
  if (!mssResult?.detected) {
    return { grade: 'Reject', score: 0,
             factors: ['sweep_confirmed', 'reclaim_confirmed'], missing: ['mss_not_detected'] };
  }

  // ── Factor scoring ────────────────────────────────────────────────────────
  const factors = ['sweep_confirmed', 'reclaim_confirmed', 'mss_confirmed'];
  const missing  = [];
  let score = 9; // base: sweep(3) + reclaim(3) + mss(3)

  const dir = biasResult.permission === 'long' ? 'bullish' : 'bearish';
  const h4  = biasResult['4H'] ?? 'neutral';
  const h1  = biasResult['1H'] ?? 'neutral';

  const htf2Aligned = (h4 === dir || h4 === 'neutral') && (h1 === dir || h1 === 'neutral');

  if (allThreeHtfAligned) {
    score += 3; factors.push('htf_3_aligned');
  } else if (htf2Aligned) {
    score += 2; factors.push('htf_2_aligned');
  } else {
    score += 1; factors.push('htf_partial_aligned');
  }

  const quickReclaim = reclaimResult.candlesToReclaim != null && reclaimResult.candlesToReclaim <= 3;
  if (quickReclaim) { score += 1; factors.push('quick_reclaim'); }

  const volPresent  = volumeResult?.surge === true;
  const dispPresent = displacementCandle !== null && displacementCandle !== undefined;

  if (volPresent)  { score += 2; factors.push('volume_expansion'); }
  else               missing.push('volume_expansion');

  if (dispPresent) { score += 2; factors.push('displacement_present'); }
  else               missing.push('displacement_candle');

  // ── Grade assignment ──────────────────────────────────────────────────────
  let grade;
  if (allThreeHtfAligned && volPresent && dispPresent && quickReclaim) {
    grade = 'A+';
  } else if (htf2Aligned && (volPresent || dispPresent)) {
    grade = 'A';
  } else if (htf2Aligned) {
    grade = 'B';
  } else {
    grade = 'C';
  }

  return { grade, score, factors, missing };
}
