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
 * Detect common dev server errors from response body
 * Returns error info if detected, null otherwise
 */
interface DevServerError {
  title: string;
  message: string;
  suggestion: string;
  originalError?: string;
}

function detectDevServerError(body: string, statusCode: number): DevServerError | null {
  // Check for HTTP error status codes
  if (statusCode >= 400 && statusCode < 600) {
    // Check for specific error patterns in the body
    
    // Vite allowedHosts error
    if (body.includes('Blocked request') && body.includes('allowedHosts')) {
      const hostMatch = body.match(/This host \("([^"]+)"\)/);
      const blockedHost = hostMatch ? hostMatch[1] : 'unknown host';
      return {
        title: 'Host Not Allowed',
        message: `The dev server blocked the request because "${blockedHost}" is not in the allowed hosts list.`,
        suggestion: 'Ask Claude to update vite.config.js and add server.allowedHosts: true',
        originalError: body.substring(0, 500),
      };
    }
    
    // Generic 403 Forbidden
    if (statusCode === 403) {
      return {
        title: 'Access Forbidden',
        message: 'The dev server rejected the request.',
        suggestion: 'Check the server configuration or ask Claude to fix the issue.',
        originalError: body.substring(0, 500),
      };
    }
    
    // 404 Not Found
    if (statusCode === 404) {
      return {
        title: 'Page Not Found',
        message: 'The requested page or resource was not found.',
        suggestion: 'Make sure the app is properly built and the route exists.',
        originalError: body.substring(0, 500),
      };
    }
    
    // 500 Internal Server Error
    if (statusCode >= 500) {
      return {
        title: 'Server Error',
        message: 'The dev server encountered an internal error.',
        suggestion: 'Check the terminal for error details or ask Claude to debug.',
        originalError: body.substring(0, 500),
      };
    }
  }
  
  // Check for error patterns in body even with 200 status (some dev servers do this)
  
  // Node.js/npm errors
  if (body.includes('Error: Cannot find module') || body.includes('MODULE_NOT_FOUND')) {
    const moduleMatch = body.match(/Cannot find module ['"]([^'"]+)['"]/);
    const moduleName = moduleMatch ? moduleMatch[1] : 'a module';
    return {
      title: 'Missing Module',
      message: `The app is missing a required dependency: ${moduleName}`,
      suggestion: 'Ask Claude to install the missing package with npm install.',
      originalError: body.substring(0, 500),
    };
  }
  
  // Syntax errors
  if (body.includes('SyntaxError:') || body.includes('Parsing error:')) {
    return {
      title: 'Syntax Error',
      message: 'There is a syntax error in the code.',
      suggestion: 'Check the terminal for the exact error location and ask Claude to fix it.',
      originalError: body.substring(0, 500),
    };
  }
  
  // Build/compilation errors
  if (body.includes('Build failed') || body.includes('Compilation failed') || body.includes('Failed to compile')) {
    return {
      title: 'Build Failed',
      message: 'The project failed to build.',
      suggestion: 'Check the terminal for build errors and ask Claude to fix them.',
      originalError: body.substring(0, 500),
    };
  }
  
  // Port already in use
  if (body.includes('EADDRINUSE') || body.includes('address already in use')) {
    return {
      title: 'Port In Use',
      message: 'The dev server port is already in use.',
      suggestion: 'Ask Claude to use a different port or stop the other process.',
      originalError: body.substring(0, 500),
    };
  }
  
  return null;
}

/**
 * Generate a styled HTML error page for dev server errors
 */
function generateDevServerErrorPage(error: DevServerError): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview Error - ${error.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e1e2e 0%, #2d2d3f 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #e0e0e0;
    }
    .error-container {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 32px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      backdrop-filter: blur(10px);
    }
    .error-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .error-title {
      font-size: 24px;
      font-weight: 600;
      color: #ff6b6b;
      margin-bottom: 12px;
    }
    .error-message {
      font-size: 16px;
      color: #b0b0b0;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .suggestion-box {
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .suggestion-label {
      font-size: 12px;
      text-transform: uppercase;
      color: #6366f1;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .suggestion-text {
      font-size: 14px;
      color: #e0e0e0;
    }
    .details-toggle {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #888;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    .details-toggle:hover {
      border-color: rgba(255, 255, 255, 0.4);
      color: #aaa;
    }
    .details-content {
      display: none;
      margin-top: 16px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
      padding: 12px;
      text-align: left;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      color: #888;
      max-height: 150px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .details-content.show {
      display: block;
    }
    .help-text {
      margin-top: 20px;
      font-size: 12px;
      color: #666;
    }
    .help-text a {
      color: #6366f1;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">⚠️</div>
    <h1 class="error-title">${escapeHtml(error.title)}</h1>
    <p class="error-message">${escapeHtml(error.message)}</p>
    
    <div class="suggestion-box">
      <div class="suggestion-label">💡 How to fix</div>
      <div class="suggestion-text">${escapeHtml(error.suggestion)}</div>
    </div>
    
    ${error.originalError ? `
    <button class="details-toggle" onclick="document.querySelector('.details-content').classList.toggle('show')">
      Show Technical Details
    </button>
    <div class="details-content">${escapeHtml(error.originalError)}</div>
    ` : ''}
    
    <p class="help-text">
      This is a development error from your app.<br>
      Check the Terminal for more details.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
          // Check for common dev server errors and show user-friendly error page
          const devServerError = detectDevServerError(body, proxyRes.statusCode || 200);
          if (devServerError) {
            res.status(200); // Return 200 so iframe displays our styled error
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(generateDevServerErrorPage(devServerError));
            return;
          }

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
