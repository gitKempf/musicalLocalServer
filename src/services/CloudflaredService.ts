/**
 * Cloudflared Service
 *
 * Manages Cloudflare Tunnel for exposing local server to the internet.
 * Uses `cloudflared tunnel` to create a temporary tunnel without config files.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../lib/logger';

export interface CloudflaredConfig {
  localPort: number;
  protocol?: 'http' | 'https';
}

export class CloudflaredService extends EventEmitter {
  private config: CloudflaredConfig;
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private ready: boolean = false;

  constructor(config: CloudflaredConfig) {
    super();
    this.config = {
      protocol: 'http',
      ...config,
    };
  }

  /**
   * Start Cloudflare Tunnel
   */
  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.process) {
        logger.warn('⚠️  Cloudflared already running');
        if (this.tunnelUrl) {
          return resolve(this.tunnelUrl);
        }
        return reject(new Error('Cloudflared running but no tunnel URL available'));
      }

      logger.info('🌐 Starting Cloudflare Tunnel...', {
        localPort: this.config.localPort,
        protocol: this.config.protocol,
      });

      // Start cloudflared in quick tunnel mode
      this.process = spawn('cloudflared', [
        'tunnel',
        '--url',
        `${this.config.protocol}://localhost:${this.config.localPort}`,
        '--no-autoupdate',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let urlFound = false;
      const timeout = setTimeout(() => {
        if (!urlFound) {
          this.stop();
          reject(new Error('Timeout waiting for Cloudflare Tunnel URL'));
        }
      }, 30000); // 30 second timeout

      // Parse stdout for tunnel URL
      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        logger.debug('Cloudflared stdout:', { output });

        // Look for tunnel URL pattern: https://*.trycloudflare.com
        // URL must start with alphanumeric (not hyphen) to be a valid domain
        const urlMatch = output.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          this.tunnelUrl = urlMatch[0];
          this.ready = true;
          clearTimeout(timeout);

          logger.info('✅ Cloudflare Tunnel ready', {
            tunnelUrl: this.tunnelUrl,
          });

          this.emit('ready', this.tunnelUrl);
          resolve(this.tunnelUrl);
        }
      });

      // Log stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();

        // Also check stderr for URL (cloudflared sometimes logs there)
        // URL must start with alphanumeric (not hyphen) to be a valid domain
        const urlMatch = output.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          this.tunnelUrl = urlMatch[0];
          this.ready = true;
          clearTimeout(timeout);

          logger.info('✅ Cloudflare Tunnel ready', {
            tunnelUrl: this.tunnelUrl,
          });

          this.emit('ready', this.tunnelUrl);
          resolve(this.tunnelUrl);
        }

        // Log other stderr messages as debug
        if (!urlMatch) {
          logger.debug('Cloudflared stderr:', { output });
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        logger.info('🌐 Cloudflared process exited', { code, signal });
        this.process = null;
        this.ready = false;
        this.tunnelUrl = null;
        this.emit('exit', { code, signal });

        if (!urlFound) {
          clearTimeout(timeout);
          reject(new Error(`Cloudflared exited with code ${code} before URL was available`));
        }
      });

      // Handle process errors
      this.process.on('error', (error) => {
        logger.error('❌ Cloudflared error', { error: error.message });
        clearTimeout(timeout);
        this.emit('error', error);
        if (!urlFound) {
          reject(error);
        }
      });
    });
  }

  /**
   * Stop Cloudflare Tunnel
   */
  stop(): void {
    if (this.process) {
      logger.info('🛑 Stopping Cloudflare Tunnel...');
      this.process.kill('SIGTERM');
      this.process = null;
      this.tunnelUrl = null;
      this.ready = false;
    }
  }

  /**
   * Get tunnel URL
   */
  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Check if tunnel is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Check if cloudflared is running
   */
  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stop();
    this.removeAllListeners();
  }
}
