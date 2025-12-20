/**
 * Claude Session Manager
 * Manages communication with Claude Agent container
 * Handles session lifecycle and code generation requests
 */

import axios, { AxiosInstance } from 'axios';
import EventEmitter from 'events';
import { logger } from '../lib/logger';

export interface ClaudeSession {
  id: string;
  projectId: string;
  status: 'created' | 'generating' | 'completed' | 'failed' | 'error';
  createdAt: Date;
  lastActivity: Date;
  outputLines?: number;
  errorLines?: number;
}

export interface GenerationOptions {
  timeout?: number;
  stream?: boolean;
}

export interface GenerationResult {
  success: boolean;
  sessionId: string;
  output: string;
  error?: string;
}

/**
 * ClaudeSessionManager
 * Manages Claude Code CLI sessions via claude-agent container
 */
export class ClaudeSessionManager extends EventEmitter {
  private client: AxiosInstance;
  private agentUrl: string;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(agentUrl: string = 'http://claude-agent:17110') {
    super();
    this.agentUrl = agentUrl;

    this.client = axios.create({
      baseURL: agentUrl,
      timeout: 300000, // 5 minutes default timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });

    logger.info('🤖 ClaudeSessionManager initialized', { agentUrl });
  }

  /**
   * Start health check monitoring
   */
  async startHealthCheck(intervalMs: number = 30000): Promise<void> {
    logger.info('🏥 Starting Claude agent health check', { intervalMs });

    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.getHealth();
        logger.debug('Claude agent health check', health);
        this.emit('health', health);
      } catch (error) {
        logger.warn('Claude agent health check failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        this.emit('health-error', error);
      }
    }, intervalMs);

    // Initial health check
    try {
      const health = await this.getHealth();
      logger.info('✅ Claude agent is healthy', health);
    } catch (error) {
      logger.error('❌ Claude agent initial health check failed', { error });
      throw new Error('Claude agent is not available');
    }
  }

  /**
   * Stop health check monitoring
   */
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.info('🛑 Stopped Claude agent health check');
    }
  }

  /**
   * Get health status
   */
  async getHealth(): Promise<{
    status: string;
    sessions: number;
    idleMinutes: number;
    autoShutdownMinutes: number;
    uptime: number;
  }> {
    const response = await this.client.get('/health');
    return response.data;
  }

  /**
   * Create a new Claude session
   */
  async createSession(
    sessionId: string,
    projectId: string,
    workDir?: string
  ): Promise<ClaudeSession> {
    logger.info('📝 Creating Claude session', { sessionId, projectId, workDir });

    try {
      const response = await this.client.post('/sessions/create', {
        sessionId,
        projectId,
        workDir,
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to create session');
      }

      const session = response.data.session;
      logger.info('✅ Claude session created', { sessionId });
      this.emit('session-created', session);

      return {
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        createdAt: new Date(session.createdAt),
        lastActivity: new Date(session.createdAt),
      };
    } catch (error) {
      logger.error('❌ Failed to create Claude session', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Execute code generation
   */
  async generateCode(
    sessionId: string,
    prompt: string,
    options: GenerationOptions = {}
  ): Promise<GenerationResult> {
    logger.info('🤖 Starting code generation', { sessionId, promptLength: prompt.length });

    try {
      const response = await this.client.post(
        `/sessions/${sessionId}/generate`,
        { prompt, options },
        { timeout: options.timeout || 300000 } // 5 minutes default
      );

      if (!response.data.success) {
        throw new Error(response.data.error || 'Generation failed');
      }

      const result: GenerationResult = {
        success: response.data.success,
        sessionId: response.data.sessionId,
        output: response.data.output,
        error: response.data.error,
      };

      logger.info('✅ Code generation completed', {
        sessionId,
        outputLength: result.output.length
      });
      this.emit('generation-complete', result);

      return result;
    } catch (error) {
      logger.error('❌ Code generation failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.emit('generation-error', { sessionId, error });
      throw error;
    }
  }

  /**
   * Get session info
   */
  async getSession(sessionId: string): Promise<ClaudeSession | null> {
    try {
      const response = await this.client.get(`/sessions/${sessionId}`);

      if (!response.data.success) {
        return null;
      }

      const session = response.data.session;
      return {
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        createdAt: new Date(session.createdAt),
        lastActivity: new Date(session.lastActivity),
        outputLines: session.outputLines,
        errorLines: session.errorLines,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      logger.error('Failed to get session info', { sessionId, error });
      throw error;
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<ClaudeSession[]> {
    try {
      const response = await this.client.get('/sessions');

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to list sessions');
      }

      return response.data.sessions.map((s: any) => ({
        id: s.id,
        projectId: s.projectId,
        status: s.status,
        createdAt: new Date(s.createdAt),
        lastActivity: new Date(s.lastActivity),
      }));
    } catch (error) {
      logger.error('Failed to list sessions', { error });
      throw error;
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    logger.info('🗑️  Deleting Claude session', { sessionId });

    try {
      const response = await this.client.delete(`/sessions/${sessionId}`);

      if (!response.data.success) {
        return false;
      }

      logger.info('✅ Claude session deleted', { sessionId });
      this.emit('session-deleted', sessionId);
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      logger.error('Failed to delete session', { sessionId, error });
      throw error;
    }
  }

  /**
   * Cleanup - stop health checks
   */
  cleanup(): void {
    this.stopHealthCheck();
    this.removeAllListeners();
    logger.info('🧹 ClaudeSessionManager cleaned up');
  }
}
