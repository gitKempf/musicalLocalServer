#!/usr/bin/env node
/**
 * Git MCP Server for Claude Code CLI
 *
 * This MCP (Model Context Protocol) server provides Git operations to Claude.
 * It enables Claude to automatically commit generated code to the local Gitea repository.
 *
 * Tools provided:
 * - git_status: Check repository status
 * - git_add: Stage files for commit
 * - git_commit: Create a commit
 * - git_push: Push to remote
 * - git_init: Initialize repository
 * - git_log: View commit history
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

// Default working directory for generated projects
const DEFAULT_WORK_DIR = process.env.WORK_DIR || '/app/projects';

// Gitea configuration
const GITEA_URL = process.env.GITEA_URL || 'http://local-gitea:3000';
const GITEA_USER = process.env.GITEA_USER || 'musical';
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';

/**
 * Execute git command
 */
async function execGit(command, workDir = DEFAULT_WORK_DIR) {
  try {
    const { stdout, stderr } = await execAsync(`git ${command}`, {
      cwd: workDir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // Disable prompts
      },
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || '',
    };
  }
}

/**
 * Create MCP server
 */
const server = new Server(
  {
    name: 'git-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'git_status',
        description: 'Get the current status of the Git repository',
        inputSchema: {
          type: 'object',
          properties: {
            workDir: {
              type: 'string',
              description: 'Working directory (defaults to /app/projects)',
            },
          },
        },
      },
      {
        name: 'git_add',
        description: 'Stage files for commit',
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files to stage (e.g., [".", "file.js", "src/"])',
            },
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
          },
          required: ['files'],
        },
      },
      {
        name: 'git_commit',
        description: 'Create a commit with staged changes',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Commit message',
            },
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'git_push',
        description: 'Push commits to remote repository',
        inputSchema: {
          type: 'object',
          properties: {
            remote: {
              type: 'string',
              description: 'Remote name (default: origin)',
              default: 'origin',
            },
            branch: {
              type: 'string',
              description: 'Branch name (default: main)',
              default: 'main',
            },
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
          },
        },
      },
      {
        name: 'git_init',
        description: 'Initialize a new Git repository',
        inputSchema: {
          type: 'object',
          properties: {
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
            remoteName: {
              type: 'string',
              description: 'Remote repository name',
            },
            remoteUrl: {
              type: 'string',
              description: 'Remote repository URL',
            },
          },
        },
      },
      {
        name: 'git_log',
        description: 'View commit history',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of commits to show (default: 10)',
              default: 10,
            },
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
          },
        },
      },
      {
        name: 'git_auto_commit',
        description: 'Automatically stage all changes and commit with AI-generated message',
        inputSchema: {
          type: 'object',
          properties: {
            workDir: {
              type: 'string',
              description: 'Working directory',
            },
            push: {
              type: 'boolean',
              description: 'Push after committing (default: false)',
              default: false,
            },
          },
        },
      },
    ],
  };
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'git_status': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;
        const result = await execGit('status --short', workDir);

        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? result.stdout || 'Working tree clean'
                : `Error: ${result.error}\n${result.stderr}`,
            },
          ],
        };
      }

      case 'git_add': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;
        const files = args.files.join(' ');
        const result = await execGit(`add ${files}`, workDir);

        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Staged: ${files}`
                : `Error: ${result.error}\n${result.stderr}`,
            },
          ],
        };
      }

      case 'git_commit': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;
        const message = args.message.replace(/"/g, '\\"');
        const result = await execGit(`commit -m "${message}"`, workDir);

        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? result.stdout
                : `Error: ${result.error}\n${result.stderr}`,
            },
          ],
        };
      }

      case 'git_push': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;
        const remote = args.remote || 'origin';
        const branch = args.branch || 'main';
        const result = await execGit(`push ${remote} ${branch}`, workDir);

        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? result.stdout || 'Pushed successfully'
                : `Error: ${result.error}\n${result.stderr}`,
            },
          ],
        };
      }

      case 'git_init': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;

        // Initialize repo
        let result = await execGit('init -b main', workDir);
        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Error initializing: ${result.error}\n${result.stderr}`,
              },
            ],
          };
        }

        // Set user config
        await execGit('config user.name "Claude Code"', workDir);
        await execGit('config user.email "claude@musical.run"', workDir);

        // Add remote if specified
        if (args.remoteUrl) {
          const remoteName = args.remoteName || 'origin';
          result = await execGit(
            `remote add ${remoteName} ${args.remoteUrl}`,
            workDir
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: 'Repository initialized successfully',
            },
          ],
        };
      }

      case 'git_log': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;
        const limit = args.limit || 10;
        const result = await execGit(
          `log --oneline --max-count=${limit}`,
          workDir
        );

        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? result.stdout || 'No commits yet'
                : `Error: ${result.error}\n${result.stderr}`,
            },
          ],
        };
      }

      case 'git_auto_commit': {
        const workDir = args.workDir || DEFAULT_WORK_DIR;

        // Check status
        const status = await execGit('status --short', workDir);
        if (!status.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Error checking status: ${status.error}`,
              },
            ],
          };
        }

        if (!status.stdout) {
          return {
            content: [
              {
                type: 'text',
                text: 'No changes to commit',
              },
            ],
          };
        }

        // Stage all changes
        const add = await execGit('add .', workDir);
        if (!add.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Error staging files: ${add.error}`,
              },
            ],
          };
        }

        // Generate commit message from diff
        const diff = await execGit('diff --cached --stat', workDir);
        const commitMessage = `Auto-commit: Generated code\n\n${diff.stdout}`;

        // Commit
        const commit = await execGit(
          `commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
          workDir
        );

        let resultText = commit.success
          ? `Committed: ${commit.stdout}`
          : `Error committing: ${commit.error}`;

        // Push if requested
        if (args.push && commit.success) {
          const push = await execGit('push origin main', workDir);
          resultText += push.success
            ? '\nPushed to remote'
            : `\nError pushing: ${push.error}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Git MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
