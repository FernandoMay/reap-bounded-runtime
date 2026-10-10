#!/usr/bin/env bash
#
# Create the GitHub remote and push the current branch.
#
# The `gh` CLI is required. This script does not run `gh auth login` for you —
# interactive authentication belongs to you, not to a script.
#
#   gh auth login
#   ./scripts/publish-remote.sh [repo-name]

set -euo pipefail

REPO_NAME="${1:-reap-bounded-runtime}"
DESCRIPTION="A programmable economic-authority layer for autonomous agents, built on Reap Agentic Payments"

if ! command -v gh > /dev/null 2>&1; then
  echo "error: gh is not installed."
  echo "  Linux amd64: curl -fsSL https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_linux_amd64.tar.gz | tar -xz"
  echo "  then: sudo install -m0755 gh_2.62.0_linux_amd64/bin/gh /usr/local/bin/gh"
  exit 1
fi

if ! gh auth status > /dev/null 2>&1; then
  echo "error: gh is not authenticated. Run: gh auth login"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: the working tree is dirty. Commit or stash first."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "Creating $REPO_NAME (public) from the current branch $BRANCH..."
gh repo create "$REPO_NAME" \
  --public \
  --description "$DESCRIPTION" \
  --source=. \
  --remote=origin \
  --push

echo
echo "Done. Remote set to: $(git remote get-url origin)"
echo
echo "A pull request, left open for review rather than merged:"
echo "  gh pr create --fill --draft"
