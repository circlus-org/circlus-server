#!/bin/bash
# Database initialization script.
# Applies schema/migrations and generates typed SQL bindings.

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "========================================="
echo "Circlus Server - Initial Local Database Setup"
echo "========================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}ERROR: .env file not found${NC}"
    echo ""
    echo "Please create .env file first:"
    echo "  cp .env.minimal.example .env"
    echo "  # Edit .env with your settings"
    echo ""
    exit 1
fi

# Load .env file
echo "Loading configuration from .env..."

# NOTE: Do not use `export $(cat .env | xargs)` because it breaks on values with spaces
# and can cause confusing errors.
while IFS= read -r line || [ -n "$line" ]; do
    # Strip CR (Windows line endings)
    line="${line%$'\r'}"

    # Skip comments and empty lines
    case "$line" in
        ''|'#'*) continue ;;
    esac

    # Skip lines without '='
    if [[ "$line" != *"="* ]]; then
        continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    # Trim whitespace in key
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

    # Trim one leading space from value (common in .env formatting)
    value="$(echo "$value" | sed -e 's/^[[:space:]]*//')"

    # Remove optional surrounding quotes
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
done < .env

# Check required variables
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}ERROR: DATABASE_URL not set in .env${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Configuration loaded${NC}"
echo "  DATABASE_URL is configured (credentials are not printed)"
echo ""

# Step 1: Setup database
echo "========================================="
echo "Step 1: Database Setup"
echo "========================================="
echo ""

echo -e "${YELLOW}WARNING: initial setup drops and recreates the configured local database.${NC}"
echo "For an existing installation, stop now and run 'npm run migrate' instead."
echo ""
./reset-local-database.sh

# Step 2: Generate pgtyped types
echo ""
echo "========================================="
echo "Step 2: Generate TypeScript Types"
echo "========================================="
echo ""

npm run types:generate

echo "========================================="
echo -e "${GREEN}✓ Database initialization successful!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Start the server:"
echo "     npm run dev"
echo ""
echo "  2. Or build and start production server:"
echo "     npm run build"
echo "     npm start"
echo ""
echo "  3. Create a one-time server admin Claim token and connect the new server from Server Management."
echo ""
