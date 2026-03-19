# Godot MCP 最近更新日志

> 更新时间：2026-03-20  
> 共显示最近 20 次提交

---

## 📋 提交概览

| 提交哈希 | 作者 | 日期 | 类型 | 提交信息 |
|---------|------|------|------|---------|
| `341ea20` | ishmael816 | 2026-03-20 | - | 提交一波 |
| `3222dd4` | ishmael816 | 2026-03-18 | docs | 添加AI美术工作流的资产生成计划 |
| `9f4b8a8` | ishmael816 | 2026-03-18 | feat | 添加智能导出功能（带自动修复） |
| `dae3771` | ishmael816 | 2026-03-18 | feat | 添加项目导出功能 |
| `c48a166` | ishmael816 | 2026-03-18 | docs | 添加AI助手系统提示模板 |
| `29ebd79` | ishmael816 | 2026-03-18 | feat | 添加 C# 构建支持 |
| `13aa518` | ishmael816 | 2026-03-18 | feat | 添加可视化开发和文档工具 |
| `f341234` | Solomon Elias | 2026-01-30 | chore | 版本提升至 0.1.1，添加 npm 元数据 |
| `21c785d` | Solomon Elias | 2026-01-29 | merge | 合并 PR #67：修复命令注入漏洞 |
| `96fe4f7` | wcole3 | 2026-01-26 | fix | 切换到 execFile 以防止 shell 注入 |
| `90b907a` | Solomon Elias | 2026-01-05 | fix | 修复 console.debug 写入 stdout 问题 |
| `b7ae146` | Solomon Elias | 2026-01-05 | merge | 合并 PR #60：移除无效的 default 关键字 |
| `926a850` | Solomon Elias | 2026-01-05 | fix | 移除无效的 default 关键字 |
| `2466543` | Solomon Elias | 2026-01-05 | merge | 合并 PR #25：修复 stdout/stderr 处理 |
| `e5da166` | Solomon Elias | 2026-01-05 | merge | 合并 PR #47：修复 npm 依赖安全问题 |
| `ab02801` | iocron | 2025-10-21 | fix | 修复 form-data 和 axios 安全漏洞 |
| `32508d1` | Solomon Elias | 2025-08-09 | merge | 合并 PR #34：修复 Windows JSON 参数解析 |
| `31f62a7` | Solomon Elias | 2025-08-04 | docs | 添加 GitHub Sponsors 徽章 |
| `8855720` | Solomon Elias | 2025-08-04 | chore | 添加 GitHub Sponsors |
| `309936f` | Miguel Ripoll | 2025-07-15 | merge | 合并 PR #1：修复 Windows JSON 参数引号 |

---

## 🔍 详细更新内容

### 2026-03-20

#### `341ea20` - 提交一波
**作者**: ishmael816  
**变更文件**: 10 个文件  
**变更统计**: `+6,552` / `-1,839` 行

**主要变更**:
- `EDITOR_BRIDGE_GUIDE.md` - 新增 373 行文档
- `src/index.ts` - 大幅重构，新增 4336 行代码
- 新增 `AssetManager.ts` 资源管理器
- 新增 `ScriptManager.ts` 脚本管理器
- 新增 `TileMapEditor.ts` 地图编辑器
- 新增 `FileUtils.ts` 文件工具类
- 新增 Godot 编辑器桥接插件 (`mcp_bridge`)

---

### 2026-03-18

#### `3222dd4` - docs: add asset generation plan for AI-powered art workflow
**作者**: ishmael816  
**变更**: `ASSET_GENERATION_PLAN.md` (+233 行)

新增 AI 美术工作流的资产生成计划文档。

---

#### `9f4b8a8` - feat: add smart_export with auto-repair capability
**作者**: ishmael816  
**变更**: `src/index.ts` (+248 / -16 行)

新增智能导出功能：
- 自动检测和修复导出错误
- 对 C# 项目：导出前自动编译，构建错误时重试
- 将错误分类为可自动修复 vs 需要手动设置
- 提供详细的进程日志（带 emoji 指示器）
- 添加 `maxRetries` 参数用于配置重试次数

---

#### `dae3771` - feat: add project export functionality
**作者**: ishmael816  
**变更**: `src/index.ts` (+252 行)

新增项目导出功能：
- 支持导出游戏可执行文件
- 支持 Windows (.exe)、macOS (.app)、Linux、Android、iOS、Web
- 自动检测缺失的导出模板和预设
- 报告文件大小和导出时间
- 包含平台特定的分发说明

---

#### `c48a166` - docs: add comprehensive system prompt template for AI assistants
**作者**: ishmael816  
**变更**: `GODOT_MCP_SYSTEM_PROMPT.md` (+381 行)

新增 AI 助手的综合系统提示模板，包含：
- 工具使用决策树
- 自我验证检查清单
- 错误处理策略
- GDScript 和 C# 最佳实践
- 典型任务示例
- 防止幻觉的指南

---

#### `29ebd79` - feat: add C# build support
**作者**: ishmael816  
**变更**: `src/index.ts` (+223 行), `src/scripts/godot_operations.gd` (+2 行)

新增 C# 构建支持：
- 添加 `build_csharp_project` 工具
- 支持 dotnet CLI 和 Godot 内置构建
- 自动检测 .csproj 文件
- 捕获和报告构建错误并提供建议
- 支持 Debug/Release 配置

---

#### `13aa518` - feat: add visual development and documentation tools
**作者**: ishmael816  
**变更**: 4 个文件 (+2,769 行)

新增可视化开发和文档工具：
- `capture_screenshot` - 场景截图用于视觉验证
- `attach_script` - 将 GDScript 连接到节点
- `connect_signal` - UI 交互信号连接
- `set_node_property` - 设置位置、颜色、主题属性
- `delete_node` - 场景清理
- `query_documentation` - Godot API 查询
- `validate_api` - 防止 API 幻觉
- `DocManager` - 首次使用时自动从 GitHub 下载文档

---

### 2026-01-30

#### `f341234` - chore: bump to 0.1.1, add npm metadata
**作者**: Solomon Elias  
**变更**: `package.json` (+23 / -15 行)

- 版本提升至 0.1.1
- 添加 npm 元数据

---

### 2026-01-29

#### `21c785d` - Merge pull request #67 from wcole3/rce-exec-fix
**作者**: Solomon Elias  

合并 PR #67：切换到 execFile 以缓解潜在的 shell 注入（参见 #64）

---

### 2026-01-26

#### `96fe4f7` - fix: switch to execFile to mitigate shell injection
**作者**: wcole3  
**变更**: `src/index.ts` (+27 / -37 行)

安全修复：切换到 `execFile` 以防止命令注入攻击。

---

### 2026-01-05

#### `90b907a` - fix: remaining console.debug writing to stdout
**作者**: Solomon Elias  
**变更**: `src/index.ts` (+1 / -1 行)

修复：阻止剩余的 `console.debug` 写入 stdout，避免 JSON-RPC 通信错误。

---

#### `b7ae146` - Merge pull request #60 from Coding-Solo/fix/remove-default-keyword
**作者**: Solomon Elias  

合并 PR #60：从工具模式中移除无效的 default 关键字

---

#### `926a850` - remove invalid 'default' keyword
**作者**: Solomon Elias  
**变更**: `src/index.ts` (-2 行)

修复：移除无效的 `default` 关键字。

---

#### `2466543` - Merge pull request #25 from raihaku/bugfix/logNotValidJson
**作者**: Solomon Elias  

合并 PR #25：修复 stdout/stderr 处理以防止 JSON-RPC 通信错误

---

#### `e5da166` - Merge pull request #47 from iocron/main
**作者**: Solomon Elias  

合并 PR #47：修复 npm 依赖安全问题

---

### 2025-10-21

#### `ab02801` - fix: npm dependencies form-data unsafe + axios DoS
**作者**: iocron  
**变更**: `package-lock.json` (+8 / -7 行)

安全修复：
- 修复 form-data 不安全漏洞
- 修复 axios DoS 漏洞

---

### 2025-08-09

#### `32508d1` - Merge pull request #34 from MiguelRipoll23/main
**作者**: Solomon Elias  

合并 PR #34：修复 Windows 上的 JSON 参数解析

---

### 2025-08-04

#### `31f62a7` - add github sponsors badge to README
**作者**: Solomon Elias  
**变更**: `README.md` (+2 行)

在 README 中添加 GitHub Sponsors 徽章。

---

#### `8855720` - add github sponsors
**作者**: Solomon Elias  
**变更**: `.github/FUNDING.yml` (+15 行)

添加 GitHub Sponsors 配置文件。

---

### 2025-07-15

#### `309936f` - Merge pull request #1 from MiguelRipoll23/codex/fix-json-parameter-parsing-on-windows
**作者**: Miguel Ripoll  

合并 PR #1：修复 Windows 上 JSON 参数的引号处理

---

## 📊 统计汇总

### 按类型统计

| 类型 | 数量 |
|------|------|
| feat (新功能) | 5 |
| docs (文档) | 3 |
| fix (修复) | 5 |
| chore (杂项) | 2 |
| merge (合并) | 5 |

### 按作者统计

| 作者 | 提交数 |
|------|--------|
| ishmael816 | 7 |
| Solomon Elias | 10 |
| wcole3 | 1 |
| iocron | 1 |
| Miguel Ripoll | 1 |

---

## 🔗 相关链接

- [项目主页](https://github.com/Coding-Solo/godot-mcp)
- [问题追踪](https://github.com/Coding-Solo/godot-mcp/issues)
- [贡献指南](./CONTRIBUTING.md)
