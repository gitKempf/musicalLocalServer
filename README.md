# Musical.run Local Server

Privacy-first AI code generation on your machine. Your code never leaves your computer.

## Quick Start

```bash
# Install with one command
curl -fsSL https://musical.run/install.sh | bash

# Or clone and install locally
git clone https://github.com/gitKempf/musicalLocalServer.git
cd musicalLocalServer
./install.sh
```

## The `musical` CLI

After installation, use the `musical` command to manage your servers:

```bash
# Interactive UI (Claude CLI-like interface)
musical

# List all instances
musical list

# Show instance status
musical status [instance]

# Start/stop instances
musical start <instance>
musical stop <instance>

# Authenticate with Musical.run
musical auth login <instance>

# View logs
musical logs <instance> [--service local|postgres|gitea|claude]

# Configure an instance
musical config edit <instance>

# Install a new instance
musical install --instance work --port 18100

# Uninstall an instance
musical uninstall <instance>
```

## Multi-Instance Support

Run multiple isolated servers on one machine:

```bash
# Home server (default ports 17100-17199)
./install.sh --instance home

# Work server (ports 18100-18199)
./install.sh --instance work --port 18100

# Dev server (ports 19100-19199)
./install.sh --instance dev --port 19100
```

Each instance is fully isolated with its own:
- Docker network (`musical-network-<instance>`)
- Containers (`musical-*-<instance>`)
- Volumes (persistent data)
- Port range
- Authentication

## Configuration

### Instance Configuration

Configuration is stored in `~/.musical/instances/<instance>/`:

```bash
# View configuration
musical config show <instance>

# Set a value
musical config set port 18100 --instance work
musical config set name "Work Server" --instance work

# Edit interactively
musical config edit <instance>
```

### Environment Variables

Create a `.env` file or set these variables:

```bash
# Instance
INSTANCE_ID=default
INSTANCE_NAME="Local Server"

# Ports
MUSICAL_PORT=17100
GITEA_PORT=17101
GITEA_SSH_PORT=2222

# Cloud connection
TUNNEL_ENABLED=true
TUNNEL_ROUTER_URL=https://musical.run
AUTH_SERVICE_URL=https://musical.run

# Optional: Direct API key
ANTHROPIC_API_KEY=your_key_here
```

## Authentication

### Device Authentication (Recommended)

```bash
# Start auth flow
musical auth login <instance>

# Follow the prompts to authenticate in browser
```

### API Key Authentication

Set `ANTHROPIC_API_KEY` in your `.env` file or environment.

### Auth Status

```bash
# Check authentication status
musical auth status

# Logout
musical auth logout <instance>
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Machine                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 musical-network-<instance>              │ │
│  │                                                         │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │ │
│  │  │  PostgreSQL  │  │    Gitea     │  │ Claude Agent │  │ │
│  │  │   Database   │  │  Git Server  │  │   AI Tasks   │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │ │
│  │         │                 │                 │          │ │
│  │         └─────────────────┼─────────────────┘          │ │
│  │                           │                             │ │
│  │                  ┌────────┴────────┐                   │ │
│  │                  │  Local Server   │                   │ │
│  │                  │   Port 17100    │                   │ │
│  │                  └────────┬────────┘                   │ │
│  └───────────────────────────│─────────────────────────────┘ │
│                              │                               │
│                    ┌─────────┴─────────┐                    │
│                    │   Tunnel/Direct   │                    │
│                    └─────────┬─────────┘                    │
└──────────────────────────────│──────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   Musical.run Cloud  │
                    │   (Tunnel Router)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │    Web Frontend     │
                    │   musical.run/app   │
                    └─────────────────────┘
```

## Services

Each instance runs four services:

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| Local Server | `musical-local-<id>` | 17100 | Main API server |
| PostgreSQL | `musical-postgres-<id>` | - | Database (internal) |
| Gitea | `musical-gitea-<id>` | 17101 | Git server |
| Claude Agent | `musical-claude-agent-<id>` | - | AI agent (internal) |

## Commands Reference

### Instance Management

```bash
musical list                    # List all instances
musical status [instance]       # Show status
musical start <instance>        # Start instance
musical stop <instance>         # Stop instance
musical restart <instance>      # Restart instance
musical shell <instance>        # Shell into container
musical logs <instance>         # View logs
musical uninstall <instance>    # Remove completely
```

### Authentication

```bash
musical auth login [instance]   # Authenticate
musical auth logout [instance]  # Logout
musical auth status [instance]  # Show auth status
```

### Configuration

```bash
musical config show [instance]  # Show config
musical config set <key> <val>  # Set config value
musical config edit [instance]  # Edit interactively
```

### Installation

```bash
musical install                 # Interactive install
musical install --instance id   # Named instance
musical install --port 18100    # Custom port
```

## Troubleshooting

### Check Status

```bash
# Quick status check
musical status

# Detailed health info
curl http://localhost:17100/health | jq

# Docker container status
docker ps | grep musical
```

### View Logs

```bash
# All logs
musical logs <instance>

# Specific service
musical logs <instance> --service postgres
musical logs <instance> --service gitea
musical logs <instance> --service claude

# Follow logs
musical logs <instance> --follow
```

### Common Issues

**Port already in use:**
```bash
# Check what's using the port
ss -tlnp | grep 17100

# Use a different port
musical install --port 18100
```

**Container won't start:**
```bash
# Check Docker logs
docker logs musical-local-<instance>

# Restart with fresh state
musical stop <instance>
docker rm -f musical-local-<instance>
musical start <instance>
```

**Authentication issues:**
```bash
# Re-authenticate
musical auth logout <instance>
musical auth login <instance>
```

## Development

### Building from Source

```bash
# Clone repository
git clone https://github.com/gitKempf/musicalLocalServer.git
cd musicalLocalServer

# Build Docker images
docker build -t musical-local-server:dev .
docker build -t musical-claude-agent:dev ./claude-agent

# Build CLI
cd cli
npm install
npm run build
npm link
```

### Running Tests

```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:e2e      # End-to-end tests
```

## License

MIT License - see [LICENSE](LICENSE)
