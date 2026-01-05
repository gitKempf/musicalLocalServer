/**
 * Unit Tests for PreviewVerificationService
 * Tests preview health checking and error pattern detection
 */

import { 
  PreviewVerificationService, 
  ProjectType, 
  PreviewStatus,
  HealthCheckResult,
  PreviewError 
} from '../../src/services/PreviewVerificationService';

// Mock axios
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock database
jest.mock('../../src/lib/database', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
  query: jest.fn(),
}));
import db from '../../src/lib/database';
const mockedDb = db as jest.Mocked<typeof db>;

// Helper to create mock query result
const mockQueryResult = (rows: any[], rowCount: number = rows.length) => ({
  rows,
  rowCount,
  command: 'SELECT' as const,
  oid: 0,
  fields: [],
});

describe('PreviewVerificationService', () => {
  let service: PreviewVerificationService;

  beforeEach(() => {
    service = new PreviewVerificationService({
      maxAutoFixAttempts: 3,
      healthCheckTimeoutMs: 5000,
    });
    jest.clearAllMocks();
  });

  describe('detectProjectType', () => {
    test('should detect Vite project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { vite: '^5.0.0', react: '^18.0.0' },
          scripts: { dev: 'vite', build: 'vite build' }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('vite');
    });

    test('should detect React Native Web project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { 
            expo: '^50.0.0', 
            'react-native-web': '^0.19.0',
            react: '^18.0.0' 
          }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('react-native-web');
    });

    test('should detect Next.js project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { next: '^14.0.0', react: '^18.0.0' }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('nextjs');
    });

    test('should detect Create React App project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { react: '^18.0.0' },
          devDependencies: { 'react-scripts': '^5.0.0' }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('create-react-app');
    });

    test('should detect Vue project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { vue: '^3.0.0' },
          devDependencies: { '@vue/cli-service': '^5.0.0' }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('vue');
    });

    test('should return static for no package.json', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('static');
    });

    test('should return unknown for unrecognized project', async () => {
      const mockExec = jest.fn().mockResolvedValue({
        stdout: JSON.stringify({
          dependencies: { 'some-unknown-lib': '^1.0.0' }
        }),
        stderr: ''
      });

      const projectType = await service.detectProjectType('/app', mockExec);
      expect(projectType).toBe('unknown');
    });
  });

  describe('checkPreviewHealth', () => {
    test('should return healthy for successful response', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: '<html><body>Hello World</body></html>',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('healthy');
      expect(result.responseCode).toBe(200);
      expect(result.error).toBeUndefined();
    });

    test('should detect Vite allowedHosts error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 403,
        data: 'Blocked request. This host ("preview-project_xxx") is not allowed. To allow this host, add "preview-project_xxx" to `server.allowedHosts` in vite.config.js.',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('vite_allowed_hosts');
      expect(result.error!.severity).toBe('critical');
      expect(result.error!.claudePrompt).toContain('allowedHosts');
    });

    test('should detect module not found error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'Error: Cannot find module "react-router-dom"',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('module_not_found');
    });

    test('should detect syntax error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'SyntaxError: Unexpected token at line 42',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('syntax_error');
    });

    test('should detect npm error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'npm ERR! code ENOENT\nnpm error...',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('npm_error');
    });

    test('should return unreachable for connection refused', async () => {
      const error = new Error('connect ECONNREFUSED');
      (error as any).code = 'ECONNREFUSED';
      mockedAxios.get.mockRejectedValue(error);

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('unreachable');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('server_unreachable');
    });

    test('should return unreachable for timeout', async () => {
      const error = new Error('timeout of 5000ms exceeded');
      (error as any).code = 'ETIMEDOUT';
      mockedAxios.get.mockRejectedValue(error);

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('unreachable');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('server_timeout');
    });

    test('should detect Metro bundler error for RN projects', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'Metro bundler error: Unable to resolve module',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'react-native-web');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('metro_error');
    });

    test('should detect Next.js module not found error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: "Module not found: Can't resolve '@/components/Button'",
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'nextjs');
      
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('nextjs_module_not_found');
    });
  });

  describe('saveHealthCheck', () => {
    test('should save successful health check', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([], 1));

      const result: HealthCheckResult = {
        status: 'healthy',
        responseCode: 200,
        responseTimeMs: 150,
      };

      await service.saveHealthCheck('project_123', result);

      expect(mockedDb.query).toHaveBeenCalledTimes(2);
      // First call: insert health check record
      expect(mockedDb.query).toHaveBeenNthCalledWith(1, 
        expect.stringContaining('INSERT INTO preview_health_checks'),
        expect.arrayContaining(['project_123', 'http', 'healthy'])
      );
      // Second call: update project (reset error count)
      expect(mockedDb.query).toHaveBeenNthCalledWith(2,
        expect.stringContaining('preview_error_count = 0'),
        expect.arrayContaining(['project_123', 'healthy'])
      );
    });

    test('should save error health check and increment error count', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([], 1));

      const result: HealthCheckResult = {
        status: 'error',
        responseCode: 403,
        responseTimeMs: 100,
        error: {
          type: 'vite_allowed_hosts',
          message: 'Vite blocking hosts',
          suggestion: 'Update config',
          claudePrompt: 'Fix it',
          severity: 'critical',
        },
      };

      await service.saveHealthCheck('project_123', result);

      expect(mockedDb.query).toHaveBeenCalledTimes(2);
      // Second call should increment error count
      expect(mockedDb.query).toHaveBeenNthCalledWith(2,
        expect.stringContaining('preview_error_count + 1'),
        expect.arrayContaining(['project_123', 'error', 'Vite blocking hosts'])
      );
    });
  });

  describe('shouldAttemptAutoFix', () => {
    test('should allow auto-fix when under limit', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([{ auto_fix_attempts: 1, last_auto_fix_at: null }]));

      const shouldFix = await service.shouldAttemptAutoFix('project_123');
      expect(shouldFix).toBe(true);
    });

    test('should deny auto-fix when at limit', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([{ auto_fix_attempts: 3, last_auto_fix_at: null }]));

      const shouldFix = await service.shouldAttemptAutoFix('project_123');
      expect(shouldFix).toBe(false);
    });

    test('should deny auto-fix when rate limited', async () => {
      const recentTime = new Date(Date.now() - 10000); // 10 seconds ago
      mockedDb.query.mockResolvedValue(mockQueryResult([{ auto_fix_attempts: 1, last_auto_fix_at: recentTime }]));

      const shouldFix = await service.shouldAttemptAutoFix('project_123');
      expect(shouldFix).toBe(false);
    });

    test('should allow auto-fix after rate limit expires', async () => {
      const oldTime = new Date(Date.now() - 60000); // 60 seconds ago
      mockedDb.query.mockResolvedValue(mockQueryResult([{ auto_fix_attempts: 1, last_auto_fix_at: oldTime }]));

      const shouldFix = await service.shouldAttemptAutoFix('project_123');
      expect(shouldFix).toBe(true);
    });

    test('should return false for non-existent project', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([]));

      const shouldFix = await service.shouldAttemptAutoFix('nonexistent');
      expect(shouldFix).toBe(false);
    });
  });

  describe('recordAutoFixAttempt', () => {
    test('should increment auto-fix attempts', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([], 1));

      await service.recordAutoFixAttempt('project_123');

      expect(mockedDb.query).toHaveBeenCalledWith(
        expect.stringContaining('auto_fix_attempts = auto_fix_attempts + 1'),
        ['project_123']
      );
    });
  });

  describe('resetAutoFixAttempts', () => {
    test('should reset auto-fix attempts to 0', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([], 1));

      await service.resetAutoFixAttempts('project_123');

      expect(mockedDb.query).toHaveBeenCalledWith(
        expect.stringContaining('auto_fix_attempts = 0'),
        ['project_123']
      );
    });
  });

  describe('updateProjectType', () => {
    test('should update project type in database', async () => {
      mockedDb.query.mockResolvedValue(mockQueryResult([], 1));

      await service.updateProjectType('project_123', 'vite');

      expect(mockedDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE projects SET project_type'),
        ['project_123', 'vite']
      );
    });
  });

  describe('Error pattern detection edge cases', () => {
    test('should handle 200 with error content', async () => {
      // Some servers return 200 with error pages
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: 'Error: Cannot find module "lodash"',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      // Should still detect the error in the body
      expect(result.status).toBe('error');
      expect(result.error!.type).toBe('module_not_found');
    });

    test('should handle port already in use error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'Error: EADDRINUSE: address already in use :::3000',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error!.type).toBe('port_in_use');
      expect(result.error!.severity).toBe('warning'); // Not critical, infrastructure issue
    });

    test('should handle file not found error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'ENOENT: no such file or directory, open "/app/src/missing.js"',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error!.type).toBe('file_not_found');
    });

    test('should handle unknown error gracefully', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 500,
        data: 'Some completely unknown error message that we do not recognize',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error!.type).toBe('http_500');
    });

    test('should handle 404 error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 404,
        data: 'Not Found',
      });

      const result = await service.checkPreviewHealth('http://localhost:3000', 'vite');
      
      expect(result.status).toBe('error');
      expect(result.error!.type).toBe('http_404');
    });
  });
});
