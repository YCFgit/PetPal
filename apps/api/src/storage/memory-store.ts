import { emptyState } from '../domain/models.ts';
import type { BookingState } from '../domain/models.ts';

export interface BookingStore {
  transaction<Result>(work: (state: BookingState) => Result): Promise<Result>;
}

export class MemoryBookingStore implements BookingStore {
  private state: BookingState;
  private tail: Promise<void> = Promise.resolve();

  constructor(seed: BookingState = emptyState()) {
    this.state = structuredClone(seed);
  }

  async transaction<Result>(work: (state: BookingState) => Result): Promise<Result> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = work(draft);
      if (result instanceof Promise) throw new Error('Memory transactions must be synchronous');
      const detached = structuredClone(result);
      this.state = draft;
      return detached;
    } finally {
      release();
    }
  }
}
