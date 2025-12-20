/**
 * AuthService - Authenticate local server with Musical.run
 *
 * Handles OAuth-style authentication flow:
 * 1. Opens browser to Musical.run login page
 * 2. User logs in with their Musical.run account
 * 3. Musical.run redirects back with auth token
 * 4. Token is stored locally for future use
 *
 * This enables the local server to:
 * - Register with tunnel router using authenticated user ID
 * - Associate the local server with a specific Musical.run account
 * - Access user-specific resources (projects, settings, etc.)
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../lib/logger';
import express, { Request, Response } from 'express';
import http from 'http';

export interface AuthTokenData {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  email: string;
  fullName: string;
}

export interface AuthServiceConfig {
  authServiceUrl: string;
  callbackPort?: number;
  tokenStoragePath?: string;
}

export class AuthService {
  private authServiceUrl: string;
  private callbackPort: number;
  private tokenStoragePath: string;
  private tokenData: AuthTokenData | null = null;
  private authServer: http.Server | null = null;
  private authResolve: ((value: AuthTokenData) => void) | null = null;
  private authReject: ((reason: any) => void) | null = null;

  constructor(config: AuthServiceConfig) {
    this.authServiceUrl = config.authServiceUrl;
    this.callbackPort = config.callbackPort || 17105;
    this.tokenStoragePath = config.tokenStoragePath || path.join(process.env.HOME || '/root', '.musical', 'auth.json');
  }

  /**
   * Initialize auth service - load existing token if available
   */
  async initialize(): Promise<void> {
    logger.info('🔑 Initializing AuthService...');

    // Try to load existing token
    try {
      await this.loadToken();

      if (this.tokenData) {
        // Verify token is still valid
        const isValid = await this.verifyToken();
        if (isValid) {
          logger.info('✅ Loaded valid authentication token', {
            userId: this.tokenData.userId,
            email: this.tokenData.email,
          });
          return;
        } else {
          logger.warn('⚠️  Stored token is invalid or expired');
          this.tokenData = null;
        }
      }
    } catch (error: any) {
      logger.debug('No existing token found', { error: error.message });
    }

    logger.info('💡 No valid authentication found - will need to authenticate');
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.tokenData !== null;
  }

  /**
   * Get current user ID
   */
  getUserId(): string | null {
    return this.tokenData?.userId || null;
  }

  /**
   * Get current user data
   */
  getUserData(): AuthTokenData | null {
    return this.tokenData;
  }

  /**
   * Get access token for API calls
   */
  getAccessToken(): string | null {
    return this.tokenData?.accessToken || null;
  }

  /**
   * Authenticate with Musical.run using CLI prompts or environment variables
   * Prompts user for email/password directly in terminal, or uses env vars
   */
  async authenticateCLI(): Promise<AuthTokenData> {
    logger.info('🔑 CLI Authentication Flow');
    logger.info('');

    let email = process.env.MUSICAL_AUTH_EMAIL;
    let password = process.env.MUSICAL_AUTH_PASSWORD;

    // If env vars not set and we have TTY, prompt user
    if (!email || !password) {
      if (process.stdin.isTTY) {
        try {
          const prompts = await import('prompts');

          const response = await prompts.default([
            {
              type: 'text',
              name: 'email',
              message: 'Email:',
              validate: (value: string) => value.includes('@') || 'Please enter a valid email'
            },
            {
              type: 'password',
              name: 'password',
              message: 'Password:',
            }
          ]);

          if (!response.email || !response.password) {
            throw new Error('Authentication cancelled by user');
          }

          email = response.email;
          password = response.password;
        } catch (error: any) {
          logger.error('❌ Interactive prompts failed', { error: error.message });
          throw new Error('Authentication failed: No credentials provided. Set MUSICAL_AUTH_EMAIL and MUSICAL_AUTH_PASSWORD environment variables or run in interactive mode.');
        }
      } else {
        throw new Error('Authentication failed: No credentials provided. Set MUSICAL_AUTH_EMAIL and MUSICAL_AUTH_PASSWORD environment variables.');
      }
    } else {
      logger.info('🔐 Using credentials from environment variables');
    }

    logger.info('🔐 Authenticating with Musical.run...');

    try {
      // Call Musical.run auth API with email/password
      const authResponse = await axios.post(
        `${this.authServiceUrl}/api/auth/login`,
        {
          email,
          password
        },
        { timeout: 10000 }
      );

      if (!authResponse.data.success) {
        throw new Error(authResponse.data.error || 'Authentication failed');
      }

      // Handle both old format (accessToken at root) and new format (tokens.accessToken)
      const tokens = authResponse.data.tokens || authResponse.data;
      const tokenData: AuthTokenData = {
        userId: authResponse.data.user.id.toString(),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        email: authResponse.data.user.email,
        fullName: authResponse.data.user.fullName || email,
      };

      // Save token
      await this.saveToken(tokenData);
      this.tokenData = tokenData;

      logger.info('✅ Authentication successful!', {
        userId: tokenData.userId,
        email: tokenData.email,
      });

      return tokenData;
    } catch (error: any) {
      if (error.message === 'Authentication cancelled by user') {
        logger.warn('⚠️  Authentication cancelled');
      } else {
        logger.error('❌ CLI authentication failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Authenticate with Musical.run
   * Opens browser for user to login, waits for callback
   */
  async authenticate(options: { openBrowser?: boolean; useCLI?: boolean } = {}): Promise<AuthTokenData> {
    const { openBrowser = true, useCLI = false } = options;

    // Use CLI authentication if requested or if in Docker/non-interactive environment
    if (useCLI || process.env.DOCKER_CONTAINER === 'true' || !process.stdout.isTTY) {
      return this.authenticateCLI();
    }

    logger.info('🌐 Starting authentication flow...');

    // Start local callback server
    await this.startCallbackServer();

    // Generate auth URL
    const callbackUrl = `http://localhost:${this.callbackPort}/auth/callback`;
    const authUrl = `${this.authServiceUrl}/auth/local-server?callback=${encodeURIComponent(callbackUrl)}`;

    logger.info('');
    logger.info('🔗 Please log in to Musical.run:');
    logger.info(`   ${authUrl}`);
    logger.info('');

    // Open browser automatically (if enabled)
    if (openBrowser) {
      try {
        const open = await import('open');
        await open.default(authUrl);
        logger.info('🌐 Browser opened automatically');
      } catch (error: any) {
        logger.warn('⚠️  Could not open browser automatically', { error: error.message });
        logger.info('💡 Please open the URL above manually');
      }
    }

    // Wait for callback
    logger.info('⏳ Waiting for authentication...');

    try {
      const tokenData = await this.waitForCallback();

      // Save token
      await this.saveToken(tokenData);

      this.tokenData = tokenData;

      logger.info('✅ Authentication successful!', {
        userId: tokenData.userId,
        email: tokenData.email,
      });

      return tokenData;
    } finally {
      // Always stop callback server
      this.stopCallbackServer();
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(): Promise<void> {
    if (!this.tokenData?.refreshToken) {
      throw new Error('No refresh token available');
    }

    logger.debug('🔄 Refreshing access token...');

    try {
      const response = await axios.post(
        `${this.authServiceUrl}/api/auth/refresh`,
        { refreshToken: this.tokenData.refreshToken },
        { timeout: 10000 }
      );

      if (response.data.success) {
        const { accessToken, expiresAt } = response.data;

        this.tokenData.accessToken = accessToken;
        this.tokenData.expiresAt = expiresAt;

        // Save updated token
        await this.saveToken(this.tokenData);

        logger.debug('✅ Access token refreshed');
      } else {
        throw new Error(response.data.error || 'Token refresh failed');
      }
    } catch (error: any) {
      logger.error('❌ Token refresh failed', { error: error.message });

      // If refresh fails, clear token data
      this.tokenData = null;
      await this.clearToken();

      throw new Error('Authentication expired. Please login again.');
    }
  }

  /**
   * Verify token is valid
   */
  async verifyToken(): Promise<boolean> {
    if (!this.tokenData?.accessToken) {
      return false;
    }

    try {
      const response = await axios.get(
        `${this.authServiceUrl}/api/auth/verify`,
        {
          headers: {
            Authorization: `Bearer ${this.tokenData.accessToken}`,
          },
          timeout: 10000,
        }
      );

      return response.data.success === true;
    } catch (error: any) {
      // Try to refresh token if verification fails
      if (this.tokenData?.refreshToken) {
        try {
          await this.refreshAccessToken();
          return true;
        } catch {
          return false;
        }
      }

      return false;
    }
  }

  /**
   * Logout - clear stored token
   */
  async logout(): Promise<void> {
    logger.info('🔓 Logging out...');

    this.tokenData = null;
    await this.clearToken();

    logger.info('✅ Logged out successfully');
  }

  /**
   * Start local callback server to receive auth response
   */
  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const app = express();

      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));

      // Callback endpoint
      app.get('/auth/callback', (req: Request, res: Response) => {
        const { token, userId, email, fullName, error } = req.query;

        if (error) {
          const errorMessage = String(error);
          logger.error('❌ Authentication failed', { error: errorMessage });

          res.send(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Failed - Musical.run</title>
                <style>
                  body { font-family: system-ui; padding: 40px; text-align: center; }
                  .error { color: #dc2626; font-size: 18px; margin: 20px 0; }
                </style>
              </head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p class="error">${errorMessage}</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);

          if (this.authReject) {
            this.authReject(new Error(errorMessage));
          }
          return;
        }

        if (!token || !userId) {
          res.send(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Error - Musical.run</title>
                <style>
                  body { font-family: system-ui; padding: 40px; text-align: center; }
                  .error { color: #dc2626; font-size: 18px; margin: 20px 0; }
                </style>
              </head>
              <body>
                <h1>❌ Authentication Error</h1>
                <p class="error">Missing authentication data</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);

          if (this.authReject) {
            this.authReject(new Error('Missing authentication data'));
          }
          return;
        }

        // Parse token data
        const tokenData: AuthTokenData = {
          userId: String(userId),
          accessToken: String(token),
          refreshToken: String(req.query.refreshToken || ''),
          expiresAt: String(req.query.expiresAt || ''),
          email: String(email || ''),
          fullName: String(fullName || ''),
        };

        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Authentication Successful - Musical.run</title>
              <style>
                body {
                  font-family: system-ui;
                  padding: 40px;
                  text-align: center;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                }
                .success { font-size: 72px; margin: 20px 0; }
                h1 { font-size: 32px; margin: 20px 0; }
                p { font-size: 18px; opacity: 0.9; }
              </style>
            </head>
            <body>
              <div class="success">✅</div>
              <h1>Authentication Successful!</h1>
              <p>Your local server is now connected to Musical.run</p>
              <p>You can close this window and return to your terminal.</p>
            </body>
          </html>
        `);

        if (this.authResolve) {
          this.authResolve(tokenData);
        }
      });

      // Health check
      app.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok' });
      });

      this.authServer = app.listen(this.callbackPort, () => {
        logger.debug(`Callback server listening on port ${this.callbackPort}`);
        resolve();
      });

      this.authServer.on('error', (error: any) => {
        logger.error('❌ Failed to start callback server', { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Stop callback server
   */
  private stopCallbackServer(): void {
    if (this.authServer) {
      this.authServer.close();
      this.authServer = null;
      logger.debug('Callback server stopped');
    }
  }

  /**
   * Wait for authentication callback
   */
  private waitForCallback(): Promise<AuthTokenData> {
    return new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.authResolve) {
          reject(new Error('Authentication timeout - no response received'));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Load token from disk
   */
  private async loadToken(): Promise<void> {
    try {
      const tokenJson = await fs.readFile(this.tokenStoragePath, 'utf-8');
      this.tokenData = JSON.parse(tokenJson);
      logger.debug('Token loaded from disk');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.warn('⚠️  Could not load token', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Save token to disk
   */
  private async saveToken(tokenData: AuthTokenData): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.tokenStoragePath);
      await fs.mkdir(dir, { recursive: true });

      // Write token
      await fs.writeFile(
        this.tokenStoragePath,
        JSON.stringify(tokenData, null, 2),
        { mode: 0o600 } // Only owner can read/write
      );

      logger.debug('Token saved to disk', { path: this.tokenStoragePath });
    } catch (error: any) {
      logger.error('❌ Could not save token', { error: error.message });
      throw error;
    }
  }

  /**
   * Clear stored token
   */
  private async clearToken(): Promise<void> {
    try {
      await fs.unlink(this.tokenStoragePath);
      logger.debug('Token file deleted');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.warn('⚠️  Could not delete token file', { error: error.message });
      }
    }
  }

  /**
   * Get authorization header for API calls
   */
  getAuthorizationHeader(): string | null {
    if (!this.tokenData?.accessToken) {
      return null;
    }
    return `Bearer ${this.tokenData.accessToken}`;
  }

  /**
   * Make authenticated API request
   */
  async authenticatedRequest<T = any>(
    url: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      data?: any;
      timeout?: number;
    } = {}
  ): Promise<T> {
    const { method = 'GET', data, timeout = 10000 } = options;

    const authHeader = this.getAuthorizationHeader();
    if (!authHeader) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios({
        url,
        method,
        data,
        headers: {
          Authorization: authHeader,
        },
        timeout,
      });

      return response.data;
    } catch (error: any) {
      // If 401, try to refresh token
      if (error.response?.status === 401 && this.tokenData?.refreshToken) {
        await this.refreshAccessToken();

        // Retry request with new token
        const newAuthHeader = this.getAuthorizationHeader();
        const response = await axios({
          url,
          method,
          data,
          headers: {
            Authorization: newAuthHeader!,
          },
          timeout,
        });

        return response.data;
      }

      throw error;
    }
  }
}
