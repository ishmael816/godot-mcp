# 美术资产自动生成方案

## 概述
为 Godot MCP 添加 AI 美术资产生成功能，支持从占位符到 AI 生成图像的完整工作流。

---

## 阶段 1: 基础占位符生成（无需外部 API）

### 工具: `generate_placeholder`
生成程序化占位符资源。

**参数：**
- `projectPath`: 项目路径
- `outputPath`: 输出路径（如 "assets/placeholder/player.png"）
- `type`: placeholder | noise | gradient | grid | checkerboard
- `width`: 图像宽度
- `height`: 图像高度
- `color`: 主色调（如 "#ff6b6b"）
- `label`: 可选，在图像中心显示文字

**使用场景：**
- 快速原型开发
- 测试场景布局
- 等待正式美术资源时的临时替代

---

## 阶段 2: AI 图像生成（需要 API Key）

### 工具: `generate_ai_asset`
调用 AI 图像生成 API 创建游戏资源。

**参数：**
- `projectPath`: 项目路径
- `prompt`: AI 绘画提示词
- `outputPath`: 输出路径
- `width/height`: 图像尺寸（默认 512x512）
- `provider`: openai | stability | local
- `style`: pixel_art | realistic | cartoon | anime
- `autoLoad`: 生成后是否自动加载到场景
- `scenePath`: 目标场景（如果 autoLoad 为 true）
- `nodePath`: 目标节点（如果 autoLoad 为 true）

**工作流程：**
1. 调用图像生成 API
2. 下载并保存到项目目录
3. 如果 autoLoad=true，调用 load_sprite 附加到节点
4. capture_screenshot 验证效果

**配置 API Key：**
```json
{
  "mcpServers": {
    "godot": {
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "STABILITY_API_KEY": "sk-..."
      }
    }
  }
}
```

---

## 阶段 3: 批量资产生成

### 工具: `generate_sprite_sheet`
批量生成动画帧并合并为精灵图集。

**参数：**
- `prompts`: 各帧的描述数组
- `outputPath`: 精灵图输出路径
- `columns`: 水平排列帧数
- `frameWidth/Height`: 单帧尺寸

### 工具: `generate_tileset`
生成瓦片地图资源集。

**参数：**
- `tileType`: grass | dirt | stone | water | wood
- `variations`: 变体数量
- `tileSize`: 瓦片尺寸（32/64/128）
- `seamless`: 是否无缝衔接

---

## 完整工作流示例

### 示例 1: 快速原型角色

```
用户: "创建一个玩家角色占位符"

AI:
1. generate_placeholder
   - type: placeholder
   - color: "#4ecdc4"
   - label: "Player"
   - outputPath: "assets/temp/player.png"

2. create_scene: scenes/player.tscn
3. add_node: Sprite2D
4. load_sprite: 加载占位符图像
5. capture_screenshot: 验证
```

### 示例 2: AI 生成正式资源

```
用户: "生成一个太空飞船精灵"

AI:
1. generate_ai_asset
   - prompt: "2D space shooter ship, top-down view, blue and silver, sci-fi style, transparent background, game sprite"
   - style: "pixel_art"
   - outputPath: "assets/ships/player_ship.png"
   - autoLoad: true
   - scenePath: "scenes/player.tscn"
   - nodePath: "root/ShipSprite"

2. capture_screenshot: 验证效果

用户: "飞船太小了，放大 1.5 倍"

AI:
3. set_node_property
   - propertyPath: "scale"
   - propertyValue: "Vector2(1.5, 1.5)"

4. capture_screenshot: 最终确认
```

### 示例 3: 完整场景生成

```
用户: "创建一个地牢场景，有墙壁和地板"

AI:
1. generate_ai_asset × 2
   - 地板: "Seless dungeon floor texture, stone tiles, top-down"
   - 墙壁: "Dungeon wall texture, stone bricks, top-down"

2. create_scene: scenes/dungeon.tscn (TileMap)
3. 配置 TileSet 使用生成的纹理
4. set_node_property: 配置 TileMap 属性
5. capture_screenshot: 验证
```

---

## 技术实现

### GDScript 图像生成（占位符）

```gdscript
# 使用 Godot 的 Image 类生成基础图形
func generate_placeholder_image(width, height, color, label):
    var image = Image.create(width, height, false, Image.FORMAT_RGBA8)
    
    # 填充背景色
    image.fill(Color(color))
    
    # 添加边框
    for x in width:
        image.set_pixel(x, 0, Color.BLACK)
        image.set_pixel(x, height-1, Color.BLACK)
    for y in height:
        image.set_pixel(0, y, Color.BLACK)
        image.set_pixel(width-1, y, Color.BLACK)
    
    # 保存
    image.save_png(output_path)
```

### TypeScript 图像生成（AI）

```typescript
// 调用 OpenAI DALL-E API
async function generateWithOpenAI(prompt: string, size: string): Promise<Buffer> {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      n: 1,
      size,
      response_format: 'b64_json',
    }),
  });
  
  const data = await response.json();
  return Buffer.from(data.data[0].b64_json, 'base64');
}
```

---

## 注意事项

1. **版权问题**
   - AI 生成图像的版权归属因平台和地区而异
   - 商业项目建议咨询法律意见或使用无版权风险的模型

2. **风格一致性**
   - 使用相同的 seed 或 style reference 保持角色一致
   - 在 prompt 中明确指定 "same style as previous"

3. **文件管理**
   - 建议将生成资源放在 `assets/generated/` 目录
   - 占位符资源放在 `assets/placeholders/`
   - 将 generated/ 加入 .gitignore（大文件）

4. **性能优化**
   - 生成的大图应在 Godot 中设置适当的压缩
   - 使用纹理图集（AtlasTexture）合并小图

---

## 实现优先级

| 工具 | 难度 | 优先级 | 依赖 |
|------|------|--------|------|
| generate_placeholder | ⭐⭐ 低 | 🔴 高 | 无 |
| generate_ai_asset | ⭐⭐⭐⭐ 高 | 🟠 中 | API Key |
| generate_sprite_sheet | ⭐⭐⭐ 中 | 🟡 低 | AI 生成 |
| generate_tileset | ⭐⭐⭐ 中 | 🟡 低 | AI 生成 |

**建议：** 先从 `generate_placeholder` 开始，无需外部依赖，立即可用。
