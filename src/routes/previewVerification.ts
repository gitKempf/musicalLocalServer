/**
 * Preview Verification Routes
 * 
 * API endpoints for verifying preview health and triggering auto-fixes.
 * Used by the stop hook to validate preview after Claude makes changes.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import db from '../lib/database';
import { 
  getPreviewVerificationService, 
  ProjectType,
  HealthCheckResult 
} from '../services/PreviewVerificationService';

const router = Router();
const verificationService = getPreviewVerificationService();

/**
 * POST /api/preview/verify
 * Verify preview health and determine if auto-fix is needed
 */
router.post('/verify', async (req: Request, res: Response) => {
  const { projectId, sessionId } = req.body;

  if (!projectId) {
    return res.status(400).json({ 
      success: false, 
      error: 'projectId is required' 
    });
  }

  logger.info('🔍 Verifying preview health', { projectId, sessionId });

  try {
    // Get project from database
    const projectResult = await db.query(
      `SELECT id, preview_url, preview_container_id, project_type, 
              preview_status, auto_fix_attempts
       FROM projects WHERE id = $1`,
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const project = projectResult.rows[0];

    // Check if preview exists
    if (!project.preview_container_id || !project.preview_url) {
      return res.json({
        success: true,
        status: 'pending',
        message: 'No preview container available yet',
        shouldAutoFix: false,
      });
    }

    // Detect project type if not set
    let projectType: ProjectType = project.project_type || 'unknown';
    if (projectType === 'unknown') {
      // Try to detect from container
      // For now, default to 'vite' as it's most common
      projectType = 'vite';
      await verificationService.updateProjectType(projectId, projectType);
    }

    // Build the preview URL for health check
    // Use internal proxy route for checking
    const previewCheckUrl = `http://localhost:17100/api/preview/${projectId}/`;

    // Perform health check
    const healthResult = await verificationService.checkPreviewHealth(
      previewCheckUrl,
      projectType
    );

    // Save health check to database
    await verificationService.saveHealthCheck(projectId, healthResult);

    // Determine if auto-fix should be attempted
    let shouldAutoFix = false;
    let claudePrompt: string | null = null;

    if (healthResult.status !== 'healthy' && healthResult.error) {
      shouldAutoFix = await verificationService.shouldAttemptAutoFix(projectId);
      claudePrompt = healthResult.error.claudePrompt;

      if (shouldAutoFix) {
        logger.info('🔧 Auto-fix recommended', {
          projectId,
          errorType: healthResult.error.type,
          attempts: project.auto_fix_attempts + 1,
        });
      }
    } else if (healthResult.status === 'healthy') {
      // Reset auto-fix attempts on success
      await verificationService.resetAutoFixAttempts(projectId);
      logger.info('✅ Preview is healthy', { projectId });
    }

    return res.json({
      success: true,
      status: healthResult.status,
      projectType,
      responseCode: healthResult.responseCode,
      responseTimeMs: healthResult.responseTimeMs,
      error: healthResult.error ? {
        type: healthResult.error.type,
        message: healthResult.error.message,
        suggestion: healthResult.error.suggestion,
        severity: healthResult.error.severity,
      } : null,
      shouldAutoFix,
      claudePrompt,
      autoFixAttempts: project.auto_fix_attempts,
    });

  } catch (error: any) {
    logger.error('Preview verification failed', { projectId, error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/preview/record-fix-attempt
 * Record that an auto-fix attempt was made
 */
router.post('/record-fix-attempt', async (req: Request, res: Response) => {
  const { projectId } = req.body;

  if (!projectId) {
    return res.status(400).json({ 
      success: false, 
      error: 'projectId is required' 
    });
  }

  try {
    await verificationService.recordAutoFixAttempt(projectId);
    
    logger.info('📝 Recorded auto-fix attempt', { projectId });

    return res.json({
      success: true,
      message: 'Auto-fix attempt recorded',
    });
  } catch (error: any) {
    logger.error('Failed to record auto-fix attempt', { projectId, error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/preview/detect-type
 * Detect and update project type
 */
router.post('/detect-type', async (req: Request, res: Response) => {
  const { projectId } = req.body;

  if (!projectId) {
    return res.status(400).json({ 
      success: false, 
      error: 'projectId is required' 
    });
  }

  try {
    // Get project container
    const projectResult = await db.query(
      'SELECT preview_container_id FROM projects WHERE id = $1',
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const containerId = projectResult.rows[0].preview_container_id;

    if (!containerId) {
      return res.json({
        success: true,
        projectType: 'unknown',
        message: 'No container available for detection',
      });
    }

    // Import Docker for container execution
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    const container = docker.getContainer(containerId);

    // Create exec function
    const execInContainer = async (cmd: string) => {
      const exec = await container.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      
      return new Promise<{stdout: string; stderr: string}>((resolve) => {
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        stream.on('end', () => {
          resolve({ stdout, stderr });
        });
      });
    };

    // Detect project type
    const projectType = await verificationService.detectProjectType('/app', execInContainer);

    // Update in database
    await verificationService.updateProjectType(projectId, projectType);

    logger.info('🔍 Detected project type', { projectId, projectType });

    return res.json({
      success: true,
      projectType,
    });

  } catch (error: any) {
    logger.error('Failed to detect project type', { projectId, error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/preview/health-history/:projectId
 * Get health check history for a project
 */
router.get('/health-history/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const result = await db.query(
      `SELECT * FROM preview_health_checks 
       WHERE project_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [projectId, limit]
    );

    return res.json({
      success: true,
      projectId,
      checks: result.rows,
    });
  } catch (error: any) {
    logger.error('Failed to get health history', { projectId, error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
