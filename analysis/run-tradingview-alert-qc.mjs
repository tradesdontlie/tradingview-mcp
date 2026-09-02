#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { disconnect } from '../src/connection.js';
import {
  buildTradingViewAlertQcFailureReport,
  buildTradingViewAlertQcReport,
  collectTradingViewAlertQcInventory,
  exportTradingViewAlertsLogCsv,
  importTradingViewAlertsLogCsv,
  loadFrozenTradingViewAlertQcExpected,
  loadTradingViewAlertQcOccurrences,
  prepareTradingViewAlertQcHome,
  tradingViewAlertQcPaths,
  withTradingViewAlertQcWriterLock,
  writeTradingViewAlertQcBacklog,
  writeTradingViewAlertQcReport,
} from '../src/core/tradingview-alert-qc.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXPECTED_PATH = join(REPO_ROOT, 'analysis', 'tradingview-alert-qc-expected.json');

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function absoluteOption(value, label) {
  if (!value || !value.startsWith('/')) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

function optionalJson(path, label) {
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cleanupDownloadedCsv(exportResult, fixturePath) {
  const path = exportResult?.csv_path;
  if (!path || fixturePath || !path.startsWith('/tmp/tradingview-alert-qc-') || !existsSync(path)) return;
  try { unlinkSync(path); } catch { /* retained temp evidence is harmless if cleanup loses a race */ }
}

async function main() {
  const args = process.argv.slice(2);
  const home = absoluteOption(optionValue(args, '--home') ?? process.env.TRADINGVIEW_ALERT_QC_HOME ?? '/Users/odin/.codex/tradingview-alert-qc', 'QC home');
  const backlogPath = absoluteOption(optionValue(args, '--backlog') ?? process.env.TRADINGVIEW_ALERT_QC_BACKLOG ?? '/Users/odin/projects/omega/wiki/codebases/tradingview-mcp/investment-attention-alert-qc-improvements.md', 'QC backlog');
  const expectedPath = absoluteOption(optionValue(args, '--expected-config') ?? process.env.TRADINGVIEW_ALERT_QC_EXPECTED_CONFIG ?? DEFAULT_EXPECTED_PATH, 'expected config');
  const fixturePath = optionValue(args, '--fixture-csv') ?? process.env.TRADINGVIEW_ALERT_QC_FIXTURE_CSV ?? null;
  const rsiReferencePath = optionValue(args, '--rsi-reference') ?? process.env.TRADINGVIEW_ALERT_QC_RSI_REFERENCE ?? null;
  const paths = prepareTradingViewAlertQcHome(home, backlogPath);
  const expectedConfig = loadFrozenTradingViewAlertQcExpected(expectedPath);
  const startedAt = new Date().toISOString();
  let exportResult = null;
  let inventoryResult = null;
  try {
    inventoryResult = await collectTradingViewAlertQcInventory();
    exportResult = fixturePath
      ? {
        success: true,
        source: 'TradingView Alerts Log CSV fixture',
        csv_path: absoluteOption(fixturePath, 'fixture CSV'),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        target_url: 'fixture://TradingView Alerts Log CSV',
        ui_log_state: null,
      }
      : await exportTradingViewAlertsLogCsv();
    const referencePath = rsiReferencePath
      ? absoluteOption(rsiReferencePath, 'RSI reference')
      : join(paths.runtime_dir, 'independent-rsi-reference.json');
    const rsiReference = rsiReferencePath || existsSync(referencePath)
      ? optionalJson(referencePath, 'RSI reference file')
      : null;
    const result = await withTradingViewAlertQcWriterLock(home, async lockedPaths => {
      const importResult = importTradingViewAlertsLogCsv({
        csvPath: exportResult.csv_path,
        paths: lockedPaths,
        importedAt: exportResult.completed_at ?? new Date().toISOString(),
        observedInventory: inventoryResult.inventory,
        expectedConfig,
      });
      const occurrences = loadTradingViewAlertQcOccurrences(lockedPaths);
      const report = buildTradingViewAlertQcReport({
        expectedConfig,
        observedInventory: inventoryResult.inventory,
        collection: {
          ...exportResult,
          success: true,
          collected_at: exportResult.completed_at,
          observed_at: inventoryResult.observed_at,
          csv_columns: importResult.csv_columns,
          csv_record_count: importResult.csv_record_count,
          raw_evidence_path: importResult.raw_evidence_path,
          history_completeness: 'unproven',
          history_reason: 'The authenticated UI export is proven, but retention, pagination, and restart completeness remain unproven.',
        },
        occurrences,
        importResult,
        generatedAt: new Date().toISOString(),
        rsiReference,
        expectedConfigPath: expectedPath,
      });
      const backlog = writeTradingViewAlertQcBacklog(report.improvement_suggestions, {
        backlogPath: lockedPaths.backlog_path,
        generatedAt: report.generated_at,
      });
      report.backlog = {
        status: 'updated',
        path: backlog.path,
        item_ids: backlog.item_ids,
        preserved_statuses: backlog.preserved_statuses,
      };
      const reportPaths = writeTradingViewAlertQcReport(report, { paths: lockedPaths });
      return { report, report_paths: reportPaths, backlog, import_result: importResult };
    }, { backlogPath });
    console.log(JSON.stringify({
      success: true,
      command: `${process.execPath} ${fileURLToPath(import.meta.url)}`,
      expected_config_path: expectedPath,
      qc_home: paths.root,
      report_paths: result.report_paths,
      backlog: result.backlog,
      collection: result.report.collection,
      inventory_counts: {
        expected: result.report.inventory.expected_count,
        observed_managed: result.report.inventory.observed_managed_count,
        observed_active_managed: result.report.inventory.observed_active_managed_count,
      },
      occurrence_counts: {
        retained: result.report.occurrences.unique_occurrence_count,
        imported: result.import_result.appended_count,
        exact_duplicates: result.import_result.exact_duplicates,
      },
      finding_counts: result.report.findings,
      rsi_miss_sampling: result.report.rsi_miss_sampling.status,
    }, null, 2));
    cleanupDownloadedCsv(exportResult, fixturePath);
  } catch (error) {
    let failureReport = buildTradingViewAlertQcFailureReport({
      error,
      generatedAt: new Date().toISOString(),
      targetUrl: exportResult?.target_url ?? inventoryResult?.target_url ?? null,
    });
    let failurePaths = null;
    try {
      failurePaths = await withTradingViewAlertQcWriterLock(home, async lockedPaths => {
        const reportPaths = writeTradingViewAlertQcReport(failureReport, { paths: lockedPaths });
        return reportPaths;
      }, { backlogPath });
    } catch (writeError) {
      failureReport = { ...failureReport, report_write_error: writeError.message };
    }
    console.error(JSON.stringify({
      success: false,
      command: `${process.execPath} ${fileURLToPath(import.meta.url)}`,
      qc_home: paths.root,
      error: error.message,
      failure_report_paths: failurePaths,
      collection_failed: true,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}

await main();
