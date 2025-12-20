/**
 * Tunnel Registration Service
 *
 * Registers local server with Musical.run Tunnel Router for zero-knowledge message routing.
 * Handles:
 * - Initial registration with Cloudflare Tunnel URL
 * - Periodic heartbeats to maintain connection status
 * - Unregistration on shutdown
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../lib/logger';
import { encryptionService } from '../lib/EncryptionService';

export interface TunnelConfig {
  tunnelRouterUrl: string;
  userId: string;
  serverType: 'local' | 'cloud';
  heartbeatIntervalMs?: number;
}

export class TunnelRegistrationService {
  private client: AxiosInstance;
  private config: TunnelConfig;
  private tunnelUrl: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private registered: boolean = false;

  constructor(config: TunnelConfig) {
    this.config = {
      heartbeatIntervalMs: 30000, // 30 seconds default
      ...config,
    };

    this.client = axios.create({
      baseURL: config.tunnelRouterUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Musical-Client': 'local-server',
      },
      // Accept self-signed certificates (for development/testing)
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    });
  }

  /**
   * Register tunnel with router
   */
  async register(tunnelUrl: string): Promise<void> {
    try {
      logger.info('🔌 Registering tunnel with router', {
        tunnelUrl,
        userId: this.config.userId,
        serverType: this.config.serverType,
      });

      const response = await this.client.post('/api/tunnel/register', {
        userId: this.config.userId,
        tunnelUrl,
        encryptionPubkey: encryptionService.getPublicKey(),
        serverType: this.config.serverType,
      });

      if (response.data.success) {
        this.tunnelUrl = tunnelUrl;
        this.registered = true;
        logger.info('✅ Tunnel registered successfully', {
          userId: this.config.userId,
          tunnelUrl: tunnelUrl.substring(0, 30) + '...',
        });

        // Start heartbeat
        this.startHeartbeat();
      } else {
        throw new Error('Registration failed: ' + response.data.error);
      }
    } catch (error) {
      logger.error('❌ Failed to register tunnel', {
        error: error instanceof Error ? error.message : String(error),
        userId: this.config.userId,
      });
      throw error;
    }
  }

  /**
   * Unregister tunnel from router
   */
  async unregister(): Promise<void> {
    if (!this.registered) {
      return;
    }

    try {
      logger.info('🔌 Unregistering tunnel from router', {
        userId: this.config.userId,
      });

      // Stop heartbeat first
      this.stopHeartbeat();

      const response = await this.client.post('/api/tunnel/unregister', {
        userId: this.config.userId,
      });

      if (response.data.success) {
        this.registered = false;
        this.tunnelUrl = null;
        logger.info('✅ Tunnel unregistered successfully');
      }
    } catch (error) {
      logger.error('❌ Failed to unregister tunnel', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - allow graceful shutdown
    }
  }

  /**
   * Start periodic heartbeat to tunnel router
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    logger.info('💓 Starting heartbeat', {
      intervalMs: this.config.heartbeatIntervalMs,
    });

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (error) {
        logger.warn('⚠️  Heartbeat failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.info('💓 Heartbeat stopped');
    }
  }

  /**
   * Send heartbeat to tunnel router
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.registered) {
      return;
    }

    try {
      await this.client.post('/api/tunnel/heartbeat', {
        userId: this.config.userId,
      });

      logger.debug('💓 Heartbeat sent', { userId: this.config.userId });
    } catch (error) {
      // Log but don't throw - heartbeat failures shouldn't crash the server
      logger.warn('⚠️  Heartbeat request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check tunnel status
   */
  async getStatus(): Promise<any> {
    try {
      const response = await this.client.get(`/api/tunnel/status/${this.config.userId}`);
      return response.data;
    } catch (error) {
      logger.error('❌ Failed to get tunnel status', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check if tunnel is registered
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get current tunnel URL
   */
  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopHeartbeat();
  }
}
