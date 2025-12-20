/**
 * Generate encryption keys for local server
 * This script is used during installation and key rotation
 */

import sodium from 'libsodium-wrappers';

async function generateKeys() {
  await sodium.ready;

  const keypair = sodium.crypto_box_keypair();

  const output = {
    publicKey: sodium.to_base64(keypair.publicKey),
    privateKey: sodium.to_base64(keypair.privateKey),
    createdAt: new Date().toISOString(),
    version: '1.0',
  };

  // Output to stdout (can be redirected to file)
  console.log(JSON.stringify(output, null, 2));
}

generateKeys().catch((error) => {
  console.error('Failed to generate keys:', error);
  process.exit(1);
});
