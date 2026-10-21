import { createHash, randomUUID } from 'node:crypto';
import { conflict, identifier, invalid, notFound, objectInput, onlyFields } from './errors.ts';
import type { BookingInput, BookingState, Order, Quote, Slot } from './models.ts';
import type { BookingStore } from '../storage/memory-store.ts';

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

function ownedOrder(state: BookingState, userId: string, orderId: string): Order {
  const order = state.orders.get(orderId);
  if (!order || order.userId !== userId) return notFound();
  return order;
}

function usableSlot(state: BookingState, input: BookingInput, areaId: string, now: Date): Slot {
  const slot = state.slots.get(input.slotId);
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
    return this.store.transaction(state => [...state.services.values()].filter(service => service.active));
  }

  listSlots(serviceId: string, areaId: string) {
    identifier(serviceId, 'serviceId');
    identifier(areaId, 'areaId');
    return this.store.transaction(state => [...state.slots.values()]
      .filter(slot => slot.active && slot.serviceId === serviceId && slot.areaId === areaId
        && Date.parse(slot.startsAt) > this.clock().getTime())
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
      .slice(0, 100)
      .map(slot => ({
        id: slot.id, serviceId: slot.serviceId, areaId: slot.areaId,
        startsAt: slot.startsAt, endsAt: slot.endsAt,
        available: Math.max(0, slot.capacity - slot.reserved),
      })));
  }

  listPets(userId: string) {
    return this.store.transaction(state => [...state.pets.values()].filter(pet => pet.userId === userId));
  }

  listAddresses(userId: string) {
    return this.store.transaction(state => [...state.addresses.values()]
      .filter(address => address.userId === userId));
  }

  createQuote(userId: string, value: unknown): Promise<Quote> {
    const input = parseBooking(value);
    return this.store.transaction(state => {
      const now = this.clock();
      const service = state.services.get(input.serviceId);
      if (!service?.active) return notFound();
      if (!Number.isSafeInteger(service.basePriceFen) || service.basePriceFen <= 0
        || !Number.isSafeInteger(service.extraPetPriceFen) || service.extraPetPriceFen < 0
        || !Number.isInteger(service.maxPets) || service.maxPets < 1) {
        conflict('PRICE_UNAVAILABLE', 'Invalid service pricing configuration');
      }
      const address = state.addresses.get(input.addressId);
      if (!address || address.userId !== userId) return notFound();
      const petSnapshots = input.petIds.map(petId => {
        const pet = state.pets.get(petId);
        if (!pet || pet.userId !== userId) return notFound();
        if (pet.type !== service.petType) invalid('Pet type does not match the service');
        return pet;
      });
      if (petSnapshots.length > service.maxPets) invalid('Too many pets for this service');
      const slot = usableSlot(state, input, address.areaId, now);
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
      state.quotes.set(quote.id, quote);
      return quote;
    });
  }

  createOrder(userId: string, value: unknown, key: unknown, requestId: string): Promise<Order> {
    const input = objectInput(value);
    onlyFields(input, ['quoteId']);
    const quoteId = identifier(input.quoteId, 'quoteId');
    const recordKey = JSON.stringify([userId, 'create-order', idempotencyKey(key)]);
    const digest = fingerprint({ quoteId });
    return this.store.transaction(state => {
      const existing = state.idempotency.get(recordKey);
      if (existing) {
        if (existing.fingerprint !== digest) conflict('IDEMPOTENCY_CONFLICT', 'Key was used for another request');
        return ownedOrder(state, userId, existing.orderId);
      }
      const quote = state.quotes.get(quoteId);
      if (!quote || quote.userId !== userId) return notFound();
      const previous = [...state.orders.values()].find(order => order.quoteId === quoteId);
      if (previous) conflict('QUOTE_CONSUMED', 'Quote has already created an order');
      const now = this.clock();
      if (Date.parse(quote.expiresAt) <= now.getTime()) conflict('QUOTE_EXPIRED', 'Request a new quote');
      const service = state.services.get(quote.input.serviceId);
      const address = state.addresses.get(quote.input.addressId);
      if (!service?.active || !address || address.userId !== userId) return notFound();
      if (address.areaId !== quote.addressSnapshot.areaId
        || quote.input.petIds.some(petId => state.pets.get(petId)?.userId !== userId)) {
        conflict('QUOTE_STALE', 'Booking resources have changed; request a new quote');
      }
      const slot = usableSlot(state, quote.input, quote.addressSnapshot.areaId, now);
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
      state.orders.set(order.id, order);
      state.reservations.set(order.id, { orderId: order.id, slotId: slot.id, status: 'HELD' });
      state.events.push({ id: randomUUID(), orderId: order.id, actorId: userId,
        kind: 'ORDER_CREATED', createdAt: now.toISOString(), requestId });
      state.idempotency.set(recordKey, { fingerprint: digest, orderId: order.id });
      return order;
    });
  }

  getOrder(userId: string, orderId: string) {
    identifier(orderId, 'orderId');
    return this.store.transaction(state => ownedOrder(state, userId, orderId));
  }

  listOrders(userId: string, limit = 20, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be between 1 and 100');
    if (cursor !== undefined) identifier(cursor, 'cursor');
    return this.store.transaction(state => {
      const orders = [...state.orders.values()].filter(order => order.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      const start = cursor === undefined ? 0 : orders.findIndex(order => order.id === cursor) + 1;
      if (cursor !== undefined && start === 0) invalid('Invalid cursor');
      const items = orders.slice(start, start + limit);
      return { items, nextCursor: start + limit < orders.length ? items.at(-1)?.id ?? null : null };
    });
  }

  cancelUnsubmittedOrder(userId: string, orderId: string, key: unknown, requestId: string) {
    identifier(orderId, 'orderId');
    const recordKey = JSON.stringify([userId, 'cancel-order', idempotencyKey(key)]);
    const digest = fingerprint({ orderId });
    return this.store.transaction(state => {
      const existing = state.idempotency.get(recordKey);
      if (existing && existing.fingerprint !== digest) conflict('IDEMPOTENCY_CONFLICT', 'Key was used for another request');
      const order = ownedOrder(state, userId, orderId);
      if (!existing && order.status !== 'CANCELLED') this.release(state, order, 'USER_CANCELLED', userId, requestId);
      state.idempotency.set(recordKey, { fingerprint: digest, orderId });
      return order;
    });
  }

  expireUnsubmittedOrders() {
    return this.store.transaction(state => {
      let expired = 0;
      const now = this.clock().getTime();
      for (const order of state.orders.values()) {
        if (order.status === 'PENDING_PAYMENT' && !order.paymentChannelSubmitted
          && Date.parse(order.paymentDeadline) <= now) {
          this.release(state, order, 'PAYMENT_EXPIRED', 'system', randomUUID());
          expired += 1;
        }
      }
      return expired;
    });
  }

  private release(state: BookingState, order: Order, kind: 'USER_CANCELLED' | 'PAYMENT_EXPIRED',
    actorId: string, requestId: string) {
    if (order.status !== 'PENDING_PAYMENT' || order.paymentChannelSubmitted) {
      conflict('PAYMENT_VERIFICATION_REQUIRED', 'Channel verification is required before releasing capacity');
    }
    const reservation = state.reservations.get(order.id);
    const slot = reservation && state.slots.get(reservation.slotId);
    if (!reservation || reservation.status !== 'HELD' || !slot || slot.reserved <= 0) {
      throw new Error('Reservation invariant violated');
    }
    slot.reserved -= 1;
    reservation.status = 'RELEASED';
    order.status = 'CANCELLED';
    order.cancelledAt = this.clock().toISOString();
    order.version += 1;
    state.events.push({ id: randomUUID(), orderId: order.id, actorId, kind,
      createdAt: order.cancelledAt, requestId });
  }
}
