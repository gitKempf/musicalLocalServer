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
 * Initialize database schema - creates tables if they don't exist
 * This is called on server startup to ensure the database is ready
 */
export async function initializeDatabase(): Promise<void> {
  logger.info('🔧 Initializing database schema...');
  
  try {
    // Create projects table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(50) PRIMARY KEY,
        user_id TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        template VARCHAR(50) DEFAULT 'react-native',
        status VARCHAR(50) DEFAULT 'active',
        initial_prompt TEXT,
        gitea_repo_url VARCHAR(500),
        gitea_repo_id INTEGER,
        container_id VARCHAR(255),
        ssh_port INTEGER,
        tunnel_url VARCHAR(500),
        preview_url VARCHAR(500),
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes for projects
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);`);
    
    // Migration: Add last_activity_at column if it doesn't exist (for existing tables)
    // PostgreSQL 11+ supports ADD COLUMN IF NOT EXISTS
    try {
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
    } catch (err: any) {
      // Column might already exist - ignore duplicate column errors
      if (!err.message?.includes('already exists')) {
        throw err;
      }
    }
    
    // Create sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id VARCHAR(50) REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        session_path TEXT,
        status VARCHAR(50) DEFAULT 'active',
        turn_count INTEGER DEFAULT 0,
        container_id VARCHAR(255),
        ssh_port INTEGER,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes for sessions
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`);
    
    // Migration: Add missing columns to sessions table (for existing tables)
    try {
      await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_id VARCHAR(255);`);
      await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ssh_port INTEGER;`);
    } catch (err: any) {
      if (!err.message?.includes('already exists')) {
        throw err;
      }
    }
    
    // Create messages table (optional, for storing encrypted chat history)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);`);
    
    // Create preview_builds table for tracking webhook-triggered builds
    await pool.query(`
      CREATE TABLE IF NOT EXISTS preview_builds (
        id UUID PRIMARY KEY,
        project_id VARCHAR(50) REFERENCES projects(id) ON DELETE CASCADE,
        commit_hash VARCHAR(64) NOT NULL,
        branch VARCHAR(255) DEFAULT 'main',
        status VARCHAR(50) DEFAULT 'building',
        preview_url VARCHAR(500),
        container_id VARCHAR(255),
        pusher VARCHAR(255),
        commit_message TEXT,
        error TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_preview_builds_project_id ON preview_builds(project_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_preview_builds_status ON preview_builds(status);`);
    
    // Migration: Add preview_container_id and preview_port to projects table
    try {
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_container_id VARCHAR(255);`);
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_port INTEGER;`);
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_url VARCHAR(500);`);
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;`);
    } catch (err: any) {
      if (!err.message?.includes('already exists')) {
        throw err;
      }
    }
    
    logger.info('✅ Database schema initialized successfully');
  } catch (error) {
    logger.error('❌ Failed to initialize database schema', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

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
  initializeDatabase,
};
