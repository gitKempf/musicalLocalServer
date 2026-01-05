/**
 * Preview Verification Service
 * 
 * Validates that preview builds are working correctly based on project type.
 * Diagnoses common errors and provides actionable feedback for Claude to fix.
 * 
 * Supported project types:
 * - react-native-web: Expo/React Native Web projects
 * - vite: Vite-based projects (React, Vue, Vanilla)
 * - nextjs: Next.js projects
 * - create-react-app: CRA projects
 * - vue: Vue CLI projects
 * - static: Static HTML/CSS/JS
 */

import axios from 'axios';
import { logger } from '../lib/logger';
import db from '../lib/database';

export type ProjectType = 
  | 'react-native-web'
  | 'vite'
  | 'nextjs'
  | 'create-react-app'
  | 'vue'
  | 'static'
  | 'unknown';

export type PreviewStatus = 
  | 'pending'
  | 'building'
  | 'healthy'
  | 'error'
  | 'unreachable';

export interface PreviewError {
  type: string;
  message: string;
  suggestion: string;
  claudePrompt: string;  // Specific prompt to send to Claude for auto-fix
  severity: 'critical' | 'warning' | 'info';
}

export interface HealthCheckResult {
  status: PreviewStatus;
  responseCode?: number;
  responseTimeMs?: number;
  error?: PreviewError;
  rawResponse?: string;
}

// Error patterns for different project types
const ERROR_PATTERNS: Record<string, {
  pattern: RegExp;
  errorType: string;
  message: string;
  suggestion: string;
  claudePrompt: string;
  severity: 'critical' | 'warning' | 'info';
}[]> = {
  // Vite-specific errors
  vite: [
    {
      pattern: /Blocked request.*allowedHosts/i,
      errorType: 'vite_allowed_hosts',
      message: 'Vite is blocking requests from external hosts',
      suggestion: 'Add server.allowedHosts: true to vite.config.js',
      claudePrompt: `The preview is failing because Vite is blocking external host requests. 
Please update vite.config.js to add:
\`\`\`javascript
server: {
  allowedHosts: true,
  host: '0.0.0.0',
}
\`\`\`
This allows the preview to work through the tunnel proxy.`,
      severity: 'critical',
    },
    {
      pattern: /Failed to resolve import|Cannot find module/i,
      errorType: 'module_not_found',
      message: 'A required module or import could not be found',
      suggestion: 'Install the missing dependency or fix the import path',
      claudePrompt: `The preview is failing because a module import cannot be resolved. 
Please check the error message and either:
1. Install the missing npm package
2. Fix the import path if it's incorrect
3. Create the missing file if it should exist`,
      severity: 'critical',
    },
  ],
  
  // React Native Web specific errors
  'react-native-web': [
    {
      pattern: /Metro.*error|Metro bundler/i,
      errorType: 'metro_error',
      message: 'Metro bundler encountered an error',
      suggestion: 'Check the Metro bundler output for specific error',
      claudePrompt: `The Metro bundler is failing. Please check the error and fix the issue.
Common causes:
1. Syntax errors in JavaScript/TypeScript
2. Missing dependencies
3. Invalid imports`,
      severity: 'critical',
    },
    {
      pattern: /Expo.*error|expo-cli/i,
      errorType: 'expo_error',
      message: 'Expo encountered an error',
      suggestion: 'Check Expo configuration and dependencies',
      claudePrompt: `Expo is failing to start. Please check:
1. app.json/app.config.js configuration
2. Expo SDK version compatibility
3. Missing Expo packages`,
      severity: 'critical',
    },
  ],
  
  // Next.js specific errors
  nextjs: [
    {
      pattern: /Module not found.*Can't resolve/i,
      errorType: 'nextjs_module_not_found',
      message: 'Next.js cannot resolve a module',
      suggestion: 'Install missing dependency or fix import',
      claudePrompt: `Next.js build is failing due to a missing module. Please:
1. Check which module is missing from the error
2. Install it with npm install <package>
3. Or fix the import path if incorrect`,
      severity: 'critical',
    },
    {
      pattern: /Server Error.*in.*page/i,
      errorType: 'nextjs_server_error',
      message: 'Next.js server-side error',
      suggestion: 'Check server component or API route code',
      claudePrompt: `There's a server-side error in Next.js. Please check:
1. Server components for errors
2. API routes for issues
3. Data fetching functions`,
      severity: 'critical',
    },
  ],
  
  // Common errors across all project types
  common: [
    {
      pattern: /SyntaxError|Parsing error|Unexpected token/i,
      errorType: 'syntax_error',
      message: 'Syntax error in the code',
      suggestion: 'Fix the JavaScript/TypeScript syntax error',
      claudePrompt: `There's a syntax error in the code. Please:
1. Find the file and line number from the error
2. Fix the syntax issue
3. Common causes: missing brackets, typos, invalid syntax`,
      severity: 'critical',
    },
    {
      pattern: /EADDRINUSE|address already in use/i,
      errorType: 'port_in_use',
      message: 'The port is already in use',
      suggestion: 'The dev server port is occupied',
      claudePrompt: `The dev server port is already in use. This is usually a Musical infrastructure issue, not a code problem. Try rebuilding the preview.`,
      severity: 'warning',
    },
    {
      pattern: /npm ERR!|npm error/i,
      errorType: 'npm_error',
      message: 'npm encountered an error',
      suggestion: 'Check package.json and dependencies',
      claudePrompt: `npm is failing. Please check:
1. package.json for syntax errors
2. Dependencies are correctly specified
3. No conflicting package versions`,
      severity: 'critical',
    },
    {
      pattern: /ENOENT|no such file or directory/i,
      errorType: 'file_not_found',
      message: 'A required file is missing',
      suggestion: 'Create the missing file or fix the path',
      claudePrompt: `A required file is missing. Please check:
1. The file path in the error
2. Create the file if it should exist
3. Fix the path if it's incorrect`,
      severity: 'critical',
    },
    {
      pattern: /TypeError|ReferenceError|Error:/i,
      errorType: 'runtime_error',
      message: 'Runtime JavaScript error',
      suggestion: 'Fix the runtime error in the code',
      claudePrompt: `There's a runtime error. Please check the error message and fix the issue in the code.`,
      severity: 'critical',
    },
  ],
};

export class PreviewVerificationService {
  private maxAutoFixAttempts: number;
  private healthCheckTimeoutMs: number;

  constructor(config: {
    maxAutoFixAttempts?: number;
    healthCheckTimeoutMs?: number;
  } = {}) {
    this.maxAutoFixAttempts = config.maxAutoFixAttempts || 3;
    this.healthCheckTimeoutMs = config.healthCheckTimeoutMs || 10000;
  }

  /**
   * Detect project type from package.json and project structure
   */
  async detectProjectType(projectPath: string, containerExec?: (cmd: string) => Promise<{stdout: string; stderr: string}>): Promise<ProjectType> {
    try {
      let packageJsonContent: string;
      
      if (containerExec) {
        // Execute in container
        const result = await containerExec('cat /app/package.json 2>/dev/null');
        packageJsonContent = result.stdout;
      } else {
        // Local file system (for testing)
        const fs = await import('fs/promises');
        packageJsonContent = await fs.readFile(`${projectPath}/package.json`, 'utf-8');
      }

      if (!packageJsonContent.trim()) {
        return 'static';
      }

      const packageJson = JSON.parse(packageJsonContent);
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Check for specific frameworks
      if (deps['expo'] || deps['react-native-web']) {
        return 'react-native-web';
      }
      if (deps['next']) {
        return 'nextjs';
      }
      if (deps['vite']) {
        return 'vite';
      }
      if (deps['react-scripts']) {
        return 'create-react-app';
      }
      if (deps['@vue/cli-service'] || deps['vue']) {
        return 'vue';
      }

      // Check scripts for hints
      const scripts = packageJson.scripts || {};
      if (scripts.dev?.includes('vite') || scripts.start?.includes('vite')) {
        return 'vite';
      }
      if (scripts.dev?.includes('next') || scripts.start?.includes('next')) {
        return 'nextjs';
      }
      if (scripts.start?.includes('expo')) {
        return 'react-native-web';
      }

      return 'unknown';
    } catch (error) {
      logger.warn('Could not detect project type', { error });
      return 'unknown';
    }
  }

  /**
   * Perform health check on preview URL
   */
  async checkPreviewHealth(
    previewUrl: string,
    projectType: ProjectType
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await axios.get(previewUrl, {
        timeout: this.healthCheckTimeoutMs,
        validateStatus: () => true, // Accept any status code
        maxRedirects: 5,
      });

      const responseTimeMs = Date.now() - startTime;
      const responseBody = typeof response.data === 'string' 
        ? response.data 
        : JSON.stringify(response.data);

      // Check for success
      if (response.status >= 200 && response.status < 400) {
        // Even with 200, check for error patterns in the body
        const error = this.detectErrorInResponse(responseBody, projectType);
        
        if (error) {
          return {
            status: 'error',
            responseCode: response.status,
            responseTimeMs,
            error,
            rawResponse: responseBody.substring(0, 2000),
          };
        }

        return {
          status: 'healthy',
          responseCode: response.status,
          responseTimeMs,
        };
      }

      // Handle error status codes
      const error = this.detectErrorInResponse(responseBody, projectType) || {
        type: `http_${response.status}`,
        message: `HTTP ${response.status} error`,
        suggestion: 'Check the dev server logs for details',
        claudePrompt: `The preview is returning HTTP ${response.status}. Please check the server output for errors.`,
        severity: 'critical' as const,
      };

      return {
        status: 'error',
        responseCode: response.status,
        responseTimeMs,
        error,
        rawResponse: responseBody.substring(0, 2000),
      };

    } catch (error: any) {
      const responseTimeMs = Date.now() - startTime;

      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        return {
          status: 'unreachable',
          responseTimeMs,
          error: {
            type: 'server_unreachable',
            message: 'Preview server is not responding',
            suggestion: 'The dev server may not be running',
            claudePrompt: `The preview server is not reachable. Please:
1. Check if the dev server is running
2. Look for startup errors in the terminal
3. Make sure the correct port is being used`,
            severity: 'critical',
          },
        };
      }

      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return {
          status: 'unreachable',
          responseTimeMs,
          error: {
            type: 'server_timeout',
            message: 'Preview server timed out',
            suggestion: 'The server is too slow to respond',
            claudePrompt: `The preview server is timing out. This may indicate:
1. The server is stuck during startup
2. There's an infinite loop in the code
3. Heavy processing blocking the response`,
            severity: 'critical',
          },
        };
      }

      return {
        status: 'error',
        responseTimeMs,
        error: {
          type: 'unknown_error',
          message: error.message,
          suggestion: 'Unknown error occurred',
          claudePrompt: `An unexpected error occurred: ${error.message}`,
          severity: 'critical',
        },
      };
    }
  }

  /**
   * Detect error patterns in response body
   */
  private detectErrorInResponse(
    body: string,
    projectType: ProjectType
  ): PreviewError | null {
    // Check project-specific patterns first
    const projectPatterns = ERROR_PATTERNS[projectType] || [];
    for (const pattern of projectPatterns) {
      if (pattern.pattern.test(body)) {
        return {
          type: pattern.errorType,
          message: pattern.message,
          suggestion: pattern.suggestion,
          claudePrompt: pattern.claudePrompt,
          severity: pattern.severity,
        };
      }
    }

    // Check common patterns
    for (const pattern of ERROR_PATTERNS.common) {
      if (pattern.pattern.test(body)) {
        return {
          type: pattern.errorType,
          message: pattern.message,
          suggestion: pattern.suggestion,
          claudePrompt: pattern.claudePrompt,
          severity: pattern.severity,
        };
      }
    }

    return null;
  }

  /**
   * Save health check result to database
   */
  async saveHealthCheck(
    projectId: string,
    result: HealthCheckResult
  ): Promise<void> {
    try {
      // Insert health check record
      await db.query(
        `INSERT INTO preview_health_checks 
         (project_id, check_type, status, error_type, error_message, response_code, response_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          projectId,
          'http',
          result.status,
          result.error?.type || null,
          result.error?.message || null,
          result.responseCode || null,
          result.responseTimeMs || null,
        ]
      );

      // Update project preview status
      const updateFields: any = {
        preview_status: result.status,
        preview_last_checked_at: new Date(),
      };

      if (result.error) {
        updateFields.preview_last_error = result.error.message;
        // Increment error count
        await db.query(
          `UPDATE projects SET 
           preview_status = $2, 
           preview_last_error = $3,
           preview_last_checked_at = NOW(),
           preview_error_count = preview_error_count + 1
           WHERE id = $1`,
          [projectId, result.status, result.error.message]
        );
      } else {
        // Reset error count on success
        await db.query(
          `UPDATE projects SET 
           preview_status = $2, 
           preview_last_error = NULL,
           preview_last_checked_at = NOW(),
           preview_error_count = 0
           WHERE id = $1`,
          [projectId, result.status]
        );
      }

    } catch (error) {
      logger.error('Failed to save health check', { projectId, error });
    }
  }

  /**
   * Check if auto-fix should be attempted
   */
  async shouldAttemptAutoFix(projectId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT auto_fix_attempts, last_auto_fix_at FROM projects WHERE id = $1`,
        [projectId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      const { auto_fix_attempts, last_auto_fix_at } = result.rows[0];

      // Don't exceed max attempts
      if (auto_fix_attempts >= this.maxAutoFixAttempts) {
        logger.info('Max auto-fix attempts reached', { projectId, attempts: auto_fix_attempts });
        return false;
      }

      // Rate limit: Don't retry within 30 seconds
      if (last_auto_fix_at) {
        const timeSinceLastFix = Date.now() - new Date(last_auto_fix_at).getTime();
        if (timeSinceLastFix < 30000) {
          logger.info('Auto-fix rate limited', { projectId, timeSinceLastFix });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error checking auto-fix eligibility', { projectId, error });
      return false;
    }
  }

  /**
   * Record an auto-fix attempt
   */
  async recordAutoFixAttempt(projectId: string): Promise<void> {
    try {
      await db.query(
        `UPDATE projects SET 
         auto_fix_attempts = auto_fix_attempts + 1,
         last_auto_fix_at = NOW()
         WHERE id = $1`,
        [projectId]
      );
    } catch (error) {
      logger.error('Failed to record auto-fix attempt', { projectId, error });
    }
  }

  /**
   * Reset auto-fix attempts (call when preview becomes healthy)
   */
  async resetAutoFixAttempts(projectId: string): Promise<void> {
    try {
      await db.query(
        `UPDATE projects SET 
         auto_fix_attempts = 0,
         last_auto_fix_at = NULL
         WHERE id = $1`,
        [projectId]
      );
    } catch (error) {
      logger.error('Failed to reset auto-fix attempts', { projectId, error });
    }
  }

  /**
   * Update project type in database
   */
  async updateProjectType(projectId: string, projectType: ProjectType): Promise<void> {
    try {
      await db.query(
        `UPDATE projects SET project_type = $2 WHERE id = $1`,
        [projectId, projectType]
      );
      logger.info('Updated project type', { projectId, projectType });
    } catch (error) {
      logger.error('Failed to update project type', { projectId, error });
    }
  }
}

// Singleton instance
let verificationServiceInstance: PreviewVerificationService | null = null;

export function getPreviewVerificationService(): PreviewVerificationService {
  if (!verificationServiceInstance) {
    verificationServiceInstance = new PreviewVerificationService();
  }
  return verificationServiceInstance;
}
