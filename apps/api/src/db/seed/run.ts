import { loadConfig } from '../../config';
import { createDb } from '../client';
import { runMigrations } from '../migrate';
import { seedReference } from './reference';
import { seedTraining } from './training';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db, sql } = createDb(config.DATABASE_URL);
const log = await seedReference(db, { seedDir: config.SEED_DIR, adminEmail: config.BOOTSTRAP_ADMIN_EMAIL, adminName: config.BOOTSTRAP_ADMIN_NAME });
if (config.APP_ENV === 'training') log.push(...await seedTraining(db));
console.log(log.length ? 'Seeded: ' + log.join(', ') : 'Nothing to seed — already up to date.');
await sql.end();
