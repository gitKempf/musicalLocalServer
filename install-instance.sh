#!/bin/bash
#
# Musical.run Local Server - Instance-Based Installer
#
# Supports multiple isolated installations on the same machine.
# Each instance has its own Docker network, containers, and volumes.
#
# Usage:
#   # Install with default instance (home)
#   curl -fsSL https://musical.run/install.sh | bash
#
#   # Install a second instance (work)
#   curl -fsSL https://musical.run/install.sh | bash -s -- --instance work --port 18100
#
#   # Install with custom options
#   curl -fsSL https://musical.run/install.sh | bash -s -- --instance office --port 19100 --dir ~/musical-office
#
# This script will:
# 1. Generate a unique instance ID (or use provided one)
# 2. Create isolated Docker network and containers
# 3. Generate unique secure credentials
# 4. Start all services with instance-specific names
# 5. Register with Musical.run cloud
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Default configuration
INSTANCE_ID=""
INSTALL_DIR=""
MUSICAL_PORT=""
GITEA_PORT=""
GITEA_SSH_PORT=""
POSTGRES_PORT=""
REPO_URL="${REPO_URL:-https://github.com/gitKempf/musicalLocalServer.git}"
BRANCH="${BRANCH:-master}"

# Port allocation base for auto-assignment
PORT_BASE_HOME=17100
PORT_BASE_WORK=18100
PORT_BASE_OTHER=19100

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --instance|-i)
                INSTANCE_ID="$2"
                shift 2
                ;;
            --dir|-d)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --port|-p)
                MUSICAL_PORT="$2"
                shift 2
                ;;
            --gitea-port)
                GITEA_PORT="$2"
                shift 2
                ;;
            --branch|-b)
                BRANCH="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

show_help() {
    cat << EOF
Musical.run Local Server - Instance-Based Installer

Supports multiple isolated installations on the same machine.

Usage: install.sh [OPTIONS]

Options:
  --instance, -i ID     Instance identifier (e.g., 'home', 'work', 'office')
                        Default: auto-generated or 'default'
  --dir, -d DIR         Installation directory
                        Default: ~/musical-local-server-<instance>
  --port, -p PORT       Local server port
                        Default: auto-assigned based on instance
  --gitea-port PORT     Gitea port (default: musical_port + 1)
  --branch, -b BRANCH   Git branch to use (default: master)
  --help, -h            Show this help message

Examples:
  # First installation (home computer)
  ./install.sh --instance home

  # Second installation (work computer)
  ./install.sh --instance work --port 18100

  # Custom installation
  ./install.sh --instance office --port 19100 --dir ~/musical-office

Instance Isolation:
  Each instance gets:
  - Unique Docker network: musical-network-<instance>
  - Unique container names: musical-local-<instance>, musical-postgres-<instance>, etc.
  - Separate data volumes: musical-data-<instance>
  - Independent port assignments
  - Separate credentials and encryption keys

This allows running multiple Musical.run servers on the same machine
without any interference between instances.
EOF
}

# Generate a short random ID
generate_short_id() {
    openssl rand -base64 6 | tr -dc 'a-z0-9' | head -c 6
}

# Setup instance configuration
setup_instance_config() {
    # Generate instance ID if not provided
    if [ -z "$INSTANCE_ID" ]; then
        # Check if this is the first installation
        if ! docker ps -a --format '{{.Names}}' | grep -q '^musical-local-'; then
            INSTANCE_ID="default"
        else
            # Generate unique ID for additional installations
            INSTANCE_ID="inst-$(generate_short_id)"
            log_info "Generated instance ID: $INSTANCE_ID"
        fi
    fi
    
    # Validate instance ID (alphanumeric and hyphens only)
    if ! [[ "$INSTANCE_ID" =~ ^[a-zA-Z0-9][-a-zA-Z0-9]*$ ]]; then
        log_error "Invalid instance ID: $INSTANCE_ID"
        log_error "Use only letters, numbers, and hyphens (must start with letter/number)"
        exit 1
    fi
    
    # Set installation directory
    if [ -z "$INSTALL_DIR" ]; then
        if [ "$INSTANCE_ID" = "default" ]; then
            INSTALL_DIR="$HOME/musical-local-server"
        else
            INSTALL_DIR="$HOME/musical-local-server-${INSTANCE_ID}"
        fi
    fi
    
    # Auto-assign ports based on instance
    if [ -z "$MUSICAL_PORT" ]; then
        case "$INSTANCE_ID" in
            default|home)
                MUSICAL_PORT=$PORT_BASE_HOME
                ;;
            work)
                MUSICAL_PORT=$PORT_BASE_WORK
                ;;
            *)
                # Find next available port range
                MUSICAL_PORT=$(find_available_port_range)
                ;;
        esac
    fi
    
    # Set related ports
    GITEA_PORT="${GITEA_PORT:-$((MUSICAL_PORT + 1))}"
    GITEA_SSH_PORT="${GITEA_SSH_PORT:-$((MUSICAL_PORT + 100))}"
    POSTGRES_PORT="${POSTGRES_PORT:-$((MUSICAL_PORT + 2))}"
    
    # Validate ports are not in use
    validate_ports
}

# Find an available port range (starting from PORT_BASE_OTHER)
find_available_port_range() {
    local port=$PORT_BASE_OTHER
    while [ $port -lt 65000 ]; do
        if ! is_port_in_use $port && ! is_port_in_use $((port + 1)) && ! is_port_in_use $((port + 2)); then
            echo $port
            return
        fi
        port=$((port + 100))
    done
    echo $PORT_BASE_OTHER
}

# Check if a port is in use
is_port_in_use() {
    local port=$1
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep -q ":${port} " && return 0
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tlnp 2>/dev/null | grep -q ":${port} " && return 0
    fi
    # Also check if any Musical container is using this port
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${port}->" && return 0
    return 1
}

# Validate that selected ports are available
validate_ports() {
    local ports_in_use=()
    
    for port in $MUSICAL_PORT $GITEA_PORT $GITEA_SSH_PORT; do
        if is_port_in_use $port; then
            ports_in_use+=($port)
        fi
    done
    
    if [ ${#ports_in_use[@]} -gt 0 ]; then
        log_warning "Some ports are already in use: ${ports_in_use[*]}"
        log_info "Checking if they belong to another Musical instance..."
        
        for port in "${ports_in_use[@]}"; do
            local container=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep ":${port}->" | awk '{print $1}')
            if [ -n "$container" ]; then
                log_info "  Port $port is used by container: $container"
            fi
        done
        
        echo ""
        log_error "Please specify different ports with --port option"
        log_info "Example: --port $((MUSICAL_PORT + 1000))"
        exit 1
    fi
    
    log_success "Ports $MUSICAL_PORT, $GITEA_PORT, $GITEA_SSH_PORT are available"
}

# Check if instance already exists
check_existing_instance() {
    local container_name="musical-local-${INSTANCE_ID}"
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
        log_warning "Instance '$INSTANCE_ID' already exists"
        echo ""
        echo "Options:"
        echo "  1. Update existing instance: cd $INSTALL_DIR && git pull && docker-compose up -d --build"
        echo "  2. Remove and reinstall: cd $INSTALL_DIR && docker-compose down -v && cd .. && rm -rf $INSTALL_DIR"
        echo "  3. Create a new instance with different ID: --instance <new-id>"
        echo ""
        read -p "Do you want to update the existing instance? (y/N) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log_info "Updating existing instance..."
            UPDATE_MODE=true
        else
            exit 1
        fi
    fi
}

# Banner
print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🎵  Musical.run Local Server Installer  🎵              ║"
    echo "║                                                              ║"
    echo "║     Instance-based installation for multi-server setups     ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Logging functions
log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✅${NC} $1"; }
log_warning() { echo -e "${YELLOW}⚠️${NC} $1"; }
log_error() { echo -e "${RED}❌${NC} $1"; }
log_step() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}\n"; }

# Generate secure random strings
generate_secret() {
    local length=${1:-32}
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

generate_password() {
    local length=${1:-24}
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking Prerequisites"
    
    local missing=()
    
    if command_exists docker; then
        local docker_version=$(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')
        log_success "Docker installed: $docker_version"
    else
        missing+=("docker")
        log_error "Docker not found"
    fi
    
    if command_exists docker-compose || docker compose version >/dev/null 2>&1; then
        if docker compose version >/dev/null 2>&1; then
            log_success "Docker Compose V2 installed"
            COMPOSE_CMD="docker compose"
        else
            log_success "Docker Compose installed"
            COMPOSE_CMD="docker-compose"
        fi
    else
        missing+=("docker-compose")
        log_error "Docker Compose not found"
    fi
    
    if command_exists git; then
        log_success "Git installed"
    else
        missing+=("git")
        log_error "Git not found"
    fi
    
    if command_exists openssl; then
        log_success "OpenSSL installed"
    else
        missing+=("openssl")
        log_error "OpenSSL not found"
    fi
    
    if command_exists curl; then
        log_success "curl installed"
    else
        missing+=("curl")
        log_error "curl not found"
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        echo ""
        log_error "Missing required tools: ${missing[*]}"
        echo ""
        echo "On Ubuntu/Debian:"
        echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose git openssl curl"
        echo ""
        echo "On macOS:"
        echo "  brew install docker docker-compose git openssl curl"
        exit 1
    fi
    
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker daemon is not running"
        echo "Please start Docker and try again"
        exit 1
    fi
    log_success "Docker daemon is running"
}

# Clone or update repository
setup_repository() {
    log_step "Setting Up Repository"
    
    if [ -d "$INSTALL_DIR" ]; then
        if [ "$UPDATE_MODE" = true ]; then
            log_info "Updating existing repository..."
            cd "$INSTALL_DIR"
            git fetch origin "$BRANCH" 2>/dev/null || true
            git reset --hard "origin/$BRANCH" 2>/dev/null || true
            log_success "Repository updated"
        else
            log_error "Directory already exists: $INSTALL_DIR"
            exit 1
        fi
    else
        log_info "Cloning repository to $INSTALL_DIR..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
        log_success "Repository cloned"
    fi
    
    cd "$INSTALL_DIR"
    
    # Move local-server contents to root if needed
    if [ -d "local-server" ] && [ ! -f "docker-compose.yml" ]; then
        shopt -s dotglob
        mv local-server/* . 2>/dev/null || true
        rm -rf local-server
        shopt -u dotglob
    fi
}

# Generate unique credentials for this instance
generate_credentials() {
    log_step "Generating Secure Credentials for Instance: $INSTANCE_ID"
    
    local env_file="$INSTALL_DIR/.env"
    local secrets_dir="$HOME/.musical/instances/${INSTANCE_ID}"
    
    mkdir -p "$secrets_dir"
    chmod 700 "$HOME/.musical"
    chmod 700 "$secrets_dir"
    
    # Generate credentials
    DB_PASSWORD=$(generate_password 32)
    GITEA_ADMIN_PASSWORD=$(generate_password 24)
    GITEA_SECRET_KEY=$(generate_secret 64)
    ENCRYPTION_KEY=$(generate_secret 32)
    
    log_info "Generated unique credentials for instance: $INSTANCE_ID"
    
    # Create .env file with instance configuration
    cat > "$env_file" << EOF
# Musical.run Local Server Configuration
# Instance: ${INSTANCE_ID}
# Generated: $(date -Iseconds)
#
# ⚠️  SECURITY: This file contains sensitive credentials.
#     Do not share or commit this file to version control.
#

#=============================================================================
# INSTANCE CONFIGURATION
#=============================================================================
# Unique identifier for this installation
# Used to isolate Docker networks, containers, and volumes
INSTANCE_ID=${INSTANCE_ID}

#=============================================================================
# PORTS
#=============================================================================
# Each instance uses different ports to avoid conflicts
MUSICAL_PORT=${MUSICAL_PORT}
GITEA_PORT=${GITEA_PORT}
GITEA_SSH_PORT=${GITEA_SSH_PORT}

#=============================================================================
# DATABASE
#=============================================================================
DB_PASSWORD=${DB_PASSWORD}

#=============================================================================
# GITEA
#=============================================================================
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=${GITEA_ADMIN_PASSWORD}
GITEA_SECRET_KEY=${GITEA_SECRET_KEY}

#=============================================================================
# ENCRYPTION
#=============================================================================
ENCRYPTION_KEY=${ENCRYPTION_KEY}

#=============================================================================
# AUTO-SETUP
#=============================================================================
AUTO_SETUP=true

#=============================================================================
# CLAUDE CREDENTIALS (Optional)
#=============================================================================
# Path to your Claude CLI config (default: ~/.config/claude-code)
# CLAUDE_CONFIG_PATH=~/.config/claude-code

# Or set your API key directly:
# ANTHROPIC_API_KEY=your_api_key_here
EOF
    
    chmod 600 "$env_file"
    log_success "Environment file created: $env_file"
    
    # Save credentials backup
    cat > "$secrets_dir/credentials.json" << EOF
{
    "instance_id": "$INSTANCE_ID",
    "generated_at": "$(date -Iseconds)",
    "install_dir": "$INSTALL_DIR",
    "db_password": "$DB_PASSWORD",
    "gitea_admin_user": "musical",
    "gitea_admin_password": "$GITEA_ADMIN_PASSWORD",
    "ports": {
        "musical": $MUSICAL_PORT,
        "gitea": $GITEA_PORT,
        "gitea_ssh": $GITEA_SSH_PORT
    },
    "containers": {
        "local_server": "musical-local-${INSTANCE_ID}",
        "postgres": "musical-postgres-${INSTANCE_ID}",
        "gitea": "musical-gitea-${INSTANCE_ID}",
        "claude_agent": "musical-claude-agent-${INSTANCE_ID}"
    },
    "network": "musical-network-${INSTANCE_ID}"
}
EOF
    chmod 600 "$secrets_dir/credentials.json"
    log_success "Credentials backed up to $secrets_dir/credentials.json"
}

# Build Docker images
build_images() {
    log_step "Building Docker Images"
    
    cd "$INSTALL_DIR"
    
    log_info "Building local server image..."
    docker build -t "musical-local-server-${INSTANCE_ID}:latest" . 2>&1 | tail -5
    
    if [ -d "claude-agent" ]; then
        log_info "Building Claude agent image..."
        docker build -t "musical-claude-agent-${INSTANCE_ID}:latest" ./claude-agent 2>&1 | tail -5
    fi
    
    log_success "Docker images built"
}

# Start services with instance isolation
start_services() {
    log_step "Starting Services (Instance: $INSTANCE_ID)"
    
    cd "$INSTALL_DIR"
    
    # Determine compose file
    if [ -f "docker-compose.instance.yml" ]; then
        COMPOSE_FILE="docker-compose.instance.yml"
    elif [ -f "docker-compose.user.yml" ]; then
        COMPOSE_FILE="docker-compose.user.yml"
    else
        COMPOSE_FILE="docker-compose.yml"
    fi
    
    log_info "Using compose file: $COMPOSE_FILE"
    log_info "Instance ID: $INSTANCE_ID"
    log_info "Network: musical-network-${INSTANCE_ID}"
    
    # Export instance ID for docker-compose
    export INSTANCE_ID
    
    $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "musical-${INSTANCE_ID}" up -d
    
    log_success "Services started"
    
    # List running containers for this instance
    echo ""
    log_info "Running containers for instance '$INSTANCE_ID':"
    docker ps --filter "label=musical.instance=${INSTANCE_ID}" --format "  {{.Names}}: {{.Status}}"
}

# Wait for services
wait_for_services() {
    log_step "Waiting for Services to Initialize"
    
    local max_attempts=60
    local attempt=0
    
    # Wait for PostgreSQL
    log_info "Waiting for PostgreSQL..."
    while [ $attempt -lt $max_attempts ]; do
        if docker exec "musical-postgres-${INSTANCE_ID}" pg_isready -U musical >/dev/null 2>&1; then
            log_success "PostgreSQL is ready"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "PostgreSQL did not become ready"
        exit 1
    fi
    
    # Wait for Gitea
    log_info "Waiting for Gitea..."
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:${GITEA_PORT}/api/v1/version" >/dev/null 2>&1; then
            log_success "Gitea is ready"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "Gitea did not become ready"
        exit 1
    fi
    
    # Wait for Local Server
    log_info "Waiting for Musical Local Server..."
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:${MUSICAL_PORT}/health" >/dev/null 2>&1; then
            log_success "Musical Local Server is ready"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "Local Server did not become ready"
        exit 1
    fi
}

# Configure Gitea
configure_gitea() {
    log_step "Configuring Gitea"
    
    local gitea_container="musical-gitea-${INSTANCE_ID}"
    local admin_user="musical"
    local admin_password="$GITEA_ADMIN_PASSWORD"
    local secrets_dir="$HOME/.musical/instances/${INSTANCE_ID}"
    
    # Ensure Gitea is properly configured
    docker exec "$gitea_container" sh -c "
        if grep -q 'INSTALL_LOCK = false' /data/gitea/conf/app.ini 2>/dev/null; then
            sed -i 's/INSTALL_LOCK = false/INSTALL_LOCK = true/' /data/gitea/conf/app.ini
        fi
    " 2>/dev/null || true
    
    docker restart "$gitea_container" >/dev/null 2>&1 || true
    sleep 5
    
    # Wait for Gitea again
    local attempt=0
    while [ $attempt -lt 30 ]; do
        if curl -s "http://localhost:${GITEA_PORT}/api/v1/version" >/dev/null 2>&1; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    # Create or update admin user
    local user_exists=$(docker exec -u git "$gitea_container" sh -c "gitea admin user list 2>&1 | grep -w '$admin_user' | wc -l" 2>/dev/null || echo "0")
    
    if [ "$user_exists" -gt 0 ]; then
        log_info "Updating admin password..."
        docker exec -u git "$gitea_container" sh -c "gitea admin user change-password --username '$admin_user' --password '$admin_password'" 2>/dev/null || true
    else
        log_info "Creating Gitea admin user..."
        docker exec -u git "$gitea_container" sh -c "gitea admin user create --username '$admin_user' --password '$admin_password' --email 'admin@musical.local' --admin --must-change-password=false 2>&1" || true
    fi
    
    # Generate API token
    log_info "Generating Gitea API token..."
    local token_name="musical-${INSTANCE_ID}-$(date +%s)"
    
    local response=$(curl -s -X POST "http://localhost:${GITEA_PORT}/api/v1/users/$admin_user/tokens" \
        -u "$admin_user:$admin_password" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$token_name\", \"scopes\": [\"write:repository\", \"write:user\", \"write:organization\"]}")
    
    local token=$(echo "$response" | grep -o '"sha1":"[^"]*"' | cut -d'"' -f4)
    
    if [ -n "$token" ]; then
        log_success "Gitea API token generated"
        
        # Save to credentials
        cat > "$secrets_dir/gitea-credentials.json" << EOF
{
    "url": "http://gitea:3000",
    "external_url": "http://localhost:${GITEA_PORT}",
    "username": "$admin_user",
    "token": "$token",
    "password": "$admin_password"
}
EOF
        chmod 600 "$secrets_dir/gitea-credentials.json"
        
        # Update .env
        echo "" >> "$INSTALL_DIR/.env"
        echo "# Gitea API Token (auto-generated)" >> "$INSTALL_DIR/.env"
        echo "GITEA_TOKEN=$token" >> "$INSTALL_DIR/.env"
        echo "GITEA_USERNAME=$admin_user" >> "$INSTALL_DIR/.env"
        
        log_success "Gitea credentials saved"
    else
        log_warning "Could not generate API token automatically"
    fi
}

# Restart local server
restart_local_server() {
    log_info "Restarting local server to apply configuration..."
    
    cd "$INSTALL_DIR"
    export INSTANCE_ID
    
    local compose_file="docker-compose.instance.yml"
    [ ! -f "$compose_file" ] && compose_file="docker-compose.user.yml"
    [ ! -f "$compose_file" ] && compose_file="docker-compose.yml"
    
    $COMPOSE_CMD -f "$compose_file" --project-name "musical-${INSTANCE_ID}" restart musical-local 2>/dev/null || true
    
    sleep 5
    local attempt=0
    while [ $attempt -lt 30 ]; do
        if curl -s "http://localhost:${MUSICAL_PORT}/health" >/dev/null 2>&1; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
}

# Print success message
print_success() {
    log_step "Installation Complete! 🎉"
    
    local health=$(curl -s "http://localhost:${MUSICAL_PORT}/health" 2>/dev/null)
    local tunnel_url=$(echo "$health" | grep -o '"tunnelUrl":"[^"]*"' | cut -d'"' -f4)
    local public_key=$(echo "$health" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4 | head -c 20)
    
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🎵  Musical.run Local Server is Ready!  🎵              ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    echo -e "${BOLD}Instance Information:${NC}"
    echo -e "  Instance ID:   ${CYAN}${INSTANCE_ID}${NC}"
    echo -e "  Network:       ${CYAN}musical-network-${INSTANCE_ID}${NC}"
    echo -e "  Public Key:    ${CYAN}${public_key}...${NC}"
    echo ""
    
    echo -e "${BOLD}Service URLs:${NC}"
    echo -e "  Local Server:  ${CYAN}http://localhost:${MUSICAL_PORT}${NC}"
    echo -e "  Gitea:         ${CYAN}http://localhost:${GITEA_PORT}${NC}"
    if [ -n "$tunnel_url" ]; then
        echo -e "  Tunnel URL:    ${CYAN}$tunnel_url${NC}"
    fi
    echo ""
    
    echo -e "${BOLD}Containers:${NC}"
    echo -e "  musical-local-${INSTANCE_ID}"
    echo -e "  musical-postgres-${INSTANCE_ID}"
    echo -e "  musical-gitea-${INSTANCE_ID}"
    echo -e "  musical-claude-agent-${INSTANCE_ID}"
    echo ""
    
    echo -e "${BOLD}Installation Directory:${NC}"
    echo -e "  ${CYAN}$INSTALL_DIR${NC}"
    echo ""
    
    echo -e "${BOLD}Credentials:${NC}"
    echo -e "  Config:  ${CYAN}$INSTALL_DIR/.env${NC}"
    echo -e "  Backup:  ${CYAN}$HOME/.musical/instances/${INSTANCE_ID}/${NC}"
    echo ""
    
    echo -e "${BOLD}Commands:${NC}"
    echo -e "  View logs:     ${CYAN}cd $INSTALL_DIR && docker compose logs -f${NC}"
    echo -e "  Stop:          ${CYAN}cd $INSTALL_DIR && docker compose --project-name musical-${INSTANCE_ID} down${NC}"
    echo -e "  Start:         ${CYAN}cd $INSTALL_DIR && docker compose --project-name musical-${INSTANCE_ID} up -d${NC}"
    echo ""
    
    echo -e "${BOLD}Next Steps:${NC}"
    echo -e "  1. Open ${CYAN}https://musical.run${NC} in your browser"
    echo -e "  2. Login or create an account"
    echo -e "  3. Your local server will appear in the server selector"
    echo ""
    
    # Show other instances if they exist
    local other_instances=$(docker ps --filter "label=musical.service=local-server" --format '{{.Names}}' | grep -v "musical-local-${INSTANCE_ID}" || true)
    if [ -n "$other_instances" ]; then
        echo -e "${BOLD}Other Musical Instances Running:${NC}"
        for container in $other_instances; do
            local inst_id=$(echo "$container" | sed 's/musical-local-//')
            local inst_port=$(docker port "$container" 17100/tcp 2>/dev/null | cut -d: -f2)
            echo -e "  - ${inst_id}: http://localhost:${inst_port}"
        done
        echo ""
    fi
    
    echo -e "${YELLOW}⚠️  Security Note:${NC}"
    echo -e "  Each instance uses unique, randomly generated credentials."
    echo -e "  Keep your .env file secure and do not share it."
    echo ""
}

# Cleanup on error
cleanup_on_error() {
    log_error "Installation failed!"
    echo ""
    echo "To troubleshoot:"
    echo "  1. Check logs: docker logs musical-local-${INSTANCE_ID}"
    echo "  2. Check ports: netstat -tlnp | grep -E '(${MUSICAL_PORT}|${GITEA_PORT})'"
    echo ""
    echo "To clean up:"
    echo "  cd $INSTALL_DIR && docker compose --project-name musical-${INSTANCE_ID} down -v"
    echo "  rm -rf $INSTALL_DIR"
    echo ""
}

# Main installation flow
main() {
    parse_args "$@"
    
    trap cleanup_on_error ERR
    
    print_banner
    setup_instance_config
    
    log_info "Instance ID: $INSTANCE_ID"
    log_info "Installation directory: $INSTALL_DIR"
    log_info "Ports: Musical=$MUSICAL_PORT, Gitea=$GITEA_PORT, Gitea SSH=$GITEA_SSH_PORT"
    echo ""
    
    check_existing_instance
    check_prerequisites
    setup_repository
    generate_credentials
    build_images
    start_services
    wait_for_services
    configure_gitea
    restart_local_server
    print_success
}

# Run
main "$@"
