/**
 * Services Routes
 * API endpoints for monitoring and managing local server services
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const servicesRoutes = Router();

interface ServiceInfo {
  name: string;
  type: 'core' | 'project';
  status: 'running' | 'stopped' | 'error' | 'starting' | 'unknown';
  health?: 'healthy' | 'unhealthy' | 'unknown';
  uptime?: string;
  port?: number;
  containerId?: string;
  projectId?: string;
  projectName?: string;
}

/**
 * GET /api/services
 * Get status of all services
 */
servicesRoutes.get('/', async (req: Request, res: Response) => {
  try {
    const services: ServiceInfo[] = [];
    
    // Get Docker container info
    const containers = await getDockerContainers();
    
    // Core services
    const postgresContainer = containers.find(c => 
      c.name.includes('postgres') && !c.name.includes('gitea')
    );
    services.push({
      name: 'PostgreSQL',
      type: 'core',
      status: postgresContainer?.status || 'unknown',
      health: postgresContainer?.health || 'unknown',
      uptime: postgresContainer?.uptime,
      port: 5432,
      containerId: postgresContainer?.id,
    });

    const apiContainer = containers.find(c => 
      c.name.includes('musical-local') && !c.name.includes('postgres')
    );
    services.push({
      name: 'Local Server API',
      type: 'core',
      status: 'running', // If we're responding, API is running
      health: 'healthy',
      port: parseInt(process.env.PORT || '17100'),
      containerId: apiContainer?.id,
      uptime: apiContainer?.uptime,
    });

    const giteaContainer = containers.find(c => c.name.includes('gitea') && !c.name.includes('db'));
    services.push({
      name: 'Gitea',
      type: 'core',
      status: giteaContainer?.status || 'unknown',
      health: giteaContainer?.health || 'unknown',
      uptime: giteaContainer?.uptime,
      port: 3000,
      containerId: giteaContainer?.id,
    });

    // Project containers
    const projectContainers = containers.filter(c => 
      c.name.startsWith('project-') || c.name.includes('claude-agent')
    );
    
    for (const container of projectContainers) {
      // Extract project info from container name or labels
      const projectId = container.labels?.['musical.project.id'];
      const projectName = container.labels?.['musical.project.name'] || container.name;
      
      services.push({
        name: container.name,
        type: 'project',
        status: container.status,
        health: container.health,
        uptime: container.uptime,
        containerId: container.id,
        projectId,
        projectName,
      });
    }

    res.json({
      success: true,
      services,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Failed to get services status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/services/:name
 * Get detailed status of a specific service
 */
servicesRoutes.get('/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const containers = await getDockerContainers();
    
    const container = containers.find(c => 
      c.name.toLowerCase().includes(name.toLowerCase())
    );
    
    if (!container) {
      return res.status(404).json({
        success: false,
        error: `Service ${name} not found`,
      });
    }

    // Get detailed container info
    const details = await getContainerDetails(container.id);
    
    res.json({
      success: true,
      service: {
        ...container,
        ...details,
      },
    });
  } catch (error: any) {
    logger.error('Failed to get service details', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/services/:name/restart
 * Restart a service
 */
servicesRoutes.post('/:name/restart', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    
    // Only allow restarting certain services
    const allowedServices = ['gitea', 'postgres', 'claude-agent'];
    const isAllowed = allowedServices.some(s => name.toLowerCase().includes(s));
    
    if (!isAllowed) {
      return res.status(403).json({
        success: false,
        error: 'Cannot restart this service',
      });
    }

    const containers = await getDockerContainers();
    const container = containers.find(c => 
      c.name.toLowerCase().includes(name.toLowerCase())
    );
    
    if (!container) {
      return res.status(404).json({
        success: false,
        error: `Service ${name} not found`,
      });
    }

    await execAsync(`docker restart ${container.id}`);
    
    logger.info('Service restarted', { name, containerId: container.id });
    
    res.json({
      success: true,
      message: `Service ${name} restarted`,
    });
  } catch (error: any) {
    logger.error('Failed to restart service', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

interface ContainerInfo {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'unknown';
  health: 'healthy' | 'unhealthy' | 'unknown';
  uptime?: string;
  labels?: Record<string, string>;
}

async function getDockerContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Labels}}'`
    );
    
    const lines = stdout.trim().split('\n').filter(Boolean);
    const containers: ContainerInfo[] = [];
    
    for (const line of lines) {
      const [id, name, statusStr, labelsStr] = line.split('|');
      
      // Parse status
      let status: ContainerInfo['status'] = 'unknown';
      let health: ContainerInfo['health'] = 'unknown';
      let uptime: string | undefined;
      
      if (statusStr.includes('Up')) {
        status = 'running';
        // Extract uptime like "Up 2 hours"
        const uptimeMatch = statusStr.match(/Up\s+(.+?)(?:\s+\(|$)/);
        if (uptimeMatch) {
          uptime = uptimeMatch[1].trim();
        }
        
        if (statusStr.includes('(healthy)')) {
          health = 'healthy';
        } else if (statusStr.includes('(unhealthy)')) {
          health = 'unhealthy';
        }
      } else if (statusStr.includes('Exited')) {
        status = 'stopped';
      } else if (statusStr.includes('Created') || statusStr.includes('Starting')) {
        status = 'starting';
      }
      
      // Parse labels
      const labels: Record<string, string> = {};
      if (labelsStr) {
        labelsStr.split(',').forEach(label => {
          const [key, value] = label.split('=');
          if (key && value) {
            labels[key] = value;
          }
        });
      }
      
      containers.push({
        id: id.substring(0, 12),
        name,
        status,
        health,
        uptime,
        labels,
      });
    }
    
    return containers;
  } catch (error) {
    logger.error('Failed to get Docker containers', { error });
    return [];
  }
}

async function getContainerDetails(containerId: string): Promise<any> {
  try {
    const { stdout } = await execAsync(
      `docker inspect ${containerId} --format '{{json .}}'`
    );
    
    const info = JSON.parse(stdout);
    
    return {
      image: info.Config?.Image,
      created: info.Created,
      startedAt: info.State?.StartedAt,
      restartCount: info.RestartCount,
      ports: info.NetworkSettings?.Ports,
      mounts: info.Mounts?.map((m: any) => ({
        source: m.Source,
        destination: m.Destination,
        type: m.Type,
      })),
      env: info.Config?.Env?.filter((e: string) => 
        !e.includes('PASSWORD') && !e.includes('SECRET') && !e.includes('TOKEN')
      ),
    };
  } catch (error) {
    logger.error('Failed to get container details', { error });
    return {};
  }
}
