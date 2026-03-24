#!/usr/bin/env bash
set -e

# Build frontend first to ensure latest changes are applied
echo "📦 Building frontend..."
(cd web && pnpm build)

# Start backend (with web frontend) in watch mode
echo "🚀 Starting server..."
exec node --import tsx/esm --watch src/main.ts --web --debug "$@"
