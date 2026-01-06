#!/bin/bash
#
# Pre-commit documentation reminder
# Install: cp scripts/pre-commit-docs.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Check if docs directory exists
if [ ! -d "docs" ]; then
    echo -e "${RED}Error: docs/ directory not found${NC}"
    echo "Run the documentation setup first."
    exit 1
fi

# Get list of staged files (excluding docs)
STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^src/' || true)
STAGED_DOCS=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^docs/' || true)

# If source files changed but no docs changed, prompt
if [ -n "$STAGED_SRC" ] && [ -z "$STAGED_DOCS" ]; then
    echo ""
    echo -e "${YELLOW}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  📝 Documentation Reminder                                  ║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "You have staged source changes but no documentation updates."
    echo ""
    echo "Changed source files:"
    echo "$STAGED_SRC" | sed 's/^/  - /'
    echo ""
    echo -e "${GREEN}Consider updating:${NC}"
    echo "  - docs/changelog.md (add to [Unreleased] section)"
    echo "  - docs/project-status.md (if status changed)"
    echo "  - docs/features/*.md (if feature behavior changed)"
    echo "  - docs/spec.md (if API/data models changed)"
    echo ""
    echo -e "Run ${GREEN}/update-docs${NC} workflow for guided documentation updates."
    echo ""
    
    # Prompt for confirmation
    read -p "Continue with commit anyway? [y/N] " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Commit cancelled. Update docs and try again.${NC}"
        exit 1
    fi
fi

# If docs were updated, show confirmation
if [ -n "$STAGED_DOCS" ]; then
    echo -e "${GREEN}✓ Documentation updated${NC}"
    echo "$STAGED_DOCS" | sed 's/^/  - /'
fi

exit 0
