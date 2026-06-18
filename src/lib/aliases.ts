const path = require('path');

// Define path aliases for @/ directories
// This must live at the project root and be referenced in next.config.js
// and all tsconfig.json files

// @/ is root directory
// @/lib = lib files
// @/public = public files
// @/components = components directory
// Additional aliases can be defined as needed
const aliases = {
  '@': path.resolve(__dirname, '.'),
  '@/lib': path.resolve(__dirname, 'src', 'lib'),
  '@/components': path.resolve(__dirname, 'src', 'components'),
  '@/app': path.resolve(__dirname, 'src', 'app'),
  '@/public': path.resolve(__dirname, 'public'),
};

module.exports = { aliases };