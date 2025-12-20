#!/bin/bash
#
# Musical.run Local Server - One-Command Installer
#
# Usage:
#   curl -fsSL https://musical.run/install.sh | bash
#
# Or directly from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/gitKempf/musicalLocalServer/master/install.sh | bash
#
# Or with custom options:
#   curl -fsSL https://musical.run/install.sh | bash -s -- --port 17100
#
# This script will:
# 1. Check prerequisites (Docker, Docker Compose)
# 2. Clone the local-server repository
# 3. Generate unique secure credentials
# 4. Start all services (PostgreSQL, Gitea, Local Server)
# 5. Wait for Gitea to be ready and configure it automatically
# 6. Display connection information
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Default configuration
INSTALL_DIR="${INSTALL_DIR:-$HOME/musical-local-server}"
MUSICAL_PORT="${MUSICAL_PORT:-17100}"
GITEA_PORT="${GITEA_PORT:-17101}"
POSTGRES_PORT="${POSTGRES_PORT:-17102}"
REPO_URL="${REPO_URL:-https://github.com/gitKempf/musicalLocalServer.git}"
BRANCH="${BRANCH:-master}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        --port)
            MUSICAL_PORT="$2"
            shift 2
            ;;
        --gitea-port)
            GITEA_PORT="$2"
            shift 2
            ;;
        --branch)
            BRANCH="$2"
            shift 2
            ;;
        --help)
            echo "Musical.run Local Server Installer"
            echo ""
            echo "Usage: install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dir DIR         Installation directory (default: ~/musical-local-server)"
            echo "  --port PORT       Local server port (default: 17100)"
            echo "  --gitea-port PORT Gitea port (default: 17101)"
            echo "  --branch BRANCH   Git branch to use (default: main)"
            echo "  --help            Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Banner
print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🎵  Musical.run Local Server Installer  🎵              ║"
    echo "║                                                              ║"
    echo "║     One-command setup for local code generation             ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✅${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

log_error() {
    echo -e "${RED}❌${NC} $1"
}

log_step() {
    echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}\n"
}

# Generate cryptographically secure random string
generate_secret() {
    local length=${1:-32}
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# Generate password with special characters
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
    
    # Check Docker
    if command_exists docker; then
        local docker_version=$(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')
        log_success "Docker installed: $docker_version"
    else
        missing+=("docker")
        log_error "Docker not found"
    fi
    
    # Check Docker Compose
    if command_exists docker-compose || docker compose version >/dev/null 2>&1; then
        if docker compose version >/dev/null 2>&1; then
            local compose_version=$(docker compose version --short 2>/dev/null)
            log_success "Docker Compose installed: $compose_version"
        else
            local compose_version=$(docker-compose --version 2>/dev/null | cut -d' ' -f4 | tr -d ',')
            log_success "Docker Compose installed: $compose_version"
        fi
    else
        missing+=("docker-compose")
        log_error "Docker Compose not found"
    fi
    
    # Check Git
    if command_exists git; then
        local git_version=$(git --version 2>/dev/null | cut -d' ' -f3)
        log_success "Git installed: $git_version"
    else
        missing+=("git")
        log_error "Git not found"
    fi
    
    # Check OpenSSL (for generating secrets)
    if command_exists openssl; then
        log_success "OpenSSL installed"
    else
        missing+=("openssl")
        log_error "OpenSSL not found"
    fi
    
    # Check curl
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
        echo "Please install the missing tools and try again."
        echo ""
        echo "On Ubuntu/Debian:"
        echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose git openssl curl"
        echo ""
        echo "On macOS:"
        echo "  brew install docker docker-compose git openssl curl"
        echo ""
        exit 1
    fi
    
    # Check if Docker is running
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker daemon is not running"
        echo ""
        echo "Please start Docker and try again:"
        echo "  sudo systemctl start docker"
        echo "  # or on macOS: open Docker Desktop"
        exit 1
    fi
    log_success "Docker daemon is running"
}

# Clone or update repository
setup_repository() {
    log_step "Setting Up Repository"
    
    if [ -d "$INSTALL_DIR" ]; then
        log_warning "Installation directory already exists: $INSTALL_DIR"
        
        # Check if it's a valid installation
        if [ -f "$INSTALL_DIR/docker-compose.yml" ] || [ -f "$INSTALL_DIR/docker-compose.user.yml" ]; then
            log_info "Existing installation found. Updating..."
            cd "$INSTALL_DIR"
            git fetch origin "$BRANCH" 2>/dev/null || true
            git reset --hard "origin/$BRANCH" 2>/dev/null || true
            log_success "Repository updated"
        else
            log_error "Directory exists but is not a valid Musical installation"
            log_error "Please remove or backup the directory and try again:"
            log_error "  rm -rf $INSTALL_DIR"
            exit 1
        fi
    else
        log_info "Cloning repository..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        
        # Move local-server contents to root if needed
        if [ -d "local-server" ] && [ ! -f "docker-compose.yml" ]; then
            shopt -s dotglob
            mv local-server/* . 2>/dev/null || true
            rm -rf local-server
            shopt -u dotglob
        fi
        
        log_success "Repository cloned to $INSTALL_DIR"
    fi
    
    cd "$INSTALL_DIR"
}

# Generate unique credentials
generate_credentials() {
    log_step "Generating Secure Credentials"
    
    local env_file="$INSTALL_DIR/.env"
    local secrets_dir="$HOME/.musical/secrets"
    
    # Create secrets directory
    mkdir -p "$secrets_dir"
    chmod 700 "$secrets_dir"
    
    # Generate unique credentials
    DB_PASSWORD=$(generate_password 32)
    GITEA_ADMIN_PASSWORD=$(generate_password 24)
    GITEA_SECRET_KEY=$(generate_secret 64)
    ENCRYPTION_KEY=$(generate_secret 32)
    
    log_info "Generated secure database password"
    log_info "Generated secure Gitea admin password"
    log_info "Generated secure Gitea secret key"
    log_info "Generated secure encryption key"
    
    # Create .env file
    cat > "$env_file" << EOF
# Musical.run Local Server Configuration
# Generated: $(date -Iseconds)
# 
# ⚠️  SECURITY: This file contains sensitive credentials.
#     Do not share or commit this file to version control.
#

# Ports
MUSICAL_PORT=${MUSICAL_PORT}
GITEA_PORT=${GITEA_PORT}
GITEA_SSH_PORT=2222

# Database credentials (auto-generated, unique to this installation)
DB_PASSWORD=${DB_PASSWORD}

# Gitea admin credentials (auto-generated)
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=${GITEA_ADMIN_PASSWORD}
GITEA_SECRET_KEY=${GITEA_SECRET_KEY}

# Encryption key for secure communication
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# Auto-setup (enables automatic Gitea configuration)
AUTO_SETUP=true

# Optional: Add your Anthropic API key here if you don't use Claude Code CLI auth
# ANTHROPIC_API_KEY=your_api_key_here
EOF
    
    chmod 600 "$env_file"
    log_success "Credentials saved to $env_file"
    
    # Save credentials to secrets directory for reference
    cat > "$secrets_dir/install-credentials.json" << EOF
{
    "generated_at": "$(date -Iseconds)",
    "install_dir": "$INSTALL_DIR",
    "db_password": "$DB_PASSWORD",
    "gitea_admin_user": "musical",
    "gitea_admin_password": "$GITEA_ADMIN_PASSWORD",
    "ports": {
        "musical": $MUSICAL_PORT,
        "gitea": $GITEA_PORT
    }
}
EOF
    chmod 600 "$secrets_dir/install-credentials.json"
    log_success "Credentials backed up to $secrets_dir/install-credentials.json"
}

# Build Docker images
build_images() {
    log_step "Building Docker Images"
    
    cd "$INSTALL_DIR"
    
    log_info "Building local server image (this may take a few minutes)..."
    docker build -t local-server-musical-local-server:latest . 2>&1 | tail -20
    
    log_success "Docker images built successfully"
}

# Start services
start_services() {
    log_step "Starting Services"
    
    cd "$INSTALL_DIR"
    
    # Determine which docker-compose command to use
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi
    
    # Use docker-compose.user.yml if it exists, otherwise use docker-compose.yml
    if [ -f "docker-compose.user.yml" ]; then
        COMPOSE_FILE="docker-compose.user.yml"
    else
        COMPOSE_FILE="docker-compose.yml"
    fi
    
    log_info "Starting services with $COMPOSE_FILE..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    
    log_success "Services started"
}

# Wait for services to be ready
wait_for_services() {
    log_step "Waiting for Services to Initialize"
    
    local max_attempts=60
    local attempt=0
    
    # Wait for PostgreSQL
    log_info "Waiting for PostgreSQL..."
    while [ $attempt -lt $max_attempts ]; do
        if docker exec musical-postgres pg_isready -U musical >/dev/null 2>&1; then
            log_success "PostgreSQL is ready"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "PostgreSQL did not become ready in time"
        exit 1
    fi
    
    # Wait for Gitea
    log_info "Waiting for Gitea..."
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:${GITEA_PORT}/api/v1/version" >/dev/null 2>&1; then
            local version=$(curl -s "http://localhost:${GITEA_PORT}/api/v1/version" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
            log_success "Gitea is ready (version: $version)"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "Gitea did not become ready in time"
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
        log_error "Local Server did not become ready in time"
        exit 1
    fi
}

# Configure Gitea automatically
configure_gitea() {
    log_step "Configuring Gitea"
    
    local gitea_container="musical-gitea"
    local admin_user="musical"
    local admin_password="$GITEA_ADMIN_PASSWORD"
    local secrets_dir="$HOME/.musical/secrets"
    
    # Check if user already exists
    local user_exists=$(docker exec -u git "$gitea_container" sh -c "gitea admin user list 2>&1 | grep -w '$admin_user' | wc -l" 2>/dev/null || echo "0")
    
    if [ "$user_exists" -gt 0 ]; then
        log_info "Admin user already exists, updating password..."
        docker exec -u git "$gitea_container" sh -c "gitea admin user change-password --username '$admin_user' --password '$admin_password'" 2>/dev/null || true
    else
        log_info "Creating Gitea admin user..."
        docker exec -u git "$gitea_container" sh -c "gitea admin user create --username '$admin_user' --password '$admin_password' --email 'admin@musical.local' --admin --must-change-password=false 2>&1" || {
            log_warning "Could not create admin user via CLI"
        }
    fi
    
    # Generate API token
    log_info "Generating Gitea API token..."
    local token_name="musical-local-$(date +%s)"
    
    local response=$(curl -s -X POST "http://localhost:${GITEA_PORT}/api/v1/users/$admin_user/tokens" \
        -u "$admin_user:$admin_password" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$token_name\", \"scopes\": [\"write:repository\", \"write:user\", \"write:organization\"]}")
    
    local token=$(echo "$response" | grep -o '"sha1":"[^"]*"' | cut -d'"' -f4)
    
    if [ -z "$token" ]; then
        log_warning "Could not generate API token automatically"
        log_info "Gitea will be configured on first server restart"
    else
        log_success "Gitea API token generated"
        
        # Save credentials
        mkdir -p "$secrets_dir"
        cat > "$secrets_dir/gitea-credentials.json" << EOF
{
    "url": "http://gitea:3000",
    "username": "$admin_user",
    "token": "$token",
    "password": "$admin_password",
    "organization": "musical"
}
EOF
        chmod 600 "$secrets_dir/gitea-credentials.json"
        
        # Update .env with token
        if [ -f "$INSTALL_DIR/.env" ]; then
            echo "" >> "$INSTALL_DIR/.env"
            echo "# Gitea API Token (auto-generated)" >> "$INSTALL_DIR/.env"
            echo "GITEA_TOKEN=$token" >> "$INSTALL_DIR/.env"
        fi
        
        log_success "Gitea credentials saved"
    fi
}

# Restart local server to pick up new configuration
restart_local_server() {
    log_info "Restarting local server to apply configuration..."
    
    cd "$INSTALL_DIR"
    
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi
    
    if [ -f "docker-compose.user.yml" ]; then
        COMPOSE_FILE="docker-compose.user.yml"
    else
        COMPOSE_FILE="docker-compose.yml"
    fi
    
    $COMPOSE_CMD -f "$COMPOSE_FILE" restart musical-local 2>/dev/null || true
    
    # Wait for server to be ready again
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

# Print success message and next steps
print_success() {
    log_step "Installation Complete! 🎉"
    
    # Get server status
    local health=$(curl -s "http://localhost:${MUSICAL_PORT}/health" 2>/dev/null)
    local tunnel_url=$(echo "$health" | grep -o '"tunnelUrl":"[^"]*"' | cut -d'"' -f4)
    
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🎵  Musical.run Local Server is Ready!  🎵              ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    echo -e "${BOLD}Service URLs:${NC}"
    echo -e "  Local Server:  ${CYAN}http://localhost:${MUSICAL_PORT}${NC}"
    echo -e "  Gitea:         ${CYAN}http://localhost:${GITEA_PORT}${NC}"
    if [ -n "$tunnel_url" ]; then
        echo -e "  Tunnel URL:    ${CYAN}$tunnel_url${NC}"
    fi
    echo ""
    
    echo -e "${BOLD}Health Check:${NC}"
    echo -e "  ${CYAN}curl http://localhost:${MUSICAL_PORT}/health${NC}"
    echo ""
    
    echo -e "${BOLD}Installation Directory:${NC}"
    echo -e "  ${CYAN}$INSTALL_DIR${NC}"
    echo ""
    
    echo -e "${BOLD}Credentials:${NC}"
    echo -e "  Stored in: ${CYAN}$INSTALL_DIR/.env${NC}"
    echo -e "  Backup:    ${CYAN}$HOME/.musical/secrets/install-credentials.json${NC}"
    echo ""
    
    echo -e "${BOLD}Next Steps:${NC}"
    echo -e "  1. Open ${CYAN}https://musical.run${NC} in your browser"
    echo -e "  2. Login or create an account"
    echo -e "  3. The frontend will automatically connect to your local server"
    echo ""
    
    echo -e "${BOLD}Commands:${NC}"
    echo -e "  View logs:     ${CYAN}cd $INSTALL_DIR && docker compose logs -f${NC}"
    echo -e "  Stop server:   ${CYAN}cd $INSTALL_DIR && docker compose down${NC}"
    echo -e "  Start server:  ${CYAN}cd $INSTALL_DIR && docker compose up -d${NC}"
    echo -e "  Update:        ${CYAN}cd $INSTALL_DIR && git pull && docker compose up -d --build${NC}"
    echo ""
    
    echo -e "${YELLOW}⚠️  Security Note:${NC}"
    echo -e "  Your installation uses unique, randomly generated credentials."
    echo -e "  Keep your .env file secure and do not share it."
    echo ""
}

# Cleanup on error
cleanup_on_error() {
    log_error "Installation failed!"
    echo ""
    echo "To troubleshoot:"
    echo "  1. Check Docker logs: docker logs musical-local"
    echo "  2. Check if ports are in use: netstat -tlnp | grep -E '(17100|17101|17102)'"
    echo "  3. Try running the installer again"
    echo ""
    echo "To clean up and start fresh:"
    echo "  cd $INSTALL_DIR && docker compose down -v"
    echo "  rm -rf $INSTALL_DIR"
    echo ""
}

# Main installation flow
main() {
    trap cleanup_on_error ERR
    
    print_banner
    
    log_info "Installation directory: $INSTALL_DIR"
    log_info "Ports: Musical=$MUSICAL_PORT, Gitea=$GITEA_PORT"
    echo ""
    
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

# Run main function
main "$@"
