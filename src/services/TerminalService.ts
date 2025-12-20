/**
 * TerminalService - SSH-based terminal access to containers
 *
 * Provides PTY (pseudo-terminal) access to Docker containers via SSH.
 * This enables full terminal functionality including:
 * - Interactive shells (bash, zsh, etc.)
 * - Color output and special characters
 * - Terminal resizing
 * - Ctrl+C, Ctrl+D, and other control sequences
 *
 * Architecture:
 * 1. Container runs SSH server (openssh-server)
 * 2. TerminalService connects via SSH using ssh2 library
 * 3. PTY stream is bridged to WebSocket for frontend
 * 4. Frontend uses xterm.js for rendering
 */

import { Client, ClientChannel } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../lib/logger';
import Dockerode from 'dockerode';

export interface TerminalSession {
  id: string;
  containerId: string;
  containerName: string;
  sshClient: Client;
  channel: ClientChannel | null;
  createdAt: Date;
  lastActivity: Date;
  rows: number;
  cols: number;
}

export interface TerminalConfig {
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPrivateKey?: Buffer;
  defaultShell?: string;
}

export class TerminalService {
  private sessions: Map<string, TerminalSession> = new Map();
  private config: TerminalConfig;
  private docker: Dockerode;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: TerminalConfig = {}) {
    this.config = {
      sshHost: config.sshHost || 'claude-agent',
      sshPort: config.sshPort || 22,
      sshUser: config.sshUser || 'root',
      sshPassword: config.sshPassword || 'musical',
      defaultShell: config.defaultShell || '/bin/bash',
      ...config,
    };

    // Initialize Docker client
    this.docker = new Dockerode({
      socketPath: '/var/run/docker.sock',
    });

    // Start cleanup interval (every 5 minutes)
    this.startCleanup();
  }

  /**
   * Create new terminal session for a container
   */
  async createSession(
    containerId: string,
    options: {
      rows?: number;
      cols?: number;
      onData?: (data: Buffer) => void;
      onClose?: () => void;
      onError?: (error: Error) => void;
    } = {}
  ): Promise<string> {
    const sessionId = uuidv4();
    const { rows = 24, cols = 80, onData, onClose, onError } = options;

    logger.info('Creating terminal session', {
      sessionId,
      containerId: containerId.substring(0, 12),
      rows,
      cols,
    });

    try {
      // Get container info
      const container = this.docker.getContainer(containerId);
      const containerInfo = await container.inspect();
      const containerName = containerInfo.Name.replace(/^\//, '');

      // For now, we'll use docker exec instead of SSH
      // This is simpler and doesn't require SSH server in container
      // We can upgrade to SSH later if needed

      const session: TerminalSession = {
        id: sessionId,
        containerId,
        containerName,
        sshClient: new Client(),
        channel: null,
        createdAt: new Date(),
        lastActivity: new Date(),
        rows,
        cols,
      };

      // Create SSH connection
      await this.connectSSH(session, onData, onClose, onError);

      this.sessions.set(sessionId, session);

      logger.info('Terminal session created', {
        sessionId,
        containerName,
      });

      return sessionId;
    } catch (error: any) {
      logger.error('Failed to create terminal session', {
        error: error.message,
        containerId,
      });
      throw error;
    }
  }

  /**
   * Connect to container via SSH
   */
  private async connectSSH(
    session: TerminalSession,
    onData?: (data: Buffer) => void,
    onClose?: () => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const { sshClient } = session;

      sshClient.on('ready', () => {
        logger.debug('SSH connection ready', { sessionId: session.id });

        // Request shell with PTY
        sshClient.shell(
          {
            rows: session.rows,
            cols: session.cols,
            term: 'xterm-256color',
          },
          (err, stream) => {
            if (err) {
              logger.error('Failed to create shell', {
                sessionId: session.id,
                error: err.message,
              });
              reject(err);
              return;
            }

            session.channel = stream;

            // Handle data from container
            stream.on('data', (data: Buffer) => {
              session.lastActivity = new Date();
              if (onData) {
                onData(data);
              }
            });

            // Handle stream close
            stream.on('close', () => {
              logger.debug('Terminal stream closed', { sessionId: session.id });
              if (onClose) {
                onClose();
              }
              this.closeSession(session.id);
            });

            // Handle errors
            stream.on('error', (error: Error) => {
              logger.error('Terminal stream error', {
                sessionId: session.id,
                error: error.message,
              });
              if (onError) {
                onError(error);
              }
            });

            logger.info('Terminal shell started', { sessionId: session.id });
            resolve();
          }
        );
      });

      sshClient.on('error', (error: Error) => {
        logger.error('SSH connection error', {
          sessionId: session.id,
          error: error.message,
        });
        if (onError) {
          onError(error);
        }
        reject(error);
      });

      sshClient.on('close', () => {
        logger.debug('SSH connection closed', { sessionId: session.id });
        if (onClose) {
          onClose();
        }
      });

      // Connect to SSH server
      const connectionConfig: any = {
        host: this.config.sshHost,
        port: this.config.sshPort,
        username: this.config.sshUser,
        readyTimeout: 10000,
      };

      if (this.config.sshPrivateKey) {
        connectionConfig.privateKey = this.config.sshPrivateKey;
      } else if (this.config.sshPassword) {
        connectionConfig.password = this.config.sshPassword;
      }

      logger.debug('Connecting to SSH server', {
        host: connectionConfig.host,
        port: connectionConfig.port,
        user: connectionConfig.username,
      });

      sshClient.connect(connectionConfig);
    });
  }

  /**
   * Send input to terminal session
   */
  async sendInput(sessionId: string, data: string | Buffer): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.channel) {
      throw new Error(`Session channel not ready: ${sessionId}`);
    }

    session.lastActivity = new Date();

    // Write to SSH channel
    session.channel.write(data);
  }

  /**
   * Resize terminal
   */
  async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.channel) {
      throw new Error(`Session channel not ready: ${sessionId}`);
    }

    session.rows = rows;
    session.cols = cols;

    // Send window change
    session.channel.setWindow(rows, cols, 0, 0);

    logger.debug('Terminal resized', { sessionId, rows, cols });
  }

  /**
   * Close terminal session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    logger.info('Closing terminal session', {
      sessionId,
      containerName: session.containerName,
    });

    // Close channel
    if (session.channel) {
      session.channel.end();
    }

    // Close SSH connection
    session.sshClient.end();

    // Remove from sessions
    this.sessions.delete(sessionId);
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all active sessions
   */
  listSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Start cleanup interval
   */
  private startCleanup(): void {
    // Clean up inactive sessions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }

  /**
   * Clean up sessions inactive for > 30 minutes
   */
  private cleanupInactiveSessions(): void {
    const now = new Date();
    const maxInactiveMs = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of this.sessions.entries()) {
      const inactiveMs = now.getTime() - session.lastActivity.getTime();

      if (inactiveMs > maxInactiveMs) {
        logger.info('Cleaning up inactive session', {
          sessionId,
          inactiveMinutes: Math.floor(inactiveMs / 60000),
        });

        this.closeSession(sessionId);
      }
    }
  }

  /**
   * Cleanup service
   */
  cleanup(): void {
    logger.info('Cleaning up TerminalService');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Close all sessions
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
  }

  /**
   * Execute command in container (non-interactive)
   */
  async executeCommand(
    containerId: string,
    command: string,
    options: {
      onStdout?: (data: Buffer) => void;
      onStderr?: (data: Buffer) => void;
      onExit?: (code: number) => void;
    } = {}
  ): Promise<void> {
    const { onStdout, onStderr, onExit } = options;

    const container = this.docker.getContainer(containerId);
    const containerInfo = await container.inspect();
    const containerName = containerInfo.Name.replace(/^\//, '');

    logger.info('Executing command', {
      containerName,
      command: command.substring(0, 100),
    });

    return new Promise((resolve, reject) => {
      const sshClient = new Client();

      sshClient.on('ready', () => {
        sshClient.exec(command, (err, stream) => {
          if (err) {
            sshClient.end();
            reject(err);
            return;
          }

          // Handle stdout
          stream.on('data', (data: Buffer) => {
            if (onStdout) {
              onStdout(data);
            }
          });

          // Handle stderr
          stream.stderr.on('data', (data: Buffer) => {
            if (onStderr) {
              onStderr(data);
            }
          });

          // Handle exit
          stream.on('close', (code: number) => {
            sshClient.end();

            if (onExit) {
              onExit(code);
            }

            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Command exited with code ${code}`));
            }
          });
        });
      });

      sshClient.on('error', (error: Error) => {
        reject(error);
      });

      // Connect
      const connectionConfig: any = {
        host: this.config.sshHost,
        port: this.config.sshPort,
        username: this.config.sshUser,
        readyTimeout: 10000,
      };

      if (this.config.sshPrivateKey) {
        connectionConfig.privateKey = this.config.sshPrivateKey;
      } else if (this.config.sshPassword) {
        connectionConfig.password = this.config.sshPassword;
      }

      sshClient.connect(connectionConfig);
    });
  }
}
