/**
 * Interactive UI
 * 
 * Terminal-based interactive UI for managing Musical.run instances.
 * Redesigned with two-level navigation:
 *   1. Instance selection
 *   2. Instance management (services, projects, settings)
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { InstanceManager, InstanceInfo, InstanceConfig } from '../lib/instance-manager';
import { AuthManager } from '../lib/auth-manager';
import { ConfigManager } from '../lib/config-manager';
import { spawn } from 'child_process';

// Service definition for local server
interface ServiceInfo {
  name: string;
  containerId: string;
  status: 'running' | 'stopped' | 'error';
  port?: number;
  description: string;
}

export class InteractiveUI {
  private instanceManager: InstanceManager;
  private authManager: AuthManager;
  private configManager: ConfigManager;

  constructor() {
    this.instanceManager = new InstanceManager();
    this.authManager = new AuthManager();
    this.configManager = new ConfigManager();
  }

  /**
   * Start the interactive UI
   */
  async start(): Promise<void> {
    console.clear();
    this.printHeader();

    // Main loop - instance selection
    while (true) {
      const selectedInstance = await this.showInstanceSelector();
      
      if (selectedInstance === 'quit') {
        console.log(chalk.dim('\nGoodbye! 👋\n'));
        break;
      }
      
      if (selectedInstance === 'install') {
        await this.installWizard({});
        console.clear();
        this.printHeader();
        continue;
      }

      // Enter instance management
      const shouldContinue = await this.manageInstance(selectedInstance);
      if (!shouldContinue) {
        break;
      }
      
      console.clear();
      this.printHeader();
    }
  }

  private printHeader(): void {
    console.log('');
    console.log(chalk.cyan.bold('  ╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('  ║') + chalk.white.bold('        🎵  Musical.run Local Server Manager  🎵        ') + chalk.cyan.bold('║'));
    console.log(chalk.cyan.bold('  ╚══════════════════════════════════════════════════════════╝'));
    console.log('');
  }

  /**
   * Screen 1: Instance Selector
   */
  private async showInstanceSelector(): Promise<string> {
    const instances = await this.instanceManager.listInstances();

    console.log(chalk.bold('  📦 Local Server Instances\n'));

    if (instances.length === 0) {
      console.log(chalk.dim('  No instances found. Install one to get started.\n'));
    } else {
      // Show instance table
      this.printInstanceTable(instances);
    }

    const choices: any[] = [];

    // Add each instance as a choice
    for (const instance of instances) {
      const statusIcon = instance.status === 'running' ? chalk.green('●') : chalk.red('○');
      const authIcon = instance.authenticated ? chalk.green('✓') : chalk.yellow('!');
      choices.push({
        name: `${statusIcon} ${instance.id} (port ${instance.port}) ${authIcon}`,
        value: instance.id
      });
    }

    if (instances.length > 0) {
      choices.push(new inquirer.Separator());
    }

    choices.push({ name: chalk.green('➕ Install new instance'), value: 'install' });
    choices.push({ name: chalk.red('❌ Quit'), value: 'quit' });

    const { selection } = await inquirer.prompt([{
      type: 'list',
      name: 'selection',
      message: 'Select an instance to manage:',
      choices,
      pageSize: 15
    }]);

    return selection;
  }

  private printInstanceTable(instances: InstanceInfo[]): void {
    const cols = { instance: 15, status: 10, port: 8, tunnel: 35, auth: 8 };

    console.log(
      chalk.dim('  ') +
      chalk.bold('Instance'.padEnd(cols.instance)) +
      chalk.bold('Status'.padEnd(cols.status)) +
      chalk.bold('Port'.padEnd(cols.port)) +
      chalk.bold('Tunnel URL'.padEnd(cols.tunnel)) +
      chalk.bold('Auth')
    );
    console.log(chalk.dim('  ' + '─'.repeat(cols.instance + cols.status + cols.port + cols.tunnel + cols.auth)));

    for (const instance of instances) {
      const statusColor = instance.status === 'running' ? chalk.green : chalk.red;
      const authIcon = instance.authenticated ? chalk.green('✓') : chalk.red('✗');
      
      let tunnelDisplay = '-';
      if (instance.tunnelUrl) {
        tunnelDisplay = instance.tunnelUrl.length > 32 
          ? instance.tunnelUrl.substring(0, 32) + '...'
          : instance.tunnelUrl;
      }

      console.log(
        '  ' +
        chalk.cyan(instance.id.padEnd(cols.instance)) +
        statusColor(instance.status.padEnd(cols.status)) +
        String(instance.port).padEnd(cols.port) +
        chalk.dim(tunnelDisplay.padEnd(cols.tunnel)) +
        authIcon
      );
    }
    console.log('');
  }

  /**
   * Screen 2: Instance Management
   * Returns false if user wants to quit entirely
   */
  private async manageInstance(instanceId: string): Promise<boolean> {
    while (true) {
      console.clear();
      this.printHeader();

      // Get fresh instance info
      const instance = await this.instanceManager.getInstanceStatus(instanceId);
      if (!instance) {
        console.log(chalk.red(`Instance '${instanceId}' not found.`));
        await this.pause();
        return true; // Go back to instance selector
      }

      // Show instance header
      this.printInstanceHeader(instance);

      // Get services status
      const services = await this.getServicesStatus(instanceId);
      this.printServicesTable(services);

      // Build menu based on instance state
      const action = await this.showInstanceMenu(instance, services);

      switch (action) {
        case 'back':
          return true; // Go back to instance selector
        
        case 'quit':
          return false; // Exit the app
        
        case 'authenticate':
          await this.handleAuthenticate(instanceId);
          break;
        
        case 'start':
          await this.handleStartInstance(instanceId);
          break;
        
        case 'stop':
          await this.handleStopInstance(instanceId);
          break;
        
        case 'restart':
          await this.handleRestartInstance(instanceId);
          break;
        
        case 'services':
          await this.handleServicesMenu(instanceId, services);
          break;
        
        case 'projects':
          await this.handleProjectsMenu(instanceId);
          break;
        
        case 'logs':
          await this.handleLogs(instanceId);
          break;
        
        case 'settings':
          await this.configEditor(instanceId);
          break;
        
        case 'uninstall':
          const uninstalled = await this.handleUninstall(instanceId);
          if (uninstalled) return true; // Go back to instance selector
          break;
        
        case 'refresh':
          // Just loop again
          break;
      }
    }
  }

  private printInstanceHeader(instance: InstanceInfo): void {
    const statusColor = instance.status === 'running' ? chalk.green : chalk.red;
    const statusIcon = instance.status === 'running' ? '●' : '○';
    
    console.log(chalk.bold(`  📦 Instance: ${chalk.cyan(instance.id)}`));
    console.log(chalk.dim('  ' + '─'.repeat(50)));
    console.log(`  Status:    ${statusColor(statusIcon + ' ' + instance.status)}`);
    console.log(`  Port:      ${instance.port}`);
    
    if (instance.tunnelUrl) {
      console.log(`  Tunnel:    ${chalk.dim(instance.tunnelUrl)}`);
    }
    
    if (instance.authenticated) {
      console.log(`  Auth:      ${chalk.green('✓ Authenticated')} ${instance.userId ? chalk.dim(`(${instance.userId})`) : ''}`);
    } else {
      console.log(`  Auth:      ${chalk.yellow('⚠ Not authenticated')}`);
    }
    console.log('');
  }

  /**
   * Get status of all services for an instance
   */
  private async getServicesStatus(instanceId: string): Promise<ServiceInfo[]> {
    const services: ServiceInfo[] = [];
    const Docker = require('dockerode');
    const docker = new Docker();

    const serviceDefinitions = [
      { name: 'Local Server', container: 'musical-local', port: 17100, description: 'Main API server' },
      { name: 'PostgreSQL', container: 'musical-postgres', port: 5432, description: 'Database' },
      { name: 'Gitea', container: 'musical-gitea', port: 17101, description: 'Git repository manager' },
      { name: 'Claude Agent', container: 'musical-claude-agent', port: 17110, description: 'AI coding assistant' },
    ];

    for (const def of serviceDefinitions) {
      // Try both legacy naming (for default) and new naming
      const containerNames = instanceId === 'default' 
        ? [def.container, `${def.container}-${instanceId}`]
        : [`${def.container}-${instanceId}`];

      let found = false;
      for (const containerName of containerNames) {
        try {
          const container = docker.getContainer(containerName);
          const info = await container.inspect();
          
          services.push({
            name: def.name,
            containerId: containerName,
            status: info.State.Running ? 'running' : 'stopped',
            port: def.port,
            description: def.description
          });
          found = true;
          break;
        } catch {
          // Container doesn't exist with this name
        }
      }

      if (!found) {
        services.push({
          name: def.name,
          containerId: `${def.container}-${instanceId}`,
          status: 'stopped',
          port: def.port,
          description: def.description
        });
      }
    }

    return services;
  }

  private printServicesTable(services: ServiceInfo[]): void {
    console.log(chalk.bold('  🔧 Services\n'));
    
    for (const service of services) {
      const statusIcon = service.status === 'running' 
        ? chalk.green('● running') 
        : chalk.red('○ stopped');
      
      console.log(`  ${service.name.padEnd(20)} ${statusIcon}`);
    }
    console.log('');
  }

  private async showInstanceMenu(instance: InstanceInfo, services: ServiceInfo[]): Promise<string> {
    const choices: any[] = [];
    const isRunning = instance.status === 'running';
    const runningServices = services.filter(s => s.status === 'running').length;

    // Authentication first if not authenticated
    if (!instance.authenticated) {
      choices.push({ name: chalk.yellow('🔐 Authenticate (required)'), value: 'authenticate' });
      choices.push(new inquirer.Separator());
    }

    // Instance control
    if (!isRunning) {
      choices.push({ name: '▶️  Start instance', value: 'start' });
    } else {
      choices.push({ name: '⏹️  Stop instance', value: 'stop' });
      choices.push({ name: '🔄 Restart instance', value: 'restart' });
    }

    choices.push(new inquirer.Separator());

    // Only show these if authenticated and running
    if (instance.authenticated && isRunning) {
      choices.push({ name: `🔧 Manage services (${runningServices}/${services.length} running)`, value: 'services' });
      choices.push({ name: '📁 Projects', value: 'projects' });
    }

    // Always available
    choices.push({ name: '📋 View logs', value: 'logs' });
    choices.push({ name: '⚙️  Settings', value: 'settings' });
    
    choices.push(new inquirer.Separator());
    choices.push({ name: '🔄 Refresh', value: 'refresh' });
    choices.push({ name: '⬅️  Back to instances', value: 'back' });
    choices.push({ name: chalk.red('🗑️  Uninstall instance'), value: 'uninstall' });
    choices.push(new inquirer.Separator());
    choices.push({ name: '❌ Quit', value: 'quit' });

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
      pageSize: 15
    }]);

    return action;
  }

  /**
   * Services management submenu
   */
  private async handleServicesMenu(instanceId: string, services: ServiceInfo[]): Promise<void> {
    while (true) {
      console.clear();
      this.printHeader();
      console.log(chalk.bold(`  🔧 Services for: ${chalk.cyan(instanceId)}\n`));

      // Show services with more detail
      for (const service of services) {
        const statusIcon = service.status === 'running' 
          ? chalk.green('● running') 
          : chalk.red('○ stopped');
        
        console.log(`  ${chalk.bold(service.name.padEnd(20))} ${statusIcon}`);
        console.log(chalk.dim(`    Container: ${service.containerId}`));
        if (service.port) {
          console.log(chalk.dim(`    Port: ${service.port}`));
        }
        console.log('');
      }

      const choices: any[] = [];

      // Add start/stop for each service
      for (const service of services) {
        if (service.status === 'running') {
          choices.push({ 
            name: `⏹️  Stop ${service.name}`, 
            value: `stop:${service.containerId}` 
          });
        } else {
          choices.push({ 
            name: `▶️  Start ${service.name}`, 
            value: `start:${service.containerId}` 
          });
        }
      }

      choices.push(new inquirer.Separator());
      choices.push({ name: '▶️  Start all services', value: 'start-all' });
      choices.push({ name: '⏹️  Stop all services', value: 'stop-all' });
      choices.push(new inquirer.Separator());
      // Future: Add service
      // choices.push({ name: '➕ Add new service', value: 'add' });
      choices.push({ name: '⬅️  Back', value: 'back' });

      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'Select action:',
        choices,
        pageSize: 15
      }]);

      if (action === 'back') {
        return;
      }

      if (action === 'start-all') {
        await this.instanceManager.start(instanceId);
        await this.pause();
        // Refresh services
        services.length = 0;
        services.push(...await this.getServicesStatus(instanceId));
        continue;
      }

      if (action === 'stop-all') {
        await this.instanceManager.stop(instanceId);
        await this.pause();
        services.length = 0;
        services.push(...await this.getServicesStatus(instanceId));
        continue;
      }

      if (action.startsWith('start:')) {
        const containerName = action.split(':')[1];
        await this.startContainer(containerName);
        await this.pause();
        services.length = 0;
        services.push(...await this.getServicesStatus(instanceId));
        continue;
      }

      if (action.startsWith('stop:')) {
        const containerName = action.split(':')[1];
        await this.stopContainer(containerName);
        await this.pause();
        services.length = 0;
        services.push(...await this.getServicesStatus(instanceId));
        continue;
      }
    }
  }

  private async startContainer(containerName: string): Promise<void> {
    const Docker = require('dockerode');
    const docker = new Docker();
    
    try {
      console.log(chalk.blue(`Starting ${containerName}...`));
      const container = docker.getContainer(containerName);
      await container.start();
      console.log(chalk.green(`✅ ${containerName} started`));
    } catch (error: any) {
      console.log(chalk.red(`❌ Failed to start ${containerName}: ${error.message}`));
    }
  }

  private async stopContainer(containerName: string): Promise<void> {
    const Docker = require('dockerode');
    const docker = new Docker();
    
    try {
      console.log(chalk.blue(`Stopping ${containerName}...`));
      const container = docker.getContainer(containerName);
      await container.stop();
      console.log(chalk.green(`✅ ${containerName} stopped`));
    } catch (error: any) {
      console.log(chalk.red(`❌ Failed to stop ${containerName}: ${error.message}`));
    }
  }

  /**
   * Projects submenu (placeholder for future)
   */
  private async handleProjectsMenu(instanceId: string): Promise<void> {
    console.clear();
    this.printHeader();
    console.log(chalk.bold(`  📁 Projects for: ${chalk.cyan(instanceId)}\n`));
    console.log(chalk.dim('  Project management coming soon...'));
    console.log(chalk.dim('  Projects are managed through the Musical.run web interface.'));
    console.log('');
    
    // TODO: Fetch projects from local server API
    // const response = await axios.get(`http://localhost:${port}/api/projects`);
    
    await this.pause();
  }

  private async handleAuthenticate(instanceId: string): Promise<void> {
    await this.authManager.login(instanceId);
    await this.pause();
  }

  private async handleStartInstance(instanceId: string): Promise<void> {
    await this.instanceManager.start(instanceId);
    await this.pause();
  }

  private async handleStopInstance(instanceId: string): Promise<void> {
    await this.instanceManager.stop(instanceId);
    await this.pause();
  }

  private async handleRestartInstance(instanceId: string): Promise<void> {
    console.log(chalk.blue('Restarting instance...'));
    await this.instanceManager.stop(instanceId);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.instanceManager.start(instanceId);
    await this.pause();
  }

  private async handleLogs(instanceId: string): Promise<void> {
    const { service } = await inquirer.prompt([{
      type: 'list',
      name: 'service',
      message: 'Select service:',
      choices: [
        { name: 'Local Server', value: 'local' },
        { name: 'PostgreSQL', value: 'postgres' },
        { name: 'Gitea', value: 'gitea' },
        { name: 'Claude Agent', value: 'claude' },
        new inquirer.Separator(),
        { name: '⬅️  Back', value: 'back' }
      ]
    }]);

    if (service === 'back') return;

    console.log(chalk.dim(`\nShowing logs. Press 'q' to return to menu.\n`));
    
    const containerName = this.getContainerName(instanceId, service);
    
    const proc = spawn('docker', ['logs', '-f', '--tail', '50', containerName], {
      stdio: ['ignore', 'inherit', 'inherit']
    });

    // Handle Ctrl+C and 'q' to exit logs
    const sigintHandler = () => { proc.kill('SIGTERM'); };
    process.on('SIGINT', sigintHandler);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const keyHandler = (key: Buffer) => {
        if (key.toString() === 'q' || key.toString() === '\u0003') {
          proc.kill('SIGTERM');
        }
      };
      process.stdin.on('data', keyHandler);
      
      await new Promise<void>(resolve => {
        proc.on('close', () => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', keyHandler);
          process.removeListener('SIGINT', sigintHandler);
          resolve();
        });
      });
    } else {
      await new Promise<void>(resolve => {
        proc.on('close', () => {
          process.removeListener('SIGINT', sigintHandler);
          resolve();
        });
      });
    }
    
    console.log(chalk.dim('\n--- Logs ended ---\n'));
  }

  private getContainerName(instanceId: string, service: string): string {
    const serviceMap: Record<string, string> = {
      'local': 'musical-local',
      'postgres': 'musical-postgres',
      'gitea': 'musical-gitea',
      'claude': 'musical-claude-agent'
    };
    const prefix = serviceMap[service] || `musical-${service}`;
    
    // For default instance, use legacy name (without suffix)
    if (instanceId === 'default') {
      return prefix;
    }
    
    return `${prefix}-${instanceId}`;
  }

  private async handleUninstall(instanceId: string): Promise<boolean> {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: chalk.red(`⚠️  This will DELETE ALL DATA for '${instanceId}'. Are you sure?`),
      default: false
    }]);

    if (!confirm) {
      console.log('Cancelled.');
      return false;
    }

    const { confirmAgain } = await inquirer.prompt([{
      type: 'input',
      name: 'confirmAgain',
      message: `Type "${instanceId}" to confirm deletion:`,
      validate: (input: string) => input === instanceId || 'Instance ID does not match'
    }]);

    if (confirmAgain !== instanceId) {
      console.log('Cancelled.');
      return false;
    }

    await this.instanceManager.uninstall(instanceId);
    await this.pause();
    return true;
  }

  /**
   * Configuration editor
   */
  async configEditor(instanceId: string): Promise<void> {
    let config = this.instanceManager.getConfig(instanceId);
    if (!config) {
      console.log(chalk.yellow(`No configuration found for '${instanceId}'.`));
      await this.pause();
      return;
    }

    console.log(chalk.bold(`\n⚙️  Settings: ${instanceId}\n`));

    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: 'What would you like to configure?',
      choices: [
        { name: `Instance Name: ${config.instanceName}`, value: 'instanceName' },
        { name: `Server Port: ${config.musicalPort}`, value: 'musicalPort' },
        { name: `Gitea Port: ${config.giteaPort}`, value: 'giteaPort' },
        { name: `Tunnel Enabled: ${config.tunnelEnabled}`, value: 'tunnelEnabled' },
        { name: `Tunnel Router URL: ${config.tunnelRouterUrl}`, value: 'tunnelRouterUrl' },
        new inquirer.Separator(),
        { name: 'Regenerate secrets', value: 'regenerate' },
        { name: '⬅️  Back', value: 'back' }
      ]
    }]);

    if (field === 'back') return;

    if (field === 'regenerate') {
      const { confirmRegen } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmRegen',
        message: chalk.yellow('This will regenerate all secrets. Restart required. Continue?'),
        default: false
      }]);

      if (confirmRegen) {
        config.dbPassword = this.instanceManager.generateSecret(32);
        config.giteaAdminPassword = this.instanceManager.generateSecret(24);
        config.giteaSecretKey = this.instanceManager.generateSecret(64);
        config.encryptionKey = this.instanceManager.generateSecret(32);
        this.instanceManager.saveConfig(instanceId, config);
        console.log(chalk.green('✅ Secrets regenerated. Restart the instance to apply.'));
      }
      await this.pause();
      return;
    }

    // Edit the selected field
    const currentValue = (config as any)[field];
    
    if (field === 'tunnelEnabled') {
      const { newValue } = await inquirer.prompt([{
        type: 'confirm',
        name: 'newValue',
        message: 'Enable tunnel?',
        default: currentValue
      }]);
      (config as any)[field] = newValue;
    } else if (field.includes('Port')) {
      const { newValue } = await inquirer.prompt([{
        type: 'input',
        name: 'newValue',
        message: `New value for ${field}:`,
        default: String(currentValue),
        validate: (input: string) => {
          const p = parseInt(input);
          return (!isNaN(p) && p >= 1024 && p <= 65535) || 'Invalid port number';
        }
      }]);
      (config as any)[field] = parseInt(newValue);
    } else {
      const { newValue } = await inquirer.prompt([{
        type: 'input',
        name: 'newValue',
        message: `New value for ${field}:`,
        default: currentValue
      }]);
      (config as any)[field] = newValue;
    }

    this.instanceManager.saveConfig(instanceId, config);
    console.log(chalk.green(`✅ Configuration updated. Restart to apply changes.`));
    await this.pause();
  }

  /**
   * Installation wizard
   */
  async installWizard(options: { instance?: string; port?: string; name?: string }): Promise<void> {
    console.log(chalk.bold('\n📦 Install New Instance\n'));

    const existingInstances = await this.instanceManager.listInstances();
    const usedPorts = new Set(existingInstances.map(i => i.port));

    // Instance ID
    let instanceId = options.instance;
    if (!instanceId) {
      const { id } = await inquirer.prompt([{
        type: 'input',
        name: 'id',
        message: 'Instance ID (e.g., home, work, dev):',
        default: existingInstances.length === 0 ? 'default' : undefined,
        validate: (input: string) => {
          if (!input) return 'Instance ID is required';
          if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(input)) {
            return 'ID must start with a letter and contain only letters, numbers, and hyphens';
          }
          if (existingInstances.some(i => i.id === input)) {
            return `Instance '${input}' already exists`;
          }
          return true;
        }
      }]);
      instanceId = id;
    }

    // Instance name
    const { instanceName } = await inquirer.prompt([{
      type: 'input',
      name: 'instanceName',
      message: 'Human-readable name:',
      default: options.name || `${instanceId!.charAt(0).toUpperCase() + instanceId!.slice(1)} Server`
    }]);

    // Port
    let port = options.port ? parseInt(options.port) : undefined;
    if (!port) {
      let suggestedPort = 17100;
      while (usedPorts.has(suggestedPort)) {
        suggestedPort += 100;
      }

      const { portInput } = await inquirer.prompt([{
        type: 'input',
        name: 'portInput',
        message: 'Main server port:',
        default: String(suggestedPort),
        validate: (input: string) => {
          const p = parseInt(input);
          if (isNaN(p) || p < 1024 || p > 65535) {
            return 'Port must be between 1024 and 65535';
          }
          if (usedPorts.has(p)) {
            return `Port ${p} is already in use by another instance`;
          }
          return true;
        }
      }]);
      port = parseInt(portInput);
    }

    // Create configuration
    const config: InstanceConfig = {
      instanceId: instanceId!,
      instanceName,
      musicalPort: port,
      giteaPort: port + 1,
      giteaSshPort: port + 100,
      dbPassword: this.instanceManager.generateSecret(32),
      giteaAdminPassword: this.instanceManager.generateSecret(24),
      giteaSecretKey: this.instanceManager.generateSecret(64),
      encryptionKey: this.instanceManager.generateSecret(32),
      tunnelEnabled: true,
      tunnelRouterUrl: 'https://musical.run',
      authServiceUrl: 'https://musical.run'
    };

    // Show summary
    console.log('');
    console.log(chalk.bold('Configuration Summary:'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(`  Instance ID:    ${chalk.cyan(config.instanceId)}`);
    console.log(`  Name:           ${config.instanceName}`);
    console.log(`  Server Port:    ${config.musicalPort}`);
    console.log(`  Gitea Port:     ${config.giteaPort}`);
    console.log(`  Gitea SSH:      ${config.giteaSshPort}`);
    console.log(chalk.dim('─'.repeat(40)));
    console.log('');

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Proceed with installation?',
      default: true
    }]);

    if (!confirm) {
      console.log('Cancelled.');
      return;
    }

    // Save configuration
    this.instanceManager.saveConfig(instanceId!, config);

    // Generate .env file
    const envContent = this.configManager.generateEnvFile(config);
    const fs = require('fs');
    const path = require('path');
    const installDir = process.cwd();
    
    const envPath = path.join(installDir, `.env.${instanceId}`);
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });

    console.log(chalk.green(`\n✅ Configuration saved to ${envPath}`));

    // Ask to start
    const { startNow } = await inquirer.prompt([{
      type: 'confirm',
      name: 'startNow',
      message: 'Start the instance now?',
      default: true
    }]);

    if (startNow) {
      await this.instanceManager.start(instanceId!);
    }

    console.log('');
    console.log(chalk.green.bold('Installation complete! 🎉'));
    console.log('');
    console.log(`Next: Authenticate with ${chalk.cyan(`musical auth login ${instanceId}`)}`);
    console.log('');
    
    await this.pause();
  }

  private async pause(): Promise<void> {
    await inquirer.prompt([{
      type: 'input',
      name: 'continue',
      message: chalk.dim('Press Enter to continue...')
    }]);
  }
}
