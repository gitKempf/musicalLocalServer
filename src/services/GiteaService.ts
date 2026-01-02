/**
 * GiteaService - Real Gitea Repository Management
 *
 * This service handles REAL repository operations with Gitea:
 * - Creating repositories via Gitea API
 * - Managing repository access
 * - Setting up webhooks for preview builds
 *
 * NO MOCKS - All operations use real Gitea API calls
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../lib/logger';

export interface GiteaRepository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  created_at: string;
}

export interface CreateRepositoryParams {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  default_branch?: string;
}

export interface GiteaServiceConfig {
  baseURL: string;
  username: string;
  token: string;
  defaultOrganization?: string;
}

export class GiteaService {
  private client: AxiosInstance;
  private username: string;
  private organization?: string;

  constructor(config: GiteaServiceConfig) {
    this.username = config.username;
    this.organization = config.defaultOrganization;

    // Create axios client with auth token
    this.client = axios.create({
      baseURL: config.baseURL,
      headers: {
        'Authorization': `token ${config.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    logger.info('🔧 GiteaService initialized', {
      baseURL: config.baseURL,
      username: config.username,
      hasOrganization: !!config.defaultOrganization,
    });
  }

  /**
   * Test connection to Gitea
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/v1/version');
      logger.info('✅ Gitea connection successful', {
        version: response.data.version,
      });
      return true;
    } catch (error: any) {
      logger.error('❌ Gitea connection failed', {
        error: error.message,
        baseURL: this.client.defaults.baseURL,
      });
      return false;
    }
  }

  /**
   * Create a new repository in Gitea (REAL API CALL)
   */
  async createRepository(params: CreateRepositoryParams): Promise<GiteaRepository> {
    try {
      logger.info('📦 Creating Gitea repository', {
        name: params.name,
        private: params.private,
        organization: this.organization,
      });

      const endpoint = this.organization
        ? `/api/v1/orgs/${this.organization}/repos`
        : '/api/v1/user/repos';

      const payload = {
        name: params.name,
        description: params.description || '',
        private: params.private !== false, // Default to private
        auto_init: params.auto_init !== false, // Default to true (creates README)
        default_branch: params.default_branch || 'main',
      };

      const response = await this.client.post(endpoint, payload);

      const repo: GiteaRepository = response.data;

      logger.info('✅ Repository created successfully', {
        id: repo.id,
        name: repo.full_name,
        cloneUrl: repo.clone_url,
      });

      return repo;
    } catch (error: any) {
      logger.error('❌ Failed to create repository', {
        error: error.message,
        response: error.response?.data,
        name: params.name,
      });

      // Handle specific error cases
      if (error.response?.status === 409) {
        throw new Error(`Repository '${params.name}' already exists`);
      } else if (error.response?.status === 401) {
        throw new Error('Gitea authentication failed - check token');
      } else if (error.response?.status === 422) {
        throw new Error(`Invalid repository name: ${params.name}`);
      }

      throw new Error(`Failed to create repository: ${error.message}`);
    }
  }

  /**
   * Get repository by name (REAL API CALL)
   */
  async getRepository(name: string): Promise<GiteaRepository | null> {
    try {
      const owner = this.organization || this.username;
      const response = await this.client.get(`/api/v1/repos/${owner}/${name}`);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      logger.error('❌ Failed to get repository', {
        error: error.message,
        name,
      });
      throw error;
    }
  }

  /**
   * Delete repository (REAL API CALL)
   */
  async deleteRepository(name: string): Promise<boolean> {
    try {
      const owner = this.organization || this.username;
      await this.client.delete(`/api/v1/repos/${owner}/${name}`);

      logger.info('🗑️  Repository deleted', { name });
      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn('⚠️  Repository not found', { name });
        return false;
      }
      logger.error('❌ Failed to delete repository', {
        error: error.message,
        name,
      });
      throw error;
    }
  }

  /**
   * Create webhook for repository (REAL API CALL)
   * This enables automatic preview builds on push
   */
  async createWebhook(
    repoName: string,
    webhookUrl: string,
    events: string[] = ['push']
  ): Promise<void> {
    try {
      const owner = this.organization || this.username;

      const payload = {
        type: 'gitea',
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: '', // Can add webhook secret for security
        },
        events,
        active: true,
      };

      await this.client.post(
        `/api/v1/repos/${owner}/${repoName}/hooks`,
        payload
      );

      logger.info('✅ Webhook created', {
        repo: repoName,
        url: webhookUrl,
        events,
      });
    } catch (error: any) {
      logger.error('❌ Failed to create webhook', {
        error: error.message,
        repo: repoName,
      });
      throw error;
    }
  }

  /**
   * Get clone URL for a repository
   */
  getCloneUrl(repoName: string, useSSH: boolean = false): string {
    const owner = this.organization || this.username;
    const baseURL = this.client.defaults.baseURL || '';

    if (useSSH) {
      // SSH URLs are typically in format: git@host:owner/repo.git
      const host = baseURL.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      return `git@${host}:${owner}/${repoName}.git`;
    } else {
      // HTTP URLs: http://host:port/owner/repo.git
      return `${baseURL}/${owner}/${repoName}.git`;
    }
  }

  /**
   * Check if repository exists
   */
  async repositoryExists(name: string): Promise<boolean> {
    const repo = await this.getRepository(name);
    return repo !== null;
  }

  /**
   * Get commits for a repository (REAL API CALL)
   */
  async getCommits(
    repoName: string,
    options: { limit?: number; page?: number; branch?: string } = {}
  ): Promise<{
    commits: Array<{
      sha: string;
      message: string;
      author: { name: string; email: string };
      committer: { name: string; email: string };
      timestamp: string;
      url: string;
    }>;
    total?: number;
  }> {
    try {
      const owner = this.organization || this.username;
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.page) params.append('page', options.page.toString());
      if (options.branch) params.append('sha', options.branch);

      const response = await this.client.get(
        `/api/v1/repos/${owner}/${repoName}/commits?${params.toString()}`
      );

      const commits = response.data.map((commit: any) => ({
        sha: commit.sha,
        message: commit.commit?.message || commit.message || '',
        author: {
          name: commit.commit?.author?.name || commit.author?.login || 'Unknown',
          email: commit.commit?.author?.email || '',
        },
        committer: {
          name: commit.commit?.committer?.name || commit.committer?.login || 'Unknown',
          email: commit.commit?.committer?.email || '',
        },
        timestamp: commit.commit?.author?.date || commit.created || new Date().toISOString(),
        url: commit.html_url || '',
      }));

      logger.debug('📜 Retrieved commits from Gitea', {
        repo: repoName,
        count: commits.length,
      });

      return { commits };
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn('⚠️  Repository not found or no commits', { repoName });
        return { commits: [] };
      }
      logger.error('❌ Failed to get commits', {
        error: error.message,
        repo: repoName,
      });
      throw error;
    }
  }

  /**
   * Get specific commit details
   */
  async getCommit(repoName: string, sha: string): Promise<{
    sha: string;
    message: string;
    author: { name: string; email: string };
    timestamp: string;
    files?: Array<{ filename: string; status: string }>;
  } | null> {
    try {
      const owner = this.organization || this.username;
      const response = await this.client.get(
        `/api/v1/repos/${owner}/${repoName}/git/commits/${sha}`
      );

      const commit = response.data;
      return {
        sha: commit.sha,
        message: commit.commit?.message || commit.message || '',
        author: {
          name: commit.commit?.author?.name || commit.author?.login || 'Unknown',
          email: commit.commit?.author?.email || '',
        },
        timestamp: commit.commit?.author?.date || commit.created || new Date().toISOString(),
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      logger.error('❌ Failed to get commit', {
        error: error.message,
        repo: repoName,
        sha,
      });
      throw error;
    }
  }
}
