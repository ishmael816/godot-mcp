/**
 * 通用文件操作工具
 * 提供安全的文件读写功能
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { dirname, join, normalize, isAbsolute, relative } from 'path';

export interface FileReadResult {
  success: boolean;
  content?: string;
  error?: string;
  path: string;
  size: number;
  modified: Date;
}

export interface FileWriteResult {
  success: boolean;
  error?: string;
  path: string;
  bytesWritten: number;
  backupPath?: string;
}

export class FileUtils {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = normalize(projectPath);
  }

  /**
   * 安全地解析路径，防止路径遍历攻击
   */
  resolvePath(filePath: string): string {
    // 如果已经是绝对路径，检查是否在项目内
    if (isAbsolute(filePath)) {
      const normalized = normalize(filePath);
      if (!normalized.startsWith(this.projectPath)) {
        throw new Error(`Path outside project: ${filePath}`);
      }
      return normalized;
    }
    
    // 相对路径，拼接到项目路径
    return join(this.projectPath, filePath);
  }

  /**
   * 读取文本文件
   */
  readText(filePath: string): FileReadResult {
    try {
      const fullPath = this.resolvePath(filePath);
      
      if (!existsSync(fullPath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
          path: fullPath,
          size: 0,
          modified: new Date()
        };
      }

      const content = readFileSync(fullPath, 'utf-8');
      const stats = statSync(fullPath);
      
      return {
        success: true,
        content,
        path: fullPath,
        size: stats.size,
        modified: stats.mtime
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to read file: ${error.message}`,
        path: filePath,
        size: 0,
        modified: new Date()
      };
    }
  }

  /**
   * 写入文本文件
   */
  writeText(filePath: string, content: string, options?: { backup?: boolean; createDirs?: boolean }): FileWriteResult {
    try {
      const fullPath = this.resolvePath(filePath);
      
      // 确保目录存在
      if (options?.createDirs !== false) {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      // 创建备份
      let backupPath: string | undefined;
      if (options?.backup && existsSync(fullPath)) {
        backupPath = `${fullPath}.backup.${Date.now()}`;
        copyFileSync(fullPath, backupPath);
      }

      writeFileSync(fullPath, content, 'utf-8');
      
      return {
        success: true,
        path: fullPath,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        backupPath
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to write file: ${error.message}`,
        path: filePath,
        bytesWritten: 0
      };
    }
  }

  /**
   * 检查文件是否存在
   */
  exists(filePath: string): boolean {
    try {
      const fullPath = this.resolvePath(filePath);
      return existsSync(fullPath);
    } catch {
      return false;
    }
  }

  /**
   * 在文件内容中搜索
   */
  searchInFile(filePath: string, pattern: string | RegExp): Array<{ line: number; content: string; match: string }> {
    const result = this.readText(filePath);
    if (!result.success || !result.content) {
      return [];
    }

    const lines = result.content.split('\n');
    const matches: Array<{ line: number; content: string; match: string }> = [];

    lines.forEach((line, index) => {
      if (typeof pattern === 'string') {
        if (line.includes(pattern)) {
          matches.push({ line: index + 1, content: line.trim(), match: pattern });
        }
      } else {
        const match = line.match(pattern);
        if (match) {
          matches.push({ line: index + 1, content: line.trim(), match: match[0] });
        }
      }
    });

    return matches;
  }
}
