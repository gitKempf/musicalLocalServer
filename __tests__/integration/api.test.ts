/**
 * Integration Tests for API Endpoints
 * Tests REST API functionality
 */

import request from 'supertest';
import express from 'express';
import { setupRoutes } from '../../src/routes';
import { encryptionService } from '../../src/lib/EncryptionService';

describe('API Integration Tests', () => {
  let app: express.Application;

  beforeAll(async () => {
    // Initialize encryption service
    await encryptionService.initialize();

    // Create Express app
    app = express();
    app.use(express.json());

    // Setup routes
    setupRoutes(app);
  });

  describe('Root Endpoint', () => {
    test('GET / should return API info', async () => {
      const response = await request(app)
        .get('/')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('status', 'running');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body.endpoints).toHaveProperty('health');
      expect(response.body.endpoints).toHaveProperty('sessions');
      expect(response.body.endpoints).toHaveProperty('projects');
    });
  });

  describe('Session Routes', () => {
    test('GET /api/sessions should return empty sessions list', async () => {
      const response = await request(app)
        .get('/api/sessions')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('sessions');
      expect(Array.isArray(response.body.sessions)).toBe(true);
    });

    test('POST /api/sessions/create should create a new session', async () => {
      const response = await request(app)
        .post('/api/sessions/create')
        .send({
          projectId: 'test-project-123',
          template: 'react-native',
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('sessionId');
      expect(response.body).toHaveProperty('projectId', 'test-project-123');
      expect(response.body).toHaveProperty('template', 'react-native');
    });

    test('POST /api/sessions/create should fail without projectId', async () => {
      const response = await request(app)
        .post('/api/sessions/create')
        .send({
          template: 'react-native',
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    test('POST /api/sessions/:sessionId/message should handle encrypted messages', async () => {
      const sessionId = 'test-session-123';
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/message`)
        .send({
          encryptedMessage: 'fake-encrypted-message',
          senderPublicKey: 'fake-public-key',
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });

    test('POST /api/sessions/:sessionId/message should fail without required fields', async () => {
      const sessionId = 'test-session-123';
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/message`)
        .send({
          encryptedMessage: 'fake-encrypted-message',
          // Missing senderPublicKey
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    test('GET /api/sessions/:sessionId should return session details', async () => {
      const sessionId = 'test-session-123';
      const response = await request(app)
        .get(`/api/sessions/${sessionId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('session');
      expect(response.body.session).toHaveProperty('id', sessionId);
    });

    test('DELETE /api/sessions/:sessionId should delete session', async () => {
      const sessionId = 'test-session-to-delete';
      const response = await request(app)
        .delete(`/api/sessions/${sessionId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message');
    });
  });

  describe('Project Routes', () => {
    test('GET /api/projects should return empty projects list', async () => {
      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('projects');
      expect(Array.isArray(response.body.projects)).toBe(true);
    });

    test('POST /api/projects should create a new project', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({
          name: 'Test Project',
          description: 'A test project',
          template: 'react-native',
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('project');
      expect(response.body.project).toHaveProperty('id');
      expect(response.body.project).toHaveProperty('name', 'Test Project');
      expect(response.body.project).toHaveProperty('template', 'react-native');
    });

    test('POST /api/projects should fail without name', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({
          description: 'A test project',
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    test('GET /api/projects/:projectId should return project details', async () => {
      const projectId = 'test-project-123';
      const response = await request(app)
        .get(`/api/projects/${projectId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('project');
      expect(response.body.project).toHaveProperty('id', projectId);
    });

    test('DELETE /api/projects/:projectId should delete project', async () => {
      const projectId = 'test-project-to-delete';
      const response = await request(app)
        .delete(`/api/projects/${projectId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message');
    });
  });

  describe('Status Routes', () => {
    test('GET /api/status should return server status', async () => {
      const response = await request(app)
        .get('/api/status')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('status', 'running');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('memory');
      expect(response.body).toHaveProperty('publicKey');
      expect(response.body).toHaveProperty('capabilities');
    });

    test('GET /api/status/config should return server configuration', async () => {
      const response = await request(app)
        .get('/api/status/config')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('config');
      expect(response.body.config).toHaveProperty('port');
      expect(response.body.config).toHaveProperty('nodeEnv');
      expect(response.body.config).toHaveProperty('claudeAutoShutdown');
    });

    test('POST /api/status/config should handle config updates', async () => {
      const response = await request(app)
        .post('/api/status/config')
        .send({
          logLevel: 'debug',
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });
  });

  describe('Error Handling', () => {
    test('should return 404 for unknown routes', async () => {
      await request(app)
        .get('/api/unknown-route')
        .expect(404);
    });

    test('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/sessions/create')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);
    });
  });

  describe('CORS and Security', () => {
    test('should accept JSON content-type', async () => {
      await request(app)
        .post('/api/sessions/create')
        .set('Content-Type', 'application/json')
        .send({ projectId: 'test' })
        .expect(200);
    });

    test('should handle large payloads within limit', async () => {
      const largePayload = {
        projectId: 'test',
        metadata: {
          data: 'A'.repeat(100000), // 100KB (within 10MB limit)
        },
      };

      await request(app)
        .post('/api/sessions/create')
        .send(largePayload)
        .expect(200);
    });
  });

  describe('Performance', () => {
    test('should handle 100 concurrent requests', async () => {
      const requests = Array.from({ length: 100 }, (_, i) =>
        request(app)
          .get('/api/status')
          .expect(200)
      );

      const responses = await Promise.all(requests);
      expect(responses.length).toBe(100);
      responses.forEach(res => {
        expect(res.body).toHaveProperty('success', true);
      });
    });

    test('should respond to health check in under 100ms', async () => {
      const startTime = Date.now();

      await request(app)
        .get('/api/status')
        .expect(200);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
