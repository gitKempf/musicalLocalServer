/**
 * Gitea Auto-Setup Service
 * 
 * Automatically configures Gitea on first run:
 * 1. Creates admin user with secure auto-generated password
 * 2. Generates API token for local-server
 * 3. Creates organization for projects
 * 4. Stores credentials securely
 * 
 * Security considerations:
 * - Uses crypto.randomBytes for secure token generation
 * - Stores credentials with restricted file permissions
 * - Token is scoped with minimal required permissions
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import axios, { AxiosInstance } from 'axios';
import { logger } from '../lib/logger';

const execAsync = promisify(exec);

interface GiteaSetupConfig {
  giteaUrl: string;
  giteaContainer?: string;
  adminUsername?: string;
  adminEmail?: string;
  organization?: string;
  secretsDir?: string;
}

interface GiteaCredentials {
  url: string;
  username: string;
  token: string;
  password: string;
  organization: string;
}

export class GiteaAutoSetupService {
  private config: Required<GiteaSetupConfig>;
  private client: AxiosInstance;
  private setupComplete: boolean = false;

  constructor(config: GiteaSetupConfig) {
    this.config = {
      giteaUrl: config.giteaUrl,
      giteaContainer: config.giteaContainer || 'musical-gitea-local',
      adminUsername: config.adminUsername || 'musical',
      adminEmail: config.adminEmail || 'admin@musical.local',
      organization: config.organization || 'musical',
      secretsDir: config.secretsDir || path.join(process.env.HOME || '/root', '.musical', 'secrets'),
    };

    this.client = axios.create({
      baseURL: this.config.giteaUrl,
      timeout: 10000,
    });
  }

  /**
   * Generate cryptographically secure random string
   */
  private generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
  }

  /**
   * Check if Gitea is ready
   */
  private async waitForGitea(maxAttempts: number = 30): Promise<boolean> {
    logger.info('🔄 Waiting for Gitea to be ready...');

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await this.client.get('/api/v1/version');
        if (response.status === 200) {
          logger.info('✅ Gitea is ready', { version: response.data.version });
          return true;
        }
      } catch (error) {
        // Gitea not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    logger.error('❌ Gitea did not become ready in time');
    return false;
  }

  /**
   * Check if setup was already completed by reading saved credentials
   */
  private async isSetupComplete(): Promise<GiteaCredentials | null> {
    const credentialsFile = path.join(this.config.secretsDir, 'gitea-credentials.json');

    try {
      const credentialsData = await fs.readFile(credentialsFile, 'utf-8');
      const credentials = JSON.parse(credentialsData) as GiteaCredentials;

      if (!credentials.token || !credentials.username) {
        logger.debug('Invalid credentials file, missing token or username');
        return null;
      }

      // Verify token still works
      try {
        const response = await this.client.get('/api/v1/user', {
          headers: { Authorization: `token ${credentials.token}` },
        });

        if (response.status === 200) {
          logger.info('✅ Gitea already configured with valid token from file');
          this.setupComplete = true;
          return credentials;
        }
      } catch (verifyError) {
        logger.debug('Token verification failed, will attempt new setup');
      }
    } catch (error) {
      // Setup not complete or credentials file doesn't exist
    }

    return null;
  }

  /**
   * Create admin user via Gitea API (install endpoint)
   * Falls back to checking if user exists and can authenticate
   */
  private async createAdminUser(password: string): Promise<boolean> {
    logger.info('👤 Creating Gitea admin user via API...', { username: this.config.adminUsername });

    try {
      // First, check if we can already authenticate (user may exist)
      try {
        const authResponse = await this.client.get('/api/v1/user', {
          auth: {
            username: this.config.adminUsername,
            password: password,
          },
        });
        if (authResponse.status === 200) {
          logger.info('✅ Admin user already exists and credentials work');
          return true;
        }
      } catch (authError: any) {
        // User doesn't exist or password is wrong, continue with creation
        logger.debug('User auth check failed, will try to create');
      }

      // Try Gitea's admin API if we have a way to auth
      // For first-time setup, Gitea might need installation via web or CLI
      // Since we can't use Docker exec, try the admin/users endpoint if accessible
      try {
        // Check if Gitea is in install mode (first run)
        const settingsResponse = await this.client.get('/api/v1/settings/api');
        logger.debug('Gitea settings accessible', { data: settingsResponse.data });
      } catch (e) {
        logger.debug('Could not access settings endpoint');
      }

      // If we reach here, user needs to be created via Gitea's install page
      // or CLI. For Docker Compose setups, INSTALL_LOCK=true skips the installer,
      // but we need to create the admin user another way.
      
      // Try to use Gitea's internal install API (works on some versions)
      try {
        const installResponse = await this.client.post('/install', {
          db_type: 'postgres',
          admin_name: this.config.adminUsername,
          admin_passwd: password,
          admin_confirm_passwd: password,
          admin_email: this.config.adminEmail,
        }, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        });
        
        if (installResponse.status < 400) {
          logger.info('✅ Admin user created via install endpoint');
          return true;
        }
      } catch (installError: any) {
        logger.debug('Install endpoint not available', { error: installError.message });
      }

      // Last resort: check if the default admin user was created by Gitea
      logger.warn('⚠️  Could not create admin user via API. Gitea may need manual setup or the user already exists with a different password.');
      logger.info('💡 Tip: Set GITEA_ADMIN_PASSWORD environment variable to a known password, or create user manually in Gitea web UI');
      
      return false;
    } catch (error: any) {
      logger.error('❌ Failed to create admin user', { error: error.message });
      return false;
    }
  }

  /**
   * Generate API token via Gitea API
   */
  private async generateApiToken(password: string): Promise<string | null> {
    logger.info('🔑 Generating Gitea API token...');

    const tokenName = `musical-local-${Date.now()}`;

    try {
      const response = await this.client.post(
        `/api/v1/users/${this.config.adminUsername}/tokens`,
        {
          name: tokenName,
          scopes: ['write:repository', 'write:user', 'write:organization'],
        },
        {
          auth: {
            username: this.config.adminUsername,
            password: password,
          },
        }
      );

      const token = response.data.sha1;
      if (token) {
        logger.info('✅ API token generated', { tokenName });
        return token;
      }
    } catch (error: any) {
      logger.error('❌ Failed to generate API token', { error: error.message });
    }

    return null;
  }

  /**
   * Create organization for projects
   */
  private async createOrganization(token: string): Promise<boolean> {
    logger.info('🏢 Creating organization...', { name: this.config.organization });

    try {
      await this.client.post(
        '/api/v1/orgs',
        {
          username: this.config.organization,
          full_name: 'Musical.run Projects',
          visibility: 'private',
        },
        {
          headers: { Authorization: `token ${token}` },
        }
      );

      logger.info('✅ Organization created');
      return true;
    } catch (error: any) {
      if (error.response?.status === 422) {
        logger.info('👍 Organization already exists');
        return true;
      }
      logger.warn('⚠️  Could not create organization', { error: error.message });
      return false;
    }
  }

  /**
   * Save credentials securely
   */
  private async saveCredentials(credentials: GiteaCredentials): Promise<void> {
    // Ensure secrets directory exists
    await fs.mkdir(this.config.secretsDir, { recursive: true });
    await fs.chmod(this.config.secretsDir, 0o700);

    // Save token file
    const tokenFile = path.join(this.config.secretsDir, 'gitea-token');
    await fs.writeFile(tokenFile, credentials.token);
    await fs.chmod(tokenFile, 0o600);

    // Save full credentials (for recovery)
    const credentialsFile = path.join(this.config.secretsDir, 'gitea-credentials.json');
    await fs.writeFile(credentialsFile, JSON.stringify(credentials, null, 2));
    await fs.chmod(credentialsFile, 0o600);

    logger.info('✅ Credentials saved securely', { 
      tokenFile, 
      credentialsFile,
    });
  }

  /**
   * Run auto-setup
   * @param providedPassword Optional password from environment variable (GITEA_ADMIN_PASSWORD)
   */
  async setup(providedPassword?: string): Promise<GiteaCredentials | null> {
    logger.info('🔧 Starting Gitea auto-setup...');

    // Check if already setup
    const existingCredentials = await this.isSetupComplete();
    if (existingCredentials) {
      return existingCredentials;
    }

    // Wait for Gitea
    if (!await this.waitForGitea()) {
      return null;
    }

    // Use provided password or generate a new one
    const adminPassword = providedPassword || this.generateSecureToken(24);
    if (providedPassword) {
      logger.info('🔐 Using provided admin password from environment');
    } else {
      logger.info('🔐 Generated new secure admin password');
    }

    // Create admin user
    await this.createAdminUser(adminPassword);

    // Wait a moment for user creation to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Generate API token
    const token = await this.generateApiToken(adminPassword);
    if (!token) {
      logger.error('❌ Failed to generate API token');
      return null;
    }

    // Create organization
    await this.createOrganization(token);

    // Prepare credentials
    const credentials: GiteaCredentials = {
      url: this.config.giteaUrl,
      username: this.config.adminUsername,
      token,
      password: adminPassword,
      organization: this.config.organization,
    };

    // Save credentials
    await this.saveCredentials(credentials);

    this.setupComplete = true;
    logger.info('✅ Gitea auto-setup complete!');

    return credentials;
  }

  /**
   * Get credentials if already setup
   */
  async getCredentials(): Promise<GiteaCredentials | null> {
    if (!this.setupComplete) {
      return await this.isSetupComplete();
    }

    const credentialsFile = path.join(this.config.secretsDir, 'gitea-credentials.json');
    try {
      const data = await fs.readFile(credentialsFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Read token from saved file
   */
  static async readSavedToken(secretsDir?: string): Promise<string | null> {
    const dir = secretsDir || path.join(process.env.HOME || '/root', '.musical', 'secrets');
    const tokenFile = path.join(dir, 'gitea-token');

    try {
      return (await fs.readFile(tokenFile, 'utf-8')).trim();
    } catch {
      return null;
    }
  }
}
