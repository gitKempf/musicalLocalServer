/**
 * Terminal API Routes
 *
 * REST API for terminal session management.
 * WebSocket is used for real-time I/O, but this API provides
 * session listing, info, and management.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getTerminalService } from '../sockets/terminal';

const router = Router();

/**
 * GET /terminal/sessions
 * List all active terminal sessions
 */
router.get('/sessions', (req: Request, res: Response) => {
  try {
    const service = getTerminalService();
    const sessions = service.getActiveSessions();

    res.json({
      success: true,
      sessions: sessions.map((session) => ({
        id: session.id,
        containerId: session.containerId,
        createdAt: session.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error('Failed to list terminal sessions', {
      error: error.message,
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /terminal/sessions/:sessionId
 * Get info about specific session
 */
router.get('/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const service = getTerminalService();
    const session = service.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json({
      success: true,
      session: {
        id: session.id,
        containerId: session.containerId,
        createdAt: session.createdAt,
      },
    });
  } catch (error: any) {
    logger.error('Failed to get terminal session', {
      error: error.message,
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /terminal/sessions/:sessionId
 * Close a terminal session
 */
router.delete('/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const service = getTerminalService();

    service.closeSession(sessionId);

    res.json({
      success: true,
      message: 'Session closed',
    });
  } catch (error: any) {
    logger.error('Failed to close terminal session', {
      error: error.message,
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /terminal/execute
 * REMOVED: Use interactive terminal via WebSocket instead
 *
 * For command execution, connect to the terminal WebSocket and send
 * commands interactively. This provides better user experience and
 * allows Claude Code to prompt for authentication.
 */
router.post('/execute', (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: 'This endpoint has been removed. Use terminal WebSocket for interactive command execution.',
    instructions: {
      step1: 'Connect to terminal via WebSocket (socket.io)',
      step2: 'Emit "terminal:create" event with containerId and sessionId',
      step3: 'Send commands via "terminal:input" event',
      step4: 'Receive output via "terminal:data" event',
    },
  });
});

export default router;
