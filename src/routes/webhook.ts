/**
 * Gitea Webhook Routes
 * 
 * Handles webhooks from Gitea for automatic preview builds.
 * When code is pushed to a Gitea repository, Gitea sends a webhook
 * to this endpoint, which triggers a preview build.
 * 
 * NO MOCKS - Real implementation only
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { PreviewBuildService, BuildConfig } from '../services/PreviewBuildService';
import { logger } from '../lib/logger';
import { query } from '../lib/database';

const router = Router();

// Initialize PreviewBuildService
let previewBuildService: PreviewBuildService | null = null;

/**
 * Get or create PreviewBuildService instance
 */
async function getPreviewBuildService(): Promise<PreviewBuildService> {
  if (!previewBuildService) {
    previewBuildService = new PreviewBuildService({
      giteaUrl: process.env.GITEA_URL || 'http://gitea:3000',
      giteaToken: process.env.GITEA_TOKEN,
      giteaUser: process.env.GITEA_USERNAME || 'musical',
      dockerNetwork: process.env.DOCKER_NETWORK || 'musical-network-main',
    });
    await previewBuildService.initialize();
  }
  return previewBuildService;
}

// Initialize on module load
getPreviewBuildService().catch(err => {
  logger.error('Failed to initialize PreviewBuildService', { error: err.message });
});

/**
 * Gitea Push Webhook Payload
 */
interface GiteaPushPayload {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: Array<{
    id: string;
    message: string;
    url: string;
    author: {
      name: string;
      email: string;
      username: string;
    };
    timestamp: string;
  }>;
  total_commits: number;
  head_commit?: {
    id: string;
    message: string;
    timestamp: string;
    author: {
      name: string;
      email: string;
      username: string;
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    description: string;
    html_url: string;
    ssh_url: string;
    clone_url: string;
    owner: {
      id: number;
      login: string;
      full_name: string;
      email: string;
    };
    private: boolean;
    fork: boolean;
    default_branch: string;
  };
  pusher: {
    id: number;
    login: string;
    full_name: string;
    email: string;
  };
  sender: {
    id: number;
    login: string;
    full_name: string;
    email: string;
  };
}

/**
 * Verify Gitea webhook signature
 */
function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature || !secret) {
    // If no secret configured, skip verification
    return true;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * POST /api/webhook/gitea
 * 
 * Receives push events from Gitea and triggers preview builds
 */
router.post('/gitea', async (req: Request, res: Response) => {
  const eventType = req.headers['x-gitea-event'] as string;
  const deliveryId = req.headers['x-gitea-delivery'] as string;
  const signature = req.headers['x-gitea-signature'] as string;

  logger.info('📨 Received Gitea webhook', {
    eventType,
    deliveryId,
    hasSignature: !!signature,
  });

  // Only handle push events
  if (eventType !== 'push') {
    logger.debug('Ignoring non-push webhook event', { eventType });
    return res.status(200).json({
      success: true,
      message: `Ignored ${eventType} event`,
    });
  }

  try {
    const payload = req.body as GiteaPushPayload;

    // Validate payload
    if (!payload.repository || !payload.after) {
      logger.warn('Invalid webhook payload', { payload: JSON.stringify(payload).slice(0, 200) });
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook payload',
      });
    }

    // Extract branch name from ref (refs/heads/main -> main)
    const branch = payload.ref.replace('refs/heads/', '');

    // Skip if this is a zero commit (branch deletion)
    if (payload.after === '0000000000000000000000000000000000000000') {
      logger.info('Ignoring branch deletion event');
      return res.status(200).json({
        success: true,
        message: 'Ignored branch deletion',
      });
    }

    // Get commit info
    const commitHash = payload.after;
    const commitMessage = payload.head_commit?.message || 
                         (payload.commits.length > 0 ? payload.commits[0].message : 'No message');
    const pusher = payload.pusher.login;

    // Extract project ID from repository name
    // Repository names follow pattern: project_<id>
    const repoName = payload.repository.name;
    const projectId = await resolveProjectId(repoName);

    if (!projectId) {
      logger.warn('Could not resolve project ID from repository', { repoName });
      return res.status(404).json({
        success: false,
        error: `Project not found for repository: ${repoName}`,
      });
    }

    // Get the user ID for this project
    const userId = await getProjectUserId(projectId);

    // Build config
    const buildConfig: BuildConfig = {
      projectId,
      commitHash,
      branch,
      repoUrl: payload.repository.clone_url,
      userId,
      pusher,
      commitMessage,
    };

    logger.info('🚀 Triggering preview build from webhook', {
      projectId,
      repoName,
      branch,
      commitHash: commitHash.slice(0, 8),
      pusher,
    });

    // Get preview build service
    const service = await getPreviewBuildService();

    // Trigger build asynchronously - don't wait for completion
    service.triggerBuild(buildConfig).catch(err => {
      logger.error('Preview build failed', {
        projectId,
        error: err.message,
      });
    });

    // Return immediately to acknowledge webhook
    return res.status(202).json({
      success: true,
      message: 'Build triggered',
      projectId,
      commitHash,
      branch,
    });

  } catch (error: any) {
    logger.error('Webhook processing error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/webhook/gitea/:projectId
 * 
 * Project-specific webhook endpoint (alternative URL format)
 */
router.post('/gitea/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const eventType = req.headers['x-gitea-event'] as string;

  logger.info('📨 Received project-specific Gitea webhook', {
    projectId,
    eventType,
  });

  if (eventType !== 'push') {
    return res.status(200).json({ success: true, message: `Ignored ${eventType} event` });
  }

  try {
    const payload = req.body as GiteaPushPayload;
    const branch = payload.ref.replace('refs/heads/', '');
    const commitHash = payload.after;

    if (commitHash === '0000000000000000000000000000000000000000') {
      return res.status(200).json({ success: true, message: 'Ignored branch deletion' });
    }

    const userId = await getProjectUserId(projectId);

    const buildConfig: BuildConfig = {
      projectId,
      commitHash,
      branch,
      repoUrl: payload.repository.clone_url,
      userId,
      pusher: payload.pusher?.login || 'unknown',
      commitMessage: payload.head_commit?.message || '',
    };

    const service = await getPreviewBuildService();
    service.triggerBuild(buildConfig).catch(err => {
      logger.error('Preview build failed', { projectId, error: err.message });
    });

    return res.status(202).json({
      success: true,
      message: 'Build triggered',
      projectId,
      commitHash,
    });

  } catch (error: any) {
    logger.error('Webhook processing error', { projectId, error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/webhook/gitea/health
 * 
 * Health check for webhook endpoint
 */
router.get('/gitea/health', async (req: Request, res: Response) => {
  try {
    const service = await getPreviewBuildService();
    return res.status(200).json({
      success: true,
      message: 'Webhook endpoint healthy',
      service: 'PreviewBuildService',
      status: 'initialized',
    });
  } catch (error: any) {
    return res.status(503).json({
      success: false,
      message: 'Service unavailable',
      error: error.message,
    });
  }
});

/**
 * GET /api/webhook/builds/:projectId
 * 
 * Get build history for a project
 */
router.get('/builds/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  try {
    const service = await getPreviewBuildService();
    const builds = await service.getProjectBuilds(projectId);

    return res.status(200).json({
      success: true,
      projectId,
      builds,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/webhook/builds/:projectId/:buildId
 * 
 * Get specific build status
 */
router.get('/builds/:projectId/:buildId', async (req: Request, res: Response) => {
  const { buildId } = req.params;

  try {
    const service = await getPreviewBuildService();
    const build = service.getBuild(buildId);

    if (!build) {
      return res.status(404).json({
        success: false,
        error: 'Build not found',
      });
    }

    return res.status(200).json({
      success: true,
      build,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/webhook/trigger/:projectId
 * 
 * Manually trigger a preview build (for testing/manual deployment)
 */
router.post('/trigger/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { branch = 'main', commitHash = 'HEAD' } = req.body;

  logger.info('🔧 Manual build trigger', { projectId, branch, commitHash });

  try {
    // Get project info
    const projectResult = await query(
      `SELECT * FROM projects WHERE id = $1`,
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const project = projectResult.rows[0];
    const giteaUrl = process.env.GITEA_URL || 'http://gitea:3000';
    const giteaUser = process.env.GITEA_USERNAME || 'musical';

    const buildConfig: BuildConfig = {
      projectId,
      commitHash,
      branch,
      repoUrl: `${giteaUrl}/${giteaUser}/${project.name || projectId}.git`,
      userId: project.user_id,
      pusher: 'manual',
      commitMessage: 'Manual trigger',
    };

    const service = await getPreviewBuildService();
    const result = await service.triggerBuild(buildConfig);

    return res.status(200).json({
      success: true,
      message: 'Build completed',
      build: result,
    });

  } catch (error: any) {
    logger.error('Manual trigger failed', { projectId, error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Resolve project ID from repository name
 */
async function resolveProjectId(repoName: string): Promise<string | null> {
  // Try direct match with project name
  try {
    const result = await query(
      `SELECT id FROM projects WHERE name = $1 OR id = $1`,
      [repoName]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].id;
    }
  } catch (error) {
    logger.debug('Database lookup failed', { error });
  }

  // If repo name follows pattern project_<timestamp>, use that
  if (repoName.startsWith('project_')) {
    return repoName;
  }

  return null;
}

/**
 * Get user ID for a project
 */
async function getProjectUserId(projectId: string): Promise<number> {
  try {
    const result = await query(
      `SELECT user_id FROM projects WHERE id = $1`,
      [projectId]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].user_id;
    }
  } catch (error) {
    logger.debug('Could not get project user ID', { error });
  }

  return 0; // Default user ID
}

export default router;
