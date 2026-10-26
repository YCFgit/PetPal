import type { Address, IdempotencyRecord, Order, OrderEvent, Pet, Quote, Reservation, Service, Slot } from '../domain/models.ts';

export interface Entities {
  services: Service;
  pets: Pet;
  addresses: Address;
  slots: Slot;
  quotes: Quote;
  orders: Order;
  reservations: Reservation;
  idempotency: IdempotencyRecord;
}

export interface ListOptions {
  limit?: number;
  before?: Pick<Order, 'id' | 'createdAt'>;
  dueBefore?: string;
}

export interface EntityTable<Entity> {
  get(id: string): Promise<Entity | undefined>;
  list(filter?: Partial<Entity>, options?: ListOptions): Promise<Entity[]>;
  put(id: string, entity: Entity): Promise<void>;
  remove(id: string): Promise<void>;
}

export type Repository = { [Name in keyof Entities]: EntityTable<Entities[Name]> } & {
  appendEvent(event: OrderEvent): Promise<void>;
  resourceInUse(userId: string, kind: 'pet' | 'address', id: string): Promise<boolean>;
};

export interface BookingStore {
  run<Result>(userId: string | null, work: (repository: Repository) => Promise<Result>): Promise<Result>;
}
