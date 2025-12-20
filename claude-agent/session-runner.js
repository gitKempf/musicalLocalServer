#!/usr/bin/env node
/**
 * Claude Agent Session Runner
 * Manages Claude Code CLI sessions and handles generation requests
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 17110;
const AUTO_SHUTDOWN_MINUTES = parseInt(process.env.CLAUDE_AUTO_SHUTDOWN_MINUTES || '30');
const ACTIVITY_FILE = '/tmp/activity/last_activity';

app.use(express.json({ limit: '50mb' }));

// Active sessions
const sessions = new Map();

// Activity tracking
let lastActivity = Date.now();
let shutdownTimer = null;

/**
 * Update activity timestamp
 */
async function updateActivity() {
  lastActivity = Date.now();
  try {
    await fs.writeFile(ACTIVITY_FILE, lastActivity.toString());
  } catch (error) {
    console.warn('Failed to update activity file:', error.message);
  }
}

/**
 * Start auto-shutdown timer
 */
function startAutoShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
  }

  const timeoutMs = AUTO_SHUTDOWN_MINUTES * 60 * 1000;

  shutdownTimer = setTimeout(async () => {
    const idleTime = Date.now() - lastActivity;
    const idleMinutes = Math.floor(idleTime / 60000);

    if (idleMinutes >= AUTO_SHUTDOWN_MINUTES) {
      console.log(`🛑 Auto-shutdown triggered after ${idleMinutes} minutes of inactivity`);

      // Close all sessions
      for (const [sessionId, session] of sessions.entries()) {
        try {
          if (session.process && !session.process.killed) {
            session.process.kill('SIGTERM');
          }
        } catch (error) {
          console.error(`Failed to kill session ${sessionId}:`, error);
        }
      }

      process.exit(0);
    } else {
      // Reset timer
      startAutoShutdown();
    }
  }, timeoutMs);
}

/**
 * Create new Claude session
 */
async function createSession(sessionId, projectId, workDir) {
  console.log(`📝 Creating Claude session: ${sessionId} for project: ${projectId}`);

  const sessionDir = path.join('/app/.claude-sessions', sessionId);
  const projectDir = workDir || path.join('/app/projects', projectId);

  // Create directories
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  // Session metadata
  const session = {
    id: sessionId,
    projectId,
    sessionDir,
    projectDir,
    process: null,
    output: [],
    error: [],
    createdAt: new Date(),
    lastActivity: new Date(),
    status: 'created',
  };

  sessions.set(sessionId, session);
  await updateActivity();

  console.log(`✅ Session created: ${sessionId}`);
  return session;
}

/**
 * Execute Claude Code CLI
 */
async function executeGeneration(sessionId, prompt, options = {}) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  console.log(`🤖 Starting Claude Code generation for session: ${sessionId}`);
  session.status = 'generating';
  session.lastActivity = new Date();

  return new Promise((resolve, reject) => {
    // Spawn Claude Code CLI
    // Authentication is handled via ~/.config/claude-code/ (mounted from host)
    const claudeProcess = spawn('claude', [
      '--print',  // Non-interactive mode
      '--session-id', sessionId,
      prompt,
    ], {
      cwd: session.projectDir,
      env: {
        ...process.env,
        HOME: '/root',  // Ensure it finds config in /root/.config/claude-code
      },
    });

    session.process = claudeProcess;

    let stdout = '';
    let stderr = '';

    claudeProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      session.output.push(output);
      console.log(`[Claude] ${output.trim()}`);
    });

    claudeProcess.stderr.on('data', (data) => {
      const error = data.toString();
      stderr += error;
      session.error.push(error);
      console.error(`[Claude Error] ${error.trim()}`);
    });

    claudeProcess.on('close', async (code) => {
      session.status = code === 0 ? 'completed' : 'failed';
      session.lastActivity = new Date();

      await updateActivity();

      if (code === 0) {
        console.log(`✅ Generation completed for session: ${sessionId}`);
        resolve({
          success: true,
          sessionId,
          output: stdout,
          error: stderr,
        });
      } else {
        console.error(`❌ Generation failed for session: ${sessionId} (exit code: ${code})`);
        reject(new Error(`Claude Code failed with exit code ${code}: ${stderr}`));
      }
    });

    claudeProcess.on('error', (error) => {
      session.status = 'error';
      console.error(`❌ Failed to start Claude Code:`, error);
      reject(error);
    });
  });
}

/**
 * Get session info
 */
function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    outputLines: session.output.length,
    errorLines: session.error.length,
  };
}

/**
 * Delete session
 */
async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  console.log(`🗑️  Deleting session: ${sessionId}`);

  // Kill process if running
  if (session.process && !session.process.killed) {
    session.process.kill('SIGTERM');
  }

  // Remove from map
  sessions.delete(sessionId);

  // Optionally delete session directory
  // await fs.rm(session.sessionDir, { recursive: true, force: true });

  console.log(`✅ Session deleted: ${sessionId}`);
  return true;
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  const idleMinutes = Math.floor((Date.now() - lastActivity) / 60000);

  res.json({
    status: 'healthy',
    sessions: sessions.size,
    idleMinutes,
    autoShutdownMinutes: AUTO_SHUTDOWN_MINUTES,
    uptime: process.uptime(),
  });
});

/**
 * Create session
 */
app.post('/sessions/create', async (req, res) => {
  try {
    const { sessionId, projectId, workDir } = req.body;

    if (!sessionId || !projectId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and projectId are required',
      });
    }

    const session = await createSession(sessionId, projectId, workDir);

    res.json({
      success: true,
      session: {
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Generate code
 */
app.post('/sessions/:sessionId/generate', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { prompt, options } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'prompt is required',
      });
    }

    const result = await executeGeneration(sessionId, prompt, options);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Generation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get session info
 */
app.get('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  res.json({
    success: true,
    session,
  });
});

/**
 * List all sessions
 */
app.get('/sessions', (req, res) => {
  const sessionList = Array.from(sessions.values()).map(s => ({
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
  }));

  res.json({
    success: true,
    sessions: sessionList,
    count: sessionList.length,
  });
});

/**
 * Delete session
 */
app.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const deleted = await deleteSession(sessionId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json({
      success: true,
      message: 'Session deleted',
    });
  } catch (error) {
    console.error('Failed to delete session:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

app.listen(PORT, () => {
  console.log(`🤖 Claude Agent Session Runner started on port ${PORT}`);
  console.log(`⏰ Auto-shutdown after ${AUTO_SHUTDOWN_MINUTES} minutes of inactivity`);
  console.log(`📂 Sessions directory: /app/.claude-sessions`);
  console.log(`📂 Projects directory: /app/projects`);

  // Start auto-shutdown timer
  startAutoShutdown();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');

  // Close all sessions
  for (const [sessionId, session] of sessions.entries()) {
    try {
      if (session.process && !session.process.killed) {
        session.process.kill('SIGTERM');
      }
    } catch (error) {
      console.error(`Failed to kill session ${sessionId}:`, error);
    }
  }

  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});
