/**
 * Authentication Routes
 * Provides API endpoints for authenticating the local server with Musical.run
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';

export const authRoutes = Router();

// Service will be injected via middleware
let authService: any = null;

export function initializeAuthRoutes(auth: any) {
  authService = auth;
  logger.info('✅ Auth routes initialized');
}

/**
 * GET /api/auth/status
 * Check authentication status
 */
authRoutes.get('/status', (req: Request, res: Response) => {
  const isAuthenticated = authService.isAuthenticated();
  const userData = authService.getUserData();

  res.json({
    success: true,
    authenticated: isAuthenticated,
    user: userData ? {
      userId: userData.userId,
      email: userData.email,
      fullName: userData.fullName,
    } : null,
  });
});

/**
 * POST /api/auth/start
 * Start authentication flow (non-blocking)
 * Returns auth URL that user must visit manually
 */
authRoutes.post('/start', async (req: Request, res: Response) => {
  try {
    if (authService.isAuthenticated()) {
      return res.json({
        success: false,
        error: 'Already authenticated',
        user: authService.getUserData(),
      });
    }

    // Don't actually start the flow (which would block)
    // Just return the URL the user needs to visit
    const callbackPort = 17105;
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://musical.run';
    const callbackUrl = `http://localhost:${callbackPort}/auth/callback`;
    const authUrl = `${authServiceUrl}/auth/local-server?callback=${encodeURIComponent(callbackUrl)}`;

    logger.info('🔑 Authentication flow requested', { authUrl });

    res.json({
      success: true,
      message: 'Visit the auth URL to authenticate',
      authUrl,
      instructions: [
        '1. Visit the authUrl in your browser',
        '2. Log in with your Musical.run account',
        '3. The server will automatically receive the authentication token',
        '4. Check /api/auth/status to confirm authentication'
      ],
    });
  } catch (error: any) {
    logger.error('❌ Failed to start authentication', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/auth/logout
 * Clear authentication
 */
authRoutes.post('/logout', async (req: Request, res: Response) => {
  try {
    // Clear token data
    authService.tokenData = null;

    logger.info('🔓 User logged out');

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    logger.error('❌ Failed to logout', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
