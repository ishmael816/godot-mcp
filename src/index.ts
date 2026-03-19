#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, statSync } from 'fs';
import { spawn, execFile, exec } from 'child_process';
import { promisify } from 'util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DocManager } from './docs/DocManager.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// New utility imports
import { FileUtils } from './utils/FileUtils.js';
import { ScriptManager } from './scripts/ScriptManager.js';
import { AssetManager, AssetInfo } from './assets/AssetManager.js';
import { TileMapEditor } from './tilemap/TileMapEditor.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Interface for editor command responses
 */
interface EditorCommandResponse {
  id: string;
  success: boolean;
  error: string;
  data: any;
}

/**
 * Editor Bridge for TCP communication with Godot Editor
 */
class EditorBridge {
  private host: string = '127.0.0.1';
  private port: number = 9742;
  private socket: any = null;
  private net: any = null;
  private pendingCommands: Map<string, { resolve: Function; reject: Function; timeout: any }> = new Map();
  private commandId: number = 0;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;
  private buffer: string = '';

  constructor() {
    // Dynamic import to avoid issues if net is not available
    import('net').then((netModule) => {
      this.net = netModule.default || netModule;
    }).catch(() => {
      console.error('[EditorBridge] net module not available');
    });
  }

  /**
   * Check if connected to the editor
   */
  isConnected(): boolean {
    return this.connected && this.socket && !this.socket.destroyed;
  }

  /**
   * Connect to the Godot Editor plugin
   */
  async connect(): Promise<boolean> {
    if (this.isConnected()) {
      return true;
    }

    if (!this.net) {
      try {
        const netModule = await import('net');
        this.net = netModule.default || netModule;
      } catch {
        throw new Error('TCP networking not available');
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.socket = new this.net.Socket();

        const timeout = setTimeout(() => {
          this.socket.destroy();
          reject(new Error('Connection timeout - Is the Godot Editor running with MCP Bridge plugin enabled?'));
        }, 5000);

        this.socket.connect(this.port, this.host, () => {
          clearTimeout(timeout);
          this.connected = true;
          this.reconnectAttempts = 0;
          console.error('[EditorBridge] Connected to Godot Editor');
          resolve(true);
        });

        this.socket.on('data', (data: Buffer) => {
          this._handleData(data.toString());
        });

        this.socket.on('close', () => {
          this.connected = false;
          console.error('[EditorBridge] Connection closed');
        });

        this.socket.on('error', (err: Error) => {
          clearTimeout(timeout);
          this.connected = false;
          reject(new Error(`Failed to connect: ${err.message}`));
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the editor
   */
  disconnect(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingCommands.clear();
  }

  /**
   * Send a command to the editor
   */
  async sendCommand(type: string, params: any = {}): Promise<EditorCommandResponse> {
    if (!this.isConnected()) {
      await this.connect();
    }

    const id = `cmd_${++this.commandId}_${Date.now()}`;
    const command = { id, type, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error('Command timeout'));
      }, 30000);

      this.pendingCommands.set(id, { resolve, reject, timeout });

      try {
        this.socket.write(JSON.stringify(command) + '\n');
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCommands.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming data from the editor
   */
  private _handleData(data: string): void {
    this.buffer += data;
    
    // Process complete JSON objects (newline delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, newlineIndex);
      this.buffer = this.buffer.substring(newlineIndex + 1);
      
      if (line.trim()) {
        try {
          const response: EditorCommandResponse = JSON.parse(line);
          const pending = this.pendingCommands.get(response.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingCommands.delete(response.id);
            pending.resolve(response);
          }
        } catch (e) {
          console.error('[EditorBridge] Failed to parse response:', line);
        }
      }
    }
  }

  /**
   * Get connection status info
   */
  getStatus(): { connected: boolean; host: string; port: number } {
    return {
      connected: this.isConnected(),
      host: this.host,
      port: this.port
    };
  }
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  private docManager: DocManager | null = null;
  private editorBridge: EditorBridge = new EditorBridge();
  private recentProjects: string[] = [];
  private cacheFilePath: string;
  private detectedProjectPath: string | null = null;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize cache file path
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    this.cacheFilePath = join(homeDir, '.godot-mcp', 'cache.json');
    this.loadRecentProjects();

    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize documentation manager
    this.docManager = new DocManager('4.2'); // Default to 4.2, will be updated based on detected version

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  // ============================================================================
  // Auto-Detection and Cache Methods
  // ============================================================================

  /**
   * Load recent projects from cache file
   */
  private loadRecentProjects(): void {
    try {
      if (existsSync(this.cacheFilePath)) {
        const cache = JSON.parse(readFileSync(this.cacheFilePath, 'utf8'));
        this.recentProjects = cache.recentProjects || [];
        this.logDebug(`Loaded ${this.recentProjects.length} recent projects from cache`);
      }
    } catch (error) {
      this.logDebug(`Failed to load cache: ${error}`);
      this.recentProjects = [];
    }
  }

  /**
   * Save recent projects to cache file
   */
  private saveRecentProjects(): void {
    try {
      const cacheDir = dirname(this.cacheFilePath);
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }
      writeFileSync(this.cacheFilePath, JSON.stringify({
        recentProjects: this.recentProjects.slice(0, 10),  // Keep only 10 most recent
        lastUpdated: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      this.logDebug(`Failed to save cache: ${error}`);
    }
  }

  /**
   * Add a project to recent projects list
   */
  private addRecentProject(projectPath: string): void {
    // Remove if already exists
    this.recentProjects = this.recentProjects.filter(p => p !== projectPath);
    // Add to front
    this.recentProjects.unshift(projectPath);
    // Save cache
    this.saveRecentProjects();
  }

  /**
   * Detect running Godot Editor process and extract project path
   * @returns Project path if detected, null otherwise
   */
  private async detectRunningGodotProject(): Promise<string | null> {
    try {
      const platform = process.platform;
      let command: string;

      if (platform === 'win32') {
        // Windows: use wmic or tasklist
        command = 'wmic process where "name like \"%godot%\"" get CommandLine /format:csv';
      } else if (platform === 'darwin') {
        // macOS: use ps
        command = 'ps aux | grep -i godot | grep -v grep';
      } else {
        // Linux: use ps
        command = 'ps aux | grep -i godot | grep -v grep';
      }

      const { stdout } = await execAsync(command);
      
      if (!stdout) {
        return null;
      }

      // Parse command line to find --path argument
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes('godot')) {
          // Extract --path value using regex
          const pathMatch = line.match(/--path\s+"?([^"\s]+)"?/);
          if (pathMatch) {
            const projectPath = pathMatch[1];
            // Verify it's a valid project
            if (existsSync(join(projectPath, 'project.godot'))) {
              this.logDebug(`Detected running Godot project: ${projectPath}`);
              this.detectedProjectPath = projectPath;
              return projectPath;
            }
          }
          
          // Also try -e (editor) flag detection
          if (line.includes('-e') || line.includes('--editor')) {
            // Look for project path without --path flag (Godot uses working directory or first argument)
            const parts = line.split(/\s+/);
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (part.includes('\\') || part.includes('/')) {
                // Potential path
                const potentialPath = part.replace(/^"/, '').replace(/"$/, '');
                if (existsSync(join(potentialPath, 'project.godot'))) {
                  this.logDebug(`Detected running Godot project: ${potentialPath}`);
                  this.detectedProjectPath = potentialPath;
                  return potentialPath;
                }
              }
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logDebug(`Failed to detect running Godot: ${error}`);
      return null;
    }
  }

  /**
   * Get current scene from connected editor
   * @returns Current scene info or null
   */
  private async getCurrentSceneFromEditor(): Promise<any | null> {
    try {
      if (!this.editorBridge.isConnected()) {
        await this.editorBridge.connect();
      }

      const response = await this.editorBridge.sendCommand('get_editor_state');
      
      if (response.success && response.data) {
        return {
          sceneName: response.data.current_scene,
          scenePath: response.data.current_scene_path,
          isPlaying: response.data.is_playing,
          hasSelection: response.data.has_selection
        };
      }
      
      return null;
    } catch (error) {
      this.logDebug(`Failed to get current scene: ${error}`);
      return null;
    }
  }

  /**
   * Auto-detect project and connect to editor
   * @returns Detection result with project and scene info
   */
  private async autoDetectAndConnect(): Promise<{ 
    success: boolean; 
    projectPath?: string; 
    sceneInfo?: any; 
    error?: string;
    isNewConnection?: boolean;
  }> {
    try {
      // Step 1: Check if already connected
      if (this.editorBridge.isConnected()) {
        const sceneInfo = await this.getCurrentSceneFromEditor();
        if (sceneInfo && this.detectedProjectPath) {
          return {
            success: true,
            projectPath: this.detectedProjectPath,
            sceneInfo,
            isNewConnection: false
          };
        }
      }

      // Step 2: Detect running Godot project
      const projectPath = await this.detectRunningGodotProject();
      
      if (!projectPath) {
        // Try recent projects as fallback
        if (this.recentProjects.length > 0) {
          const recent = this.recentProjects[0];
          if (existsSync(join(recent, 'project.godot'))) {
            return {
              success: true,
              projectPath: recent,
              error: 'No running Godot detected. Using most recent project. You may need to open the editor manually.'
            };
          }
        }
        
        return {
          success: false,
          error: 'Could not detect a running Godot Editor. Please:\n1. Open Godot Editor with your project\n2. Or provide the project path manually'
        };
      }

      // Step 3: Check if plugin is installed
      const pluginDir = join(projectPath, 'addons', 'mcp_bridge');
      if (!existsSync(pluginDir)) {
        return {
          success: false,
          projectPath,
          error: `MCP Bridge plugin not installed in this project.\nRun: install_editor_plugin({projectPath: "${projectPath}"})`
        };
      }

      // Step 4: Try to connect
      try {
        await this.editorBridge.connect();
        const sceneInfo = await this.getCurrentSceneFromEditor();
        
        this.addRecentProject(projectPath);
        
        return {
          success: true,
          projectPath,
          sceneInfo,
          isNewConnection: true
        };
      } catch (connError: any) {
        return {
          success: false,
          projectPath,
          error: `Plugin detected but connection failed: ${connError.message}\n\nPlease ensure:\n1. Godot Editor is running\n2. MCP Bridge plugin is enabled (Project Settings > Plugins)\n3. Plugin shows "listening on 127.0.0.1:9742" in Output panel`
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: `Auto-detection failed: ${error.message}`
      };
    }
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'capture_screenshot',
          description: 'Capture a screenshot of a Godot scene. Renders the scene and saves it as a PNG image for visual verification and iterative UI development.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file to capture (relative to project)',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the screenshot will be saved (relative to project, should end with .png)',
              },
              width: {
                type: 'number',
                description: 'Screenshot width in pixels (default: 1920)',
              },
              height: {
                type: 'number',
                description: 'Screenshot height in pixels (default: 1080)',
              },
              delay: {
                type: 'number',
                description: 'Delay in seconds before capturing to let scene stabilize (default: 0.5)',
              },
              transparentBg: {
                type: 'boolean',
                description: 'Whether to use transparent background (default: false)',
              },
              disable3d: {
                type: 'boolean',
                description: 'Whether to disable 3D rendering for better 2D performance (default: false)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'attach_script',
          description: 'Attach a GDScript or C# script to a node in a Godot scene. The script file must already exist. Modifies the scene file to include the script reference.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the target node (e.g., "root" for root node, "root/Player" for child node)',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file (relative to project, e.g., "scripts/player.gd")',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
          },
        },
        {
          name: 'query_documentation',
          description: 'Query Godot class documentation. Returns information about classes, methods, properties, signals, and constants. Automatically downloads documentation on first use if not cached locally. Use this to verify API correctness and prevent hallucinations.',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the Godot class to query (e.g., "Button", "CharacterBody2D", "Vector2")',
              },
              memberName: {
                type: 'string',
                description: 'Optional: Specific member to query (method, property, signal, or constant name)',
              },
              memberType: {
                type: 'string',
                enum: ['method', 'property', 'signal', 'constant'],
                description: 'Optional: Type of member to search for (speeds up search)',
              },
              godotVersion: {
                type: 'string',
                description: 'Optional: Godot version (e.g., "4.2", "4.3"). Uses cached version or downloads if not available.',
              },
            },
            required: ['className'],
          },
        },
        {
          name: 'validate_api',
          description: 'Validate Godot API usage and detect potential errors. Checks if class/member exists, validates method signatures, and provides suggestions for corrections. Use this before generating code to ensure API correctness.',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the Godot class',
              },
              memberName: {
                type: 'string',
                description: 'Method, property, or signal name being used',
              },
              usage: {
                type: 'string',
                description: 'Optional: How you are using this API (e.g., "button.pressed.connect(on_click)") for context-aware validation',
              },
              godotVersion: {
                type: 'string',
                description: 'Optional: Godot version for version-specific validation',
              },
            },
            required: ['className', 'memberName'],
          },
        },
        {
          name: 'connect_signal',
          description: 'Connect a Godot signal to a method callback. Enables UI interactions like button clicks. Modifies the scene to persist the signal connection.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the node that emits the signal (e.g., "root/StartButton")',
              },
              signalName: {
                type: 'string',
                description: 'Name of the signal to connect (e.g., "pressed", "body_entered")',
              },
              targetPath: {
                type: 'string',
                description: 'Path to the node that contains the callback method (usually same as nodePath or "root")',
              },
              methodName: {
                type: 'string',
                description: 'Name of the callback method (e.g., "_on_start_button_pressed")',
              },
              flags: {
                type: 'number',
                description: 'Optional: Connection flags (0=default, 1=deferred, 2=one_shot, 4=reference_counted)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'signalName', 'targetPath', 'methodName'],
          },
        },
        {
          name: 'set_node_property',
          description: 'Set a property value on a node in a Godot scene. Supports position, scale, rotation, colors, and theme overrides. Modifies the scene file to persist the changes.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the target node (e.g., "root" or "root/StartButton")',
              },
              propertyPath: {
                type: 'string',
                description: 'Property path (e.g., "position", "modulate", "scale:x", "theme_override_colors/font_color")',
              },
              propertyValue: {
                type: ['string', 'number', 'boolean'],
                description: 'Property value. Supports numbers, "Vector2(100, 200)", "Color.red", "#ff0000", "true/false"',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'propertyPath', 'propertyValue'],
          },
        },
        {
          name: 'delete_node',
          description: 'Delete a node from a Godot scene. Cannot delete the root node. Modifies the scene file to persist the changes.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the node to delete (e.g., "root/OldButton")',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'build_csharp_project',
          description: 'Compile C# scripts in a Godot project. Automatically detects .csproj files and runs dotnet build. Required after modifying C# scripts before running the project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              configuration: {
                type: 'string',
                enum: ['Debug', 'Release'],
                description: 'Build configuration (default: Debug)',
              },
              useGodotBuild: {
                type: 'boolean',
                description: 'Use Godot\'s built-in build instead of dotnet CLI (default: false)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'smart_export',
          description: 'Smart export with automatic error detection and repair. Attempts to export the project, and if it fails due to code errors (C# or GDScript), automatically fixes them and retries. For setup errors (missing templates/presets), provides detailed manual instructions.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              presetName: {
                type: 'string',
                description: 'Export preset name (e.g., "Windows Desktop", "macOS", "Android")',
              },
              outputPath: {
                type: 'string',
                description: 'Output path for the exported file',
              },
              maxRetries: {
                type: 'number',
                description: 'Maximum number of auto-fix attempts (default: 3)',
              },
              debug: {
                type: 'boolean',
                description: 'Export debug build (default: false)',
              },
            },
            required: ['projectPath', 'presetName', 'outputPath'],
          },
        },
        {
          name: 'export_project',
          description: 'Export Godot project to executable or package. Supports Windows (.exe), macOS (.app), Linux, Android (.apk/.aab), iOS, and Web. Requires export preset to be configured in Godot editor first.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              presetName: {
                type: 'string',
                description: 'Export preset name (e.g., "Windows Desktop", "macOS", "Linux/X11", "Android")',
              },
              outputPath: {
                type: 'string',
                description: 'Output path for the exported file (e.g., "builds/mygame.exe")',
              },
              debug: {
                type: 'boolean',
                description: 'Export debug build instead of release (default: false)',
              },
              patches: {
                type: 'string',
                description: 'Optional: PCK file to embed (for patch exports)',
              },
            },
            required: ['projectPath', 'presetName', 'outputPath'],
          },
        },
        // Editor Bridge Tools
        {
          name: 'install_editor_plugin',
          description: 'Install the MCP Bridge plugin to a Godot project. This plugin enables real-time communication with the Godot Editor. Must be installed before using editor bridge features.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory where the plugin will be installed',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'connect_editor',
          description: 'Connect to the Godot Editor via the MCP Bridge plugin. Must be called before using other editor bridge commands. The Editor must be running with the MCP Bridge plugin enabled.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_editor_state',
          description: 'Get the current state of the Godot Editor including the open scene, selection, and playback status. Requires active connection via connect_editor.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_editor_selection',
          description: 'Get information about currently selected nodes in the Godot Editor. Returns node names, types, and paths.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'select_node_in_editor',
          description: 'Select a specific node in the Godot Editor by its path. The node will be highlighted in the scene tree and inspector.',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node to select (e.g., "Player/Sprite2D" or "HUD/Panel/Button")',
              },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'get_scene_tree_from_editor',
          description: 'Get the complete scene tree hierarchy from the currently open scene in the Godot Editor. Returns nested structure of nodes with their types.',
          inputSchema: {
            type: 'object',
            properties: {
              maxDepth: {
                type: 'number',
                description: 'Maximum depth to traverse (default: 10)',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_node_properties_from_editor',
          description: 'Get properties of a specific node from the Godot Editor. Returns current values as shown in the Inspector panel.',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node (e.g., "Player/Sprite2D")',
              },
              includeDefaults: {
                type: 'boolean',
                description: 'Whether to include default property values (default: false)',
              },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'set_node_property_in_editor',
          description: 'Set a property value on a node in the Godot Editor. Changes are applied immediately and the scene is marked as modified.',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node (e.g., "Player/Sprite2D")',
              },
              property: {
                type: 'string',
                description: 'Property name (e.g., "position", "modulate", "texture")',
              },
              value: {
                type: ['string', 'number', 'boolean', 'object'],
                description: 'New value for the property. For complex types use object notation: {"__type": "Vector2", "x": 100, "y": 200}',
              },
            },
            required: ['nodePath', 'property', 'value'],
          },
        },
        {
          name: 'open_scene_in_editor',
          description: 'Open a scene file in the Godot Editor. Switches the editor view to the specified scene.',
          inputSchema: {
            type: 'object',
            properties: {
              scenePath: {
                type: 'string',
                description: 'Path to the scene file relative to project root (e.g., "scenes/main.tscn")',
              },
            },
            required: ['scenePath'],
          },
        },
        {
          name: 'save_scene_in_editor',
          description: 'Save the currently open scene in the Godot Editor.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'inspect_node_in_editor',
          description: 'Focus the Inspector panel on a specific node in the Godot Editor. The node will be selected and its properties displayed.',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node to inspect (e.g., "Player/CollisionShape2D")',
              },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'execute_code_in_editor',
          description: 'Execute arbitrary GDScript code in the context of the Godot Editor. Useful for advanced operations not covered by other commands.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'GDScript code to execute. Use "editor" variable to access EditorInterface.',
              },
            },
            required: ['code'],
          },
        },
        {
          name: 'disconnect_editor',
          description: 'Disconnect from the Godot Editor. Clean up the connection when done working with the editor.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        // Auto-Detection Tools
        {
          name: 'detect_godot_project',
          description: 'Automatically detect running Godot Editor and return the project path. Scans system processes to find Godot instances and extracts the project directory from command line arguments.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'auto_setup_editor',
          description: 'One-click setup: Detect running Godot project, install MCP Bridge plugin if needed, connect to editor, and return current scene info. This is the recommended way to start working with the editor.',
          inputSchema: {
            type: 'object',
            properties: {
              installPluginIfNeeded: {
                type: 'boolean',
                description: 'Automatically install plugin if not found (default: true)',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_current_scene_auto',
          description: 'Get information about the currently open scene in Godot Editor. Automatically detects the running project and connects if needed. Returns scene name, path, selection, and tree structure.',
          inputSchema: {
            type: 'object',
            properties: {
              includeTree: {
                type: 'boolean',
                description: 'Include full scene tree structure (default: true)',
              },
              includeProperties: {
                type: 'boolean',
                description: 'Include properties of selected nodes (default: false)',
              },
            },
            required: [],
          },
        },
        {
          name: 'screenshot_current_scene',
          description: 'Capture a screenshot of the currently open Godot Editor window using Windows native screenshot (nircmd or PowerShell). Activates the Godot window and captures the full screen. Windows only.',
          inputSchema: {
            type: 'object',
            properties: {
              outputPath: {
                type: 'string',
                description: 'Where to save the screenshot (relative to project, default: auto-generated in screenshots/)',
              },
              delay: {
                type: 'number',
                description: 'Delay before capture in seconds (default: 1.0)',
              },
            },
            required: [],
          },
        },
        // === Script File Operations ===
        {
          name: 'read_script',
          description: 'Read a GDScript or C# script file content. Supports reading the entire file or a specific line range.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file relative to project root (e.g., "scripts/player.gd")',
              },
              lineStart: {
                type: 'number',
                description: 'Optional: Start line number (1-based). If not provided, reads entire file.',
              },
              lineEnd: {
                type: 'number',
                description: 'Optional: End line number (1-based, inclusive). If not provided, reads to end.',
              },
            },
            required: ['projectPath', 'scriptPath'],
          },
        },
        {
          name: 'write_script',
          description: 'Write content to a script file. Creates the file if it does not exist. Optionally creates a backup.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file relative to project root',
              },
              content: {
                type: 'string',
                description: 'The script content to write',
              },
              backup: {
                type: 'boolean',
                description: 'Whether to create a backup of existing file (default: true)',
              },
            },
            required: ['projectPath', 'scriptPath', 'content'],
          },
        },
        {
          name: 'create_script',
          description: 'Create a new script file with a template. Supports GDScript and C# with various templates.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path for the new script file (e.g., "scripts/enemy.gd")',
              },
              language: {
                type: 'string',
                enum: ['gdscript', 'csharp'],
                description: 'Script language',
              },
              template: {
                type: 'string',
                enum: ['empty', 'node2d', 'node3d', 'control', 'characterbody2d'],
                description: 'Template type (default: empty)',
              },
            },
            required: ['projectPath', 'scriptPath', 'language'],
          },
        },
        {
          name: 'edit_script',
          description: 'Edit a script by replacing specific line ranges. Allows precise modifications without rewriting the entire file.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file',
              },
              lineStart: {
                type: 'number',
                description: 'Start line number to replace (1-based)',
              },
              lineEnd: {
                type: 'number',
                description: 'End line number to replace (1-based, inclusive)',
              },
              newContent: {
                type: 'string',
                description: 'New content to insert',
              },
            },
            required: ['projectPath', 'scriptPath', 'lineStart', 'lineEnd', 'newContent'],
          },
        },
        {
          name: 'search_in_script',
          description: 'Search for text patterns in a script file. Returns line numbers and content of matches.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file',
              },
              pattern: {
                type: 'string',
                description: 'Text pattern to search for',
              },
            },
            required: ['projectPath', 'scriptPath', 'pattern'],
          },
        },
        {
          name: 'replace_in_script',
          description: 'Replace all occurrences of a text pattern in a script file.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the script file',
              },
              search: {
                type: 'string',
                description: 'Text to search for',
              },
              replace: {
                type: 'string',
                description: 'Replacement text',
              },
            },
            required: ['projectPath', 'scriptPath', 'search', 'replace'],
          },
        },
        // === Asset Operations ===
        {
          name: 'import_asset',
          description: 'Import an external file into the Godot project. Supports textures, audio, fonts, and models. Automatically generates .import configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              sourcePath: {
                type: 'string',
                description: 'Absolute path to the source file on disk',
              },
              targetPath: {
                type: 'string',
                description: 'Target path relative to project root (e.g., "assets/textures/player.png")',
              },
              overwrite: {
                type: 'boolean',
                description: 'Whether to overwrite if target exists (default: false)',
              },
            },
            required: ['projectPath', 'sourcePath', 'targetPath'],
          },
        },
        {
          name: 'scan_assets',
          description: 'Scan the project directory and list all assets. Supports filtering by type and recursive scanning.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              directory: {
                type: 'string',
                description: 'Directory to scan relative to project root (default: root)',
              },
              typeFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional: Filter by asset types (texture, audio, font, model, etc.)',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to scan subdirectories (default: true)',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'analyze_assets',
          description: 'Analyze project assets to find unused files or duplicates.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              findUnused: {
                type: 'boolean',
                description: 'Find assets not referenced by any scene or script',
              },
              findDuplicates: {
                type: 'boolean',
                description: 'Find duplicate assets by name',
              },
            },
            required: ['projectPath'],
          },
        },
        // === TileMap Operations ===
        {
          name: 'modify_tilemap',
          description: 'Modify a TileMap in a scene file. Supports setting/erasing cells, clearing layers, and terrain painting.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file containing the TileMap',
              },
              tileMapNodePath: {
                type: 'string',
                description: 'Path to the TileMap node (e.g., "root/TileMap")',
              },
              operations: {
                type: 'array',
                description: 'List of operations to perform',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['set_cell', 'erase_cell', 'clear_layer'],
                    },
                    coords: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      description: 'Tile coordinates for set_cell/erase_cell',
                    },
                    atlasCoords: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      description: 'Atlas coordinates for the tile',
                    },
                    sourceId: {
                      type: 'number',
                      description: 'Source ID for the tile',
                    },
                    layerIndex: {
                      type: 'number',
                      description: 'Layer index (default: 0)',
                    },
                  },
                },
              },
            },
            required: ['projectPath', 'scenePath', 'tileMapNodePath', 'operations'],
          },
        },
        {
          name: 'get_recent_projects',
          description: 'Get list of recently accessed Godot projects from cache. Useful when auto-detection fails.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'capture_screenshot':
          return await this.handleCaptureScreenshot(request.params.arguments);
        case 'attach_script':
          return await this.handleAttachScript(request.params.arguments);
        case 'query_documentation':
          return await this.handleQueryDocumentation(request.params.arguments);
        case 'validate_api':
          return await this.handleValidateApi(request.params.arguments);
        case 'connect_signal':
          return await this.handleConnectSignal(request.params.arguments);
        case 'set_node_property':
          return await this.handleSetNodeProperty(request.params.arguments);
        case 'delete_node':
          return await this.handleDeleteNode(request.params.arguments);
        case 'build_csharp_project':
          return await this.handleBuildCSharpProject(request.params.arguments);
        case 'smart_export':
          return await this.handleSmartExport(request.params.arguments);
        case 'export_project':
          return await this.handleExportProject(request.params.arguments);
        // Editor Bridge Handlers
        case 'install_editor_plugin':
          return await this.handleInstallEditorPlugin(request.params.arguments);
        case 'connect_editor':
          return await this.handleConnectEditor();
        case 'get_editor_state':
          return await this.handleGetEditorState();
        case 'get_editor_selection':
          return await this.handleGetEditorSelection();
        case 'select_node_in_editor':
          return await this.handleSelectNodeInEditor(request.params.arguments);
        case 'get_scene_tree_from_editor':
          return await this.handleGetSceneTreeFromEditor(request.params.arguments);
        case 'get_node_properties_from_editor':
          return await this.handleGetNodePropertiesFromEditor(request.params.arguments);
        case 'set_node_property_in_editor':
          return await this.handleSetNodePropertyInEditor(request.params.arguments);
        case 'open_scene_in_editor':
          return await this.handleOpenSceneInEditor(request.params.arguments);
        case 'save_scene_in_editor':
          return await this.handleSaveSceneInEditor();
        case 'inspect_node_in_editor':
          return await this.handleInspectNodeInEditor(request.params.arguments);
        case 'execute_code_in_editor':
          return await this.handleExecuteCodeInEditor(request.params.arguments);
        case 'disconnect_editor':
          return await this.handleDisconnectEditor();
        // Auto-Detection Handlers
        case 'detect_godot_project':
          return await this.handleDetectGodotProject();
        case 'auto_setup_editor':
          return await this.handleAutoSetupEditor(request.params.arguments);
        case 'get_current_scene_auto':
          return await this.handleGetCurrentSceneAuto(request.params.arguments);
        case 'screenshot_current_scene':
          return await this.handleScreenshotCurrentScene(request.params.arguments);
        // Script Operations
        case 'read_script':
          return await this.handleReadScript(request.params.arguments);
        case 'write_script':
          return await this.handleWriteScript(request.params.arguments);
        case 'create_script':
          return await this.handleCreateScript(request.params.arguments);
        case 'edit_script':
          return await this.handleEditScript(request.params.arguments);
        case 'search_in_script':
          return await this.handleSearchInScript(request.params.arguments);
        case 'replace_in_script':
          return await this.handleReplaceInScript(request.params.arguments);
        // Asset Operations
        case 'import_asset':
          return await this.handleImportAsset(request.params.arguments);
        case 'scan_assets':
          return await this.handleScanAssets(request.params.arguments);
        case 'analyze_assets':
          return await this.handleAnalyzeAssets(request.params.arguments);
        // TileMap Operations
        case 'modify_tilemap':
          return await this.handleModifyTileMap(request.params.arguments);
        case 'get_recent_projects':
          return await this.handleGetRecentProjects();
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the capture_screenshot tool
   */
  private async handleCaptureScreenshot(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.width) {
        params.width = args.width;
      }
      if (args.height) {
        params.height = args.height;
      }
      if (args.delay !== undefined) {
        params.delay = args.delay;
      }
      if (args.transparentBg !== undefined) {
        params.transparent_bg = args.transparentBg;
      }
      if (args.disable3d !== undefined) {
        params.disable_3d = args.disable3d;
      }

      this.logDebug(`Capturing screenshot of ${args.scenePath} to ${args.outputPath}`);

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('capture_screenshot', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to capture screenshot: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be loaded and rendered',
          ]
        );
      }

      // Parse the result JSON if present
      let resultText = stdout.trim();
      try {
        const result = JSON.parse(resultText);
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Screenshot captured successfully!\n\nSaved to: ${result.path}\nAbsolute path: ${result.absolute_path}\nSize: ${result.size.x}x${result.size.y}\n\nYou can now view this image to verify the visual appearance of your UI/scene.`,
              },
            ],
          };
        }
      } catch (e) {
        // JSON parsing failed, use raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: `Screenshot captured.\n\nOutput: ${resultText}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to capture screenshot: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Make sure the scene can be rendered (not corrupted)',
        ]
      );
    }
  }

  /**
   * Handle the attach_script tool
   */
  private async handleAttachScript(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.scriptPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and scriptPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.scriptPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the script file exists
      const scriptPath = join(args.projectPath, args.scriptPath);
      if (!existsSync(scriptPath)) {
        return this.createErrorResponse(
          `Script file does not exist: ${args.scriptPath}`,
          [
            'Ensure the script path is correct',
            'Create the script file first before attaching it to a node',
            'Use your code editor or AI assistant to generate the script content',
          ]
        );
      }

      // Validate script extension
      if (!args.scriptPath.endsWith('.gd') && !args.scriptPath.endsWith('.cs')) {
        return this.createErrorResponse(
          'Invalid script file extension',
          [
            'Script file must end with .gd (GDScript) or .cs (C#)',
            'Example: "scripts/player.gd" or "scripts/Enemy.cs"',
          ]
        );
      }

      // Prepare parameters for the operation
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        scriptPath: args.scriptPath,
      };

      this.logDebug(`Attaching script ${args.scriptPath} to node ${args.nodePath} in ${args.scenePath}`);

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('attach_script', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to attach script: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the script file is valid GDScript or C#',
            'Verify the scene file is not corrupted',
            'Make sure the node type is compatible with the script (e.g., Node2D script for Node2D node)',
          ]
        );
      }

      // Parse the result JSON
      let resultText = stdout.trim();
      try {
        const result = JSON.parse(resultText);
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Script attached successfully!\n\nScene: ${result.scene_path}\nNode: ${result.node_path} (${result.node_type})\nScript: ${result.script_path}\n\nThe scene has been saved with the script reference.`,
              },
            ],
          };
        }
      } catch (e) {
        // JSON parsing failed, use raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: `Script attached.\n\nOutput: ${resultText}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to attach script: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Make sure the script file exists and is valid',
        ]
      );
    }
  }

  /**
   * Initialize documentation manager if needed
   */
  private async ensureDocsInitialized(godotVersion?: string): Promise<boolean> {
    if (!this.docManager) {
      this.docManager = new DocManager(godotVersion || '4.2');
    }

    if (!this.docManager.isLoaded()) {
      console.error('[SERVER] Initializing documentation manager...');
      const success = await this.docManager.initialize();
      if (success) {
        console.error(`[SERVER] Documentation loaded: ${this.docManager.getClassCount()} classes`);
      } else {
        console.error('[SERVER] Failed to load documentation');
      }
      return success;
    }

    return true;
  }

  /**
   * Handle the query_documentation tool
   */
  private async handleQueryDocumentation(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.className) {
      return this.createErrorResponse(
        'Class name is required',
        ['Provide a valid Godot class name (e.g., "Button", "CharacterBody2D")']
      );
    }

    try {
      // Initialize docs if needed
      const initialized = await this.ensureDocsInitialized(args.godotVersion);
      if (!initialized || !this.docManager) {
        return this.createErrorResponse(
          'Documentation not available',
          [
            'Failed to initialize documentation manager',
            'Check your internet connection for first-time download',
            'Documentation is cached locally after first download',
          ]
        );
      }

      this.logDebug(`Querying documentation for ${args.className}${args.memberName ? '.' + args.memberName : ''}`);

      // Query the documentation
      const result = this.docManager.query(
        args.className,
        args.memberName,
        args.memberType
      );

      if (!result.found) {
        const suggestions = result.suggestions && result.suggestions.length > 0
          ? result.suggestions
          : [];
        
        const solutions = [
          'Check the spelling of the class/member name',
          'Use the exact Godot API names (case-sensitive)',
          'Search for related terms if unsure',
        ];

        if (suggestions.length > 0) {
          solutions.push('', 'Did you mean:', ...suggestions.map(s => `- ${s}`));
        }
        
        return this.createErrorResponse(
          result.error || 'Not found',
          solutions
        );
      }

      // Format the result
      let responseText = '';

      if (result.class) {
        const classInfo = result.class;
        responseText += `## ${classInfo.name}\n\n`;
        
        if (classInfo.extends) {
          responseText += `**Extends:** ${classInfo.extends}\n\n`;
        }

        if (classInfo.brief_description) {
          responseText += `${classInfo.brief_description}\n\n`;
        }

        if (classInfo.description && classInfo.description !== classInfo.brief_description) {
          responseText += `**Description:**\n${classInfo.description}\n\n`;
        }

        // If querying a specific member
        if (result.member && result.memberType) {
          const member = result.member;
          responseText += `---\n\n### ${result.memberType}: ${member.name}\n\n`;
          
          if (member.description) {
            responseText += `${member.description}\n\n`;
          }

          // Type-specific details
          if (result.memberType === 'method') {
            const method = member as any;
            if (method.return_type) {
              responseText += `**Returns:** ${method.return_type}\n\n`;
            }
            if (method.arguments && method.arguments.length > 0) {
              responseText += `**Arguments:**\n`;
              for (const arg of method.arguments) {
                const defaultVal = arg.default_value ? ` = ${arg.default_value}` : '';
                responseText += `- ${arg.name}: ${arg.type}${defaultVal}\n`;
              }
              responseText += '\n';
            }
            if (method.is_virtual) {
              responseText += `*This is a virtual method - override it in your script*\n\n`;
            }
          } else if (result.memberType === 'property') {
            const prop = member as any;
            if (prop.type) responseText += `**Type:** ${prop.type}\n\n`;
            if (prop.default_value) responseText += `**Default:** ${prop.default_value}\n\n`;
          } else if (result.memberType === 'signal') {
            const signal = member as any;
            if (signal.arguments && signal.arguments.length > 0) {
              responseText += `**Arguments:**\n`;
              for (const arg of signal.arguments) {
                responseText += `- ${arg.name}: ${arg.type}\n`;
              }
              responseText += '\n';
            }
          }
        } else {
          // List available members
          const methods = classInfo.methods || [];
          const properties = classInfo.properties || [];
          const signals = classInfo.signals || [];

          if (methods.length > 0) {
            responseText += `**Methods (${methods.length}):**\n`;
            const methodNames = methods.slice(0, 10).map(m => m.name);
            responseText += methodNames.join(', ');
            if (methods.length > 10) responseText += `, ... and ${methods.length - 10} more`;
            responseText += '\n\n';
          }

          if (properties.length > 0) {
            responseText += `**Properties (${properties.length}):**\n`;
            const propNames = properties.slice(0, 10).map(p => p.name);
            responseText += propNames.join(', ');
            if (properties.length > 10) responseText += `, ... and ${properties.length - 10} more`;
            responseText += '\n\n';
          }

          if (signals.length > 0) {
            responseText += `**Signals (${signals.length}):**\n`;
            const signalNames = signals.map(s => s.name);
            responseText += signalNames.join(', ');
            responseText += '\n\n';
          }

          responseText += `*Use memberName parameter to get details about a specific method, property, or signal.*`;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to query documentation: ${error?.message || 'Unknown error'}`,
        [
          'Documentation may not be downloaded yet',
          'Check your internet connection for first-time setup',
          'Try specifying a different Godot version',
        ]
      );
    }
  }

  /**
   * Handle the validate_api tool
   */
  private async handleValidateApi(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.className || !args.memberName) {
      return this.createErrorResponse(
        'Class name and member name are required',
        ['Provide both className and memberName to validate']
      );
    }

    try {
      // Initialize docs if needed
      const initialized = await this.ensureDocsInitialized(args.godotVersion);
      if (!initialized || !this.docManager) {
        return this.createErrorResponse(
          'Documentation not available',
          ['Failed to initialize documentation manager']
        );
      }

      this.logDebug(`Validating API: ${args.className}.${args.memberName}`);

      // Validate the API
      const result = this.docManager.validate(
        args.className,
        args.memberName,
        args.usage
      );

      let responseText = '';

      if (result.valid) {
        responseText = `✅ **Valid API**\n\n`;
        responseText += `${args.className}.${args.memberName} exists and is correctly used.\n\n`;
        
        if (result.suggestions && result.suggestions.length > 0) {
          responseText += `**Tips:**\n`;
          for (const suggestion of result.suggestions) {
            responseText += `- ${suggestion}\n`;
          }
        }
      } else {
        responseText = `❌ **API Validation Failed**\n\n`;
        
        if (result.issues && result.issues.length > 0) {
          responseText += `**Issues:**\n`;
          for (const issue of result.issues) {
            responseText += `- ${issue}\n`;
          }
          responseText += '\n';
        }

        if (result.suggestions && result.suggestions.length > 0) {
          responseText += `**Did you mean:**\n`;
          for (const suggestion of result.suggestions) {
            responseText += `- ${suggestion}\n`;
          }
          responseText += '\n';
        }

        if (result.corrected) {
          responseText += `**Suggested correction:**\n\`${result.corrected}\`\n`;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        isError: !result.valid,
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to validate API: ${error?.message || 'Unknown error'}`,
        [
          'Documentation may not be available',
          'Check your internet connection for first-time setup',
        ]
      );
    }
  }

  /**
   * Handle the connect_signal tool
   */
  private async handleConnectSignal(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.signalName || !args.targetPath || !args.methodName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, signalName, targetPath, and methodName']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.targetPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Validate signal name format
      if (!args.signalName.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
        return this.createErrorResponse(
          'Invalid signal name format',
          ['Signal names must start with a letter or underscore and contain only letters, numbers, and underscores']
        );
      }

      // Validate method name format
      if (!args.methodName.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
        return this.createErrorResponse(
          'Invalid method name format',
          ['Method names must start with a letter or underscore and contain only letters, numbers, and underscores']
        );
      }

      // Prepare parameters for the operation
      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        signalName: args.signalName,
        targetPath: args.targetPath,
        methodName: args.methodName,
      };

      // Add optional parameters
      if (args.flags !== undefined) {
        params.flags = args.flags;
      }

      this.logDebug(`Connecting signal ${args.signalName} on ${args.nodePath} to ${args.targetPath}.${args.methodName}`);

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('connect_signal', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to connect signal: ${stderr}`,
          [
            'Check if the signal name is correct (use query_documentation to verify)',
            'Ensure the node path is correct',
            'Verify the target node has the specified method',
            'Check if signal and method signatures are compatible',
          ]
        );
      }

      // Parse the result JSON
      let resultText = stdout.trim();
      try {
        const result = JSON.parse(resultText);
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Signal connected successfully!\n\nSignal: ${result.signal_name}\nSource: ${result.source_node}\nTarget: ${result.target_node}.${result.method_name}\n\nThe connection is now saved in the scene file and will be restored when the scene loads.`,
              },
            ],
          };
        }
      } catch (e) {
        // JSON parsing failed, use raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: `Signal connected.\n\nOutput: ${resultText}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to connect signal: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Make sure the scene file is valid',
          'Check if the signal exists on the specified node (use query_documentation)',
        ]
      );
    }
  }

  /**
   * Handle the set_node_property tool
   */
  private async handleSetNodeProperty(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.propertyPath || args.propertyValue === undefined) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, propertyPath, and propertyValue']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.propertyPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        property_path: args.propertyPath,
        property_value: args.propertyValue,
      };

      this.logDebug(`Setting property ${args.propertyPath} = ${args.propertyValue} on ${args.nodePath}`);

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('set_node_property', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to set property: ${stderr}`,
          [
            'Check if the property path is correct',
            'Verify the property value format matches the expected type',
            'For Vector2: use "Vector2(100, 200)" or "(100, 200)"',
            'For Color: use "Color.red", "Color(1, 0, 0)", or "#ff0000"',
            'For sub-properties: use "position:x" to set just the x coordinate',
          ]
        );
      }

      // Parse the result JSON
      let resultText = stdout.trim();
      try {
        const result = JSON.parse(resultText);
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Property set successfully!\n\nNode: ${result.node_path}\nProperty: ${result.property_path}\nValue: ${result.property_value}\n\nThe change is now saved in the scene file.`,
              },
            ],
          };
        }
      } catch (e) {
        // JSON parsing failed, use raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: `Property set.\n\nOutput: ${resultText}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set property: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Make sure the scene file is valid',
          'Check property value format (numbers, strings, Vector2, Color)',
        ]
      );
    }
  }

  /**
   * Handle the delete_node tool
   */
  private async handleDeleteNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and nodePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // Prevent deleting root node
    if (args.nodePath === 'root' || args.nodePath === '.' || args.nodePath === '') {
      return this.createErrorResponse(
        'Cannot delete root node',
        [
          'Use delete_scene to delete the entire scene file',
          'Or delete child nodes individually',
        ]
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
      };

      this.logDebug(`Deleting node ${args.nodePath} from ${args.scenePath}`);

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('delete_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to delete node: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node exists in the scene',
            'Root node cannot be deleted (delete the scene file instead)',
          ]
        );
      }

      // Parse the result JSON
      let resultText = stdout.trim();
      try {
        const result = JSON.parse(resultText);
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Node deleted successfully!\n\nDeleted: ${result.deleted_node}\nParent: ${result.parent_node}\nScene: ${result.scene_path}`,
              },
            ],
          };
        }
      } catch (e) {
        // JSON parsing failed, use raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node deleted.\n\nOutput: ${resultText}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to delete node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
          'Make sure the scene file is valid',
          'Ensure the node exists in the scene',
        ]
      );
    }
  }

  /**
   * Handle the build_csharp_project tool
   */
  private async handleBuildCSharpProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if this is a C# project
      const fs = await import('fs');
      const path = await import('path');
      
      const files = fs.readdirSync(args.projectPath);
      const csprojFiles = files.filter((f: string) => f.endsWith('.csproj'));
      
      if (csprojFiles.length === 0) {
        return this.createErrorResponse(
          'No C# project file found',
          [
            'This does not appear to be a C# Godot project',
            'Looked for .csproj files in the project directory',
            'For GDScript projects, C# compilation is not needed',
          ]
        );
      }

      const csprojFile = csprojFiles[0];
      const csprojPath = join(args.projectPath, csprojFile);

      this.logDebug(`Found C# project: ${csprojFile}`);

      // Determine build method
      const useGodotBuild = args.useGodotBuild === true;
      const configuration = args.configuration || 'Debug';

      let buildCommand: string;
      let buildArgs: string[];
      let buildDescription: string;

      if (useGodotBuild) {
        // Use Godot's built-in build command
        if (!this.godotPath) {
          await this.detectGodotPath();
        }
        
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Godot executable not found',
            [
              'Set GODOT_PATH environment variable',
              'Or use dotnet CLI build instead (useGodotBuild: false)',
            ]
          );
        }

        buildCommand = this.godotPath;
        buildArgs = ['--build-solutions', '--path', args.projectPath];
        buildDescription = `Godot build (${configuration})`;
      } else {
        // Use dotnet CLI
        buildCommand = 'dotnet';
        buildArgs = ['build', csprojPath, '-c', configuration];
        buildDescription = `dotnet build (${configuration})`;
      }

      this.logDebug(`Running: ${buildCommand} ${buildArgs.join(' ')}`);

      // Execute build
      const { stdout, stderr } = await execFileAsync(buildCommand, buildArgs, {
        cwd: args.projectPath,
        timeout: 120000, // 2 minute timeout for builds
      });

      const output = stdout || '';
      const errors = stderr || '';

      // Check for build success
      const hasErrors = errors.includes('error') || 
                       output.includes('Build FAILED') ||
                       output.includes('error CS');

      if (hasErrors) {
        // Try to extract error details
        const errorLines = (output + '\n' + errors)
          .split('\n')
          .filter((line: string) => 
            line.includes('error CS') || 
            line.includes('warning CS') ||
            line.includes('Build FAILED')
          )
          .slice(0, 20); // Limit to first 20 errors

        const errorDetails = errorLines.length > 0 
          ? errorLines.join('\n') 
          : (errors || output);

        return this.createErrorResponse(
          `C# build failed\n\nError details:\n${errorDetails}`,
          [
            'Fix the compilation errors listed above',
            'Check that all C# class names match their file names',
            'Ensure all referenced types are properly imported',
            'For Godot-specific errors, verify you\'re using the correct Godot C# API',
          ]
        );
      }

      // Parse success info
      const timeMatch = output.match(/Time Elapsed\s+([\d:]+)/);
      const timeElapsed = timeMatch ? timeMatch[1] : 'unknown';

      const warningCount = (output.match(/warning CS/g) || []).length;

      let responseText = `✅ **C# Build Successful**\n\n`;
      responseText += `Project: ${csprojFile}\n`;
      responseText += `Configuration: ${configuration}\n`;
      responseText += `Build method: ${buildDescription}\n`;
      responseText += `Time elapsed: ${timeElapsed}\n`;
      
      if (warningCount > 0) {
        responseText += `Warnings: ${warningCount}\n\n`;
        responseText += `*Tip: Run with Release configuration for optimized builds.*`;
      } else {
        responseText += `\nNo warnings! 🎉`;
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check for specific errors
      if (errorMessage.includes('dotnet') || errorMessage.includes('ENOENT')) {
        return this.createErrorResponse(
          'dotnet CLI not found',
          [
            'Install .NET SDK: https://dotnet.microsoft.com/download',
            'Ensure dotnet is in your system PATH',
            'Or use useGodotBuild: true to use Godot\'s built-in compiler',
          ]
        );
      }

      if (errorMessage.includes('timeout')) {
        return this.createErrorResponse(
          'Build timeout',
          [
            'Build took too long (over 2 minutes)',
            'Try building manually first to warm up the cache',
            'Check for complex dependencies that might slow down compilation',
          ]
        );
      }

      return this.createErrorResponse(
        `Build failed: ${errorMessage}`,
        [
          'Ensure .NET SDK is installed',
          'Verify the C# project file is valid',
          'Check that all NuGet packages are restored',
          'Try running "dotnet restore" manually first',
        ]
      );
    }
  }

  /**
   * Handle the smart_export tool - Export with auto-fix capabilities
   */
  private async handleSmartExport(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.presetName || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, presetName, and outputPath']
      );
    }

    const maxRetries = args.maxRetries || 3;
    const results: string[] = [];
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.error(`[SMART_EXPORT] Attempt ${attempt}/${maxRetries}...`);
      
      // For C# projects, try to build first
      const fs = await import('fs');
      const files = fs.readdirSync(args.projectPath);
      const hasCSharp = files.some((f: string) => f.endsWith('.csproj'));
      
      if (hasCSharp && attempt === 1) {
        results.push(`📦 Detected C# project, pre-compiling...`);
        const buildResult = await this.handleBuildCSharpProject({
          projectPath: args.projectPath,
          configuration: args.debug ? 'Debug' : 'Release',
        });
        
        if (buildResult.isError) {
          results.push(`⚠️ Build failed: ${buildResult.content[0].text}`);
          results.push(`🔄 Retrying export anyway...`);
        } else {
          results.push(`✅ C# build successful`);
        }
      }
      
      // Attempt export
      const exportResult = await this.handleExportProject({
        projectPath: args.projectPath,
        presetName: args.presetName,
        outputPath: args.outputPath,
        debug: args.debug,
      });
      
      if (!exportResult.isError) {
        // Success!
        let responseText = exportResult.content[0].text;
        if (results.length > 0) {
          responseText = `**Export Process Log:**\n\n${results.join('\n')}\n\n---\n\n${responseText}`;
        }
        return {
          content: [{ type: 'text', text: responseText }],
        };
      }
      
      // Export failed - analyze error
      const errorText = exportResult.content[0].text;
      results.push(`❌ Attempt ${attempt} failed: ${errorText.substring(0, 200)}...`);
      
      // Check if it's a fixable error
      if (errorText.includes('C# Compilation Errors') && hasCSharp) {
        results.push(`🔧 Attempting to fix C# errors...`);
        
        // Rebuild with detailed output
        const rebuildResult = await this.handleBuildCSharpProject({
          projectPath: args.projectPath,
          configuration: args.debug ? 'Debug' : 'Release',
        });
        
        if (!rebuildResult.isError) {
          results.push(`✅ Build fixed, retrying export...`);
          continue; // Retry export
        } else {
          results.push(`❌ Could not auto-fix C# errors`);
          return {
            content: [{
              type: 'text',
              text: `**Smart Export Failed After ${attempt} Attempts**\n\n${results.join('\n')}\n\n**C# compilation errors could not be automatically fixed.**\n\nPlease:\n1. Check the detailed error messages above\n2. Fix the code issues manually\n3. Or share the specific errors for AI-assisted debugging`,
            }],
            isError: true,
          };
        }
      }
      
      // Check for other auto-fixable errors
      if (errorText.includes('Resource Errors')) {
        results.push(`⚠️ Resource errors detected - may require manual asset fixing`);
      }
      
      // Non-fixable errors (templates, presets)
      if (errorText.includes('Export templates not installed') || 
          errorText.includes('Export preset not found')) {
        results.push(`❌ Setup error - requires manual Godot configuration`);
        return {
          content: [{
            type: 'text',
            text: `**Smart Export Failed**\n\n${results.join('\n')}\n\n${errorText}`,
          }],
          isError: true,
        };
      }
      
      // Last attempt failed
      if (attempt === maxRetries) {
        return {
          content: [{
            type: 'text',
            text: `**Smart Export Failed After ${maxRetries} Attempts**\n\n${results.join('\n')}\n\n**Final Error:**\n${errorText}\n\nPlease check the error details and try manual export or share the errors for debugging.`,
          }],
          isError: true,
        };
      }
      
      // Wait a bit before retry
      results.push(`⏳ Waiting before retry...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Should not reach here
    return this.createErrorResponse(
      'Export failed after maximum retries',
      ['Check the error logs above', 'Try manual export from Godot Editor']
    );
  }

  /**
   * Handle the export_project tool
   */
  private async handleExportProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.presetName || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, presetName, and outputPath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.outputPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Create output directory if it doesn't exist
      const outputDir = dirname(args.outputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
        this.logDebug(`Created output directory: ${outputDir}`);
      }

      // Build export command
      const isDebug = args.debug === true;
      const exportFlag = isDebug ? '--export-debug' : '--export-release';
      
      const exportArgs = [
        '--headless',
        exportFlag,
        args.presetName,
        args.outputPath,
      ];

      // Add optional PCK patch
      if (args.patches) {
        exportArgs.push('--export-patches', args.patches);
      }

      this.logDebug(`Exporting project: ${this.godotPath} ${exportArgs.join(' ')}`);

      // Execute export
      let stdout: string;
      let stderr: string;
      
      try {
        const result = await execFileAsync(this.godotPath!, exportArgs, {
          cwd: args.projectPath,
          timeout: 300000, // 5 minute timeout for exports
        });
        stdout = result.stdout || '';
        stderr = result.stderr || '';
      } catch (execError: any) {
        // Godot export may exit with non-zero code even on success
        stdout = execError.stdout || '';
        stderr = execError.stderr || '';
      }

      const output = stdout + '\n' + stderr;

      // Check for common export errors
      const hasExportErrors = 
        output.includes('Export template') && output.includes('not found') ||
        output.includes('Preset') && output.includes('not found') ||
        output.includes('Failed to export') ||
        output.includes('error CS') ||
        output.includes('GDScript');

      if (hasExportErrors) {
        const errorMatch = output.match(/ERROR:\s*(.+)/);
        const errorMessage = errorMatch ? errorMatch[1] : 'Unknown export error';

        // Handle C# compilation errors - CAN AUTO-FIX
        if (output.includes('error CS') || errorMessage.includes('Build FAILED')) {
          const autoFix = args.autoFix !== false; // Default to true
          
          if (autoFix) {
            console.error('[EXPORT] Detected C# compilation errors, attempting auto-fix...');
            
            // Extract C# errors
            const csErrors = output
              .split('\n')
              .filter((line: string) => line.includes('error CS'))
              .slice(0, 10);
            
            return {
              content: [
                {
                  type: 'text',
                  text: `⚠️ **Export Failed: C# Compilation Errors**\n\nDetected ${csErrors.length} C# errors:\n${csErrors.join('\n')}\n\n**Auto-fix available!**\n\nUse \`build_csharp_project\` to compile and fix errors:\n1. I will analyze the errors\n2. Fix the code issues\n3. Rebuild the project\n4. Then retry export\n\nWould you like me to attempt automatic repair?`,
                },
              ],
              isError: true,
              autoFixable: true,
              errorType: 'csharp_compile',
              suggestedAction: 'build_csharp_project',
            };
          }
        }

        // Handle GDScript errors - CAN AUTO-FIX (partially)
        if (output.includes('GDScript') && output.includes('error')) {
          const gdErrors = output
            .split('\n')
            .filter((line: string) => line.includes('GDScript') && line.includes('error'))
            .slice(0, 5);
          
          return {
            content: [
              {
                type: 'text',
                text: `⚠️ **Export Failed: GDScript Errors**\n\n${gdErrors.join('\n')}\n\nThese errors need to be fixed in the script files. I can help:\n1. Identify the problematic scripts\n2. Analyze and fix the errors\n3. Retry export\n\nPlease share the script content or let me analyze the project.`,
              },
            ],
            isError: true,
            autoFixable: true,
            errorType: 'gdscript_error',
          };
        }

        // Handle missing export templates - CANNOT AUTO-FIX
        if (errorMessage.includes('Export template')) {
          return this.createErrorResponse(
            `❌ **Export templates not installed**\n\nThis requires manual setup in Godot Editor:\n\n1. Open Godot Editor\n2. Go to Editor > Manage Export Templates\n3. Download templates for your Godot version\n4. Or manually download from https://godotengine.org/download\n\n*This cannot be automated through MCP.*`,
            [
              'Open Godot Editor',
              'Editor > Manage Export Templates',
              'Download and install templates',
              'Then retry export',
            ]
          );
        }

        // Handle missing preset - CANNOT AUTO-FIX
        if (errorMessage.includes('Preset')) {
          return this.createErrorResponse(
            `❌ **Export preset "${args.presetName}" not found**\n\nThis requires manual setup in Godot Editor:\n\n1. Open Godot Editor\n2. Go to Project > Export\n3. Click "Add..." and select your target platform\n4. Configure the preset settings\n5. Use the exact preset name in MCP\n\n*This cannot be automated through MCP.*`,
            [
              'Open Godot Editor',
              'Project > Export',
              'Create preset: "' + args.presetName + '"',
              'Suggested preset names:',
              '- "Windows Desktop"',
              '- "macOS"',
              '- "Linux/X11"',
              '- "Android"',
              '- "Web"',
            ]
          );
        }

        // Handle resource errors - PARTIALLY AUTO-FIXABLE
        if (output.includes('Resource') || output.includes('Failed to load')) {
          const resourceErrors = output
            .split('\n')
            .filter((line: string) => line.includes('Failed to load') || line.includes('Resource'))
            .slice(0, 5);
          
          return this.createErrorResponse(
            `⚠️ **Export Failed: Resource Errors**\n\n${resourceErrors.join('\n')}\n\nSome resources failed to load. Possible causes:\n- Missing or corrupted files\n- Incorrect file paths in scripts\n- Unsupported resource formats\n\n*I can help fix path references in scripts if you share the error details.*`,
            [
              'Check that all referenced files exist',
              'Verify file paths in scripts are correct',
              'Re-import any corrupted assets in Godot',
              'Check for case sensitivity issues in paths',
            ]
          );
        }

        // Generic export error
        return this.createErrorResponse(
          `❌ **Export failed: ${errorMessage}**`,
          [
            'Check that the export preset exists in Godot',
            'Ensure export templates are installed',
            'Verify you have write permissions to the output directory',
            'Check available disk space',
            'Look at the detailed error output above',
          ]
        );
      }

      // Check if output file was created
      if (!existsSync(args.outputPath)) {
        return this.createErrorResponse(
          'Export appeared to succeed but output file was not created',
          [
            'Check Godot output for warnings',
            'Verify the export preset is correctly configured',
            'Check that all resources are valid',
          ]
        );
      }

      // Get file size
      const fs = await import('fs');
      const stats = fs.statSync(args.outputPath);
      const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);

      // Parse export info from output
      const exportTimeMatch = output.match(/EXPORT_TIME:\s*([\d.]+)/);
      const exportTime = exportTimeMatch ? `${exportTimeMatch[1]}s` : 'unknown';

      let responseText = `✅ **Export Successful!**\n\n`;
      responseText += `Preset: ${args.presetName}\n`;
      responseText += `Output: ${args.outputPath}\n`;
      responseText += `File size: ${fileSizeMB} MB\n`;
      responseText += `Build type: ${isDebug ? 'Debug' : 'Release'}\n`;
      
      if (exportTime !== 'unknown') {
        responseText += `Export time: ${exportTime}\n`;
      }

      responseText += `\nYour game is ready to distribute! 🎉`;

      // Add platform-specific notes
      if (args.presetName.toLowerCase().includes('windows')) {
        responseText += `\n\n*Note: Windows exports may trigger antivirus false positives. Consider code signing for distribution.*`;
      } else if (args.presetName.toLowerCase().includes('mac')) {
        responseText += `\n\n*Note: macOS exports need code signing and notarization for distribution outside the App Store.*`;
      } else if (args.presetName.toLowerCase().includes('android')) {
        responseText += `\n\n*Note: Android exports need to be signed with a keystore for Google Play distribution.*`;
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (errorMessage.includes('timeout')) {
        return this.createErrorResponse(
          'Export timeout',
          [
            'Export took too long (over 5 minutes)',
            'Try exporting manually first to cache resources',
            'Check for large assets that may slow down export',
          ]
        );
      }

      return this.createErrorResponse(
        `Export failed: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify export templates are installed',
          'Check that the export preset exists',
          'Ensure you have write permissions to the output directory',
        ]
      );
    }
  }

  // ============================================================================
  // Editor Bridge Handlers
  // ============================================================================

  /**
   * Handle the install_editor_plugin tool
   */
  private async handleInstallEditorPlugin(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if project exists
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get plugin source path
      const pluginSourceDir = join(__dirname, 'editor_plugin', 'mcp_bridge');
      if (!existsSync(pluginSourceDir)) {
        return this.createErrorResponse(
          'Plugin source not found',
          [
            'The editor plugin may not be built yet',
            'Run npm run build first',
          ]
        );
      }

      // Create addons directory if needed
      const addonsDir = join(args.projectPath, 'addons');
      if (!existsSync(addonsDir)) {
        mkdirSync(addonsDir, { recursive: true });
      }

      // Copy plugin to project
      const pluginTargetDir = join(addonsDir, 'mcp_bridge');
      if (!existsSync(pluginTargetDir)) {
        mkdirSync(pluginTargetDir, { recursive: true });
      }

      // Copy plugin files
      const pluginFiles = readdirSync(pluginSourceDir);
      
      for (const file of pluginFiles) {
        const srcPath = join(pluginSourceDir, file);
        const destPath = join(pluginTargetDir, file);
        copyFileSync(srcPath, destPath);
      }

      // Enable plugin in project.godot
      const projectContent = readFileSync(projectFile, 'utf8');
      
      // Check if plugin is already enabled
      if (!projectContent.includes('mcp_bridge')) {
        // Add plugin to [editor_plugins] section
        let newContent = projectContent;
        
        if (!projectContent.includes('[editor_plugins]')) {
          newContent += '\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/mcp_bridge/plugin.cfg")';
        } else {
          // Append to existing enabled list
          newContent = projectContent.replace(
            /enabled=PackedStringArray\(([^)]*)\)/,
            (match: string, existing: string) => {
              const plugins = existing ? existing.split(',').map((s: string) => s.trim()) : [];
              plugins.push('"res://addons/mcp_bridge/plugin.cfg"');
              return `enabled=PackedStringArray(${plugins.join(', ')})`;
            }
          );
        }
        
        writeFileSync(projectFile, newContent);
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ MCP Bridge plugin installed successfully!\n\nLocation: ${pluginTargetDir}\n\n**Next steps:**\n1. Open the Godot Editor for this project\n2. Go to Project > Project Settings > Plugins\n3. Verify "MCP Editor Bridge" is enabled\n4. Use \`connect_editor\` to establish connection\n\nThe plugin will start listening on port 9742 when the editor loads.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to install plugin: ${error?.message || 'Unknown error'}`,
        [
          'Ensure you have write permissions to the project directory',
          'Check if the project path is correct',
          'Verify the plugin source files exist',
        ]
      );
    }
  }

  /**
   * Handle the connect_editor tool
   */
  private async handleConnectEditor() {
    try {
      if (this.editorBridge.isConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: '✅ Already connected to Godot Editor',
            },
          ],
        };
      }

      await this.editorBridge.connect();
      
      // Test the connection with a ping
      const response = await this.editorBridge.sendCommand('ping');
      
      if (response.success) {
        const version = response.data?.godot_version || {};
        return {
          content: [
            {
              type: 'text',
              text: `✅ Connected to Godot Editor!\n\nGodot Version: ${version.major || '?'}.${version.minor || '?'}.${version.patch || '?'}\nConnection: 127.0.0.1:9742\n\nYou can now use editor bridge commands to interact with the editor.`,
            },
          ],
        };
      } else {
        return this.createErrorResponse(
          'Connection test failed',
          ['The plugin may not be fully initialized yet']
        );
      }
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to connect: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot Editor is running',
          'Verify the MCP Bridge plugin is installed and enabled',
          'Check that the plugin shows a green indicator in Project Settings',
          'Try restarting Godot Editor if the plugin was just enabled',
          'Make sure port 9742 is not blocked by firewall',
        ]
      );
    }
  }

  /**
   * Handle the disconnect_editor tool
   */
  private async handleDisconnectEditor() {
    this.editorBridge.disconnect();
    return {
      content: [
        {
          type: 'text',
          text: 'Disconnected from Godot Editor',
        },
      ],
    };
  }

  // ============================================================================
  // Auto-Detection Tool Handlers
  // ============================================================================

  /**
   * Handle the detect_godot_project tool
   */
  private async handleDetectGodotProject() {
    try {
      const projectPath = await this.detectRunningGodotProject();
      
      if (!projectPath) {
        // Return recent projects as fallback
        const recent = this.recentProjects.length > 0 
          ? `\n\nRecently used projects:\n${this.recentProjects.slice(0, 5).map(p => `- ${p}`).join('\n')}`
          : '';
          
        return this.createErrorResponse(
          'No running Godot Editor detected',
          [
            'Ensure Godot Editor is running with a project open',
            'Check that Godot process is visible in Task Manager (Windows) or Activity Monitor (macOS)',
            ...recent ? [recent] : []
          ]
        );
      }

      // Get project name from project.godot
      let projectName = basename(projectPath);
      try {
        const projectFile = join(projectPath, 'project.godot');
        const content = readFileSync(projectFile, 'utf8');
        const nameMatch = content.match(/config\/name="([^"]+)"/);
        if (nameMatch) {
          projectName = nameMatch[1];
        }
      } catch {}

      return {
        content: [
          {
            type: 'text',
            text: `✅ Detected running Godot project!\n\n**Project Name:** ${projectName}\n**Path:** \`${projectPath}\`\n\nNext steps:\n1. ${existsSync(join(projectPath, 'addons', 'mcp_bridge')) ? 'Plugin already installed ✅' : 'Run: install_editor_plugin({projectPath: "' + projectPath + '"})'}\n2. Connect: connect_editor({})`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Detection failed: ${error?.message || 'Unknown error'}`,
        ['Try providing the project path manually']
      );
    }
  }

  /**
   * Handle the auto_setup_editor tool
   */
  private async handleAutoSetupEditor(args: any) {
    args = this.normalizeParameters(args);
    const installIfNeeded = args.installPluginIfNeeded !== false;

    this.logDebug('Auto-setup: Starting detection...');

    // Step 1: Detect running project
    const detection = await this.autoDetectAndConnect();
    
    if (!detection.success) {
      // If detection failed but we have a project path, try to install plugin
      if (detection.projectPath && installIfNeeded && detection.error?.includes('plugin not installed')) {
        this.logDebug('Auto-setup: Plugin not installed, installing...');
        
        const installResult = await this.handleInstallEditorPlugin({ projectPath: detection.projectPath });
        
        if (!installResult.isError) {
          return {
            content: [
              {
                type: 'text',
                text: `📦 Plugin installed to: ${detection.projectPath}\n\n**Please restart Godot Editor with the plugin enabled, then run this command again.**\n\nSteps:\n1. Close Godot Editor\n2. Reopen it (plugin will auto-enable)\n3. Run auto_setup_editor again`,
              },
            ],
          };
        }
        
        return installResult;
      }
      
      return this.createErrorResponse(
        detection.error || 'Auto-setup failed',
        ['Open Godot Editor manually', 'Or provide project path: get_project_info({projectPath: "..."})']
      );
    }

    // Add to recent projects
    if (detection.projectPath) {
      this.addRecentProject(detection.projectPath);
    }

    // Build response
    let text = `✅ **Auto-setup complete!**\n\n`;
    text += `**Project:** ${detection.projectPath}\n`;
    
    if (detection.sceneInfo) {
      text += `**Current Scene:** ${detection.sceneInfo.sceneName || 'Unsaved'}\n`;
      text += `**Scene Path:** ${detection.sceneInfo.scenePath || 'N/A'}\n`;
      text += `**Game Running:** ${detection.sceneInfo.isPlaying ? 'Yes 🎮' : 'No'}\n`;
      text += `**Has Selection:** ${detection.sceneInfo.hasSelection ? 'Yes' : 'No'}\n`;
    }
    
    text += `\n**Status:** ${detection.isNewConnection ? 'New connection established' : 'Using existing connection'}\n`;
    text += `\nYou can now use editor commands:\n- get_current_scene_auto({})\n- screenshot_current_scene({})\n- get_editor_selection({})`;

    return {
      content: [
        {
          type: 'text',
          text: text,
        },
      ],
    };
  }

  /**
   * Handle the get_current_scene_auto tool
   */
  private async handleGetCurrentSceneAuto(args: any) {
    args = this.normalizeParameters(args);
    const includeTree = args.includeTree !== false;
    const includeProperties = args.includeProperties === true;

    // Ensure we're connected
    const detection = await this.autoDetectAndConnect();
    
    if (!detection.success) {
      return this.createErrorResponse(
        detection.error || 'Failed to connect to editor',
        ['Run auto_setup_editor({}) first', 'Or ensure Godot Editor is running']
      );
    }

    try {
      let responseText = `## Current Scene\n\n`;
      
      if (detection.sceneInfo) {
        responseText += `**Scene:** ${detection.sceneInfo.sceneName || 'Unsaved'}\n`;
        responseText += `**Path:** \`${detection.sceneInfo.scenePath || 'N/A'}\`\n`;
        responseText += `**Playing:** ${detection.sceneInfo.isPlaying ? 'Yes 🎮' : 'No'}\n\n`;
      }

      // Get selection info
      const selectionResponse = await this.editorBridge.sendCommand('get_selection');
      if (selectionResponse.success && selectionResponse.data.count > 0) {
        responseText += `**Selected Nodes (${selectionResponse.data.count}):**\n`;
        for (const node of selectionResponse.data.nodes) {
          responseText += `- ${node.name} (${node.type})\n`;
        }
        responseText += '\n';

        // Optionally get properties of first selected node
        if (includeProperties && selectionResponse.data.nodes.length > 0) {
          const firstNode = selectionResponse.data.nodes[0];
          const propsResponse = await this.editorBridge.sendCommand('get_node_properties', {
            node_path: firstNode.path,
            include_defaults: false
          });
          
          if (propsResponse.success) {
            responseText += `### ${firstNode.name} Properties\n`;
            const props = propsResponse.data.properties.slice(0, 10);
            for (const prop of props) {
              const val = typeof prop.value === 'object' ? JSON.stringify(prop.value) : prop.value;
              responseText += `- ${prop.name}: ${val}\n`;
            }
            if (propsResponse.data.properties.length > 10) {
              responseText += `- ... and ${propsResponse.data.properties.length - 10} more\n`;
            }
            responseText += '\n';
          }
        }
      } else {
        responseText += `*No nodes selected*\n\n`;
      }

      // Optionally get scene tree
      if (includeTree) {
        const treeResponse = await this.editorBridge.sendCommand('get_scene_tree', { max_depth: 3 });
        if (treeResponse.success) {
          responseText += `### Scene Tree (depth: 3)\n`;
          
          const formatNode = (node: any, indent: string = ''): string => {
            let result = `${indent}- **${node.name}** (${node.type})\n`;
            if (node.children && node.children.length > 0) {
              for (const child of node.children.slice(0, 5)) {
                result += formatNode(child, indent + '  ');
              }
              if (node.children.length > 5) {
                result += `${indent}  ... and ${node.children.length - 5} more children\n`;
              }
            }
            return result;
          };
          
          responseText += formatNode(treeResponse.data.root);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get scene info: ${error?.message || 'Unknown error'}`,
        []
      );
    }
  }

  /**
   * Handle the screenshot_current_scene tool - Windows native screenshot
   */
  private async handleScreenshotCurrentScene(args: any) {
    args = this.normalizeParameters(args);

    // Step 1: Get project path from recent projects or args
    let projectPath = args.projectPath;
    if (!projectPath && this.recentProjects.length > 0) {
      projectPath = this.recentProjects[0];
    }
    
    if (!projectPath) {
      return this.createErrorResponse(
        'No project path available',
        ['Run auto_setup_editor({}) first', 'Or provide projectPath parameter']
      );
    }

    // Step 2: Generate output path
    const timestamp = Date.now();
    const screenshotDir = join(projectPath, 'screenshots');
    if (!existsSync(screenshotDir)) {
      mkdirSync(screenshotDir, { recursive: true });
    }
    
    const sceneName = 'editor_capture';
    const outputPath = args.outputPath || `screenshots/${sceneName}_${timestamp}.png`;
    const fullOutputPath = outputPath.startsWith('/') || outputPath.includes(':') 
      ? outputPath 
      : join(projectPath, outputPath);

    const outputDir = dirname(fullOutputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    this.logDebug(`Windows screenshot: ${projectPath} -> ${fullOutputPath}`);

    try {
      const delay = args.delay || 2; // seconds - default 2s for stability
      const delayMs = Math.round(delay * 1000);

      // Use PowerShell for screenshot - write script to temp file for reliability
      const tempScriptPath = join(projectPath, 'screenshots', `_screenshot_${timestamp}.ps1`);
      
      // Escape backslashes in path for PowerScript
      const psSafePath = fullOutputPath.replace(/\\/g, '\\');
      
      const psScript = `# Screenshot script
$wshell = New-Object -ComObject WScript.Shell
$godotActivated = $wshell.AppActivate("Godot Engine")
if (-not $godotActivated) {
    $godotActivated = $wshell.AppActivate("Godot")
}
if ($godotActivated) {
    Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds ${delayMs}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save("${psSafePath}")
$graphics.Dispose()
$bitmap.Dispose()
Write-Host "Screenshot saved to: ${psSafePath}"
`;

      // Write script to temp file
      writeFileSync(tempScriptPath, psScript, 'utf8');
      this.logDebug(`PowerShell script written to: ${tempScriptPath}`);

      // Execute PowerShell script file
      await execAsync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tempScriptPath}"`, {
        timeout: 30000 // 30 second timeout
      });

      // Clean up temp script
      try {
        unlinkSync(tempScriptPath);
      } catch { /* ignore cleanup errors */ }

      // Verify screenshot
      if (existsSync(fullOutputPath)) {
        const stats = statSync(fullOutputPath);
        const sizeInKB = Math.round(stats.size / 1024);
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Screenshot captured successfully!\n\n` +
                    `📁 Project: ${projectPath}\n` +
                    `💾 Output: ${outputPath}\n` +
                    `📍 Full path: ${fullOutputPath}\n` +
                    `📊 File size: ${sizeInKB} KB\n` +
                    `⏱️ Delay: ${delay}s`,
            },
          ],
        };
      } else {
        throw new Error('Screenshot file was not created');
      }

    } catch (error: any) {
      this.logDebug(`Screenshot failed: ${error.message}`);
      return this.createErrorResponse(
        `Failed to capture screenshot: ${error.message}`,
        [
          'Ensure Godot Editor is running and visible on screen',
          'Try increasing the delay parameter (e.g., delay: 3)',
          'Check if PowerShell is available on your system',
          'Verify the output directory is writable'
        ]
      );
    }
  }

  /**
   * Handle the get_recent_projects tool
   */
  private async handleGetRecentProjects() {
    if (this.recentProjects.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No recent projects found.\n\nUse detect_godot_project({}) or work with a project to populate this list.',
          },
        ],
      };
    }

    // Verify each project still exists
    const validProjects = [];
    for (const path of this.recentProjects) {
      if (existsSync(join(path, 'project.godot'))) {
        validProjects.push(path);
      }
    }
    
    // Update cache if some were removed
    if (validProjects.length !== this.recentProjects.length) {
      this.recentProjects = validProjects;
      this.saveRecentProjects();
    }

    let text = `## Recent Godot Projects (${validProjects.length})\n\n`;
    for (let i = 0; i < validProjects.length; i++) {
      text += `${i + 1}. \`${validProjects[i]}\`\n`;
    }
    
    text += `\nTo use a recent project:\n`;
    text += `\`\`\`\nget_project_info({projectPath: "${validProjects[0]}"})\n\`\`\``;

    return {
      content: [
        {
          type: 'text',
          text: text,
        },
      ],
    };
  }

  /**
   * Handle the get_editor_state tool
   */
  private async handleGetEditorState() {
    try {
      const response = await this.editorBridge.sendCommand('get_editor_state');
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to get editor state',
          ['Ensure a scene is open in the editor']
        );
      }

      const data = response.data;
      let text = `## Godot Editor State\n\n`;
      text += `- **Current Scene**: ${data.current_scene || 'None'}\n`;
      text += `- **Scene Path**: ${data.current_scene_path || 'N/A'}\n`;
      text += `- **Is Playing**: ${data.is_playing ? 'Yes 🎮' : 'No'}\n`;
      text += `- **Has Selection**: ${data.has_selection ? 'Yes' : 'No'}\n`;
      text += `- **Selection Count**: ${data.selection_count}\n`;

      return {
        content: [
          {
            type: 'text',
            text: text,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get editor state: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor via connect_editor']
      );
    }
  }

  /**
   * Handle the get_editor_selection tool
   */
  private async handleGetEditorSelection() {
    try {
      const response = await this.editorBridge.sendCommand('get_selection');
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to get selection',
          []
        );
      }

      const data = response.data;
      
      if (data.count === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No nodes are currently selected in the editor.',
            },
          ],
        };
      }

      let text = `## Selected Nodes (${data.count})\n\n`;
      
      for (const node of data.nodes) {
        text += `- **${node.name}** (${node.type})\n`;
        text += `  - Path: \`${node.path}\`\n`;
        if (node.scene_path) {
          text += `  - Scene: \`${node.scene_path}\`\n`;
        }
        text += '\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: text,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get selection: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the select_node_in_editor tool
   */
  private async handleSelectNodeInEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.nodePath) {
      return this.createErrorResponse(
        'Node path is required',
        ['Provide a valid node path (e.g., "Player/Sprite2D")']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('select_node', {
        node_path: args.nodePath
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to select node',
          ['Check that the node path is correct']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Selected node: **${response.data.name}**\n\nPath: \`${response.data.path}\`\n\nThe node is now highlighted in the scene tree and inspector.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to select node: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the get_scene_tree_from_editor tool
   */
  private async handleGetSceneTreeFromEditor(args: any) {
    args = this.normalizeParameters(args);
    
    try {
      const response = await this.editorBridge.sendCommand('get_scene_tree', {
        max_depth: args.maxDepth || 10
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to get scene tree',
          ['Ensure a scene is open in the editor']
        );
      }

      const data = response.data;
      
      function formatNode(node: any, indent: string = ''): string {
        let result = `${indent}- **${node.name}** (${node.type})\n`;
        if (node.children && node.children.length > 0) {
          for (const child of node.children) {
            result += formatNode(child, indent + '  ');
          }
        }
        if (node.has_more_children) {
          result += `${indent}  ... and ${node.child_count - (node.children?.length || 0)} more children\n`;
        }
        return result;
      }

      let text = `## Scene Tree: ${data.root.name}\n\n`;
      text += `Scene Path: \`${data.scene_path || 'unsaved'}\`\n\n`;
      text += formatNode(data.root);

      return {
        content: [
          {
            type: 'text',
            text: text,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get scene tree: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the get_node_properties_from_editor tool
   */
  private async handleGetNodePropertiesFromEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.nodePath) {
      return this.createErrorResponse(
        'Node path is required',
        ['Provide a valid node path (e.g., "Player/Sprite2D")']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('get_node_properties', {
        node_path: args.nodePath,
        include_defaults: args.includeDefaults || false
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to get node properties',
          ['Check that the node path is correct']
        );
      }

      const data = response.data;
      let text = `## Properties: ${data.node} (${data.type})\n\n`;
      
      // Group properties by type/category (simplified)
      const grouped: Record<string, any[]> = {};
      
      for (const prop of data.properties) {
        const category = prop.name.includes('/') ? prop.name.split('/')[0] : 'General';
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push(prop);
      }
      
      for (const [category, props] of Object.entries(grouped)) {
        text += `### ${category}\n`;
        for (const prop of props.slice(0, 20)) {  // Limit per category
          const valueStr = typeof prop.value === 'object' 
            ? JSON.stringify(prop.value) 
            : String(prop.value);
          text += `- **${prop.name}**: ${valueStr} (${prop.type_name || prop.type})\n`;
        }
        if (props.length > 20) {
          text += `- ... and ${props.length - 20} more\n`;
        }
        text += '\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: text,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get node properties: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the set_node_property_in_editor tool
   */
  private async handleSetNodePropertyInEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.nodePath || !args.property || args.value === undefined) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide nodePath, property, and value']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('set_node_property', {
        node_path: args.nodePath,
        property: args.property,
        value: args.value
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to set property',
          ['Check that the node path and property name are correct']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Property set successfully!\n\nNode: **${response.data.node}**\nProperty: \`${response.data.property}\`\nNew Value: \`${JSON.stringify(response.data.value)}\`\n\nThe scene has been marked as modified (unsaved).`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set property: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the open_scene_in_editor tool
   */
  private async handleOpenSceneInEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.scenePath) {
      return this.createErrorResponse(
        'Scene path is required',
        ['Provide a valid scene path (e.g., "scenes/main.tscn")']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('open_scene', {
        scene_path: args.scenePath
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to open scene',
          ['Check that the scene file exists']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Scene opened: **${response.data.scene_path}**\n\nThe editor has switched to this scene.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to open scene: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the save_scene_in_editor tool
   */
  private async handleSaveSceneInEditor() {
    try {
      const response = await this.editorBridge.sendCommand('save_scene');
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to save scene',
          ['Check that a scene is open and has a valid path']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Scene saved: **${response.data.scene_path}**`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the inspect_node_in_editor tool
   */
  private async handleInspectNodeInEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.nodePath) {
      return this.createErrorResponse(
        'Node path is required',
        ['Provide a valid node path (e.g., "Player/Sprite2D")']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('inspect_node', {
        node_path: args.nodePath
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to inspect node',
          ['Check that the node path is correct']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Inspecting node: **${response.data.name}** (${response.data.type})\n\nPath: \`${response.data.path}\`\n\nThe node is now shown in the Inspector panel.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to inspect node: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  /**
   * Handle the execute_code_in_editor tool
   */
  private async handleExecuteCodeInEditor(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.code) {
      return this.createErrorResponse(
        'Code is required',
        ['Provide GDScript code to execute']
      );
    }

    try {
      const response = await this.editorBridge.sendCommand('execute_code', {
        code: args.code
      });
      
      if (!response.success) {
        return this.createErrorResponse(
          response.error || 'Failed to execute code',
          []
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Code executed successfully!\n\n**Output:**\n\`\`\`\n${JSON.stringify(response.data.output, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to execute code: ${error?.message || 'Unknown error'}`,
        ['Ensure you are connected to the editor']
      );
    }
  }

  // === NEW HANDLER METHODS ===

  /**
   * Handle read_script tool
   */
  private async handleReadScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath) {
      return this.createErrorResponse('projectPath and scriptPath are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.readScript(args.scriptPath);
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to read script');
      }

      let content = result.info!.content;
      let lineCount = result.info!.lineCount;

      // Handle line range
      if (args.lineStart !== undefined || args.lineEnd !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (args.lineStart || 1) - 1);
        const end = Math.min(lines.length, args.lineEnd || lines.length);
        content = lines.slice(start, end).join('\n');
        lineCount = end - start;
      }

      return {
        content: [
          {
            type: 'text',
            text: `## Script: ${args.scriptPath}\n` +
                  `**Language:** ${result.info!.language}\n` +
                  `**Total Lines:** ${result.info!.lineCount}\n\n` +
                  `\`\`\`${result.info!.language}\n${content}\n\`\`\``,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read script: ${error.message}`);
    }
  }

  /**
   * Handle write_script tool
   */
  private async handleWriteScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath || args.content === undefined) {
      return this.createErrorResponse('projectPath, scriptPath, and content are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.writeScript(
        args.scriptPath, 
        args.content,
        { backup: args.backup !== false }
      );
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to write script');
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Script written successfully: ${args.scriptPath}\n\n` +
                  `${args.backup !== false ? 'Backup created.' : 'No backup.'}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to write script: ${error.message}`);
    }
  }

  /**
   * Handle create_script tool
   */
  private async handleCreateScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath || !args.language) {
      return this.createErrorResponse('projectPath, scriptPath, and language are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.createScript(
        args.scriptPath,
        args.language,
        args.template || 'empty'
      );
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to create script');
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Script created: ${args.scriptPath}\n\n` +
                  `**Language:** ${args.language}\n` +
                  `**Template:** ${args.template || 'empty'}\n\n` +
                  `\`\`\`${args.language}\n${result.content}\n\`\`\``,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create script: ${error.message}`);
    }
  }

  /**
   * Handle edit_script tool
   */
  private async handleEditScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath || 
        args.lineStart === undefined || args.lineEnd === undefined || 
        args.newContent === undefined) {
      return this.createErrorResponse('projectPath, scriptPath, lineStart, lineEnd, and newContent are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.replaceLines(
        args.scriptPath,
        { start: args.lineStart, end: args.lineEnd },
        args.newContent
      );
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to edit script');
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Script edited: ${args.scriptPath}\n` +
                  `Lines ${args.lineStart}-${args.lineEnd} replaced.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to edit script: ${error.message}`);
    }
  }

  /**
   * Handle search_in_script tool
   */
  private async handleSearchInScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath || !args.pattern) {
      return this.createErrorResponse('projectPath, scriptPath, and pattern are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.search(args.scriptPath, args.pattern);
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to search script');
      }

      const matches = result.matches || [];
      
      let text = `## Search Results: ${args.scriptPath}\n\n`;
      text += `**Pattern:** "${args.pattern}"\n`;
      text += `**Matches:** ${matches.length}\n\n`;

      if (matches.length > 0) {
        for (const match of matches.slice(0, 20)) {
          text += `**Line ${match.line}:** \`${match.content}\`\n`;
        }
        if (matches.length > 20) {
          text += `\n... and ${matches.length - 20} more matches`;
        }
      } else {
        text += 'No matches found.';
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to search script: ${error.message}`);
    }
  }

  /**
   * Handle replace_in_script tool
   */
  private async handleReplaceInScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scriptPath || 
        args.search === undefined || args.replace === undefined) {
      return this.createErrorResponse('projectPath, scriptPath, search, and replace are required');
    }

    try {
      const scriptManager = new ScriptManager(args.projectPath);
      const result = scriptManager.replaceAll(
        args.scriptPath,
        args.search,
        args.replace
      );
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to replace in script');
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Replaced in ${args.scriptPath}\n\n` +
                  `"${args.search}" → "${args.replace}"\n` +
                  `${result.count} occurrence(s) replaced.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to replace in script: ${error.message}`);
    }
  }

  /**
   * Handle import_asset tool
   */
  private async handleImportAsset(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.sourcePath || !args.targetPath) {
      return this.createErrorResponse('projectPath, sourcePath, and targetPath are required');
    }

    try {
      const assetManager = new AssetManager(args.projectPath);
      const result = assetManager.importAsset(
        args.sourcePath,
        args.targetPath,
        { overwrite: args.overwrite === true }
      );
      
      if (!result.success) {
        return this.createErrorResponse(result.error || 'Failed to import asset');
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Asset imported\n\n` +
                  `**From:** ${args.sourcePath}\n` +
                  `**To:** ${args.targetPath}\n` +
                  `**Type:** ${result.info?.type}\n` +
                  `**Size:** ${Math.round((result.info?.size || 0) / 1024)} KB`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to import asset: ${error.message}`);
    }
  }

  /**
   * Handle scan_assets tool
   */
  private async handleScanAssets(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse('projectPath is required');
    }

    try {
      const assetManager = new AssetManager(args.projectPath);
      const assets = assetManager.scanDirectory(args.directory || '.', {
        recursive: args.recursive !== false,
        typeFilter: args.typeFilter
      });

      // 按类型分组
      const byType: Record<string, AssetInfo[]> = {};
      for (const asset of assets) {
        if (!byType[asset.type]) byType[asset.type] = [];
        byType[asset.type].push(asset);
      }

      let text = `## Project Assets\n\n`;
      text += `**Total:** ${assets.length} files\n\n`;

      for (const [type, items] of Object.entries(byType)) {
        text += `### ${type} (${items.length})\n`;
        for (const item of items.slice(0, 10)) {
          text += `- \`${item.path}\` (${Math.round(item.size / 1024)} KB)\n`;
        }
        if (items.length > 10) {
          text += `- ... and ${items.length - 10} more\n`;
        }
        text += '\n';
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to scan assets: ${error.message}`);
    }
  }

  /**
   * Handle analyze_assets tool
   */
  private async handleAnalyzeAssets(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse('projectPath is required');
    }

    try {
      const assetManager = new AssetManager(args.projectPath);
      const analysis = assetManager.analyzeAssets({
        findUnused: args.findUnused === true,
        findDuplicates: args.findDuplicates === true
      });

      let text = `## Asset Analysis\n\n`;

      if (args.findUnused && analysis.unused) {
        text += `### Unused Assets (${analysis.unused.length})\n`;
        if (analysis.unused.length > 0) {
          for (const path of analysis.unused.slice(0, 20)) {
            text += `- \`${path}\`\n`;
          }
          if (analysis.unused.length > 20) {
            text += `- ... and ${analysis.unused.length - 20} more\n`;
          }
        } else {
          text += 'No unused assets found.\n';
        }
        text += '\n';
      }

      if (args.findDuplicates && analysis.duplicates) {
        text += `### Duplicate Groups (${analysis.duplicates.length})\n`;
        if (analysis.duplicates.length > 0) {
          for (const group of analysis.duplicates) {
            text += `**${group.hash}:**\n`;
            for (const file of group.files) {
              text += `- \`${file}\`\n`;
            }
          }
        } else {
          text += 'No duplicates found.\n';
        }
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to analyze assets: ${error.message}`);
    }
  }

  /**
   * Handle modify_tilemap tool
   */
  private async handleModifyTileMap(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.tileMapNodePath || !args.operations) {
      return this.createErrorResponse('projectPath, scenePath, tileMapNodePath, and operations are required');
    }

    try {
      // 使用 Godot 脚本来修改 TileMap
      const operations = args.operations.map((op: any) => {
        switch (op.type) {
          case 'set_cell':
            return `
tilemap.set_cell(${op.layerIndex || 0}, Vector2i(${op.coords.x}, ${op.coords.y})${op.atlasCoords ? `, 0, Vector2i(${op.atlasCoords.x}, ${op.atlasCoords.y})` : op.sourceId !== undefined ? `, ${op.sourceId}` : ''})`;
          case 'erase_cell':
            return `
tilemap.erase_cell(${op.layerIndex || 0}, Vector2i(${op.coords.x}, ${op.coords.y}))`;
          case 'clear_layer':
            return `
tilemap.clear_layer(${op.layerIndex || 0})`;
          default:
            return '';
        }
      }).join('');

      const scriptContent = `
extends SceneTree

func _init():
    var scene = load("res://${args.scenePath}")
    if scene == null:
        printerr("Failed to load scene: ${args.scenePath}")
        quit(1)
    
    var instance = scene.instantiate()
    var tilemap = instance.get_node("${args.tileMapNodePath.replace('root/', '')}")
    if tilemap == null:
        printerr("TileMap not found: ${args.tileMapNodePath}")
        quit(1)
    
    ${operations}
    
    var packed = PackedScene.new()
    var err = packed.pack(instance)
    if err != OK:
        printerr("Failed to pack scene")
        quit(1)
    
    err = ResourceSaver.save(packed, "res://${args.scenePath}")
    if err != OK:
        printerr("Failed to save scene")
        quit(1)
    
    print("TileMap modified successfully")
    quit()
`;

      // 执行临时脚本
      const tempScriptPath = join(args.projectPath, '.temp_tilemap_edit.gd');
      writeFileSync(tempScriptPath, scriptContent, 'utf-8');

      try {
        await execFileAsync(this.godotPath!, [
          '--headless',
          '--script',
          tempScriptPath,
          '--path',
          args.projectPath
        ]);

        return {
          content: [
            {
              type: 'text',
              text: `✅ TileMap modified: ${args.tileMapNodePath}\n` +
                    `${args.operations.length} operation(s) applied.`,
            },
          ],
        };
      } finally {
        // 清理临时文件
        try { unlinkSync(tempScriptPath); } catch {}
      }
    } catch (error: any) {
      return this.createErrorResponse(`Failed to modify TileMap: ${error.message}`);
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
