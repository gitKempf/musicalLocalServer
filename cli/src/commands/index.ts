/**
 * CLI Commands
 * 
 * Non-interactive command implementations.
 */

import chalk from 'chalk';
import { table } from 'table';
import { spawn } from 'child_process';
import { InstanceManager } from '../lib/instance-manager';

const instanceManager = new InstanceManager();

/**
 * List all instances
 */
export async function listInstances(options: { json?: boolean }): Promise<void> {
  const instances = await instanceManager.listInstances();

  if (options.json) {
    console.log(JSON.stringify(instances, null, 2));
    return;
  }

  if (instances.length === 0) {
    console.log(chalk.dim('No instances found.'));
    console.log(chalk.dim('Run `musical install` to create a new instance.'));
    return;
  }

  const data = [
    ['Instance', 'Status', 'Port', 'Tunnel', 'Auth'].map(h => chalk.bold(h))
  ];

  for (const instance of instances) {
    const statusColor = instance.status === 'running' ? chalk.green : chalk.red;
    const authIcon = instance.authenticated ? chalk.green('✓') : chalk.red('✗');
    
    let tunnelDisplay = '-';
    if (instance.tunnelUrl) {
      tunnelDisplay = instance.tunnelUrl.length > 30 
        ? instance.tunnelUrl.substring(0, 30) + '...'
        : instance.tunnelUrl;
    }

    // Show name if different from id, otherwise just show id
    const displayName = instance.name && instance.name !== instance.id 
      ? `${instance.name} (${instance.id})`
      : instance.id;

    data.push([
      chalk.cyan(displayName),
      statusColor(instance.status),
      String(instance.port),
      chalk.dim(tunnelDisplay),
      authIcon
    ]);
  }

  console.log(table(data, {
    border: {
      topBody: '',
      topJoin: '',
      topLeft: '',
      topRight: '',
      bottomBody: '',
      bottomJoin: '',
      bottomLeft: '',
      bottomRight: '',
      bodyLeft: '',
      bodyRight: '',
      bodyJoin: '',
      joinBody: '',
      joinLeft: '',
      joinRight: '',
      joinJoin: ''
    },
    drawHorizontalLine: () => false
  }));
}

/**
 * Show status for an instance
 */
export async function showStatus(instanceId?: string, options: { json?: boolean } = {}): Promise<void> {
  if (!instanceId) {
    await listInstances(options);
    return;
  }

  const instance = await instanceManager.getInstanceStatus(instanceId);

  if (!instance) {
    console.log(chalk.red(`Instance '${instanceId}' not found`));
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(instance, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold(`Instance: ${chalk.cyan(instance.id)}`));
  console.log('');

  const statusColor = instance.status === 'running' ? chalk.green : chalk.red;
  console.log(`  Status:        ${statusColor(instance.status)}`);
  console.log(`  Port:          ${instance.port}`);
  console.log(`  Gitea Port:    ${instance.giteaPort}`);
  
  if (instance.tunnelUrl) {
    console.log(`  Tunnel URL:    ${chalk.cyan(instance.tunnelUrl)}`);
  }
  
  console.log(`  Authenticated: ${instance.authenticated ? chalk.green('Yes') : chalk.red('No')}`);
  
  if (instance.userId) {
    console.log(`  User ID:       ${instance.userId}`);
  }

  if (instance.health) {
    console.log('');
    console.log(chalk.bold('  Services:'));
    const healthIcon = (healthy: boolean) => healthy ? chalk.green('✓') : chalk.red('✗');
    console.log(`    PostgreSQL:    ${healthIcon(instance.health.postgres)}`);
    console.log(`    Gitea:         ${healthIcon(instance.health.gitea)}`);
    console.log(`    Claude Agent:  ${healthIcon(instance.health.claudeAgent)}`);
    console.log(`    Local Server:  ${healthIcon(instance.health.localServer)}`);
  }

  console.log('');
}

/**
 * Start an instance
 */
export async function startInstance(instanceId: string): Promise<void> {
  try {
    await instanceManager.start(instanceId);
  } catch (error: any) {
    console.log(chalk.red(`Failed to start instance: ${error.message}`));
    process.exit(1);
  }
}

/**
 * Stop an instance
 */
export async function stopInstance(instanceId: string): Promise<void> {
  try {
    await instanceManager.stop(instanceId);
  } catch (error: any) {
    console.log(chalk.red(`Failed to stop instance: ${error.message}`));
    process.exit(1);
  }
}

/**
 * View logs for an instance
 */
export async function logsCommand(
  instanceId: string, 
  options: { service?: string; follow?: boolean; lines?: string }
): Promise<void> {
  const service = options.service || 'local';
  const serviceMap: Record<string, string> = {
    'local': 'musical-local',
    'postgres': 'musical-postgres',
    'gitea': 'musical-gitea',
    'claude': 'musical-claude-agent'
  };

  const prefix = serviceMap[service] || `musical-${service}`;
  
  // For default instance, use legacy name (without suffix)
  const containerName = instanceId === 'default' ? prefix : `${prefix}-${instanceId}`;

  const args = ['logs'];
  if (options.follow) args.push('-f');
  args.push('--tail', options.lines || '100');
  args.push(containerName);

  const proc = spawn('docker', args, { stdio: 'inherit' });

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Logs exited with code ${code}`));
    });
  });
}
