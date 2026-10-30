import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolError } from '../core/errors.mjs';

const SAFE_TEXT_LIMIT = 512 * 1024;

function resolvePath(p, ctx) {
  const resolved = path.resolve(ctx.config.root, p);
  return resolved;
}

function insideAllowed(resolved, ctx) {
  return ctx.config.isAllowedPath(resolved, { write: true });
}

function assertNoSensitive(resolved, ctx) {
  const norm = resolved.replaceAll('\\', '/');
  const patterns = ctx.config.sensitivePatterns;
  for (const pattern of patterns) {
    if (glob(pattern, norm)) {
      throw new ToolError('SENSITIVE_PATH', `Access to sensitive path blocked: ${resolved}`);
    }
  }
}

function glob(pattern, value) {
  const p = pattern.replaceAll('\\', '/');
  const escaped = p.split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function walk(root, { pattern, maxResults, maxDepth, includeDirs, skipDirs }) {
  const results = [];
  const re = pattern ? globToRegex(pattern) : null;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && results.length < maxResults) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) continue;
        if (includeDirs && (!re || re.test(entry.name))) results.push({ path: full, type: 'dir', size: 0 });
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        const rel = full.replaceAll('\\', '/');
        if (!re || re.test(entry.name) || re.test(rel)) {
          let size = 0;
          try { size = statSync(full).size; } catch { /* ignore */ }
          results.push({ path: full, type: 'file', size });
        }
      }
    }
  }
  return results;
}

function globToRegex(pattern) {
  const escaped = pattern.replaceAll('\\', '/').split('').map((ch) => {
    if (ch === '*') return '[^/]*';
    if (ch === '?') return '.';
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`${escaped.replaceAll('[^/]*[^/]*', '.*')}$`, 'i');
}

export const filesystemTools = [
  {
    name: 'filesystem.list',
    title: 'List a directory',
    category: 'filesystem',
    permission: 'observe',
    description: 'List files and folders in an authorized directory with size and modification time.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (absolute or workspace-relative)', default: '.' },
        limit: { type: 'integer', description: 'Maximum entries', minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
    pathArgs: ['path'],
    examples: [{ path: 'workspace' }],
    handler: async (args, ctx) => {
      const resolved = resolvePath(args.path ?? '.', ctx);
      assertNoSensitive(resolved, ctx);
      if (!existsSync(resolved)) throw new ToolError('NOT_FOUND', `Directory not found: ${resolved}`);
      if (!statSync(resolved).isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${resolved}`);
      const entries = readdirSync(resolved, { withFileTypes: true }).slice(0, args.limit ?? 100).map((e) => {
        const full = path.join(resolved, e.name);
        let size = 0; let mtime = null;
        try { const st = statSync(full); size = st.size; mtime = st.mtime.toISOString(); } catch { /* ignore */ }
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, modified: mtime, path: full };
      });
      return { path: resolved, count: entries.length, entries };
    },
  },
  {
    name: 'filesystem.search',
    title: 'Search files',
    category: 'filesystem',
    permission: 'observe',
    description: 'Search for files by glob pattern inside an authorized directory (bounded depth and result count). Use this instead of clicking through the desktop to find files.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to search', default: '.' },
        pattern: { type: 'string', description: 'Glob such as *.txt or **/*.log', default: '*' },
        max_results: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        max_depth: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
        include_dirs: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    pathArgs: ['root'],
    examples: [{ root: 'workspace', pattern: '*.txt' }],
    handler: async (args, ctx) => {
      const resolved = resolvePath(args.root ?? '.', ctx);
      assertNoSensitive(resolved, ctx);
      if (!existsSync(resolved)) throw new ToolError('NOT_FOUND', `Search root not found: ${resolved}`);
      const skip = new Set(['node_modules', '.git', '.agent', '$recycle.bin', 'windows', 'program files', 'program files (x86)', 'appdata']);
      const results = walk(resolved, {
        pattern: args.pattern ?? '*',
        maxResults: args.max_results ?? 50,
        maxDepth: args.max_depth ?? 6,
        includeDirs: args.include_dirs ?? false,
        skipDirs: skip,
      });
      return { root: resolved, pattern: args.pattern ?? '*', count: results.length, results };
    },
  },
  {
    name: 'filesystem.read_text',
    title: 'Read a text file',
    category: 'filesystem',
    permission: 'observe',
    description: 'Read a UTF-8 text file with size limits. Sensitive paths and files outside the workspace require approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        max_bytes: { type: 'integer', minimum: 1, maximum: 1048576, default: 131072 },
        approval_id: { type: 'string', description: 'Approval id for files outside the workspace' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: ['path'],
    examples: [{ path: 'workspace/test.txt' }],
    whenNotToUse: 'Do not read binaries, databases or private documents without explicit user authorization.',
    handler: async (args, ctx) => {
      const resolved = resolvePath(args.path, ctx);
      assertNoSensitive(resolved, ctx);
      if (!existsSync(resolved)) throw new ToolError('NOT_FOUND', `File not found: ${resolved}`);
      const st = statSync(resolved);
      if (!st.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a file: ${resolved}`);
      if (!insideAllowed(resolved, ctx)) {
        ctx.ensureApproval('outside_workspace_read', args, {
          summary: `Read file outside the workspace: ${resolved}`,
          risk: 'observe',
        });
      }
      const maxBytes = Math.min(args.max_bytes ?? 131072, SAFE_TEXT_LIMIT);
      const buf = readFileSync(resolved);
      const slice = buf.subarray(0, maxBytes);
      const text = slice.toString('utf8');
      return {
        path: resolved,
        size: st.size,
        bytes_read: slice.length,
        truncated: buf.length > slice.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        text,
      };
    },
  },
  {
    name: 'filesystem.write_text',
    title: 'Write a text file',
    category: 'filesystem',
    permission: 'modify',
    description: 'Write a UTF-8 text file inside the authorized workspace. Returns the final path, size and SHA-256 so the result can be verified programmatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination file path inside the workspace' },
        text: { type: 'string', description: 'Exact UTF-8 content', maxLength: 500000 },
        mode: { type: 'string', enum: ['overwrite', 'append', 'create'], default: 'overwrite' },
        create_dirs: { type: 'boolean', default: true },
        approval_id: { type: 'string', description: 'Approval id when overwriting outside the workspace' },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
    pathArgs: ['path'],
    examples: [{ path: 'workspace/test.txt', text: 'hello' }],
    whenNotToUse: 'Do not use to modify application binaries or files outside the approved workspace.',
    handler: async (args, ctx) => {
      const resolved = resolvePath(args.path, ctx);
      assertNoSensitive(resolved, ctx);
      const exists = existsSync(resolved);
      const inside = insideAllowed(resolved, ctx);
      if (!inside) {
        ctx.ensureApproval('outside_workspace_write', args, {
          summary: `Write outside the workspace: ${resolved}`,
          risk: 'modify',
        });
      }
      if (args.mode === 'create' && exists) throw new ToolError('ALREADY_EXISTS', `File already exists: ${resolved}`);
      mkdirSync(path.dirname(resolved), { recursive: true });
      if (args.mode === 'append' && exists) {
        writeFileSync(resolved, args.text, { encoding: 'utf8', flag: 'a' });
      } else {
        writeFileSync(resolved, args.text, { encoding: 'utf8' });
      }
      const st = statSync(resolved);
      const sha = createHash('sha256').update(readFileSync(resolved)).digest('hex');
      return { path: resolved, bytes: st.size, mode: args.mode ?? 'overwrite', sha256: sha, created_dirs: args.create_dirs ?? true };
    },
  },
  {
    name: 'filesystem.delete',
    title: 'Delete a file or folder',
    category: 'filesystem',
    permission: 'destructive',
    description: 'Delete a file or directory. Always requires explicit approval for the exact target. Refuses system paths and paths outside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact target path' },
        recursive: { type: 'boolean', description: 'Delete a directory recursively', default: false },
        approval_id: { type: 'string', description: 'Approval id for this exact target' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: ['path'],
    examples: [{ path: 'workspace/tmp/old.txt', approval_id: 'apr_12345678' }],
    whenNotToUse: 'Never delete user data without a backup or recovery strategy.',
    handler: async (args, ctx) => {
      const resolved = resolvePath(args.path, ctx);
      if (!insideAllowed(resolved, ctx)) {
        throw new ToolError('OUTSIDE_WORKSPACE', `Refusing to delete outside the workspace: ${resolved}`);
      }
      if (!existsSync(resolved)) throw new ToolError('NOT_FOUND', `Target not found: ${resolved}`);
      const st = statSync(resolved);
      if (st.isDirectory()) {
        if (!args.recursive) throw new ToolError('INVALID_ARGUMENT', 'Directory deletion requires recursive=true');
        rmSync(resolved, { recursive: true, force: false });
      } else {
        unlinkSync(resolved);
      }
      return { deleted: true, path: resolved, type: st.isDirectory() ? 'dir' : 'file', still_exists: existsSync(resolved) };
    },
  },
];
