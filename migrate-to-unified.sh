#!/bin/bash
#
# Migrate to Unified Configuration
#
# This script:
# 1. Backs up old configuration files
# 2. Makes docker-compose.unified.yml the default
# 3. Makes install-unified.sh the default install script
# 4. Installs the new CLI tool
#

set -e

cd "$(dirname "$0")"

echo "🔄 Migrating to unified configuration..."

# Backup old files
BACKUP_DIR=".backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "📦 Backing up old configuration files to $BACKUP_DIR/"

# Backup and remove old docker-compose files
for file in docker-compose.yml docker-compose.user.yml docker-compose.instance.yml; do
    if [ -f "$file" ]; then
        mv "$file" "$BACKUP_DIR/"
        echo "  Backed up: $file"
    fi
done

# Backup and remove old install scripts
for file in install.sh install-instance.sh; do
    if [ -f "$file" ]; then
        mv "$file" "$BACKUP_DIR/"
        echo "  Backed up: $file"
    fi
done

# Make unified files the default
echo ""
echo "📝 Setting up new configuration..."

if [ -f "docker-compose.unified.yml" ]; then
    cp docker-compose.unified.yml docker-compose.yml
    echo "  Created: docker-compose.yml (from unified)"
fi

if [ -f "install-unified.sh" ]; then
    cp install-unified.sh install.sh
    chmod +x install.sh
    echo "  Created: install.sh (from unified)"
fi

# Install CLI
echo ""
echo "🔧 Installing CLI tool..."

if [ -d "cli" ] && command -v npm &>/dev/null; then
    cd cli
    npm install --silent
    npm run build --silent
    
    # Create global symlink
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    
    cat > "$BIN_DIR/musical" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")/local-server/cli"
if [ -f "$CLI_DIR/dist/cli.js" ]; then
    node "$CLI_DIR/dist/cli.js" "$@"
else
    # Fallback to the old bash script
    "$(dirname "$SCRIPT_DIR")/local-server/musical" "$@"
fi
EOF
    chmod +x "$BIN_DIR/musical"
    
    echo "  Installed: musical CLI"
    echo ""
    echo "  Add to your shell profile:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    cd ..
else
    # Use bash script as fallback
    if [ -f "musical" ]; then
        BIN_DIR="$HOME/.local/bin"
        mkdir -p "$BIN_DIR"
        cp musical "$BIN_DIR/musical"
        chmod +x "$BIN_DIR/musical"
        echo "  Installed: musical CLI (bash version)"
    fi
fi

echo ""
echo "✅ Migration complete!"
echo ""
echo "What's changed:"
echo "  - Single docker-compose.yml with multi-instance support"
echo "  - Single install.sh script"
echo "  - New 'musical' CLI with interactive UI"
echo ""
echo "Next steps:"
echo "  1. Run 'musical' for interactive management"
echo "  2. Or 'musical list' to see instances"
echo "  3. Old files are in $BACKUP_DIR/"
echo ""
