/**
 * Auto-Update Service
 * Checks for and applies updates to the local server
 */

import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { logger } from '../lib/logger';

const GITHUB_API = 'https://api.github.com/repos/musical-run/local-server';
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const CURRENT_VERSION = process.env.VERSION || '1.0.0';

interface Release {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export class AutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private updateAvailable: Release | null = null;

  async initialize() {
    logger.info('🔄 Auto-update service initialized', {
      currentVersion: CURRENT_VERSION,
      checkInterval: UPDATE_CHECK_INTERVAL / 1000 / 60 / 60 + ' hours'
    });

    // Check for updates on startup
    await this.checkForUpdates();

    // Set up periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, UPDATE_CHECK_INTERVAL);
  }

  async checkForUpdates(): Promise<boolean> {
    try {
      logger.debug('Checking for updates...');

      // Fetch latest release from GitHub
      const response = await axios.get(`${GITHUB_API}/releases/latest`, {
        headers: {
          'User-Agent': 'Musical-Local-Server',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      const latestRelease: Release = response.data;
      const latestVersion = latestRelease.tag_name.replace(/^v/, '');

      if (this.isNewerVersion(latestVersion, CURRENT_VERSION)) {
        this.updateAvailable = latestRelease;

        logger.info('🎉 New version available!', {
          currentVersion: CURRENT_VERSION,
          latestVersion,
          releaseName: latestRelease.name
        });

        // Notify user
        await this.notifyUser(latestRelease);

        return true;
      } else {
        logger.debug('No updates available', {
          currentVersion: CURRENT_VERSION,
          latestVersion
        });
        return false;
      }

    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn('No releases found in repository');
      } else {
        logger.error('Failed to check for updates', { error: error.message });
      }
      return false;
    }
  }

  async applyUpdate(): Promise<boolean> {
    if (!this.updateAvailable) {
      logger.warn('No update available to apply');
      return false;
    }

    try {
      logger.info('📦 Applying update', {
        version: this.updateAvailable.tag_name
      });

      // Pull new Docker images
      logger.info('Pulling new Docker images...');
      await this.runCommand('docker-compose', ['pull']);

      // Restart services
      logger.info('Restarting services...');
      await this.runCommand('docker-compose', ['up', '-d']);

      logger.info('✅ Update applied successfully', {
        newVersion: this.updateAvailable.tag_name
      });

      this.updateAvailable = null;
      return true;

    } catch (error: any) {
      logger.error('❌ Failed to apply update', { error: error.message });
      return false;
    }
  }

  getUpdateInfo(): Release | null {
    return this.updateAvailable;
  }

  private isNewerVersion(latest: string, current: string): boolean {
    const latestParts = latest.split('.').map(Number);
    const currentParts = current.split('.').map(Number);

    for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
      const latestPart = latestParts[i] || 0;
      const currentPart = currentParts[i] || 0;

      if (latestPart > currentPart) return true;
      if (latestPart < currentPart) return false;
    }

    return false; // Versions are equal
  }

  private async notifyUser(release: Release) {
    // Write update notification to file
    const notificationPath = process.env.HOME + '/.musical/update-available.txt';

    try {
      await fs.writeFile(notificationPath, `
╔══════════════════════════════════════════════════════╗
║                                                      ║
║         🎉  Musical.run Update Available  🎉        ║
║                                                      ║
╚══════════════════════════════════════════════════════╝

New Version: ${release.tag_name}
Current Version: ${CURRENT_VERSION}
Released: ${new Date(release.published_at).toLocaleDateString()}

${release.name}

${release.body}

To update, run:
  cd ~/.musical
  docker-compose pull
  docker-compose up -d

Or visit: https://github.com/musical-run/local-server/releases/latest
`, 'utf-8');

      logger.info('Update notification written', { path: notificationPath });
    } catch (error: any) {
      logger.error('Failed to write update notification', { error: error.message });
    }
  }

  private async runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: process.env.HOME + '/.musical',
        stdio: 'pipe'
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  async shutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Auto-update service shutdown');
  }
}
