/**
 * 脚本文件管理器
 * 提供 GDScript 和 C# 脚本的基础读写操作
 * 将设计空间留给大模型，不做过多预设
 */

import { FileUtils } from '../utils/FileUtils.js';

export interface ScriptInfo {
  path: string;
  language: 'gdscript' | 'csharp';
  content: string;
  lineCount: number;
}

export interface LineRange {
  start: number;  // 1-based
  end: number;    // 1-based, inclusive
}

export class ScriptManager {
  private fileUtils: FileUtils;

  constructor(projectPath: string) {
    this.fileUtils = new FileUtils(projectPath);
  }

  /**
   * 检测脚本语言类型
   */
  detectLanguage(filePath: string): 'gdscript' | 'csharp' | 'unknown' {
    if (filePath.endsWith('.gd')) return 'gdscript';
    if (filePath.endsWith('.cs')) return 'csharp';
    return 'unknown';
  }

  /**
   * 读取脚本文件
   */
  readScript(filePath: string): { success: boolean; info?: ScriptInfo; error?: string } {
    const result = this.fileUtils.readText(filePath);
    
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const language = this.detectLanguage(filePath);
    if (language === 'unknown') {
      return { success: false, error: 'Unknown script language' };
    }

    const lineCount = result.content!.split('\n').length;

    return {
      success: true,
      info: {
        path: filePath,
        language,
        content: result.content!,
        lineCount
      }
    };
  }

  /**
   * 写入脚本文件
   */
  writeScript(filePath: string, content: string, options?: { backup?: boolean }): { success: boolean; error?: string } {
    const result = this.fileUtils.writeText(filePath, content, { 
      backup: options?.backup ?? true,
      createDirs: true 
    });

    return {
      success: result.success,
      error: result.error
    };
  }

  /**
   * 创建新脚本（带模板）
   */
  createScript(
    filePath: string, 
    language: 'gdscript' | 'csharp',
    template?: 'empty' | 'node2d' | 'node3d' | 'control' | 'characterbody2d'
  ): { success: boolean; content?: string; error?: string } {
    const templates: Record<string, Record<string, string>> = {
      gdscript: {
        empty: `extends Node

func _ready():
	pass
`,
        node2d: `extends Node2D

func _ready():
	pass

func _process(delta):
	pass
`,
        node3d: `extends Node3D

func _ready():
	pass

func _process(delta):
	pass
`,
        control: `extends Control

func _ready():
	pass
`,
        characterbody2d: `extends CharacterBody2D

@export var speed: float = 300.0
@export var jump_velocity: float = -400.0

func _physics_process(delta):
	# Add gravity
	if not is_on_floor():
		velocity += get_gravity() * delta

	# Handle jump
	if Input.is_action_just_pressed("ui_accept") and is_on_floor():
		velocity.y = jump_velocity

	# Get input direction
	var direction := Input.get_axis("ui_left", "ui_right")
	if direction:
		velocity.x = direction * speed
	else:
		velocity.x = move_toward(velocity.x, 0, speed)

	move_and_slide()
`
      },
      csharp: {
        empty: `using Godot;
using System;

public partial class NewScript : Node
{
    public override void _Ready()
    {
    }
}
`,
        node2d: `using Godot;
using System;

public partial class NewScript : Node2D
{
    public override void _Ready()
    {
    }

    public override void _Process(double delta)
    {
    }
}
`,
        characterbody2d: `using Godot;
using System;

public partial class NewScript : CharacterBody2D
{
    [Export]
    public float Speed { get; set; } = 300.0f;

    [Export]
    public float JumpVelocity { get; set; } = -400.0f;

    public override void _PhysicsProcess(double delta)
    {
        Vector2 velocity = Velocity;

        // Add gravity
        if (!IsOnFloor())
        {
            velocity += GetGravity() * (float)delta;
        }

        // Handle jump
        if (Input.IsActionJustPressed("ui_accept") && IsOnFloor())
        {
            velocity.Y = JumpVelocity;
        }

        // Get input direction
        float direction = Input.GetAxis("ui_left", "ui_right");
        if (direction != 0)
        {
            velocity.X = direction * Speed;
        }
        else
        {
            velocity.X = Mathf.MoveToward(Velocity.X, 0, Speed);
        }

        Velocity = velocity;
        MoveAndSlide();
    }
}
`
      }
    };

    const templateKey = template || 'empty';
    const content = templates[language][templateKey] || templates[language]['empty'];

    const result = this.writeScript(filePath, content, { backup: false });
    
    if (result.success) {
      return { success: true, content };
    } else {
      return { success: false, error: result.error };
    }
  }

  /**
   * 获取指定范围的行
   */
  getLines(filePath: string, range?: LineRange): { success: boolean; lines?: string[]; error?: string } {
    const readResult = this.readScript(filePath);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const allLines = readResult.info!.content.split('\n');
    
    if (!range) {
      return { success: true, lines: allLines };
    }

    const start = Math.max(0, range.start - 1);
    const end = Math.min(allLines.length, range.end);
    
    return { success: true, lines: allLines.slice(start, end) };
  }

  /**
   * 替换指定范围的行
   */
  replaceLines(filePath: string, range: LineRange, newContent: string): { success: boolean; error?: string } {
    const readResult = this.readScript(filePath);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const allLines = readResult.info!.content.split('\n');
    const start = Math.max(0, range.start - 1);
    const end = Math.min(allLines.length, range.end);

    const newLines = newContent.split('\n');
    const resultLines = [
      ...allLines.slice(0, start),
      ...newLines,
      ...allLines.slice(end)
    ];

    return this.writeScript(filePath, resultLines.join('\n'));
  }

  /**
   * 在指定行后插入内容
   */
  insertAfter(filePath: string, line: number, content: string): { success: boolean; error?: string } {
    const readResult = this.readScript(filePath);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const allLines = readResult.info!.content.split('\n');
    const insertIndex = Math.min(line, allLines.length);
    const newLines = content.split('\n');

    allLines.splice(insertIndex, 0, ...newLines);

    return this.writeScript(filePath, allLines.join('\n'));
  }

  /**
   * 在文件中搜索
   */
  search(filePath: string, pattern: string): { success: boolean; matches?: Array<{ line: number; content: string }>; error?: string } {
    const result = this.fileUtils.searchInFile(filePath, pattern);
    return {
      success: true,
      matches: result.map(r => ({ line: r.line, content: r.content }))
    };
  }

  /**
   * 替换文件中所有匹配的内容
   */
  replaceAll(filePath: string, search: string, replace: string): { success: boolean; count?: number; error?: string } {
    const readResult = this.readScript(filePath);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const content = readResult.info!.content;
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const newContent = content.replace(regex, replace);
    const count = (content.match(regex) || []).length;

    const writeResult = this.writeScript(filePath, newContent);
    
    return {
      success: writeResult.success,
      count,
      error: writeResult.error
    };
  }
}
