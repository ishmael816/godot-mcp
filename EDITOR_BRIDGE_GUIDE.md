# Godot MCP Editor Bridge 使用指南

Editor Bridge 是一个新功能，允许 AI 助手与**正在运行的 Godot 编辑器**实时通信，从而真正"看到"编辑器状态并进行交互。

## ✨ 一键自动模式（推荐）

新增的自动检测功能让 AI 能够**自动发现**正在运行的 Godot 项目和场景，无需手动输入路径：

```javascript
// 🔥 最简 workflow：一键检测、安装、连接、截图
screenshot_current_scene({})  // 自动检测并截图当前场景
```

## 🏗️ 架构

```
┌─────────────────┐         TCP Socket         ┌─────────────────┐
│   MCP Server    │  ◄──────────────────────►  │  Godot Editor   │
│   (AI 助手)      │       127.0.0.1:9742       │  (EditorPlugin) │
└─────────────────┘                            └─────────────────┘
```

## 🚀 快速开始（自动模式）

### 方式一：完全自动（推荐）

```javascript
// 1. 一键自动检测并连接
auto_setup_editor({})

// 2. 获取当前场景信息
get_current_scene_auto({})

// 3. 截图当前场景
screenshot_current_scene({})
```

### 方式二：手动指定路径

如果你需要手动控制：

```javascript
install_editor_plugin({
  projectPath: "E:/Projects/MyGame"
})
```

### 2. 启动 Godot 编辑器

手动打开 Godot 编辑器，并确保项目加载。

### 3. 启用插件

- 进入 `Project > Project Settings > Plugins`
- 找到 "MCP Editor Bridge" 并点击启用
- 插件会自动在端口 9742 上启动 TCP 服务器

### 4. 连接编辑器

```javascript
connect_editor({})
```

连接成功后，你就可以使用所有编辑器桥接功能了！

## 🛠️ 可用工具

| 工具 | 描述 |
|------|------|
| `install_editor_plugin` | 将 MCP Bridge 插件安装到项目中 |
| `connect_editor` | 连接到正在运行的 Godot 编辑器 |
| `get_editor_state` | 获取编辑器当前状态（打开的场景、是否运行等） |
| `get_editor_selection` | 获取当前选中的节点列表 |
| `select_node_in_editor` | 在编辑器中选择指定节点 |
| `get_scene_tree_from_editor` | 获取当前场景的完整节点树 |
| `get_node_properties_from_editor` | 获取指定节点的属性值（Inspector 面板内容） |
| `set_node_property_in_editor` | 修改指定节点的属性值 |
| `open_scene_in_editor` | 在编辑器中打开另一个场景 |
| `save_scene_in_editor` | 保存当前场景 |
| `inspect_node_in_editor` | 在 Inspector 面板中聚焦指定节点 |
| `execute_code_in_editor` | 在编辑器上下文中执行任意 GDScript 代码 |
| `disconnect_editor` | 断开与编辑器的连接 |
| **🤖 自动检测工具** | |
| `detect_godot_project` | 自动检测运行的 Godot 进程并返回项目路径 |
| `auto_setup_editor` | 一键检测、安装插件、连接编辑器 |
| `get_current_scene_auto` | 自动获取当前场景信息（检测+连接+查询） |
| `screenshot_current_scene` | 一键截图当前场景（全自动） |
| `get_recent_projects` | 获取最近使用过的项目列表 |

## 💡 使用示例

### 查看当前编辑器状态

```javascript
get_editor_state({})
// 返回：
// - 当前打开的场景
// - 场景路径
// - 是否正在运行游戏
// - 选中节点数量
```

### 获取场景树结构

```javascript
get_scene_tree_from_editor({
  maxDepth: 5
})
// 返回当前场景的完整节点层次结构
```

### 查看节点属性

```javascript
get_node_properties_from_editor({
  nodePath: "Player/Sprite2D",
  includeDefaults: false  // 只显示非默认值
})
// 返回节点的所有属性及其当前值
```

### 修改节点属性

```javascript
set_node_property_in_editor({
  nodePath: "Player/Sprite2D",
  property: "position",
  value: { __type: "Vector2", x: 100, y: 200 }
})
```

### 在编辑器中选择节点

```javascript
select_node_in_editor({
  nodePath: "HUD/ScoreLabel"
})
// 节点会在场景树中高亮，并在 Inspector 中显示
```

### 打开其他场景

```javascript
open_scene_in_editor({
  scenePath: "scenes/level_2.tscn"
})
```

### 执行自定义代码

```javascript
execute_code_in_editor({
  code: 'editor.get_editor_interface().get_selection().get_selected_nodes()[0].name'
})
// 可以访问 editor 变量（EditorInterface）
```

## 🔌 EditorPlugin 功能详解

插件 (`bridge.gd`) 提供了以下功能：

### 支持的命令

| 命令 | 功能 |
|------|------|
| `ping` | 测试连接，返回 Godot 版本信息 |
| `get_editor_state` | 获取编辑器状态 |
| `get_selection` | 获取选中的节点 |
| `select_node` | 选择指定路径的节点 |
| `get_scene_tree` | 获取场景树 |
| `get_node_properties` | 获取节点属性列表 |
| `set_node_property` | 设置节点属性 |
| `open_scene` | 打开场景文件 |
| `save_scene` | 保存当前场景 |
| `inspect_node` | 在 Inspector 中聚焦节点 |
| `execute_code` | 执行 GDScript 代码 |

### 数据序列化

复杂类型（Vector2, Color, Transform2D 等）会自动序列化为 JSON：

```json
// Vector2
{"__type": "Vector2", "x": 100, "y": 200}

// Color
{"__type": "Color", "r": 1, "g": 0, "b": 0, "a": 1}

// Resource
{"__type": "Resource", "path": "res://icon.png"}
```

## 🔥 自动检测功能详解

### `detect_godot_project` - 检测运行的 Godot

自动扫描系统进程，找到正在运行的 Godot Editor 并提取项目路径：

```javascript
detect_godot_project({})
// 返回：
// ✅ Detected running Godot project!
// Project Name: MyGame
// Path: E:/Projects/MyGame
```

### `auto_setup_editor` - 一键设置

自动完成整个设置流程：
1. 检测运行的 Godot 项目
2. 检查/安装 MCP Bridge 插件
3. 连接到编辑器
4. 返回当前场景信息

```javascript
auto_setup_editor({
  installPluginIfNeeded: true  // 如果插件未安装，自动安装
})
// 返回完整的连接状态和场景信息
```

### `get_current_scene_auto` - 自动获取场景

无需手动连接，自动检测并返回当前场景信息：

```javascript
get_current_scene_auto({
  includeTree: true,       // 包含场景树结构
  includeProperties: true  // 包含选中节点的属性
})
// 返回：
// - 当前场景名称和路径
// - 选中的节点
// - 场景树结构
// - 选中节点的属性值
```

### `screenshot_current_scene` - 一键截图

全自动截图当前场景：

```javascript
screenshot_current_scene({
  width: 1920,
  height: 1080,
  delay: 0.5  // 等待时间，让场景稳定
})
// 自动检测项目 → 连接 → 截图 → 保存
```

### `get_recent_projects` - 最近项目

获取缓存的最近使用过的项目列表：

```javascript
get_recent_projects({})
// 返回最近使用的 10 个项目路径
```

## ⚠️ 注意事项

1. **编辑器必须先打开**：`connect_editor` 只有在 Godot 编辑器运行并启用插件时才能成功

2. **自动检测原理**：通过扫描系统进程（`ps`/`wmic`）获取 Godot 的命令行参数中的 `--path`

3. **单连接限制**：同一时间只能有一个 MCP 客户端连接到编辑器

4. **端口冲突**：如果端口 9742 被占用，插件将无法启动。检查是否有其他 Godot 实例正在运行

5. **防火墙**：确保防火墙没有阻止本地连接 (127.0.0.1:9742)

6. **线程安全**：插件使用后台线程处理命令，UI 更新在主线程执行

## 🔧 故障排除

### 无法连接到编辑器

```
Failed to connect: Connection timeout
```

**解决方案：**
- 确保 Godot 编辑器已打开
- 检查插件是否已启用（Project Settings > Plugins）
- 查看 Godot 输出面板是否有错误信息
- 重启 Godot 编辑器

### 命令执行失败

```
Failed to get editor state: No scene is currently open
```

**解决方案：**
- 确保编辑器中有场景打开
- 某些命令需要特定条件（如选中节点）

### 插件安装失败

```
Failed to install plugin: Plugin source not found
```

**解决方案：**
- 运行 `npm run build` 确保插件文件被复制到 build 目录
- 检查 `build/editor_plugin/mcp_bridge/` 目录是否存在

## 🎯 使用场景示例

### 场景 1：AI 辅助场景编辑

```
User: "帮我看看 Player 节点现在的位置"
AI: *调用 get_node_properties_from_editor({nodePath: "Player", ...})*
    "Player 节点的 position 是 (100, 200)"

User: "把它移到屏幕中央"
AI: *调用 set_node_property_in_editor({nodePath: "Player", property: "position", value: {...}})*
    "已将 Player 移动到 (576, 324)"
```

### 场景 2：场景分析

```
User: "这个场景里有什么节点？"
AI: *调用 get_scene_tree_from_editor({})*
    "当前场景 Main 包含：
     - Player (CharacterBody2D)
       - Sprite2D
       - CollisionShape2D
     - HUD (CanvasLayer)
       - ScoreLabel
       - HealthBar"
```

### 场景 3：批量修改

```
User: "选中所有的敌人节点"
AI: *分析场景树 -> 找到所有 Enemy 前缀的节点 -> 逐个调用 select_node_in_editor*
    "已选中 Enemy1, Enemy2, Enemy3"
```

## 📝 进阶用法

### 编写自定义编辑器脚本

```javascript
execute_code_in_editor({
  code: `
    var editor = editor.get_editor_interface()
    var scene = editor.get_edited_scene_root()
    
    // 创建新节点
    var node = Node2D.new()
    node.name = "DynamicNode"
    scene.add_child(node)
    node.owner = scene
    
    editor.mark_scene_as_unsaved()
    return "Created node: " + node.name
  `
})
```

## 🔮 未来扩展

可能添加的功能：
- 编辑器截图（捕获编辑器视口）
- 撤销/重做控制
- 文件系统监视
- 脚本编辑器集成
- 动画编辑器控制
