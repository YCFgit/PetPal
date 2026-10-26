import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { sha256, verifyBackup } from '../src/scripts/mysql-admin.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MySQL backup file validation', () => {
  it('accepts a backup with a matching SHA-256 sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'petpal-backup-test-'));
    directories.push(directory);
    const path = join(directory, 'petpal_dev.sql');
    await writeFile(path, 'SELECT 1;');
    await writeFile(`${path}.sha256`, `${await sha256(path)}  petpal_dev.sql\n`);
    await verifyBackup(path);
  });

  it('rejects a backup changed after its checksum was written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'petpal-backup-test-'));
    directories.push(directory);
    const path = join(directory, 'petpal_dev.sql');
    await writeFile(path, 'SELECT 1;');
    await writeFile(`${path}.sha256`, `${await sha256(path)}  petpal_dev.sql\n`);
    await writeFile(path, 'DROP DATABASE petpal_dev;');
    await assert.rejects(verifyBackup(path), /checksum is missing or invalid/);
  });
});
