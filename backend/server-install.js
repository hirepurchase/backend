// Server-side dependency installer
// Run this ONCE on SmarterASP.NET after uploading files
// node server-install.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Installing production dependencies on server...');

try {
  // Check if node_modules exists
  const nodeModulesPath = path.join(__dirname, 'node_modules');

  if (fs.existsSync(nodeModulesPath)) {
    console.log('⚠️  node_modules already exists. Removing...');
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  }

  // Install production dependencies only
  console.log('📦 Installing packages...');
  execSync('npm install --omit=dev --no-optional', {
    stdio: 'inherit',
    cwd: __dirname
  });

  console.log('✅ Installation complete!');
  console.log('🎉 Server is ready to run!');
  console.log('');
  console.log('Next: Enable Node.js in SmarterASP.NET control panel');
  console.log('Entry point: index.js');

} catch (error) {
  console.error('❌ Installation failed:', error.message);
  process.exit(1);
}
