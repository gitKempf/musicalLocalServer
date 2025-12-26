/**
 * Tunnel Integration Tests
 * Tests CloudflaredService and TunnelRegistrationService integration
 */

import axios from 'axios';
import { TunnelRegistrationService } from '../../src/services/TunnelRegistrationService';
import { CloudflaredService } from '../../src/services/CloudflaredService';

// Mock dependencies
jest.mock('axios');
jest.mock('child_process');
jest.mock('../../src/lib/EncryptionService', () => ({
  encryptionService: {
    getPublicKey: jest.fn().mockReturnValue('mock_public_key_base64'),
    initialize: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Tunnel Integration Tests', () => {
  let tunnelService: TunnelRegistrationService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock axios instance
    const mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
    } as any;

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);

    tunnelService = new TunnelRegistrationService({
      tunnelRouterUrl: 'http://localhost:17200',
      userId: 'test_user',
      serverType: 'local',
      heartbeatIntervalMs: 1000, // 1 second for testing
      serverName: 'Test Server',
    });
  });

  afterEach(() => {
    tunnelService.cleanup();
  });

  describe('TunnelRegistrationService', () => {
    it('should register tunnel successfully', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      await tunnelService.register('https://test.trycloudflare.com');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/tunnel/register',
        expect.objectContaining({
          userId: 'test_user',
          tunnelUrl: 'https://test.trycloudflare.com',
          serverType: 'local',
        })
      );

      expect(tunnelService.isRegistered()).toBe(true);
      expect(tunnelService.getTunnelUrl()).toBe('https://test.trycloudflare.com');
    });

    it('should unregister tunnel successfully', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      // Register first
      await tunnelService.register('https://test.trycloudflare.com');

      // Then unregister
      await tunnelService.unregister();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/tunnel/unregister',
        expect.objectContaining({
          userId: 'test_user',
          serverId: expect.stringContaining('server_')
        })
      );

      expect(tunnelService.isRegistered()).toBe(false);
      expect(tunnelService.getTunnelUrl()).toBe(null);
    });

    it('should send heartbeat after registration', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      await tunnelService.register('https://test.trycloudflare.com');

      // Wait for heartbeat (1 second interval)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should have called: register + at least 1 heartbeat
      expect(mockAxiosInstance.post.mock.calls.length).toBeGreaterThanOrEqual(2);

      const heartbeatCall = mockAxiosInstance.post.mock.calls.find(
        (call: any) => call[0] === '/api/tunnel/heartbeat'
      );

      expect(heartbeatCall).toBeDefined();
      expect(heartbeatCall[1]).toMatchObject({ 
        userId: 'test_user',
        serverName: 'Test Server',
        serverId: expect.stringContaining('server_'),
      });
    });

    it('should get tunnel status', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          success: true,
          connected: true,
          serverType: 'local',
          lastSeenAgo: 10,
        },
      });

      const status = await tunnelService.getStatus();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/tunnel\/status\/test_user/)
      );
      expect(status.connected).toBe(true);
    });

    it('should handle registration errors', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockRejectedValue(new Error('Network error'));

      await expect(
        tunnelService.register('https://test.trycloudflare.com')
      ).rejects.toThrow('Network error');

      expect(tunnelService.isRegistered()).toBe(false);
    });

    it('should cleanup resources', async () => {
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      await tunnelService.register('https://test.trycloudflare.com');

      // Cleanup should stop heartbeat
      tunnelService.cleanup();

      const callsBefore = mockAxiosInstance.post.mock.calls.length;

      // Wait 1.5 seconds - no new heartbeat should be sent
      await new Promise(resolve => setTimeout(resolve, 1500));

      const callsAfter = mockAxiosInstance.post.mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });

    it('should send serverName in heartbeat when configured', async () => {
      const customTunnelService = new TunnelRegistrationService({
        tunnelRouterUrl: 'http://localhost:17200',
        userId: 'test_user',
        serverType: 'local',
        heartbeatIntervalMs: 1000,
        serverName: 'Custom Server Name',
      });

      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      await customTunnelService.register('https://test.trycloudflare.com');

      // Wait for at least one heartbeat
      await new Promise(resolve => setTimeout(resolve, 1200));

      const heartbeatCalls = mockAxiosInstance.post.mock.calls.filter(
        (call: any) => call[0] === '/api/tunnel/heartbeat'
      );

      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
      expect(heartbeatCalls[0][1]).toMatchObject({
        userId: 'test_user',
        serverName: 'Custom Server Name',
      });

      customTunnelService.cleanup();
    });

    it('should not send serverName if not configured', async () => {
      const noNameTunnelService = new TunnelRegistrationService({
        tunnelRouterUrl: 'http://localhost:17200',
        userId: 'test_user_2',
        serverType: 'local',
        heartbeatIntervalMs: 1000,
      });

      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      await noNameTunnelService.register('https://test2.trycloudflare.com');

      // Wait for at least one heartbeat
      await new Promise(resolve => setTimeout(resolve, 1200));

      const heartbeatCalls = mockAxiosInstance.post.mock.calls.filter(
        (call: any) => call[0] === '/api/tunnel/heartbeat'
      );

      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
      expect(heartbeatCalls[0][1].serverName).toBeUndefined();

      noNameTunnelService.cleanup();
    });
  });

  describe('CloudflaredService', () => {
    it('should have required methods', () => {
      const cloudflared = new CloudflaredService({
        localPort: 17100,
      });

      expect(cloudflared.start).toBeDefined();
      expect(cloudflared.stop).toBeDefined();
      expect(cloudflared.getTunnelUrl).toBeDefined();
      expect(cloudflared.isReady).toBeDefined();
      expect(cloudflared.isRunning).toBeDefined();
      expect(cloudflared.cleanup).toBeDefined();
    });

    it('should initialize with correct config', () => {
      const cloudflared = new CloudflaredService({
        localPort: 17100,
        protocol: 'https',
      });

      expect(cloudflared).toBeDefined();
      expect(cloudflared.isReady()).toBe(false);
      expect(cloudflared.isRunning()).toBe(false);
    });

    it('should cleanup resources', () => {
      const cloudflared = new CloudflaredService({
        localPort: 17100,
      });

      expect(() => cloudflared.cleanup()).not.toThrow();
      expect(cloudflared.isRunning()).toBe(false);
    });
  });

  describe('Integration: Cloudflared + TunnelRegistration', () => {
    it('should have complete tunnel flow', async () => {
      // This test verifies the integration pattern used in server.ts
      const mockAxiosInstance = mockedAxios.create() as any;
      mockAxiosInstance.post.mockResolvedValue({
        data: { success: true },
      });

      const cloudflared = new CloudflaredService({ localPort: 17100 });
      const tunnelReg = new TunnelRegistrationService({
        tunnelRouterUrl: 'http://localhost:17200',
        userId: 'test_user',
        serverType: 'local',
      });

      // In real scenario:
      // 1. Start cloudflared -> get tunnel URL
      // 2. Register tunnel URL with router
      // 3. Heartbeat keeps connection alive
      // 4. On shutdown: unregister, stop cloudflared

      // For this test, we simulate the flow
      const mockTunnelUrl = 'https://abc123.trycloudflare.com';

      // Step 2: Register (simulated - cloudflared.start() is mocked in real env)
      await tunnelReg.register(mockTunnelUrl);

      expect(tunnelReg.isRegistered()).toBe(true);
      expect(tunnelReg.getTunnelUrl()).toBe(mockTunnelUrl);

      // Step 4: Cleanup
      await tunnelReg.unregister();
      cloudflared.cleanup();

      expect(tunnelReg.isRegistered()).toBe(false);
    });
  });
});
