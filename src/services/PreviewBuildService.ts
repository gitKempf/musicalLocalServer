/**
 * Preview Build Service
 * 
 * Handles automatic preview builds triggered by Gitea webhooks.
 * When code is pushed to Gitea (by Claude hooks or manually), this service:
 * 1. Creates or reuses a preview container
 * 2. Clones/pulls the latest code from Gitea
 * 3. Installs dependencies
 * 4. Starts a preview server
 * 5. Returns the preview URL
 * 
 * Port Management:
 * - Uses centralized PortRegistry for database-backed port allocation
 * - Survives server restarts, no port conflicts
 * 
 * NO MOCKS - Real implementation only
 */

import { v4 as uuidv4 } from 'uuid';
import Docker from 'dockerode';
import { logger } from '../lib/logger';
import { query } from '../lib/database';
import { ContainerOrchestrator } from './ContainerOrchestrator';
import { getPortRegistry, PortRegistry } from './PortRegistry';

export interface BuildConfig {
  projectId: string;
  commitHash: string;
  branch: string;
  repoUrl: string;
  userId: number;
  pusher?: string;
  commitMessage?: string;
}

export interface BuildResult {
  buildId: string;
  projectId: string;
  commitHash: string;
  previewUrl: string;
  containerId: string;
  status: 'success' | 'failed' | 'building';
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface PreviewContainer {
  containerId: string;
  dockerId: string;
  projectId: string;
  port: number;
  status: string;
  previewUrl: string;
  traefikUrl?: string; // URL via Traefik: https://projectId.dev.musical.run
}

export class PreviewBuildService {
  private docker: Docker;
  private builds: Map<string, BuildResult>;
  private previewContainers: Map<string, PreviewContainer>;
  private buildLocks: Map<string, Promise<BuildResult>>; // Lock to prevent parallel builds
  private portRegistry: PortRegistry | null = null;
  private giteaUrl: string;
  private giteaToken: string;
  private giteaUser: string;
  private dockerNetwork: string;

  constructor(config: {
    giteaUrl?: string;
    giteaToken?: string;
    giteaUser?: string;
    dockerNetwork?: string;
    basePort?: number;
  } = {}) {
    this.docker = new Docker();
    this.builds = new Map();
    this.previewContainers = new Map();
    this.buildLocks = new Map();
    
    this.giteaUrl = config.giteaUrl || process.env.GITEA_URL || 'http://gitea:3000';
    this.giteaToken = config.giteaToken || process.env.GITEA_TOKEN || '';
    this.giteaUser = config.giteaUser || process.env.GITEA_USERNAME || 'musical';
    this.dockerNetwork = config.dockerNetwork || process.env.DOCKER_NETWORK || 'musical-network-main';

    logger.info('🏗️  PreviewBuildService initialized', {
      giteaUrl: this.giteaUrl,
      dockerNetwork: this.dockerNetwork,
    });
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    try {
      await this.docker.ping();
      logger.info('✅ PreviewBuildService: Docker daemon accessible');
      
      // Scan existing preview containers
      await this.scanExistingPreviewContainers();
      
    } catch (error) {
      logger.error('❌ PreviewBuildService: Docker not accessible', { error });
      throw error;
    }
  }

  /**
   * Scan existing preview containers to rebuild state
   * Note: Port tracking is now handled by PortRegistry which syncs from Docker on startup
   */
  private async scanExistingPreviewContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const previewContainers = containers.filter(c =>
        c.Names.some(name => name.includes('/preview-'))
      );

      let cleanedCount = 0;
      let runningCount = 0;

      for (const container of previewContainers) {
        // Clean up orphaned containers (Created state but not running)
        if (container.State === 'created' || container.State === 'exited') {
          try {
            logger.info('🧹 Cleaning up orphaned preview container', {
              name: container.Names[0],
              state: container.State,
            });
            const orphanContainer = this.docker.getContainer(container.Id);
            await orphanContainer.remove({ force: true });
            cleanedCount++;
          } catch (removeError) {
            logger.warn('⚠️  Failed to remove orphan container', { error: removeError });
          }
          continue;
        }

        if (container.State === 'running') {
          runningCount++;
        }
      }

      if (previewContainers.length > 0) {
        logger.info('🔍 Scanned existing preview containers', {
          total: previewContainers.length,
          running: runningCount,
          cleaned: cleanedCount,
        });
      }
    } catch (error) {
      logger.warn('⚠️  Failed to scan preview containers', { error });
    }
  }

  /**
   * Find a running preview container for a project directly from Docker
   */
  private async findRunningPreviewContainer(projectId: string): Promise<PreviewContainer | null> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const previewContainer = containers.find(c =>
        c.Names.some(name => name.includes(`/preview-${projectId}`)) &&
        c.State === 'running'
      );

      if (previewContainer) {
        // Extract port from the container - port is already tracked by PortRegistry
        let port = 31000; // Default, will be overwritten
        for (const portMapping of previewContainer.Ports || []) {
          if (portMapping.PublicPort && portMapping.PrivatePort === 3000) {
            port = portMapping.PublicPort;
            break;
          }
        }

        const containerName = previewContainer.Names[0].replace(/^\//, '');
        return {
          containerId: containerName,
          dockerId: previewContainer.Id,
          projectId,
          port,
          status: 'running',
          previewUrl: `http://localhost:${port}`,
        };
      }
    } catch (error) {
      logger.debug('Failed to find running preview container', { projectId, error });
    }
    return null;
  }

  /**
   * Trigger a build from a Gitea webhook
   * Uses a lock to prevent parallel builds for the same project
   */
  async triggerBuild(config: BuildConfig): Promise<BuildResult> {
    // Check if there's already a build in progress for this project
    const existingBuild = this.buildLocks.get(config.projectId);
    if (existingBuild) {
      logger.info('⏳ Build already in progress for project, waiting...', {
        projectId: config.projectId,
        commitHash: config.commitHash,
      });
      // Wait for the existing build to complete, then start a new one
      try {
        await existingBuild;
      } catch (error) {
        // Ignore errors from previous build
      }
    }

    // Create a new build promise and store it
    const buildPromise = this.executeBuild(config);
    this.buildLocks.set(config.projectId, buildPromise);

    try {
      return await buildPromise;
    } finally {
      // Clean up the lock
      this.buildLocks.delete(config.projectId);
    }
  }

  /**
   * Execute the actual build process
   */
  private async executeBuild(config: BuildConfig): Promise<BuildResult> {
    const buildId = uuidv4();
    const startedAt = new Date();

    logger.info('🚀 Starting preview build', {
      buildId,
      projectId: config.projectId,
      commitHash: config.commitHash,
      branch: config.branch,
    });

    const buildResult: BuildResult = {
      buildId,
      projectId: config.projectId,
      commitHash: config.commitHash,
      previewUrl: '',
      containerId: '',
      status: 'building',
      startedAt,
    };

    this.builds.set(buildId, buildResult);

    try {
      // Save build record to database
      await this.saveBuildRecord(buildResult, config);

      // Get or create preview container for this project
      const previewContainer = await this.getOrCreatePreviewContainer(config.projectId);
      buildResult.containerId = previewContainer.containerId;

      // Clone or pull latest code
      await this.syncCodeFromGitea(previewContainer, config);

      // Detect project type and install dependencies
      await this.installDependencies(previewContainer);

      // Start preview server
      const previewUrl = await this.startPreviewServer(previewContainer);
      buildResult.previewUrl = previewUrl;

      // Update build status
      buildResult.status = 'success';
      buildResult.completedAt = new Date();

      // Update database
      await this.updateBuildRecord(buildResult);

      // Update project with preview URL
      await this.updateProjectPreviewUrl(config.projectId, previewUrl, previewContainer.containerId);

      logger.info('✅ Preview build completed', {
        buildId,
        projectId: config.projectId,
        previewUrl,
        duration: `${(buildResult.completedAt.getTime() - startedAt.getTime()) / 1000}s`,
      });

      return buildResult;

    } catch (error: any) {
      buildResult.status = 'failed';
      buildResult.error = error.message;
      buildResult.completedAt = new Date();

      await this.updateBuildRecord(buildResult);

      logger.error('❌ Preview build failed', {
        buildId,
        projectId: config.projectId,
        error: error.message,
      });

      return buildResult;
    }
  }

  /**
   * Get or create a preview container for a project
   */
  private async getOrCreatePreviewContainer(projectId: string): Promise<PreviewContainer> {
    // Check if we already have a preview container for this project (in-memory)
    const existing = this.previewContainers.get(projectId);
    if (existing) {
      // Verify it's still running
      try {
        const container = this.docker.getContainer(existing.dockerId);
        const info = await container.inspect();
        if (info.State.Running) {
          logger.info('♻️  Reusing existing preview container (from memory)', {
            projectId,
            containerId: existing.containerId,
          });
          return existing;
        }
      } catch (error) {
        logger.debug('Existing container not available, will check Docker');
      }
    }

    // Check Docker directly for any running preview container for this project
    const runningContainer = await this.findRunningPreviewContainer(projectId);
    if (runningContainer) {
      logger.info('♻️  Found running preview container in Docker', {
        projectId,
        containerId: runningContainer.containerId,
      });
      this.previewContainers.set(projectId, runningContainer);
      return runningContainer;
    }

    // Check database for existing preview container
    const dbResult = await query(
      `SELECT preview_container_id, preview_port FROM projects WHERE id = $1`,
      [projectId]
    );

    if (dbResult.rows.length > 0 && dbResult.rows[0].preview_container_id) {
      try {
        const container = this.docker.getContainer(dbResult.rows[0].preview_container_id);
        const info = await container.inspect();
        if (info.State.Running) {
          // Use existing port from database, or get allocated port from PortRegistry
          const existingPort = dbResult.rows[0].preview_port || 31000;
          const previewContainer: PreviewContainer = {
            containerId: dbResult.rows[0].preview_container_id,
            dockerId: info.Id,
            projectId,
            port: existingPort,
            status: 'running',
            previewUrl: `http://localhost:${existingPort}`,
          };
          this.previewContainers.set(projectId, previewContainer);
          return previewContainer;
        }
      } catch (error) {
        logger.debug('DB container not found, creating new one');
      }
    }

    // Create new preview container
    return await this.createPreviewContainer(projectId);
  }

  /**
   * Create a new preview container
   */
  private async createPreviewContainer(projectId: string): Promise<PreviewContainer> {
    const containerId = `preview-${projectId}-${Date.now()}`;
    const port = await this.allocatePort(projectId, containerId);
    const traefikHost = `${projectId}.dev.musical.run`;

    logger.info('🐳 Creating preview container', { projectId, containerId, port, traefikHost });

    try {
      // Pull image if needed
      await this.pullImageIfNeeded('node:20-bullseye-slim');

      const containerConfig: Docker.ContainerCreateOptions = {
        name: containerId,
        Image: 'node:20-bullseye-slim',
        Cmd: ['sh', '-c', 'while true; do sleep 30; done'],
        Env: [
          `PROJECT_ID=${projectId}`,
          `GITEA_URL=${this.giteaUrl}`,
        ],
        HostConfig: {
          Memory: 512 * 1024 * 1024, // 512MB
          NetworkMode: this.dockerNetwork,
          PortBindings: {
            '3000/tcp': [{ HostPort: port.toString() }],
            '8080/tcp': [{ HostPort: (port + 1).toString() }],
          },
          ExtraHosts: ['host.docker.internal:host-gateway'],
        },
        ExposedPorts: {
          '3000/tcp': {},
          '8080/tcp': {},
        },
        WorkingDir: '/app',
        Labels: {
          'musical.type': 'preview-container',
          'musical.project': projectId,
          'musical.port': port.toString(),
          // Traefik labels for automatic routing
          'traefik.enable': 'true',
          [`traefik.http.routers.${containerId}.rule`]: `Host(\`${traefikHost}\`)`,
          [`traefik.http.routers.${containerId}.entrypoints`]: 'web',
          [`traefik.http.services.${containerId}.loadbalancer.server.port`]: '3000',
          'traefik.docker.network': 'musicalbackend_musical-network',
        },
      };

      const container = await this.docker.createContainer(containerConfig);
      await container.start();

      const info = await container.inspect();

      // Connect to Traefik network for routing via *.dev.musical.run
      try {
        const traefikNetwork = this.docker.getNetwork('musicalbackend_musical-network');
        await traefikNetwork.connect({ Container: info.Id });
        logger.info('🔗 Connected preview container to Traefik network', { containerId });
      } catch (networkError: any) {
        logger.warn('⚠️  Could not connect to Traefik network (routing via domain may not work)', {
          containerId,
          error: networkError.message,
        });
      }

      // Install basic tools
      await this.execInContainer(container, `
        apt-get update -qq &&
        apt-get install -y -qq git curl ca-certificates >/dev/null 2>&1
      `);

      // Configure git
      await this.execInContainer(container, `
        git config --global user.email "preview@musical.run" &&
        git config --global user.name "Musical Preview" &&
        git config --global http.sslVerify false
      `);

      const previewContainer: PreviewContainer = {
        containerId,
        dockerId: info.Id,
        projectId,
        port,
        status: 'running',
        previewUrl: `http://localhost:${port}`,
        traefikUrl: `http://${traefikHost}`,
      };

      this.previewContainers.set(projectId, previewContainer);
      // Port is already tracked by PortRegistry from allocatePort() call

      logger.info('✅ Preview container created', { containerId, port, traefikUrl: previewContainer.traefikUrl });

      return previewContainer;

    } catch (error: any) {
      // Release the port back to PortRegistry on failure
      if (this.portRegistry) {
        await this.portRegistry.releasePort(port).catch(e => 
          logger.warn('Failed to release port on error', { port, error: e })
        );
      }
      
      // Cleanup failed container if it exists
      try {
        const containers = await this.docker.listContainers({ all: true });
        const failedContainer = containers.find(c => 
          c.Names.some(name => name.includes(containerId))
        );
        if (failedContainer) {
          const container = this.docker.getContainer(failedContainer.Id);
          await container.remove({ force: true });
          logger.info('🧹 Cleaned up failed container', { containerId });
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      logger.error('❌ Failed to create preview container', { error: error.message });
      throw error;
    }
  }

  /**
   * Sync code from Gitea to preview container
   */
  private async syncCodeFromGitea(
    previewContainer: PreviewContainer,
    config: BuildConfig
  ): Promise<void> {
    const container = this.docker.getContainer(previewContainer.dockerId);
    
    // Build authenticated URL
    const authUrl = this.buildAuthenticatedGitUrl(config.repoUrl);

    logger.info('📥 Syncing code from Gitea', {
      projectId: config.projectId,
      commitHash: config.commitHash,
    });

    // Check if repo already exists
    const checkResult = await this.execInContainer(container, `
      [ -d /app/.git ] && echo "exists" || echo "new"
    `);

    if (checkResult.stdout.trim() === 'exists') {
      // Pull latest changes
      await this.execInContainer(container, `
        cd /app &&
        git remote set-url origin ${authUrl} &&
        git fetch origin &&
        git checkout ${config.branch} 2>/dev/null || git checkout -b ${config.branch} origin/${config.branch} &&
        git reset --hard origin/${config.branch}
      `);
    } else {
      // Clone repository
      await this.execInContainer(container, `
        rm -rf /app/* /app/.* 2>/dev/null || true &&
        git clone ${authUrl} /app &&
        cd /app &&
        git checkout ${config.branch} 2>/dev/null || true
      `);
    }

    // Checkout specific commit if provided
    if (config.commitHash && config.commitHash !== 'HEAD') {
      await this.execInContainer(container, `
        cd /app && git checkout ${config.commitHash} 2>/dev/null || true
      `);
    }

    logger.info('✅ Code synced from Gitea');
  }

  /**
   * Build authenticated Git URL for internal Docker network
   */
  private buildAuthenticatedGitUrl(repoUrl: string): string {
    // Convert external URL to internal
    let internalUrl = repoUrl
      .replace(/http:\/\/localhost:\d+/, 'http://gitea:3000')
      .replace(/http:\/\/[^\/]+:\d+/, 'http://gitea:3000');

    // Add credentials
    if (this.giteaToken && this.giteaUser) {
      internalUrl = internalUrl.replace('http://', `http://${this.giteaUser}:${this.giteaToken}@`);
    }

    return internalUrl;
  }

  /**
   * Install dependencies based on project type
   */
  private async installDependencies(previewContainer: PreviewContainer): Promise<void> {
    const container = this.docker.getContainer(previewContainer.dockerId);

    logger.info('📦 Installing dependencies', { projectId: previewContainer.projectId });

    // Detect project type
    const detectResult = await this.execInContainer(container, `
      cd /app &&
      if [ -f package.json ]; then echo "node"; 
      elif [ -f requirements.txt ]; then echo "python";
      elif [ -f index.html ]; then echo "static";
      else echo "unknown"; fi
    `);

    const projectType = detectResult.stdout.trim();

    switch (projectType) {
      case 'node':
        await this.execInContainer(container, `
          cd /app &&
          npm install --legacy-peer-deps 2>/dev/null || npm install 2>/dev/null || true
        `);
        break;

      case 'python':
        await this.execInContainer(container, `
          apt-get install -y -qq python3 python3-pip >/dev/null 2>&1 &&
          cd /app &&
          pip3 install -r requirements.txt 2>/dev/null || true
        `);
        break;

      case 'static':
        // No dependencies needed for static sites
        break;

      default:
        logger.warn('⚠️  Unknown project type, skipping dependency installation');
    }

    logger.info('✅ Dependencies installed', { projectType });
  }

  /**
   * Configure Vite to allow all hosts when behind a proxy
   * 
   * This is critical for tunnel-based preview access. Vite 5+ enforces
   * allowedHosts security by default, blocking requests from unknown hosts.
   * When requests come through cloudflare tunnel → local server → container,
   * Vite may see the container name or proxy hostname instead of localhost.
   * 
   * We solve this by:
   * 1. Patching vite.config.js to add server.allowedHosts: true
   * 2. Setting __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS env var as backup
   */
  private async configureViteAllowedHosts(container: Docker.Container): Promise<void> {
    try {
      // Check if this is a Vite project
      const checkViteResult = await this.execInContainer(container, `
        cd /app && 
        ([ -f vite.config.js ] || [ -f vite.config.ts ] || [ -f vite.config.mjs ] || [ -f vite.config.mts ]) && echo "vite" || 
        (grep -q "vite" package.json 2>/dev/null && echo "vite-dep") || 
        echo "not-vite"
      `);

      const projectType = checkViteResult.stdout.trim();
      
      if (projectType === 'not-vite') {
        logger.debug('Not a Vite project, skipping allowedHosts configuration');
        return;
      }

      logger.info('🔧 Configuring Vite allowedHosts for proxy access');

      // Strategy 1: Patch existing vite.config.js to add allowedHosts
      // This handles cases where config already exists
      const configFileName = await this.execInContainer(container, `
        cd /app &&
        if [ -f vite.config.ts ]; then echo "vite.config.ts";
        elif [ -f vite.config.mts ]; then echo "vite.config.mts";
        elif [ -f vite.config.js ]; then echo "vite.config.js";
        elif [ -f vite.config.mjs ]; then echo "vite.config.mjs";
        else echo "none"; fi
      `);

      const configFile = configFileName.stdout.trim();

      if (configFile !== 'none') {
        // Read the existing config
        const readResult = await this.execInContainer(container, `cat /app/${configFile}`);
        let configContent = readResult.stdout;

        // Check if allowedHosts is already configured
        if (configContent.includes('allowedHosts')) {
          logger.debug('Vite config already has allowedHosts, skipping patch');
        } else {
          // Patch the config to add server.allowedHosts: true
          // Handle both cases: server block exists or doesn't exist
          
          if (configContent.includes('server:') || configContent.includes('server :')) {
            // Server block exists - add allowedHosts inside it
            // Insert after 'server: {' or 'server : {'
            configContent = configContent.replace(
              /server\s*:\s*\{/,
              'server: {\n    allowedHosts: true,'
            );
          } else if (configContent.includes('defineConfig(')) {
            // No server block - add one with allowedHosts
            // Insert before the closing }) of defineConfig
            configContent = configContent.replace(
              /defineConfig\s*\(\s*\{/,
              'defineConfig({\n  server: {\n    allowedHosts: true,\n  },'
            );
          } else {
            // Fallback: create a simple config file that should work
            logger.info('Creating minimal Vite config with allowedHosts');
            configContent = `
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
  },
});
`;
          }

          // Write the patched config
          // Use base64 encoding to safely write the file content
          const base64Content = Buffer.from(configContent).toString('base64');
          await this.execInContainer(container, `
            echo '${base64Content}' | base64 -d > /app/${configFile}
          `);
          
          logger.info('✅ Patched Vite config with allowedHosts: true');
        }
      } else if (projectType === 'vite-dep') {
        // Vite is a dependency but no config file exists
        // Create a minimal vite.config.js
        logger.info('Creating Vite config for project without one');
        
        const viteConfig = `
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
    port: 3000,
  },
});
`;
        const base64Content = Buffer.from(viteConfig).toString('base64');
        await this.execInContainer(container, `
          echo '${base64Content}' | base64 -d > /app/vite.config.js
        `);
        logger.info('✅ Created Vite config with allowedHosts: true');
      }

    } catch (error: any) {
      // Don't fail the build if config patching fails - the env var fallback may still work
      logger.warn('⚠️  Failed to configure Vite allowedHosts, trying env var fallback', {
        error: error.message,
      });
    }
  }

  /**
   * Start preview server based on project type
   */
  private async startPreviewServer(previewContainer: PreviewContainer): Promise<string> {
    const container = this.docker.getContainer(previewContainer.dockerId);

    logger.info('🚀 Starting preview server', { projectId: previewContainer.projectId });

    // Kill any existing server
    await this.execInContainer(container, `
      pkill -f "node" 2>/dev/null || true &&
      pkill -f "python" 2>/dev/null || true &&
      pkill -f "serve" 2>/dev/null || true
    `);

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Configure Vite to allow all hosts when behind a proxy
    // This is critical for tunnel-based preview access
    await this.configureViteAllowedHosts(container);

    // Detect and start appropriate server
    const detectResult = await this.execInContainer(container, `
      cd /app &&
      if [ -f package.json ]; then
        # Check for various start scripts
        if grep -q '"dev"' package.json; then echo "npm-dev";
        elif grep -q '"start"' package.json; then echo "npm-start";
        elif grep -q '"web"' package.json; then echo "npm-web";
        else echo "npm-serve"; fi
      elif [ -f requirements.txt ]; then echo "python";
      elif [ -f index.html ]; then echo "static";
      else echo "static"; fi
    `);

    const serverType = detectResult.stdout.trim();

    // Environment variables for Vite to allow all hosts through proxy
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS is a Vite internal env var
    // that adds additional allowed hosts without requiring config changes
    const viteEnvVars = '__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=true';

    // Start server in background
    switch (serverType) {
      case 'npm-dev':
        await this.execInContainer(container, `
          cd /app && ${viteEnvVars} nohup npm run dev -- --host 0.0.0.0 --port 3000 > /tmp/server.log 2>&1 &
        `);
        break;

      case 'npm-start':
        await this.execInContainer(container, `
          cd /app && ${viteEnvVars} PORT=3000 nohup npm start > /tmp/server.log 2>&1 &
        `);
        break;

      case 'npm-web':
        await this.execInContainer(container, `
          cd /app && ${viteEnvVars} nohup npm run web -- --port 3000 > /tmp/server.log 2>&1 &
        `);
        break;

      case 'npm-serve':
        // Use simple HTTP server for serving files
        await this.execInContainer(container, `
          npm install -g serve 2>/dev/null || true &&
          cd /app && nohup npx serve -l 3000 > /tmp/server.log 2>&1 &
        `);
        break;

      case 'python':
        await this.execInContainer(container, `
          cd /app && nohup python3 -m http.server 3000 > /tmp/server.log 2>&1 &
        `);
        break;

      case 'static':
      default:
        await this.execInContainer(container, `
          npm install -g serve 2>/dev/null || true &&
          cd /app && nohup npx serve -l 3000 > /tmp/server.log 2>&1 &
        `);
        break;
    }

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify server is running
    const checkResult = await this.execInContainer(container, `
      curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null || echo "000"
    `);

    const statusCode = checkResult.stdout.trim();
    if (statusCode !== '200' && statusCode !== '304') {
      logger.warn('⚠️  Server may not be ready yet', { statusCode, serverType });
    }

    const previewUrl = `http://localhost:${previewContainer.port}`;
    logger.info('✅ Preview server started', { previewUrl, serverType });

    return previewUrl;
  }

  /**
   * Save build record to database
   */
  private async saveBuildRecord(build: BuildResult, config: BuildConfig): Promise<void> {
    try {
      await query(
        `INSERT INTO preview_builds (
          id, project_id, commit_hash, status, preview_url, container_id,
          branch, pusher, commit_message, started_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          build.buildId,
          build.projectId,
          build.commitHash,
          build.status,
          build.previewUrl,
          build.containerId,
          config.branch,
          config.pusher || 'unknown',
          config.commitMessage || '',
          build.startedAt,
        ]
      );
    } catch (error: any) {
      // Table might not exist yet, log and continue
      if (error.code === '42P01') {
        logger.debug('preview_builds table does not exist, skipping record');
      } else {
        logger.warn('Failed to save build record', { error: error.message });
      }
    }
  }

  /**
   * Update build record in database
   */
  private async updateBuildRecord(build: BuildResult): Promise<void> {
    try {
      await query(
        `UPDATE preview_builds SET
          status = $1,
          preview_url = $2,
          container_id = $3,
          completed_at = $4,
          error = $5
        WHERE id = $6`,
        [
          build.status,
          build.previewUrl,
          build.containerId,
          build.completedAt,
          build.error || null,
          build.buildId,
        ]
      );
    } catch (error: any) {
      logger.debug('Failed to update build record', { error: error.message });
    }
  }

  /**
   * Update project with preview URL
   */
  private async updateProjectPreviewUrl(
    projectId: string,
    previewUrl: string,
    containerId: string
  ): Promise<void> {
    try {
      await query(
        `UPDATE projects SET
          preview_url = $1,
          preview_container_id = $2,
          updated_at = NOW()
        WHERE id = $3`,
        [previewUrl, containerId, projectId]
      );
    } catch (error: any) {
      logger.warn('Failed to update project preview URL', { error: error.message });
    }
  }

  /**
   * Execute command in container
   */
  private async execInContainer(
    container: Docker.Container,
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
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

        stream.on('end', () => resolve({ stdout, stderr }));
        stream.on('error', reject);
      });
    } catch (error) {
      logger.error('Command execution failed', { error });
      throw error;
    }
  }

  /**
   * Allocate an available port using the centralized PortRegistry
   */
  private async allocatePort(projectId: string, containerId?: string): Promise<number> {
    if (!this.portRegistry) {
      this.portRegistry = getPortRegistry();
    }
    return await this.portRegistry.allocatePort({
      projectId,
      portType: 'preview_container',
      containerId,
    });
  }

  /**
   * Pull Docker image if not present
   */
  private async pullImageIfNeeded(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
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
    }
  }

  /**
   * Get build status
   */
  getBuild(buildId: string): BuildResult | undefined {
    return this.builds.get(buildId);
  }

  /**
   * Get all builds for a project
   */
  async getProjectBuilds(projectId: string): Promise<BuildResult[]> {
    try {
      const result = await query(
        `SELECT * FROM preview_builds WHERE project_id = $1 ORDER BY started_at DESC LIMIT 10`,
        [projectId]
      );
      return result.rows.map(row => ({
        buildId: row.id,
        projectId: row.project_id,
        commitHash: row.commit_hash,
        previewUrl: row.preview_url,
        containerId: row.container_id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        error: row.error,
      }));
    } catch (error) {
      return [];
    }
  }

  /**
   * Clean up old preview containers
   */
  async cleanupOldContainers(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [projectId, previewContainer] of this.previewContainers.entries()) {
      try {
        const container = this.docker.getContainer(previewContainer.dockerId);
        const info = await container.inspect();
        const createdAt = new Date(info.Created).getTime();

        if (now - createdAt > maxAge) {
          await container.stop({ t: 10 });
          await container.remove();
          this.previewContainers.delete(projectId);
          
          // Release port back to PortRegistry
          if (this.portRegistry) {
            await this.portRegistry.releasePort(previewContainer.port).catch(e =>
              logger.warn('Failed to release port during cleanup', { port: previewContainer.port, error: e })
            );
          }
          
          cleaned++;
          logger.info('🧹 Cleaned up old preview container', { projectId, port: previewContainer.port });
        }
      } catch (error) {
        logger.debug('Failed to cleanup container', { projectId, error });
      }
    }

    return cleaned;
  }
}
