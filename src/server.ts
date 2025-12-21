/**
 * Musical.run Local Server - Main Entry Point
 *
 * Privacy-first code generation server that runs on user's local machine.
 * All code generation happens locally, with end-to-end encrypted communication.
 */

import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { logger } from './lib/logger';
import { encryptionService } from './lib/EncryptionService';
import { initializeDatabase } from './lib/database';
import { AuthService } from './services/AuthService';
import { CloudRegistrationService } from './services/CloudRegistrationService';
import { ClaudeSessionManager } from './services/ClaudeSessionManager';
import { TunnelRegistrationService } from './services/TunnelRegistrationService';
import { CloudflaredService } from './services/CloudflaredService';
import { ContainerOrchestrator } from './services/ContainerOrchestrator';
import { GiteaService } from './services/GiteaService';
import { GiteaAutoSetupService } from './services/GiteaAutoSetupService';
import { setupRoutes } from './routes';
import { setupSocketHandlers } from './sockets';
import { initializeSessionRoutes } from './routes/sessions';
import { initializeAuthRoutes } from './routes/auth';
import { initializeProjectRoutes } from './routes/projects';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 17100;
const CLOUD_REGISTRATION_ENABLED = process.env.CLOUD_REGISTRATION_ENABLED === 'true';
const TUNNEL_ENABLED = process.env.TUNNEL_ENABLED !== 'false'; // Default: true
const TUNNEL_ROUTER_URL = process.env.TUNNEL_ROUTER_URL || 'http://localhost:17200';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'https://musical.run';
const AUTO_AUTH_ENABLED = process.env.AUTO_AUTH_ENABLED !== 'false'; // Default: true

class LocalServer {
  private app: express.Application;
  private server: http.Server;
  private io: SocketIOServer;
  private authService: AuthService;
  private cloudRegistration: CloudRegistrationService;
  private claudeSessionManager: ClaudeSessionManager;
  private containerOrchestrator: ContainerOrchestrator;
  private giteaService: GiteaService | null = null;
  private cloudflared: CloudflaredService | null = null;
  private tunnelRegistration: TunnelRegistrationService | null = null;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST'],
      },
    });

    // Initialize AuthService with callback to setup tunnel after auth
    this.authService = new AuthService({
      authServiceUrl: AUTH_SERVICE_URL,
      callbackPort: 17105,
      onAuthenticated: async (tokenData) => {
        logger.info('🔐 Authentication completed, setting up tunnel...', { userId: tokenData.userId });
        await this.setupTunnel();
      },
    });

    this.cloudRegistration = new CloudRegistrationService();

    // Initialize Claude Session Manager
    const claudeAgentUrl = process.env.CLAUDE_AGENT_URL || 'http://claude-agent:17110';
    this.claudeSessionManager = new ClaudeSessionManager(claudeAgentUrl);

    // Initialize Container Orchestrator
    this.containerOrchestrator = new ContainerOrchestrator({
      baseImage: process.env.CONTAINER_BASE_IMAGE || 'node:20-bullseye-slim',
      dockerNetwork: process.env.DOCKER_NETWORK || 'bridge',
      basePort: parseInt(process.env.CONTAINER_BASE_PORT || '30000'),
      giteaUrl: process.env.GITEA_URL || 'http://host.docker.internal:17101',
    });
  }

  async initialize() {
    logger.info('🎵 Initializing Musical.run Local Server...');

    // Initialize database schema (creates tables if they don't exist)
    await initializeDatabase();
    logger.info('🗄️  Database initialized');

    // Initialize encryption
    await encryptionService.initialize();
    logger.info('🔐 Encryption service initialized');

    // Initialize authentication
    await this.authService.initialize();

    // Auto-authenticate with Musical.run (if enabled and not already authenticated)
    if (AUTO_AUTH_ENABLED && !this.authService.isAuthenticated()) {
      logger.info('🔑 Authenticating with Musical.run...');
      logger.info('');

      try {
        // Use CLI authentication (supports env vars and prompts)
        await this.authService.authenticate({ useCLI: true });
        logger.info('');
      } catch (error: any) {
        logger.error('❌ Authentication failed', { error: error.message });
        logger.warn('⚠️  Local server will work in offline mode (no cloud sync)');
        logger.info('💡 You can authenticate later via /api/auth endpoints');
      }
    } else if (this.authService.isAuthenticated()) {
      const userData = this.authService.getUserData();
      logger.info('✅ Already authenticated', {
        email: userData?.email,
        userId: userData?.userId,
      });
    }

    // Initialize Claude Session Manager with health check (optional for standalone mode)
    try {
      await this.claudeSessionManager.startHealthCheck();
      logger.info('🤖 Claude Session Manager initialized and healthy');
    } catch (error) {
      logger.warn('⚠️  Claude Agent not available - running in terminal-only mode');
      logger.info('💡 Users can still access containers via terminal and run `claude` commands manually');
      // Continue anyway - terminal access will still work
    }

    // Initialize Container Orchestrator
    try {
      await this.containerOrchestrator.initialize();
      logger.info('🐳 Container Orchestrator initialized successfully');
    } catch (error) {
      logger.error('❌ Container Orchestrator initialization failed', { error });
      throw new Error('Docker is required but not accessible. Make sure Docker is running.');
    }

    // Initialize Gitea Service (with auto-setup if not configured)
    const giteaUrl = process.env.GITEA_URL;
    let giteaToken = process.env.GITEA_TOKEN;
    let giteaUsername = process.env.GITEA_USERNAME || process.env.GITEA_ADMIN_USER;
    const giteaAdminPassword = process.env.GITEA_ADMIN_PASSWORD;
    const autoSetupEnabled = process.env.AUTO_SETUP !== 'false';

    // Try auto-setup if token is not provided and auto-setup is enabled
    if (giteaUrl && (!giteaToken || !giteaUsername) && autoSetupEnabled) {
      logger.info('🔧 Gitea token not configured, attempting auto-setup...');
      
      try {
        const autoSetup = new GiteaAutoSetupService({
          giteaUrl,
          giteaContainer: process.env.GITEA_CONTAINER || 'musical-gitea',
          adminUsername: giteaUsername || 'musical',
          organization: process.env.GITEA_ORGANIZATION || 'musical',
        });

        // Pass the admin password from environment if provided
        const credentials = await autoSetup.setup(giteaAdminPassword);
        if (credentials) {
          giteaToken = credentials.token;
          giteaUsername = credentials.username;
          logger.info('✅ Gitea auto-setup successful', { username: giteaUsername });
        }
      } catch (error: any) {
        logger.warn('⚠️  Gitea auto-setup failed', { error: error.message });
        logger.info('💡 You can manually configure GITEA_TOKEN in .env file');
      }
    }

    if (giteaUrl && giteaToken && giteaUsername) {
      try {
        this.giteaService = new GiteaService({
          baseURL: giteaUrl,
          token: giteaToken,
          username: giteaUsername,
          defaultOrganization: process.env.GITEA_ORGANIZATION,
        });

        // Test connection
        const version = await this.giteaService.testConnection();
        logger.info('✅ Gitea service initialized', { version, url: giteaUrl });
      } catch (error: any) {
        logger.warn('⚠️  Gitea service initialization failed', { error: error.message });
        logger.info('💡 Projects will be created without Git repositories');
        this.giteaService = null;
      }
    } else {
      logger.warn('⚠️  Gitea not configured (missing GITEA_URL, GITEA_TOKEN, or GITEA_USERNAME)');
      logger.info('💡 Projects will be created without Git repositories');
    }

    // Initialize session routes with services
    initializeSessionRoutes(this.claudeSessionManager, encryptionService, this.containerOrchestrator);

    // Initialize auth routes
    initializeAuthRoutes(this.authService);

    // Initialize project routes with Gitea service and container orchestrator
    initializeProjectRoutes(this.giteaService, this.containerOrchestrator);

    // Setup middleware
    this.setupMiddleware();

    // Setup routes
    setupRoutes(this.app);
    logger.info('🛣️  Routes configured');

    // Setup WebSocket handlers
    setupSocketHandlers(this.io);
    logger.info('🔌 WebSocket handlers configured');

    // Register with Musical.run cloud (if enabled)
    if (CLOUD_REGISTRATION_ENABLED) {
      try {
        await this.cloudRegistration.register();
        logger.info('☁️  Registered with Musical.run cloud');
      } catch (error) {
        logger.warn('⚠️  Could not register with cloud', { error });
        logger.info('💡 Local server will work in offline mode');
      }
    }

    // Setup tunnel (if enabled and authenticated)
    if (TUNNEL_ENABLED) {
      try {
        await this.setupTunnel();
        logger.info('🌐 Tunnel registration complete');
      } catch (error) {
        logger.warn('⚠️  Could not setup tunnel', { error });
        logger.info('💡 Local server will work without tunnel (direct access only)');
      }
    }

    logger.info('✅ Local server initialized successfully');
  }

  private async setupTunnel(): Promise<void> {
    logger.info('🌐 Setting up Cloudflare Tunnel...');

    // SECURITY: Do NOT set up tunnel without authentication
    if (!this.authService.isAuthenticated()) {
      logger.warn('⚠️  Cannot setup tunnel: User not authenticated');
      logger.info('💡 Please authenticate first via /api/auth/start');
      logger.info('💡 Tunnel will be automatically setup after authentication');
      return; // Exit without setting up tunnel
    }

    // Get authenticated user ID
    const userId = this.authService.getUserId();
    if (!userId) {
      logger.error('❌ Cannot setup tunnel: No user ID available');
      return;
    }

    logger.info('🔐 Setting up tunnel for authenticated user', { userId });

    // Initialize Cloudflared service
    this.cloudflared = new CloudflaredService({
      localPort: Number(PORT),
      protocol: 'http',
    });

    // Start Cloudflare Tunnel
    const tunnelUrl = await this.cloudflared.start();
    logger.info('✅ Cloudflare Tunnel started', { tunnelUrl });

    // Initialize Tunnel Registration service
    this.tunnelRegistration = new TunnelRegistrationService({
      tunnelRouterUrl: TUNNEL_ROUTER_URL,
      userId,
      serverType: 'local',
      heartbeatIntervalMs: 30000,
    });

    // Register tunnel with router
    await this.tunnelRegistration.register(tunnelUrl);
    logger.info('✅ Tunnel registered with router', { userId });
  }

  private setupMiddleware() {
    // CORS
    this.app.use(cors({
      origin: process.env.FRONTEND_URL || '*',
      credentials: true,
    }));

    // Logging
    this.app.use(morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    }));

    // Serve static files (terminal.html, etc.)
    const publicPath = path.join(__dirname, '../public');
    this.app.use(express.static(publicPath));
    logger.info(`📁 Serving static files from: ${publicPath}`);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      const userData = this.authService.getUserData();
      res.json({
        status: 'healthy',
        version: '1.0.0',
        uptime: process.uptime(),
        publicKey: encryptionService.getPublicKey(),
        authenticated: this.authService.isAuthenticated(),
        user: userData ? {
          userId: userData.userId,
          email: userData.email,
          fullName: userData.fullName,
        } : null,
        cloudConnected: this.cloudRegistration.isConnected(),
        tunnelConnected: this.tunnelRegistration?.isRegistered() || false,
        tunnelUrl: this.tunnelRegistration?.getTunnelUrl() || null,
      });
    });

    // Error handler
    this.app.use((err: any, req: Request, res: Response, next: any) => {
      logger.error('❌ Server error', { error: err.message, stack: err.stack });
      res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
      });
    });
  }

  async start() {
    await this.initialize();

    this.server.listen(PORT, () => {
      logger.info(`🚀 Musical.run Local Server running on port ${PORT}`);
      logger.info(`📡 WebSocket server ready`);
      logger.info(`🔑 Public Key: ${encryptionService.getPublicKey().substring(0, 32)}...`);
      logger.info('');

      // Display authentication info
      if (this.authService.isAuthenticated()) {
        const userData = this.authService.getUserData();
        logger.info('👤 Authenticated User:');
        logger.info(`   Email: ${userData?.email}`);
        logger.info(`   User ID: ${userData?.userId}`);
        logger.info('');
      }

      // Display tunnel info
      if (this.tunnelRegistration?.isRegistered()) {
        const tunnelUrl = this.tunnelRegistration.getTunnelUrl();
        const userId = this.authService.getUserId() || process.env.USER_ID || 'local_user';
        logger.info('🌐 Tunnel Information:');
        logger.info(`   Public URL: ${tunnelUrl}`);
        logger.info(`   User ID: ${userId}`);
        logger.info('');
      }

      logger.info('🎉 Ready to accept connections from Musical.run frontend');
      logger.info(`   Health check: http://localhost:${PORT}/health`);
      logger.info('');

      // Generate connection URL/QR code
      this.displayConnectionInfo();
    });
  }

  private displayConnectionInfo() {
    const connectionUrl = this.cloudRegistration.getConnectionUrl();
    if (connectionUrl) {
      logger.info('🔗 Connection URL:');
      logger.info(`   ${connectionUrl}`);
      logger.info('');
      logger.info('📱 Scan this QR code to connect:');

      // QR code will be generated by CloudRegistrationService
      this.cloudRegistration.displayQRCode();
    } else {
      logger.info('💡 Local mode: Connect manually using localhost:' + PORT);
    }
  }

  async shutdown() {
    logger.info('🛑 Shutting down local server...');

    // Cleanup containers
    try {
      await this.containerOrchestrator.cleanup();
      logger.info('✅ Containers cleaned up');
    } catch (error) {
      logger.warn('⚠️  Could not cleanup containers', { error });
    }

    // Cleanup Claude Session Manager
    this.claudeSessionManager.cleanup();

    // Unregister tunnel
    if (this.tunnelRegistration) {
      try {
        await this.tunnelRegistration.unregister();
        this.tunnelRegistration.cleanup();
      } catch (error) {
        logger.warn('⚠️  Could not unregister tunnel', { error });
      }
    }

    // Stop Cloudflare Tunnel
    if (this.cloudflared) {
      this.cloudflared.cleanup();
    }

    // Unregister from cloud
    if (CLOUD_REGISTRATION_ENABLED) {
      try {
        await this.cloudRegistration.unregister();
      } catch (error) {
        logger.warn('⚠️  Could not unregister from cloud', { error });
      }
    }

    // Close WebSocket connections
    this.io.close();

    // Close HTTP server
    this.server.close(() => {
      logger.info('✅ Local server shut down gracefully');
      process.exit(0);
    });
  }
}

// Create and start server
const server = new LocalServer();

// Graceful shutdown
process.on('SIGTERM', () => server.shutdown());
process.on('SIGINT', () => server.shutdown());

// Start server
server.start().catch((error) => {
  logger.error('❌ Failed to start server', { error });
  process.exit(1);
});
