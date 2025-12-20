#!/bin/bash
#
# PostgreSQL Multi-Database Initialization
# Creates separate databases for local-server and Gitea
#

set -e

echo "🚀 Initializing Musical.run PostgreSQL databases..."

# Create databases
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    -- Create separate databases
    CREATE DATABASE musical_local;
    CREATE DATABASE gitea;

    -- Grant permissions (using same user for simplicity)
    GRANT ALL PRIVILEGES ON DATABASE musical_local TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON DATABASE gitea TO $POSTGRES_USER;

    -- Display created databases
    \l
EOSQL

echo "✅ Created databases:"
echo "   - musical_local (local-server projects and sessions)"
echo "   - gitea (Git server data)"
