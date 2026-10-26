import { loadMysqlConfig } from '../storage/mysql-store.ts';
import { createDatabaseBackup } from './mysql-admin.ts';

const config = loadMysqlConfig(process.env);
const path = await createDatabaseBackup(config, process.argv[2]);
console.log(JSON.stringify({ event: 'database-backup-created', path, checksum: `${path}.sha256` }));
