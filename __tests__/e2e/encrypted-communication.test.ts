/**
 * E2E Tests for Encrypted Communication
 * Tests end-to-end encrypted message flow between browser and server
 */

import { EncryptionService } from '../../src/lib/EncryptionService';
import io from 'socket.io-client';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { setupSocketHandlers } from '../../src/sockets';

describe('E2E Encrypted Communication', () => {
  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverAddress: string;

  // Simulated browser encryption service
  let browserEncryption: EncryptionService;
  // Server encryption service
  let serverEncryption: EncryptionService;

  beforeAll(async () => {
    // Initialize encryption services
    browserEncryption = new EncryptionService('/tmp/musical-test/keys/browser.key');
    serverEncryption = new EncryptionService('/tmp/musical-test/keys/server-e2e.key');

    await browserEncryption.initialize();
    await serverEncryption.initialize();

    // Create HTTP server
    httpServer = http.createServer();

    // Create Socket.IO server
    ioServer = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // Setup socket handlers
    setupSocketHandlers(ioServer);

    // Start server
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        if (address && typeof address !== 'string') {
          serverAddress = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close server
    ioServer.close();
    httpServer.close();

    // Cleanup
    await Promise.all([
      import('fs/promises').then(fs => fs.unlink('/tmp/musical-test/keys/browser.key').catch(() => {})),
      import('fs/promises').then(fs => fs.unlink('/tmp/musical-test/keys/server-e2e.key').catch(() => {})),
    ]);
  });

  describe('WebSocket Connection', () => {
    test('should establish WebSocket connection', (done) => {
      const client = io(serverAddress);

      client.on('connect', () => {
        expect(client.connected).toBe(true);
        client.disconnect();
        done();
      });

      client.on('connect_error', (error) => {
        done(error);
      });
    });

    test('should handle multiple concurrent connections', async () => {
      const clients = Array.from({ length: 10 }, () => io(serverAddress));

      await Promise.all(
        clients.map(
          client =>
            new Promise<void>((resolve) => {
              client.on('connect', () => {
                expect(client.connected).toBe(true);
                resolve();
              });
            })
        )
      );

      clients.forEach(client => client.disconnect());
    });
  });

  describe('Encrypted Message Exchange', () => {
    test('should send and receive encrypted message', (done) => {
      const client = io(serverAddress);
      const testMessage = 'Hello from browser!';

      client.on('connect', async () => {
        try {
          // Encrypt message for server
          const serverPublicKey = serverEncryption.getPublicKey();
          const encryptedMessage = await browserEncryption.encryptCompact(
            testMessage,
            serverPublicKey
          );

          // Send encrypted message
          client.emit('encrypted-message', {
            encryptedMessage,
            senderPublicKey: browserEncryption.getPublicKey(),
            sessionId: 'test-session-123',
          });

          // Wait for encrypted response
          client.on('encrypted-response', async (data) => {
            try {
              expect(data).toHaveProperty('encryptedResponse');
              expect(data).toHaveProperty('sessionId', 'test-session-123');
              expect(data).toHaveProperty('serverPublicKey');

              // Decrypt response
              const decryptedResponse = await browserEncryption.decryptCompact(
                data.encryptedResponse,
                data.serverPublicKey
              );

              // Should be echo response
              expect(decryptedResponse).toContain(testMessage);

              client.disconnect();
              done();
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });

      client.on('error', done);
    }, 10000);

    test('should handle large encrypted messages', (done) => {
      const client = io(serverAddress);
      const largeMessage = 'A'.repeat(10000); // 10KB message

      client.on('connect', async () => {
        try {
          const serverPublicKey = serverEncryption.getPublicKey();
          const encryptedMessage = await browserEncryption.encryptCompact(
            largeMessage,
            serverPublicKey
          );

          client.emit('encrypted-message', {
            encryptedMessage,
            senderPublicKey: browserEncryption.getPublicKey(),
            sessionId: 'large-message-test',
          });

          client.on('encrypted-response', async (data) => {
            try {
              const decryptedResponse = await browserEncryption.decryptCompact(
                data.encryptedResponse,
                data.serverPublicKey
              );

              expect(decryptedResponse).toContain(largeMessage);
              client.disconnect();
              done();
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });
    }, 15000);

    test('should handle JSON payloads in encrypted messages', (done) => {
      const client = io(serverAddress);
      const jsonPayload = JSON.stringify({
        type: 'code-generation',
        prompt: 'Create a React Native login screen',
        options: {
          template: 'react-native',
          version: '1.0.0',
        },
      });

      client.on('connect', async () => {
        try {
          const serverPublicKey = serverEncryption.getPublicKey();
          const encryptedMessage = await browserEncryption.encryptCompact(
            jsonPayload,
            serverPublicKey
          );

          client.emit('encrypted-message', {
            encryptedMessage,
            senderPublicKey: browserEncryption.getPublicKey(),
            sessionId: 'json-payload-test',
          });

          client.on('encrypted-response', async (data) => {
            try {
              const decryptedResponse = await browserEncryption.decryptCompact(
                data.encryptedResponse,
                data.serverPublicKey
              );

              expect(decryptedResponse).toContain('Create a React Native login screen');
              client.disconnect();
              done();
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });
    }, 10000);
  });

  describe('Generation Progress Streaming', () => {
    test('should stream generation progress updates', (done) => {
      const client = io(serverAddress);

      client.on('connect', () => {
        // Start generation
        client.emit('start-generation', {
          projectId: 'test-project',
          prompt: 'Create a simple app',
          sessionId: 'progress-test',
        });

        const progressUpdates: any[] = [];

        client.on('generation-progress', (data) => {
          progressUpdates.push(data);

          if (data.type === 'complete') {
            expect(progressUpdates.length).toBeGreaterThan(0);
            expect(progressUpdates[0]).toHaveProperty('type', 'progress');
            expect(progressUpdates[progressUpdates.length - 1]).toHaveProperty('type', 'complete');

            client.disconnect();
            done();
          }
        });

        client.on('generation-error', (error) => {
          done(error);
        });
      });
    }, 15000);
  });

  describe('Error Handling', () => {
    test('should handle invalid encrypted message', (done) => {
      const client = io(serverAddress);

      client.on('connect', () => {
        // Send invalid encrypted message
        client.emit('encrypted-message', {
          encryptedMessage: 'invalid-encrypted-data',
          senderPublicKey: 'invalid-public-key',
          sessionId: 'error-test',
        });

        client.on('error', (data) => {
          expect(data).toHaveProperty('error');
          client.disconnect();
          done();
        });
      });
    }, 10000);

    test('should handle missing required fields', (done) => {
      const client = io(serverAddress);

      client.on('connect', () => {
        // Send message without required fields
        client.emit('encrypted-message', {
          sessionId: 'missing-fields-test',
          // Missing encryptedMessage and senderPublicKey
        });

        client.on('error', (data) => {
          expect(data).toHaveProperty('error');
          client.disconnect();
          done();
        });
      });
    }, 10000);
  });

  describe('Privacy Guarantees', () => {
    test('server should never see plaintext messages', (done) => {
      const client = io(serverAddress);
      const secretMessage = 'This is a secret that server should never see in plaintext';

      let serverSawPlaintext = false;

      // Monkey-patch console.log to check if server logs plaintext
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        const logString = args.join(' ');
        if (logString.includes(secretMessage)) {
          serverSawPlaintext = true;
        }
        originalLog(...args);
      };

      client.on('connect', async () => {
        try {
          const serverPublicKey = serverEncryption.getPublicKey();
          const encryptedMessage = await browserEncryption.encryptCompact(
            secretMessage,
            serverPublicKey
          );

          // Verify encrypted message doesn't contain plaintext
          expect(encryptedMessage).not.toContain(secretMessage);

          client.emit('encrypted-message', {
            encryptedMessage,
            senderPublicKey: browserEncryption.getPublicKey(),
            sessionId: 'privacy-test',
          });

          client.on('encrypted-response', async () => {
            // Restore console.log
            console.log = originalLog;

            // Server should never have logged the plaintext
            expect(serverSawPlaintext).toBe(false);

            client.disconnect();
            done();
          });
        } catch (error) {
          console.log = originalLog;
          done(error);
        }
      });
    }, 10000);

    test('encrypted messages should be different each time', async () => {
      const message = 'Same message encrypted twice';
      const serverPublicKey = serverEncryption.getPublicKey();

      const encrypted1 = await browserEncryption.encryptCompact(message, serverPublicKey);
      const encrypted2 = await browserEncryption.encryptCompact(message, serverPublicKey);

      // Should be different due to random nonce
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same message
      const decrypted1 = await serverEncryption.decryptCompact(encrypted1, browserEncryption.getPublicKey());
      const decrypted2 = await serverEncryption.decryptCompact(encrypted2, browserEncryption.getPublicKey());

      expect(decrypted1).toBe(message);
      expect(decrypted2).toBe(message);
    });
  });

  describe('Performance', () => {
    test('should handle 50 concurrent encrypted messages', async () => {
      const clients = Array.from({ length: 50 }, () => io(serverAddress));

      await Promise.all(
        clients.map(
          (client, index) =>
            new Promise<void>((resolve, reject) => {
              client.on('connect', async () => {
                try {
                  const message = `Message ${index}`;
                  const serverPublicKey = serverEncryption.getPublicKey();
                  const encryptedMessage = await browserEncryption.encryptCompact(
                    message,
                    serverPublicKey
                  );

                  client.emit('encrypted-message', {
                    encryptedMessage,
                    senderPublicKey: browserEncryption.getPublicKey(),
                    sessionId: `concurrent-test-${index}`,
                  });

                  client.on('encrypted-response', async (data) => {
                    const decrypted = await browserEncryption.decryptCompact(
                      data.encryptedResponse,
                      data.serverPublicKey
                    );

                    expect(decrypted).toContain(message);
                    client.disconnect();
                    resolve();
                  });
                } catch (error) {
                  reject(error);
                }
              });

              client.on('error', reject);
            })
        )
      );
    }, 30000);

    test('should encrypt/decrypt round-trip in under 50ms', async () => {
      const message = 'Performance test message';
      const serverPublicKey = serverEncryption.getPublicKey();

      const startTime = Date.now();

      // Encrypt
      const encrypted = await browserEncryption.encryptCompact(message, serverPublicKey);

      // Decrypt
      const decrypted = await serverEncryption.decryptCompact(encrypted, browserEncryption.getPublicKey());

      const elapsed = Date.now() - startTime;

      expect(decrypted).toBe(message);
      expect(elapsed).toBeLessThan(50);
    });
  });
});
