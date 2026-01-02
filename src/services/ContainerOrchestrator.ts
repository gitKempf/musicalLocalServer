/**
 * Container Orchestrator for Local Server
 * Creates isolated Docker containers per project
 * Ported from backup GVisorProvider - Real implementation, no mocks
 * 
 * Port Management:
 * - Uses centralized PortRegistry for database-backed port allocation
 * - Survives server restarts
 * - No port conflicts between containers
 */

import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import * as tar from 'tar-stream';
import { logger } from '../lib/logger';
import * as net from 'net';
import { getPortRegistry, PortRegistry } from './PortRegistry';

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
  private portRegistry: PortRegistry | null = null;
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
    this.baseImage = config.baseImage || 'node:20-bullseye-slim';
    this.dockerNetwork = config.dockerNetwork || 'bridge';
    this.giteaUrl = config.giteaUrl || 'http://host.docker.internal:17101';

    logger.info('🐳 ContainerOrchestrator initialized', {
      baseImage: this.baseImage,
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

      // Initialize port registry (database-backed)
      this.portRegistry = getPortRegistry();
      await this.portRegistry.initialize();

      // Scan existing containers to populate in-memory cache
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
   * Scan existing containers to populate in-memory cache
   * Port sync is now handled by PortRegistry
   */
  private async scanExistingContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: false });
      const projectContainers = containers.filter((c) =>
        c.Names.some((name) => name.includes('/project-project_'))
      );

      if (projectContainers.length > 0) {
        logger.info('🔍 Found existing project containers', {
          count: projectContainers.length,
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

    // Allocate ports using centralized registry
    const devServerPort = await this.allocatePort(projectId, 'project_dev');
    const previewPort = await this.allocatePort(projectId, 'project_preview');

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

      // Setup Claude hooks for auto-commit
      await this.setupClaudeHooks(container);

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

      // Mark ports as in use in the registry
      if (this.portRegistry) {
        await this.portRegistry.markPortInUse(devServerPort, containerId);
        await this.portRegistry.markPortInUse(previewPort, containerId);
      }

      return containerInfo;
    } catch (error) {
      // Release ports on failure
      await this.releasePorts(projectId);

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
   * Setup Claude hooks for auto-commit after code generation
   * These hooks automatically commit and push changes when Claude finishes generating code
   */
  private async setupClaudeHooks(container: Docker.Container): Promise<void> {
    try {
      logger.info('🔧 Setting up Claude hooks for auto-commit');

      // Create hooks directory
      await this.execInContainer(container, `
        mkdir -p /root/.claude/hooks
      `);

      // Create settings.json with Stop and SessionEnd hooks
      const settingsJson = JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'bash /root/.claude/hooks/commit-on-stop.sh'
                }
              ]
            }
          ],
          SessionEnd: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command', 
                  command: 'bash /root/.claude/hooks/commit-on-session-end.sh'
                }
              ]
            }
          ]
        }
      }, null, 2);

      await this.execInContainer(container, `
        cat > /root/.claude/settings.json << 'SETTINGS_EOF'
${settingsJson}
SETTINGS_EOF
      `);

      // Create commit-on-stop.sh hook script
      const commitOnStopScript = `#!/bin/bash
################################################################################
# Stop Hook - Commit when Claude finishes inference
################################################################################

# Read JSON input from stdin
INPUT=\$(cat)

# Parse JSON fields
SESSION_ID=\$(echo "\$INPUT" | jq -r '.session_id // "unknown"')
CWD=\$(echo "\$INPUT" | jq -r '.cwd // "/app"')
STOP_HOOK_ACTIVE=\$(echo "\$INPUT" | jq -r '.stop_hook_active // "false"')

LOG_FILE="/tmp/claude-hooks.log"

log() {
    echo "[\$(date -u +"%Y-%m-%d %H:%M:%S")] \$1" >> "\$LOG_FILE"
}

log "Stop hook triggered - Session: \$SESSION_ID, CWD: \$CWD"

# Change to working directory
cd "\$CWD" || cd /app || {
    log "Failed to change to directory"
    exit 0
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log "Not a git repository, skipping commit"
    exit 0
fi

# Prevent infinite loop
if [ "\$STOP_HOOK_ACTIVE" = "true" ]; then
    log "Stop hook already active, skipping"
    exit 0
fi

# Check for changes
if git diff-index --quiet HEAD -- 2>/dev/null; then
    if [ -z "\$(git ls-files --others --exclude-standard)" ]; then
        log "No changes to commit"
        exit 0
    fi
fi

TIMESTAMP=\$(date -u +"%Y-%m-%d %H:%M:%S UTC")
STATS=\$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=\$(git diff --name-only HEAD 2>/dev/null | head -10)
UNTRACKED_FILES=\$(git ls-files --others --exclude-standard | head -5)

ALL_FILES="\${MODIFIED_FILES}\${UNTRACKED_FILES:+
\$UNTRACKED_FILES}"

COMMIT_MSG="🤖 Claude inference complete (\${SESSION_ID:0:8})

Modified files:
\${ALL_FILES}

Statistics: \${STATS}
Timestamp: \${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"

# Stage all changes
git add -A

# Commit
if git commit -m "\$COMMIT_MSG" 2>/dev/null; then
    log "✅ Changes committed"
    echo "✅ Changes committed"
    
    # Push to remote
    CURRENT_BRANCH=\$(git branch --show-current 2>/dev/null || echo "main")
    if git push origin "\$CURRENT_BRANCH" 2>/dev/null; then
        log "✅ Pushed to remote"
        echo "✅ Pushed to remote"
    else
        log "⚠️ Could not push to remote"
    fi
else
    log "⚠️ No changes to commit"
fi

exit 0
`;

      await this.execInContainer(container, `
        cat > /root/.claude/hooks/commit-on-stop.sh << 'HOOK_EOF'
${commitOnStopScript}
HOOK_EOF
        chmod +x /root/.claude/hooks/commit-on-stop.sh
      `);

      // Create commit-on-session-end.sh hook script
      const commitOnSessionEndScript = `#!/bin/bash
################################################################################
# SessionEnd Hook - Final commit when session ends
################################################################################

INPUT=\$(cat)

SESSION_ID=\$(echo "\$INPUT" | jq -r '.session_id // "unknown"')
CWD=\$(echo "\$INPUT" | jq -r '.cwd // "/app"')
REASON=\$(echo "\$INPUT" | jq -r '.reason // "unknown"')

LOG_FILE="/tmp/claude-hooks.log"

log() {
    echo "[\$(date -u +"%Y-%m-%d %H:%M:%S")] \$1" >> "\$LOG_FILE"
}

log "SessionEnd hook triggered - Session: \$SESSION_ID, Reason: \$REASON"

cd "\$CWD" || cd /app || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log "Not a git repository"
    exit 0
fi

if git diff-index --quiet HEAD -- 2>/dev/null; then
    if [ -z "\$(git ls-files --others --exclude-standard)" ]; then
        log "No uncommitted changes"
        exit 0
    fi
fi

TIMESTAMP=\$(date -u +"%Y-%m-%d %H:%M:%S UTC")
STATS=\$(git diff --stat HEAD 2>/dev/null | tail -1)
MODIFIED_FILES=\$(git diff --name-only HEAD 2>/dev/null)
UNTRACKED_FILES=\$(git ls-files --others --exclude-standard)

ALL_FILES="\${MODIFIED_FILES}\${UNTRACKED_FILES:+
\$UNTRACKED_FILES}"

COMMIT_MSG="🤖 Claude session ended (\${SESSION_ID:0:8})

Reason: \${REASON}

Modified files:
\${ALL_FILES}

Statistics: \${STATS}
Timestamp: \${TIMESTAMP}

Co-Authored-By: Claude <noreply@anthropic.com>"

git add -A

if git commit -m "\$COMMIT_MSG" 2>/dev/null; then
    log "✅ Final session commit created"
    
    CURRENT_BRANCH=\$(git branch --show-current 2>/dev/null || echo "main")
    if git push origin "\$CURRENT_BRANCH" 2>/dev/null; then
        log "✅ Pushed to remote"
    fi
fi

exit 0
`;

      await this.execInContainer(container, `
        cat > /root/.claude/hooks/commit-on-session-end.sh << 'HOOK_EOF'
${commitOnSessionEndScript}
HOOK_EOF
        chmod +x /root/.claude/hooks/commit-on-session-end.sh
      `);

      // Install jq for JSON parsing in hooks (needed by the scripts)
      await this.execInContainer(container, `
        apt-get update -qq && apt-get install -y -qq jq >/dev/null 2>&1 || true
      `);

      logger.info('✅ Claude hooks configured for auto-commit');
    } catch (error: any) {
      logger.warn('⚠️  Failed to setup Claude hooks', { error: error.message });
      // Don't fail container creation if hooks setup fails
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

      // Configure Git credentials for Gitea (if token provided)
      if (options.giteaToken && options.giteaUser) {
        // Extract host from Gitea URL (e.g., local-gitea:3000)
        const giteaHost = this.giteaUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        
        // Set up credential helper to store credentials
        await this.execInContainer(container, `
          git config --global credential.helper store &&
          mkdir -p ~/.git-credentials &&
          echo "http://${options.giteaUser}:${options.giteaToken}@${giteaHost}" > ~/.git-credentials
        `);
        
        // Also configure URL rewriting to include credentials automatically
        await this.execInContainer(container, `
          git config --global url."http://${options.giteaUser}:${options.giteaToken}@${giteaHost}/".insteadOf "http://${giteaHost}/"
        `);
        
        logger.info('✅ Git credentials configured for Gitea', { giteaUser: options.giteaUser });
      }

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
   * This creates an actual Git repo and optionally connects it to Gitea
   */
  async initializeGitRepository(
    containerId: string,
    repoCloneUrl: string | null,
    projectName: string
  ): Promise<void> {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('🔧 Initializing Git repository in container', {
      containerId,
      repoCloneUrl: repoCloneUrl || '(local only)',
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

      // Set remote origin only if we have a Gitea repo URL
      if (repoCloneUrl) {
        // Convert external URL to internal Docker network URL with credentials
        // External: http://localhost:17101/musical/repo.git
        // Internal: http://musical:TOKEN@gitea:3000/musical/repo.git
        let internalUrl = repoCloneUrl;
        const giteaToken = process.env.GITEA_TOKEN;
        const giteaUser = process.env.GITEA_USERNAME || process.env.GITEA_ADMIN_USER || 'musical';
        
        // Replace localhost or external host with internal gitea hostname
        internalUrl = internalUrl.replace(/http:\/\/localhost:\d+/, 'http://gitea:3000');
        internalUrl = internalUrl.replace(/http:\/\/[^\/]+:\d+/, 'http://gitea:3000');
        
        // Add credentials to URL if we have them
        if (giteaToken && giteaUser) {
          internalUrl = internalUrl.replace('http://', `http://${giteaUser}:${giteaToken}@`);
        }
        
        await this.execInContainer(container, `
          cd /app &&
          git remote remove origin 2>/dev/null || true &&
          git remote add origin ${internalUrl}
        `);

        logger.info('✅ Git remote configured', { repoCloneUrl, internalUrl: internalUrl.replace(giteaToken || '', '***') });
      } else {
        logger.info('ℹ️  No remote configured (local Git only)');
      }

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

      // Release ports via registry
      await this.releasePorts(containerInfo.projectId);
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
   * Remove a container (stop if running, then remove)
   */
  async removeContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      
      // First try to stop the container
      try {
        await container.stop({ t: 5 }); // 5 second grace period
        logger.info('⏸️  Container stopped before removal', { containerId });
      } catch (stopError: any) {
        // Ignore "container already stopped" or "not running" errors
        if (stopError.statusCode !== 304 && stopError.statusCode !== 404) {
          logger.debug('Container stop warning (may already be stopped)', { containerId, error: stopError.message });
        }
      }

      // Remove the container
      await container.remove({ force: true, v: true }); // force remove, also remove volumes

      logger.info('🗑️  Container removed', { containerId });
    } catch (error: any) {
      // Ignore "container not found" errors
      if (error.statusCode === 404) {
        logger.debug('Container not found (already removed)', { containerId });
        return;
      }
      logger.error('❌ Failed to remove container', { containerId, error: error.message });
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
   * Allocate an available port for a project
   * Now uses the centralized PortRegistry for database-backed allocation
   */
  private async allocatePort(projectId: string, portType: 'project_dev' | 'project_preview'): Promise<number> {
    if (!this.portRegistry) {
      throw new Error('Port registry not initialized');
    }

    return this.portRegistry.allocatePort({
      projectId,
      portType,
    });
  }

  /**
   * Release ports for a project
   */
  private async releasePorts(projectId: string): Promise<void> {
    if (this.portRegistry) {
      await this.portRegistry.releaseProjectPorts(projectId);
    }
  }

  /**
   * Check if port is available (kept for compatibility)
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
