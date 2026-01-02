/**
 * Preview Proxy Routes
 * 
 * Proxies requests to preview containers, allowing access through the tunnel.
 * This solves the mixed content issue when the frontend is on HTTPS.
 */

import { Router, Request, Response } from 'express';
import http from 'http';
import { logger } from '../lib/logger';
import db from '../lib/database';

const router = Router();

/**
 * GET /api/preview/:projectId/*
 * Proxies requests to the preview container for the given project
 */
router.all('/:projectId/*', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const path = req.params[0] || '';

  try {
    // Get project from database to find preview URL
    const result = await db.query(
      'SELECT * FROM projects WHERE id = $1',
      [projectId]
    );
    const project = result.rows[0];

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check if preview container exists
    if (!project.preview_container_id || !project.preview_url) {
      return res.status(404).json({
        error: 'Preview not available',
        message: 'No preview has been built for this project yet. Commit code to trigger a preview build.',
      });
    }

    // Use container name for Docker network access (internal port 3000)
    // The preview container exposes port 3000 internally
    const containerName = project.preview_container_id;
    const internalPort = 3000; // Preview containers always use port 3000 internally

    logger.debug('Proxying preview request', {
      projectId,
      path,
      containerName,
      internalPort,
    });

    // Create proxy request using container name (works on Docker network)
    const proxyReq = http.request({
      hostname: containerName,
      port: internalPort,
      path: '/' + path + (req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''),
      method: req.method,
      headers: {
        ...req.headers,
        // Use localhost as host to avoid Vite's allowedHosts security check
        host: `localhost:${internalPort}`,
      },
    }, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const isJs = contentType.includes('javascript') || contentType.includes('application/json');
      const isCss = contentType.includes('text/css');

      // For HTML, JS, and CSS responses, we need to rewrite paths
      if (isHtml || isJs || isCss) {
        let body = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (chunk) => {
          body += chunk;
        });
        proxyRes.on('end', () => {
          // Base URL for this project's preview
          const baseUrl = `/api/preview/${projectId}/`;
          let modifiedBody = body;

          if (isHtml) {
            // Disable Vite HMR when accessed through proxy (it can't connect to localhost)
            const hmrDisableScript = `<script>
              // Disable Vite HMR - we're behind a proxy and WebSocket won't work
              window.__vite_is_modern_browser = false;
              window.__HMR_ENABLE_OVERLAY__ = false;
            </script>`;
            
            const baseTag = `<base href="${baseUrl}">`;
            
            // Insert base tag and HMR disable script after <head>
            if (body.includes('<head>')) {
              modifiedBody = body.replace('<head>', `<head>${baseTag}${hmrDisableScript}`);
            } else if (body.includes('<HEAD>')) {
              modifiedBody = body.replace('<HEAD>', `<HEAD>${baseTag}${hmrDisableScript}`);
            } else if (body.includes('<!DOCTYPE') || body.includes('<!doctype')) {
              // Insert after doctype
              modifiedBody = body.replace(/(<!DOCTYPE[^>]*>|<!doctype[^>]*>)/i, `$1${baseTag}${hmrDisableScript}`);
            } else {
              modifiedBody = baseTag + hmrDisableScript + body;
            }
            
            // Rewrite absolute paths (starting with /) to go through the preview proxy
            // Replace src="/ and href="/ with src="/api/preview/projectId/ and href="/api/preview/projectId/
            modifiedBody = modifiedBody.replace(
              /(src|href)=["']\/(?!api\/preview\/|http|\/\/)/gi,
              `$1="${baseUrl}`
            );
            
            // Also handle single-quoted attributes
            modifiedBody = modifiedBody.replace(
              /(src|href)='\/(?!api\/preview\/|http|\/\/)/gi,
              `$1='${baseUrl}`
            );
            
            // Rewrite inline script imports like: import { x } from "/@react-refresh"
            // This is needed for Vite's React refresh to work
            modifiedBody = modifiedBody.replace(
              /from\s*["']\/(?!api\/preview\/|http|\/\/)/g,
              `from "${baseUrl}`
            );
          }

          // For JS files, rewrite import paths and dynamic imports
          // This handles Vite's transformed imports like: import App from "/src/App.jsx"
          if (isJs) {
            // Rewrite ES module imports: from "/path" -> from "/api/preview/projectId/path"
            modifiedBody = modifiedBody.replace(
              /from\s*["']\/(?!api\/preview\/|http|\/\/)/g,
              `from "${baseUrl}`
            );
            
            // Rewrite dynamic imports: import("/path") -> import("/api/preview/projectId/path")
            modifiedBody = modifiedBody.replace(
              /import\s*\(\s*["']\/(?!api\/preview\/|http|\/\/)/g,
              `import("${baseUrl}`
            );
            
            // Rewrite bare path strings that look like module paths
            // This catches patterns like: "/node_modules/.vite/deps/..."
            modifiedBody = modifiedBody.replace(
              /["']\/node_modules\//g,
              `"${baseUrl}node_modules/`
            );
            modifiedBody = modifiedBody.replace(
              /["']\/@/g,
              `"${baseUrl}@`
            );
            modifiedBody = modifiedBody.replace(
              /["']\/src\//g,
              `"${baseUrl}src/`
            );
            
            // Disable Vite HMR WebSocket connections in @vite/client
            // Replace WebSocket connection attempts with a no-op
            if (path.includes('@vite/client') || path.includes('vite/dist/client')) {
              // Replace the WebSocket constructor call to prevent connection attempts
              modifiedBody = modifiedBody.replace(
                /new\s+WebSocket\s*\(/g,
                '(function(){console.log("[Proxy] HMR disabled - preview via tunnel");return{addEventListener:()=>{},send:()=>{},close:()=>{}}})(//new WebSocket('
              );
            }
          }

          // For CSS files, rewrite url() paths
          if (isCss) {
            modifiedBody = modifiedBody.replace(
              /url\(\s*["']?\/(?!api\/preview\/|http|\/\/)/gi,
              `url(${baseUrl}`
            );
          }

          // Copy headers except content-length (it changed)
          res.status(proxyRes.statusCode || 200);
          Object.keys(proxyRes.headers).forEach((key) => {
            if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'transfer-encoding') {
              const value = proxyRes.headers[key];
              if (value) {
                res.setHeader(key, value);
              }
            }
          });

          res.setHeader('Content-Length', Buffer.byteLength(modifiedBody, 'utf8'));
          res.send(modifiedBody);
        });
      } else {
        // For non-HTML responses, just pipe through
        res.status(proxyRes.statusCode || 200);
        Object.keys(proxyRes.headers).forEach((key) => {
          const value = proxyRes.headers[key];
          if (value) {
            res.setHeader(key, value);
          }
        });

        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      logger.error('Preview proxy error', { projectId, error: err.message });
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Preview unavailable',
          message: 'The preview server is not responding. Make sure the dev server is running.',
        });
      }
    });

    // Pipe request body if present
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } catch (error: any) {
    logger.error('Preview proxy failed', { projectId, error: error.message });
    res.status(500).json({ error: 'Failed to proxy preview request' });
  }
});

/**
 * GET /api/preview/:projectId
 * Returns preview status for a project
 */
router.get('/:projectId', async (req: Request, res: Response) => {
  const { projectId } = req.params;

  try {
    const result = await db.query(
      'SELECT * FROM projects WHERE id = $1',
      [projectId]
    );
    const project = result.rows[0];

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      projectId,
      hasPreview: !!project.preview_container_id,
      previewUrl: project.preview_url,
      previewContainerId: project.preview_container_id,
      // The proxy URL that can be used from the frontend
      proxyUrl: project.preview_container_id 
        ? `/api/preview/${projectId}/` 
        : null,
    });
  } catch (error: any) {
    logger.error('Failed to get preview status', { projectId, error: error.message });
    res.status(500).json({ error: 'Failed to get preview status' });
  }
});

export default router;
