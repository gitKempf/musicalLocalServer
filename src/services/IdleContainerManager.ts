/**
 * Idle Container Manager
 * Automatically stops containers that have been idle for too long
 * Saves resources and prevents container sprawl
 */

import { logger } from '../lib/logger';
import { query } from '../lib/database';
import { ContainerOrchestrator } from './ContainerOrchestrator';

export class IdleContainerManager {
  private containerOrchestrator: ContainerOrchestrator;
  private checkInterval: NodeJS.Timeout | null = null;
  private idleTimeoutMinutes: number;
  private checkIntervalMinutes: number;

  constructor(
    containerOrchestrator: ContainerOrchestrator,
    idleTimeoutMinutes: number = 30,
    checkIntervalMinutes: number = 5
  ) {
    this.containerOrchestrator = containerOrchestrator;
    this.idleTimeoutMinutes = idleTimeoutMinutes;
    this.checkIntervalMinutes = checkIntervalMinutes;
  }

  /**
   * Start the idle container checker
   */
  start(): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Idle container checker already running');
      return;
    }

    logger.info('🕐 Starting idle container checker', {
      idleTimeoutMinutes: this.idleTimeoutMinutes,
      checkIntervalMinutes: this.checkIntervalMinutes,
    });

    // Check immediately on start
    this.checkIdleContainers();

    // Then check periodically
    this.checkInterval = setInterval(
      () => this.checkIdleContainers(),
      this.checkIntervalMinutes * 60 * 1000
    );
  }

  /**
   * Stop the idle container checker
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('🛑 Stopped idle container checker');
    }
  }

  /**
   * Check for idle containers and stop them
   */
  private async checkIdleContainers(): Promise<void> {
    try {
      logger.debug('🔍 Checking for idle containers...');

      // Find projects with containers that haven't been active recently
      const idleThreshold = new Date(
        Date.now() - this.idleTimeoutMinutes * 60 * 1000
      );

      const result = await query<{
        id: string;
        name: string;
        container_id: string;
        last_activity_at: Date;
      }>(
        `SELECT id, name, container_id, last_activity_at
         FROM projects
         WHERE container_id IS NOT NULL
           AND status = 'active'
           AND (last_activity_at < $1 OR last_activity_at IS NULL)`,
        [idleThreshold]
      );

      if (result.rows.length === 0) {
        logger.debug('✅ No idle containers found');
        return;
      }

      logger.info('🔍 Found idle containers to stop', {
        count: result.rows.length,
        idleThresholdMinutes: this.idleTimeoutMinutes,
      });

      // Stop each idle container
      for (const project of result.rows) {
        await this.stopIdleContainer(project);
      }

      logger.info('✅ Idle container check complete', {
        stoppedCount: result.rows.length,
      });
    } catch (error: any) {
      logger.error('❌ Failed to check idle containers', {
        error: error.message,
      });
    }
  }

  /**
   * Stop a single idle container
   */
  private async stopIdleContainer(project: {
    id: string;
    name: string;
    container_id: string;
    last_activity_at: Date;
  }): Promise<void> {
    try {
      const { id, name, container_id, last_activity_at } = project;

      // Check if container is actually running
      const isRunning = await this.containerOrchestrator.isContainerRunning(
        container_id
      );

      if (!isRunning) {
        logger.debug('⏭️  Container already stopped', {
          projectId: id,
          containerId: container_id,
        });
        return;
      }

      const idleMinutes = Math.floor(
        (Date.now() - new Date(last_activity_at).getTime()) / 60000
      );

      logger.info('⏸️  Stopping idle container', {
        projectId: id,
        projectName: name,
        containerId: container_id,
        idleMinutes,
      });

      // Stop the container (don't destroy it - we can restart later)
      await this.containerOrchestrator.stopContainer(container_id);

      logger.info('✅ Idle container stopped successfully', {
        projectId: id,
        containerId: container_id,
      });
    } catch (error: any) {
      logger.error('❌ Failed to stop idle container', {
        projectId: project.id,
        containerId: project.container_id,
        error: error.message,
      });
    }
  }

  /**
   * Update last activity timestamp for a project
   */
  async updateActivity(projectId: string): Promise<void> {
    try {
      await query(
        `UPDATE projects
         SET last_activity_at = NOW()
         WHERE id = $1`,
        [projectId]
      );

      logger.debug('📝 Updated project activity', { projectId });
    } catch (error: any) {
      logger.warn('⚠️  Failed to update project activity', {
        projectId,
        error: error.message,
      });
    }
  }
}
