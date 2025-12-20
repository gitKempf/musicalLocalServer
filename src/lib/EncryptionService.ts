/**
 * EncryptionService - End-to-End Encryption using libsodium
 *
 * Provides zero-knowledge encryption between browser and local server.
 * Musical.run cloud cannot decrypt messages as it doesn't have private keys.
 *
 * Uses NaCl (libsodium) public-key authenticated encryption:
 * - Browser generates keypair (stored in IndexedDB)
 * - Local server generates keypair (stored in ~/.musical/keys/)
 * - Messages encrypted with recipient's public key
 * - Only recipient can decrypt with their private key
 */

import sodium from 'libsodium-wrappers';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger';

export interface KeyPair {
  publicKey: string;  // Base64 encoded
  privateKey: string; // Base64 encoded
}

export interface EncryptedMessage {
  nonce: string;      // Base64 encoded
  ciphertext: string; // Base64 encoded
  senderPublicKey?: string; // Base64 encoded (for verification)
}

export class EncryptionService {
  private keypair: sodium.KeyPair | null = null;
  private initialized = false;
  private keyPath: string;

  constructor(keyPath?: string) {
    this.keyPath = keyPath || process.env.ENCRYPTION_KEY_PATH ||
                   path.join(process.env.HOME || '/root', '.musical', 'keys', 'encryption.key');
  }

  /**
   * Initialize encryption service
   * Loads existing keypair or generates new one
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('EncryptionService already initialized');
      return;
    }

    await sodium.ready;
    logger.info('🔐 Initializing EncryptionService with libsodium');

    try {
      // Try to load existing keypair
      const stored = await this.loadKeypairFromFile();
      this.keypair = stored;
      this.initialized = true;
      logger.info('✅ Loaded existing encryption keypair', {
        publicKey: this.getPublicKey().substring(0, 16) + '...',
      });
    } catch (error) {
      // Generate new keypair
      logger.info('📝 Generating new encryption keypair');
      this.keypair = sodium.crypto_box_keypair();
      this.initialized = true;
      await this.saveKeypairToFile(this.keypair);
      logger.info('✅ Generated and saved new encryption keypair', {
        publicKey: this.getPublicKey().substring(0, 16) + '...',
      });
    }
  }

  /**
   * Ensure service is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.keypair) {
      throw new Error('EncryptionService not initialized. Call initialize() first.');
    }
  }

  /**
   * Get public key (can be shared publicly)
   */
  getPublicKey(): string {
    this.ensureInitialized();
    return sodium.to_base64(this.keypair!.publicKey);
  }

  /**
   * Encrypt message for specific recipient
   *
   * @param message - Plain text message
   * @param recipientPublicKey - Recipient's public key (base64)
   * @returns Encrypted message object
   */
  async encrypt(message: string, recipientPublicKey: string): Promise<EncryptedMessage> {
    this.ensureInitialized();
    await sodium.ready;

    try {
      const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
      const messageBytes = sodium.from_string(message);
      const recipientKeyBytes = sodium.from_base64(recipientPublicKey);

      const ciphertext = sodium.crypto_box_easy(
        messageBytes,
        nonce,
        recipientKeyBytes,
        this.keypair!.privateKey
      );

      return {
        nonce: sodium.to_base64(nonce),
        ciphertext: sodium.to_base64(ciphertext),
        senderPublicKey: this.getPublicKey(),
      };
    } catch (error) {
      logger.error('❌ Encryption failed', { error });
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * Decrypt message from sender
   *
   * @param encrypted - Encrypted message object
   * @param senderPublicKey - Sender's public key (base64)
   * @returns Decrypted plain text message
   */
  async decrypt(encrypted: EncryptedMessage, senderPublicKey: string): Promise<string> {
    this.ensureInitialized();
    await sodium.ready;

    try {
      const nonce = sodium.from_base64(encrypted.nonce);
      const ciphertext = sodium.from_base64(encrypted.ciphertext);
      const senderKeyBytes = sodium.from_base64(senderPublicKey);

      const decrypted = sodium.crypto_box_open_easy(
        ciphertext,
        nonce,
        senderKeyBytes,
        this.keypair!.privateKey
      );

      return sodium.to_string(decrypted);
    } catch (error) {
      logger.error('❌ Decryption failed', { error });
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  /**
   * Encrypt message as compact string (for API transmission)
   * Format: nonce.ciphertext
   */
  async encryptCompact(message: string, recipientPublicKey: string): Promise<string> {
    const encrypted = await this.encrypt(message, recipientPublicKey);
    return `${encrypted.nonce}.${encrypted.ciphertext}`;
  }

  /**
   * Decrypt compact string message
   */
  async decryptCompact(compactMessage: string, senderPublicKey: string): Promise<string> {
    const [nonce, ciphertext] = compactMessage.split('.');
    if (!nonce || !ciphertext) {
      throw new Error('Invalid compact message format');
    }

    return this.decrypt({ nonce, ciphertext }, senderPublicKey);
  }

  /**
   * Load keypair from filesystem
   */
  private async loadKeypairFromFile(): Promise<sodium.KeyPair> {
    await sodium.ready;

    const keyData = await fs.readFile(this.keyPath, 'utf-8');
    const stored = JSON.parse(keyData);

    return {
      publicKey: sodium.from_base64(stored.publicKey),
      privateKey: sodium.from_base64(stored.privateKey),
      keyType: 'curve25519',
    };
  }

  /**
   * Save keypair to filesystem (private key with restricted permissions)
   */
  private async saveKeypairToFile(keypair: sodium.KeyPair): Promise<void> {
    await sodium.ready;

    // Ensure directory exists
    const keyDir = path.dirname(this.keyPath);
    await fs.mkdir(keyDir, { recursive: true });

    const keyData = JSON.stringify({
      publicKey: sodium.to_base64(keypair.publicKey),
      privateKey: sodium.to_base64(keypair.privateKey),
      createdAt: new Date().toISOString(),
      version: '1.0',
    }, null, 2);

    // Write with restricted permissions (owner read/write only)
    await fs.writeFile(this.keyPath, keyData, { mode: 0o600 });

    logger.info(`✅ Saved encryption keypair to ${this.keyPath}`);
  }

  /**
   * Generate new keypair (for key rotation)
   */
  async rotateKeys(): Promise<void> {
    await sodium.ready;
    logger.info('🔄 Rotating encryption keys');

    // Backup old key
    const backupPath = `${this.keyPath}.backup.${Date.now()}`;
    try {
      await fs.copyFile(this.keyPath, backupPath);
      logger.info(`📦 Backed up old key to ${backupPath}`);
    } catch (error) {
      logger.warn('⚠️ Could not backup old key', { error });
    }

    // Generate and save new keypair
    this.keypair = sodium.crypto_box_keypair();
    await this.saveKeypairToFile(this.keypair);

    logger.info('✅ Key rotation complete', {
      newPublicKey: this.getPublicKey().substring(0, 16) + '...',
    });
  }

  /**
   * Verify message authenticity (check sender)
   */
  async verifySignature(
    message: string,
    signature: string,
    senderPublicKey: string
  ): Promise<boolean> {
    await sodium.ready;

    try {
      const signatureBytes = sodium.from_base64(signature);
      const messageBytes = sodium.from_string(message);
      const publicKeyBytes = sodium.from_base64(senderPublicKey);

      // Using crypto_sign_verify_detached for signature verification
      return sodium.crypto_sign_verify_detached(
        signatureBytes,
        messageBytes,
        publicKeyBytes
      );
    } catch (error) {
      logger.error('❌ Signature verification failed', { error });
      return false;
    }
  }
}

// Singleton instance
export const encryptionService = new EncryptionService();
