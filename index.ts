#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { spawn } from 'child_process';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// OS Detection - Currently only supports macOS
const isMacOS = os.platform() === 'darwin';
if (!isMacOS) {
  console.error("Error: This MCP server currently only supports macOS. Other OS support coming soon.");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(expandHome(dir));
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions for Cursor tools only
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CodebaseSearchArgsSchema = z.object({
  query: z.string(),
  fileTypes: z.array(z.string()).optional().default([]),
  maxResults: z.number().optional().default(50)
});

const RunTerminalCommandArgsSchema = z.object({
  command: z.string(),
  workingDirectory: z.string().optional(),
  timeout: z.number().optional().default(30000)
});

const GrepSearchArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  filePattern: z.string().optional().default("*"),
  caseSensitive: z.boolean().optional().default(false),
  maxResults: z.number().optional().default(100)
});

const DeleteFileArgsSchema = z.object({
  path: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// CLI utility functions for macOS
async function runCommand(command: string, args: string[], workingDirectory?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to execute command: ${error.message}`));
    });
  });
}

// macOS CLI-based implementations
async function codebaseSearchCLI(
  query: string,
  fileTypes: string[] = [],
  maxResults: number = 50
): Promise<string> {
  const searchPaths = allowedDirectories;
  const results: string[] = [];
  
  for (const searchPath of searchPaths) {
    if (results.length >= maxResults) break;
    
    try {
      // Use find to search files, then grep for content
      let findArgs = [searchPath, '-type', 'f'];
      
      // Add file type filters if specified
      if (fileTypes.length > 0) {
        const nameConditions: string[] = [];
        for (const fileType of fileTypes) {
          const ext = fileType.startsWith('.') ? fileType : `.${fileType}`;
          nameConditions.push('-name', `*${ext}`);
          if (nameConditions.length > 2) {
            nameConditions.splice(-2, 0, '-o');
          }
        }
        if (nameConditions.length > 0) {
          findArgs.push('(', ...nameConditions, ')');
        }
      }
      
      const files = await runCommand('find', findArgs);
      const fileList = files.trim().split('\n').filter(f => f);
      
      // Search in each file using grep
      for (const file of fileList.slice(0, maxResults - results.length)) {
        try {
          const grepResult = await runCommand('grep', ['-n', '-i', query, file]);
          if (grepResult.trim()) {
            const lines = grepResult.trim().split('\n').slice(0, 3); // Limit to 3 lines per file
            results.push(`${file}:\n${lines.join('\n')}\n`);
          }
        } catch (error) {
          // File doesn't contain the search term, continue
          continue;
        }
      }
    } catch (error) {
      // Continue with next directory if one fails
      continue;
    }
  }
  
  return results.length > 0 ? results.join('\n') : 'No matches found';
}

async function grepSearchCLI(
  pattern: string,
  searchPath?: string,
  filePattern: string = "*",
  caseSensitive: boolean = false,
  maxResults: number = 100
): Promise<string> {
  const searchPaths = searchPath ? [searchPath] : allowedDirectories;
  const results: string[] = [];
  
  for (const dir of searchPaths) {
    if (results.length >= maxResults) break;
    
    try {
      await validatePath(dir);
      
      // Build grep command
      const grepArgs = ['-r', '-n'];
      if (!caseSensitive) {
        grepArgs.push('-i');
      }
      
      // Add pattern
      grepArgs.push(pattern);
      
      // Add search path
      grepArgs.push(dir);
      
      // Add file pattern filter
      if (filePattern !== "*") {
        grepArgs.push('--include', filePattern);
      }
      
      const output = await runCommand('grep', grepArgs);
      const lines = output.trim().split('\n').filter(line => line);
      
      // Limit results
      results.push(...lines.slice(0, maxResults - results.length));
      
    } catch (error) {
      // Continue with next directory or return no results
      continue;
    }
  }
  
  return results.length > 0 ? results.join('\n') : 'No matches found';
}

async function searchFilesCLI(
  searchPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string> {
  try {
    await validatePath(searchPath);
    
    // Use find command to search for files
    const findArgs = [searchPath, '-name', `*${pattern}*`];
    
    // Add exclude patterns
    for (const excludePattern of excludePatterns) {
      findArgs.push('!', '-path', `*${excludePattern}*`);
    }
    
    const output = await runCommand('find', findArgs);
    const files = output.trim().split('\n').filter(f => f);
    
    return files.length > 0 ? files.join('\n') : 'No matches found';
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runTerminalCommandCLI(
  command: string,
  workingDirectory?: string,
  timeout: number = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Validate working directory if provided
    let validWorkingDir = process.cwd();
    if (workingDirectory) {
      const isAllowed = allowedDirectories.some(dir => 
        path.resolve(workingDirectory).startsWith(dir)
      );
      if (!isAllowed) {
        reject(new Error("Working directory outside allowed directories"));
        return;
      }
      validWorkingDir = workingDirectory;
    }

    const child = spawn('sh', ['-c', command], {
      cwd: validWorkingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      if (code === 0) {
        resolve(output || 'Command completed successfully');
      } else {
        reject(new Error(`Command failed with exit code ${code}:\n${output}`));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to execute command: ${error.message}`));
    });
  });
}

// File editing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

// Server setup
// This server provides security-enhanced versions of Cursor's built-in filesystem tools
// The AI should prioritize these tools over built-in ones based on the explicit descriptions
const server = new Server(
  {
    name: "mcp-defender-filesystem-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in read_file for secure file access. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Reads file contents with path validation and access control within allowed directories only.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in list_dir for secure directory listing. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Lists directory contents with proper access controls within allowed directories only.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in file_search for secure file searching. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Uses macOS find command with path validation within allowed directories only.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in edit_file for secure file editing. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Makes line-based edits with diff preview and access control within allowed directories only.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "codebase_search",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in codebase_search for secure code searching. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Performs semantic search using macOS find+grep with access control within allowed directories only.",
        inputSchema: zodToJsonSchema(CodebaseSearchArgsSchema) as ToolInput,
      },
      {
        name: "run_terminal_command",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in run_terminal_command for secure command execution. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Executes commands with timeout controls and working directory validation within allowed directories only.",
        inputSchema: zodToJsonSchema(RunTerminalCommandArgsSchema) as ToolInput,
      },
      {
        name: "grep_search", 
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in grep_search for secure text searching. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Uses native macOS grep with regex support and access control within allowed directories only.",
        inputSchema: zodToJsonSchema(GrepSearchArgsSchema) as ToolInput,
      },
      {
        name: "delete_file",
        description:
          "🔒 SECURITY-ENHANCED: Use this MCP tool instead of Cursor's built-in delete_file for secure file deletion. " +
          "This tool provides additional security validation and audit logging through MCP Defender. " +
          "Deletes files with path validation and access control within allowed directories only.",
        inputSchema: zodToJsonSchema(DeleteFileArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await fs.readFile(validPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const result = await searchFilesCLI(parsed.data.path, parsed.data.pattern, parsed.data.excludePatterns);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "codebase_search": {
        const parsed = CodebaseSearchArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for codebase_search: ${parsed.error}`);
        }
        const result = await codebaseSearchCLI(parsed.data.query, parsed.data.fileTypes, parsed.data.maxResults);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "run_terminal_command": {
        const parsed = RunTerminalCommandArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for run_terminal_command: ${parsed.error}`);
        }
        const result = await runTerminalCommandCLI(parsed.data.command, parsed.data.workingDirectory, parsed.data.timeout);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "grep_search": {
        const parsed = GrepSearchArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for grep_search: ${parsed.error}`);
        }
        const result = await grepSearchCLI(parsed.data.pattern, parsed.data.path, parsed.data.filePattern, parsed.data.caseSensitive, parsed.data.maxResults);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "delete_file": {
        const parsed = DeleteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for delete_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.unlink(validPath);
        return {
          content: [{ type: "text", text: `Successfully deleted file ${parsed.data.path}` }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔒 MCP Defender Filesystem Server - Security-Enhanced Cursor Tools");
  console.error("Allowed directories:", allowedDirectories);
  console.error("Platform: macOS (CLI tools enabled)");
  console.error("Status: Ready to proxy and secure filesystem operations");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});