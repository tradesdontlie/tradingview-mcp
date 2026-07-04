/**
 * Apply (or stage) a validated decision, honoring the hybrid autonomy policy.
 *
 *   classification 'auto'     → write the new orchestrator_config.json (versioned)
 *                               + a dated rationale .md, and log it. Reversible.
 *   classification 'approval' → write proposal + rationale to decisions/pending/,
 *                               DO NOT touch the live config. A human promotes it.
 *   classification 'reject'   → write nothing; record the rationale for the record.
 *
 * Every applied change bumps version, stamps updated_by/updated_at, and points
 * rationale_ref at the dated .md — so `git diff` shows both the config delta and
 * the reasoning behind it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function loadConfig(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeRationale(dir, bot, classification, body) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = `${stamp()}_${bot}_${classification}.md`;
  writeFileSync(join(dir, name), body);
  return name;
}

export function applyDecision({ bot, classification, clamped, changes, rationaleText, configPath, decisionsDir }) {
  const body =
    `# Orchestrator decision — ${bot} — ${classification}\n\n` +
    `- when: ${new Date().toISOString()}\n` +
    `- changes: ${changes.length ? changes.join('; ') : '(none — re-affirm current config)'}\n\n` +
    `## Proposed ${bot} section\n\n\`\`\`json\n${JSON.stringify(clamped, null, 2)}\n\`\`\`\n\n` +
    `## Rationale\n\n${rationaleText ?? '(none provided)'}\n`;

  if (classification === 'reject') {
    const ref = writeRationale(join(decisionsDir, 'rejected'), bot, 'reject', body);
    return { applied: false, classification, rationale_ref: `rejected/${ref}` };
  }

  if (classification === 'approval') {
    const ref = writeRationale(join(decisionsDir, 'pending'), bot, 'approval', body);
    return { applied: false, classification, pending: true, rationale_ref: `pending/${ref}` };
  }

  // Dry-run: classify and record what WOULD happen, but never mutate the live config.
  if (process.env.ORCH_DRY_RUN) {
    const ref = writeRationale(join(decisionsDir, 'dryrun'), bot, 'auto', body);
    return { applied: false, dryRun: true, classification, rationale_ref: `dryrun/${ref}` };
  }

  // auto-apply
  const ref = writeRationale(decisionsDir, bot, 'auto', body);
  const cfg = loadConfig(configPath);
  cfg.version = (cfg.version ?? 0) + 1;
  cfg.updated_at = new Date().toISOString();
  cfg.updated_by = 'orchestrator';
  cfg.rationale_ref = ref;
  cfg[bot] = {
    ...cfg[bot],
    active_strategies: clamped.active_strategies,
    active_filters: clamped.active_filters,
    ...(clamped.param_overrides ? { param_overrides: clamped.param_overrides } : {}),
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  return { applied: true, classification, version: cfg.version, rationale_ref: ref };
}
