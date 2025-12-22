/**
 * Instance Manager
 * 
 * Manages Docker containers and instances for Musical.run local servers.
 */

import Docker from 'dockerode';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import chalk from 'chalk';

const execAsync = promisify(exec);

export interface InstanceInfo {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'unknown';
  port: number;
  giteaPort: number;
  tunnelUrl?: string;
  authenticated: boolean;
  userId?: string;
  lastSeen?: Date;
  health?: {
    postgres: boolean;
    gitea: boolean;
    claudeAgent: boolean;
    localServer: boolean;
  };
}

export interface InstanceConfig {
  instanceId: string;
  instanceName: string;
  musicalPort: number;
  giteaPort: number;
  giteaSshPort: number;
  dbPassword: string;
  giteaAdminPassword: string;
  giteaSecretKey: string;
  encryptionKey: string;
  tunnelEnabled: boolean;
  tunnelRouterUrl: string;
  authServiceUrl: string;
  anthropicApiKey?: string;
}

export class InstanceManager {
  private docker: Docker;
  private configDir: string;

  constructor() {
    this.docker = new Docker();
    this.configDir = path.join(process.env.HOME || '/root', '.musical', 'instances');
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Get all Musical.run instances on this machine
   */
  async listInstances(): Promise<InstanceInfo[]> {
    const containers = await this.docker.listContainers({ all: true });
    const instances = new Map<string, InstanceInfo>();

    for (const container of containers) {
      const name = container.Names[0]?.replace('/', '') || '';
      
      // Match musical-local-* or musical-local containers
      const match = name.match(/^musical-local-(.+)$/) || (name === 'musical-local' ? ['', 'default'] : null);
      if (!match) continue;

      const instanceId = match[1] || 'default';
      
      // Get or create instance info
      let instance = instances.get(instanceId);
      if (!instance) {
        instance = {
          id: instanceId,
          name: instanceId,
          status: 'unknown',
          port: 17100,
          giteaPort: 17101,
          authenticated: false,
          health: {
            postgres: false,
            gitea: false,
            claudeAgent: false,
            localServer: false
          }
        };
        instances.set(instanceId, instance);
      }

      // Update status based on container state
      if (container.State === 'running') {
        instance.status = 'running';
        
        // Get port mapping
        const portMapping = container.Ports.find(p => p.PrivatePort === 17100);
        if (portMapping?.PublicPort) {
          instance.port = portMapping.PublicPort;
        }
      } else if (container.State === 'exited') {
        if (instance.status !== 'running') {
          instance.status = 'stopped';
        }
      }
    }

    // Fetch health info for running instances
    for (const instance of instances.values()) {
      if (instance.status === 'running') {
        try {
          const health = await this.getInstanceHealth(instance.port);
          instance.tunnelUrl = health.tunnelUrl;
          instance.authenticated = health.authenticated;
          instance.userId = health.userId;
          instance.name = health.instanceName || instance.id;
          instance.health = health.services;
        } catch {
          // Instance not responding
        }
      }
    }

    return Array.from(instances.values());
  }

  /**
   * Get health info from a running instance
   */
  async getInstanceHealth(port: number): Promise<{
    tunnelUrl?: string;
    authenticated: boolean;
    userId?: string;
    instanceName?: string;
    services: {
      postgres: boolean;
      gitea: boolean;
      claudeAgent: boolean;
      localServer: boolean;
    };
  }> {
    const response = await axios.get(`http://localhost:${port}/health`, { timeout: 5000 });
    const data = response.data;

    return {
      tunnelUrl: data.tunnelUrl,
      authenticated: data.authenticated === true,
      userId: data.userId,
      instanceName: data.instanceName,
      services: {
        postgres: data.services?.postgres?.healthy === true,
        gitea: data.services?.gitea?.healthy === true,
        claudeAgent: data.services?.claudeAgent?.healthy === true,
        localServer: true
      }
    };
  }

  /**
   * Get detailed status for a specific instance
   */
  async getInstanceStatus(instanceId: string): Promise<InstanceInfo | null> {
    const instances = await this.listInstances();
    return instances.find(i => i.id === instanceId) || null;
  }

  /**
   * Start an instance
   */
  async start(instanceId: string): Promise<void> {
    const installDir = this.getInstallDir(instanceId);
    if (!installDir) {
      throw new Error(`Cannot find installation directory for instance '${instanceId}'`);
    }

    console.log(chalk.blue(`Starting instance '${instanceId}'...`));

    const composeFile = 'docker-compose.yml';
    const { stdout, stderr } = await execAsync(
      `cd "${installDir}" && docker compose -f ${composeFile} --project-name musical-${instanceId} up -d`,
      { env: { ...process.env, INSTANCE_ID: instanceId } }
    );

    if (stderr && !stderr.includes('Started')) {
      console.log(chalk.yellow(stderr));
    }

    console.log(chalk.green(`✅ Instance '${instanceId}' started`));
  }

  /**
   * Stop an instance
   */
  async stop(instanceId: string): Promise<void> {
    console.log(chalk.blue(`Stopping instance '${instanceId}'...`));

    // For default instance, try legacy names first
    const isDefault = instanceId === 'default';
    const containers = isDefault ? [
      'musical-local',
      'musical-postgres',
      'musical-gitea',
      'musical-claude-agent'
    ] : [
      `musical-local-${instanceId}`,
      `musical-postgres-${instanceId}`,
      `musical-gitea-${instanceId}`,
      `musical-claude-agent-${instanceId}`
    ];

    for (const name of containers) {
      try {
        const container = this.docker.getContainer(name);
        await container.stop();
      } catch {
        // Container might not exist or already stopped
      }
    }

    console.log(chalk.green(`✅ Instance '${instanceId}' stopped`));
  }

  /**
   * Uninstall an instance completely
   */
  async uninstall(instanceId: string): Promise<void> {
    console.log(chalk.yellow(`⚠️  Uninstalling instance '${instanceId}'...`));

    // Stop containers
    await this.stop(instanceId);

    // For default instance, try legacy names first
    const isDefault = instanceId === 'default';
    const containers = isDefault ? [
      'musical-local',
      'musical-postgres',
      'musical-gitea',
      'musical-claude-agent'
    ] : [
      `musical-local-${instanceId}`,
      `musical-postgres-${instanceId}`,
      `musical-gitea-${instanceId}`,
      `musical-claude-agent-${instanceId}`
    ];

    for (const name of containers) {
      try {
        const container = this.docker.getContainer(name);
        await container.remove({ force: true });
      } catch {
        // Container might not exist
      }
    }

    // Remove volumes - try both naming conventions for default
    const volumes = isDefault ? [
      'musical-postgres-data',
      'musical-gitea-data',
      'musical-claude-home',
      'musical-data',
      'musical-postgres',
      'musical-gitea',
      'musical-claude',
      // Also try with -default suffix
      'musical-postgres-default',
      'musical-gitea-default',
      'musical-claude-default',
      'musical-data-default'
    ] : [
      `musical-postgres-${instanceId}`,
      `musical-gitea-${instanceId}`,
      `musical-claude-${instanceId}`,
      `musical-data-${instanceId}`
    ];

    for (const name of volumes) {
      try {
        const volume = this.docker.getVolume(name);
        await volume.remove({ force: true });
      } catch {
        // Volume might not exist
      }
    }

    // Remove network - try both naming conventions for default
    const networks = isDefault ? [
      'musical-network',
      'musical-local',
      'musical-network-default'
    ] : [
      `musical-network-${instanceId}`
    ];

    for (const name of networks) {
      try {
        const network = this.docker.getNetwork(name);
        await network.remove();
      } catch {
        // Network might not exist
      }
    }

    // Remove config
    const configPath = path.join(this.configDir, instanceId);
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { recursive: true });
    }

    console.log(chalk.green(`✅ Instance '${instanceId}' uninstalled`));
  }

  /**
   * Open shell into a container
   */
  async shell(instanceId: string, service: string = 'local'): Promise<void> {
    const containerName = this.getContainerName(instanceId, service);
    
    // Use spawn for interactive shell
    const proc = spawn('docker', ['exec', '-it', containerName, 'sh'], {
      stdio: 'inherit'
    });

    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Shell exited with code ${code}`));
      });
    });
  }

  /**
   * Get container name for a service
   * Handles both new naming (musical-local-instanceId) and legacy naming (musical-local)
   */
  private getContainerName(instanceId: string, service: string): string {
    const serviceMap: Record<string, string> = {
      'local': 'musical-local',
      'postgres': 'musical-postgres',
      'gitea': 'musical-gitea',
      'claude': 'musical-claude-agent'
    };

    const prefix = serviceMap[service] || `musical-${service}`;
    
    // For default instance, check if legacy container exists
    if (instanceId === 'default') {
      return prefix;  // Legacy name without suffix
    }
    
    return `${prefix}-${instanceId}`;
  }

  /**
   * Get container name, trying both new and legacy naming conventions
   */
  private async findContainerName(instanceId: string, service: string): Promise<string | null> {
    const serviceMap: Record<string, string> = {
      'local': 'musical-local',
      'postgres': 'musical-postgres',
      'gitea': 'musical-gitea',
      'claude': 'musical-claude-agent'
    };

    const prefix = serviceMap[service] || `musical-${service}`;
    
    // Try new naming convention first
    const newName = `${prefix}-${instanceId}`;
    try {
      const container = this.docker.getContainer(newName);
      await container.inspect();
      return newName;
    } catch {
      // Container doesn't exist with new name
    }

    // For default instance, try legacy name (without suffix)
    if (instanceId === 'default') {
      const legacyName = prefix;
      try {
        const container = this.docker.getContainer(legacyName);
        await container.inspect();
        return legacyName;
      } catch {
        // Legacy container doesn't exist either
      }
    }

    return null;
  }

  /**
   * Find installation directory for an instance
   */
  private getInstallDir(instanceId: string): string | null {
    const possiblePaths = [
      path.join(process.env.HOME || '/root', `musical-local-server-${instanceId}`),
      path.join(process.env.HOME || '/root', 'musical-local-server'),
      '/root/local-server',
      path.join(process.cwd())
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(path.join(p, 'docker-compose.yml'))) {
        return p;
      }
    }

    return null;
  }

  /**
   * Get configuration for an instance
   */
  getConfig(instanceId: string): InstanceConfig | null {
    const configPath = path.join(this.configDir, instanceId, 'config.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  /**
   * Save configuration for an instance
   */
  saveConfig(instanceId: string, config: InstanceConfig): void {
    const configDir = path.join(this.configDir, instanceId);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2),
      { mode: 0o600 }
    );
  }

  /**
   * Generate secure random string
   */
  generateSecret(length: number = 32): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    const randomBytes = require('crypto').randomBytes(length);
    for (let i = 0; i < length; i++) {
      result += chars[randomBytes[i] % chars.length];
    }
    return result;
  }
}
