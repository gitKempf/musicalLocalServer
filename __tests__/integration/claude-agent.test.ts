/**
 * Claude Agent Integration Tests
 * Tests ClaudeSessionManager integration with claude-agent service
 */

import { ClaudeSessionManager } from '../../src/services/ClaudeSessionManager';
import axios from 'axios';

// Mock axios for testing without real claude-agent
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Claude Agent Integration Tests', () => {
  let sessionManager: ClaudeSessionManager;
  let mockClient: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock axios instance
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
      defaults: {},
      interceptors: {
        request: { use: jest.fn(), eject: jest.fn() },
        response: { use: jest.fn(), eject: jest.fn() },
      },
    };

    mockedAxios.create = jest.fn(() => mockClient);

    sessionManager = new ClaudeSessionManager('http://mock-claude:17110');
  });

  afterEach(() => {
    sessionManager.cleanup();
  });

  describe('Health Check', () => {
    it('should successfully check health', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          status: 'healthy',
          sessions: 0,
          idleMinutes: 5,
          autoShutdownMinutes: 30,
          uptime: 3600,
        },
      });

      const health = await sessionManager.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.sessions).toBe(0);
      expect(mockClient.get).toHaveBeenCalledWith('/health');
    });

    it('should handle health check failure', async () => {
      mockClient.get.mockRejectedValue(new Error('Connection refused'));

      await expect(sessionManager.getHealth()).rejects.toThrow('Connection refused');
    });

    it('should start and stop health check monitoring', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          status: 'healthy',
          sessions: 0,
          idleMinutes: 0,
          autoShutdownMinutes: 30,
          uptime: 10,
        },
      });

      await sessionManager.startHealthCheck(100); // 100ms interval for testing

      // Wait for first health check
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockClient.get).toHaveBeenCalledWith('/health');

      sessionManager.stopHealthCheck();

      const callCount = mockClient.get.mock.calls.length;

      // Wait a bit more and verify no new calls
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockClient.get.mock.calls.length).toBe(callCount);
    });
  });

  describe('Session Management', () => {
    it('should create a new session', async () => {
      const mockSession = {
        id: 'session_123',
        projectId: 'project_1',
        status: 'created',
        createdAt: new Date().toISOString(),
      };

      mockClient.post.mockResolvedValue({
        data: {
          success: true,
          session: mockSession,
        },
      });

      const session = await sessionManager.createSession(
        'session_123',
        'project_1',
        '/app/projects/project_1'
      );

      expect(session.id).toBe('session_123');
      expect(session.projectId).toBe('project_1');
      expect(session.status).toBe('created');
      expect(mockClient.post).toHaveBeenCalledWith('/sessions/create', {
        sessionId: 'session_123',
        projectId: 'project_1',
        workDir: '/app/projects/project_1',
      });
    });

    it('should handle session creation failure', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          success: false,
          error: 'Invalid project ID',
        },
      });

      await expect(
        sessionManager.createSession('session_123', '', '/app/projects')
      ).rejects.toThrow('Invalid project ID');
    });

    it('should get session info', async () => {
      const mockSession = {
        id: 'session_123',
        projectId: 'project_1',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        outputLines: 10,
        errorLines: 0,
      };

      mockClient.get.mockResolvedValue({
        data: {
          success: true,
          session: mockSession,
        },
      });

      const session = await sessionManager.getSession('session_123');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('session_123');
      expect(session?.outputLines).toBe(10);
      expect(mockClient.get).toHaveBeenCalledWith('/sessions/session_123');
    });

    it('should return null for non-existent session', async () => {
      const axiosError = new Error('Not found');
      Object.assign(axiosError, {
        isAxiosError: true,
        response: { status: 404 },
      });

      mockClient.get.mockRejectedValue(axiosError);
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);

      const session = await sessionManager.getSession('nonexistent');

      expect(session).toBeNull();
    });

    it('should list all sessions', async () => {
      const mockSessions = [
        {
          id: 'session_1',
          projectId: 'project_1',
          status: 'active',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        },
        {
          id: 'session_2',
          projectId: 'project_2',
          status: 'completed',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        },
      ];

      mockClient.get.mockResolvedValue({
        data: {
          success: true,
          sessions: mockSessions,
          count: 2,
        },
      });

      const sessions = await sessionManager.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session_1');
      expect(sessions[1].id).toBe('session_2');
      expect(mockClient.get).toHaveBeenCalledWith('/sessions');
    });

    it('should delete a session', async () => {
      mockClient.delete.mockResolvedValue({
        data: {
          success: true,
          message: 'Session deleted',
        },
      });

      const deleted = await sessionManager.deleteSession('session_123');

      expect(deleted).toBe(true);
      expect(mockClient.delete).toHaveBeenCalledWith('/sessions/session_123');
    });

    it('should return false when deleting non-existent session', async () => {
      const axiosError = new Error('Not found');
      Object.assign(axiosError, {
        isAxiosError: true,
        response: { status: 404 },
      });

      mockClient.delete.mockRejectedValue(axiosError);
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);

      const deleted = await sessionManager.deleteSession('nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('Code Generation', () => {
    it('should successfully generate code', async () => {
      const mockResult = {
        success: true,
        sessionId: 'session_123',
        output: 'Code generated successfully!\n\nHere is your React component...',
        error: '',
      };

      mockClient.post.mockResolvedValue({
        data: mockResult,
      });

      const result = await sessionManager.generateCode(
        'session_123',
        'Create a React button component'
      );

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('session_123');
      expect(result.output).toContain('Code generated successfully');
      expect(mockClient.post).toHaveBeenCalledWith(
        '/sessions/session_123/generate',
        {
          prompt: 'Create a React button component',
          options: {},
        },
        { timeout: 300000 }
      );
    });

    it('should handle generation timeout', async () => {
      mockClient.post.mockRejectedValue(new Error('Request timeout'));

      await expect(
        sessionManager.generateCode('session_123', 'Very complex prompt', {
          timeout: 1000,
        })
      ).rejects.toThrow('Request timeout');
    });

    it('should handle generation failure', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          success: false,
          error: 'Claude API key not configured',
        },
      });

      await expect(
        sessionManager.generateCode('session_123', 'Test prompt')
      ).rejects.toThrow('Claude API key not configured');
    });

    it('should support custom timeout for generation', async () => {
      const mockResult = {
        success: true,
        sessionId: 'session_123',
        output: 'Generated code',
      };

      mockClient.post.mockResolvedValue({
        data: mockResult,
      });

      await sessionManager.generateCode(
        'session_123',
        'Test prompt',
        { timeout: 60000 } // 1 minute
      );

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sessions/session_123/generate',
        expect.any(Object),
        { timeout: 60000 }
      );
    });
  });

  describe('Event Emitters', () => {
    it('should emit session-created event', async () => {
      const mockSession = {
        id: 'session_123',
        projectId: 'project_1',
        status: 'created',
        createdAt: new Date().toISOString(),
      };

      mockClient.post.mockResolvedValue({
        data: {
          success: true,
          session: mockSession,
        },
      });

      const eventSpy = jest.fn();
      sessionManager.on('session-created', eventSpy);

      await sessionManager.createSession('session_123', 'project_1');

      expect(eventSpy).toHaveBeenCalledWith(mockSession);
    });

    it('should emit generation-complete event', async () => {
      const mockResult = {
        success: true,
        sessionId: 'session_123',
        output: 'Generated code',
      };

      mockClient.post.mockResolvedValue({
        data: mockResult,
      });

      const eventSpy = jest.fn();
      sessionManager.on('generation-complete', eventSpy);

      await sessionManager.generateCode('session_123', 'Test prompt');

      expect(eventSpy).toHaveBeenCalledWith(mockResult);
    });

    it('should emit session-deleted event', async () => {
      mockClient.delete.mockResolvedValue({
        data: {
          success: true,
        },
      });

      const eventSpy = jest.fn();
      sessionManager.on('session-deleted', eventSpy);

      await sessionManager.deleteSession('session_123');

      expect(eventSpy).toHaveBeenCalledWith('session_123');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      mockClient.post.mockRejectedValue(new Error('Network error'));

      await expect(
        sessionManager.createSession('session_123', 'project_1')
      ).rejects.toThrow('Network error');
    });

    it('should handle malformed responses', async () => {
      mockClient.get.mockResolvedValue({
        data: null,
      });

      await expect(sessionManager.listSessions()).rejects.toThrow();
    });
  });
});
