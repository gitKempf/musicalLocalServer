/**
 * Auth Manager
 * 
 * Handles authentication with Musical.run cloud service.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { InstanceManager } from './instance-manager';

export interface AuthInfo {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class AuthManager {
  private instanceManager: InstanceManager;
  private configDir: string;

  constructor() {
    this.instanceManager = new InstanceManager();
    this.configDir = path.join(process.env.HOME || '/root', '.musical');
  }

  /**
   * Start device authentication flow
   */
  async login(instanceId?: string): Promise<void> {
    const spinner = ora('Starting authentication...').start();

    try {
      // Get instance port
      let port = 17100;
      if (instanceId) {
        const instance = await this.instanceManager.getInstanceStatus(instanceId);
        if (!instance || instance.status !== 'running') {
          spinner.fail(`Instance '${instanceId}' is not running`);
          return;
        }
        port = instance.port;
      }

      // Start device auth flow
      const response = await axios.post(`http://localhost:${port}/api/auth/device`);
      const { deviceCode, userCode, verificationUrl, expiresIn } = response.data;

      spinner.stop();

      console.log('');
      console.log(chalk.bold('🔐 Device Authentication'));
      console.log('');
      console.log(`To authenticate, visit: ${chalk.cyan.underline(verificationUrl)}`);
      console.log('');
      console.log(`Enter code: ${chalk.bold.yellow(userCode)}`);
      console.log('');
      console.log(chalk.dim(`Code expires in ${Math.floor(expiresIn / 60)} minutes`));
      console.log('');

      // Poll for completion
      const pollSpinner = ora('Waiting for authentication...').start();
      const startTime = Date.now();
      const pollInterval = 5000;

      while (Date.now() - startTime < expiresIn * 1000) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
          const pollResponse = await axios.post(`http://localhost:${port}/api/auth/device/poll`, {
            deviceCode
          });

          if (pollResponse.data.authenticated) {
            pollSpinner.succeed('Authentication successful!');
            
            console.log('');
            console.log(chalk.green('✅ Logged in as: ') + chalk.bold(pollResponse.data.email));
            console.log(chalk.green('   User ID: ') + pollResponse.data.userId);
            console.log('');

            // Save auth info
            this.saveAuthInfo(instanceId || 'default', {
              userId: pollResponse.data.userId,
              email: pollResponse.data.email,
              accessToken: pollResponse.data.accessToken,
              refreshToken: pollResponse.data.refreshToken,
              expiresAt: new Date(pollResponse.data.expiresAt)
            });

            return;
          }
        } catch (err: any) {
          if (err.response?.status === 400 && err.response?.data?.error === 'authorization_pending') {
            // Still waiting, continue polling
            continue;
          }
          throw err;
        }
      }

      pollSpinner.fail('Authentication timed out');
    } catch (error: any) {
      spinner.fail(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Logout from Musical.run
   */
  async logout(instanceId?: string): Promise<void> {
    const id = instanceId || 'default';
    const authPath = path.join(this.configDir, 'instances', id, 'auth.json');

    if (fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
      console.log(chalk.green(`✅ Logged out from instance '${id}'`));
    } else {
      console.log(chalk.yellow(`Instance '${id}' is not logged in`));
    }
  }

  /**
   * Show authentication status
   */
  async showStatus(instanceId?: string): Promise<void> {
    if (instanceId) {
      await this.showInstanceAuthStatus(instanceId);
    } else {
      // Show all instances
      const instances = await this.instanceManager.listInstances();
      
      console.log('');
      console.log(chalk.bold('Authentication Status'));
      console.log('');

      if (instances.length === 0) {
        console.log(chalk.dim('No instances found'));
        return;
      }

      for (const instance of instances) {
        const authInfo = this.getAuthInfo(instance.id);
        const authStatus = authInfo ? chalk.green('✓ Authenticated') : chalk.red('✗ Not authenticated');
        const email = authInfo ? chalk.dim(` (${authInfo.email})`) : '';
        
        console.log(`  ${chalk.bold(instance.id)}: ${authStatus}${email}`);
      }
      console.log('');
    }
  }

  private async showInstanceAuthStatus(instanceId: string): Promise<void> {
    const authInfo = this.getAuthInfo(instanceId);

    console.log('');
    console.log(chalk.bold(`Authentication Status: ${instanceId}`));
    console.log('');

    if (!authInfo) {
      console.log(chalk.red('✗ Not authenticated'));
      console.log('');
      console.log(`Run ${chalk.cyan(`musical auth login ${instanceId}`)} to authenticate.`);
    } else {
      console.log(chalk.green('✓ Authenticated'));
      console.log(`  Email: ${authInfo.email}`);
      console.log(`  User ID: ${authInfo.userId}`);
      console.log(`  Expires: ${authInfo.expiresAt.toLocaleString()}`);
    }
    console.log('');
  }

  /**
   * Get saved auth info for an instance
   */
  getAuthInfo(instanceId: string): AuthInfo | null {
    const authPath = path.join(this.configDir, 'instances', instanceId, 'auth.json');
    
    if (!fs.existsSync(authPath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      return {
        ...data,
        expiresAt: new Date(data.expiresAt)
      };
    } catch {
      return null;
    }
  }

  /**
   * Save auth info for an instance
   */
  private saveAuthInfo(instanceId: string, authInfo: AuthInfo): void {
    const authDir = path.join(this.configDir, 'instances', instanceId);
    
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify(authInfo, null, 2),
      { mode: 0o600 }
    );
  }
}
