import { createHash, randomUUID } from 'node:crypto';
import { conflict, identifier, invalid, notFound, objectInput, onlyFields } from './errors.ts';
import type { BookingInput, Order, Quote, Slot } from './models.ts';
import type { BookingStore, Repository } from '../storage/booking-store.ts';

function parseBooking(value: unknown): BookingInput {
  const input = objectInput(value);
  onlyFields(input, ['serviceId', 'slotId', 'addressId', 'petIds']);
  if (!Array.isArray(input.petIds) || input.petIds.length === 0 || input.petIds.length > 10) {
    invalid('petIds must contain between 1 and 10 pet identifiers');
  }
  const petIds = input.petIds.map(petId => identifier(petId, 'petIds')).sort();
  if (new Set(petIds).size !== petIds.length) invalid('petIds must be unique');
  return {
    serviceId: identifier(input.serviceId, 'serviceId'),
    slotId: identifier(input.slotId, 'slotId'),
    addressId: identifier(input.addressId, 'addressId'),
    petIds,
  };
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    invalid('Idempotency-Key must have 8 to 128 letters, digits, underscores or hyphens');
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ownedOrder(state: Repository, userId: string, orderId: string): Promise<Order> {
  const order = await state.orders.get(orderId);
  if (!order || order.userId !== userId) return notFound();
  return order;
}

async function usableSlot(state: Repository, input: BookingInput, areaId: string, now: Date): Promise<Slot> {
  const slot = await state.slots.get(input.slotId);
  if (!slot || !slot.active || slot.serviceId !== input.serviceId || slot.areaId !== areaId) {
    return conflict('SLOT_UNAVAILABLE', 'This service and address cannot use the selected slot');
  }
  if (Date.parse(slot.startsAt) <= now.getTime()) conflict('SLOT_UNAVAILABLE', 'Slot has already started');
  if (slot.reserved >= slot.capacity) conflict('SLOT_FULL', 'No capacity is available');
  return slot;
}

export class BookingService {
  private readonly store: BookingStore;
  private readonly clock: () => Date;
  private readonly quoteTtlMs: number;
  private readonly paymentTtlMs: number;

  constructor(store: BookingStore, options: {
    clock?: () => Date;
    quoteTtlMs?: number;
    paymentTtlMs?: number;
  } = {}) {
    this.store = store;
    this.clock = options.clock ?? (() => new Date());
    this.quoteTtlMs = options.quoteTtlMs ?? 5 * 60_000;
    this.paymentTtlMs = options.paymentTtlMs ?? 15 * 60_000;
    for (const ttl of [this.quoteTtlMs, this.paymentTtlMs]) {
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('Invalid booking timeout');
    }
  }

  listServices() {
    return this.store.run(null, state => state.services.list({ active: true }));
  }

  listSlots(serviceId: string, areaId: string) {
    identifier(serviceId, 'serviceId');
    identifier(areaId, 'areaId');
    return this.store.run(null, async state => (await state.slots.list({ active: true, serviceId, areaId }))
      .filter(slot => Date.parse(slot.startsAt) > this.clock().getTime())
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
      .slice(0, 100)
      .map(slot => ({
        id: slot.id, serviceId: slot.serviceId, areaId: slot.areaId,
        startsAt: slot.startsAt, endsAt: slot.endsAt,
        available: Math.max(0, slot.capacity - slot.reserved),
      })));
  }

  createQuote(userId: string, value: unknown): Promise<Quote> {
    const input = parseBooking(value);
    return this.store.run(userId, async state => {
      const now = this.clock();
      const service = await state.services.get(input.serviceId);
      if (!service?.active) return notFound();
      if (!Number.isSafeInteger(service.basePriceFen) || service.basePriceFen <= 0
        || !Number.isSafeInteger(service.extraPetPriceFen) || service.extraPetPriceFen < 0
        || !Number.isInteger(service.maxPets) || service.maxPets < 1) {
        conflict('PRICE_UNAVAILABLE', 'Invalid service pricing configuration');
      }
      const address = await state.addresses.get(input.addressId);
      if (!address || address.userId !== userId) return notFound();
      const petSnapshots = await Promise.all(input.petIds.map(async petId => {
        const pet = await state.pets.get(petId);
        if (!pet || pet.userId !== userId) return notFound();
        if (pet.type !== service.petType) invalid('Pet type does not match the service');
        return pet;
      }));
      if (petSnapshots.length > service.maxPets) invalid('Too many pets for this service');
      const slot = await usableSlot(state, input, address.areaId, now);
      if (Date.parse(slot.endsAt) - Date.parse(slot.startsAt) !== service.durationMinutes * 60_000) {
        conflict('SLOT_UNAVAILABLE', 'Slot duration does not match the service');
      }
      const amountFen = service.basePriceFen + (petSnapshots.length - 1) * service.extraPetPriceFen;
      if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
        conflict('PRICE_UNAVAILABLE', 'Invalid service pricing configuration');
      }
      const quote: Quote = {
        id: randomUUID(), userId, input, serviceSnapshot: structuredClone(service),
        petSnapshots: structuredClone(petSnapshots), addressSnapshot: structuredClone(address),
        slotSnapshot: { id: slot.id, areaId: slot.areaId, startsAt: slot.startsAt, endsAt: slot.endsAt },
        amountFen, currency: 'CNY', createdAt: now.toISOString(),
        expiresAt: new Date(Math.min(now.getTime() + this.quoteTtlMs, Date.parse(slot.startsAt))).toISOString(),
      };
      await state.quotes.put(quote.id, quote);
      return quote;
    });
  }

  createOrder(userId: string, value: unknown, key: unknown, requestId: string): Promise<Order> {
    const input = objectInput(value);
    onlyFields(input, ['quoteId']);
    const quoteId = identifier(input.quoteId, 'quoteId');
    const recordKey = JSON.stringify([userId, 'create-order', idempotencyKey(key)]);
    const digest = fingerprint({ quoteId });
    return this.store.run(userId, async state => {
      const existing = await state.idempotency.get(recordKey);
      if (existing) {
        if (existing.fingerprint !== digest) conflict('IDEMPOTENCY_CONFLICT', 'Key was used for another request');
        return ownedOrder(state, userId, existing.orderId);
      }
      const quote = await state.quotes.get(quoteId);
      if (!quote || quote.userId !== userId) return notFound();
      const previous = (await state.orders.list({ quoteId }, { limit: 1 }))[0];
      if (previous) conflict('QUOTE_CONSUMED', 'Quote has already created an order');
      const now = this.clock();
      if (Date.parse(quote.expiresAt) <= now.getTime()) conflict('QUOTE_EXPIRED', 'Request a new quote');
      const service = await state.services.get(quote.input.serviceId);
      const address = await state.addresses.get(quote.input.addressId);
      if (!service?.active || !address || address.userId !== userId) return notFound();
      if (address.areaId !== quote.addressSnapshot.areaId || address.label !== quote.addressSnapshot.label
        || (await Promise.all(quote.petSnapshots.map(async snapshot => {
          const pet = await state.pets.get(snapshot.id);
          return !pet || pet.userId !== userId || pet.name !== snapshot.name
            || pet.type !== snapshot.type || pet.careNotes !== snapshot.careNotes;
        }))).some(Boolean)) {
        conflict('QUOTE_STALE', 'Booking resources have changed; request a new quote');
      }
      const slot = await usableSlot(state, quote.input, quote.addressSnapshot.areaId, now);
      if (slot.startsAt !== quote.slotSnapshot.startsAt || slot.endsAt !== quote.slotSnapshot.endsAt) {
        conflict('QUOTE_STALE', 'Slot has changed; request a new quote');
      }
      slot.reserved += 1;
      const order: Order = {
        id: randomUUID(), userId, quoteId, status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID',
        paymentChannelSubmitted: false, amountFen: quote.amountFen, currency: quote.currency,
        snapshot: structuredClone(quote), createdAt: now.toISOString(),
        paymentDeadline: new Date(Math.min(now.getTime() + this.paymentTtlMs, Date.parse(slot.startsAt))).toISOString(),
        cancelledAt: null, version: 1,
      };
      await state.slots.put(slot.id, slot);
      await state.orders.put(order.id, order);
      await state.reservations.put(order.id, { orderId: order.id, slotId: slot.id, status: 'HELD' });
      await state.appendEvent({ id: randomUUID(), orderId: order.id, actorId: userId,
        kind: 'ORDER_CREATED', createdAt: now.toISOString(), requestId });
      await state.idempotency.put(recordKey, { fingerprint: digest, orderId: order.id });
      return order;
    });
  }

  getOrder(userId: string, orderId: string) {
    identifier(orderId, 'orderId');
    return this.store.run(userId, state => ownedOrder(state, userId, orderId));
  }

  listOrders(userId: string, limit = 20, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be between 1 and 100');
    if (cursor !== undefined) identifier(cursor, 'cursor');
    return this.store.run(userId, async state => {
      const before = cursor === undefined ? undefined : await state.orders.get(cursor);
      if (cursor !== undefined && (!before || before.userId !== userId)) invalid('Invalid cursor');
      const orders = await state.orders.list({ userId }, { limit: limit + 1, ...(before ? { before } : {}) });
      const items = orders.slice(0, limit);
      return { items, nextCursor: orders.length > limit ? items.at(-1)?.id ?? null : null };
    });
  }

  cancelUnsubmittedOrder(userId: string, orderId: string, key: unknown, requestId: string) {
    identifier(orderId, 'orderId');
    const recordKey = JSON.stringify([userId, 'cancel-order', idempotencyKey(key)]);
    const digest = fingerprint({ orderId });
    return this.store.run(userId, async state => {
      const existing = await state.idempotency.get(recordKey);
      if (existing && existing.fingerprint !== digest) conflict('IDEMPOTENCY_CONFLICT', 'Key was used for another request');
      const order = await ownedOrder(state, userId, orderId);
      if (!existing && order.status !== 'CANCELLED') await this.release(state, order, 'USER_CANCELLED', userId, requestId);
      await state.idempotency.put(recordKey, { fingerprint: digest, orderId });
      return order;
    });
  }

  async expireUnsubmittedOrders() {
    const due = await this.store.run(null, state => state.orders.list(
      { status: 'PENDING_PAYMENT', paymentChannelSubmitted: false },
      { dueBefore: this.clock().toISOString(), limit: 100 }));
    let expired = 0;
    for (const candidate of due) {
      expired += await this.store.run(candidate.userId, async state => {
        const order = await ownedOrder(state, candidate.userId, candidate.id);
        if (order.status !== 'PENDING_PAYMENT' || order.paymentChannelSubmitted
          || Date.parse(order.paymentDeadline) > this.clock().getTime()) return 0;
        await this.release(state, order, 'PAYMENT_EXPIRED', 'system', randomUUID());
        return 1;
      });
    }
    return expired;
  }

  private async release(state: Repository, order: Order, kind: 'USER_CANCELLED' | 'PAYMENT_EXPIRED',
    actorId: string, requestId: string) {
    if (order.status !== 'PENDING_PAYMENT' || order.paymentChannelSubmitted) {
      conflict('PAYMENT_VERIFICATION_REQUIRED', 'Channel verification is required before releasing capacity');
    }
    const reservation = await state.reservations.get(order.id);
    const slot = reservation && await state.slots.get(reservation.slotId);
    if (!reservation || reservation.status !== 'HELD' || !slot || slot.reserved <= 0) {
      throw new Error('Reservation invariant violated');
    }
    slot.reserved -= 1;
    reservation.status = 'RELEASED';
    order.status = 'CANCELLED';
    order.cancelledAt = this.clock().toISOString();
    order.version += 1;
    await state.slots.put(slot.id, slot);
    await state.reservations.put(order.id, reservation);
    await state.orders.put(order.id, order);
    await state.appendEvent({ id: randomUUID(), orderId: order.id, actorId, kind,
      createdAt: order.cancelledAt, requestId });
  }
}
