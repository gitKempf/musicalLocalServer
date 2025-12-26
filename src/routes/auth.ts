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
 * For Docker environments, use /api/auth/server instead
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

    // Check if we're in Docker - recommend server auth flow
    if (process.env.DOCKER_CONTAINER === 'true') {
      return res.json({
        success: true,
        message: 'For Docker environments, use /api/auth/server for browser-based authentication',
        useServerAuth: true,
        serverAuthUrl: '/api/auth/server',
      });
    }

    // Get the server port from environment or default
    const serverPort = process.env.PORT || 17100;
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'https://musical.run';
    
    // Use the main server port for callback (works through tunnel too)
    const callbackUrl = `http://localhost:${serverPort}/api/auth/callback`;
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
 * POST /api/auth/server
 * Start server instance authentication flow
 * Returns a verification URL and user code to display
 */
authRoutes.post('/server', async (req: Request, res: Response) => {
  try {
    if (authService.isAuthenticated()) {
      return res.json({
        success: false,
        error: 'Already authenticated',
        user: authService.getUserData(),
      });
    }

    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'https://musical.run';
    const serverName = process.env.SERVER_NAME || req.body.serverName || 'Local Server';

    // Request auth code from Musical.run
    const axios = require('axios');
    const response = await axios.post(
      `${authServiceUrl}/api/auth/server/code`,
      { serverName },
      { timeout: 10000 }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to get auth code');
    }

    const { authCode, userCode, verificationUrl, expiresIn, interval } = response.data;

    logger.info('🔑 Server authentication started', { userCode, verificationUrl });

    // Start polling in the background
    pollServerAuthInBackground(authService, authServiceUrl, authCode, interval);

    res.json({
      success: true,
      message: 'Visit the verification URL to authenticate',
      verificationUrl,
      userCode,
      expiresIn,
      pollInterval: interval,
      instructions: [
        '1. Visit the verificationUrl in your browser',
        '2. Log in to Musical.run (if not already logged in)',
        '3. Enter the user code or click "Authorize Server"',
        '4. This server will automatically receive the authentication',
        '5. Check /api/auth/status to confirm authentication'
      ],
    });
  } catch (error: any) {
    logger.error('❌ Failed to start server authentication', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/auth/server/poll
 * Poll for server authentication completion
 * This is called by the CLI to check if the user has completed authentication
 */
authRoutes.post('/server/poll', async (req: Request, res: Response) => {
  try {
    // Check if authenticated
    if (authService.isAuthenticated()) {
      const userData = authService.getUserData();
      return res.json({
        authenticated: true,
        userId: userData?.userId,
        email: userData?.email,
        fullName: userData?.fullName,
        accessToken: userData?.accessToken,
        refreshToken: userData?.refreshToken,
        expiresAt: userData?.expiresAt,
      });
    }

    // Not yet authenticated - return pending status
    return res.status(400).json({
      authenticated: false,
      error: 'authorization_pending',
      message: 'Waiting for user to complete authentication',
    });
  } catch (error: any) {
    logger.error('❌ Server poll error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Background polling for server authentication
async function pollServerAuthInBackground(authService: any, authServiceUrl: string, authCode: string, interval: number) {
  const axios = require('axios');
  const pollInterval = (interval || 5) * 1000;
  const maxPollTime = 15 * 60 * 1000; // 15 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const statusResponse = await axios.get(
        `${authServiceUrl}/api/auth/server/status/${authCode}`,
        { timeout: 10000 }
      );

      if (statusResponse.data.status === 'authorized') {
        // Success! Set the token
        const tokenData = {
          userId: statusResponse.data.userId.toString(),
          accessToken: statusResponse.data.accessToken,
          refreshToken: statusResponse.data.refreshToken,
          expiresAt: statusResponse.data.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          email: statusResponse.data.email,
          fullName: statusResponse.data.fullName || statusResponse.data.email,
        };

        await authService.setToken(tokenData);
        logger.info('✅ Server authentication successful', { userId: tokenData.userId, email: tokenData.email });
        return;
      }

      if (statusResponse.data.status !== 'pending') {
        logger.warn('⚠️ Server authentication failed', { status: statusResponse.data.status });
        return;
      }
    } catch (error: any) {
      if (error.response?.status === 403 || error.response?.status === 404 || error.response?.status === 410) {
        logger.warn('⚠️ Auth code expired or denied');
        return;
      }
      // Continue polling on other errors
    }
  }

  logger.warn('⚠️ Server authentication timeout');
}

/**
 * POST /api/auth/token
 * Accept authentication token directly
 * This allows authentication without localhost callbacks (e.g., from frontend via tunnel)
 */
authRoutes.post('/token', async (req: Request, res: Response) => {
  try {
    const { accessToken, refreshToken, userId, email, fullName, expiresAt } = req.body;

    if (!accessToken || !userId || !email) {
      return res.status(400).json({
        success: false,
        error: 'accessToken, userId, and email are required',
      });
    }

    logger.info('🔑 Received authentication token', { userId, email });

    // Set token data on auth service
    const tokenData = {
      userId: userId.toString(),
      accessToken,
      refreshToken: refreshToken || '',
      expiresAt: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      email,
      fullName: fullName || email,
    };

    // Use AuthService's setToken method if available, otherwise set directly
    if (authService.setToken) {
      await authService.setToken(tokenData);
    } else {
      // Direct approach - save token and trigger callback
      authService.tokenData = tokenData;
      await authService.saveToken?.(tokenData);
      
      // Trigger onAuthenticated callback (e.g., to setup tunnel)
      if (authService.onAuthenticatedCallback) {
        try {
          await authService.onAuthenticatedCallback(tokenData);
        } catch (error: any) {
          logger.warn('⚠️  onAuthenticated callback failed', { error: error.message });
        }
      }
    }

    logger.info('✅ Authentication successful via token injection', { userId, email });

    res.json({
      success: true,
      message: 'Authentication successful',
      user: {
        userId: tokenData.userId,
        email: tokenData.email,
        fullName: tokenData.fullName,
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to set authentication token', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/auth/callback
 * Handle OAuth callback via the main server port
 * This allows authentication without a separate callback server
 */
authRoutes.get('/callback', async (req: Request, res: Response) => {
  try {
    const { token, refreshToken, userId, email, fullName, expiresAt, error } = req.query;

    if (error) {
      logger.error('❌ Authentication callback error', { error });
      return res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Authentication Failed</h1>
            <p>Error: ${error}</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    if (!token || !userId || !email) {
      return res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Invalid Callback</h1>
            <p>Missing required parameters.</p>
          </body>
        </html>
      `);
    }

    logger.info('🔑 Received authentication callback', { userId, email });

    // Set token data
    const tokenData = {
      userId: userId.toString(),
      accessToken: token as string,
      refreshToken: (refreshToken as string) || '',
      expiresAt: (expiresAt as string) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      email: email as string,
      fullName: (fullName as string) || (email as string),
    };

    // Save token
    authService.tokenData = tokenData;
    await authService.saveToken?.(tokenData);

    // Trigger onAuthenticated callback
    if (authService.onAuthenticatedCallback) {
      try {
        await authService.onAuthenticatedCallback(tokenData);
      } catch (error: any) {
        logger.warn('⚠️  onAuthenticated callback failed', { error: error.message });
      }
    }

    logger.info('✅ Authentication successful via callback', { userId, email });

    // Return success page
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>✅ Authentication Successful!</h1>
          <p>You are now logged in as <strong>${email}</strong></p>
          <p>You can close this window and return to your application.</p>
          <script>
            // Try to close window after delay
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    logger.error('❌ Authentication callback error', { error: error.message });
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Server Error</h1>
          <p>${error.message}</p>
        </body>
      </html>
    `);
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
