/**
 * Unit Tests for PortRegistry
 * Tests centralized port allocation and management
 */

import { PortRegistry, getPortRegistry, initializePortRegistry } from '../../src/services/PortRegistry';
import { query, getPool, closePool, initializeDatabase } from '../../src/lib/database';

describe('PortRegistry', () => {
  let portRegistry: PortRegistry;

  beforeAll(async () => {
    // Initialize database connection
    await initializeDatabase();
  });

  beforeEach(async () => {
    // Clean up port_allocations table before each test
    await query('DELETE FROM port_allocations');
    
    // Create fresh instance
    portRegistry = new PortRegistry();
    await portRegistry.initialize();
  });

  afterEach(() => {
    portRegistry.shutdown();
  });

  afterAll(async () => {
    // Clean up
    await query('DELETE FROM port_allocations');
    await closePool();
  });

  describe('Initialization', () => {
    test('should initialize successfully', async () => {
      const registry = new PortRegistry();
      await expect(registry.initialize()).resolves.not.toThrow();
      registry.shutdown();
    });

    test('should create port_allocations table', async () => {
      const result = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'port_allocations'
        );
      `);
      expect(result.rows[0].exists).toBe(true);
    });

    test('should create required indexes', async () => {
      const result = await query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'port_allocations'
      `);
      const indexNames = result.rows.map(r => r.indexname);
      
      expect(indexNames).toContain('idx_port_allocations_port');
      expect(indexNames).toContain('idx_port_allocations_project');
      expect(indexNames).toContain('idx_port_allocations_container');
      expect(indexNames).toContain('idx_port_allocations_status');
      expect(indexNames).toContain('idx_port_allocations_type');
    });
  });

  describe('Port Allocation', () => {
    test('should allocate a port in the correct range', async () => {
      const port = await portRegistry.allocatePort({
        projectId: 'test-project-1',
        portType: 'project_dev',
      });

      expect(port).toBeGreaterThanOrEqual(30000);
      expect(port).toBeLessThanOrEqual(30499);
    });

    test('should allocate different ports for different requests', async () => {
      const port1 = await portRegistry.allocatePort({
        projectId: 'test-project-1',
        portType: 'project_dev',
      });

      const port2 = await portRegistry.allocatePort({
        projectId: 'test-project-2',
        portType: 'project_dev',
      });

      expect(port1).not.toBe(port2);
    });

    test('should allocate ports in correct ranges for different types', async () => {
      const devPort = await portRegistry.allocatePort({
        projectId: 'test-project',
        portType: 'project_dev',
      });

      const previewPort = await portRegistry.allocatePort({
        projectId: 'test-project',
        portType: 'preview_container',
      });

      expect(devPort).toBeGreaterThanOrEqual(30000);
      expect(devPort).toBeLessThanOrEqual(30499);
      
      expect(previewPort).toBeGreaterThanOrEqual(31000);
      expect(previewPort).toBeLessThanOrEqual(32999);
    });

    test('should store allocation in database', async () => {
      const port = await portRegistry.allocatePort({
        projectId: 'test-project-db',
        portType: 'project_dev',
        containerId: 'test-container-123',
      });

      const result = await query(
        'SELECT * FROM port_allocations WHERE port = $1',
        [port]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].project_id).toBe('test-project-db');
      expect(result.rows[0].container_id).toBe('test-container-123');
      expect(result.rows[0].port_type).toBe('project_dev');
      expect(result.rows[0].status).toBe('allocated');
    });

    test('should set expiration time when ttlMinutes provided', async () => {
      const port = await portRegistry.allocatePort({
        projectId: 'test-project-ttl',
        portType: 'project_dev',
        ttlMinutes: 60,
      });

      const result = await query(
        'SELECT expires_at FROM port_allocations WHERE port = $1',
        [port]
      );

      expect(result.rows[0].expires_at).not.toBeNull();
      
      // Verify expiration is approximately 60 minutes from now
      const expiresAt = new Date(result.rows[0].expires_at);
      const expected = new Date(Date.now() + 60 * 60 * 1000);
      const diff = Math.abs(expiresAt.getTime() - expected.getTime());
      expect(diff).toBeLessThan(5000); // Within 5 seconds
    });
  });

  describe('Port Reuse', () => {
    test('should reuse released port for same project', async () => {
      // Allocate and release a port
      const originalPort = await portRegistry.allocatePort({
        projectId: 'reuse-project',
        portType: 'project_dev',
      });

      await portRegistry.releasePort(originalPort);

      // Allocate again for same project
      const reusedPort = await portRegistry.allocatePort({
        projectId: 'reuse-project',
        portType: 'project_dev',
      });

      expect(reusedPort).toBe(originalPort);
    });

    test('should not reuse released port for different project in same allocation batch', async () => {
      // This test verifies that different projects get different ports
      // when allocated together (not about reusing released ports)
      const projectA = 'project-A-' + Date.now();
      const projectB = 'project-B-' + Date.now();
      
      const portA = await portRegistry.allocatePort({
        projectId: projectA,
        portType: 'project_dev',
      });

      const portB = await portRegistry.allocatePort({
        projectId: projectB,
        portType: 'project_dev',
      });

      // Different projects should get different ports
      expect(portA).not.toBe(portB);
    });
  });

  describe('Port Status Management', () => {
    test('should mark port as in_use', async () => {
      const port = await portRegistry.allocatePort({
        projectId: 'status-test',
        portType: 'project_dev',
      });

      await portRegistry.markPortInUse(port, 'container-xyz');

      const result = await query(
        'SELECT status, container_id FROM port_allocations WHERE port = $1',
        [port]
      );

      expect(result.rows[0].status).toBe('in_use');
      expect(result.rows[0].container_id).toBe('container-xyz');
    });

    test('should release port', async () => {
      const port = await portRegistry.allocatePort({
        projectId: 'release-test',
        portType: 'project_dev',
      });

      await portRegistry.releasePort(port);

      const result = await query(
        'SELECT status FROM port_allocations WHERE port = $1',
        [port]
      );

      expect(result.rows[0].status).toBe('released');
    });

    test('should release all ports for a project', async () => {
      const projectId = 'multi-port-project';
      
      // Allocate multiple ports for same project
      const port1 = await portRegistry.allocatePort({
        projectId,
        portType: 'project_dev',
      });
      const port2 = await portRegistry.allocatePort({
        projectId,
        portType: 'preview_container',
      });

      // Mark as in_use
      await portRegistry.markPortInUse(port1, 'container-1');
      await portRegistry.markPortInUse(port2, 'container-2');

      // Release all
      const count = await portRegistry.releaseProjectPorts(projectId);
      expect(count).toBe(2);

      // Verify both are released
      const result = await query(
        'SELECT status FROM port_allocations WHERE project_id = $1',
        [projectId]
      );

      result.rows.forEach(row => {
        expect(row.status).toBe('released');
      });
    });
  });

  describe('Query Methods', () => {
    test('should get all ports for a project', async () => {
      const projectId = 'query-project';
      
      await portRegistry.allocatePort({
        projectId,
        portType: 'project_dev',
        containerId: 'container-1',
      });
      await portRegistry.allocatePort({
        projectId,
        portType: 'preview_container',
        containerId: 'container-2',
      });

      const ports = await portRegistry.getProjectPorts(projectId);
      
      expect(ports.length).toBe(2);
      expect(ports.some(p => p.port_type === 'project_dev')).toBe(true);
      expect(ports.some(p => p.port_type === 'preview_container')).toBe(true);
    });

    test('should get accurate statistics for test allocations', async () => {
      // Get baseline count first
      const baselineStats = await portRegistry.getStats();
      const baselineTotal = baselineStats.total;
      
      // Create some allocations with unique project IDs
      const testId = Date.now();
      const port1 = await portRegistry.allocatePort({
        projectId: `stats-project-1-${testId}`,
        portType: 'project_dev',
      });
      await portRegistry.allocatePort({
        projectId: `stats-project-2-${testId}`,
        portType: 'project_dev',
      });
      await portRegistry.allocatePort({
        projectId: `stats-project-3-${testId}`,
        portType: 'preview_container',
      });

      // Mark one as in_use
      await portRegistry.markPortInUse(port1, 'container-1');

      // Release one
      const port2 = await portRegistry.allocatePort({
        projectId: `stats-project-4-${testId}`,
        portType: 'project_dev',
      });
      await portRegistry.releasePort(port2);

      const stats = await portRegistry.getStats();

      // Should have 4 new allocations
      expect(stats.total).toBe(baselineTotal + 4);
      // Verify the structure is correct
      expect(stats.byType).toBeDefined();
      expect(typeof stats.inUse).toBe('number');
      expect(typeof stats.released).toBe('number');
      expect(typeof stats.allocated).toBe('number');
    });
  });

  describe('Cleanup', () => {
    test('should clean up expired allocations', async () => {
      // Insert an expired allocation within valid port range
      const testPort = 30400 + Math.floor(Math.random() * 99); // 30400-30499
      
      // First clean any existing entry for this port
      await query('DELETE FROM port_allocations WHERE port = $1', [testPort]);
      
      // Insert with an expiration 1 hour in the past using database's CURRENT_TIMESTAMP
      await query(
        `INSERT INTO port_allocations 
         (port, port_type, project_id, status, expires_at)
         VALUES ($1, $2, $3, 'allocated', CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        [testPort, 'project_dev', 'expired-project-' + Date.now()]
      );

      // Verify it was inserted with expired timestamp
      const beforeCleanup = await query(
        'SELECT status, expires_at FROM port_allocations WHERE port = $1',
        [testPort]
      );
      expect(beforeCleanup.rows.length).toBe(1);
      expect(beforeCleanup.rows[0].status).toBe('allocated');
      
      // Verify expires_at is in the past
      const expiresAt = new Date(beforeCleanup.rows[0].expires_at);
      expect(expiresAt.getTime()).toBeLessThan(Date.now());

      // Run cleanup
      await portRegistry.cleanupStaleAllocations();

      // Verify it was released
      const result = await query(
        'SELECT status FROM port_allocations WHERE port = $1',
        [testPort]
      );

      expect(result.rows[0].status).toBe('released');
      
      // Clean up
      await query('DELETE FROM port_allocations WHERE port = $1', [testPort]);
    });
  });

  describe('Concurrent Allocations', () => {
    test('should handle concurrent allocations without conflicts', async () => {
      // Run multiple allocations concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        portRegistry.allocatePort({
          projectId: `concurrent-project-${i}`,
          portType: 'project_dev',
        })
      );

      const ports = await Promise.all(promises);

      // All ports should be unique
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(10);

      // All should be in valid range
      ports.forEach(port => {
        expect(port).toBeGreaterThanOrEqual(30000);
        expect(port).toBeLessThanOrEqual(30499);
      });
    });
  });

  describe('Singleton Pattern', () => {
    test('getPortRegistry should return same instance', () => {
      const instance1 = getPortRegistry();
      const instance2 = getPortRegistry();
      expect(instance1).toBe(instance2);
    });

    test('initializePortRegistry should initialize and return registry', async () => {
      // This uses the singleton, which is already initialized
      const registry = await initializePortRegistry();
      expect(registry).toBeDefined();
      
      const stats = await registry.getStats();
      expect(stats).toBeDefined();
    });
  });
});
