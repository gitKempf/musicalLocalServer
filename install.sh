#!/bin/bash
# Musical.run Local Server - Universal Installer
# One-command installation for Mac and Linux

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="$HOME/.musical"
REPO_URL="https://github.com/yourusername/musical-backend"
DOCKER_COMPOSE_URL="https://raw.githubusercontent.com/yourusername/musical-backend/main/local-server/docker-compose.yml"

# Utility functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="mac"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
    else
        log_error "Unsupported OS: $OSTYPE"
        exit 1
    fi
    log_info "Detected OS: $OS"
}

# Check if Docker is installed
check_docker() {
    if command -v docker &> /dev/null; then
        log_success "Docker is already installed"
        return 0
    else
        log_warning "Docker is not installed"
        return 1
    fi
}

# Install Docker
install_docker() {
    log_info "Installing Docker..."

    if [[ "$OS" == "mac" ]]; then
        if command -v brew &> /dev/null; then
            log_info "Installing Docker via Homebrew..."
            brew install --cask docker
            log_success "Docker installed. Please start Docker Desktop manually."
            log_warning "After Docker Desktop starts, run this installer again."
            exit 0
        else
            log_error "Homebrew not found. Please install Docker Desktop manually from https://www.docker.com/products/docker-desktop"
            exit 1
        fi
    elif [[ "$OS" == "linux" ]]; then
        log_info "Installing Docker via official script..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        sudo sh get-docker.sh
        sudo usermod -aG docker $USER
        rm get-docker.sh
        log_success "Docker installed"
        log_warning "Please log out and back in for group changes to take effect"
    fi
}

# Check if Docker Compose is installed
check_docker_compose() {
    if docker compose version &> /dev/null; then
        log_success "Docker Compose is available"
        return 0
    elif command -v docker-compose &> /dev/null; then
        log_success "Docker Compose (standalone) is available"
        return 0
    else
        log_warning "Docker Compose not found"
        return 1
    fi
}

# Create installation directory
create_install_dir() {
    log_info "Creating installation directory: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"/{data,keys,logs,config}
    log_success "Installation directory created"
}

# Download docker-compose.yml
download_compose_file() {
    log_info "Downloading docker-compose.yml..."

    # For now, copy from local directory (in production, use DOCKER_COMPOSE_URL)
    if [ -f "docker-compose.yml" ]; then
        cp docker-compose.yml "$INSTALL_DIR/docker-compose.yml"
    else
        log_error "docker-compose.yml not found"
        exit 1
    fi

    log_success "docker-compose.yml downloaded"
}

# Create .env file
create_env_file() {
    log_info "Creating .env file..."

    cat > "$INSTALL_DIR/.env" <<EOF
# Musical.run Local Server Configuration
POSTGRES_USER=musical
POSTGRES_PASSWORD=$(openssl rand -hex 32)
POSTGRES_DB=musical_local
DATABASE_URL=postgresql://musical:musical@postgres:5432/musical_local

# Gitea Configuration
GITEA_ADMIN_USER=musical
GITEA_ADMIN_PASSWORD=$(openssl rand -hex 16)
GITEA_ADMIN_EMAIL=admin@musical.local

# Local Server Configuration
LOCAL_SERVER_PORT=17100
NODE_ENV=production

# OAuth Configuration (will be filled after first login)
MUSICAL_ACCESS_TOKEN=
MUSICAL_REFRESH_TOKEN=
MUSICAL_USER_ID=
EOF

    log_success ".env file created"
}

# Create CLI wrapper
create_cli_wrapper() {
    log_info "Creating CLI wrapper..."

    cat > "$INSTALL_DIR/musical-server" <<'CLI_EOF'
#!/bin/bash
# Musical.run Local Server CLI

INSTALL_DIR="$HOME/.musical"
cd "$INSTALL_DIR"

case "$1" in
    start)
        echo "🚀 Starting Musical.run Local Server..."
        docker compose up -d
        echo "✓ Local server started"
        echo "  Health: http://localhost:17100/health"
        echo "  Terminal: http://localhost:17100/terminal.html"
        ;;
    stop)
        echo "🛑 Stopping Musical.run Local Server..."
        docker compose down
        echo "✓ Local server stopped"
        ;;
    restart)
        echo "🔄 Restarting Musical.run Local Server..."
        docker compose restart
        echo "✓ Local server restarted"
        ;;
    logs)
        docker compose logs -f "${2:-}"
        ;;
    status)
        docker compose ps
        ;;
    update)
        echo "📦 Updating Musical.run Local Server..."
        docker compose pull
        docker compose up -d
        echo "✓ Local server updated"
        ;;
    cleanup)
        echo "🧹 Cleaning up old Docker images..."
        docker system prune -f
        echo "✓ Cleanup complete"
        ;;
    *)
        echo "Musical.run Local Server CLI"
        echo ""
        echo "Usage: musical-server <command>"
        echo ""
        echo "Commands:"
        echo "  start     Start the local server"
        echo "  stop      Stop the local server"
        echo "  restart   Restart the local server"
        echo "  logs      View logs (optional: service name)"
        echo "  status    Show service status"
        echo "  update    Update to latest version"
        echo "  cleanup   Clean up old Docker images"
        echo ""
        echo "Examples:"
        echo "  musical-server start"
        echo "  musical-server logs musical-local"
        echo "  musical-server status"
        ;;
esac
CLI_EOF

    chmod +x "$INSTALL_DIR/musical-server"
    log_success "CLI wrapper created"
}

# Create symlink to make CLI globally accessible
create_symlink() {
    log_info "Creating global symlink..."

    # Determine bin directory
    if [[ "$OS" == "mac" ]]; then
        BIN_DIR="/usr/local/bin"
    else
        BIN_DIR="$HOME/.local/bin"
        mkdir -p "$BIN_DIR"
    fi

    # Create symlink
    if [[ -L "$BIN_DIR/musical-server" ]]; then
        rm "$BIN_DIR/musical-server"
    fi

    if [[ "$OS" == "mac" ]] || [[ -w "$BIN_DIR" ]]; then
        ln -s "$INSTALL_DIR/musical-server" "$BIN_DIR/musical-server"
        log_success "Symlink created at $BIN_DIR/musical-server"
    else
        sudo ln -s "$INSTALL_DIR/musical-server" "$BIN_DIR/musical-server"
        log_success "Symlink created at $BIN_DIR/musical-server (required sudo)"
    fi

    # Add to PATH if needed
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        log_warning "Add $BIN_DIR to your PATH by adding this to ~/.bashrc or ~/.zshrc:"
        echo "  export PATH=\"\$PATH:$BIN_DIR\""
    fi
}

# Pull Docker images
pull_images() {
    log_info "Pulling Docker images..."
    cd "$INSTALL_DIR"
    docker compose pull || log_warning "Some images may need to be built locally"
    log_success "Docker images ready"
}

# Start services
start_services() {
    log_info "Starting services..."
    cd "$INSTALL_DIR"
    docker compose up -d
    log_success "Services started"
}

# Wait for health check
wait_for_health() {
    log_info "Waiting for services to be healthy..."

    for i in {1..30}; do
        if curl -sf http://localhost:17100/health > /dev/null 2>&1; then
            log_success "Local server is healthy"
            return 0
        fi
        sleep 2
    done

    log_warning "Health check timed out (services may still be starting)"
}

# Print next steps
print_next_steps() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}✓ Installation Complete!${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🎵 Musical.run Local Server is now installed and running!"
    echo ""
    echo -e "${BLUE}Installation Directory:${NC} $INSTALL_DIR"
    echo ""
    echo -e "${BLUE}Available Commands:${NC}"
    echo "  musical-server start       # Start the local server"
    echo "  musical-server stop        # Stop the local server"
    echo "  musical-server restart     # Restart the local server"
    echo "  musical-server logs        # View logs"
    echo "  musical-server status      # Check status"
    echo ""
    echo -e "${BLUE}Service URLs:${NC}"
    echo "  Health:   http://localhost:17100/health"
    echo "  Terminal: http://localhost:17100/terminal.html"
    echo "  Gitea:    http://localhost:3000"
    echo ""
    echo -e "${BLUE}Next Steps:${NC}"
    echo "  1. Open Musical.run mobile app"
    echo "  2. Tap 'Connect Local Server' in settings"
    echo "  3. Follow OAuth flow to authenticate"
    echo "  4. Start generating apps with Claude!"
    echo ""
    echo -e "${YELLOW}Note:${NC} Your OAuth credentials are stored in $INSTALL_DIR/.env"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Main installation flow
main() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}🎵 Musical.run Local Server Installer${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Detect OS
    detect_os

    # Check and install Docker if needed
    if ! check_docker; then
        install_docker
    fi

    # Check Docker Compose
    if ! check_docker_compose; then
        log_error "Docker Compose not available. Please install Docker Desktop or docker-compose."
        exit 1
    fi

    # Create installation directory
    create_install_dir

    # Download configuration files
    download_compose_file
    create_env_file

    # Create CLI tools
    create_cli_wrapper
    create_symlink

    # Pull and start services
    pull_images
    start_services
    wait_for_health

    # Print next steps
    print_next_steps
}

# Run installer
main
