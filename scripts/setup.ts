import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { issueMissingDemoTokens, seedDatabase } from '../src/seed.js';
import type { SeedResult } from '../src/seed.js';
import { seedIpdTemplate } from '../src/templates/ipd.js';
import type { IpdTemplateResult } from '../src/templates/ipd.js';
import { backfillDefaultAutomations } from '../src/core/default-automations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const reset = process.argv.includes('--reset');
const configPath = path.join(root, '.orbitrc.json');

if (reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  console.log(`Reset database: ${config.dbPath}`);
}

const db = openDatabase(config.dbPath);
let seed: SeedResult;
let ipd: IpdTemplateResult;
try {
  seed = seedDatabase(db);
  if (!seed.seeded) {
    console.log(`Database already seeded: ${config.dbPath}`);
  }
  ipd = seedIpdTemplate(db);
} catch (error) {
  closeDatabase(db);
  throw error;
}

const defaultAutomations = backfillDefaultAutomations(db);

let humanToken = seed.humanToken;
let agentToken = seed.agentToken;

if (!fs.existsSync(configPath)) {
  if (!seed.seeded && !humanToken) {
    const tokens = issueMissingDemoTokens(db);
    humanToken = tokens.humanToken;
    agentToken = tokens.agentToken;
  }
  const demoConfig = {
    apiUrl: `http://${config.host}:${config.port}`,
    humanToken,
    agentToken,
    projectKey: seed.projectKey,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(demoConfig, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.log(`Wrote ${configPath} (mode 600)`);
}

const counts = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM projects) AS projects,
       (SELECT COUNT(*) FROM tasks) AS tasks,
       (SELECT COUNT(*) FROM automations) AS automations,
       (SELECT COUNT(*) FROM agent_jobs) AS jobs`,
  )
  .get() as { projects: number; tasks: number; automations: number; jobs: number };

closeDatabase(db);

console.log('');
console.log('Orbit demo is ready.');
console.log(`  Database : ${config.dbPath}`);
console.log(`  Projects : ${counts.projects} (${counts.tasks} tasks, ${counts.automations} automations, ${counts.jobs} jobs)`);
console.log(`  Default  : ${seed.projectKey}`);
console.log(`  IPD      : ${ipd.created ? 'created' : 'already present'} (${ipd.projectKey}, ${ipd.taskCount} tasks)`);
if (defaultAutomations.length > 0) {
  console.log(`  Defaults : installed ${defaultAutomations.length} automation(s) for projects without automations`);
}
console.log('  Token file: .orbitrc.json (gitignored)');
console.log('');
console.log('Next:');
console.log('  npm run dev');
console.log('  npm run orbit -- me');
console.log('  npm run orbit -- board ORB');
