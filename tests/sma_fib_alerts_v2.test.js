import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1_PATH = join(ROOT, 'ma reaction classifier', 'sma-fib-confluence-alerts-v1.pine');
const V2_PATH = join(ROOT, 'ma reaction classifier', 'sma-fib-confluence-alerts-v2.pine');
const CONTRACT_PATH = join(
  ROOT,
  'ma reaction classifier',
  'analysis',
  'frozen-v2-sma-fib-alerts.json',
);

const v1 = readFileSync(V1_PATH, 'utf8');
const v2 = readFileSync(V2_PATH, 'utf8');
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function alertLines(source) {
  return source.split('\n').filter(line => line.startsWith('alertcondition('));
}

function machinePlotTitles(source) {
  return [...source.matchAll(/^plot\([^,\n]+,\s*"([^"]+)".*display=display\.data_window\)/gm)]
    .map(match => match[1]);
}

function plotResourceEstimate(source) {
  const plotCalls = [...source.matchAll(/^(?:[A-Za-z_]\w*\s*=\s*)?plot\(/gm)].length;
  const plotshapeLines = source.match(/^plotshape\([^\n]+/gm) ?? [];
  const alertConditions = [...source.matchAll(/^alertcondition\(/gm)].length;
  const seriesColorResources = plotshapeLines.filter(line => /\bcolor\s*=.*\?/.test(line)).length;
  return plotCalls + plotshapeLines.length + alertConditions + seriesColorResources;
}

describe('SMA/Fib display-only alert successor V2', () => {
  it('preserves the frozen V1 source bytes', () => {
    assert.equal(
      sha256(v1),
      '59738a1c77a52cf998f90238f6e5bdaec84412da08887247dd620a6643d6a510',
    );
    assert.equal(contract.predecessor.source_sha256, sha256(v1));
  });

  it('changes no calculation, event-state, or machine-plot code', () => {
    assert.equal(
      section(v2, 'int MA_LENGTH', '// Stable machine-readable plot order.'),
      section(v1, 'int MA_LENGTH', '// Stable machine-readable plot order.'),
    );
    assert.equal(
      section(
        v2,
        '// Stable machine-readable plot order.',
        '// Optional display-only explanation of the one current causal Fib pair.',
      ),
      section(v1, '// Stable machine-readable plot order.', '// Neutral visual context.'),
    );
    assert.deepEqual(machinePlotTitles(v2), machinePlotTitles(v1));
  });

  it('preserves every visual plot and all seven alert conditions byte-for-byte', () => {
    assert.equal(
      section(v2, '// Neutral visual context.', 'var table statusTable'),
      section(v1, '// Neutral visual context.', 'var table statusTable'),
    );
    assert.deepEqual(alertLines(v2), alertLines(v1));
    assert.equal(alertLines(v2).length, 7);
  });

  it('adds a default-off active-anchor input and a distinct indicator title', () => {
    assert.match(v2, /indicator\("SMA\/Fib Confluence Alerts \+ Anchor \[200D\/200W\]"/);
    assert.match(
      v2,
      /showActiveFibAnchorLeg = input\.bool\(false, "Show Active Fib Anchor Leg"\)/,
    );
  });

  it('uses exactly one persistent line and two persistent endpoint labels', () => {
    const anchorBlock = section(
      v2,
      '// Optional display-only explanation of the one current causal Fib pair.',
      '// Neutral visual context.',
    );
    assert.equal((anchorBlock.match(/\bvar line\b/g) ?? []).length, 1);
    assert.equal((anchorBlock.match(/\bvar label\b/g) ?? []).length, 2);
    assert.equal((anchorBlock.match(/\bline\.new\(/g) ?? []).length, 1);
    assert.equal((anchorBlock.match(/\blabel\.new\(/g) ?? []).length, 2);
    assert.match(
      anchorBlock,
      /showActiveFibAnchorLeg and profileSupported and pairEligible/,
    );
    assert.match(anchorBlock, /xloc=xloc\.bar_time/);
    assert.match(anchorBlock, /pairLowPivotTime, pairLowPrice/);
    assert.match(anchorBlock, /pairHighPivotTime, pairHighPrice/);
    assert.match(anchorBlock, /str\.format_time\([^,]+, "yyyy-MM-dd", syminfo\.timezone\)/);
    assert.match(anchorBlock, /str\.tostring\(pairLowPrice, format\.mintick\)/);
    assert.match(anchorBlock, /str\.tostring\(pairHighPrice, format\.mintick\)/);
  });

  it('deletes and resets every persistent object when the visual is unavailable', () => {
    const anchorBlock = section(
      v2,
      '// Optional display-only explanation of the one current causal Fib pair.',
      '// Neutral visual context.',
    );
    assert.equal((anchorBlock.match(/\bline\.delete\(/g) ?? []).length, 1);
    assert.equal((anchorBlock.match(/\blabel\.delete\(/g) ?? []).length, 2);
    assert.match(anchorBlock, /activeFibAnchorLeg := na/);
    assert.match(anchorBlock, /activeFibLowLabel := na/);
    assert.match(anchorBlock, /activeFibHighLabel := na/);
  });

  it('adds an explicit structural alignment row without conflating it with direct touch', () => {
    assert.match(v2, /table\.new\(position\.bottom_right, 2, 8,/);
    assert.match(v2, /"SMA \+ pocket"/);
    assert.match(v2, /pairEligible and maInGolden \? "Aligned" : "No confluence"/);
    assert.match(v2, /table\.clear\(statusTable, 0, 0, 1, 7\)/);
    assert.match(v2, /"Current direct"/);
  });

  it('uses no additional plot resources', () => {
    assert.equal(plotResourceEstimate(v1), 62);
    assert.equal(plotResourceEstimate(v2), 62);
    assert.equal(contract.runtime_limits.estimated_plot_resources, 62);
    assert.equal(contract.runtime_limits.remaining_plot_resource_headroom, 2);
  });

  it('binds the exact V2 source and freezes the display-only boundary', () => {
    assert.equal(contract.source_sha256, sha256(v2));
    assert.equal(contract.invariants.signal_math_unchanged, true);
    assert.equal(contract.invariants.event_state_machine_unchanged, true);
    assert.equal(contract.invariants.machine_plot_names_values_and_order_unchanged, true);
    assert.equal(contract.invariants.alert_conditions_titles_and_messages_unchanged, true);
    assert.equal(contract.delivery.overwrite_predecessor, false);
    assert.equal(contract.delivery.replace_existing_alerts, false);
  });
});
