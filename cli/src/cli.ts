#!/usr/bin/env node
/**
 * Musical.run Local Server CLI
 * 
 * Interactive TUI for managing multiple local server instances.
 * Similar to Claude Code CLI interface.
 */

import { Command } from 'commander';
import { InteractiveUI } from './ui/interactive';
import { InstanceManager } from './lib/instance-manager';
import { AuthManager } from './lib/auth-manager';
import { ConfigManager } from './lib/config-manager';
import { listInstances, showStatus, startInstance, stopInstance, logsCommand } from './commands';
import chalk from 'chalk';

const program = new Command();

program
  .name('musical')
  .description('Musical.run Local Server CLI - Manage multiple server instances')
  .version('1.0.0');

// Interactive mode (default when no command specified)
program
  .command('ui', { isDefault: true })
  .description('Launch interactive UI')
  .action(async () => {
    const ui = new InteractiveUI();
    await ui.start();
  });

// List all instances
program
  .command('list')
  .alias('ls')
  .description('List all server instances')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    await listInstances(options);
  });

// Show status
program
  .command('status [instance]')
  .alias('st')
  .description('Show status of instance(s)')
  .option('-j, --json', 'Output as JSON')
  .action(async (instance, options) => {
    await showStatus(instance, options);
  });

// Start instance
program
  .command('start <instance>')
  .description('Start a server instance')
  .action(async (instance) => {
    await startInstance(instance);
  });

// Stop instance
program
  .command('stop <instance>')
  .description('Stop a server instance')
  .action(async (instance) => {
    await stopInstance(instance);
  });

// Restart instance
program
  .command('restart <instance>')
  .description('Restart a server instance')
  .action(async (instance) => {
    await stopInstance(instance);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await startInstance(instance);
  });

// View logs
program
  .command('logs <instance>')
  .description('View logs for an instance')
  .option('-s, --service <service>', 'Service to view logs for (local, postgres, gitea, claude)', 'local')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '100')
  .action(async (instance, options) => {
    await logsCommand(instance, options);
  });

// Install new instance
program
  .command('install')
  .description('Install a new server instance')
  .option('-i, --instance <id>', 'Instance identifier')
  .option('-p, --port <port>', 'Main server port')
  .option('-n, --name <name>', 'Human-readable instance name')
  .action(async (options) => {
    const ui = new InteractiveUI();
    await ui.installWizard(options);
  });

// Uninstall instance
program
  .command('uninstall <instance>')
  .description('Uninstall a server instance')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (instance, options) => {
    const manager = new InstanceManager();
    if (!options.yes) {
      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to uninstall instance '${instance}'? This will delete all data.`,
        default: false
      }]);
      if (!confirm) {
        console.log('Cancelled.');
        return;
      }
    }
    await manager.uninstall(instance);
  });

// Auth commands
const auth = program.command('auth').description('Authentication management');

auth
  .command('login [instance]')
  .description('Authenticate an instance with Musical.run')
  .action(async (instance) => {
    const authManager = new AuthManager();
    await authManager.login(instance);
  });

auth
  .command('logout [instance]')
  .description('Logout an instance from Musical.run')
  .action(async (instance) => {
    const authManager = new AuthManager();
    await authManager.logout(instance);
  });

auth
  .command('status [instance]')
  .description('Show authentication status')
  .action(async (instance) => {
    const authManager = new AuthManager();
    await authManager.showStatus(instance);
  });

// Config commands
const config = program.command('config').description('Configuration management');

config
  .command('show [instance]')
  .description('Show configuration for an instance')
  .action(async (instance) => {
    const configManager = new ConfigManager();
    await configManager.show(instance);
  });

config
  .command('set <key> <value>')
  .description('Set a configuration value')
  .option('-i, --instance <instance>', 'Instance to configure')
  .action(async (key, value, options) => {
    const configManager = new ConfigManager();
    await configManager.set(key, value, options.instance);
  });

config
  .command('edit [instance]')
  .description('Edit configuration interactively')
  .action(async (instance) => {
    const ui = new InteractiveUI();
    await ui.configEditor(instance);
  });

// Shell into container
program
  .command('shell <instance>')
  .alias('sh')
  .description('Open shell in local-server container')
  .option('-s, --service <service>', 'Service to shell into', 'local')
  .action(async (instance, options) => {
    const manager = new InstanceManager();
    await manager.shell(instance, options.service);
  });

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
  console.log(`Run ${chalk.cyan('musical --help')} for usage.`);
  process.exit(1);
});

// Run
program.parse();
