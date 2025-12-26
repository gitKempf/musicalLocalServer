/**
 * Integration Tests for Auth Routes
 * Tests authentication API endpoints including server auth flow
 */

import request from 'supertest';
import express from 'express';
import { authRoutes, initializeAuthRoutes } from '../../src/routes/auth';

// Mock auth service for testing
class MockAuthService {
  private authenticated = false;
  private userData: any = null;
  private tokens: any = null;

  isAuthenticated() {
    return this.authenticated;
  }

  getUserData() {
    return this.userData;
  }

  setAuthenticated(value: boolean) {
    this.authenticated = value;
  }

  setUserData(data: any) {
    this.userData = data;
    this.authenticated = !!data;
  }

  async setToken(tokenData: any) {
    this.tokens = tokenData;
    this.userData = tokenData;
    this.authenticated = true;
  }

  async verifyToken(token: string): Promise<{ valid: boolean; userId?: string; error?: string }> {
    if (token === 'valid_token') {
      return { valid: true, userId: '123' };
    }
    return { valid: false, error: 'Invalid token' };
  }

  async logout() {
    this.authenticated = false;
    this.userData = null;
    this.tokens = null;
  }

  reset() {
    this.authenticated = false;
    this.userData = null;
    this.tokens = null;
  }
}

describe('Auth Routes Integration Tests', () => {
  let app: express.Application;
  let mockAuthService: MockAuthService;

  beforeAll(async () => {
    // Create Express app
    app = express();
    app.use(express.json());

    // Create and initialize mock auth service
    mockAuthService = new MockAuthService();
    initializeAuthRoutes(mockAuthService);

    // Mount auth routes
    app.use('/api/auth', authRoutes);
  });

  afterAll(() => {
    // Clean up any pending operations
    jest.clearAllTimers();
  });

  beforeEach(() => {
    // Reset mock state before each test
    mockAuthService.reset();
  });

  describe('GET /api/auth/status', () => {
    test('should return unauthenticated status when not logged in', async () => {
      const response = await request(app)
        .get('/api/auth/status')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('authenticated', false);
      expect(response.body.user).toBeNull();
    });

    test('should return authenticated status with user data when logged in', async () => {
      mockAuthService.setUserData({
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
        accessToken: 'token123',
      });

      const response = await request(app)
        .get('/api/auth/status')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('authenticated', true);
      expect(response.body.user).toEqual({
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
      });
    });
  });

  describe('POST /api/auth/server', () => {
    test('should return already authenticated when logged in', async () => {
      mockAuthService.setUserData({
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
      });

      const response = await request(app)
        .post('/api/auth/server')
        .expect(200);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Already authenticated');
      expect(response.body).toHaveProperty('user');
    });

    // Note: Testing the actual server auth flow requires mocking axios
    // which is complex. The endpoint structure is tested here.
  });

  describe('POST /api/auth/server/poll', () => {
    test('should return authenticated data when user is logged in', async () => {
      const userData = {
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
        accessToken: 'access_token_123',
        refreshToken: 'refresh_token_123',
        expiresAt: '2025-01-01T00:00:00Z',
      };
      mockAuthService.setUserData(userData);

      const response = await request(app)
        .post('/api/auth/server/poll')
        .expect(200);

      expect(response.body).toHaveProperty('authenticated', true);
      expect(response.body).toHaveProperty('userId', '123');
      expect(response.body).toHaveProperty('email', 'test@example.com');
      expect(response.body).toHaveProperty('fullName', 'Test User');
    });

    test('should return authorization_pending when not authenticated', async () => {
      const response = await request(app)
        .post('/api/auth/server/poll')
        .expect(400);

      expect(response.body).toHaveProperty('authenticated', false);
      expect(response.body).toHaveProperty('error', 'authorization_pending');
      expect(response.body).toHaveProperty('message', 'Waiting for user to complete authentication');
    });
  });

  describe('POST /api/auth/token', () => {
    test('should accept valid token data and authenticate', async () => {
      const tokenData = {
        accessToken: 'valid_access_token',
        refreshToken: 'valid_refresh_token',
        userId: '456',
        email: 'user@example.com',
        fullName: 'Full Name',
        expiresAt: '2025-12-31T23:59:59Z',
      };

      const response = await request(app)
        .post('/api/auth/token')
        .send(tokenData)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Authentication successful');
      
      // Verify the auth service was updated
      expect(mockAuthService.isAuthenticated()).toBe(true);
    });

    test('should reject token request without accessToken', async () => {
      const response = await request(app)
        .post('/api/auth/token')
        .send({
          userId: '456',
          email: 'user@example.com',
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'accessToken, userId, and email are required');
    });

    test('should reject token request without userId', async () => {
      const response = await request(app)
        .post('/api/auth/token')
        .send({
          accessToken: 'token123',
          email: 'user@example.com',
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'accessToken, userId, and email are required');
    });

    test('should reject token request without email', async () => {
      const response = await request(app)
        .post('/api/auth/token')
        .send({
          accessToken: 'token123',
          userId: '456',
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'accessToken, userId, and email are required');
    });
  });

  describe('POST /api/auth/logout', () => {
    test('should logout successfully when authenticated', async () => {
      mockAuthService.setUserData({
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
      });

      const response = await request(app)
        .post('/api/auth/logout')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Logged out successfully');
    });

    test('should return success even when not authenticated', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });
  });

  describe('GET /api/auth/callback', () => {
    test('should return error page when error param is present', async () => {
      const response = await request(app)
        .get('/api/auth/callback')
        .query({ error: 'access_denied' })
        .expect(400);

      expect(response.text).toContain('Authentication Failed');
      expect(response.text).toContain('access_denied');
    });

    test('should return error page when required params are missing', async () => {
      const response = await request(app)
        .get('/api/auth/callback')
        .query({ token: 'some_token' }) // missing userId and email
        .expect(400);

      expect(response.text).toContain('Invalid Callback');
      expect(response.text).toContain('Missing required parameters');
    });

    test('should authenticate successfully with all required params', async () => {
      const response = await request(app)
        .get('/api/auth/callback')
        .query({
          token: 'access_token_123',
          userId: '789',
          email: 'callback@example.com',
          fullName: 'Callback User',
        })
        .expect(200);

      expect(response.text).toContain('Authentication Successful');
      expect(response.text).toContain('callback@example.com');
    });
  });

  describe('POST /api/auth/start', () => {
    test('should return already authenticated when logged in', async () => {
      mockAuthService.setUserData({
        userId: '123',
        email: 'test@example.com',
        fullName: 'Test User',
      });

      const response = await request(app)
        .post('/api/auth/start')
        .expect(200);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Already authenticated');
    });

    test('should return auth URL when not authenticated', async () => {
      const response = await request(app)
        .post('/api/auth/start')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('authUrl');
      expect(response.body).toHaveProperty('instructions');
      expect(Array.isArray(response.body.instructions)).toBe(true);
    });
  });
});

describe('Auth Routes - Endpoint Naming', () => {
  test('should use /server endpoint instead of deprecated /device', async () => {
    const app = express();
    app.use(express.json());
    
    const mockAuth = new MockAuthService();
    initializeAuthRoutes(mockAuth);
    app.use('/api/auth', authRoutes);

    // Test that /server endpoint exists
    const serverResponse = await request(app)
      .post('/api/auth/server')
      .expect(200);
    
    expect(serverResponse.body).toBeDefined();

    // Test that /server/poll endpoint exists
    const pollResponse = await request(app)
      .post('/api/auth/server/poll')
      .expect(400); // 400 because not authenticated yet
    
    expect(pollResponse.body).toHaveProperty('error', 'authorization_pending');
  });

  test('should NOT have /device endpoints (they were renamed)', async () => {
    const app = express();
    app.use(express.json());
    
    const mockAuth = new MockAuthService();
    initializeAuthRoutes(mockAuth);
    app.use('/api/auth', authRoutes);

    // These should return 404 as the routes no longer exist
    await request(app)
      .post('/api/auth/device')
      .expect(404);

    await request(app)
      .post('/api/auth/device/poll')
      .expect(404);
  });
});
