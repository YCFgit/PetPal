import { createHash } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { BookingState, Order } from '../domain/models.ts';
import type { BookingStore, Entities, EntityTable, Repository } from './booking-store.ts';
import { migrationTable, migrations, schemaVersion } from './mysql-schema.ts';

export interface MysqlConfig {
  host: string;
  port: number;
  socketPath: string | null;
  user: string;
  password: string;
  database: string;
}

export function loadMysqlConfig(environment: NodeJS.ProcessEnv): MysqlConfig {
  const host = environment.MYSQL_HOST ?? '127.0.0.1';
  const port = Number(environment.MYSQL_PORT ?? 3306);
  const database = environment.MYSQL_DATABASE ?? 'petpal_dev';
  const socketPath = environment.MYSQL_SOCKET?.trim() || null;
  const user = environment.MYSQL_USER ?? '';
  const password = environment.MYSQL_PASSWORD ?? '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Local MySQL requires a loopback MYSQL_HOST');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MYSQL_PORT');
  if (socketPath !== null && (!socketPath.startsWith('/') || socketPath.includes('\0'))) throw new Error('Invalid MYSQL_SOCKET');
  if (!/^petpal_[a-z0-9_]{1,48}$/.test(database)) throw new Error('MYSQL_DATABASE must use a petpal_ prefix');
  if (!user || !password) throw new Error('Set MYSQL_USER and MYSQL_PASSWORD for explicitly enabled MySQL storage');
  return { host, port, socketPath, database, user, password };
}

export function mysqlPool(config: MysqlConfig, includeDatabase = true): Pool {
  const { database, socketPath, ...connection } = config;
  return createPool({ ...connection, ...(socketPath ? { socketPath } : {}), ...(includeDatabase ? { database } : {}), connectionLimit: 8,
    connectTimeout: 5000, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true,
    decimalNumbers: false, multipleStatements: false });
}

const fields: { [Name in keyof Entities]: string[] } = {
  services: ['id', 'name', 'petType', 'durationMinutes', 'basePriceFen', 'extraPetPriceFen', 'maxPets', 'priceVersion', 'ruleVersion', 'active'],
  pets: ['id', 'userId', 'name', 'type', 'careNotes'],
  addresses: ['id', 'userId', 'areaId', 'label'],
  slots: ['id', 'serviceId', 'areaId', 'startsAt', 'endsAt', 'capacity', 'reserved', 'active'],
  quotes: ['id', 'userId', 'input', 'serviceSnapshot', 'petSnapshots', 'addressSnapshot', 'slotSnapshot', 'amountFen', 'currency', 'createdAt', 'expiresAt'],
  orders: ['id', 'userId', 'quoteId', 'status', 'paymentStatus', 'paymentChannelSubmitted', 'amountFen', 'currency', 'snapshot', 'createdAt', 'paymentDeadline', 'cancelledAt', 'version'],
  reservations: ['orderId', 'slotId', 'status'], idempotency: ['fingerprint', 'orderId'],
};
const jsonFields = new Set(['input', 'serviceSnapshot', 'petSnapshots', 'addressSnapshot', 'slotSnapshot', 'snapshot']);
const booleanFields = new Set(['active', 'paymentChannelSubmitted']);
const moneyFields = new Set(['amountFen', 'basePriceFen', 'extraPetPriceFen']);
const quoted = (field: string) => `\`${field}\``;
type SqlValue = string | number | boolean | null;

function encoded(field: string, value: unknown): SqlValue {
  if (jsonFields.has(field)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`Missing JSON database value: ${field}`);
    return serialized;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Unsupported database value: ${field}`);
}

function decoded<Entity>(row: RowDataPacket): Entity {
  const entity: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (jsonFields.has(field)) entity[field] = typeof value === 'string' ? JSON.parse(value) : value;
    else if (booleanFields.has(field)) entity[field] = Boolean(value);
    else if (moneyFields.has(field)) {
      const amount = Number(value);
      if (!Number.isSafeInteger(amount)) throw new Error('Unsafe integer money in database');
      entity[field] = amount;
    } else entity[field] = value;
  }
  return entity as Entity;
}

function repository(connection: PoolConnection, locking: boolean): Repository {
  const lock = locking ? ' FOR UPDATE' : '';
  const table = <Name extends keyof Entities>(name: Name): EntityTable<Entities[Name]> => {
    const columns = fields[name];
    const primary = name === 'reservations' ? 'orderId' : 'id';
    return {
      async get(id) {
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${columns.map(quoted)} FROM ${name} WHERE ${primary}=?${lock}`, [id]);
        return rows[0] ? decoded<Entities[Name]>(rows[0]) : undefined;
      },
      async list(filter = {}, options = {}) {
        const conditions: string[] = [];
        const values: SqlValue[] = [];
        for (const [field, value] of Object.entries(filter)) {
          if (!columns.includes(field) || jsonFields.has(field)) throw new Error('Unsupported repository filter');
          conditions.push(`${quoted(field)}=?`);
          values.push(encoded(field, value));
        }
        if (options.before) {
          if (name !== 'orders') throw new Error('Order cursor required');
          conditions.push('(createdAt < ? OR (createdAt = ? AND id < ?))');
          values.push(options.before.createdAt, options.before.createdAt, options.before.id);
        }
        if (options.dueBefore) {
          if (name !== 'orders') throw new Error('Order deadline required');
          conditions.push('paymentDeadline <= ?');
          values.push(options.dueBefore);
        }
        const limit = options.limit;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error('Invalid repository limit');
        const ordering = name === 'orders' ? ' ORDER BY createdAt DESC,id DESC' : '';
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${columns.map(quoted)} FROM ${name}`
          + (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') + ordering
          + (limit === undefined ? '' : ` LIMIT ${limit}`) + lock, values);
        return rows.map(row => decoded<Entities[Name]>(row));
      },
      async put(id, entity) {
        const record = entity as unknown as Record<string, unknown>;
        const [existing] = await connection.execute<RowDataPacket[]>(`SELECT ${primary} FROM ${name} WHERE ${primary}=? FOR UPDATE`, [id]);
        if (existing.length) {
          const update = columns.filter(field => field !== primary);
          await connection.execute(`UPDATE ${name} SET ${update.map(field => `${quoted(field)}=?`)} WHERE ${primary}=?`,
            [...update.map(field => encoded(field, record[field])), id]);
        } else {
          const insert = name === 'idempotency' ? ['id', ...columns] : columns;
          await connection.execute(`INSERT INTO ${name} (${insert.map(quoted)}) VALUES (${insert.map(() => '?')})`,
            insert.map(field => field === primary ? id : encoded(field, record[field])));
        }
        if (name === 'orders') {
          const order = entity as Order;
          await connection.execute('DELETE FROM order_resources WHERE orderId=?', [id]);
          for (const petId of order.snapshot.input.petIds) {
            await connection.execute("INSERT INTO order_resources(orderId,kind,resourceId) VALUES (?,'pet',?)", [id, petId]);
          }
          await connection.execute("INSERT INTO order_resources(orderId,kind,resourceId) VALUES (?,'address',?)", [id, order.snapshot.input.addressId]);
        }
      },
      async remove(id) { await connection.execute(`DELETE FROM ${name} WHERE ${primary}=?`, [id]); },
    };
  };
  return {
    services: table('services'), pets: table('pets'), addresses: table('addresses'), slots: table('slots'),
    quotes: table('quotes'), orders: table('orders'), reservations: table('reservations'), idempotency: table('idempotency'),
    async appendEvent(event) {
      await connection.execute('INSERT INTO order_events(id,orderId,actorId,kind,createdAt,requestId) VALUES (?,?,?,?,?,?)',
        [event.id, event.orderId, event.actorId, event.kind, event.createdAt, event.requestId]);
    },
    async resourceInUse(userId, kind, id) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT orders.id FROM order_resources
        JOIN orders ON orders.id=order_resources.orderId
        WHERE orders.userId=? AND orders.status='PENDING_PAYMENT' AND kind=? AND resourceId=? LIMIT 1`, [userId, kind, id]);
      return rows.length > 0;
    },
  };
}

export class MysqlBookingStore implements BookingStore {
  readonly pool: Pool;

  constructor(pool: Pool) { this.pool = pool; }

  async run<Result>(userId: string | null, work: (repository: Repository) => Promise<Result>): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await this.pool.getConnection();
      try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        if (userId !== null) {
          await connection.execute('INSERT IGNORE INTO user_locks(id) VALUES (?)', [userId]);
          await connection.execute('SELECT id FROM user_locks WHERE id=? FOR UPDATE', [userId]);
        }
        const result = await work(repository(connection, userId !== null));
        await connection.commit();
        return structuredClone(result);
      } catch (error) {
        await connection.rollback();
        const code = (error as { code?: string }).code;
        if (attempt >= 2 || !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? '')) throw error;
      } finally { connection.release(); }
    }
  }

  async ready() {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT version,checksum FROM schema_migrations ORDER BY version');
    const applied = new Map(rows.map(row => [Number(row.version), String(row.checksum)]));
    if (rows.some(row => Number(row.version) > schemaVersion)
      || migrations.some(migration => applied.get(migration.version) !== migrationChecksum(migration))) {
      throw new Error('Database schema requires npm run db:migrate');
    }
  }

  async seed(state: BookingState, userId: string) {
    await this.run(userId, async resources => {
      for (const name of ['services', 'pets', 'addresses', 'slots'] as const) {
        for (const [id, entity] of state[name]) {
          if (!(await resources[name].get(id))) {
            const destination = resources[name] as EntityTable<typeof entity>;
            await destination.put(id, entity);
          }
        }
      }
    });
  }

  async close() { await this.pool.end(); }
}

function migrationChecksum(migration: (typeof migrations)[number]) {
  return createHash('sha256').update(migration.statements.join('\n')).digest('hex');
}

export async function migrate(pool: Pool) {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(CONCAT(DATABASE(),':migrate'),10) AS acquired");
    if (Number(locks[0]?.acquired) !== 1) throw new Error('Could not acquire migration lock');
    locked = true;
    await connection.query(migrationTable);
    const [versions] = await connection.execute<RowDataPacket[]>('SELECT version,checksum FROM schema_migrations ORDER BY version DESC');
    if (versions.some(row => row.version > schemaVersion)) throw new Error('Database schema is newer than this API');
    const applied = new Map(versions.map(row => [Number(row.version), String(row.checksum)]));
    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const current = applied.get(migration.version);
      if (current !== undefined) {
        if (current !== checksum) throw new Error(`Migration ${migration.version} checksum mismatch`);
        continue;
      }
      for (const statement of migration.statements) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES (?,?)', [migration.version, checksum]);
    }
  } finally {
    try { if (locked) await connection.execute("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':migrate'))"); }
    finally { connection.release(); }
  }
}
