import path from 'path';
import { FileQueue } from './file-queue';
import { JobQueue } from './types';

export * from './types';
export { FileQueue } from './file-queue';

/**
 * Picks the queue backend from the environment.
 *
 * Only the on-disk backend exists today. A worker running somewhere else needs
 * a networked one (Redis, SQS, or an HTTP shim over JobQueue) — add the case
 * here and neither the bot nor the worker changes.
 */
export function createQueue<T>(env = process.env): JobQueue<T> {
  const backend = env.QUEUE_BACKEND ?? 'file';
  switch (backend) {
    case 'file':
      return new FileQueue<T>(env.QUEUE_DIR ?? path.join(process.cwd(), '.queue'));
    default:
      throw new Error(`Unknown QUEUE_BACKEND "${backend}" (supported: file)`);
  }
}
