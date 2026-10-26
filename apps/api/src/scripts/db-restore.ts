import { loadMysqlConfig } from '../storage/mysql-store.ts';
import { createDatabaseBackup, restoreDatabaseBackup, verifyBackup } from './mysql-admin.ts';

const config = loadMysqlConfig(process.env);
const backupPath = process.argv[2];
if (config.database !== 'petpal_dev') throw new Error('Restore is restricted to MYSQL_DATABASE=petpal_dev');
if (!backupPath || process.argv[3] !== '--confirm=petpal_dev' || process.argv.length > 4) {
  throw new Error('Usage: npm run db:restore -- <backup.sql> --confirm=petpal_dev');
}

await verifyBackup(backupPath);
const safetyBackup = await createDatabaseBackup(config);
console.log(JSON.stringify({ event: 'database-restore-safety-backup-created', path: safetyBackup }));
await restoreDatabaseBackup(config, backupPath);
console.log(JSON.stringify({ event: 'database-restored', database: config.database, safetyBackup }));
