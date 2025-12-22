/**
 * Config Manager
 * 
 * Manages configuration for Musical.run local server instances.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { InstanceManager, InstanceConfig } from './instance-manager';

export class ConfigManager {
  private instanceManager: InstanceManager;
  private configDir: string;

  constructor() {
    this.instanceManager = new InstanceManager();
    this.configDir = path.join(process.env.HOME || '/root', '.musical', 'instances');
  }

  /**
   * Show configuration for an instance
   */
  async show(instanceId?: string): Promise<void> {
    if (instanceId) {
      await this.showInstanceConfig(instanceId);
    } else {
      // Show global config and list instances
      console.log('');
      console.log(chalk.bold('Musical.run Configuration'));
      console.log('');
      console.log(chalk.dim('Config directory: ') + this.configDir);
      console.log('');

      const instances = await this.instanceManager.listInstances();
      if (instances.length === 0) {
        console.log(chalk.dim('No instances configured'));
      } else {
        console.log(chalk.bold('Instances:'));
        for (const instance of instances) {
          const config = this.instanceManager.getConfig(instance.id);
          const port = config?.musicalPort || instance.port;
          console.log(`  ${chalk.cyan(instance.id)}: port ${port}`);
        }
      }
      console.log('');
    }
  }

  private async showInstanceConfig(instanceId: string): Promise<void> {
    const config = this.instanceManager.getConfig(instanceId);
    
    console.log('');
    console.log(chalk.bold(`Configuration: ${instanceId}`));
    console.log('');

    if (!config) {
      console.log(chalk.yellow('No configuration found for this instance'));
      console.log(chalk.dim('Run the install wizard or create config manually.'));
      return;
    }

    console.log(chalk.dim('Instance:'));
    console.log(`  ID: ${config.instanceId}`);
    console.log(`  Name: ${config.instanceName}`);
    console.log('');
    
    console.log(chalk.dim('Ports:'));
    console.log(`  Musical: ${config.musicalPort}`);
    console.log(`  Gitea HTTP: ${config.giteaPort}`);
    console.log(`  Gitea SSH: ${config.giteaSshPort}`);
    console.log('');

    console.log(chalk.dim('Cloud:'));
    console.log(`  Tunnel Enabled: ${config.tunnelEnabled}`);
    console.log(`  Tunnel Router: ${config.tunnelRouterUrl}`);
    console.log(`  Auth Service: ${config.authServiceUrl}`);
    console.log('');

    console.log(chalk.dim('Security:'));
    console.log(`  DB Password: ${chalk.dim('[hidden]')}`);
    console.log(`  Gitea Admin Password: ${chalk.dim('[hidden]')}`);
    console.log(`  Encryption Key: ${chalk.dim('[hidden]')}`);
    console.log('');
  }

  /**
   * Set a configuration value
   */
  async set(key: string, value: string, instanceId?: string): Promise<void> {
    const id = instanceId || 'default';
    let config = this.instanceManager.getConfig(id);

    if (!config) {
      // Create new config with defaults
      config = this.createDefaultConfig(id);
    }

    // Map of allowed config keys
    const keyMap: Record<string, keyof InstanceConfig> = {
      'name': 'instanceName',
      'instance-name': 'instanceName',
      'port': 'musicalPort',
      'musical-port': 'musicalPort',
      'gitea-port': 'giteaPort',
      'gitea-ssh-port': 'giteaSshPort',
      'tunnel-enabled': 'tunnelEnabled',
      'tunnel-url': 'tunnelRouterUrl',
      'auth-url': 'authServiceUrl',
      'anthropic-key': 'anthropicApiKey'
    };

    const configKey = keyMap[key];
    if (!configKey) {
      console.log(chalk.red(`Unknown config key: ${key}`));
      console.log('');
      console.log('Available keys:');
      Object.keys(keyMap).forEach(k => console.log(`  ${k}`));
      return;
    }

    // Type conversion
    let typedValue: any = value;
    if (['musicalPort', 'giteaPort', 'giteaSshPort'].includes(configKey)) {
      typedValue = parseInt(value, 10);
      if (isNaN(typedValue)) {
        console.log(chalk.red(`Invalid port number: ${value}`));
        return;
      }
    } else if (configKey === 'tunnelEnabled') {
      typedValue = value.toLowerCase() === 'true' || value === '1';
    }

    (config as any)[configKey] = typedValue;
    this.instanceManager.saveConfig(id, config);

    console.log(chalk.green(`✅ Set ${key} = ${value} for instance '${id}'`));
  }

  /**
   * Create default configuration
   */
  createDefaultConfig(instanceId: string): InstanceConfig {
    const manager = this.instanceManager;
    return {
      instanceId,
      instanceName: `Server ${instanceId}`,
      musicalPort: 17100,
      giteaPort: 17101,
      giteaSshPort: 2222,
      dbPassword: manager.generateSecret(32),
      giteaAdminPassword: manager.generateSecret(24),
      giteaSecretKey: manager.generateSecret(64),
      encryptionKey: manager.generateSecret(32),
      tunnelEnabled: true,
      tunnelRouterUrl: 'https://musical.run',
      authServiceUrl: 'https://musical.run'
    };
  }

  /**
   * Generate .env file from config
   */
  generateEnvFile(config: InstanceConfig): string {
    return `# Musical.run Local Server Configuration
# Instance: ${config.instanceId}
# Generated: ${new Date().toISOString()}

# Instance
INSTANCE_ID=${config.instanceId}
INSTANCE_NAME=${config.instanceName}

# Ports
MUSICAL_PORT=${config.musicalPort}
GITEA_PORT=${config.giteaPort}
GITEA_SSH_PORT=${config.giteaSshPort}

# Database
DB_PASSWORD=${config.dbPassword}

# Gitea
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=${config.giteaAdminPassword}
GITEA_SECRET_KEY=${config.giteaSecretKey}

# Security
ENCRYPTION_KEY=${config.encryptionKey}

# Cloud Connection
TUNNEL_ENABLED=${config.tunnelEnabled}
TUNNEL_ROUTER_URL=${config.tunnelRouterUrl}
AUTH_SERVICE_URL=${config.authServiceUrl}

# Auto-setup
AUTO_SETUP=true
AUTO_AUTH_ENABLED=false

# Optional: Anthropic API Key
${config.anthropicApiKey ? `ANTHROPIC_API_KEY=${config.anthropicApiKey}` : '# ANTHROPIC_API_KEY='}
`;
  }
}
