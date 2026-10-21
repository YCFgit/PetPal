export interface Service {
  id: string;
  name: string;
  petType: 'CAT' | 'DOG';
  durationMinutes: number;
  basePriceFen: number;
  extraPetPriceFen: number;
  maxPets: number;
  priceVersion: string;
  ruleVersion: string;
  active: boolean;
}

export interface Pet {
  id: string;
  userId: string;
  name: string;
  type: 'CAT' | 'DOG';
  careNotes: string;
}

export interface Address {
  id: string;
  userId: string;
  areaId: string;
  label: string;
}

export interface Slot {
  id: string;
  serviceId: string;
  areaId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  reserved: number;
  active: boolean;
}

export interface BookingInput {
  serviceId: string;
  slotId: string;
  addressId: string;
  petIds: string[];
}

export interface Quote {
  id: string;
  userId: string;
  input: BookingInput;
  serviceSnapshot: Service;
  petSnapshots: Pet[];
  addressSnapshot: Address;
  slotSnapshot: Pick<Slot, 'id' | 'areaId' | 'startsAt' | 'endsAt'>;
  amountFen: number;
  currency: 'CNY';
  createdAt: string;
  expiresAt: string;
}

export interface Order {
  id: string;
  userId: string;
  quoteId: string;
  status: 'PENDING_PAYMENT' | 'CANCELLED';
  paymentStatus: 'UNPAID';
  paymentChannelSubmitted: boolean;
  amountFen: number;
  currency: 'CNY';
  snapshot: Quote;
  createdAt: string;
  paymentDeadline: string;
  cancelledAt: string | null;
  version: number;
}

export interface Reservation {
  orderId: string;
  slotId: string;
  status: 'HELD' | 'RELEASED';
}

export interface OrderEvent {
  id: string;
  orderId: string;
  actorId: string;
  kind: 'ORDER_CREATED' | 'USER_CANCELLED' | 'PAYMENT_EXPIRED';
  createdAt: string;
  requestId: string;
}

export interface IdempotencyRecord {
  fingerprint: string;
  orderId: string;
}

export interface BookingState {
  services: Map<string, Service>;
  pets: Map<string, Pet>;
  addresses: Map<string, Address>;
  slots: Map<string, Slot>;
  quotes: Map<string, Quote>;
  orders: Map<string, Order>;
  reservations: Map<string, Reservation>;
  events: OrderEvent[];
  idempotency: Map<string, IdempotencyRecord>;
}

export function emptyState(): BookingState {
  return {
    services: new Map(), pets: new Map(), addresses: new Map(), slots: new Map(),
    quotes: new Map(), orders: new Map(), reservations: new Map(), events: [],
    idempotency: new Map(),
  };
}
