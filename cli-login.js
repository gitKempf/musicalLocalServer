#!/usr/bin/env node
/**
 * CLI Login Tool for Musical.run Local Server
 * Authenticates via username/password when browser is not available
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const TOKEN_PATH = path.join(process.env.HOME || '/root', '.musical', 'auth.json');

// Create readline interface for CLI input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function login(email, password) {
  console.log('\n🔑 Authenticating with Musical.run...\n');

  try {
    // Call auth service login endpoint
    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/login`, {
      email,
      password
    });

    if (!response.data.success) {
      throw new Error(response.data.error || 'Login failed');
    }

    const { user, token } = response.data;

    // Create token data structure
    const tokenData = {
      userId: user.id,
      accessToken: token,
      refreshToken: token, // Using same token for now
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      email: user.email,
      fullName: user.fullName || user.email
    };

    // Ensure .musical directory exists
    const dir = path.dirname(TOKEN_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save token to file
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
    fs.chmodSync(TOKEN_PATH, 0o600); // Read/write for owner only

    console.log('✅ Login successful!\n');
    console.log(`   User: ${user.email}`);
    console.log(`   User ID: ${user.id}`);
    console.log(`   Token saved to: ${TOKEN_PATH}\n`);
    console.log('🎉 Local server is now authenticated!\n');
    console.log('Restart the local server for changes to take effect:');
    console.log('   docker compose restart musical-local\n');

    return tokenData;

  } catch (error) {
    if (error.response) {
      console.error(`❌ Login failed: ${error.response.data.error || error.response.statusText}`);
    } else if (error.request) {
      console.error(`❌ Could not connect to auth service at ${AUTH_SERVICE_URL}`);
      console.error('   Make sure auth-service is running');
    } else {
      console.error(`❌ Error: ${error.message}`);
    }
    throw error;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   Musical.run Local Server - CLI Login    ║');
  console.log('╚════════════════════════════════════════════╝\n');

  try {
    // Get credentials from command line args or prompt
    let email = process.argv[2];
    let password = process.argv[3];

    if (!email) {
      email = await question('Email: ');
    }

    if (!password) {
      password = await question('Password: ');
    }

    await login(email, password);
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Authentication failed\n');
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
