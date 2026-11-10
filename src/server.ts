import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const { app } = buildApp({ db, config });

const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down`);
  await app.close();
  closeDatabase(db);
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  const projects = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
  if (Number(projects.count) === 0) {
    app.log.warn('Database has no projects. Run `npm run setup` to create the demo data.');
  }
  app.log.info(`Orbit API: http://${config.host}:${config.port}`);
  app.log.info(`Projects in database: ${projects.count}`);
} catch (error) {
  app.log.error(error);
  closeDatabase(db);
  process.exit(1);
}
