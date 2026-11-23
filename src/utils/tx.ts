import mongoose, { ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a MongoDB transaction (needs a replica set: Atlas, or `npm run dev:db` locally).
 * `fn` may be retried on transient errors, so keep side effects inside the session.
 */
export async function withTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
