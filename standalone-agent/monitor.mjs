import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { runAgent } from './lib/run-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'monitor.config.json');
const logsDir = path.join(__dirname, 'logs');

const { tasks } = JSON.parse(await fs.readFile(configPath, 'utf-8'));
if (!tasks?.length) {
  console.error(`No tasks found in ${configPath}`);
  process.exit(1);
}

await fs.mkdir(logsDir, { recursive: true });

async function runTask(task) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] running "${task.name}"...`);
  let result;
  try {
    result = await runAgent(task.prompt);
  } catch (err) {
    result = `ERROR: ${err.message}`;
  }
  const entry = `\n### ${startedAt}\n${result ?? '(no result)'}\n`;
  await fs.appendFile(path.join(logsDir, `${task.name}.md`), entry, 'utf-8');
  console.log(`[${startedAt}] "${task.name}" done -> logs/${task.name}.md`);
}

for (const task of tasks) {
  if (!cron.validate(task.schedule)) {
    console.error(`Skipping task "${task.name}": invalid cron schedule "${task.schedule}"`);
    continue;
  }
  cron.schedule(task.schedule, () => runTask(task));
  console.log(`Scheduled "${task.name}" (${task.schedule})`);
}

console.log('Monitor running. Press Ctrl+C to stop.');
