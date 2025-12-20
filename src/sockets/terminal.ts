/**
 * Terminal WebSocket Handlers
 *
 * Handles real-time terminal communication via WebSocket.
 * Provides bidirectional streaming for terminal I/O using docker exec.
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../lib/logger';
import { DockerTerminalService } from '../services/DockerTerminalService';

// Singleton terminal service
let terminalService: DockerTerminalService | null = null;

export function initializeTerminalService(): DockerTerminalService {
  if (!terminalService) {
    terminalService = new DockerTerminalService();
  }
  return terminalService;
}

export function getTerminalService(): DockerTerminalService {
  if (!terminalService) {
    throw new Error('DockerTerminalService not initialized');
  }
  return terminalService;
}

export function setupTerminalHandlers(io: SocketIOServer): void {
  // Initialize terminal service
  const service = initializeTerminalService();

  io.on('connection', (socket: Socket) => {
    logger.debug('Terminal WebSocket client connected', {
      socketId: socket.id,
    });

    // Store session ID for this socket
    let sessionId: string | null = null;

    /**
     * Create new terminal session
     */
    socket.on('terminal:create', async (data: {
      containerId: string;
      sessionId: string;
      rows?: number;
      cols?: number;
      autoCommand?: string; // Optional command to execute automatically
    }, callback) => {
      try {
        // Default autoCommand to start Claude CLI if not provided
        const {
          containerId,
          sessionId: reqSessionId,
          rows = 24,
          cols = 80,
          autoCommand = 'claude' // Auto-start Claude CLI by default
        } = data;

        logger.info('Creating terminal session', {
          socketId: socket.id,
          containerId: containerId.substring(0, 12),
          sessionId: reqSessionId,
          rows,
          cols,
          autoCommand,
        });

        // Create session with docker exec
        const session = await service.createSession(containerId, reqSessionId, {
          rows,
          cols,
          // Forward data to socket
          onData: (data: Buffer) => {
            socket.emit('terminal:data', data.toString('utf-8'));
          },
          // Handle close
          onClose: () => {
            socket.emit('terminal:close');
            sessionId = null;
          },
          // Handle error
          onError: (error: Error) => {
            socket.emit('terminal:error', {
              message: error.message,
            });
          },
        });

        sessionId = session.id;

        logger.info('Terminal session created', {
          socketId: socket.id,
          sessionId,
          hasAutoCommand: !!autoCommand,
        });

        // If autoCommand is provided, execute it automatically
        if (autoCommand) {
          logger.info('Executing auto-command', {
            sessionId,
            command: autoCommand,
          });
          
          // Wait a moment for terminal to be ready, then send the command
          setTimeout(() => {
            if (sessionId) {
              service.sendData(sessionId, autoCommand + '\n');
            }
          }, 500);
        }

        // Send success response
        if (callback) {
          callback({
            success: true,
            sessionId,
          });
        }
      } catch (error: any) {
        logger.error('Failed to create terminal session', {
          socketId: socket.id,
          error: error.message,
        });

        if (callback) {
          callback({
            success: false,
            error: error.message,
          });
        }
      }
    });

    /**
     * Send input to terminal
     */
    socket.on('terminal:input', (data: string) => {
      if (!sessionId) {
        logger.warn('Terminal input without session', {
          socketId: socket.id,
        });
        return;
      }

      try {
        service.sendData(sessionId, data);
      } catch (error: any) {
        logger.error('Failed to send terminal input', {
          socketId: socket.id,
          sessionId,
          error: error.message,
        });

        socket.emit('terminal:error', {
          message: error.message,
        });
      }
    });

    /**
     * Resize terminal
     */
    socket.on('terminal:resize', async (data: {
      rows: number;
      cols: number;
    }) => {
      if (!sessionId) {
        logger.warn('Terminal resize without session', {
          socketId: socket.id,
        });
        return;
      }

      try {
        const { rows, cols } = data;
        await service.resize(sessionId, rows, cols);

        logger.debug('Terminal resized', {
          socketId: socket.id,
          sessionId,
          rows,
          cols,
        });
      } catch (error: any) {
        logger.error('Failed to resize terminal', {
          socketId: socket.id,
          sessionId,
          error: error.message,
        });

        socket.emit('terminal:error', {
          message: error.message,
        });
      }
    });

    /**
     * Close terminal session
     */
    socket.on('terminal:close', () => {
      if (!sessionId) {
        return;
      }

      try {
        logger.info('Closing terminal session', {
          socketId: socket.id,
          sessionId,
        });

        service.closeSession(sessionId);
        sessionId = null;
      } catch (error: any) {
        logger.error('Failed to close terminal session', {
          socketId: socket.id,
          sessionId,
          error: error.message,
        });
      }
    });

    /**
     * Handle disconnect
     */
    socket.on('disconnect', () => {
      logger.debug('Terminal WebSocket client disconnected', {
        socketId: socket.id,
      });

      // Close session if exists
      if (sessionId) {
        try {
          service.closeSession(sessionId);
        } catch (error: any) {
          logger.error('Failed to close terminal session on disconnect', {
            socketId: socket.id,
            sessionId,
            error: error.message,
          });
        }
      }
    });
  });

  logger.info('Terminal WebSocket handlers configured');
}

/**
 * Cleanup terminal service
 */
export function cleanupTerminalService(): void {
  if (terminalService) {
    terminalService.closeAllSessions();
    terminalService = null;
  }
}
