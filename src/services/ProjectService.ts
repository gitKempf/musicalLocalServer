/**
 * Project Service
 * Handles all database operations for projects in local server
 */

import { query } from '../lib/database';
import { logger } from '../lib/logger';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  template: string;
  status: string;
  initial_prompt?: string;
  gitea_repo_url?: string;
  gitea_repo_id?: number;
  container_id?: string;
  ssh_port?: number;
  tunnel_url?: string;
  preview_url?: string;
  preview_container_id?: string;
  preview_port?: number;
  published_url?: string;
  published_at?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProjectParams {
  id: string;
  userId: string;
  name: string;
  description?: string;
  template?: string;
  initialPrompt?: string;
  gitRepo?: {
    repoId: number;
    repoName: string;
    cloneUrl: string;
    htmlUrl: string;
  } | null;
}

export interface UpdateProjectParams {
  sandboxId?: string;
  containerId?: string;
  previewUrl?: string;
  status?: string;
  subdomain?: string;
  error?: string;
  giteaRepoUrl?: string;
  giteaRepoId?: number;
  sshPort?: number;
  tunnelUrl?: string;
  preview_container_id?: string;
  preview_port?: number;
  published_url?: string;
  published_at?: string;
}

export interface ListProjectsOptions {
  limit?: number;
  offset?: number;
  status?: string;
}

class ProjectService {
  /**
   * Create a new project in the database
   */
  async createProject(params: CreateProjectParams): Promise<Project> {
    try {
      const {
        id,
        userId,
        name,
        description,
        template = 'react-native',
        initialPrompt,
        gitRepo,
      } = params;

      const queryText = `
        INSERT INTO projects(
          id, user_id, name, description, template, initial_prompt, status,
          gitea_repo_url, gitea_repo_id
        )
        VALUES($1, $2, $3, $4, $5, $6, 'active', $7, $8)
        RETURNING *;
      `;
      const values = [
        id,
        userId,
        name,
        description || '',
        template,
        initialPrompt,
        gitRepo?.cloneUrl || null,
        gitRepo?.repoId || null,
      ];

      const { rows } = await query<Project>(queryText, values);

      logger.info('✅ Project created', {
        projectId: id,
        name,
        hasGitRepo: !!gitRepo
      });
      return rows[0];
    } catch (error) {
      logger.error('❌ Failed to create project', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project creation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get a project by its ID and user ID
   */
  async getProject(projectId: string, userId: string): Promise<Project | null> {
    try {
      const queryText = `
        SELECT * FROM projects
        WHERE id = $1 AND user_id = $2;
      `;
      const { rows } = await query<Project>(queryText, [projectId, userId]);

      return rows[0] || null;
    } catch (error) {
      logger.error('❌ Failed to get project', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update a project's details
   */
  async updateProject(projectId: string, updates: UpdateProjectParams): Promise<Project> {
    try {
      const {
        sandboxId,
        containerId,
        previewUrl,
        status,
        subdomain,
        error: errorMsg,
        giteaRepoUrl,
        giteaRepoId,
        sshPort,
        tunnelUrl,
        preview_container_id,
        preview_port,
        published_url,
        published_at,
      } = updates;

      const queryText = `
        UPDATE projects
        SET
          sandbox_id = COALESCE($1, sandbox_id),
          container_id = COALESCE($2, container_id),
          preview_url = COALESCE($3, preview_url),
          status = COALESCE($4, status),
          subdomain = COALESCE($5, subdomain),
          error_message = COALESCE($6, error_message),
          gitea_repo_url = COALESCE($7, gitea_repo_url),
          gitea_repo_id = COALESCE($8, gitea_repo_id),
          ssh_port = COALESCE($9, ssh_port),
          tunnel_url = COALESCE($10, tunnel_url),
          preview_container_id = COALESCE($11, preview_container_id),
          preview_port = COALESCE($12, preview_port),
          published_url = COALESCE($13, published_url),
          published_at = COALESCE($14, published_at),
          updated_at = NOW()
        WHERE id = $15
        RETURNING *;
      `;
      const values = [
        sandboxId,
        containerId,
        previewUrl,
        status,
        subdomain,
        errorMsg,
        giteaRepoUrl,
        giteaRepoId,
        sshPort,
        tunnelUrl,
        preview_container_id,
        preview_port,
        published_url,
        published_at,
        projectId,
      ];

      const { rows } = await query<Project>(queryText, values);

      if (rows.length === 0) {
        throw new Error('Project not found or update failed');
      }

      logger.info('✅ Project updated', { projectId });
      return rows[0];
    } catch (error) {
      logger.error('❌ Failed to update project', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a project (soft delete)
   */
  async deleteProject(projectId: string, userId: string): Promise<{ id: string }> {
    try {
      const queryText = `
        UPDATE projects
        SET status = 'deleted', updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id;
      `;
      const { rows } = await query<{ id: string }>(queryText, [projectId, userId]);

      if (rows.length === 0) {
        throw new Error('Project not found or access denied');
      }

      logger.info('✅ Project deleted', { projectId });
      return rows[0];
    } catch (error) {
      logger.error('❌ Failed to delete project', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project deletion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List user projects
   */
  async listUserProjects(
    userId: string,
    options: ListProjectsOptions = {}
  ): Promise<Project[]> {
    try {
      const { limit = 50, offset = 0, status = 'active' } = options;

      const queryText = `
        SELECT *
        FROM projects
        WHERE user_id = $1 AND status = $2
        ORDER BY updated_at DESC
        LIMIT $3 OFFSET $4;
      `;
      const { rows } = await query<Project>(queryText, [userId, status, limit, offset]);

      logger.info('✅ Projects listed', { userId, count: rows.length });
      return rows;
    } catch (error) {
      logger.error('❌ Failed to list user projects', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project listing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get project by ID (without user check - for internal use)
   */
  async getProjectById(projectId: string): Promise<Project | null> {
    try {
      const queryText = `SELECT * FROM projects WHERE id = $1;`;
      const { rows } = await query<Project>(queryText, [projectId]);

      return rows[0] || null;
    } catch (error) {
      logger.error('❌ Failed to get project by ID', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Project retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get projects by status (for cleanup/maintenance)
   */
  async getProjectsByStatus(status: string): Promise<Project[]> {
    try {
      const queryText = `
        SELECT * FROM projects
        WHERE status = $1
        ORDER BY updated_at DESC;
      `;
      const { rows } = await query<Project>(queryText, [status]);

      return rows;
    } catch (error) {
      logger.error('❌ Failed to get projects by status', {
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

export default new ProjectService();
