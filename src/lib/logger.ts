/**
 * Logger utility using Winston
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = process.env.LOG_DIR || path.join(process.env.HOME || '/root', '.musical', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'musical-local-server' },
  transports: [
    // Write all logs to file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log')
    }),
  ],
});

// Always log to console (important for Docker containers)
// In production, use simple format; in development, use colors
const consoleFormat = process.env.NODE_ENV === 'production'
  ? winston.format.simple()
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    );

logger.add(new winston.transports.Console({
  format: consoleFormat,
}));

export { logger };
