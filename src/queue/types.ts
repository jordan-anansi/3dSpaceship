/** A payload the queue has accepted, wrapped in the bookkeeping the queue owns. */
export interface QueuedJob<T> {
  id: string;
  payload: T;
  /** ISO 8601. Also fixes the job's place in the FIFO order. */
  enqueuedAt: string;
  /** Bumped each time a lease on this job expires without an ack. */
  attempts: number;
}

/**
 * Transport-agnostic job queue.
 *
 * Producer (the Discord bot) and consumer (the batching worker) only ever see
 * this interface, so the backend can move from a local directory to Redis or an
 * HTTP endpoint without either side changing.
 *
 * claim/ack is deliberately two-phase: `claim` hides a batch from other workers
 * for `leaseMs`, and the batch only leaves the queue on `ack`. A worker that
 * dies partway through a batch loses its lease and the jobs come back.
 */
export interface JobQueue<T> {
  enqueue(payload: T): Promise<QueuedJob<T>>;
  /** Take up to `limit` jobs and hide them from other workers for `leaseMs`. */
  claim(limit: number, leaseMs: number): Promise<QueuedJob<T>[]>;
  /** Look at the head of the queue without claiming it. For status output. */
  peek(limit: number): Promise<QueuedJob<T>[]>;
  /** Done with these — drop them for good. */
  ack(ids: string[]): Promise<void>;
  /** Hand these back without waiting for the lease to lapse. */
  release(ids: string[]): Promise<void>;
  depth(): Promise<{ pending: number; claimed: number }>;
}
