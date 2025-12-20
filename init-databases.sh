#!/bin/bash
#
# PostgreSQL Multi-Database Initialization
# Creates databases for local-server and Gitea
# Supports both shared user (simple) and separate user (advanced) configurations
#

set -e

echo "🚀 Initializing Musical.run PostgreSQL databases..."

# Get configuration from environment
DB_USER="${POSTGRES_USER:-musical}"
GITEA_DB_USER="${GITEA_DB_USER:-$DB_USER}"
GITEA_DB_NAME="${GITEA_DB_NAME:-gitea}"

# Create databases
psql -v ON_ERROR_STOP=1 --username "$DB_USER" <<-EOSQL
    -- Create local-server database
    CREATE DATABASE musical_local;
    GRANT ALL PRIVILEGES ON DATABASE musical_local TO $DB_USER;

    -- Create gitea database
    CREATE DATABASE $GITEA_DB_NAME;
    GRANT ALL PRIVILEGES ON DATABASE $GITEA_DB_NAME TO $GITEA_DB_USER;

    -- Display created databases
    \l
EOSQL

# If Gitea uses a separate user, create it
if [ "$GITEA_DB_USER" != "$DB_USER" ]; then
    echo "Creating separate Gitea database user..."
    psql -v ON_ERROR_STOP=1 --username "$DB_USER" <<-EOSQL
        -- Create gitea user if different from main user
        DO \$\$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$GITEA_DB_USER') THEN
                CREATE USER $GITEA_DB_USER WITH PASSWORD '${GITEA_DB_PASSWORD:-gitea_pass}';
            END IF;
        END
        \$\$;
        
        GRANT ALL PRIVILEGES ON DATABASE $GITEA_DB_NAME TO $GITEA_DB_USER;
        
        -- Grant schema permissions
        \c $GITEA_DB_NAME
        GRANT ALL ON SCHEMA public TO $GITEA_DB_USER;
EOSQL
fi

echo "✅ Created databases:"
echo "   - musical_local (local-server projects and sessions)"
echo "   - $GITEA_DB_NAME (Git server data)"
echo "✅ Database user: $GITEA_DB_USER"
