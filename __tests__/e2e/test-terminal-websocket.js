#!/usr/bin/env node
/**
 * Test Terminal WebSocket Integration
 *
 * This script tests the new docker exec-based terminal:
 * 1. Creates a project and session
 * 2. Connects to terminal via WebSocket
 * 3. Sends interactive commands
 * 4. Receives output in real-time
 */

const io = require('socket.io-client');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const TUNNEL_ROUTER_URL = 'http://localhost:17200';
const LOCAL_SERVER_URL = 'http://localhost:17100';
const USER_ID = '17';

// Generate JWT token for authentication
function generateToken() {
  const secret = process.env.JWT_SECRET || 'musical-run-secret-key';
  return jwt.sign(
    {
      userId: parseInt(USER_ID),
      email: 'test@example.com',
      jti: 'test-' + Date.now()
    },
    secret,
    { expiresIn: '1h' }
  );
}

async function runTest() {
  console.log('========================================');
  console.log('🧪 Terminal WebSocket Integration Test');
  console.log('========================================');
  console.log('');

  const token = generateToken();
  console.log('✅ Generated auth token');
  console.log('');

  // Step 1: Create project
  console.log('Step 1: Creating project...');
  const projectResponse = await axios.post(
    `${TUNNEL_ROUTER_URL}/api/tunnel/proxy/${USER_ID}`,
    {
      method: 'POST',
      path: '/api/projects',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        name: `Terminal Test ${Date.now()}`,
        template: 'react-native',
        initialPrompt: 'test terminal',
      },
    }
  );

  const projectId = projectResponse.data.project.id;
  console.log(`✅ Project created: ${projectId}`);
  console.log('');

  // Step 2: Create session
  console.log('Step 2: Creating session...');
  const sessionResponse = await axios.post(
    `${TUNNEL_ROUTER_URL}/api/tunnel/proxy/${USER_ID}`,
    {
      method: 'POST',
      path: '/api/sessions/create',
      headers: { Authorization: `Bearer ${token}` },
      body: { projectId },
    }
  );

  const { sessionId, containerId, terminal } = sessionResponse.data;
  console.log(`✅ Session created: ${sessionId}`);
  console.log(`✅ Container: ${containerId}`);
  console.log(`✅ Terminal status: ${terminal?.message || 'ready'}`);
  console.log('');

  // Step 3: Connect to terminal via WebSocket
  console.log('Step 3: Connecting to terminal WebSocket...');

  return new Promise((resolve, reject) => {
    const socket = io(LOCAL_SERVER_URL, {
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      console.log('');

      // Create terminal session
      console.log('Step 4: Creating terminal session...');
      socket.emit('terminal:create', {
        containerId,
        sessionId,
        rows: 24,
        cols: 80,
      }, (response) => {
        if (!response.success) {
          console.error('❌ Failed to create terminal:', response.error);
          socket.close();
          reject(new Error(response.error));
          return;
        }

        console.log(`✅ Terminal session created: ${response.sessionId}`);
        console.log('');
        console.log('========================================');
        console.log('📺 Terminal Output:');
        console.log('========================================');
      });
    });

    // Handle terminal output
    socket.on('terminal:data', (data) => {
      process.stdout.write(data);
    });

    // Handle terminal errors
    socket.on('terminal:error', (error) => {
      console.error('\n❌ Terminal error:', error.message);
    });

    // Handle terminal close
    socket.on('terminal:close', () => {
      console.log('\n✅ Terminal session closed');
      socket.close();
      resolve();
    });

    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error.message);
      reject(error);
    });

    socket.on('disconnect', () => {
      console.log('\n🔌 WebSocket disconnected');
    });

    // Send test commands after a delay to let terminal initialize
    setTimeout(() => {
      console.log('\n========================================');
      console.log('⌨️  Sending test commands...');
      console.log('========================================\n');

      // Test 1: Basic command
      socket.emit('terminal:input', 'echo "Hello from WebSocket terminal!"\n');

      setTimeout(() => {
        // Test 2: Check working directory
        socket.emit('terminal:input', 'pwd\n');

        setTimeout(() => {
          // Test 3: List files
          socket.emit('terminal:input', 'ls -la\n');

          setTimeout(() => {
            // Test 4: Check Node version
            socket.emit('terminal:input', 'node --version\n');

            setTimeout(() => {
              console.log('\n========================================');
              console.log('✅ All test commands sent successfully');
              console.log('========================================\n');

              // Close after showing results
              setTimeout(() => {
                socket.emit('terminal:close');
              }, 2000);
            }, 1000);
          }, 1000);
        }, 1000);
      }, 1000);
    }, 2000);
  });
}

// Run the test
runTest()
  .then(() => {
    console.log('\n========================================');
    console.log('🎉 Terminal WebSocket test completed!');
    console.log('========================================\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });
