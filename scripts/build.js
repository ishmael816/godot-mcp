import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make the build/index.js file executable
fs.chmodSync(path.join(__dirname, '..', 'build', 'index.js'), '755');

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.ensureDirSync(path.join(__dirname, '..', 'build', 'scripts'));
  
  // Copy the godot_operations.gd file
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    path.join(__dirname, '..', 'build', 'scripts', 'godot_operations.gd')
  );
  
  console.log('Successfully copied godot_operations.gd to build/scripts');
} catch (error) {
  console.error('Error copying scripts:', error);
  process.exit(1);
}

// Copy the editor_plugin directory to the build directory
try {
  const pluginSrcDir = path.join(__dirname, '..', 'src', 'editor_plugin');
  const pluginBuildDir = path.join(__dirname, '..', 'build', 'editor_plugin');
  
  if (fs.existsSync(pluginSrcDir)) {
    fs.ensureDirSync(pluginBuildDir);
    fs.copySync(pluginSrcDir, pluginBuildDir);
    console.log('Successfully copied editor_plugin to build/editor_plugin');
  } else {
    console.log('editor_plugin source directory not found, skipping...');
  }
} catch (error) {
  console.error('Error copying editor_plugin:', error);
  process.exit(1);
}

console.log('Build scripts completed successfully!');
