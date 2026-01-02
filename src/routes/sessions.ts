/**
 * Session Routes - Manage Claude Code sessions
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger';
import { ClaudeSessionManager } from '../services/ClaudeSessionManager';
import { EncryptionService } from '../lib/EncryptionService';
import { ContainerOrchestrator } from '../services/ContainerOrchestrator';
import { query } from '../lib/database';
import { requireAuth } from '../middleware/auth';

export const sessionRoutes = Router();

// Services will be injected via middleware
let claudeSessionManager: ClaudeSessionManager;
let encryptionService: EncryptionService;
let containerOrchestrator: ContainerOrchestrator;

export function initializeSessionRoutes(
  claudeManager: ClaudeSessionManager,
  encryption: EncryptionService,
  orchestrator: ContainerOrchestrator
) {
  claudeSessionManager = claudeManager;
  encryptionService = encryption;
  containerOrchestrator = orchestrator;
  logger.info('✅ Session routes initialized with services');
}

/**
 * GET /api/sessions
 * List all Claude sessions
 */
sessionRoutes.get('/', async (req, res) => {
  try {
    const sessions = await claudeSessionManager.listSessions();

    res.json({
      success: true,
      sessions,
      count: sessions.length,
    });
  } catch (error: any) {
    logger.error('❌ Failed to list sessions', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/sessions/create
 * Create new Claude session with dedicated container
 */
sessionRoutes.post('/create', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.body;
    const userId = (req as any).user.userId;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: 'projectId is required',
      });
    }

    logger.info('📝 Creating new Claude session with container', { projectId, userId });

    // 1. Check if project exists and user has access
    const projectResult = await query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const project = projectResult.rows[0];

    // Generate unique session ID (UUID format required by Claude Code CLI)
    const sessionId = randomUUID();

    // 2. Check if container already exists for this project
    let containerInfo;
    if (project.container_id) {
      logger.info('🔍 Checking if existing container is running', {
        projectId,
        containerId: project.container_id,
      });

      try {
        // Verify container is still running
        const isRunning = await containerOrchestrator.isContainerRunning(project.container_id);

        if (isRunning) {
          logger.info('♻️  Reusing existing running container', {
            projectId,
            containerId: project.container_id,
          });

          // Reuse existing container
          containerInfo = {
            containerId: project.container_id,
            dockerId: project.container_id, // Same as containerId for existing containers
            devServerPort: project.ssh_port,
            previewPort: project.ssh_port + 1, // Assuming sequential ports
            previewUrl: project.preview_url,
          };
        } else {
          // Container exists but is stopped - try to restart it
          logger.info('▶️  Restarting stopped container', {
            projectId,
            containerId: project.container_id,
          });

          try {
            await containerOrchestrator.startContainer(project.container_id);

            // Reuse restarted container
            containerInfo = {
              containerId: project.container_id,
              dockerId: project.container_id,
              devServerPort: project.ssh_port,
              previewPort: project.ssh_port + 1,
              previewUrl: project.preview_url,
            };

            logger.info('✅ Container restarted successfully', {
              projectId,
              containerId: project.container_id,
            });
          } catch (error: any) {
            logger.warn('⚠️  Failed to restart container, will create new one', {
              projectId,
              error: error.message,
            });
            containerInfo = null;
          }
        }
      } catch (error: any) {
        logger.warn('⚠️  Failed to check existing container, will create new one', {
          projectId,
          error: error.message,
        });
        containerInfo = null;
      }
    }

    // 3. Create new container if needed
    if (!containerInfo) {
      logger.info('🐳 Creating Docker container for project', { projectId, sessionId });

      containerInfo = await containerOrchestrator.createContainer({
        projectId,
        userId,
        sessionId,
        giteaToken: process.env.GITEA_TOKEN,
        giteaUser: process.env.GITEA_USERNAME || process.env.GITEA_USER || `user${userId}`,
        gitEmail: project.git_email || `user${userId}@musical.run`,
        gitName: project.git_name || `User ${userId}`,
      });
    }

    logger.info('✅ Container created', {
      containerId: containerInfo.containerId,
      dockerId: containerInfo.dockerId,
      devServerPort: containerInfo.devServerPort,
      previewPort: containerInfo.previewPort,
    });

    // 3. Initialize Git repository and push to Gitea (if repo exists)
    // Always initialize Git for hooks to work, even without Gitea
    try {
      logger.info('🔧 Initializing Git repository in container', { projectId });

      await containerOrchestrator.initializeGitRepository(
        containerInfo.containerId,
        project.gitea_repo_url || null, // Pass null if no Gitea repo
        project.name
      );

      logger.info('✅ Git repository initialized', { projectId });

      // Push initial commit to Gitea only if we have a repo URL
      if (project.gitea_repo_url) {
        logger.info('📤 Pushing initial commit to Gitea', { projectId });
        await containerOrchestrator.pushToGitea(containerInfo.containerId, 'main');
        logger.info('✅ Initial commit pushed to Gitea', { projectId });
      } else {
        logger.info('ℹ️  No Gitea repository configured - Git initialized locally only', { projectId });
      }
    } catch (error: any) {
      logger.error('❌ Failed to initialize Git repository', {
        projectId,
        error: error.message,
      });
      // Don't fail the session creation if Git initialization fails
      logger.warn('⚠️  Session created but Git initialization failed');
    }

    // 4. Update project with container info and activity timestamp
    await query(
      `UPDATE projects
       SET container_id = $1,
           ssh_port = $2,
           preview_url = $3,
           last_activity_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [
        containerInfo.containerId,
        containerInfo.devServerPort, // Using devServerPort as SSH port for now
        containerInfo.previewUrl,
        projectId,
      ]
    );

    // 5. Create session record in database
    await query(
      `INSERT INTO sessions (id, project_id, user_id, session_path, status, container_id, ssh_port)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        projectId,
        userId,
        '/app', // Default workspace path in container
        'active',
        containerInfo.containerId,
        containerInfo.devServerPort,
      ]
    );

    // 6. Register session with Claude agent
    logger.info('📝 Registering session with Claude agent', { sessionId, projectId });
    try {
      await claudeSessionManager.createSession(
        sessionId,
        projectId,
        containerInfo.containerId // Use container ID as work directory identifier
      );
      logger.info('✅ Session registered with Claude agent', { sessionId });
    } catch (error: any) {
      logger.error('❌ Failed to register session with Claude agent', {
        sessionId,
        error: error.message,
      });
      // Don't fail the session creation if Claude registration fails
      logger.warn('⚠️  Session created but Claude agent registration failed');
    }

    logger.info('✅ Session created successfully', { sessionId, projectId });

    res.json({
      success: true,
      sessionId,
      projectId,
      containerId: containerInfo.containerId,
      dockerId: containerInfo.dockerId,
      devServerPort: containerInfo.devServerPort,
      previewPort: containerInfo.previewPort,
      previewUrl: containerInfo.previewUrl,
      status: 'active',
      createdAt: containerInfo.createdAt,
      // Terminal access info
      terminal: {
        ready: true,
        message: 'Terminal ready - connect via WebSocket to interact with container',
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to create session', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Message endpoint removed - use terminal WebSocket instead
// See socket handlers in src/sockets/terminal.ts

/**
 * GET /api/sessions/:sessionId
 * Get session details
 */
sessionRoutes.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    logger.info('📋 Getting session details', { sessionId });

    const session = await claudeSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json({
      success: true,
      session,
    });
  } catch (error: any) {
    logger.error('❌ Failed to get session', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Delete session
 */
sessionRoutes.delete('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    logger.info('🗑️  Deleting session', { sessionId });

    const deleted = await claudeSessionManager.deleteSession(sessionId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json({
      success: true,
      message: 'Session deleted successfully',
    });
  } catch (error: any) {
    logger.error('❌ Failed to delete session', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
