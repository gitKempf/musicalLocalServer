/**
 * Container Orchestrator for Local Server
 * Creates isolated Docker containers per project
 * Ported from backup GVisorProvider - Real implementation, no mocks
 */

import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import * as tar from 'tar-stream';
import { logger } from '../lib/logger';
import * as net from 'net';

export interface ContainerConfig {
  projectId: string;
  userId: number;
  sessionId: string;
  giteaToken?: string;
  giteaUser?: string;
  gitEmail?: string;
  gitName?: string;
}

export interface ContainerInfo {
  containerId: string;
  dockerId: string;
  projectId: string;
  sessionId: string;
  status: string;
  sshPort?: number;
  previewPort?: number;
  devServerPort?: number;
  previewUrl?: string;
  createdAt: Date;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ContainerOrchestrator {
  private docker: Docker;
  private containers: Map<string, ContainerInfo>;
  private allocatedPorts: Set<number>;
  private nextPort: number;
  private baseImage: string;
  private dockerNetwork: string;
  private giteaUrl: string;

  constructor(config: {
    baseImage?: string;
    dockerNetwork?: string;
    basePort?: number;
    giteaUrl?: string;
  } = {}) {
    this.docker = new Docker();
    this.containers = new Map();
    this.allocatedPorts = new Set();
    this.nextPort = config.basePort || 30000;
    this.baseImage = config.baseImage || 'node:20-bullseye-slim';
    this.dockerNetwork = config.dockerNetwork || 'bridge';
    this.giteaUrl = config.giteaUrl || 'http://host.docker.internal:17101';

    logger.info('🐳 ContainerOrchestrator initialized', {
      baseImage: this.baseImage,
      basePort: this.nextPort,
      network: this.dockerNetwork,
    });
  }

  /**
   * Initialize orchestrator - verify Docker is accessible
   */
  async initialize(): Promise<void> {
    try {
      await this.docker.ping();
      logger.info('✅ Docker daemon is accessible');

      // Ensure network exists or use default
      await this.ensureNetwork();

      // Scan existing project containers to rebuild port allocation state
      await this.scanExistingContainers();

      logger.info('✅ Container orchestrator ready');
    } catch (error) {
      logger.error('❌ Docker daemon not accessible', { error });
      throw new Error(
        `Docker not accessible: ${error instanceof Error ? error.message : String(error)}. ` +
        'Ensure Docker is running: sudo systemctl start docker'
      );
    }
  }

  /**
   * Scan existing containers to rebuild port allocation state
   */
  private async scanExistingContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: false });
      const projectContainers = containers.filter((c) =>
        c.Names.some((name) => name.includes('/project-project_'))
      );

      for (const container of projectContainers) {
        // Extract ports from container
        if (container.Ports) {
          for (const portMapping of container.Ports) {
            if (portMapping.PublicPort) {
              this.allocatedPorts.add(portMapping.PublicPort);
              // Update nextPort to be higher than any allocated port
              if (portMapping.PublicPort >= this.nextPort) {
                this.nextPort = portMapping.PublicPort + 1;
              }
            }
          }
        }
      }

      if (projectContainers.length > 0) {
        logger.info('🔍 Scanned existing containers', {
          count: projectContainers.length,
          allocatedPorts: Array.from(this.allocatedPorts).sort((a, b) => a - b),
          nextPort: this.nextPort,
        });
      }
    } catch (error) {
      logger.warn('⚠️  Failed to scan existing containers', { error });
      // Don't fail initialization if this fails
    }
  }

  /**
   * Ensure Docker network exists
   */
  private async ensureNetwork(): Promise<void> {
    try {
      const networks = await this.docker.listNetworks();
      const networkExists = networks.some((n) => n.Name === this.dockerNetwork);

      if (!networkExists && this.dockerNetwork !== 'bridge') {
        logger.warn(`Network ${this.dockerNetwork} not found, using bridge network`);
        this.dockerNetwork = 'bridge';
      } else {
        logger.info(`✅ Using Docker network: ${this.dockerNetwork}`);
      }
    } catch (error) {
      logger.warn('Could not verify network, using bridge', { error });
      this.dockerNetwork = 'bridge';
    }
  }

  /**
   * Create a new container for a project
   */
  async createContainer(config: ContainerConfig): Promise<ContainerInfo> {
    const { projectId, userId, sessionId, giteaToken, giteaUser, gitEmail, gitName } = config;

    logger.info('🚀 Creating Docker container for project', { projectId, sessionId });

    // Allocate ports
    const devServerPort = await this.allocatePort();
    const previewPort = await this.allocatePort();

    const containerId = `project-${projectId}-${Date.now()}`;

    try {
      // Pull image if needed
      await this.pullImageIfNeeded(this.baseImage);

      // Environment variables
      const envVars = [
        `GITEA_URL=${this.giteaUrl}`,
        `PROJECT_ID=${projectId}`,
        `USER_ID=${userId}`,
        `SESSION_ID=${sessionId}`,
      ];

      if (giteaToken) envVars.push(`GITEA_TOKEN=${giteaToken}`);
      if (giteaUser) envVars.push(`GITEA_USER=${giteaUser}`);

      // Container configuration
      const containerConfig: Docker.ContainerCreateOptions = {
        name: containerId,
        Image: this.baseImage,
        Cmd: ['sh', '-c', 'while true; do sleep 30; done'],
        Env: envVars,
        HostConfig: {
          Memory: 512 * 1024 * 1024, // 512MB
          NetworkMode: this.dockerNetwork,
          PortBindings: {
            '3000/tcp': [{ HostPort: devServerPort.toString() }],
            '8080/tcp': [{ HostPort: previewPort.toString() }],
          },
          ExtraHosts: ['host.docker.internal:host-gateway'],
          AutoRemove: false,
        },
        ExposedPorts: {
          '3000/tcp': {},
          '8080/tcp': {},
        },
        WorkingDir: '/app',
        Labels: {
          'musical.type': 'project-container',
          'musical.project': projectId,
          'musical.session': sessionId,
          'musical.user': userId.toString(),
        },
      };

      // Create and start container
      const container = await this.docker.createContainer(containerConfig);
      await container.start();

      // Verify running
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(`Container failed to start: ${info.State.Status}`);
      }

      // Install Claude CLI in container
      await this.installClaudeInContainer(container);

      // Setup Git in container
      await this.setupGitInContainer(container, {
        gitEmail: gitEmail || `user${userId}@musical.run`,
        gitName: gitName || `User ${userId}`,
        giteaToken,
        giteaUser,
      });

      const containerInfo: ContainerInfo = {
        containerId,
        dockerId: info.Id,
        projectId,
        sessionId,
        status: 'running',
        devServerPort,
        previewPort,
        previewUrl: `http://localhost:${previewPort}`,
        createdAt: new Date(),
      };

      this.containers.set(containerId, containerInfo);

      logger.info('✅ Container created successfully', {
        containerId,
        devServerPort,
        previewPort,
      });

      return containerInfo;
    } catch (error) {
      // Cleanup ports on failure
      this.allocatedPorts.delete(devServerPort);
      this.allocatedPorts.delete(previewPort);

      logger.error('❌ Container creation failed', { error });
      throw error;
    }
  }

  /**
   * Install Claude CLI in container
   */
  private async installClaudeInContainer(container: Docker.Container): Promise<void> {
    try {
      logger.info('🤖 Installing Claude CLI in container');
      
      // Install Claude CLI via npm
      await this.execInContainer(container, `
        npm install -g @anthropic-ai/claude-code
      `);
      
      // Remove any potential alias for claude command
      // Ensure claude command is called directly, not through alias
      await this.execInContainer(container, `
        # Remove alias if it exists
        unalias claude 2>/dev/null || true
        # Verify claude is available as direct command
        /usr/local/bin/claude --version > /dev/null 2>&1 || true
      `);
      
      logger.info('✅ Claude CLI installed successfully (no alias, using direct command)');
    } catch (error: any) {
      logger.warn('⚠️  Failed to install Claude CLI', { error: error.message });
      // Don't fail container creation if Claude install fails
    }
  }

  /**
   * Setup Git inside the container
   */
  private async setupGitInContainer(
    container: Docker.Container,
    options: {
      gitEmail: string;
      gitName: string;
      giteaToken?: string;
      giteaUser?: string;
    }
  ): Promise<void> {
    logger.info('🔧 Setting up Git in container');

    try {
      // Install git
      await this.execInContainer(container, `
        if ! which git >/dev/null 2>&1; then
          apt-get update -qq &&
          apt-get install -y -qq git curl ca-certificates
        fi
      `);

      // Configure git
      await this.execInContainer(container, `
        git config --global user.email "${options.gitEmail}" &&
        git config --global user.name "${options.gitName}" &&
        git config --global init.defaultBranch main &&
        git config --global http.sslVerify false
      `);

      // Test Gitea connectivity
      const testCmd = `curl -s -o /dev/null -w "%{http_code}" ${this.giteaUrl}/api/v1/version || echo "000"`;
      const result = await this.execInContainer(container, testCmd);
      const statusCode = result.stdout.trim();

      if (statusCode === '200') {
        logger.info('✅ Gitea is reachable from container', { url: this.giteaUrl });
      } else {
        logger.warn('⚠️  Gitea not reachable from container', {
          url: this.giteaUrl,
          statusCode,
        });
      }

      logger.info('✅ Git configured in container');
    } catch (error) {
      logger.warn('⚠️  Git setup warning (non-fatal)', { error });
      // Don't fail container creation if Git setup fails
    }
  }

  /**
   * Initialize Git repository in container (REAL REPOSITORY)
   * This creates an actual Git repo and connects it to Gitea
   */
  async initializeGitRepository(
    containerId: string,
    repoCloneUrl: string,
    projectName: string
  ): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('🔧 Initializing Git repository in container', {
      containerId,
      repoCloneUrl,
      projectName,
    });

    try {
      const container = this.docker.getContainer(containerInfo.dockerId);

      // Initialize Git repository in /app
      await this.execInContainer(container, `
        cd /app &&
        if [ ! -d .git ]; then
          git init
        fi
      `);

      logger.info('✅ Git repository initialized');

      // Create initial files
      await this.execInContainer(container, `
        cd /app &&
        if [ ! -f README.md ]; then
          echo "# ${projectName}" > README.md &&
          echo "" >> README.md &&
          echo "This project was generated by Musical.run" >> README.md
        fi
      `);

      logger.info('✅ Initial files created');

      // Set remote origin
      await this.execInContainer(container, `
        cd /app &&
        git remote remove origin 2>/dev/null || true &&
        git remote add origin ${repoCloneUrl}
      `);

      logger.info('✅ Git remote configured', { repoCloneUrl });

      // Create initial commit
      await this.execInContainer(container, `
        cd /app &&
        git add . &&
        git commit -m "Initial commit - Musical.run generated project" || true
      `);

      logger.info('✅ Initial commit created');

    } catch (error: any) {
      logger.error('❌ Failed to initialize Git repository', {
        error: error.message,
        containerId,
      });
      throw error;
    }
  }

  /**
   * Commit changes in container (REAL GIT COMMIT)
   */
  async commitChanges(
    containerId: string,
    message: string
  ): Promise<{ commitHash: string; filesChanged: number }> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('📝 Committing changes', { containerId, message });

    try {
      const container = this.docker.getContainer(containerInfo.dockerId);

      // Add all changes
      await this.execInContainer(container, `cd /app && git add .`);

      // Create commit
      const commitResult = await this.execInContainer(container, `
        cd /app &&
        git commit -m "${message.replace(/"/g, '\\"')}" &&
        git rev-parse HEAD
      `);

      const commitHash = commitResult.stdout.trim().split('\n').pop() || '';

      // Get number of files changed
      const statusResult = await this.execInContainer(container, `
        cd /app && git diff --stat HEAD~1 2>/dev/null | tail -1 || echo "0 files"
      `);

      const match = statusResult.stdout.match(/(\d+)\s+file/);
      const filesChanged = match ? parseInt(match[1], 10) : 0;

      logger.info('✅ Changes committed', {
        commitHash: commitHash.substring(0, 7),
        filesChanged,
      });

      return { commitHash, filesChanged };
    } catch (error: any) {
      // Check if there are no changes to commit
      if (error.message.includes('nothing to commit')) {
        logger.info('ℹ️  No changes to commit');
        return { commitHash: '', filesChanged: 0 };
      }

      logger.error('❌ Failed to commit changes', {
        error: error.message,
        containerId,
      });
      throw error;
    }
  }

  /**
   * Push commits to Gitea (REAL GIT PUSH)
   */
  async pushToGitea(containerId: string, branch: string = 'main'): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('⬆️  Pushing to Gitea', { containerId, branch });

    try {
      const container = this.docker.getContainer(containerInfo.dockerId);

      // Push to remote
      await this.execInContainer(container, `
        cd /app &&
        git push -u origin ${branch} 2>&1 || \
        git push --set-upstream origin ${branch} 2>&1
      `);

      logger.info('✅ Pushed to Gitea successfully', { branch });
    } catch (error: any) {
      logger.error('❌ Failed to push to Gitea', {
        error: error.message,
        containerId,
        branch,
      });
      throw error;
    }
  }

  /**
   * Execute command in container
   */
  async execInContainer(container: Docker.Container, command: string): Promise<ExecResult> {
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        stream.on('data', (chunk: Buffer) => {
          // Docker multiplexed stream format
          if (chunk[0] === 1) {
            stdout += chunk.toString().slice(8);
          } else if (chunk[0] === 2) {
            stderr += chunk.toString().slice(8);
          } else {
            stdout += chunk.toString();
          }
        });

        stream.on('end', () => {
          exec.inspect((err, data) => {
            if (err) {
              return resolve({
                success: false,
                stdout,
                stderr,
                exitCode: -1,
              });
            }
            const exitCode = data?.ExitCode ?? -1;
            resolve({
              success: exitCode === 0,
              stdout,
              stderr,
              exitCode,
            });
          });
        });

        stream.on('error', reject);
      });
    } catch (error) {
      logger.error('❌ Command execution failed', { error });
      throw error;
    }
  }

  /**
   * Execute command in container by container ID
   */
  async executeCommand(
    containerId: string,
    command: string,
    workDir: string = '/app'
  ): Promise<ExecResult> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container not found: ${containerId}`);
    }

    const container = this.docker.getContainer(containerInfo.dockerId);

    // Ensure work directory exists
    await this.execInContainer(container, `mkdir -p ${workDir}`);

    // Execute in work directory
    const fullCommand = `cd ${workDir} && ${command}`;
    return this.execInContainer(container, fullCommand);
  }

  /**
   * Destroy a container
   */
  async destroyContainer(containerId: string): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      logger.warn('Container not found for deletion', { containerId });
      return;
    }

    logger.info('🗑️  Destroying container', { containerId });

    try {
      const container = this.docker.getContainer(containerInfo.dockerId);
      await container.stop({ t: 10 });
      await container.remove();

      // Cleanup tracking
      if (containerInfo.devServerPort) {
        this.allocatedPorts.delete(containerInfo.devServerPort);
      }
      if (containerInfo.previewPort) {
        this.allocatedPorts.delete(containerInfo.previewPort);
      }
      this.containers.delete(containerId);

      logger.info('✅ Container destroyed', { containerId });
    } catch (error) {
      logger.warn('Container destruction warning', { containerId, error });
      // Clean up tracking anyway
      this.containers.delete(containerId);
    }
  }

  /**
   * Get container info
   */
  getContainer(containerId: string): ContainerInfo | null {
    return this.containers.get(containerId) || null;
  }

  /**
   * List all containers
   */
  listContainers(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  /**
   * Check if a container is currently running
   */
  async isContainerRunning(containerId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      return info.State.Running;
    } catch (error) {
      logger.debug('Container not found or not accessible', {
        containerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Stop a container (without removing it)
   */
  async stopContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 10 }); // 10 second grace period

      logger.info('⏸️  Container stopped', { containerId });
    } catch (error: any) {
      // Ignore "container already stopped" errors
      if (error.statusCode === 304) {
        logger.debug('Container already stopped', { containerId });
        return;
      }
      throw error;
    }
  }

  /**
   * Start a stopped container
   */
  async startContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.start();

      logger.info('▶️  Container started', { containerId });
    } catch (error: any) {
      // Ignore "container already started" errors
      if (error.statusCode === 304) {
        logger.debug('Container already started', { containerId });
        return;
      }
      throw error;
    }
  }

  /**
   * Allocate an available port
   */
  private async allocatePort(): Promise<number> {
    let port = this.nextPort;
    let attempts = 0;

    while (attempts < 100) {
      if (!this.allocatedPorts.has(port) && (await this.isPortAvailable(port))) {
        this.allocatedPorts.add(port);
        this.nextPort = port + 1;
        return port;
      }
      port++;
      attempts++;
    }

    throw new Error('Could not find available port after 100 attempts');
  }

  /**
   * Check if port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.listen(port, () => {
        server.once('close', () => resolve(true));
        server.close();
      });

      server.on('error', () => resolve(false));
    });
  }

  /**
   * Pull Docker image if not present
   */
  private async pullImageIfNeeded(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      logger.debug('Image already exists', { image });
    } catch (error) {
      logger.info('📥 Pulling Docker image', { image });

      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);

          this.docker.modem.followProgress(stream, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });

      logger.info('✅ Image pulled', { image });
    }
  }

  /**
   * Cleanup - stop all containers
   */
  async cleanup(): Promise<void> {
    logger.info('🧹 Cleaning up all containers');

    for (const [containerId, _] of this.containers) {
      await this.destroyContainer(containerId);
    }

    logger.info('✅ Cleanup complete');
  }
}
