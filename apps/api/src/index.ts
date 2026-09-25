import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { seedReference } from './db/seed/reference';
import { seedTraining } from './db/seed/training';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db } = createDb(config.DATABASE_URL);
const seeded = await seedReference(db, { seedDir: config.SEED_DIR, adminEmail: config.BOOTSTRAP_ADMIN_EMAIL, adminName: config.BOOTSTRAP_ADMIN_NAME });
if (config.APP_ENV === 'training') seeded.push(...await seedTraining(db));
const app = await buildApp(config, db);
if (seeded.length) app.log.info(`Seeded: ${seeded.join(', ')}`);
await app.listen({ port: config.PORT, host: config.HOST });
