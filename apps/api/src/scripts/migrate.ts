import { loadConfig } from '../config.ts';
import { migrate, mysqlPool } from '../storage/mysql-store.ts';

const config = loadConfig(process.env);
if (config.storage !== 'mysql' || !config.mysql) throw new Error('Set PETPAL_STORAGE=mysql before running db:migrate');

const pool = mysqlPool(config.mysql);
try {
  await migrate(pool);
  console.log(JSON.stringify({ event: 'database-migrated', database: config.mysql.database }));
} finally {
  await pool.end();
}
