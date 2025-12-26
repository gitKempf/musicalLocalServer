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
  serverId?: string;       // Unique identifier for this server instance
  serverName?: string;     // Human-readable name (e.g., "Home Server")
  serverType: 'local' | 'cloud';
  heartbeatIntervalMs?: number;
  onRevoked?: () => void;  // Callback when server authorization is revoked
}

export class TunnelRegistrationService {
  private client: AxiosInstance;
  private config: TunnelConfig;
  private tunnelUrl: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private registered: boolean = false;
  private revoked: boolean = false;
  private serverId: string;

  constructor(config: TunnelConfig) {
    this.config = {
      heartbeatIntervalMs: 30000, // 30 seconds default
      ...config,
    };
    
    // Generate a unique server ID if not provided
    // Uses a combination of machine-specific info to be consistent across restarts
    this.serverId = config.serverId || this.generateServerId();

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
   * Generate a unique server ID
   * Uses encryption public key fingerprint for consistency across restarts
   */
  private generateServerId(): string {
    const pubKey = encryptionService.getPublicKey();
    // Use first 12 chars of public key as server ID
    return `server_${pubKey.substring(0, 12)}`;
  }

  /**
   * Get this server's unique ID
   */
  getServerId(): string {
    return this.serverId;
  }

  /**
   * Register tunnel with router
   */
  async register(tunnelUrl: string): Promise<void> {
    try {
      logger.info('🔌 Registering tunnel with router', {
        tunnelUrl,
        userId: this.config.userId,
        serverId: this.serverId,
        serverName: this.config.serverName,
        serverType: this.config.serverType,
      });

      const response = await this.client.post('/api/tunnel/register', {
        userId: this.config.userId,
        serverId: this.serverId,
        serverName: this.config.serverName || `Local Server (${this.serverId.substring(0, 8)})`,
        tunnelUrl,
        encryptionPubkey: encryptionService.getPublicKey(),
        serverType: this.config.serverType,
      });

      if (response.data.success) {
        this.tunnelUrl = tunnelUrl;
        this.registered = true;
        logger.info('✅ Tunnel registered successfully', {
          userId: this.config.userId,
          serverId: this.serverId,
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
        serverId: this.serverId,
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
        serverId: this.serverId,
      });

      // Stop heartbeat first
      this.stopHeartbeat();

      const response = await this.client.post('/api/tunnel/unregister', {
        userId: this.config.userId,
        serverId: this.serverId,
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
   * Includes tunnelUrl to ensure it stays fresh if cloudflared restarts
   * Handles revocation responses
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.registered || this.revoked) {
      return;
    }

    try {
      const response = await this.client.post('/api/tunnel/heartbeat', {
        userId: this.config.userId,
        serverId: this.serverId,
        tunnelUrl: this.tunnelUrl, // Include tunnel URL to keep it fresh
        serverName: this.config.serverName, // Include server name to keep it updated
      });

      // Check if authorization was revoked
      if (response.data.revoked) {
        logger.warn('⛔ Server authorization has been revoked!', {
          userId: this.config.userId,
          serverId: this.serverId,
        });
        this.revoked = true;
        this.registered = false;
        this.stopHeartbeat();
        
        // Notify the caller (e.g., CLI) that authorization was revoked
        if (this.config.onRevoked) {
          this.config.onRevoked();
        }
        return;
      }

      logger.debug('💓 Heartbeat sent', { userId: this.config.userId, serverId: this.serverId });
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
      const response = await this.client.get(`/api/tunnel/status/${this.config.userId}/${this.serverId}`);
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
   * Check if server authorization was revoked
   */
  isRevoked(): boolean {
    return this.revoked;
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
