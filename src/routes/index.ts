/**
 * Route Setup - Configure all API routes
 */

import { Application } from 'express';
import { sessionRoutes } from './sessions';
import { projectRoutes } from './projects';
import { statusRoutes } from './status';
import { authRoutes } from './auth';
import { servicesRoutes } from './services';
import terminalRoutes from './terminal';
import webhookRoutes from './webhook';
import previewRoutes from './preview';

export function setupRoutes(app: Application): void {
  // API routes
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/status', statusRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/services', servicesRoutes);
  app.use('/api/terminal', terminalRoutes);
  app.use('/api/webhook', webhookRoutes);
  app.use('/api/preview', previewRoutes);

  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'Musical.run Local Server',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        auth: '/api/auth',
        sessions: '/api/sessions',
        projects: '/api/projects',
        services: '/api/services',
        status: '/api/status',
        terminal: '/api/terminal',
        webhook: '/api/webhook',
        preview: '/api/preview',
      },
    });
  });
}
