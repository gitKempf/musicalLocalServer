/**
 * DockerTerminalService - Direct docker exec terminal access
 *
 * Provides terminal access to containers using docker exec.
 * Simpler than SSH and works directly with any container.
 */

import Dockerode from 'dockerode';
import { logger } from '../lib/logger';
import { PassThrough } from 'stream';

export interface TerminalSession {
  id: string;
  containerId: string;
  exec: Dockerode.Exec | null;
  stream: NodeJS.ReadWriteStream | null;
  createdAt: Date;
  onData?: (data: Buffer) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export class DockerTerminalService {
  private docker: Dockerode;
  private sessions: Map<string, TerminalSession> = new Map();

  constructor() {
    this.docker = new Dockerode({
      socketPath: '/var/run/docker.sock',
    });
  }

  /**
   * Create new terminal session using docker exec
   */
  async createSession(
    containerId: string,
    sessionId: string,
    options: {
      rows?: number;
      cols?: number;
      onData?: (data: Buffer) => void;
      onClose?: () => void;
      onError?: (error: Error) => void;
    } = {}
  ): Promise<TerminalSession> {
    logger.info('🖥️  Creating terminal session', { sessionId, containerId });

    const session: TerminalSession = {
      id: sessionId,
      containerId,
      exec: null,
      stream: null,
      createdAt: new Date(),
      onData: options.onData,
      onClose: options.onClose,
      onError: options.onError,
    };

    this.sessions.set(sessionId, session);

    try {
      // Get container
      const container = this.docker.getContainer(containerId);

      // Create exec instance
      const exec = await container.exec({
        Cmd: ['/bin/bash'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Env: [
          `TERM=xterm-256color`,
          `COLUMNS=${options.cols || 80}`,
          `LINES=${options.rows || 24}`,
          `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        ],
      });

      session.exec = exec;

      // Start the exec
      const stream = await exec.start({
        hijack: true,
        stdin: true,
        Tty: true,
      });

      session.stream = stream;

      // Handle data from container
      stream.on('data', (data: Buffer) => {
        if (session.onData) {
          session.onData(data);
        }
      });

      // Handle stream end
      stream.on('end', () => {
        logger.info('📤 Terminal stream ended', { sessionId });
        if (session.onClose) {
          session.onClose();
        }
        this.closeSession(sessionId);
      });

      // Handle errors
      stream.on('error', (error: Error) => {
        logger.error('❌ Terminal stream error', { sessionId, error: error.message });
        if (session.onError) {
          session.onError(error);
        }
      });

      logger.info('✅ Terminal session created', { sessionId, containerId });

      return session;
    } catch (error: any) {
      logger.error('❌ Failed to create terminal session', {
        sessionId,
        containerId,
        error: error.message,
      });
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  /**
   * Send data to terminal (user input)
   */
  sendData(sessionId: string, data: string | Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stream) {
      logger.warn('⚠️  Terminal session not found or no stream', { sessionId });
      return;
    }

    session.stream.write(data);
  }

  /**
   * Resize terminal
   */
  async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.exec) {
      logger.warn('⚠️  Terminal session not found', { sessionId });
      return;
    }

    try {
      await session.exec.resize({ h: rows, w: cols });
      logger.debug('📐 Terminal resized', { sessionId, rows, cols });
    } catch (error: any) {
      logger.error('❌ Failed to resize terminal', {
        sessionId,
        error: error.message,
      });
    }
  }

  /**
   * Close terminal session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    logger.info('🔌 Closing terminal session', { sessionId });

    if (session.stream) {
      try {
        session.stream.end();
      } catch (error) {
        // Ignore errors on close
      }
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    logger.info('🔌 Closing all terminal sessions', {
      count: this.sessions.size,
    });

    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
  }
}
