# MCP Defender Secure Tools

Node.js MCP server providing security-enhanced versions of Cursor's built-in tools for secure development workflows.

## Overview

MCP Defender Secure Tools acts as a secure proxy layer between Cursor IDE and filesystem operations. By providing security-enhanced versions of Cursor's built-in tools through the Model Context Protocol (MCP), this server enables MCP Defender to monitor, validate, and secure all tool interactions within allowed directory boundaries.

## Key Features

- **Security-Enhanced Tool Mapping**: Provides secure alternatives to Cursor's built-in tools
- **Path Validation**: All operations are restricted to pre-configured allowed directories
- **Audit Logging**: Integration with MCP Defender for comprehensive security monitoring  
- **Access Control**: Symlink validation and real path checking
- **macOS CLI Integration**: Leverages native macOS tools for optimal performance

## Architecture

This MCP server intercepts and secures the following Cursor tool operations:

- File reading and editing
- Directory listing and searching
- Code searching and text searching (grep)
- Terminal command execution
- File deletion

Each tool includes explicit messaging to prioritize the secure MCP version over Cursor's built-in equivalents.

## Available Tools

### File Operations

#### `read_file`
🔒 **Security-Enhanced**: Secure file reading with path validation
- **Input**: `path` (string)
- **Security**: Path validation, symlink resolution, directory boundary checking

#### `edit_file` 
🔒 **Security-Enhanced**: Secure file editing with diff preview
- **Input**: 
  - `path` (string): File to edit
  - `edits` (array): Edit operations with oldText/newText pairs
  - `dryRun` (boolean): Preview changes without applying
- **Security**: Path validation, atomic operations, diff preview for safety

#### `delete_file`
🔒 **Security-Enhanced**: Secure file deletion
- **Input**: `path` (string)
- **Security**: Path validation before deletion

### Directory Operations

#### `list_directory`
🔒 **Security-Enhanced**: Secure directory listing  
- **Input**: `path` (string)
- **Security**: Directory boundary validation
- **Output**: Formatted list with [DIR]/[FILE] prefixes

#### `search_files`
🔒 **Security-Enhanced**: Secure file search using macOS find
- **Input**:
  - `path` (string): Starting directory
  - `pattern` (string): Search pattern
  - `excludePatterns` (string[]): Patterns to exclude
- **Security**: Path validation, restricted to allowed directories

### Code Search Operations

#### `codebase_search`
🔒 **Security-Enhanced**: Secure semantic code search
- **Input**:
  - `query` (string): Search query
  - `fileTypes` (string[]): File type filters (optional)
  - `maxResults` (number): Result limit (default: 50)
- **Security**: Uses macOS find+grep with directory restrictions

#### `grep_search`
🔒 **Security-Enhanced**: Secure text search with regex support
- **Input**:
  - `pattern` (string): Search pattern
  - `path` (string): Search path (optional)
  - `filePattern` (string): File pattern filter (default: "*")
  - `caseSensitive` (boolean): Case sensitivity (default: false)
  - `maxResults` (number): Result limit (default: 100)
- **Security**: Native macOS grep with access control

### System Operations

#### `run_terminal_command`
🔒 **Security-Enhanced**: Secure command execution
- **Input**:
  - `command` (string): Command to execute
  - `workingDirectory` (string): Working directory (optional)
  - `timeout` (number): Timeout in ms (default: 30000)
- **Security**: Working directory validation, timeout controls, sandboxed execution

## Platform Support

**Currently Supported**: macOS (darwin)
- Leverages native macOS CLI tools (find, grep, sh)
- Optimized for macOS filesystem operations

**Coming Soon**: Linux and Windows support

## Installation & Usage

### NPX Installation
```bash
npx @mcpdefender/mcp-defender-secure-tools /path/to/allowed/directory [additional/directories...]
```

### Usage with Cursor/Claude Desktop

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "mcp-defender-secure-tools": {
      "command": "npx",
      "args": [
        "-y",
        "@mcpdefender/mcp-defender-secure-tools",
        "/Users/username/Projects",
        "/Users/username/Documents/Code"
      ]
    }
  }
}
```

### Directory Security

The server requires explicit directory arguments for security:

```bash
# Allow access to specific directories only
npx @mcpdefender/mcp-defender-secure-tools \
  ~/Projects \
  ~/Documents/Code \
  ~/workspace/current-project
```

**Security Model**:
- Only operations within specified directories are allowed
- Symlinks are resolved and validated against allowed paths
- Parent directory validation for new file creation
- Real path checking prevents directory traversal attacks

## Integration with MCP Defender

This server is designed to work seamlessly with MCP Defender for:

- **Tool Traffic Monitoring**: All tool calls are logged and monitored
- **Security Policy Enforcement**: Directory restrictions and access controls
- **Audit Trail**: Comprehensive logging of all filesystem operations
- **Threat Detection**: Suspicious activity detection and prevention

## Development

### Build
```bash
npm run build
```

### Watch Mode
```bash
npm run watch
```

### Project Structure
- `index.ts`: Main MCP server implementation
- `dist/`: Compiled JavaScript output
- Tool schemas defined using Zod for validation

## Security Considerations

- **Sandboxed Execution**: All operations restricted to allowed directories
- **Path Traversal Prevention**: Comprehensive path validation and normalization
- **Symlink Security**: Real path resolution and validation
- **Command Injection Protection**: Safe command execution with validation
- **Timeout Controls**: Prevents resource exhaustion attacks
- **Access Logging**: All operations logged for security monitoring

## Contributing

This project is part of the MCP Defender security ecosystem. Contributions should focus on:

- Enhanced security validations
- Additional platform support
- Performance optimizations
- Tool coverage expansion
