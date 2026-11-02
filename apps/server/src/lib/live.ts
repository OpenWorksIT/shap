import { EventEmitter } from 'node:events';

/** What open screens hear: something changed (refetch), and who changed it (so they skip their own). */
export interface LiveEvent {
  type: 'changed';
  by: string | null;
  demo: boolean;
  at: number;
}

/**
 * In-process event bus for the live stream (one Shap process per company, so this is enough;
 * if it is ever run as several processes, swap in Postgres LISTEN/NOTIFY behind the same API).
 * From Sorted.
 */
export class LiveBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(500);
  }
  publish(event: LiveEvent): void {
    this.emitter.emit('event', event);
  }
  subscribe(fn: (event: LiveEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
