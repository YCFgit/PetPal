import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BookingService } from '../src/domain/booking-service.ts';
import { DomainError } from '../src/domain/errors.ts';
import { MemoryBookingStore } from '../src/storage/memory-store.ts';
import { demoState } from '../src/development/demo-data.ts';

const input = { serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'] };

function fixture() {
  let now = new Date('2026-10-21T07:00:00.000Z');
  const state = demoState('user-one', now);
  state.pets.set('other-cat', { id: 'other-cat', userId: 'user-two', name: 'Other', type: 'CAT', careNotes: '' });
  state.addresses.set('other-address', { id: 'other-address', userId: 'user-two', areaId: 'demo-area', label: 'Other' });
  const store = new MemoryBookingStore(state);
  const service = new BookingService(store, { clock: () => now });
  return { store, service, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

describe('pricing and resource ownership', () => {
  it('calculates a server-side integer-fen quote without reserving capacity', async () => {
    const { store, service } = fixture();
    const quote = await service.createQuote('user-one', input);
    assert.equal(quote.amountFen, 5000);
    assert.equal(quote.currency, 'CNY');
    assert.equal(quote.serviceSnapshot.priceVersion, 'demo-v1');
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 0);
  });

  it('charges extra pets using server configuration', async () => {
    const { store, service } = fixture();
    await store.transaction(state => state.pets.set('second-cat', {
      id: 'second-cat', userId: 'user-one', name: 'Second', type: 'CAT', careNotes: '',
    }));
    const quote = await service.createQuote('user-one', { ...input, petIds: ['demo-cat', 'second-cat'] });
    assert.equal(quote.amountFen, 6000);
  });

  it('rejects client prices, empty pets, duplicate pets and wrong pet types', async () => {
    const { store, service } = fixture();
    assert.throws(() => service.createQuote('user-one', { ...input, amountFen: 1 }), hasCode('INVALID_REQUEST'));
    assert.throws(() => service.createQuote('user-one', { ...input, petIds: [] }), hasCode('INVALID_REQUEST'));
    assert.throws(() => service.createQuote('user-one', { ...input, petIds: ['demo-cat', 'demo-cat'] }), hasCode('INVALID_REQUEST'));
    await store.transaction(state => { state.pets.get('demo-cat')!.type = 'DOG'; });
    await assert.rejects(service.createQuote('user-one', input), hasCode('INVALID_REQUEST'));
  });

  it('does not reveal another user’s pet or address', async () => {
    const { service } = fixture();
    await assert.rejects(service.createQuote('user-one', { ...input, petIds: ['other-cat'] }), hasCode('NOT_FOUND'));
    await assert.rejects(service.createQuote('user-one', { ...input, addressId: 'other-address' }), hasCode('NOT_FOUND'));
  });

  it('rejects area mismatches, started slots and wrong duration', async () => {
    const { service, store } = fixture();
    await store.transaction(state => { state.addresses.get('demo-address')!.areaId = 'outside'; });
    await assert.rejects(service.createQuote('user-one', input), hasCode('SLOT_UNAVAILABLE'));
    await store.transaction(state => {
      state.addresses.get('demo-address')!.areaId = 'demo-area';
      state.slots.get('demo-slot')!.endsAt = '2026-10-22T08:00:00.000Z';
    });
    await assert.rejects(service.createQuote('user-one', input), hasCode('SLOT_UNAVAILABLE'));
    await store.transaction(state => { state.slots.get('demo-slot')!.startsAt = '2026-10-20T07:00:00.000Z'; });
    await assert.rejects(service.createQuote('user-one', input), hasCode('SLOT_UNAVAILABLE'));
  });

  it('returns detached snapshots so callers cannot mutate storage', async () => {
    const { service } = fixture();
    const quote = await service.createQuote('user-one', input);
    quote.amountFen = 1;
    quote.serviceSnapshot.basePriceFen = 1;
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'order-key-1', 'request-one');
    assert.equal(order.amountFen, 5000);
    assert.equal(order.snapshot.serviceSnapshot.basePriceFen, 5000);
  });

  it('rejects fractional, negative and invalid pricing configuration', async () => {
    const { service, store } = fixture();
    await store.transaction(state => { state.services.get('demo-cat-care')!.basePriceFen = 4999.5; });
    await assert.rejects(service.createQuote('user-one', input), hasCode('PRICE_UNAVAILABLE'));
    await store.transaction(state => {
      state.services.get('demo-cat-care')!.basePriceFen = 5000;
      state.services.get('demo-cat-care')!.extraPetPriceFen = -100;
    });
    await assert.rejects(service.createQuote('user-one', input), hasCode('PRICE_UNAVAILABLE'));
  });
});

describe('idempotent booking and capacity', () => {
  it('creates one order, reservation and audit event under concurrent replay', async () => {
    const { service, store } = fixture();
    const quote = await service.createQuote('user-one', input);
    const orders = await Promise.all(Array.from({ length: 20 }, () =>
      service.createOrder('user-one', { quoteId: quote.id }, 'repeat-key', 'request-one')));
    assert.equal(new Set(orders.map(order => order.id)).size, 1);
    const counts = await store.transaction(state => ({
      orders: state.orders.size, reservations: state.reservations.size,
      events: state.events.length, reserved: state.slots.get('demo-slot')?.reserved,
    }));
    assert.deepEqual(counts, { orders: 1, reservations: 1, events: 1, reserved: 1 });
  });

  it('allows only one winner for the last slot', async () => {
    const { service, store } = fixture();
    const quotes = await Promise.all(Array.from({ length: 20 }, () => service.createQuote('user-one', input)));
    const results = await Promise.allSettled(quotes.map((quote, index) =>
      service.createOrder('user-one', { quoteId: quote.id }, `booking-key-${index}`, 'request-one')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected'
      && hasCode('SLOT_FULL')(result.reason)).length, 19);
    assert.equal(await store.transaction(state => state.orders.size), 1);
  });

  it('rejects key reuse with different content and quote reuse with a new key', async () => {
    const { service } = fixture();
    const first = await service.createQuote('user-one', input);
    const second = await service.createQuote('user-one', input);
    await service.createOrder('user-one', { quoteId: first.id }, 'original-key', 'request-one');
    await assert.rejects(service.createOrder('user-one', { quoteId: second.id }, 'original-key', 'request-two'), hasCode('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(service.createOrder('user-one', { quoteId: first.id }, 'different-key', 'request-three'), hasCode('QUOTE_CONSUMED'));
  });

  it('rejects expired quotes without consuming capacity but permits committed request replay', async () => {
    const { service, store, advance } = fixture();
    const quote = await service.createQuote('user-one', input);
    advance(5 * 60_000);
    await assert.rejects(service.createOrder('user-one', { quoteId: quote.id }, 'expired-key', 'request-one'), hasCode('QUOTE_EXPIRED'));
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 0);
    const fresh = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: fresh.id }, 'committed-key', 'request-two');
    advance(5 * 60_000);
    assert.equal((await service.createOrder('user-one', { quoteId: fresh.id }, 'committed-key', 'request-three')).id, order.id);
  });

  it('keeps accepted pricing stable if the catalogue is updated', async () => {
    const { service, store } = fixture();
    const quote = await service.createQuote('user-one', input);
    await store.transaction(state => {
      state.services.get('demo-cat-care')!.basePriceFen = 9000;
      state.services.get('demo-cat-care')!.priceVersion = 'demo-v2';
    });
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'snapshot-key', 'request-one');
    assert.equal(order.amountFen, 5000);
    assert.equal(order.snapshot.serviceSnapshot.priceVersion, 'demo-v1');
  });

  it('rechecks resource ownership and slot changes between quote and order', async () => {
    const { service, store } = fixture();
    const quote = await service.createQuote('user-one', input);
    await store.transaction(state => { state.pets.get('demo-cat')!.userId = 'user-two'; });
    await assert.rejects(service.createOrder('user-one', { quoteId: quote.id }, 'stale-ownership', 'request-one'), hasCode('QUOTE_STALE'));
    await store.transaction(state => {
      state.pets.get('demo-cat')!.userId = 'user-one';
      state.slots.get('demo-slot')!.endsAt = '2026-10-22T09:00:00.000Z';
    });
    await assert.rejects(service.createOrder('user-one', { quoteId: quote.id }, 'stale-slot-key', 'request-one'), hasCode('QUOTE_STALE'));
  });

  it('rolls back the full transaction and remains usable after failures', async () => {
    const { service, store } = fixture();
    await assert.rejects(store.transaction(state => {
      state.slots.get('demo-slot')!.reserved += 1;
      throw new Error('simulated persistence failure');
    }), /simulated persistence failure/);
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 0);
    const quote = await service.createQuote('user-one', input);
    assert.equal((await service.createOrder('user-one', { quoteId: quote.id }, 'rollback-key', 'request-one')).status, 'PENDING_PAYMENT');
  });

  it('scopes quotes and idempotency keys to their owner', async () => {
    const { service, store } = fixture();
    await store.transaction(state => { state.slots.get('demo-slot')!.capacity = 2; });
    const first = await service.createQuote('user-one', input);
    await assert.rejects(service.createOrder('user-two', { quoteId: first.id }, 'shared-key', 'request-one'), hasCode('NOT_FOUND'));
    const second = await service.createQuote('user-two', {
      ...input, addressId: 'other-address', petIds: ['other-cat'],
    });
    const orders = await Promise.all([
      service.createOrder('user-one', { quoteId: first.id }, 'shared-key', 'request-one'),
      service.createOrder('user-two', { quoteId: second.id }, 'shared-key', 'request-two'),
    ]);
    assert.notEqual(orders[0]?.id, orders[1]?.id);
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 2);
  });
});

describe('order visibility, cancellation and expiry', () => {
  it('hides other users’ orders and isolates pagination', async () => {
    const { service } = fixture();
    const quote = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'owner-key', 'request-one');
    await assert.rejects(service.getOrder('user-two', order.id), hasCode('NOT_FOUND'));
    assert.deepEqual(await service.listOrders('user-two'), { items: [], nextCursor: null });
    await assert.rejects(service.listOrders('user-two', 10, order.id), hasCode('INVALID_REQUEST'));
    assert.throws(() => service.listOrders('user-one', 0), hasCode('INVALID_REQUEST'));
  });

  it('releases exactly once across repeated cancellation and expiry', async () => {
    const { service, store, advance } = fixture();
    const quote = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'create-cancel-key', 'request-one');
    const cancellations = await Promise.all(Array.from({ length: 10 }, () =>
      service.cancelUnsubmittedOrder('user-one', order.id, 'cancel-repeat-key', 'request-two')));
    assert.ok(cancellations.every(result => result.status === 'CANCELLED' && result.version === 2));
    advance(20 * 60_000);
    assert.equal(await service.expireUnsubmittedOrders(), 0);
    assert.deepEqual(await store.transaction(state => ({ reserved: state.slots.get('demo-slot')?.reserved,
      events: state.events.map(event => event.kind) })), { reserved: 0, events: ['ORDER_CREATED', 'USER_CANCELLED'] });
  });

  it('rejects cancellation by another user without changing capacity', async () => {
    const { service, store } = fixture();
    const quote = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'cancel-owner-key', 'request-one');
    await assert.rejects(service.cancelUnsubmittedOrder('user-two', order.id, 'intruder-cancel', 'request-two'), hasCode('NOT_FOUND'));
    assert.equal((await service.getOrder('user-one', order.id)).status, 'PENDING_PAYMENT');
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 1);
  });

  it('paginates tied creation timestamps without duplicate or missing orders', async () => {
    const { service, store } = fixture();
    await store.transaction(state => { state.slots.get('demo-slot')!.capacity = 3; });
    for (const index of [0, 1, 2]) {
      const quote = await service.createQuote('user-one', input);
      await service.createOrder('user-one', { quoteId: quote.id }, `page-order-${index}`, 'request-one');
    }
    const firstPage = await service.listOrders('user-one', 2);
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    const lastPage = await service.listOrders('user-one', 2, firstPage.nextCursor);
    assert.equal(lastPage.items.length, 1);
    assert.equal(lastPage.nextCursor, null);
    assert.equal(new Set([...firstPage.items, ...lastPage.items].map(order => order.id)).size, 3);
  });

  it('expires only orders never submitted to a payment channel', async () => {
    const { service, store, advance } = fixture();
    const quote = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'payment-guard-key', 'request-one');
    await store.transaction(state => { state.orders.get(order.id)!.paymentChannelSubmitted = true; });
    advance(16 * 60_000);
    assert.equal(await service.expireUnsubmittedOrders(), 0);
    await assert.rejects(service.cancelUnsubmittedOrder('user-one', order.id, 'cannot-release', 'request-two'), hasCode('PAYMENT_VERIFICATION_REQUIRED'));
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 1);
  });

  it('releases expired unsubmitted reservations only once', async () => {
    const { service, store, advance } = fixture();
    const quote = await service.createQuote('user-one', input);
    const order = await service.createOrder('user-one', { quoteId: quote.id }, 'expiry-key', 'request-one');
    advance(15 * 60_000);
    assert.equal(await service.expireUnsubmittedOrders(), 1);
    assert.equal(await service.expireUnsubmittedOrders(), 0);
    assert.equal((await service.getOrder('user-one', order.id)).status, 'CANCELLED');
    assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 0);
  });
});
