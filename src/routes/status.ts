/**
 * Status Routes - Server status and configuration
 */

import { Router } from 'express';
import { logger } from '../lib/logger';
import { encryptionService } from '../lib/EncryptionService';

export const statusRoutes = Router();

/**
 * GET /api/status
 * Get local server status
 */
statusRoutes.get('/', async (req, res) => {
  try {
    res.json({
      success: true,
      status: 'running',
      version: '1.0.0',
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      publicKey: encryptionService.getPublicKey(),
      capabilities: {
        claudeCode: true,
        encryption: true,
        gitea: true,
        preview: true,
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to get status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/status/config
 * Get server configuration (non-sensitive)
 */
statusRoutes.get('/config', async (req, res) => {
  try {
    res.json({
      success: true,
      config: {
        port: process.env.PORT || 17100,
        nodeEnv: process.env.NODE_ENV || 'development',
        claudeAutoShutdown: parseInt(process.env.CLAUDE_AUTO_SHUTDOWN_MINUTES || '30'),
        previewDomain: process.env.PREVIEW_DOMAIN || 'preview.musical.run',
        logLevel: process.env.LOG_LEVEL || 'info',
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to get config', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/status/config
 * Update server configuration
 */
statusRoutes.post('/config', async (req, res) => {
  try {
    const updates = req.body;

    logger.info('⚙️  Updating server configuration', { updates });

    // TODO: Implement configuration updates
    // Need to validate and persist config changes

    res.json({
      success: true,
      message: 'Configuration update not yet implemented',
    });
  } catch (error: any) {
    logger.error('❌ Failed to update config', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
