/**
 * Unit Tests for EncryptionService
 * Tests end-to-end encryption functionality
 */

import { EncryptionService } from '../../src/lib/EncryptionService';
import fs from 'fs/promises';
import path from 'path';

describe('EncryptionService', () => {
  let encryptionService: EncryptionService;
  const testKeyPath = '/tmp/musical-test/keys/test-encryption.key';

  beforeEach(async () => {
    // Clean up any existing key file
    try {
      await fs.unlink(testKeyPath);
    } catch (error) {
      // File doesn't exist, that's fine
    }

    encryptionService = new EncryptionService(testKeyPath);
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.unlink(testKeyPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    test('should initialize successfully', async () => {
      await expect(encryptionService.initialize()).resolves.not.toThrow();
    });

    test('should generate new keypair on first initialization', async () => {
      await encryptionService.initialize();
      const publicKey = encryptionService.getPublicKey();

      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('string');
      expect(publicKey.length).toBeGreaterThan(0);
    });

    test('should load existing keypair on second initialization', async () => {
      // First initialization - creates keypair
      await encryptionService.initialize();
      const firstPublicKey = encryptionService.getPublicKey();

      // Create new instance
      const secondService = new EncryptionService(testKeyPath);
      await secondService.initialize();
      const secondPublicKey = secondService.getPublicKey();

      // Should be the same key
      expect(secondPublicKey).toBe(firstPublicKey);
    });

    test('should save keypair to file with correct permissions', async () => {
      await encryptionService.initialize();

      // Check file exists
      const stats = await fs.stat(testKeyPath);
      expect(stats.isFile()).toBe(true);

      // Check permissions (should be 0o600 - owner read/write only)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test('should not initialize twice', async () => {
      await encryptionService.initialize();
      await encryptionService.initialize(); // Should not throw

      // Should still work
      expect(encryptionService.getPublicKey()).toBeDefined();
    });
  });

  describe('Encryption/Decryption', () => {
    let service1: EncryptionService;
    let service2: EncryptionService;

    beforeEach(async () => {
      service1 = new EncryptionService('/tmp/musical-test/keys/service1.key');
      service2 = new EncryptionService('/tmp/musical-test/keys/service2.key');

      await service1.initialize();
      await service2.initialize();
    });

    afterEach(async () => {
      try {
        await fs.unlink('/tmp/musical-test/keys/service1.key');
        await fs.unlink('/tmp/musical-test/keys/service2.key');
      } catch (error) {
        // Ignore
      }
    });

    test('should encrypt and decrypt a simple message', async () => {
      const message = 'Hello, World!';
      const service2PublicKey = service2.getPublicKey();

      // Service1 encrypts message for Service2
      const encrypted = await service1.encrypt(message, service2PublicKey);

      expect(encrypted).toBeDefined();
      expect(encrypted.nonce).toBeDefined();
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.senderPublicKey).toBe(service1.getPublicKey());

      // Service2 decrypts message from Service1
      const service1PublicKey = service1.getPublicKey();
      const decrypted = await service2.decrypt(encrypted, service1PublicKey);

      expect(decrypted).toBe(message);
    });

    test('should encrypt and decrypt a long message', async () => {
      const message = 'A'.repeat(10000); // 10KB message
      const service2PublicKey = service2.getPublicKey();

      const encrypted = await service1.encrypt(message, service2PublicKey);
      const decrypted = await service2.decrypt(encrypted, service1.getPublicKey());

      expect(decrypted).toBe(message);
    });

    test('should encrypt and decrypt special characters', async () => {
      const message = '🎵 Musical.run! @#$%^&*() 中文 العربية';
      const service2PublicKey = service2.getPublicKey();

      const encrypted = await service1.encrypt(message, service2PublicKey);
      const decrypted = await service2.decrypt(encrypted, service1.getPublicKey());

      expect(decrypted).toBe(message);
    });

    test('should encrypt and decrypt JSON', async () => {
      const message = JSON.stringify({
        type: 'code-generation',
        prompt: 'Create a React Native app',
        sessionId: '123-456-789',
        metadata: {
          timestamp: Date.now(),
          version: '1.0.0',
        },
      });
      const service2PublicKey = service2.getPublicKey();

      const encrypted = await service1.encrypt(message, service2PublicKey);
      const decrypted = await service2.decrypt(encrypted, service1.getPublicKey());

      expect(decrypted).toBe(message);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(message));
    });

    test('should fail to decrypt with wrong sender key', async () => {
      const message = 'Secret message';
      const service2PublicKey = service2.getPublicKey();

      const encrypted = await service1.encrypt(message, service2PublicKey);

      // Try to decrypt with service2's own public key (wrong sender)
      await expect(
        service2.decrypt(encrypted, service2PublicKey)
      ).rejects.toThrow();
    });

    test('should produce different ciphertexts for same message', async () => {
      const message = 'Same message';
      const service2PublicKey = service2.getPublicKey();

      const encrypted1 = await service1.encrypt(message, service2PublicKey);
      const encrypted2 = await service1.encrypt(message, service2PublicKey);

      // Ciphertexts should be different (due to random nonce)
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.nonce).not.toBe(encrypted2.nonce);

      // But both should decrypt to same message
      const decrypted1 = await service2.decrypt(encrypted1, service1.getPublicKey());
      const decrypted2 = await service2.decrypt(encrypted2, service1.getPublicKey());

      expect(decrypted1).toBe(message);
      expect(decrypted2).toBe(message);
    });
  });

  describe('Compact Format', () => {
    let service1: EncryptionService;
    let service2: EncryptionService;

    beforeEach(async () => {
      service1 = new EncryptionService('/tmp/musical-test/keys/compact1.key');
      service2 = new EncryptionService('/tmp/musical-test/keys/compact2.key');

      await service1.initialize();
      await service2.initialize();
    });

    afterEach(async () => {
      try {
        await fs.unlink('/tmp/musical-test/keys/compact1.key');
        await fs.unlink('/tmp/musical-test/keys/compact2.key');
      } catch (error) {
        // Ignore
      }
    });

    test('should encrypt and decrypt in compact format', async () => {
      const message = 'Compact message';
      const service2PublicKey = service2.getPublicKey();

      const compactEncrypted = await service1.encryptCompact(message, service2PublicKey);

      // Should be in format: nonce.ciphertext (base64, may include - and _)
      expect(compactEncrypted).toMatch(/^[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+$/);

      const decrypted = await service2.decryptCompact(compactEncrypted, service1.getPublicKey());

      expect(decrypted).toBe(message);
    });

    test('should fail to decrypt invalid compact format', async () => {
      await expect(
        service1.decryptCompact('invalid', service2.getPublicKey())
      ).rejects.toThrow('Invalid compact message format');
    });

    test('should fail to decrypt corrupted compact message', async () => {
      const message = 'Test message';
      const compactEncrypted = await service1.encryptCompact(message, service2.getPublicKey());

      // Corrupt the ciphertext
      const [nonce, ciphertext] = compactEncrypted.split('.');
      const corrupted = `${nonce}.${ciphertext}ABC`;

      await expect(
        service2.decryptCompact(corrupted, service1.getPublicKey())
      ).rejects.toThrow();
    });
  });

  describe('Key Rotation', () => {
    test('should rotate keys successfully', async () => {
      await encryptionService.initialize();
      const oldPublicKey = encryptionService.getPublicKey();

      await encryptionService.rotateKeys();
      const newPublicKey = encryptionService.getPublicKey();

      // Keys should be different
      expect(newPublicKey).not.toBe(oldPublicKey);

      // Old key should be backed up
      const backupFiles = await fs.readdir('/tmp/musical-test/keys');
      const backups = backupFiles.filter(f => f.includes('.backup.'));
      expect(backups.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    test('should throw error when getting public key before initialization', () => {
      const uninitializedService = new EncryptionService('/tmp/musical-test/keys/uninitialized.key');

      expect(() => uninitializedService.getPublicKey()).toThrow(
        'EncryptionService not initialized'
      );
    });

    test('should throw error when encrypting before initialization', async () => {
      const uninitializedService = new EncryptionService('/tmp/musical-test/keys/uninitialized2.key');

      await expect(
        uninitializedService.encrypt('test', 'some-public-key')
      ).rejects.toThrow('EncryptionService not initialized');
    });

    test('should handle invalid public key gracefully', async () => {
      await encryptionService.initialize();

      await expect(
        encryptionService.encrypt('test', 'invalid-key')
      ).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    beforeEach(async () => {
      await encryptionService.initialize();
    });

    test('should encrypt 100 messages in under 1 second', async () => {
      const service2 = new EncryptionService('/tmp/musical-test/keys/perf.key');
      await service2.initialize();
      const service2PublicKey = service2.getPublicKey();

      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        await encryptionService.encrypt(`Message ${i}`, service2PublicKey);
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000);

      await fs.unlink('/tmp/musical-test/keys/perf.key');
    });

    test('should handle large messages efficiently', async () => {
      const service2 = new EncryptionService('/tmp/musical-test/keys/large.key');
      await service2.initialize();
      const service2PublicKey = service2.getPublicKey();

      // 1MB message
      const largeMessage = 'A'.repeat(1024 * 1024);

      const startTime = Date.now();
      const encrypted = await encryptionService.encrypt(largeMessage, service2PublicKey);
      const encryptTime = Date.now() - startTime;

      expect(encryptTime).toBeLessThan(500); // Should be fast even for 1MB

      const decryptStart = Date.now();
      const decrypted = await service2.decrypt(encrypted, encryptionService.getPublicKey());
      const decryptTime = Date.now() - decryptStart;

      expect(decryptTime).toBeLessThan(500);
      expect(decrypted).toBe(largeMessage);

      await fs.unlink('/tmp/musical-test/keys/large.key');
    });
  });
});
