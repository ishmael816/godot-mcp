/**
 * TileMap 编辑器
 * 提供基础的 TileMap 读写操作
 * 让大模型自由组合使用，不预设复杂算法
 */

import { FileUtils } from '../utils/FileUtils.js';

export interface Vector2i {
  x: number;
  y: number;
}

export interface TileData {
  atlasCoords?: Vector2i;
  sourceId?: number;
  alternativeTile?: number;
  flipH?: boolean;
  flipV?: boolean;
  transpose?: boolean;
  customData?: Record<string, any>;
}

export interface TileMapLayer {
  name: string;
  tiles: Map<string, TileData>;  // key: "x,y"
  enabled: boolean;
  modulate?: { r: number; g: number; b: number; a: number };
  ySortEnabled?: boolean;
  ySortOrigin?: number;
  [key: string]: any;  // Allow additional properties
}

export interface TileMapData {
  tileSetPath?: string;
  tileSize?: Vector2i;
  layers: TileMapLayer[];
}

export class TileMapEditor {
  private fileUtils: FileUtils;

  constructor(projectPath: string) {
    this.fileUtils = new FileUtils(projectPath);
  }

  /**
   * 解析场景文件中的 TileMap 数据
   * 这是一个简化版解析器，处理基本的 TileMap 节点
   */
  parseTileMapFromScene(scenePath: string, tileMapNodePath: string): { success: boolean; data?: TileMapData; error?: string } {
    const result = this.fileUtils.readText(scenePath);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const content = result.content!;
    const lines = content.split('\n');

    // 查找 TileMap 节点
    let inTileMap = false;
    let currentSection = '';
    let tileSetPath: string | undefined;
    let tileSize: Vector2i | undefined;
    const layers: TileMapLayer[] = [];
    let currentLayer: TileMapLayer | null = null;

    // 简单的状态机解析
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 检测 TileMap 节点开始
      if (line.startsWith('[node name="') && line.includes('type="TileMap"')) {
        // 检查是否是目标节点
        const nodeName = line.match(/name="([^"]+)"/)?.[1];
        if (nodeName && tileMapNodePath.endsWith(nodeName)) {
          inTileMap = true;
        }
        continue;
      }

      // 检测 TileMapLayer 节点
      if (line.startsWith('[node name="') && line.includes('type="TileMapLayer"')) {
        if (inTileMap) {
          const layerName = line.match(/name="([^"]+)"/)?.[1] || `Layer${layers.length}`;
          currentLayer = {
            name: layerName,
            tiles: new Map(),
            enabled: true
          };
          layers.push(currentLayer);
        }
        continue;
      }

      // 检测其他节点（结束 TileMap）
      if (line.startsWith('[node ') && !line.includes('TileMap')) {
        if (inTileMap && !line.includes('TileMapLayer')) {
          inTileMap = false;
          currentLayer = null;
        }
        continue;
      }

      if (!inTileMap) continue;

      // 解析属性
      if (line.startsWith('tile_set =')) {
        const match = line.match(/ExtResource\("([^"]+)"\)/);
        if (match) {
          tileSetPath = match[1];
        }
      }

      if (line.startsWith('tile_size =')) {
        const match = line.match(/Vector2i\((\d+),\s*(\d+)\)/);
        if (match) {
          tileSize = { x: parseInt(match[1]), y: parseInt(match[2]) };
        }
      }

      // 解析图层数据（简化版）
      if (line.startsWith('tile_map_data =') && currentLayer) {
        // 这是一个压缩/编码的数据块，实际解析需要 Godot 格式解码
        // 这里我们记录原始数据，实际修改时会重写
        currentLayer['rawData'] = line;
      }
    }

    // 如果没有找到任何图层，创建一个默认的
    if (layers.length === 0 && inTileMap) {
      layers.push({
        name: 'Layer0',
        tiles: new Map(),
        enabled: true
      });
    }

    return {
      success: true,
      data: {
        tileSetPath,
        tileSize,
        layers
      }
    };
  }

  /**
   * 通过 Godot 脚本操作 TileMap
   * 这是最可靠的方式，使用 godot_operations.gd
   */
  async modifyTileMap(
    projectPath: string,
    scenePath: string,
    tileMapNodePath: string,
    operations: TileOperation[]
  ): Promise<{ success: boolean; error?: string }> {
    // 由于需要通过 Godot 来修改，我们使用 executeOperation
    // 这里返回操作指令，由调用者通过 godot_operations.gd 执行
    
    return {
      success: true,
      error: 'TileMap modification requires Godot script execution. Use godot_operations.gd with operation: "modify_tilemap"'
    };
  }

  /**
   * 生成 TileMap 修改的 GDScript 代码
   */
  generateModifyScript(scenePath: string, tileMapNodePath: string, operations: TileOperation[]): string {
    let script = `
# Modify TileMap
var scene = load("${scenePath}")
var scene_root = scene.instantiate()
var tilemap = scene_root.get_node("${tileMapNodePath.replace('root/', '')}")

if tilemap == null:
    printerr("TileMap not found: ${tileMapNodePath}")
    quit(1)

`;

    for (const op of operations) {
      switch (op.type) {
        case 'set_cell':
          script += `
# Set cell at (${op.coords.x}, ${op.coords.y})
tilemap.set_cell(${op.layerIndex || 0}, Vector2i(${op.coords.x}, ${op.coords.y}), `;
          if (op.tile.sourceId !== undefined) {
            script += `${op.tile.sourceId}`;
          } else if (op.tile.atlasCoords) {
            script += `0, Vector2i(${op.tile.atlasCoords.x}, ${op.tile.atlasCoords.y})`;
          }
          if (op.tile.alternativeTile !== undefined) {
            script += `, ${op.tile.alternativeTile}`;
          }
          script += `)
`;
          break;

        case 'erase_cell':
          script += `
# Erase cell at (${op.coords.x}, ${op.coords.y})
tilemap.erase_cell(${op.layerIndex || 0}, Vector2i(${op.coords.x}, ${op.coords.y}))
`;
          break;

        case 'clear_layer':
          script += `
# Clear layer ${op.layerIndex || 0}
tilemap.clear_layer(${op.layerIndex || 0})
`;
          break;

        case 'set_cells_terrain_connect':
          script += `
# Set terrain cells
var coords = PackedVector2Array([`;
          script += op.coordsList.map(c => `Vector2i(${c.x}, ${c.y})`).join(', ');
          script += `])
tilemap.set_cells_terrain_connect(${op.layerIndex || 0}, coords, ${op.terrainSet}, ${op.terrain})
`;
          break;
      }
    }

    script += `
# Save scene
var packed_scene = PackedScene.new()
packed_scene.pack(scene_root)
ResourceSaver.save(packed_scene, "${scenePath}")
scene_root.free()
print("TileMap modified successfully")
`;

    return script;
  }

  /**
   * 解析 TileMap 数据格式（用于读取）
   */
  decodeTileMapData(encodedData: string): Array<{ coords: Vector2i; tile: TileData }> {
    // 这是一个简化版，实际 Godot 使用的是压缩+base64编码
    // 完整实现需要使用 Godot 的解码算法
    // 这里返回空数组，表示需要借助 Godot 来解析
    return [];
  }

  /**
   * 编码 TileMap 数据
   */
  encodeTileMapData(tiles: Array<{ coords: Vector2i; tile: TileData }>): string {
    // 同样需要 Godot 的编码算法
    return '';
  }

  /**
   * 生成矩形区域的坐标列表
   */
  static generateRectCoords(from: Vector2i, to: Vector2i): Vector2i[] {
    const coords: Vector2i[] = [];
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        coords.push({ x, y });
      }
    }

    return coords;
  }

  /**
   * 生成圆形区域的坐标列表
   */
  static generateCircleCoords(center: Vector2i, radius: number): Vector2i[] {
    const coords: Vector2i[] = [];
    const r2 = radius * radius;

    for (let x = center.x - radius; x <= center.x + radius; x++) {
      for (let y = center.y - radius; y <= center.y + radius; y++) {
        if ((x - center.x) ** 2 + (y - center.y) ** 2 <= r2) {
          coords.push({ x, y });
        }
      }
    }

    return coords;
  }

  /**
   * 生成直线路径的坐标列表
   */
  static generateLineCoords(from: Vector2i, to: Vector2i): Vector2i[] {
    const coords: Vector2i[] = [];
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const sx = from.x < to.x ? 1 : -1;
    const sy = from.y < to.y ? 1 : -1;
    let err = dx - dy;
    let x = from.x;
    let y = from.y;

    while (true) {
      coords.push({ x, y });

      if (x === to.x && y === to.y) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }

    return coords;
  }
}

export type TileOperation =
  | { type: 'set_cell'; coords: Vector2i; tile: TileData; layerIndex?: number }
  | { type: 'erase_cell'; coords: Vector2i; layerIndex?: number }
  | { type: 'clear_layer'; layerIndex?: number }
  | { type: 'set_cells_terrain_connect'; coordsList: Vector2i[]; terrainSet: number; terrain: number; layerIndex?: number };
