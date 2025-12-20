#!/usr/bin/env node
/**
 * Test Terminal WebSocket - Direct Connection
 *
 * Tests terminal by connecting directly to local-server (bypassing tunnel)
 */

const io = require('socket.io-client');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const LOCAL_SERVER_URL = 'http://localhost:17100';
const USER_ID = '17';

function generateToken() {
  const secret = process.env.JWT_SECRET || 'musical-run-secret-key';
  const email = process.env.TEST_EMAIL || 'test@example.com';
  return jwt.sign(
    {
      userId: parseInt(USER_ID),
      email: email,
      jti: 'test-' + Date.now()
    },
    secret,
    { expiresIn: '1h' }
  );
}

async function runTest() {
  console.log('========================================');
  console.log('🧪 Terminal Test - Direct Connection');
  console.log('========================================');
  console.log('');

  const token = generateToken();

  // Step 1: Create project directly
  console.log('Step 1: Creating project (direct)...');
  const projectResponse = await axios.post(
    `${LOCAL_SERVER_URL}/api/projects`,
    {
      name: `Terminal Direct Test ${Date.now()}`,
      template: 'react-native',
      initialPrompt: 'test',
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const projectId = projectResponse.data.project.id;
  console.log(`✅ Project created: ${projectId}`);

  // Step 2: Create session directly
  console.log('\nStep 2: Creating session (direct)...');
  const sessionResponse = await axios.post(
    `${LOCAL_SERVER_URL}/api/sessions/create`,
    { projectId },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const { sessionId, containerId, terminal } = sessionResponse.data;
  console.log(`✅ Session created: ${sessionId}`);
  console.log(`✅ Container: ${containerId}`);
  console.log(`✅ Terminal status: ${terminal?.message || 'ready'}`);

  // Step 3: Connect to terminal
  console.log('\nStep 3: Connecting to terminal WebSocket...');

  return new Promise((resolve, reject) => {
    const socket = io(LOCAL_SERVER_URL, {
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected\n');

      socket.emit('terminal:create', {
        containerId,
        sessionId,
        rows: 24,
        cols: 80,
      }, (response) => {
        if (!response.success) {
          console.error('❌ Failed:', response.error);
          socket.close();
          reject(new Error(response.error));
          return;
        }

        console.log(`✅ Terminal session created: ${response.sessionId}\n`);
        console.log('========================================');
        console.log('📺 Terminal Output:');
        console.log('========================================');
      });
    });

    socket.on('terminal:data', (data) => {
      process.stdout.write(data);
    });

    socket.on('terminal:error', (error) => {
      console.error('\n❌ Terminal error:', error.message);
    });

    socket.on('terminal:close', () => {
      console.log('\n\n✅ Terminal closed');
      socket.close();
      resolve();
    });

    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket error:', error.message);
      reject(error);
    });

    // Send test commands
    setTimeout(() => {
      console.log('\n\n⌨️  Sending test commands...\n');
      socket.emit('terminal:input', 'echo "Terminal working!"\n');

      setTimeout(() => {
        socket.emit('terminal:input', 'which claude\n');

        setTimeout(() => {
          socket.emit('terminal:input', 'claude --version\n');

          setTimeout(() => {
            console.log('\n\n✅ All commands sent');
            setTimeout(() => socket.emit('terminal:close'), 2000);
          }, 1500);
        }, 1500);
      }, 1500);
    }, 2000);
  });
}

runTest()
  .then(() => {
    console.log('\n========================================');
    console.log('🎉 Terminal test complete!');
    console.log('========================================\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });
