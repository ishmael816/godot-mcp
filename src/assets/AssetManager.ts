/**
 * 资源管理器
 * 提供基础资源导入、分析和操作功能
 * 将设计空间留给大模型
 */

import { FileUtils } from '../utils/FileUtils.js';
import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join, extname, basename, dirname } from 'path';

export interface AssetInfo {
  path: string;
  type: AssetType;
  size: number;
  modified: Date;
}

export type AssetType = 
  | 'texture' | 'audio' | 'font' | 'model' | 'shader' 
  | 'scene' | 'script' | 'resource' | 'other';

export interface ImportConfig {
  // 纹理配置
  texture?: {
    compress?: 'lossless' | 'vram' | 'basis_universal';
    mipmaps?: boolean;
    filter?: 'nearest' | 'linear';
    repeat?: 'disable' | 'mirror' | 'clamp';
  };
  // 音频配置
  audio?: {
    loop?: boolean;
    compress?: boolean;
  };
}

export class AssetManager {
  private fileUtils: FileUtils;
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.fileUtils = new FileUtils(projectPath);
  }

  /**
   * 根据扩展名检测资源类型
   */
  detectType(filePath: string): AssetType {
    const ext = extname(filePath).toLowerCase();
    
    const typeMap: Record<string, AssetType> = {
      // 纹理
      '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture',
      '.svg': 'texture', '.tga': 'texture', '.bmp': 'texture', '.hdr': 'texture',
      // 音频
      '.wav': 'audio', '.ogg': 'audio', '.mp3': 'audio',
      // 字体
      '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
      // 3D模型
      '.gltf': 'model', '.glb': 'model', '.obj': 'model', '.fbx': 'model',
      '.dae': 'model', '.blend': 'model',
      // 着色器
      '.gdshader': 'shader', '.shader': 'shader',
      // 场景
      '.tscn': 'scene', '.scn': 'scene', '.escn': 'scene',
      // 脚本
      '.gd': 'script', '.cs': 'script', '.csh': 'script',
      // 资源
      '.tres': 'resource', '.res': 'resource', '.material': 'resource',
      '.anim': 'resource', '.mesh': 'resource', '.shape': 'resource'
    };

    return typeMap[ext] || 'other';
  }

  /**
   * 扫描目录获取所有资源
   */
  scanDirectory(dirPath: string, options?: { recursive?: boolean; typeFilter?: AssetType[] }): AssetInfo[] {
    const assets: AssetInfo[] = [];
    const fullPath = this.fileUtils['resolvePath'](dirPath);

    try {
      const entries = readdirSync(fullPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // 跳过隐藏目录和特定目录
          if (entry.name.startsWith('.') || entry.name === 'addons') continue;
          
          if (options?.recursive !== false) {
            assets.push(...this.scanDirectory(entryPath, options));
          }
        } else {
          const type = this.detectType(entryPath);
          
          // 类型过滤
          if (options?.typeFilter && !options.typeFilter.includes(type)) {
            continue;
          }

          const stats = statSync(join(fullPath, entry.name));
          assets.push({
            path: entryPath,
            type,
            size: stats.size,
            modified: stats.mtime
          });
        }
      }
    } catch (error) {
      console.error(`Failed to scan directory: ${dirPath}`, error);
    }

    return assets;
  }

  /**
   * 获取单个资源信息
   */
  getInfo(filePath: string): AssetInfo | null {
    try {
      const fullPath = this.fileUtils['resolvePath'](filePath);
      const stats = statSync(fullPath);
      
      return {
        path: filePath,
        type: this.detectType(filePath),
        size: stats.size,
        modified: stats.mtime
      };
    } catch {
      return null;
    }
  }

  /**
   * 导入外部文件到项目
   */
  importAsset(
    sourcePath: string, 
    targetPath: string, 
    options?: { overwrite?: boolean; generateImportConfig?: boolean }
  ): { success: boolean; info?: AssetInfo; error?: string } {
    try {
      // 检查源文件
      if (!existsSync(sourcePath)) {
        return { success: false, error: `Source file not found: ${sourcePath}` };
      }

      const fullTargetPath = this.fileUtils['resolvePath'](targetPath);

      // 检查是否已存在
      if (existsSync(fullTargetPath) && !options?.overwrite) {
        return { success: false, error: `Target already exists: ${targetPath}` };
      }

      // 确保目录存在
      const dir = dirname(fullTargetPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 复制文件
      copyFileSync(sourcePath, fullTargetPath);

      // 生成 .import 配置（如果是 Godot 支持的资源）
      if (options?.generateImportConfig !== false) {
        this.generateImportConfig(targetPath);
      }

      const info = this.getInfo(targetPath);
      return { success: true, info: info! };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 生成 Godot 导入配置
   */
  private generateImportConfig(filePath: string): void {
    const type = this.detectType(filePath);
    const importPath = `${this.fileUtils['resolvePath'](filePath)}.import`;

    // 如果已存在，不覆盖
    if (existsSync(importPath)) return;

    let config = '';
    const uid = this.generateUid();
    const fileName = basename(filePath);
    const timestamp = Date.now();

    switch (type) {
      case 'texture':
        config = `[remap]

importer="texture"
type="CompressedTexture2D"
uid="uid://${uid}"
path="res://.godot/imported/${fileName}-${timestamp}.ctex"
generator_parameters={}
[deps]

source_file="res://${filePath}"
dest_files=["res://.godot/imported/${fileName}-${timestamp}.ctex"]

[params]

compress/mode=0
compress/high_quality=false
compress/lossy_quality=0.7
compress/hdr_compression=1
compress/normal_map=0
compress/channel_pack=0
mipmaps/generate=false
mipmaps/limit=-1
roughness/mode=0
roughness/src_normal=""
process/fix_alpha_border=true
process/premult_alpha=false
process/normal_map_invert_y=false
process/hdr_as_srgb=false
process/hdr_clamp_exposure=false
process/size_limit=0
detect_3d/compress_to=1
`;
        break;
      case 'audio':
        config = `[remap]

importer="ogg_vorbis"
type="AudioStreamOggVorbis"
uid="uid://${uid}"
path="res://.godot/imported/${fileName}-${timestamp}.oggvorbisstr"

[deps]

source_file="res://${filePath}"
dest_files=["res://.godot/imported/${fileName}-${timestamp}.oggvorbisstr"]

[params]

loop=false
loop_offset=0
bpm=0
beat_count=0
bar_beats=4
`;
        break;
      case 'font':
        config = `[remap]

importer="font_data_dynamic"
type="FontFile"
uid="uid://${uid}"
path="res://.godot/imported/${fileName}-${timestamp}.fontdata"

[deps]

source_file="res://${filePath}"
dest_files=["res://.godot/imported/${fileName}-${timestamp}.fontdata"]

[params]

Rendering=null
antialiasing=1
generate_mipmaps=false
disable_embedded_bitmaps=true
multichannel_signed_distance_field=false
msdf_pixel_range=8
msdf_size=48
allow_system_fallback=true
force_autohinter=false
hinting=1
subpixel_positioning=1
oversampling=0.0
Fallbacks=null
fallbacks=[]
Compress=null
compress=true
preload=[]
language_support={}
script_support={}
opentype_features={}
`;
        break;
    }

    if (config) {
      try {
        writeFileSync(importPath, config, 'utf-8');
      } catch (error) {
        console.error(`Failed to write import config: ${error}`);
      }
    }
  }

  /**
   * 生成简单的 UID
   */
  private generateUid(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 分析资源使用情况
   */
  analyzeAssets(options?: { findUnused?: boolean; findDuplicates?: boolean }): {
    unused?: string[];
    duplicates?: Array<{ hash: string; files: string[] }>;
  } {
    const result: { unused?: string[]; duplicates?: Array<{ hash: string; files: string[] }> } = {};

    // 获取所有资源
    const allAssets = this.scanDirectory('.', { recursive: true });

    if (options?.findUnused) {
      // 简单的未使用检测：检查是否有 .tscn 或 .gd 文件引用
      const scripts = allAssets.filter(a => a.type === 'script');
      const scenes = allAssets.filter(a => a.type === 'scene');
      
      // 收集所有引用
      const referenced = new Set<string>();
      
      for (const script of scripts) {
        const content = this.fileUtils.readText(script.path);
        if (content.content) {
          for (const asset of allAssets) {
            if (content.content.includes(asset.path) || 
                content.content.includes(basename(asset.path, extname(asset.path)))) {
              referenced.add(asset.path);
            }
          }
        }
      }

      for (const scene of scenes) {
        const content = this.fileUtils.readText(scene.path);
        if (content.content) {
          for (const asset of allAssets) {
            if (content.content.includes(asset.path)) {
              referenced.add(asset.path);
            }
          }
        }
      }

      result.unused = allAssets
        .filter(a => a.type !== 'script' && a.type !== 'scene' && !referenced.has(a.path))
        .map(a => a.path);
    }

    if (options?.findDuplicates) {
      // 简单的重复检测：基于文件名（不包括扩展名）
      const nameMap = new Map<string, string[]>();
      
      for (const asset of allAssets) {
        const name = basename(asset.path, extname(asset.path));
        if (!nameMap.has(name)) {
          nameMap.set(name, []);
        }
        nameMap.get(name)!.push(asset.path);
      }

      result.duplicates = Array.from(nameMap.entries())
        .filter(([_, files]) => files.length > 1)
        .map(([hash, files]) => ({ hash, files }));
    }

    return result;
  }
}
