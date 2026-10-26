import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { BookingService } from '../src/domain/booking-service.ts';
import { demoState } from '../src/development/demo-data.ts';
import { DomainError } from '../src/domain/errors.ts';
import { MysqlBookingStore, loadMysqlConfig, migrate, mysqlPool } from '../src/storage/mysql-store.ts';

const enabled = process.env.PETPAL_TEST_MYSQL === 'true';
const database = process.env.MYSQL_TEST_DATABASE ?? 'petpal_test';

describe('MySQL booking storage', { skip: !enabled }, () => {
  let pool: Pool | undefined;
  let store: MysqlBookingStore | undefined;
  const now = new Date('2030-01-01T00:00:00.000Z');
  const userId = 'mysql-user';

  before(async () => {
    if (!/^petpal_test[a-z0-9_]{0,40}$/.test(database)) {
      throw new Error('MYSQL_TEST_DATABASE must start with petpal_test');
    }
    const config = loadMysqlConfig({ ...process.env, MYSQL_DATABASE: database });
    pool = mysqlPool(config);
    await migrate(pool);
    await clearTestDatabase(pool);
    await migrate(pool);
    store = new MysqlBookingStore(pool);
    await store.ready();
    await store.seed(demoState(userId, now), userId);
  });

  after(async () => {
    if (!pool) return;
    try { await clearTestDatabase(pool); }
    finally { await pool.end(); }
  });

  it('persists profiles, quotes and orders across store instances', async () => {
    assert.ok(store);
    const bookings = new BookingService(store, { clock: () => now });
    const quote = await bookings.createQuote(userId, {
      serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'],
    });
    const order = await bookings.createOrder(userId, { quoteId: quote.id }, 'mysql-persist-key', 'mysql-request');
    const secondStore = new MysqlBookingStore(mysqlPool(loadMysqlConfig({ ...process.env, MYSQL_DATABASE: database })));
    try {
      const restored = await new BookingService(secondStore, { clock: () => now }).getOrder(userId, order.id);
      assert.deepEqual(restored, order);
    } finally {
      await secondStore.close();
    }
    await bookings.cancelUnsubmittedOrder(userId, order.id, 'mysql-persist-cancel', 'mysql-cancel');
  });

  it('allows one winner for the last slot and replays its idempotency key', async () => {
    assert.ok(store);
    await store.run(userId, async resources => {
      const slot = await resources.slots.get('demo-slot');
      assert.ok(slot);
      slot.reserved = 0;
      await resources.slots.put(slot.id, slot);
    });
    const bookings = new BookingService(store, { clock: () => now });
    const quoteOne = await bookings.createQuote(userId, {
      serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'],
    });
    const quoteTwo = await bookings.createQuote(userId, {
      serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'],
    });
    const outcomes = await Promise.allSettled([
      bookings.createOrder(userId, { quoteId: quoteOne.id }, 'mysql-capacity-one', 'request-one'),
      bookings.createOrder(userId, { quoteId: quoteTwo.id }, 'mysql-capacity-two', 'request-two'),
    ]);
    const winners = outcomes.filter(result => result.status === 'fulfilled');
    const failures = outcomes.filter(result => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0]?.status === 'rejected' && failures[0].reason instanceof DomainError);
    const winner = winners[0];
    assert.ok(winner?.status === 'fulfilled');
    const key = winner.value.quoteId === quoteOne.id ? 'mysql-capacity-one' : 'mysql-capacity-two';
    assert.deepEqual(await bookings.createOrder(userId, { quoteId: winner.value.quoteId }, key, 'replay'), winner.value);
  });
});

async function clearTestDatabase(pool: Pool) {
  await pool.query('DELETE FROM order_events');
  await pool.query('DELETE FROM idempotency');
  await pool.query('DELETE FROM reservations');
  await pool.query('DELETE FROM order_resources');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM quotes');
  await pool.query('DELETE FROM pets');
  await pool.query('DELETE FROM addresses');
  await pool.query('DELETE FROM slots');
  await pool.query('DELETE FROM services');
  await pool.query('DELETE FROM user_locks');
  await pool.query('DELETE FROM schema_migrations');
}
