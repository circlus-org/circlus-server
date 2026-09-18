import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResult, QueryResultRow, types as pgTypes } from 'pg';
import { serverLogger } from '../utils/logger';

const logger = serverLogger.child({ subsystem: 'database' });

// Parse BIGINT (int8) as number.
// We store timestamps in ms (Date.now()) which are safely within JS integer range.
pgTypes.setTypeParser(20, (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
});

// PostgreSQL connection pool
const transactionContext = new AsyncLocalStorage<{ client: PoolClient; active: boolean }>();
function contextualClient(): PoolClient | undefined {
  const context = transactionContext.getStore();
  return context?.active ? context.client : undefined;
}

let internalPool: Pool | null = null;
let serverProcessLockClient: PoolClient | null = null;

/**
 * Initialize PostgreSQL connection pool
 */
export function initializeDatabase(databaseUrl: string): Pool {
  if (internalPool) {
    return internalPool;
  }

  internalPool = new Pool({
    connectionString: databaseUrl,
    max: 10, // Maximum connections (sufficient for ~100 users)
    min: 2,  // Keep 2 connections always ready
    idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
    connectionTimeoutMillis: 2000, // Timeout waiting for connection
  });

  internalPool.on('error', (err: Error) => {
    logger.error('database_idle_client_error', { error: err });
  });

  logger.info('database_pool_initialized');

  return internalPool;
}

/**
 * Get database pool
 */
export function getPool(): Pool {
  if (!internalPool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return internalPool;
}

/**
 * Export pool for pgtyped queries
 * This is a proxy object that delegates to the internal pool
 */
export const pool = {
  query: (...args: Parameters<Pool['query']>) => (contextualClient() || getPool()).query(...args),
  connect: () => getPool().connect(),
  end: () => getPool().end(),
  on: (...args: Parameters<Pool['on']>) => getPool().on(...args)
} as Pool;

/**
 * Acquire a database-scoped process lock for the API server.
 *
 * Rate limiting and connected-client state are process-local. Holding this
 * PostgreSQL advisory lock prevents accidentally running two API server
 * processes against the same database. The lock is released automatically when
 * this dedicated client connection closes.
 */
export async function acquireServerProcessLock(): Promise<void> {
  if (serverProcessLockClient) return;

  const client = await getPool().connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
      ['circlus-family-server', 'single-active-process']
    );
    if (result.rows[0]?.locked !== true) {
      throw new Error(
        'Another Circlus server process is already running against this database. ' +
        'Run only one active server process per deployment.'
      );
    }
    serverProcessLockClient = client;
    logger.info('database_process_lock_acquired');
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function releaseServerProcessLock(): Promise<void> {
  if (!serverProcessLockClient) return;
  const client = serverProcessLockClient;
  serverProcessLockClient = null;
  try {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
      ['circlus-family-server', 'single-active-process']
    );
  } catch (error) {
    logger.warn('database_process_lock_release_failed', { error });
  } finally {
    client.release();
  }
}

/**
 * Execute query
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return (contextualClient() || getPool()).query<T>(text, params);
}

/**
 * Get client for transaction
 */
export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

/**
 * Execute function in transaction
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const inherited = contextualClient();
  if (inherited) return callback(inherited);
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (internalPool) {
    await releaseServerProcessLock();
    await internalPool.end();
    internalPool = null;
    logger.info('database_pool_closed');
  }
}

/** Route/service scope: all query()/pool.query calls use this transaction. */
export async function inTransactionContext<T>(client: PoolClient, callback: () => Promise<T>): Promise<T> {
  const context = { client, active: true };
  try {
    return await transactionContext.run(context, callback);
  } finally {
    // Detached tasks inherit AsyncLocalStorage too; never let them reuse a released client.
    context.active = false;
  }
}
