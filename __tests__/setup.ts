/**
 * Jest Test Setup
 * Runs before all tests
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load test environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.test') });

// Create test directories
const testDirs = [
  '/tmp/musical-test/keys',
  '/tmp/musical-test/data',
  '/tmp/musical-test/logs',
];

testDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Set test environment
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY_PATH = '/tmp/musical-test/keys/encryption.key';
process.env.LOG_DIR = '/tmp/musical-test/logs';
process.env.PORT = '17200'; // Different port for tests
process.env.CLOUD_REGISTRATION_ENABLED = 'false';

// Cleanup after all tests
afterAll(async () => {
  // Clean up test files
  try {
    const testRoot = '/tmp/musical-test';
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('Failed to cleanup test files:', error);
  }
});
