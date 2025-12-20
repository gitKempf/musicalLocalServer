/**
 * CloudRegistrationService - Register local server with Musical.run cloud
 *
 * Registers the local server's public key and tunnel URL with Musical.run
 * so that the frontend can connect securely.
 */

import axios from 'axios';
import QRCode from 'qrcode';
import { logger } from '../lib/logger';
import { encryptionService } from '../lib/EncryptionService';

export class CloudRegistrationService {
  private cloudApiUrl: string;
  private registered = false;
  private serverId: string | null = null;
  private connectionUrl: string | null = null;

  constructor() {
    this.cloudApiUrl = process.env.CLOUD_API_URL || 'https://api.musical.run';
  }

  /**
   * Register local server with Musical.run cloud
   */
  async register(): Promise<void> {
    logger.info('☁️  Registering with Musical.run cloud...');

    try {
      const publicKey = encryptionService.getPublicKey();
      const localPort = process.env.PORT || 17100;

      const response = await axios.post(
        `${this.cloudApiUrl}/api/tunnel/register`,
        {
          publicKey,
          serverType: 'local',
          version: '1.0.0',
          capabilities: {
            claudeCode: true,
            encryption: true,
            gitea: true,
            preview: true,
          },
          localPort,
        },
        {
          timeout: 10000,
        }
      );

      if (response.data.success) {
        this.registered = true;
        this.serverId = response.data.serverId;
        this.connectionUrl = response.data.connectionUrl;

        logger.info('✅ Registered with Musical.run cloud', {
          serverId: this.serverId,
          connectionUrl: this.connectionUrl,
        });
      } else {
        throw new Error(response.data.error || 'Registration failed');
      }
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED') {
        logger.warn('⚠️  Could not connect to Musical.run cloud (offline mode)');
      } else {
        logger.error('❌ Registration failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Unregister from cloud
   */
  async unregister(): Promise<void> {
    if (!this.registered || !this.serverId) {
      return;
    }

    logger.info('☁️  Unregistering from Musical.run cloud...');

    try {
      await axios.post(
        `${this.cloudApiUrl}/api/tunnel/unregister`,
        { serverId: this.serverId },
        { timeout: 5000 }
      );

      this.registered = false;
      logger.info('✅ Unregistered from cloud');
    } catch (error: any) {
      logger.warn('⚠️  Could not unregister from cloud', { error: error.message });
    }
  }

  /**
   * Send heartbeat to cloud
   */
  async sendHeartbeat(): Promise<void> {
    if (!this.registered || !this.serverId) {
      return;
    }

    try {
      await axios.post(
        `${this.cloudApiUrl}/api/tunnel/heartbeat`,
        { serverId: this.serverId },
        { timeout: 5000 }
      );
    } catch (error: any) {
      logger.warn('⚠️  Heartbeat failed', { error: error.message });
    }
  }

  /**
   * Check if registered with cloud
   */
  isConnected(): boolean {
    return this.registered;
  }

  /**
   * Get connection URL for frontend
   */
  getConnectionUrl(): string | null {
    return this.connectionUrl;
  }

  /**
   * Display QR code for easy mobile connection
   */
  async displayQRCode(): Promise<void> {
    if (!this.connectionUrl) {
      return;
    }

    try {
      const qrCode = await QRCode.toString(this.connectionUrl, {
        type: 'terminal',
        small: true,
      });

      console.log(qrCode);
    } catch (error: any) {
      logger.warn('⚠️  Could not generate QR code', { error: error.message });
    }
  }
}
