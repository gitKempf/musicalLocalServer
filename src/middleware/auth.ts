/**
 * Authentication Middleware
 * Extracts userId from JWT token for project ownership validation
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

// JWT decode without verification (verification happens in auth-service)
function decodeJWT(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}

/**
 * Optional auth middleware - adds user info if token is present
 * Does not block requests if no token
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const payload = decodeJWT(token);

    if (payload && payload.userId) {
      (req as any).user = {
        userId: payload.userId,
        email: payload.email,
      };
      logger.debug('User authenticated', { userId: payload.userId, email: payload.email });
    }
  }

  next();
}

/**
 * Required auth middleware - blocks requests without valid token
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): any {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('❌ No authorization header', { path: req.path });
    return res.status(401).json({
      success: false,
      error: 'Authorization header required',
    });
  }

  const token = authHeader.substring(7);
  const payload = decodeJWT(token);

  logger.info('🔍 JWT decode attempt', { path: req.path, payload, hasUserId: !!payload?.userId });

  if (!payload || !payload.userId) {
    logger.warn('❌ Invalid JWT payload', { path: req.path, payload });
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }

  (req as any).user = {
    userId: payload.userId,
    email: payload.email,
  };

  logger.debug('User authenticated', { userId: payload.userId, email: payload.email });
  next();
}
