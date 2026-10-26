import { emptyState } from '../domain/models.ts';
import type { BookingState } from '../domain/models.ts';
import type { BookingStore, Entities, EntityTable, Repository } from './booking-store.ts';

export class MemoryBookingStore implements BookingStore {
  private state: BookingState;
  private tail: Promise<void> = Promise.resolve();

  constructor(seed: BookingState = emptyState()) {
    this.state = structuredClone(seed);
  }

  async transaction<Result>(work: (state: BookingState) => Result): Promise<Result> {
    return this.withDraft(async state => {
      const result = work(state);
      if (result instanceof Promise) throw new Error('Memory transactions must be synchronous');
      return result;
    });
  }

  async run<Result>(_userId: string | null, work: (repository: Repository) => Promise<Result>): Promise<Result> {
    return this.withDraft(async state => {
      const table = <Name extends keyof Entities>(name: Name): EntityTable<Entities[Name]> => {
        const resources = state[name] as Map<string, Entities[Name]>;
        return {
          async get(id) { return resources.get(id); },
          async put(id, entity) { resources.set(id, entity); },
          async remove(id) { resources.delete(id); },
          async list(filter = {}, options = {}) {
            let items = [...resources.values()].filter(entity => Object.entries(filter)
              .every(([key, value]) => (entity as unknown as Record<string, unknown>)[key] === value));
            if (name === 'orders') {
              items.sort((left, right) => {
                const first = left as Entities['orders'];
                const second = right as Entities['orders'];
                return second.createdAt.localeCompare(first.createdAt) || second.id.localeCompare(first.id);
              });
              const before = options.before;
              if (before) items = items.filter(entity => {
                const order = entity as Entities['orders'];
                return order.createdAt < before.createdAt || (order.createdAt === before.createdAt && order.id < before.id);
              });
              if (options.dueBefore) items = items.filter(entity =>
                (entity as Entities['orders']).paymentDeadline <= options.dueBefore!);
            }
            return options.limit === undefined ? items : items.slice(0, options.limit);
          },
        };
      };
      const repository: Repository = {
        services: table('services'), pets: table('pets'), addresses: table('addresses'), slots: table('slots'),
        quotes: table('quotes'), orders: table('orders'), reservations: table('reservations'),
        idempotency: table('idempotency'),
        async appendEvent(event) { state.events.push(event); },
        async resourceInUse(userId, kind, id) {
          return [...state.orders.values()].some(order => order.userId === userId && order.status === 'PENDING_PAYMENT'
            && (kind === 'pet' ? order.snapshot.input.petIds.includes(id) : order.snapshot.input.addressId === id));
        },
      };
      return work(repository);
    });
  }

  private async withDraft<Result>(work: (state: BookingState) => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = await work(draft);
      const detached = structuredClone(result);
      this.state = draft;
      return detached;
    } finally {
      release();
    }
  }
}
