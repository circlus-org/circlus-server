#!/bin/bash
# Destructive local database reset for Circlus Server.
# Drops and recreates a local PostgreSQL database, then applies all migrations.

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================="
echo "Circlus Server - Reset Local Database"
echo "========================================="
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}ERROR: DATABASE_URL not set${NC}"
    echo ""
    echo "Please set DATABASE_URL environment variable:"
    echo "  export DATABASE_URL='postgresql://user:pass@localhost:5432/family_messenger'"
    echo ""
    exit 1
fi

# This repo is deployed as a single VPS setup: Postgres runs locally on the same machine.
# The usual and simplest approach is:
# - run admin operations (drop/create db, create role, create extensions) as Postgres superuser
# - run migrations as the app role (DATABASE_URL)
#
# Therefore this script assumes local Postgres and requires sudo access.

# Extract database name from URL
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p')
echo "Database name: $DB_NAME"
echo ""

# Extract DB user + password from DATABASE_URL.
# Examples:
# - postgresql://user:pass@localhost:5432/db -> user / pass
# - postgresql://user@localhost:5432/db -> user / (empty)
DB_USER=$(echo "$DATABASE_URL" | sed -n -E 's|^postgres(ql)?://([^:/@?]+).*$|\2|p')
DB_PASSWORD=$(echo "$DATABASE_URL" | sed -n -E 's|^postgres(ql)?://[^:/@?]+:([^@/?#]+)@.*$|\2|p')

if [ -z "$DB_USER" ]; then
    echo -e "${RED}ERROR: Could not parse database user from DATABASE_URL.${NC}"
    echo "Expected format: postgresql://user:pass@localhost:5432/$DB_NAME"
    exit 1
fi

if [ -z "$DB_PASSWORD" ]; then
    echo -e "${RED}ERROR: Could not parse database password from DATABASE_URL.${NC}"
    echo "Expected format: postgresql://$DB_USER:pass@localhost:5432/$DB_NAME"
    echo "(Migrations use psql over TCP and need a password in DATABASE_URL.)"
    exit 1
fi

DB_USER_IDENT=""
DB_USER_IDENT="\"${DB_USER//\"/\"\"}\""

# Ask for confirmation
read -p "DESTRUCTIVE: this will DROP and recreate database '$DB_NAME'. Continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "========================================="
echo "Step 1: Drop existing database (if exists)"
echo "========================================="

# Quote identifier for safety
DB_IDENT="\"${DB_NAME//\"/\"\"}\""

# SQL-safe literals (single-quoted)
DB_NAME_LIT="${DB_NAME//\'/\'\'}"
DB_USER_LIT="${DB_USER//\'/\'\'}"
DB_PASS_LIT="${DB_PASSWORD//\'/\'\'}"

require_local_postgres_admin() {
    if ! command -v sudo >/dev/null 2>&1; then
        echo -e "${RED}ERROR: sudo not found. This script expects local Postgres admin access via sudo.${NC}"
        exit 1
    fi

    if ! sudo -u postgres psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
        echo -e "${RED}ERROR: Cannot run 'psql' as OS user 'postgres'.${NC}"
        echo "Make sure Postgres is installed locally and your user can run:"
        echo "  sudo -u postgres psql -d postgres"
        exit 1
    fi
}

ensure_role() {
    sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER_LIT') THEN
    CREATE ROLE $DB_USER_IDENT LOGIN PASSWORD '$DB_PASS_LIT';
  ELSE
    ALTER ROLE $DB_USER_IDENT LOGIN PASSWORD '$DB_PASS_LIT';
  END IF;
END
\$\$;
SQL
}

drop_db() {
    # Prefer FORCE (PG13+). If unsupported, fall back to terminating connections.
    if ! sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_IDENT WITH (FORCE);" >/dev/null 2>&1; then
        sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$DB_NAME_LIT'
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS $DB_IDENT;
SQL
    fi
}

create_db() {
    sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_IDENT OWNER $DB_USER_IDENT;" >/dev/null
}

create_extensions() {
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" >/dev/null
}

fix_schema_ownership() {
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER SCHEMA public OWNER TO $DB_USER_IDENT;
GRANT ALL ON SCHEMA public TO $DB_USER_IDENT;
SQL
}

require_local_postgres_admin

# Drop database (ignore error if doesn't exist)
echo "Dropping database '$DB_NAME'..."
drop_db
echo -e "${GREEN}✓ Database dropped (if it existed)${NC}"

echo ""
echo "========================================="
echo "Step 2: Create fresh database"
echo "========================================="

echo "Ensuring role '$DB_USER' exists (and setting password)..."
ensure_role
echo -e "${GREEN}✓ Role ready${NC}"

echo "Creating database '$DB_NAME' (owner: $DB_USER)..."
create_db
echo -e "${GREEN}✓ Database created${NC}"

echo ""
echo "========================================="
echo "Step 3: Enable required extensions"
echo "========================================="

echo "Enabling uuid-ossp extension..."
create_extensions
fix_schema_ownership
echo -e "${GREEN}✓ Extensions enabled${NC}"

echo ""
echo "========================================="
echo "Step 4: Apply migrations"
echo "========================================="

cd "$(dirname "$0")"
npm run migrate

echo ""
echo "========================================="
echo -e "${GREEN}✓ Database setup complete!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Start server:"
echo "     npm run dev"
echo ""
echo "  2. Create a one-time server admin Claim token and connect the new server from Server Management."
