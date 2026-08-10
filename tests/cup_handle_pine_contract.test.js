import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINE_PATH = join(ROOT, 'cup-and-handle', 'cup-and-handle.pine');
const CONTRACT_PATH = join(
  ROOT,
  'cup-and-handle',
  'analysis',
  'frozen-v0-cup-handle.json',
);
const pine = readFileSync(PINE_PATH, 'utf8');
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

const ALERT_TITLES = [
  'Cup-and-Handle Forming Watch',
  'Cup-and-Handle Confirmed Cup / Handle Forming',
  'Cup-and-Handle Handle Ready',
  'Cup-and-Handle Breakout Confirmed',
  'Cup-and-Handle Invalidated or Expired',
  'Any Cup-and-Handle Lifecycle Event',
];

describe('Cup-and-Handle Pine clean-room contract', () => {
  it('is an original Pine v6 indicator carrying the frozen detector identity', () => {
    assert.match(pine, /^\/\/@version=6/m);
    assert.match(pine, /indicator\(\s*\n\s*"Cup-and-Handle Pattern Watch \[Clean-room V0\]"/);
    assert.match(pine, /string VERSION = "0\.1\.2-cleanroom"/);
    assert.match(pine, /string CONFIG_BASE_ID = "ch-v0-default"/);
    assert.match(pine, /string runtimeConfigId = CONFIG_BASE_ID \+ "\|settings:/);
    assert.equal(contract.detector_version, '0.1.2-cleanroom');
    assert.equal(contract.status, 'draft_calibration');
    assert.match(pine, /no protected or\s*\n\/\/ proprietary source code was copied or extracted/i);
  });

  it('freezes the publicly documented 600-bar, 5\/5-pivot, 20-bar baseline', () => {
    assert.match(pine, /input\.int\(600, "Search bars"/);
    assert.match(pine, /input\.int\(5, "Pivot bars left"/);
    assert.match(pine, /input\.int\(5, "Pivot bars right"/);
    assert.match(pine, /input\.int\(20, "Minimum cup bars"/);
    assert.equal(contract.documented_tradingview_rules.lookback_bars, 600);
    assert.equal(contract.documented_tradingview_rules.pivot_left_bars, 5);
    assert.equal(contract.documented_tradingview_rules.pivot_right_bars, 5);
    assert.equal(contract.documented_tradingview_rules.minimum_cup_bars, 20);
  });

  it('supports only native 4H, 1D, and 1W in the first slice', () => {
    assert.match(pine, /timeframe\.period == "240"/);
    assert.match(pine, /timeframe\.period == "1D"/);
    assert.match(pine, /timeframe\.period == "1W"/);
    assert.match(pine, /supports native 4H, 1D, and 1W charts/);
    assert.deepEqual(contract.supported_timeframes, ['4H', '1D', '1W']);
  });

  it('gates transitions to confirmed bars and never requests future data', () => {
    assert.match(pine, /supportedTimeframe and barstate\.isconfirmed/);
    assert.match(pine, /alert\.freq_once_per_bar_close/);
    assert.doesNotMatch(pine, /\brequest\./);
    assert.doesNotMatch(pine, /barmerge\.lookahead_on/);
    assert.doesNotMatch(pine, /plot\([^\n]*\boffset\s*=/);
    assert.doesNotMatch(pine, /\bta\.pivothigh\s*\(/);
    assert.doesNotMatch(pine, /\bta\.pivotlow\s*\(/);
    assert.equal(contract.causality.closed_bars_only, true);
    assert.equal(contract.causality.pivot_detection_is_not_backdated, true);
  });

  it('is non-trading and does not contain a multi-symbol scanner', () => {
    assert.doesNotMatch(pine, /\bstrategy\s*\(/);
    assert.doesNotMatch(pine, /\bstrategy\./);
    assert.doesNotMatch(pine, /input\.symbol\s*\(/);
    assert.doesNotMatch(pine, /request\.security\s*\(/);
    assert.ok(contract.non_goals.includes('Automated trading or order placement'));
    assert.ok(contract.non_goals.includes('Watchlist scanner implementation in the first slice'));
  });

  it('exposes the complete lifecycle through stable machine plots', () => {
    for (const stage of contract.lifecycle) assert.match(pine, new RegExp(stage));
    for (const title of [
      'CH Stage Code',
      'CH Transition Stage',
      'CH Quality Score',
      'CH Pivot',
      'CH Invalidation',
      'CH Rim',
      'CH Cup Height',
      'CH Provisional',
      'CH Left Rim Time',
      'CH Bottom Time',
      'CH Right Rim Time',
      'CH Handle Time',
      'CH Already Broken When Discovered',
    ]) {
      assert.match(pine, new RegExp(`plot\\([^\\n]+"${title}"`), title);
    }
  });

  it('defines one alert condition per useful transition plus one combined condition', () => {
    const observedTitles = [...pine.matchAll(/alertcondition\([^\n]+?"([^"]+)"/g)]
      .map((match) => match[1]);
    assert.deepEqual(observedTitles, ALERT_TITLES);
    assert.match(pine, /family_id=" \+ activeFamilyId/);
    assert.match(pine, /pattern_id=" \+ activePatternId/);
    assert.match(pine, /bar_open_time=" \+ str\.tostring\(time\)/);
    assert.match(pine, /bar_close_time=" \+ str\.tostring\(time_close\)/);
    assert.match(pine, /config=" \+ runtimeConfigId/);
  });

  it('uses provisional family identity and adds point 3 to confirmed pattern IDs', () => {
    assert.match(pine, /f_familyId\(/);
    assert.match(pine, /f_provisionalPatternId\(/);
    assert.match(pine, /f_confirmedPatternId\(string familyId, int p3Time\)/);
    assert.match(pine, /familyId \+ "\|p3=" \+ str\.tostring\(p3Time\)/);
  });

  it('keeps last-bar drawings on confirmed data', () => {
    assert.match(pine, /lastClosedIndex = barstate\.isconfirmed \? bar_index : bar_index - 1/);
    assert.match(pine, /lastClosedHigh = barstate\.isconfirmed \? high : high\[1\]/);
    assert.doesNotMatch(pine, /displayP3Price = na\(activeP3Price\) \? high : activeP3Price/);
  });

  it('terminates failed provisional geometry without resurrecting historical right rims', () => {
    assert.match(pine, /else if not stillValid or not noOvershoot or recovery < formingRecovery or bottomSuperseded/);
    assert.match(pine, /activeStage := STAGE_INVALIDATED/);
    assert.match(pine, /activeStage == STAGE_NONE and newPivotHigh/);
    assert.doesNotMatch(pine, /terminalResetThisBar/);
    assert.match(pine, /for p3Position = p3StartPosition to highCount - 1/);
    assert.match(pine, /candidateActionable = candidateHandleAge <= width/);
  });

  it('invalidates an upside escape before the handle pivot becomes knowable', () => {
    assert.match(pine, /if bar_index > activeP3Index and close > activeP3Price/);
    assert.match(pine, /activeStage := STAGE_INVALIDATED/);
  });

  it('limits historical execution to the documented rolling search window', () => {
    assert.match(pine, /withinExecutionWindow = bar_index >= math\.max\(0, last_bar_index - lookbackBars - pivotLeft - pivotRight\)/);
    assert.match(pine, /barstate\.isconfirmed and withinExecutionWindow/);
  });

  it('deduplicates terminal patterns so an old cup cannot immediately alert again', () => {
    assert.match(pine, /var array<string> finishedPatternIds = array\.new_string\(\)/);
    assert.match(pine, /var array<string> completedFamilyIds = array\.new_string\(\)/);
    assert.match(pine, /f_wasFinished\(finishedPatternIds, candidatePatternId\)/);
    assert.match(pine, /f_wasFinished\(completedFamilyIds, candidateFamilyId\)/);
    assert.match(pine, /f_markFinished\(finishedPatternIds, activePatternId\)\s*\n\s*activePatternId := f_confirmedPatternId/);
    assert.match(pine, /transitionStage == STAGE_BREAKOUT\s*\n\s*f_markFinished\(completedFamilyIds, activeFamilyId\)/);
    assert.match(pine, /f_markFinished\(finishedPatternIds, activePatternId\)/);
    assert.match(pine, /activeStage == STAGE_BREAKOUT or activeStage < STAGE_NONE/);
  });

  it('stays comfortably below TradingView plot-resource limits', () => {
    const plotCalls = [...pine.matchAll(/^plot\(/gm)].length;
    const plotshapeCalls = [...pine.matchAll(/^plotshape\(/gm)].length;
    const alertConditions = [...pine.matchAll(/^alertcondition\(/gm)].length;
    const estimatedPlotResources = plotCalls + plotshapeCalls + alertConditions;
    assert.equal(plotCalls, 13);
    assert.equal(alertConditions, ALERT_TITLES.length);
    assert.ok(
      estimatedPlotResources <= 32,
      `expected a small first-slice surface; observed ${estimatedPlotResources} plot resources`,
    );
  });
});
