#!/bin/bash
#
# Musical.run Local Server - Unified Installer
#
# Single installation script with multi-instance support.
# This is the ONLY install script needed.
#
# Usage:
#   # Default installation
#   curl -fsSL https://musical.run/install.sh | bash
#
#   # Named instance
#   curl -fsSL https://musical.run/install.sh | bash -s -- --instance work --port 18100
#
#   # Interactive mode
#   curl -fsSL https://musical.run/install.sh | bash -s -- --interactive
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Configuration
INSTANCE_ID="${INSTANCE_ID:-default}"
INSTANCE_NAME="${INSTANCE_NAME:-Local Server}"
INSTALL_DIR="${INSTALL_DIR:-}"
MUSICAL_PORT="${MUSICAL_PORT:-17100}"
GITEA_PORT="${GITEA_PORT:-17101}"
GITEA_SSH_PORT="${GITEA_SSH_PORT:-2222}"
REPO_URL="${REPO_URL:-https://github.com/gitKempf/musicalLocalServer.git}"
BRANCH="${BRANCH:-master}"
INTERACTIVE="${INTERACTIVE:-false}"

# Parse arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --instance|-i)
                INSTANCE_ID="$2"
                shift 2
                ;;
            --name|-n)
                INSTANCE_NAME="$2"
                shift 2
                ;;
            --dir|-d)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --port|-p)
                MUSICAL_PORT="$2"
                GITEA_PORT=$((MUSICAL_PORT + 1))
                GITEA_SSH_PORT=$((MUSICAL_PORT + 100))
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
            --interactive)
                INTERACTIVE=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

show_help() {
    cat << EOF
Musical.run Local Server - Unified Installer

Usage: install.sh [OPTIONS]

Options:
  --instance, -i ID     Instance identifier (default: default)
  --name, -n NAME       Human-readable name
  --dir, -d DIR         Installation directory
  --port, -p PORT       Main server port (default: 17100)
  --gitea-port PORT     Gitea HTTP port (default: port+1)
  --branch, -b BRANCH   Git branch (default: master)
  --interactive         Run interactive wizard
  --help, -h            Show this help

Examples:
  # Default installation
  ./install.sh
  
  # Named instance for work
  ./install.sh --instance work --port 18100
  
  # Custom installation
  ./install.sh --instance office --name "Office Server" --port 19100

Multi-Instance:
  Each instance is fully isolated with its own:
  - Docker network (musical-network-<instance>)
  - Containers (musical-*-<instance>)
  - Volumes (musical-*-<instance>)
  - Port range
EOF
}

# Logging
log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✅${NC} $1"; }
log_warning() { echo -e "${YELLOW}⚠️${NC} $1"; }
log_error() { echo -e "${RED}❌${NC} $1"; }
log_step() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}\n"; }

# Generate secure random string
generate_secret() {
    local length=${1:-32}
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# Banner
print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🎵  Musical.run Local Server Installer  🎵              ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking Prerequisites"
    
    local missing=()
    
    if command -v docker &>/dev/null; then
        log_success "Docker installed"
    else
        missing+=("docker")
        log_error "Docker not found"
    fi
    
    if docker compose version &>/dev/null || command -v docker-compose &>/dev/null; then
        log_success "Docker Compose installed"
    else
        missing+=("docker-compose")
        log_error "Docker Compose not found"
    fi
    
    if command -v git &>/dev/null; then
        log_success "Git installed"
    else
        missing+=("git")
        log_error "Git not found"
    fi
    
    if command -v openssl &>/dev/null; then
        log_success "OpenSSL installed"
    else
        missing+=("openssl")
        log_error "OpenSSL not found"
    fi
    
    if command -v node &>/dev/null; then
        log_success "Node.js installed"
    else
        log_warning "Node.js not found (optional, for CLI tool)"
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required tools: ${missing[*]}"
        exit 1
    fi
    
    if ! docker info &>/dev/null; then
        log_error "Docker daemon is not running"
        exit 1
    fi
    log_success "Docker daemon is running"
}

# Check for port conflicts
check_ports() {
    log_step "Checking Port Availability"
    
    local ports_in_use=()
    
    for port in $MUSICAL_PORT $GITEA_PORT $GITEA_SSH_PORT; do
        if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
           netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
            ports_in_use+=($port)
        fi
    done
    
    if [ ${#ports_in_use[@]} -gt 0 ]; then
        log_error "Ports in use: ${ports_in_use[*]}"
        log_info "Use --port to specify a different base port"
        exit 1
    fi
    
    log_success "Ports $MUSICAL_PORT, $GITEA_PORT, $GITEA_SSH_PORT are available"
}

# Setup installation directory
setup_directory() {
    log_step "Setting Up Installation Directory"
    
    if [ -z "$INSTALL_DIR" ]; then
        if [ "$INSTANCE_ID" = "default" ]; then
            INSTALL_DIR="$HOME/musical-local-server"
        else
            INSTALL_DIR="$HOME/musical-local-server-${INSTANCE_ID}"
        fi
    fi
    
    if [ -d "$INSTALL_DIR" ]; then
        log_warning "Directory exists: $INSTALL_DIR"
        if [ -f "$INSTALL_DIR/docker-compose.unified.yml" ]; then
            log_info "Updating existing installation..."
            cd "$INSTALL_DIR"
            git fetch origin
            git reset --hard origin/$BRANCH
        else
            log_error "Directory exists but is not a valid installation"
            exit 1
        fi
    else
        log_info "Cloning repository..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    fi
    
    cd "$INSTALL_DIR"
    
    # Handle repository structure
    if [ -d "local-server" ] && [ ! -f "docker-compose.unified.yml" ]; then
        log_info "Adjusting repository structure..."
        shopt -s dotglob
        mv local-server/* . 2>/dev/null || true
        rm -rf local-server
        shopt -u dotglob
    fi
    
    log_success "Installation directory: $INSTALL_DIR"
}

# Generate credentials
generate_credentials() {
    log_step "Generating Secure Credentials"
    
    local config_dir="$HOME/.musical/instances/${INSTANCE_ID}"
    mkdir -p "$config_dir"
    chmod 700 "$HOME/.musical"
    chmod 700 "$config_dir"
    
    # Generate secrets
    DB_PASSWORD=$(generate_secret 32)
    GITEA_ADMIN_PASSWORD=$(generate_secret 24)
    GITEA_SECRET_KEY=$(generate_secret 64)
    ENCRYPTION_KEY=$(generate_secret 32)
    
    # Create .env file
    cat > "$INSTALL_DIR/.env" << EOF
# Musical.run Local Server Configuration
# Instance: ${INSTANCE_ID}
# Generated: $(date -Iseconds)

# Instance
INSTANCE_ID=${INSTANCE_ID}
INSTANCE_NAME=${INSTANCE_NAME}

# Ports
MUSICAL_PORT=${MUSICAL_PORT}
GITEA_PORT=${GITEA_PORT}
GITEA_SSH_PORT=${GITEA_SSH_PORT}

# Database
DB_PASSWORD=${DB_PASSWORD}

# Gitea
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=${GITEA_ADMIN_PASSWORD}
GITEA_SECRET_KEY=${GITEA_SECRET_KEY}

# Security
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# Cloud Connection
TUNNEL_ENABLED=true
TUNNEL_ROUTER_URL=https://musical.run
AUTH_SERVICE_URL=https://musical.run

# Auto-setup
AUTO_SETUP=true
AUTO_AUTH_ENABLED=false

# Optional: Anthropic API Key
# ANTHROPIC_API_KEY=
EOF
    
    chmod 600 "$INSTALL_DIR/.env"
    
    # Save config JSON
    cat > "$config_dir/config.json" << EOF
{
  "instanceId": "${INSTANCE_ID}",
  "instanceName": "${INSTANCE_NAME}",
  "musicalPort": ${MUSICAL_PORT},
  "giteaPort": ${GITEA_PORT},
  "giteaSshPort": ${GITEA_SSH_PORT},
  "installDir": "${INSTALL_DIR}",
  "createdAt": "$(date -Iseconds)"
}
EOF
    chmod 600 "$config_dir/config.json"
    
    log_success "Credentials generated and saved"
}

# Build Docker images
build_images() {
    log_step "Building Docker Images"
    
    cd "$INSTALL_DIR"
    
    log_info "Building local server image..."
    docker build -t "musical-local-server:${INSTANCE_ID}" . 2>&1 | tail -5
    
    if [ -d "claude-agent" ]; then
        log_info "Building Claude agent image..."
        docker build -t "musical-claude-agent:${INSTANCE_ID}" ./claude-agent 2>&1 | tail -5
    fi
    
    log_success "Docker images built"
}

# Start services
start_services() {
    log_step "Starting Services"
    
    cd "$INSTALL_DIR"
    
    # Determine compose command
    if docker compose version &>/dev/null; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi
    
    local compose_file="docker-compose.yml"
    
    log_info "Starting with $compose_file..."
    export INSTANCE_ID
    $COMPOSE_CMD -f "$compose_file" --project-name "musical-${INSTANCE_ID}" up -d
    
    log_success "Services started"
}

# Wait for services
wait_for_services() {
    log_step "Waiting for Services"
    
    local max_attempts=60
    local attempt=0
    
    # Wait for PostgreSQL
    log_info "Waiting for PostgreSQL..."
    while [ $attempt -lt $max_attempts ]; do
        if docker exec "musical-postgres-${INSTANCE_ID}" pg_isready -U musical &>/dev/null; then
            log_success "PostgreSQL is ready"
            break
        fi
        sleep 2
        ((attempt++))
    done
    
    # Wait for Local Server
    log_info "Waiting for Local Server..."
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:${MUSICAL_PORT}/health" &>/dev/null; then
            log_success "Local Server is ready"
            break
        fi
        sleep 2
        ((attempt++))
    done
    
    if [ $attempt -eq $max_attempts ]; then
        log_warning "Services may still be starting..."
    fi
}

# Install CLI tool
install_cli() {
    log_step "Installing CLI Tool"
    
    cd "$INSTALL_DIR"
    
    local bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
    
    if [ -d "cli" ] && command -v npm &>/dev/null; then
        log_info "Building CLI..."
        cd cli
        npm install --silent
        npm run build --silent
        
        # Create wrapper script
        cat > "$bin_dir/musical" << EOF
#!/bin/bash
node "$INSTALL_DIR/cli/dist/cli.js" "\$@"
EOF
        chmod +x "$bin_dir/musical"
        
        log_success "CLI installed: musical"
        cd ..
    else
        # Use bash script as fallback
        if [ -f "$INSTALL_DIR/musical" ]; then
            cp "$INSTALL_DIR/musical" "$bin_dir/musical"
            chmod +x "$bin_dir/musical"
            log_success "CLI installed (bash version)"
        fi
    fi
    
    # Add to PATH in shell profile if not already there
    add_to_path "$bin_dir"
}

# Add directory to PATH in shell profile
add_to_path() {
    local dir="$1"
    local shell_profile=""
    
    # Determine shell profile
    if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
        shell_profile="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
        shell_profile="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
        shell_profile="$HOME/.bash_profile"
    elif [ -f "$HOME/.profile" ]; then
        shell_profile="$HOME/.profile"
    fi
    
    if [ -n "$shell_profile" ]; then
        # Check if already in profile
        if ! grep -q "/.local/bin" "$shell_profile" 2>/dev/null; then
            echo '' >> "$shell_profile"
            echo '# Musical.run CLI' >> "$shell_profile"
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_profile"
            log_success "Added ~/.local/bin to PATH in $shell_profile"
            log_info "Run 'source $shell_profile' or restart your terminal"
        fi
    fi
}

# Print success message
print_success() {
    log_step "Installation Complete! 🎉"
    
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║     🎵  Musical.run Local Server is Ready!  🎵              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    echo -e "${BOLD}Instance:${NC}"
    echo -e "  ID:            ${CYAN}${INSTANCE_ID}${NC}"
    echo -e "  Name:          ${INSTANCE_NAME}"
    echo ""
    
    echo -e "${BOLD}URLs:${NC}"
    echo -e "  Local Server:  ${CYAN}http://localhost:${MUSICAL_PORT}${NC}"
    echo -e "  Gitea:         ${CYAN}http://localhost:${GITEA_PORT}${NC}"
    echo ""
    
    echo -e "${BOLD}Installation:${NC}"
    echo -e "  Directory:     ${INSTALL_DIR}"
    echo -e "  Config:        $HOME/.musical/instances/${INSTANCE_ID}/"
    echo ""
    
    echo -e "${BOLD}Commands:${NC}"
    echo -e "  ${CYAN}musical${NC}              Interactive UI"
    echo -e "  ${CYAN}musical list${NC}         List instances"
    echo -e "  ${CYAN}musical status${NC}       Show status"
    echo -e "  ${CYAN}musical auth login${NC}   Authenticate"
    echo ""
    
    echo -e "${YELLOW}Next Step:${NC} Authenticate your server:"
    echo -e "  ${CYAN}musical auth login ${INSTANCE_ID}${NC}"
    echo ""
}

# Cleanup on error
cleanup_on_error() {
    log_error "Installation failed!"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check Docker logs: docker logs musical-local-${INSTANCE_ID}"
    echo "  2. Check ports: ss -tlnp | grep -E '(${MUSICAL_PORT}|${GITEA_PORT})'"
    echo "  3. Retry installation"
    echo ""
}

# Main
main() {
    trap cleanup_on_error ERR
    
    parse_args "$@"
    
    print_banner
    
    log_info "Instance: $INSTANCE_ID"
    log_info "Ports: Server=$MUSICAL_PORT, Gitea=$GITEA_PORT"
    
    if [ "$INTERACTIVE" = true ] && command -v node &>/dev/null; then
        # Use interactive wizard
        cd "$INSTALL_DIR" 2>/dev/null || {
            # Need to clone first for CLI
            setup_directory
        }
        if [ -d "cli" ]; then
            cd cli
            npm install --silent 2>/dev/null
            npm run build --silent 2>/dev/null
            node dist/cli.js install
            exit 0
        fi
    fi
    
    check_prerequisites
    check_ports
    setup_directory
    generate_credentials
    build_images
    start_services
    wait_for_services
    install_cli
    print_success
}

main "$@"
