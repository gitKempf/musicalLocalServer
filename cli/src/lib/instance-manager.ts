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
   * Only shows instances with proper config OR that are actively running
   */
  async listInstances(): Promise<InstanceInfo[]> {
    const instances = new Map<string, InstanceInfo>();
    
    // First, load instances from config directory (authoritative source)
    const configuredInstances = this.getConfiguredInstanceIds();
    for (const instanceId of configuredInstances) {
      const config = this.getConfig(instanceId);
      instances.set(instanceId, {
        id: instanceId,
        name: config?.instanceName || instanceId,
        status: 'unknown',
        port: config?.musicalPort || 17100,
        giteaPort: config?.giteaPort || 17101,
        authenticated: false,
        health: {
          postgres: false,
          gitea: false,
          claudeAgent: false,
          localServer: false
        }
      });
    }
    
    // Then check Docker containers for running instances
    const containers = await this.docker.listContainers({ all: true });

    for (const container of containers) {
      const name = container.Names[0]?.replace('/', '') || '';
      
      // Match musical-local-* containers (running instances)
      const match = name.match(/^musical-local-(.+)$/);
      if (!match) continue;

      const instanceId = match[1];
      
      // Skip orphaned containers without config unless they're running
      if (!instances.has(instanceId) && container.State !== 'running') {
        continue;
      }
      
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

    // Load instance config to get ports and credentials
    const config = this.getConfig(instanceId);
    
    // Build environment variables for docker-compose
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      INSTANCE_ID: instanceId,
    };

    // Add config values if available
    if (config) {
      env.INSTANCE_NAME = config.instanceName || instanceId;
      env.MUSICAL_PORT = String(config.musicalPort || 17100);
      env.GITEA_PORT = String(config.giteaPort || 17101);
      env.GITEA_SSH_PORT = String(config.giteaSshPort || 2222);
      env.DB_PASSWORD = config.dbPassword || 'musical_secure_pass';
      env.GITEA_ADMIN_PASSWORD = config.giteaAdminPassword || '';
      env.GITEA_SECRET_KEY = config.giteaSecretKey || '';
      env.ENCRYPTION_KEY = config.encryptionKey || '';
      env.TUNNEL_ENABLED = String(config.tunnelEnabled ?? true);
      env.TUNNEL_ROUTER_URL = config.tunnelRouterUrl || 'https://musical.run';
      env.AUTH_SERVICE_URL = config.authServiceUrl || 'https://musical.run';
      if (config.anthropicApiKey) {
        env.ANTHROPIC_API_KEY = config.anthropicApiKey;
      }
    }

    // Also try to load .env file from install directory
    const envFiles = [
      path.join(installDir, `.env.${instanceId}`),
      path.join(installDir, '.env'),
    ];
    
    for (const envFile of envFiles) {
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key && valueParts.length > 0) {
              // Don't override already set values from config
              if (!env[key]) {
                env[key] = valueParts.join('=');
              }
            }
          }
        }
        break; // Only load first existing env file
      }
    }

    const composeFile = 'docker-compose.yml';
      
    const { stdout, stderr } = await execAsync(
      `cd "${installDir}" && docker compose -f ${composeFile} --project-name musical-${instanceId} up -d`,
      { env }
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

    // For default instance, try BOTH legacy names AND new naming convention
    const isDefault = instanceId === 'default';
    const containers = isDefault ? [
      // Legacy names (old installs)
      'musical-local',
      'musical-postgres',
      'musical-gitea',
      'musical-claude-agent',
      // New naming convention with -default suffix
      'musical-local-default',
      'musical-postgres-default',
      'musical-gitea-default',
      'musical-claude-agent-default'
    ] : [
      `musical-local-${instanceId}`,
      `musical-postgres-${instanceId}`,
      `musical-gitea-${instanceId}`,
      `musical-claude-agent-${instanceId}`
    ];

    // Stop local server first to allow graceful unregistration from tunnel router
    const localServerContainers = containers.filter(c => c.includes('local'));
    for (const name of localServerContainers) {
      try {
        const container = this.docker.getContainer(name);
        const info = await container.inspect().catch(() => null);
        if (info?.State?.Running) {
          console.log(chalk.dim(`  Stopping ${name} (allowing graceful tunnel unregistration)...`));
          await container.stop({ t: 10 }); // Give 10 seconds to unregister
        }
      } catch {
        // Container might not exist or already stopped
      }
    }

    // Then stop other containers
    const otherContainers = containers.filter(c => !c.includes('local'));
    for (const name of otherContainers) {
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

    // For default instance, try BOTH legacy names AND new naming convention
    const isDefault = instanceId === 'default';
    const containers = isDefault ? [
      // Legacy names (old installs)
      'musical-local',
      'musical-postgres',
      'musical-gitea',
      'musical-claude-agent',
      // New naming convention with -default suffix
      'musical-local-default',
      'musical-postgres-default',
      'musical-gitea-default',
      'musical-claude-agent-default'
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
    // First check if there's a saved config with installDir
    const config = this.getConfig(instanceId);
    if (config && (config as any).installDir && fs.existsSync((config as any).installDir)) {
      return (config as any).installDir;
    }

    // Check for docker-compose.yml in standard locations
    const possiblePaths = [
      path.join(process.env.HOME || '/root', `musical-local-server-${instanceId}`),
      '/root/local-server',
      path.join(process.cwd()),
      path.join(process.env.HOME || '/root', 'musical-local-server'),
    ];

    // Find path with docker-compose.yml that supports INSTANCE_ID
    for (const p of possiblePaths) {
      const composeFile = path.join(p, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) {
        // Check if this docker-compose.yml supports INSTANCE_ID
        try {
          const content = fs.readFileSync(composeFile, 'utf-8');
          if (content.includes('${INSTANCE_ID') || content.includes('INSTANCE_ID:-')) {
            return p;
          }
        } catch {
          // Can't read file, skip
        }
      }
    }

    // Last resort: return any path with docker-compose.yml
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
   * Get all configured instance IDs from the config directory
   */
  getConfiguredInstanceIds(): string[] {
    if (!fs.existsSync(this.configDir)) {
      return [];
    }
    return fs.readdirSync(this.configDir).filter(name => {
      const configPath = path.join(this.configDir, name, 'config.json');
      return fs.existsSync(configPath);
    });
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

  /**
   * Check if a single port is available on the system
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();
      
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false); // Other errors also mean port is not available
        }
      });
      
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      
      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Check if all ports for an instance are available
   * Returns an object with port availability status
   */
  async checkPortsAvailable(basePort: number): Promise<{
    available: boolean;
    serverPort: { port: number; available: boolean };
    giteaPort: { port: number; available: boolean };
    sshPort: { port: number; available: boolean };
    unavailablePorts: number[];
  }> {
    const serverPort = basePort;
    const giteaPort = basePort + 1;
    const sshPort = basePort + 100;

    const [serverAvailable, giteaAvailable, sshAvailable] = await Promise.all([
      this.isPortAvailable(serverPort),
      this.isPortAvailable(giteaPort),
      this.isPortAvailable(sshPort),
    ]);

    const unavailablePorts: number[] = [];
    if (!serverAvailable) unavailablePorts.push(serverPort);
    if (!giteaAvailable) unavailablePorts.push(giteaPort);
    if (!sshAvailable) unavailablePorts.push(sshPort);

    return {
      available: serverAvailable && giteaAvailable && sshAvailable,
      serverPort: { port: serverPort, available: serverAvailable },
      giteaPort: { port: giteaPort, available: giteaAvailable },
      sshPort: { port: sshPort, available: sshAvailable },
      unavailablePorts,
    };
  }

  /**
   * Find the next available port range starting from a base port
   */
  async findAvailablePortRange(startPort: number = 17100, maxAttempts: number = 20): Promise<number | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + (i * 100);
      const result = await this.checkPortsAvailable(port);
      if (result.available) {
        return port;
      }
    }
    return null;
  }
}
