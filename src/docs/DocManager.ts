/**
 * Godot Documentation Manager
 * 
 * Manages Godot class documentation with the following features:
 * - Downloads documentation from Godot GitHub on first use
 * - Caches documentation locally for offline queries
 * - Supports multiple Godot versions
 * - Provides validation and search capabilities
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ClassDoc {
  name: string;
  extends?: string;
  brief_description?: string;
  description?: string;
  methods?: MethodDoc[];
  properties?: PropertyDoc[];
  signals?: SignalDoc[];
  constants?: ConstantDoc[];
  enums?: EnumDoc[];
}

export interface MethodDoc {
  name: string;
  return_type?: string;
  arguments?: ArgumentDoc[];
  description?: string;
  is_virtual?: boolean;
  is_static?: boolean;
}

export interface PropertyDoc {
  name: string;
  type?: string;
  description?: string;
  default_value?: string;
  setter?: string;
  getter?: string;
}

export interface SignalDoc {
  name: string;
  arguments?: ArgumentDoc[];
  description?: string;
}

export interface ConstantDoc {
  name: string;
  value?: string;
  description?: string;
}

export interface EnumDoc {
  name: string;
  values?: ConstantDoc[];
}

export interface ArgumentDoc {
  name: string;
  type?: string;
  default_value?: string;
}

export interface QueryResult {
  found: boolean;
  class?: ClassDoc;
  member?: MethodDoc | PropertyDoc | SignalDoc | ConstantDoc;
  memberType?: 'method' | 'property' | 'signal' | 'constant' | 'enum';
  suggestions?: string[];
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  suggestions?: string[];
  corrected?: string;
}

export class DocManager {
  private docsPath: string;
  private docs: Map<string, ClassDoc> = new Map();
  private version: string;
  private loaded: boolean = false;

  constructor(godotVersion: string = '4.2') {
    this.version = godotVersion;
    // Store docs in user's home directory for persistence
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    this.docsPath = join(homeDir, '.godot-mcp', 'docs', this.version);
  }

  /**
   * Initialize the documentation manager
   * Downloads docs if not present locally
   */
  async initialize(): Promise<boolean> {
    try {
      // Ensure directory exists
      if (!existsSync(this.docsPath)) {
        mkdirSync(this.docsPath, { recursive: true });
      }

      // Check if we already have cached docs
      const indexPath = join(this.docsPath, 'index.json');
      if (existsSync(indexPath)) {
        await this.loadLocalDocs();
        return true;
      }

      // Download docs from Godot GitHub
      return await this.downloadDocs();
    } catch (error) {
      console.error('[DocManager] Failed to initialize:', error);
      return false;
    }
  }

  /**
   * Download documentation from Godot GitHub repository
   */
  private async downloadDocs(): Promise<boolean> {
    console.log(`[DocManager] Downloading Godot ${this.version} documentation...`);

    try {
      // Map version to GitHub branch/tag
      const branchMap: Record<string, string> = {
        '4.0': '4.0',
        '4.1': '4.1',
        '4.2': '4.2',
        '4.3': '4.3',
        '4.4': 'master', // 4.4 is still in development as of this writing
      };
      
      const branch = branchMap[this.version] || 'master';
      
      // For core classes, we'll use a curated list of commonly used classes
      // Godot's doc/classes folder contains XML files
      const baseUrl = `https://raw.githubusercontent.com/godotengine/godot/${branch}/doc/classes`;
      
      // Essential classes to download
      const essentialClasses = [
        '@GlobalScope',
        'Node',
        'Node2D',
        'Node3D',
        'Control',
        'CanvasItem',
        'Button',
        'Label',
        'TextureRect',
        'HBoxContainer',
        'VBoxContainer',
        'GridContainer',
        'CharacterBody2D',
        'RigidBody2D',
        'StaticBody2D',
        'Area2D',
        'Sprite2D',
        'AnimatedSprite2D',
        'CollisionShape2D',
        'Camera2D',
        'Timer',
        'Tween',
        'Signal',
        'Callable',
        'Vector2',
        'Vector3',
        'Color',
        'Rect2',
        'Transform2D',
        'Input',
        'InputEvent',
        'InputEventKey',
        'InputEventMouseButton',
        'Resource',
        'PackedScene',
        'SceneTree',
        'OS',
        'FileAccess',
        'DirAccess',
        'JSON',
        'Array',
        'Dictionary',
      ];

      let downloaded = 0;
      const classList: string[] = [];

      for (const className of essentialClasses) {
        try {
          const url = `${baseUrl}/${className}.xml`;
          const response = await axios.get(url, { timeout: 10000 });
          
          if (response.data) {
            const classDoc = this.parseXmlDoc(response.data, className);
            if (classDoc) {
              this.docs.set(className, classDoc);
              classList.push(className);
              downloaded++;
            }
          }
        } catch (error) {
          // Some classes might not exist in certain versions, that's ok
          console.log(`[DocManager] Could not download ${className}, skipping...`);
        }
      }

      // Save to local cache
      this.saveLocalDocs(classList);
      
      console.log(`[DocManager] Downloaded ${downloaded} classes`);
      this.loaded = true;
      return downloaded > 0;
    } catch (error) {
      console.error('[DocManager] Failed to download docs:', error);
      return false;
    }
  }

  /**
   * Parse XML documentation to ClassDoc
   * This is a simplified parser for Godot's XML format
   */
  private parseXmlDoc(xmlContent: string, className: string): ClassDoc | null {
    try {
      const classDoc: ClassDoc = { name: className };

      // Extract extends
      const extendsMatch = xmlContent.match(/<class[^>]+inherits="([^"]+)"/);
      if (extendsMatch) {
        classDoc.extends = extendsMatch[1];
      }

      // Extract brief description
      const briefMatch = xmlContent.match(/<brief_description>([\s\S]*?)<\/brief_description>/);
      if (briefMatch) {
        classDoc.brief_description = this.cleanXmlText(briefMatch[1]);
      }

      // Extract description
      const descMatch = xmlContent.match(/<description>([\s\S]*?)<\/description>/);
      if (descMatch) {
        classDoc.description = this.cleanXmlText(descMatch[1]);
      }

      // Extract methods
      classDoc.methods = this.parseMethods(xmlContent);

      // Extract properties
      classDoc.properties = this.parseProperties(xmlContent);

      // Extract signals
      classDoc.signals = this.parseSignals(xmlContent);

      // Extract constants and enums
      const { constants, enums } = this.parseConstants(xmlContent);
      classDoc.constants = constants;
      classDoc.enums = enums;

      return classDoc;
    } catch (error) {
      console.error(`[DocManager] Failed to parse ${className}:`, error);
      return null;
    }
  }

  private parseMethods(xmlContent: string): MethodDoc[] {
    const methods: MethodDoc[] = [];
    const methodRegex = /<method[^>]*>([\s\S]*?)<\/method>/g;
    let match;

    while ((match = methodRegex.exec(xmlContent)) !== null) {
      const methodXml = match[0];
      const method: MethodDoc = { name: '' };

      const nameMatch = methodXml.match(/<method[^>]+name="([^"]+)"/);
      if (nameMatch) method.name = nameMatch[1];

      const returnMatch = methodXml.match(/<return[^>]+type="([^"]+)"/);
      if (returnMatch) method.return_type = returnMatch[1];

      method.is_virtual = methodXml.includes('qualifiers="virtual"');
      method.is_static = methodXml.includes('qualifiers="static"');

      const descMatch = methodXml.match(/<description>([\s\S]*?)<\/description>/);
      if (descMatch) method.description = this.cleanXmlText(descMatch[1]);

      method.arguments = this.parseArguments(methodXml);

      if (method.name) methods.push(method);
    }

    return methods;
  }

  private parseProperties(xmlContent: string): PropertyDoc[] {
    const properties: PropertyDoc[] = [];
    const propRegex = /<member[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/member>/g;
    let match;

    while ((match = propRegex.exec(xmlContent)) !== null) {
      const prop: PropertyDoc = { name: match[1] };
      const propXml = match[0];

      const typeMatch = propXml.match(/type="([^"]+)"/);
      if (typeMatch) prop.type = typeMatch[1];

      const setterMatch = propXml.match(/setter="([^"]+)"/);
      if (setterMatch) prop.setter = setterMatch[1];

      const getterMatch = propXml.match(/getter="([^"]+)"/);
      if (getterMatch) prop.getter = getterMatch[1];

      const defaultMatch = propXml.match(/default="([^"]+)"/);
      if (defaultMatch) prop.default_value = defaultMatch[1];

      prop.description = this.cleanXmlText(match[2]);

      properties.push(prop);
    }

    return properties;
  }

  private parseSignals(xmlContent: string): SignalDoc[] {
    const signals: SignalDoc[] = [];
    const signalRegex = /<signal[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/signal>/g;
    let match;

    while ((match = signalRegex.exec(xmlContent)) !== null) {
      const signal: SignalDoc = { name: match[1] };
      const signalXml = match[0];

      const descMatch = signalXml.match(/<description>([\s\S]*?)<\/description>/);
      if (descMatch) signal.description = this.cleanXmlText(descMatch[1]);

      signal.arguments = this.parseArguments(signalXml);

      signals.push(signal);
    }

    return signals;
  }

  private parseConstants(xmlContent: string): { constants: ConstantDoc[], enums: EnumDoc[] } {
    const constants: ConstantDoc[] = [];
    const enums: EnumDoc[] = [];

    // Parse enum constants
    const enumRegex = /<constant[^>]+name="([^"]+)"[^>]+enum="([^"]+)"[^>]*>([\s\S]*?)<\/constant>/g;
    let match;
    const enumMap = new Map<string, ConstantDoc[]>();

    while ((match = enumRegex.exec(xmlContent)) !== null) {
      const enumName = match[2];
      const constant: ConstantDoc = {
        name: match[1],
        description: this.cleanXmlText(match[3])
      };

      if (!enumMap.has(enumName)) {
        enumMap.set(enumName, []);
      }
      enumMap.get(enumName)!.push(constant);
    }

    enumMap.forEach((values, name) => {
      enums.push({ name, values });
    });

    // Parse regular constants
    const constRegex = /<constant[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/constant>/g;
    while ((match = constRegex.exec(xmlContent)) !== null) {
      // Skip if it's an enum constant (already handled)
      if (match[0].includes('enum=')) continue;

      constants.push({
        name: match[1],
        description: this.cleanXmlText(match[2])
      });
    }

    return { constants, enums };
  }

  private parseArguments(xmlContent: string): ArgumentDoc[] {
    const args: ArgumentDoc[] = [];
    const argRegex = /<argument[^>]+name="([^"]+)"[^>]*\/>/g;
    let match;

    while ((match = argRegex.exec(xmlContent)) !== null) {
      const arg: ArgumentDoc = { name: match[1] };
      const argXml = match[0];

      const typeMatch = argXml.match(/type="([^"]+)"/);
      if (typeMatch) arg.type = typeMatch[1];

      const defaultMatch = argXml.match(/default="([^"]+)"/);
      if (defaultMatch) arg.default_value = defaultMatch[1];

      args.push(arg);
    }

    return args;
  }

  private cleanXmlText(text: string): string {
    return text
      .replace(/<\/?[^>]+>/g, '') // Remove XML tags
      .replace(/\n\s*/g, ' ')     // Normalize whitespace
      .replace(/\s+/g, ' ')       // Collapse multiple spaces
      .trim();
  }

  /**
   * Save documentation to local cache
   */
  private saveLocalDocs(classList: string[]): void {
    try {
      // Save each class as separate JSON file
      for (const [name, doc] of this.docs) {
        const filePath = join(this.docsPath, `${name}.json`);
        writeFileSync(filePath, JSON.stringify(doc, null, 2));
      }

      // Save index
      const indexPath = join(this.docsPath, 'index.json');
      writeFileSync(indexPath, JSON.stringify({
        version: this.version,
        classes: classList,
        downloaded: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error('[DocManager] Failed to save docs:', error);
    }
  }

  /**
   * Load documentation from local cache
   */
  private async loadLocalDocs(): Promise<void> {
    try {
      const indexPath = join(this.docsPath, 'index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      
      console.log(`[DocManager] Loading cached docs for Godot ${index.version} (${index.classes.length} classes)`);

      for (const className of index.classes) {
        const filePath = join(this.docsPath, `${className}.json`);
        if (existsSync(filePath)) {
          const doc = JSON.parse(readFileSync(filePath, 'utf8'));
          this.docs.set(className, doc);
        }
      }

      this.loaded = true;
    } catch (error) {
      console.error('[DocManager] Failed to load local docs:', error);
    }
  }

  /**
   * Query documentation for a class or member
   */
  query(className: string, memberName?: string, memberType?: 'method' | 'property' | 'signal' | 'constant'): QueryResult {
    if (!this.loaded) {
      return { found: false, error: 'Documentation not loaded. Call initialize() first.' };
    }

    // Try exact match first
    let classDoc = this.docs.get(className);

    // Try case-insensitive match
    if (!classDoc) {
      for (const [name, doc] of this.docs) {
        if (name.toLowerCase() === className.toLowerCase()) {
          classDoc = doc;
          break;
        }
      }
    }

    if (!classDoc) {
      // Provide suggestions
      const suggestions = this.findSimilarClasses(className);
      return { found: false, suggestions, error: `Class "${className}" not found` };
    }

    // If no member requested, return class info
    if (!memberName) {
      return { found: true, class: classDoc };
    }

    // Search for member
    return this.findMember(classDoc, memberName, memberType);
  }

  /**
   * Find a member (method, property, signal, constant) in a class
   */
  private findMember(classDoc: ClassDoc, memberName: string, memberType?: string): QueryResult {
    const searchFuncs: Array<[string, (c: ClassDoc) => Array<{name: string} | undefined>]> = [
      ['method', (c) => c.methods || []],
      ['property', (c) => c.properties || []],
      ['signal', (c) => c.signals || []],
      ['constant', (c) => c.constants || []],
    ];

    const typesToSearch = memberType 
      ? searchFuncs.filter(([t]) => t === memberType)
      : searchFuncs;

    for (const [type, getItems] of typesToSearch) {
      const items = getItems(classDoc);
      const item = items.find((i: any) => 
        i?.name === memberName || 
        i?.name?.toLowerCase() === memberName.toLowerCase()
      );

      if (item) {
        return {
          found: true,
          class: classDoc,
          member: item as any,
          memberType: type as any
        };
      }
    }

    // Not found, provide suggestions
    const allMembers = [
      ...(classDoc.methods || []).map(m => ({ name: m.name, type: 'method' })),
      ...(classDoc.properties || []).map(p => ({ name: p.name, type: 'property' })),
      ...(classDoc.signals || []).map(s => ({ name: s.name, type: 'signal' })),
    ];

    const suggestions = this.findSimilarNames(memberName, allMembers.map(m => m.name));

    return {
      found: false,
      class: classDoc,
      suggestions,
      error: `"${memberName}" not found in ${classDoc.name}`
    };
  }

  /**
   * Validate API usage
   */
  validate(className: string, memberName: string, usage?: string): ValidationResult {
    const query = this.query(className, memberName);

    if (!query.found) {
      return {
        valid: false,
        issues: [query.error || 'Unknown error'],
        suggestions: query.suggestions
      };
    }

    const issues: string[] = [];
    const suggestions: string[] = [];

    if (query.memberType === 'method' && query.member) {
      const method = query.member as MethodDoc;
      
      // Check if method is virtual and needs override
      if (method.is_virtual && usage && !usage.includes('_ready') && !usage.includes('_process')) {
        suggestions.push(`Note: ${memberName} is a virtual method, use "func ${memberName}():" to override`);
      }

      // Check arguments if usage provided
      if (usage && method.arguments && method.arguments.length > 0) {
        const argCount = (usage.match(/,/g) || []).length + 1;
        if (argCount < method.arguments.length) {
          const requiredArgs = method.arguments.filter(a => !a.default_value).length;
          if (argCount < requiredArgs) {
            issues.push(`Missing required arguments. Expected ${requiredArgs}, got ${argCount}`);
          }
        }
      }
    }

    if (query.memberType === 'signal' && query.member) {
      const signal = query.member as SignalDoc;
      
      if (usage && !usage.includes('connect')) {
        suggestions.push(`Note: ${memberName} is a signal. Use "${memberName}.connect(callback)" to connect`);
      }
    }

    return {
      valid: issues.length === 0,
      issues: issues.length > 0 ? issues : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Search for classes matching a pattern
   */
  search(pattern: string, type?: 'class' | 'method' | 'property'): string[] {
    if (!this.loaded) return [];

    const results: string[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const [name, doc] of this.docs) {
      // Search class names
      if (!type || type === 'class') {
        if (name.toLowerCase().includes(lowerPattern)) {
          results.push(name);
          continue;
        }
      }

      // Search members
      if (type !== 'class') {
        const members = [
          ...(doc.methods || []).map(m => `${name}.${m.name}`),
          ...(doc.properties || []).map(p => `${name}.${p.name}`),
          ...(doc.signals || []).map(s => `${name}.${s.name}`),
        ];
        
        for (const member of members) {
          if (member.toLowerCase().includes(lowerPattern)) {
            results.push(member);
          }
        }
      }
    }

    return results.slice(0, 20); // Limit results
  }

  /**
   * Find similar class names (fuzzy matching)
   */
  private findSimilarClasses(name: string): string[] {
    const lowerName = name.toLowerCase();
    const scored: Array<[string, number]> = [];

    for (const className of this.docs.keys()) {
      const lowerClass = className.toLowerCase();
      let score = 0;

      // Exact substring match
      if (lowerClass.includes(lowerName)) score += 3;
      if (lowerName.includes(lowerClass)) score += 2;

      // Levenshtein-like distance for typos
      const dist = this.levenshtein(lowerName, lowerClass);
      if (dist <= 3) score += (4 - dist);

      if (score > 0) scored.push([className, score]);
    }

    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  }

  /**
   * Find similar names
   */
  private findSimilarNames(target: string, names: string[]): string[] {
    const lowerTarget = target.toLowerCase();
    const scored: Array<[string, number]> = [];

    for (const name of names) {
      const lowerName = name.toLowerCase();
      let score = 0;

      if (lowerName.includes(lowerTarget)) score += 3;
      if (lowerTarget.includes(lowerName)) score += 2;

      const dist = this.levenshtein(lowerTarget, lowerName);
      if (dist <= 3) score += (4 - dist);

      if (score > 0) scored.push([name, score]);
    }

    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  }

  /**
   * Simple Levenshtein distance for fuzzy matching
   */
  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Get loaded status
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get number of loaded classes
   */
  getClassCount(): number {
    return this.docs.size;
  }
}
