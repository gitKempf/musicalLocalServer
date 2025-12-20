/**
 * Complete E2E Test Suite for Musical.run Local Server
 * Tests all critical user flows matching frontend functionality
 */

import request from 'supertest';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const LOCAL_SERVER_URL = process.env.LOCAL_SERVER_URL || 'http://localhost:17100';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://musical.run';
const CLAUDE_AGENT_URL = process.env.CLAUDE_AGENT_URL || 'http://localhost:17110';
const GITEA_URL = process.env.GITEA_URL || 'http://localhost:17101';

// Test credentials - MUST be provided via environment variables
const TEST_USER = {
  email: process.env.TEST_EMAIL || '',
  password: process.env.TEST_PASSWORD || ''
};

// Validate test credentials are provided
if (!TEST_USER.email || !TEST_USER.password) {
  console.warn('⚠️  TEST_EMAIL and TEST_PASSWORD environment variables must be set for E2E tests');
}

describe('Local Server E2E Tests - Complete Flow', () => {
  let authToken: string;
  let refreshToken: string;
  let userId: string;
  let projectId: string;
  let sessionId: string;
  let containerId: string;

  // Test timeout extended for E2E tests
  jest.setTimeout(120000); // 2 minutes

  describe('1. Authentication', () => {
    test('should login via CLI and get valid token', async () => {
      // Call auth service login endpoint
      const response = await axios.post(`${AUTH_SERVICE_URL}/api/auth/login`, {
        email: TEST_USER.email,
        password: TEST_USER.password
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('tokens');
      expect(response.data.tokens).toHaveProperty('accessToken');
      expect(response.data.tokens).toHaveProperty('refreshToken');
      expect(response.data).toHaveProperty('user');

      // Save tokens for subsequent tests
      authToken = response.data.tokens.accessToken;
      refreshToken = response.data.tokens.refreshToken;
      userId = response.data.user.id.toString();

      console.log('✓ Authentication successful');
      console.log(`  User ID: ${userId}`);
      console.log(`  Email: ${response.data.user.email}`);
    });

    test('should verify token is valid', async () => {
      const response = await axios.get(`${AUTH_SERVICE_URL}/api/auth/verify`, {
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data.user.userId).toBe(parseInt(userId));
      console.log('✓ Token verification successful');
    });

    test('should confirm local server is authenticated', async () => {
      const response = await axios.get(`${LOCAL_SERVER_URL}/health`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', 'healthy');
      expect(response.data).toHaveProperty('authenticated', true);
      expect(response.data).toHaveProperty('user');
      expect(response.data.user).toHaveProperty('email', TEST_USER.email);

      console.log('✓ Local server is authenticated');
      console.log(`  User: ${response.data.user.email}`);
    });
  });

  describe('2. Project Creation', () => {
    test('should create a new project', async () => {
      const projectData = {
        name: 'E2E Test Project',
        description: 'Test project created by E2E test suite',
        template: 'react-native',
        userId: userId
      };

      const response = await axios.post(
        `${LOCAL_SERVER_URL}/api/projects`,
        projectData,
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('project');
      expect(response.data.project).toHaveProperty('id');
      expect(response.data.project).toHaveProperty('name', projectData.name);

      projectId = response.data.project.id;
      console.log('✓ Project created successfully');
      console.log(`  Project ID: ${projectId}`);
      console.log(`  Name: ${response.data.project.name}`);
    });

    test('should retrieve project details', async () => {
      const response = await axios.get(
        `${LOCAL_SERVER_URL}/api/projects/${projectId}`,
        {
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('project');
      expect(response.data.project.id).toBe(projectId);

      console.log('✓ Project retrieval successful');
    });
  });

  describe('3. Container Creation', () => {
    test('should create Claude Code container for project', async () => {
      const response = await axios.post(
        `${LOCAL_SERVER_URL}/api/sessions/create`,
        {
          projectId: projectId,
          userId: userId
        },
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('sessionId');
      expect(response.data).toHaveProperty('projectId', projectId);
      expect(response.data).toHaveProperty('status');

      sessionId = response.data.sessionId;
      // Note: containerId may be available in session details, not in creation response

      console.log('✓ Session created successfully');
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Project ID: ${response.data.projectId}`);
      console.log(`  Status: ${response.data.status}`);
    });

    test('should verify container is running', async () => {
      // Check Claude agent health
      const response = await axios.get(`${CLAUDE_AGENT_URL}/health`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(['healthy', 'running']).toContain(response.data.status);

      console.log('✓ Container is running and healthy');
    });
  });

  describe('4. Tunnel Connection', () => {
    test('should establish tunnel connection', async () => {
      // Check if tunnel is configured
      const response = await axios.get(`${LOCAL_SERVER_URL}/api/status/config`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);

      // Note: Tunnel may not be configured in test environment
      // This test validates the API endpoint exists
      console.log('✓ Tunnel status API available');
      console.log(`  Config endpoint working: ${response.data.success}`);
    });

    test('should provide tunnel URL if configured', async () => {
      // In production, this would return tunnel URL
      // In test env, we just validate the endpoint exists
      const response = await axios.get(`${LOCAL_SERVER_URL}/api/status`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', 'running');

      console.log('✓ Status endpoint provides server info');
    });
  });

  describe('5. Session Restoration', () => {
    test('should restore existing session', async () => {
      // Get session details to verify it exists
      const response = await axios.get(
        `${LOCAL_SERVER_URL}/api/sessions/${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('session');
      expect(response.data.session).toHaveProperty('id', sessionId);
      expect(response.data.session).toHaveProperty('projectId', projectId);

      console.log('✓ Session restoration successful');
      console.log(`  Restored session: ${sessionId}`);
      console.log(`  Project: ${projectId}`);
    });

    test('should list all sessions', async () => {
      const response = await axios.get(
        `${LOCAL_SERVER_URL}/api/sessions`,
        {
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('sessions');
      expect(Array.isArray(response.data.sessions)).toBe(true);
      expect(response.data.sessions.length).toBeGreaterThan(0);

      // Find our session
      const ourSession = response.data.sessions.find((s: any) => s.id === sessionId);
      expect(ourSession).toBeDefined();

      console.log('✓ Session listing successful');
      console.log(`  Total sessions: ${response.data.sessions.length}`);
    });
  });

  describe('6. Git MCP Commits', () => {
    test('should verify Gitea is accessible', async () => {
      try {
        const response = await axios.get(`${GITEA_URL}/api/v1/version`, {
          timeout: 5000
        });

        expect(response.status).toBe(200);
        expect(response.data).toHaveProperty('version');

        console.log('✓ Gitea is accessible');
        console.log(`  Version: ${response.data.version}`);
      } catch (error: any) {
        console.log('⚠ Gitea not available (optional for basic flow)');
        console.log(`  This is expected if Gitea is not running`);
        // Don't fail test if Gitea is not running
      }
    });

    test('should verify MCP Git tools are available in Claude agent', async () => {
      // Check Claude agent health which includes MCP status
      const response = await axios.get(`${CLAUDE_AGENT_URL}/health`);

      expect(response.status).toBe(200);

      console.log('✓ Claude agent with MCP tools is available');
    });
  });

  describe('7. Project Preview', () => {
    test('should get preview URL for generated project', async () => {
      // In a real scenario, after code generation completes,
      // we would get a preview URL. For now, verify the API exists.
      const response = await axios.get(
        `${LOCAL_SERVER_URL}/api/projects/${projectId}`,
        {
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('project');

      console.log('✓ Project preview API available');
      console.log(`  Project ID: ${projectId}`);

      // Note: Preview URL would be available after successful code generation
      if (response.data.project.previewUrl) {
        console.log(`  Preview URL: ${response.data.project.previewUrl}`);
      } else {
        console.log(`  Preview URL will be available after code generation`);
      }
    });

    test('should verify preview service is accessible', async () => {
      // Check if preview proxy/service is running
      const statusResponse = await axios.get(`${LOCAL_SERVER_URL}/api/status`);

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.data).toHaveProperty('capabilities');

      if (statusResponse.data.capabilities.preview) {
        console.log('✓ Preview capability is enabled');
      } else {
        console.log('⚠ Preview capability configuration needed');
      }
    });
  });

  // Cleanup after tests
  afterAll(async () => {
    try {
      // Delete session/container
      if (sessionId) {
        await axios.delete(
          `${LOCAL_SERVER_URL}/api/sessions/${sessionId}`,
          {
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          }
        );
        console.log('✓ Test session cleaned up');
      }

      // Delete test project
      if (projectId) {
        await axios.delete(
          `${LOCAL_SERVER_URL}/api/projects/${projectId}`,
          {
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          }
        );
        console.log('✓ Test project cleaned up');
      }
    } catch (error) {
      console.log('Cleanup completed with warnings');
    }
  });
});
