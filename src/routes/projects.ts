/**
 * Project Routes - Manage local projects
 * REAL IMPLEMENTATION - Uses PostgreSQL database
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../lib/logger';
import ProjectService from '../services/ProjectService';
import { GiteaService } from '../services/GiteaService';
import { requireAuth } from '../middleware/auth';

export const projectRoutes = Router();

// Gitea service will be injected via middleware
let giteaService: GiteaService | null = null;

export function initializeProjectRoutes(gitea: GiteaService | null) {
  giteaService = gitea;
  if (gitea) {
    logger.info('✅ Project routes initialized with GiteaService');
  } else {
    logger.warn('⚠️  Project routes initialized WITHOUT GiteaService (offline mode)');
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
 * Delete project (soft delete)
 */
projectRoutes.delete('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = (req as any).user.userId;

    logger.info('🗑️  Deleting project', { projectId, userId });

    const deletedProject = await ProjectService.deleteProject(projectId, userId);

    res.json({
      success: true,
      message: 'Project deleted successfully',
      projectId: deletedProject.id,
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
