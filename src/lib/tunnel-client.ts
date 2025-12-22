/**
 * Tunnel Client
 * 
 * Client for local servers to communicate with the tunnel router.
 * Provides a clean interface for registration, heartbeat, and status checks.
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from './logger';
import {
  ITunnelClient,
  TunnelRegisterRequest,
  TunnelRegisterResponse,
  TunnelHeartbeatRequest,
  TunnelHeartbeatResponse,
  TunnelStatusResponse,
  TunnelErrorCodes
} from './tunnel-api-types';

export interface TunnelClientConfig {
  /** Tunnel router URL (e.g., https://musical.run) */
  tunnelRouterUrl: string;
  
  /** User ID for this server */
  userId: string;
  
  /** Server instance ID */
  serverId: string;
  
  /** Server name for display */
  serverName: string;
  
  /** Local server's tunnel URL */
  tunnelUrl: string;
  
  /** Encryption public key */
  encryptionPubkey: string;
  
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatInterval?: number;
  
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}

export class TunnelClient implements ITunnelClient {
  private config: TunnelClientConfig;
  private client: AxiosInstance;
  private heartbeatTimer: NodeJS.Timer | null = null;
  private registered: boolean = false;

  constructor(config: TunnelClientConfig) {
    this.config = {
      heartbeatInterval: 30000,
      timeout: 10000,
      ...config
    };

    this.client = axios.create({
      baseURL: `${this.config.tunnelRouterUrl}/api/tunnel`,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-Musical-Server-Id': this.config.serverId
      }
    });
  }

  /**
   * Register this server with the tunnel router
   */
  async register(request?: Partial<TunnelRegisterRequest>): Promise<TunnelRegisterResponse> {
    const payload: TunnelRegisterRequest = {
      userId: this.config.userId,
      serverId: this.config.serverId,
      serverName: this.config.serverName,
      tunnelUrl: this.config.tunnelUrl,
      encryptionPubkey: this.config.encryptionPubkey,
      serverType: 'local',
      ...request
    };

    try {
      logger.info('🔌 Registering with tunnel router', {
        tunnelRouterUrl: this.config.tunnelRouterUrl,
        serverId: payload.serverId,
        serverName: payload.serverName
      });

      const response = await this.client.post<TunnelRegisterResponse>('/register', payload);

      if (response.data.success) {
        this.registered = true;
        this.startHeartbeat();
        logger.info('✅ Registered with tunnel router', {
          serverId: response.data.serverId
        });
      }

      return response.data;
    } catch (error: any) {
      logger.error('❌ Failed to register with tunnel router', {
        error: error.message
      });
      throw this.createError(error);
    }
  }

  /**
   * Unregister this server
   */
  async unregister(userId?: string, serverId?: string): Promise<{ success: boolean }> {
    this.stopHeartbeat();

    try {
      const response = await this.client.post('/unregister', {
        userId: userId || this.config.userId,
        serverId: serverId || this.config.serverId
      });

      this.registered = false;
      logger.info('🔌 Unregistered from tunnel router');

      return response.data;
    } catch (error: any) {
      logger.error('❌ Failed to unregister from tunnel router', {
        error: error.message
      });
      throw this.createError(error);
    }
  }

  /**
   * Send heartbeat to maintain connection
   */
  async heartbeat(userId?: string, serverId?: string): Promise<TunnelHeartbeatResponse> {
    try {
      const response = await this.client.post<TunnelHeartbeatResponse>('/heartbeat', {
        userId: userId || this.config.userId,
        serverId: serverId || this.config.serverId
      });

      return response.data;
    } catch (error: any) {
      logger.warn('⚠️  Heartbeat failed', { error: error.message });
      throw this.createError(error);
    }
  }

  /**
   * Get status of a specific server
   */
  async getServerStatus(userId: string, serverId: string): Promise<TunnelStatusResponse> {
    try {
      const response = await this.client.get<TunnelStatusResponse>(
        `/status/${userId}/${serverId}`
      );
      return response.data;
    } catch (error: any) {
      throw this.createError(error);
    }
  }

  /**
   * Get all servers for a user
   */
  async getAllServers(userId: string): Promise<TunnelStatusResponse> {
    try {
      const response = await this.client.get<TunnelStatusResponse>(`/status/${userId}`);
      return response.data;
    } catch (error: any) {
      throw this.createError(error);
    }
  }

  /**
   * Check if currently registered
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Update tunnel URL (e.g., when tunnel reconnects)
   */
  async updateTunnelUrl(newUrl: string): Promise<void> {
    this.config.tunnelUrl = newUrl;
    if (this.registered) {
      await this.register();
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    if (this.registered) {
      try {
        await this.unregister();
      } catch {
        // Ignore errors during shutdown
      }
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.heartbeat();
      } catch (error) {
        // Heartbeat failed, try to re-register
        logger.warn('⚠️  Heartbeat failed, attempting re-registration');
        try {
          await this.register();
        } catch (regError) {
          logger.error('❌ Re-registration failed');
        }
      }
    }, this.config.heartbeatInterval);

    logger.debug('Started heartbeat timer', {
      interval: this.config.heartbeatInterval
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer as any);
      this.heartbeatTimer = null;
      logger.debug('Stopped heartbeat timer');
    }
  }

  private createError(error: any): Error {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data;
      if (data?.error) {
        const err = new Error(data.error);
        (err as any).code = data.code || TunnelErrorCodes.INTERNAL_ERROR;
        (err as any).details = data.details;
        (err as any).hint = data.hint;
        return err;
      }

      if (error.code === 'ECONNREFUSED') {
        const err = new Error('Tunnel router unreachable');
        (err as any).code = TunnelErrorCodes.SERVER_UNREACHABLE;
        return err;
      }

      if (error.code === 'ETIMEDOUT') {
        const err = new Error('Request timed out');
        (err as any).code = TunnelErrorCodes.TIMEOUT;
        return err;
      }
    }

    return error;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let tunnelClientInstance: TunnelClient | null = null;

/**
 * Get or create the tunnel client instance
 */
export function getTunnelClient(): TunnelClient | null {
  return tunnelClientInstance;
}

/**
 * Initialize the tunnel client
 */
export function initializeTunnelClient(config: TunnelClientConfig): TunnelClient {
  if (tunnelClientInstance) {
    tunnelClientInstance.shutdown();
  }
  tunnelClientInstance = new TunnelClient(config);
  return tunnelClientInstance;
}
