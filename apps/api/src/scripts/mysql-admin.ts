import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import type { MysqlConfig } from '../storage/mysql-store.ts';

function optionValue(value: string) {
  if (/[\0\r\n]/u.test(value)) throw new Error('MySQL client options cannot contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function withMysqlDefaults<Result>(config: MysqlConfig, work: (path: string) => Promise<Result>) {
  const directory = await mkdtemp(join(tmpdir(), 'petpal-mysql-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'client.cnf');
  const settings = [
    '[client]', `user=${optionValue(config.user)}`, `password=${optionValue(config.password)}`,
    `host=${optionValue(config.host)}`, `port=${config.port}`,
    ...(config.socketPath ? [`socket=${optionValue(config.socketPath)}`] : []),
    'default-character-set=utf8mb4', '',
  ].join('\n');
  try {
    await writeFile(path, settings, { flag: 'wx', mode: 0o600 });
    return await work(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function backupDirectory() {
  return resolve(process.env.PETPAL_BACKUP_DIR ?? join(homedir(), '.petpal', 'backups'));
}

export async function createDatabaseBackup(config: MysqlConfig, requestedPath?: string) {
  if (!config.database.startsWith('petpal_')) throw new Error('Backups are restricted to petpal_ databases');
  const directory = requestedPath ? dirname(resolve(requestedPath)) : backupDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = requestedPath ? resolve(requestedPath)
    : join(directory, `${config.database}-${new Date().toISOString().replaceAll(':', '-')}.sql`);
  const checksumPath = `${filename}.sha256`;
  const dump = process.env.MYSQLDUMP_BIN ?? 'mysqldump';

  await withMysqlDefaults(config, async defaults => {
    const child = spawn(dump, [`--defaults-extra-file=${defaults}`, '--single-transaction', '--routines',
      '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', config.database],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const exited = once(child, 'close');
    try {
      await pipeline(child.stdout, createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      const [code] = await exited as [number | null];
      if (code !== 0) throw new Error(`mysqldump failed${stderr ? `: ${stderr.trim()}` : ''}`);
      await chmod(filename, 0o600);
      const digest = await sha256(filename);
      await writeFile(checksumPath, `${digest}  ${basename(filename)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      child.kill();
      await rm(filename, { force: true });
      await rm(checksumPath, { force: true });
      throw error;
    }
  });
  return filename;
}

export async function sha256(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function verifyBackup(path: string) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Backup must be a regular file, not a symlink');
  const sidecar = await readFile(`${path}.sha256`, 'utf8');
  const expected = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/u.exec(sidecar)?.[1];
  if (!expected || expected !== await sha256(path)) throw new Error('Backup checksum is missing or invalid');
}

export async function restoreDatabaseBackup(config: MysqlConfig, path: string) {
  await verifyBackup(path);
  const mysql = process.env.MYSQL_BIN ?? 'mysql';
  await withMysqlDefaults(config, async defaults => {
    const child = spawn(mysql, [`--defaults-extra-file=${defaults}`, config.database],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const exited = once(child, 'close');
    try {
      await pipeline(createReadStream(path), child.stdin);
      const [code] = await exited as [number | null];
      if (code !== 0) throw new Error(`mysql restore failed${stderr ? `: ${stderr.trim()}` : ''}`);
    } catch (error) {
      child.kill();
      throw error;
    }
  });
}
