#!/bin/bash
# Prepare deployment package for SmarterASP.NET
# This builds the app locally but excludes node_modules

echo "🔨 Building application..."

# Install all dependencies (including dev for build)
npm install

# Build TypeScript
npm run build

# Generate Prisma Client
npx prisma generate

echo "✅ Build complete!"
echo ""
echo "📦 Ready to upload via FTP:"
echo "  ✅ dist/ folder"
echo "  ✅ prisma/ folder"
echo "  ✅ package.json"
echo "  ✅ package-lock.json"
echo "  ✅ web.config"
echo "  ✅ index.js"
echo "  ✅ server-install.js (run this on server)"
echo ""
echo "❌ DO NOT upload:"
echo "  ❌ node_modules/ (will be installed on server)"
echo "  ❌ src/"
echo "  ❌ .env files"
echo ""
echo "After uploading, run: node server-install.js on the server"
echo "Or set it up to run automatically on first request."
