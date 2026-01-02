/**
 * Project Routes - Manage local projects
 * REAL IMPLEMENTATION - Uses PostgreSQL database
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../lib/logger';
import ProjectService from '../services/ProjectService';
import { GiteaService } from '../services/GiteaService';
import { ContainerOrchestrator } from '../services/ContainerOrchestrator';
import { requireAuth } from '../middleware/auth';

export const projectRoutes = Router();

// Services will be injected via middleware
let giteaService: GiteaService | null = null;
let containerOrchestrator: ContainerOrchestrator | null = null;

export function initializeProjectRoutes(
  gitea: GiteaService | null,
  orchestrator?: ContainerOrchestrator | null
) {
  giteaService = gitea;
  containerOrchestrator = orchestrator || null;
  if (gitea) {
    logger.info('✅ Project routes initialized with GiteaService');
  } else {
    logger.warn('⚠️  Project routes initialized WITHOUT GiteaService (offline mode)');
  }
  if (orchestrator) {
    logger.info('✅ Project routes initialized with ContainerOrchestrator');
  }
}

// Apply auth middleware to all routes
projectRoutes.use(requireAuth);

/**
 * GET /api/projects
 * List all local projects for authenticated user
 */
projectRoutes.get('/', async (req, res) => {
  try {
    // userId is guaranteed to exist due to requireAuth middleware
    const userId = (req as any).user.userId;
    const { limit, offset, status } = req.query;

    logger.info('📂 Listing local projects', { userId });

    const projects = await ProjectService.listUserProjects(userId, {
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
      status: (status as string) || 'active',
    });

    res.json({
      success: true,
      projects,
      pagination: {
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
        total: projects.length,
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to list projects', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to list projects',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects
 * Create new local project with Gitea repository
 */
projectRoutes.post('/', async (req, res) => {
  try {
    const { name, description, template = 'react-native', initialPrompt } = req.body;
    const userId = (req as any).user.userId;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'name is required',
      });
    }

    logger.info('📁 Creating new project', { name, template, userId });

    const projectId = `project_${Date.now()}`;

    // Create Gitea repository (REAL REPOSITORY)
    let giteaRepo = null;
    let repoCloneUrl = null;

    if (giteaService) {
      try {
        logger.info('🏗️  Creating Gitea repository', { projectId, name });

        // Sanitize project name for Git (replace spaces with hyphens, lowercase)
        const repoName = `${projectId}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

        giteaRepo = await giteaService.createRepository({
          name: repoName,
          description: description || `Musical.run project: ${name}`,
          private: true,
          auto_init: false, // We'll initialize Git manually in container
          default_branch: 'main',
        });

        repoCloneUrl = giteaRepo.clone_url;

        if (!repoCloneUrl) {
          throw new Error('Gitea repository created but clone_url is missing');
        }

        logger.info('✅ Gitea repository created', {
          repoId: giteaRepo.id,
          repoName: giteaRepo.name,
          cloneUrl: repoCloneUrl
        });

        // Register webhook for automatic preview builds
        try {
          // Use internal Docker network URL for webhook
          // The hostname is musical-local (from docker-compose service name)
          const webhookUrl = `http://musical-local:${process.env.PORT || 17100}/api/webhook/gitea/${projectId}`;
          await giteaService.createWebhook(repoName, webhookUrl, ['push']);
          logger.info('✅ Webhook registered for preview builds', { projectId, webhookUrl });
        } catch (webhookError: any) {
          // Webhook registration is optional - don't fail project creation
          logger.warn('⚠️  Failed to register webhook', { error: webhookError.message });
        }
      } catch (error: any) {
        logger.error('❌ Failed to create Gitea repository', { error: error.message });
        // Continue without Gitea repo - project can still be created
        logger.warn('⚠️  Project will be created without Git repository');
        giteaRepo = null;
        repoCloneUrl = null;
      }
    } else {
      logger.warn('⚠️  GiteaService not available - project will be created without Git repository');
    }

    // Create project in database
    const project = await ProjectService.createProject({
      id: projectId,
      userId,
      name,
      description,
      template,
      initialPrompt,
      gitRepo: giteaRepo && repoCloneUrl ? {
        repoId: giteaRepo.id,
        repoName: giteaRepo.name,
        cloneUrl: repoCloneUrl,
        htmlUrl: giteaRepo.html_url,
      } : null,
    });

    res.status(201).json({
      success: true,
      project,
      gitRepository: giteaRepo ? {
        id: giteaRepo.id,
        name: giteaRepo.name,
        cloneUrl: repoCloneUrl,
        webUrl: giteaRepo.html_url,
      } : null,
      message: giteaRepo
        ? 'Project and Git repository created successfully'
        : 'Project created successfully (no Git repository)',
    });
  } catch (error: any) {
    logger.error('❌ Failed to create project', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create project',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId
 * Get project details
 */
projectRoutes.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    logger.info('📋 Getting project details', { projectId, userId });

    const project = await ProjectService.getProject(projectId, userId);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    res.json({
      success: true,
      project,
    });
  } catch (error: any) {
    logger.error('❌ Failed to get project', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve project',
      details: error.message,
    });
  }
});

/**
 * PUT /api/projects/:projectId
 * Update project
 */
projectRoutes.put('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    // Check if user has access to project
    const existingProject = await ProjectService.getProject(projectId, userId);
    if (!existingProject) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    logger.info('📝 Updating project', { projectId });

    const updatedProject = await ProjectService.updateProject(projectId, req.body);

    res.json({
      success: true,
      message: 'Project updated successfully',
      project: updatedProject,
    });
  } catch (error: any) {
    logger.error('❌ Failed to update project', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to update project',
      details: error.message,
    });
  }
});

/**
 * DELETE /api/projects/:projectId
 * Delete project with full cleanup (container, Gitea repo, soft delete in DB)
 */
projectRoutes.delete('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    logger.info('🗑️  Deleting project with full cleanup', { projectId, userId });

    // First, get the project to check for container and Gitea repo
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const cleanupResults = {
      containerRemoved: false,
      giteaRepoDeleted: false,
      projectDeleted: false,
    };

    // 1. Stop and remove Docker container if exists
    if (project.container_id && containerOrchestrator) {
      try {
        logger.info('🐳 Removing container for project', { 
          projectId, 
          containerId: project.container_id 
        });
        await containerOrchestrator.removeContainer(project.container_id);
        cleanupResults.containerRemoved = true;
        logger.info('✅ Container removed successfully', { containerId: project.container_id });
      } catch (containerError: any) {
        logger.warn('⚠️  Failed to remove container (may already be removed)', { 
          containerId: project.container_id,
          error: containerError.message 
        });
        // Continue with deletion even if container removal fails
      }
    }

    // 2. Delete Gitea repository if exists
    if (project.gitea_repo_url && giteaService) {
      try {
        // Extract repo name from URL (format: http://gitea:3000/musical/repo-name.git)
        const repoUrlMatch = project.gitea_repo_url.match(/\/([^\/]+)\.git$/);
        const repoName = repoUrlMatch ? repoUrlMatch[1] : null;
        
        if (repoName) {
          logger.info('📦 Deleting Gitea repository for project', { 
            projectId, 
            repoName,
            repoUrl: project.gitea_repo_url
          });
          await giteaService.deleteRepository(repoName);
          cleanupResults.giteaRepoDeleted = true;
          logger.info('✅ Gitea repository deleted successfully', { repoName });
        }
      } catch (giteaError: any) {
        logger.warn('⚠️  Failed to delete Gitea repository (may already be deleted)', { 
          repoUrl: project.gitea_repo_url,
          error: giteaError.message 
        });
        // Continue with deletion even if Gitea deletion fails
      }
    }

    // 3. Soft delete project in database
    const deletedProject = await ProjectService.deleteProject(projectId, userId);
    cleanupResults.projectDeleted = true;

    logger.info('✅ Project deleted successfully with cleanup', { 
      projectId: deletedProject.id,
      cleanup: cleanupResults
    });

    res.json({
      success: true,
      message: 'Project deleted successfully',
      projectId: deletedProject.id,
      cleanup: cleanupResults,
    });
  } catch (error: any) {
    logger.error('❌ Failed to delete project', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete project',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/commits
 * Get commits from Gitea repository for the project
 */
projectRoutes.get('/:projectId/commits', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;
    const { limit = '20', page = '1', branch = 'main' } = req.query;

    logger.info('📜 Fetching commits for project', { projectId, userId });

    // Get project to find the Gitea repo
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    // Check if project has a Gitea repository
    if (!project.gitea_repo_url || !giteaService) {
      return res.status(400).json({
        success: false,
        error: 'Project does not have a Git repository',
      });
    }

    // Extract repo name from the URL
    const repoUrlMatch = project.gitea_repo_url.match(/\/([^\/]+)\.git$/);
    const repoName = repoUrlMatch ? repoUrlMatch[1] : null;

    if (!repoName) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine repository name',
      });
    }

    // Get commits from Gitea
    const { commits } = await giteaService.getCommits(repoName, {
      limit: parseInt(limit as string),
      page: parseInt(page as string),
      branch: branch as string,
    });

    res.json({
      success: true,
      projectId,
      repoName,
      commits,
    });
  } catch (error: any) {
    logger.error('❌ Failed to get commits', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve commits',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/builds
 * Get build history for a project
 */
projectRoutes.get('/:projectId/builds', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    logger.info('📊 Fetching builds for project', { projectId, userId });

    // Verify project access
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    // Import the webhook route to get builds
    const { query } = await import('../lib/database');
    const buildsResult = await query(
      `SELECT * FROM preview_builds WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [projectId]
    );

    const builds = buildsResult.rows.map((row: any) => ({
      buildId: row.id,
      projectId: row.project_id,
      commitHash: row.commit_hash,
      branch: row.branch,
      status: row.status,
      previewUrl: row.preview_url,
      containerId: row.container_id,
      pusher: row.pusher,
      commitMessage: row.commit_message,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));

    res.json({
      success: true,
      projectId,
      builds,
      currentPreview: {
        url: project.preview_url,
        containerId: project.preview_container_id,
        published_url: project.published_url,
        published_at: project.published_at,
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to get builds', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve builds',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/rebuild
 * Manually trigger a rebuild for a project with specific commit
 */
projectRoutes.post('/:projectId/rebuild', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;
    const { commitHash = 'HEAD', branch = 'main' } = req.body;

    logger.info('🔄 Manual rebuild requested', { projectId, commitHash, branch });

    // Verify project access
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    // Check if project has a Gitea repository
    if (!project.gitea_repo_url) {
      return res.status(400).json({
        success: false,
        error: 'Project does not have a Git repository',
      });
    }

    // Import PreviewBuildService
    const { PreviewBuildService } = await import('../services/PreviewBuildService');
    const previewBuildService = new PreviewBuildService({
      giteaUrl: process.env.GITEA_URL || 'http://gitea:3000',
      giteaToken: process.env.GITEA_TOKEN,
      giteaUser: process.env.GITEA_USERNAME || 'musical',
      dockerNetwork: process.env.DOCKER_NETWORK || 'musical-network-main',
    });
    await previewBuildService.initialize();

    // Trigger build
    const buildResult = await previewBuildService.triggerBuild({
      projectId,
      commitHash,
      branch,
      repoUrl: project.gitea_repo_url,
      userId: project.user_id,
      pusher: 'manual',
      commitMessage: `Manual rebuild: ${commitHash}`,
    });

    res.json({
      success: true,
      message: 'Rebuild triggered',
      build: buildResult,
    });
  } catch (error: any) {
    logger.error('❌ Rebuild failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to trigger rebuild',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/publish
 * Publish preview to public subdomain (e.g., {projectName}.musical.run)
 */
projectRoutes.post('/:projectId/publish', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    logger.info('🌐 Publishing project preview', { projectId, userId });

    // Verify project access
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    // Check if project has an active preview
    if (!project.preview_url || !project.preview_container_id) {
      return res.status(400).json({
        success: false,
        error: 'Project does not have an active preview. Build the project first.',
      });
    }

    // Get the tunnel URL for this local server
    const tunnelUrl = process.env.TUNNEL_URL;
    if (!tunnelUrl) {
      return res.status(500).json({
        success: false,
        error: 'Local server tunnel URL not configured',
      });
    }

    // Register with cloud preview-proxy service
    const previewProxyUrl = process.env.PREVIEW_PROXY_URL || 'https://musical.run';
    const axios = (await import('axios')).default;

    // Create a clean project name for the subdomain
    const sanitizedName = project.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);

    const publicSubdomain = `${sanitizedName}-${projectId.slice(-8)}`;

    try {
      const response = await axios.post(`${previewProxyUrl}/api/preview/register`, {
        projectId: publicSubdomain,
        userId,
        // The preview URL is accessed through the tunnel proxy
        previewUrl: `${tunnelUrl}/api/preview/${projectId}/`,
        serverType: 'local',
      }, {
        timeout: 10000,
      });

      // Update project with published URL
      await ProjectService.updateProject(projectId, {
        published_url: `https://${publicSubdomain}.preview.musical.run`,
        published_at: new Date().toISOString(),
      });

      logger.info('✅ Project published successfully', {
        projectId,
        publicUrl: `https://${publicSubdomain}.preview.musical.run`,
      });

      res.json({
        success: true,
        message: 'Project published successfully',
        publicUrl: `https://${publicSubdomain}.preview.musical.run`,
        subdomain: publicSubdomain,
      });
    } catch (publishError: any) {
      logger.error('❌ Failed to register with preview proxy', {
        error: publishError.message,
        response: publishError.response?.data,
      });

      res.status(500).json({
        success: false,
        error: 'Failed to publish preview',
        details: publishError.response?.data?.error || publishError.message,
      });
    }
  } catch (error: any) {
    logger.error('❌ Publish failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to publish project',
      details: error.message,
    });
  }
});
