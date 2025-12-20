/**
 * Database utility for Local Server
 * PostgreSQL connection pool
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { logger } from './logger';

// Create connection pool
// Shared PostgreSQL Setup:
// - In production (Docker): connects to 'postgres' container
// - In dev/test: connects to localhost:17102 (port-forwarded PostgreSQL)
// - Uses 'musical_local' database (separate from 'gitea' database)
const isInsideDocker = process.env.DOCKER_CONTAINER === 'true';
const defaultHost = isInsideDocker ? 'postgres' : 'localhost';
const defaultPort = isInsideDocker ? '5432' : '17102';

const pool = new Pool({
  host: process.env.DB_HOST || defaultHost,
  port: parseInt(process.env.DB_PORT || defaultPort),
  database: process.env.DB_NAME || 'musical_local',
  user: process.env.DB_USER || 'musical',
  password: process.env.DB_PASSWORD || 'musical_secure_pass',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds
});

// Test connection on startup
pool.connect()
  .then((client) => {
    logger.info('✅ Database connected successfully', {
      host: process.env.DB_HOST || defaultHost,
      database: process.env.DB_NAME || 'musical_local',
      sharedPostgreSQL: true,
    });
    client.release();
  })
  .catch((err) => {
    logger.error('❌ Database connection failed', { error: err.message });
  });

// Handle pool errors
pool.on('error', (err) => {
  logger.error('🚨 Database pool error', { error: err.message });
});

/**
 * Execute a database query
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;

    logger.debug('Database query executed', {
      query: text.substring(0, 100),
      duration,
      rows: result.rowCount,
    });

    return result;
  } catch (error) {
    logger.error('Database query failed', {
      query: text.substring(0, 100),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get the pool instance (for advanced usage)
 */
export function getPool(): Pool {
  return pool;
}

/**
 * Close all database connections (for graceful shutdown)
 */
export async function closePool(): Promise<void> {
  logger.info('Closing database connection pool');
  await pool.end();
  logger.info('✅ Database pool closed');
}

export default {
  query,
  pool,
  getPool,
  closePool,
};
