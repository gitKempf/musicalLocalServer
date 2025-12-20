/**
 * Route Setup - Configure all API routes
 */

import { Application } from 'express';
import { sessionRoutes } from './sessions';
import { projectRoutes } from './projects';
import { statusRoutes } from './status';
import { authRoutes } from './auth';
import terminalRoutes from './terminal';

export function setupRoutes(app: Application): void {
  // API routes
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/status', statusRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/terminal', terminalRoutes);

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
        status: '/api/status',
        terminal: '/api/terminal',
      },
    });
  });
}
