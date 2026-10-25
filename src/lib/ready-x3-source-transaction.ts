import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

// Every nested store operation must use the connection holding the source
// lock. A second connection cannot acquire that same transaction-scoped lock.
export const readyX3SourceTransactionContext = new AsyncLocalStorage<{
  sourceLockKey: string;
  client: PoolClient;
}>();
