/**
 * Port Registry Service
 * 
 * Centralized, database-backed port allocation for container management.
 * Solves:
 * - Port conflicts between containers
 * - State persistence across server restarts  
 * - Race conditions in concurrent allocations
 * - Port exhaustion and reuse
 * 
 * Architecture:
 * - Port allocations stored in PostgreSQL with advisory locks
 * - Ranges: 30000-30999 (project containers), 31000-31999 (preview containers)
 * - Automatic cleanup of orphaned allocations
 * - Internal Docker network communication (no host ports needed for inter-container)
 * 
 * Scalability: Designed to handle 10,000+ concurrent containers
 */

import { query } from '../lib/database';
import { logger } from '../lib/logger';
import Docker from 'dockerode';
import * as net from 'net';

export interface PortAllocation {
  id: number;
  port: number;
  port_type: 'project_dev' | 'project_preview' | 'preview_container' | 'preview_secondary';
  project_id: string;
  container_id: string | null;
  status: 'allocated' | 'in_use' | 'released';
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

export interface AllocatePortOptions {
  projectId: string;
  portType: PortAllocation['port_type'];
  containerId?: string;
  ttlMinutes?: number; // Optional TTL for auto-expiration
}

export interface PortRange {
  start: number;
  end: number;
}

// Port range configuration
const PORT_RANGES: Record<string, PortRange> = {
  project_dev: { start: 30000, end: 30499 },      // 500 ports for project dev servers
  project_preview: { start: 30500, end: 30999 }, // 500 ports for project preview
  preview_container: { start: 31000, end: 32999 }, // 2000 ports for preview containers
  preview_secondary: { start: 33000, end: 33999 }, // 1000 ports for secondary services
};

export class PortRegistry {
  private docker: Docker;
  private initialized: boolean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Initialize the port registry - creates table and syncs with Docker state
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('🔌 Initializing Port Registry...');

    try {
      // Create port allocations table if not exists
      await this.createSchema();

      // Sync with actual Docker state
      await this.syncWithDocker();

      // Start periodic cleanup
      this.startCleanupTimer();

      this.initialized = true;
      logger.info('✅ Port Registry initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize Port Registry', { error });
      throw error;
    }
  }

  /**
   * Create database schema for port allocations
   */
  private async createSchema(): Promise<void> {
    await query(`
      CREATE TABLE IF NOT EXISTS port_allocations (
        id SERIAL PRIMARY KEY,
        port INTEGER NOT NULL UNIQUE,
        port_type VARCHAR(50) NOT NULL,
        project_id VARCHAR(50) NOT NULL,
        container_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'allocated',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_port_allocations_port ON port_allocations(port);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_port_allocations_project ON port_allocations(project_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_port_allocations_container ON port_allocations(container_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_port_allocations_status ON port_allocations(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_port_allocations_type ON port_allocations(port_type);`);

    logger.debug('Port allocations schema created');
  }

  /**
   * Sync database with actual Docker container state
   * Removes allocations for containers that no longer exist
   */
  async syncWithDocker(): Promise<void> {
    logger.info('🔄 Syncing port registry with Docker...');

    try {
      // Get all containers from Docker
      const containers = await this.docker.listContainers({ all: true });
      const containerIds = new Set<string>();

      for (const container of containers) {
        containerIds.add(container.Id);
        // Also track by name (our container_id is often the name)
        for (const name of container.Names) {
          containerIds.add(name.replace(/^\//, ''));
        }
      }

      // Get all allocations from database
      const result = await query<PortAllocation>(
        `SELECT * FROM port_allocations WHERE status IN ('allocated', 'in_use')`
      );

      let orphanedCount = 0;
      let activeCount = 0;

      for (const allocation of result.rows) {
        if (allocation.container_id) {
          // Check if container exists
          const containerExists = containerIds.has(allocation.container_id) ||
            containers.some(c => 
              c.Names.some(n => n.includes(allocation.container_id!))
            );

          if (!containerExists) {
            // Container no longer exists - release the port
            await this.releasePort(allocation.port);
            orphanedCount++;
          } else {
            activeCount++;
          }
        }
      }

      // Also scan Docker for ports that aren't in our registry
      for (const container of containers) {
        if (container.State !== 'running') continue;
        
        for (const portMapping of container.Ports || []) {
          if (portMapping.PublicPort && portMapping.PublicPort >= 30000 && portMapping.PublicPort < 34000) {
            // Check if this port is in our registry
            const exists = result.rows.some(a => a.port === portMapping.PublicPort);
            if (!exists) {
              // Port is in use by Docker but not in registry - add it
              const containerName = container.Names[0]?.replace(/^\//, '') || container.Id;
              const projectMatch = containerName.match(/(?:project-|preview-)(project_\d+)/);
              const projectId = projectMatch ? projectMatch[1] : 'unknown';
              
              await this.registerExistingPort(
                portMapping.PublicPort,
                projectId,
                containerName
              );
              logger.info('📌 Registered untracked port from Docker', {
                port: portMapping.PublicPort,
                container: containerName,
              });
            }
          }
        }
      }

      logger.info('✅ Port registry sync complete', {
        activeAllocations: activeCount,
        orphanedReleased: orphanedCount,
      });
    } catch (error) {
      logger.error('❌ Failed to sync port registry', { error });
      throw error;
    }
  }

  /**
   * Register an existing port that was found in Docker but not in registry
   */
  private async registerExistingPort(
    port: number,
    projectId: string,
    containerId: string
  ): Promise<void> {
    const portType = this.getPortTypeFromRange(port);
    
    await query(
      `INSERT INTO port_allocations (port, port_type, project_id, container_id, status)
       VALUES ($1, $2, $3, $4, 'in_use')
       ON CONFLICT (port) DO UPDATE SET
         container_id = EXCLUDED.container_id,
         status = 'in_use',
         updated_at = CURRENT_TIMESTAMP`,
      [port, portType, projectId, containerId]
    );
  }

  /**
   * Determine port type from port number
   */
  private getPortTypeFromRange(port: number): PortAllocation['port_type'] {
    for (const [type, range] of Object.entries(PORT_RANGES)) {
      if (port >= range.start && port <= range.end) {
        return type as PortAllocation['port_type'];
      }
    }
    return 'preview_container'; // Default
  }

  /**
   * Allocate a port for a project/container
   * Uses database advisory lock to prevent race conditions
   */
  async allocatePort(options: AllocatePortOptions): Promise<number> {
    const { projectId, portType, containerId, ttlMinutes } = options;
    const range = PORT_RANGES[portType];

    if (!range) {
      throw new Error(`Unknown port type: ${portType}`);
    }

    logger.debug('Allocating port', { projectId, portType, range });

    // Use advisory lock to prevent race conditions
    // Lock ID is based on port type to allow parallel allocations across different types
    const lockId = this.getLockId(portType);

    try {
      // Acquire advisory lock
      await query(`SELECT pg_advisory_lock($1)`, [lockId]);

      // First, try to reuse a released port for the same project
      const reuseResult = await query<{ port: number }>(
        `UPDATE port_allocations 
         SET status = 'allocated', 
             container_id = $3,
             updated_at = CURRENT_TIMESTAMP,
             expires_at = $4
         WHERE port_type = $1 
           AND project_id = $2 
           AND status = 'released'
         RETURNING port`,
        [portType, projectId, containerId || null, ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000) : null]
      );

      if (reuseResult.rows.length > 0) {
        const port = reuseResult.rows[0].port;
        logger.info('♻️  Reusing released port', { port, projectId, portType });
        return port;
      }

      // Find the next available port in range
      const port = await this.findAvailablePort(range, portType);

      // Insert the allocation
      const expiresAt = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000) : null;
      
      await query(
        `INSERT INTO port_allocations (port, port_type, project_id, container_id, status, expires_at)
         VALUES ($1, $2, $3, $4, 'allocated', $5)
         ON CONFLICT (port) DO UPDATE SET
           project_id = EXCLUDED.project_id,
           container_id = EXCLUDED.container_id,
           status = 'allocated',
           updated_at = CURRENT_TIMESTAMP,
           expires_at = EXCLUDED.expires_at`,
        [port, portType, projectId, containerId || null, expiresAt]
      );

      logger.info('🔌 Port allocated', { port, projectId, portType });
      return port;

    } finally {
      // Release advisory lock
      await query(`SELECT pg_advisory_unlock($1)`, [lockId]);
    }
  }

  /**
   * Find the next available port in a range
   */
  private async findAvailablePort(range: PortRange, portType: string): Promise<number> {
    // Get all allocated ports in this range
    const result = await query<{ port: number }>(
      `SELECT port FROM port_allocations 
       WHERE port >= $1 AND port <= $2 
         AND status IN ('allocated', 'in_use')
       ORDER BY port`,
      [range.start, range.end]
    );

    const allocatedPorts = new Set(result.rows.map(r => r.port));

    // Find first available port
    for (let port = range.start; port <= range.end; port++) {
      if (!allocatedPorts.has(port)) {
        // Double-check that port is actually available on host
        const available = await this.isPortAvailable(port);
        if (available) {
          return port;
        } else {
          // Port is in use but not in our registry - mark it
          logger.warn('Port in use externally, skipping', { port });
        }
      }
    }

    throw new Error(`No available ports in range ${range.start}-${range.end} for ${portType}`);
  }

  /**
   * Check if a port is available on the host
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.listen(port, () => {
        server.once('close', () => resolve(true));
        server.close();
      });

      server.on('error', () => resolve(false));
    });
  }

  /**
   * Generate advisory lock ID from port type
   */
  private getLockId(portType: string): number {
    // Simple hash to generate consistent lock ID
    let hash = 0;
    for (let i = 0; i < portType.length; i++) {
      hash = ((hash << 5) - hash) + portType.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 1000000 + 1000000; // Ensure positive and in a safe range
  }

  /**
   * Mark a port as in use (container started)
   */
  async markPortInUse(port: number, containerId: string): Promise<void> {
    await query(
      `UPDATE port_allocations 
       SET status = 'in_use', 
           container_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE port = $1`,
      [port, containerId]
    );
    logger.debug('Port marked in use', { port, containerId });
  }

  /**
   * Release a port (container stopped/removed)
   */
  async releasePort(port: number): Promise<void> {
    await query(
      `UPDATE port_allocations 
       SET status = 'released', 
           updated_at = CURRENT_TIMESTAMP,
           expires_at = NULL
       WHERE port = $1`,
      [port]
    );
    logger.debug('Port released', { port });
  }

  /**
   * Release all ports for a project
   */
  async releaseProjectPorts(projectId: string): Promise<number> {
    const result = await query(
      `UPDATE port_allocations 
       SET status = 'released', 
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = $1 AND status IN ('allocated', 'in_use')
       RETURNING port`,
      [projectId]
    );
    
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info('Released project ports', { projectId, count });
    }
    return count;
  }

  /**
   * Get all ports for a project
   */
  async getProjectPorts(projectId: string): Promise<PortAllocation[]> {
    const result = await query<PortAllocation>(
      `SELECT * FROM port_allocations WHERE project_id = $1`,
      [projectId]
    );
    return result.rows;
  }

  /**
   * Get port allocation statistics
   */
  async getStats(): Promise<{
    total: number;
    allocated: number;
    inUse: number;
    released: number;
    byType: Record<string, number>;
  }> {
    const result = await query<{ status: string; port_type: string; count: string }>(
      `SELECT status, port_type, COUNT(*) as count 
       FROM port_allocations 
       GROUP BY status, port_type`
    );

    const stats = {
      total: 0,
      allocated: 0,
      inUse: 0,
      released: 0,
      byType: {} as Record<string, number>,
    };

    for (const row of result.rows) {
      const count = parseInt(row.count);
      stats.total += count;

      if (row.status === 'allocated') stats.allocated += count;
      if (row.status === 'in_use') stats.inUse += count;
      if (row.status === 'released') stats.released += count;

      if (!stats.byType[row.port_type]) stats.byType[row.port_type] = 0;
      stats.byType[row.port_type] += count;
    }

    return stats;
  }

  /**
   * Start periodic cleanup of stale allocations
   */
  private startCleanupTimer(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupStaleAllocations();
    }, 5 * 60 * 1000);

    // Also run once immediately
    this.cleanupStaleAllocations();
  }

  /**
   * Clean up expired and orphaned allocations
   */
  async cleanupStaleAllocations(): Promise<void> {
    try {
      // Release expired allocations
      const expiredResult = await query(
        `UPDATE port_allocations 
         SET status = 'released'
         WHERE expires_at < CURRENT_TIMESTAMP 
           AND status IN ('allocated', 'in_use')
         RETURNING port`,
        []
      );

      if (expiredResult.rowCount && expiredResult.rowCount > 0) {
        logger.info('🧹 Released expired port allocations', {
          count: expiredResult.rowCount,
        });
      }

      // Delete very old released allocations (older than 7 days)
      const deleteResult = await query(
        `DELETE FROM port_allocations 
         WHERE status = 'released' 
           AND updated_at < CURRENT_TIMESTAMP - INTERVAL '7 days'
         RETURNING port`,
        []
      );

      if (deleteResult.rowCount && deleteResult.rowCount > 0) {
        logger.debug('Deleted old released allocations', {
          count: deleteResult.rowCount,
        });
      }
    } catch (error) {
      logger.warn('Cleanup of stale allocations failed', { error });
    }
  }

  /**
   * Shutdown the port registry
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
let portRegistryInstance: PortRegistry | null = null;

/**
 * Get the singleton port registry instance
 */
export function getPortRegistry(): PortRegistry {
  if (!portRegistryInstance) {
    portRegistryInstance = new PortRegistry();
  }
  return portRegistryInstance;
}

/**
 * Initialize the port registry (call on server startup)
 */
export async function initializePortRegistry(): Promise<PortRegistry> {
  const registry = getPortRegistry();
  await registry.initialize();
  return registry;
}
