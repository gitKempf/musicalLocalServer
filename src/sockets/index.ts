/**
 * WebSocket Handlers - Real-time communication
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../lib/logger';
import { encryptionService } from '../lib/EncryptionService';
import { setupTerminalHandlers } from './terminal';

export function setupSocketHandlers(io: SocketIOServer): void {
  // Setup terminal handlers (separate namespace for cleaner separation)
  setupTerminalHandlers(io);
  io.on('connection', (socket: Socket) => {
    logger.info('🔌 Client connected', { socketId: socket.id });

    // Handle encrypted message
    socket.on('encrypted-message', async (data) => {
      try {
        const { encryptedMessage, senderPublicKey, sessionId } = data;

        logger.info('📨 Received encrypted message', {
          socketId: socket.id,
          sessionId,
          hasMessage: !!encryptedMessage,
          hasSenderKey: !!senderPublicKey,
        });

        // Decrypt message
        const decryptedMessage = await encryptionService.decryptCompact(
          encryptedMessage,
          senderPublicKey
        );

        logger.info('🔓 Decrypted message', {
          messageLength: decryptedMessage.length,
          sessionId,
        });

        // TODO: Process message with Claude Code CLI
        // For now, echo back
        const response = `Echo: ${decryptedMessage}`;

        // Encrypt response
        const encryptedResponse = await encryptionService.encryptCompact(
          response,
          senderPublicKey
        );

        // Send encrypted response back
        socket.emit('encrypted-response', {
          encryptedResponse,
          sessionId,
          serverPublicKey: encryptionService.getPublicKey(),
        });

        logger.info('📤 Sent encrypted response', { sessionId });
      } catch (error: any) {
        logger.error('❌ Failed to process encrypted message', {
          error: error.message,
          socketId: socket.id,
        });

        socket.emit('error', {
          error: 'Failed to process message',
          details: error.message,
        });
      }
    });

    // Handle generation start
    socket.on('start-generation', async (data) => {
      try {
        const { projectId, prompt, sessionId } = data;

        logger.info('🚀 Starting code generation', {
          projectId,
          sessionId,
          promptLength: prompt?.length,
        });

        // TODO: Start Claude Code CLI generation
        // Stream progress updates back to client

        socket.emit('generation-progress', {
          sessionId,
          type: 'progress',
          message: 'Starting code generation...',
          percentage: 0,
        });

        // Simulate progress (will be replaced with real Claude streaming)
        setTimeout(() => {
          socket.emit('generation-progress', {
            sessionId,
            type: 'progress',
            message: 'Analyzing requirements...',
            percentage: 25,
          });
        }, 1000);

        setTimeout(() => {
          socket.emit('generation-progress', {
            sessionId,
            type: 'complete',
            message: 'Generation complete (simulated)',
            percentage: 100,
          });
        }, 3000);
      } catch (error: any) {
        logger.error('❌ Failed to start generation', {
          error: error.message,
          socketId: socket.id,
        });

        socket.emit('generation-error', {
          error: error.message,
        });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      logger.info('🔌 Client disconnected', { socketId: socket.id });
    });
  });
}
