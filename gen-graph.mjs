#!/usr/bin/env node
// claude-dependency-mapper — dependency-graph generator.
//
// Produces, from a single static-import analysis of a JS/TS project:
//   * obsidian-graph/    — a human Obsidian vault (one note per file, [[wikilinks]])
//   * PROJECT_MAP.md     — a compact AI-facing adjacency list (only for larger projects)
// and idempotently updates .gitignore, CLAUDE.md and a PostToolUse hook in
// .claude/settings.json that auto-refreshes the graphs when source files change.
//
// Usage:
//   node gen-graph.mjs [projectRoot] [--threshold=40] [--route=directed|compact]
//   node gen-graph.mjs --hook        (internal: invoked by the PostToolUse hook)
//   node gen-graph.mjs --no-config   (regenerate graphs only; skip gitignore/CLAUDE/hook)
//   node gen-graph.mjs --quiet
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const ROOT = path.resolve(positional[0] || process.cwd());
const THRESHOLD = Number(flags.threshold ?? 40);
const FORCE_ROUTE = flags.route;          // 'directed' | 'compact' | undefined
const HOOK_MODE = !!flags.hook;
const QUIET = !!(flags.quiet || HOOK_MODE);
const NO_CONFIG = !!(flags['no-config'] || HOOK_MODE);

// ---------------------------------------------------------------- config
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.astro'];
const ASSET_EXT = ['.css', '.scss', '.sass', '.less', '.json', '.svg', '.png',
  '.jpg', '.jpeg', '.gif', '.webp'];
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.turbo', '.cache', '.parcel-cache', 'obsidian-graph', '.obsidian',
  'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target', 'bin', 'obj',
]);

const SRC = fs.existsSync(path.join(ROOT, 'src')) &&
  fs.statSync(path.join(ROOT, 'src')).isDirectory()
  ? path.join(ROOT, 'src')
  : ROOT;
const OUT = path.join(ROOT, 'obsidian-graph');

// ---------------------------------------------------------------- hook gate
// In hook mode, read the PostToolUse payload from stdin and bail out quietly
// unless the edited file is a source code file under the source base.
if (HOOK_MODE) {
  let fp;
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    fp = payload?.tool_input?.file_path || payload?.tool_input?.filePath;
  } catch { /* ignore */ }
  if (!fp) process.exit(0);
  const abs = path.resolve(ROOT, fp);
  const ext = path.extname(abs);
  const underSrc = abs === SRC || abs.startsWith(SRC + path.sep);
  const inGraph = abs.includes(`${path.sep}obsidian-graph${path.sep}`);
  if (!CODE_EXT.includes(ext) || !underSrc || inGraph) process.exit(0);
}

// ---------------------------------------------------------------- helpers
function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc);
    } else acc.push(path.join(dir, e.name));
  }
  return acc;
}
function toId(abs) {
  let rel = path.relative(SRC, abs).split(path.sep).join('/');
  const ext = path.extname(rel);
  if (CODE_EXT.includes(ext)) rel = rel.slice(0, -ext.length);
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  if (rel === 'index') rel = path.basename(SRC);
  return rel;
}
function toIdRaw(abs) {
  return path.relative(SRC, abs).split(path.sep).join('/');
}
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../'))
    base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('figma:asset/')) return { external: true, label: 'figma:asset' };
  else return null;
  const candidates = [
    base,
    ...[...CODE_EXT, ...ASSET_EXT].map(e => base + e),
    ...CODE_EXT.map(e => path.join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile())
        return ASSET_EXT.includes(path.extname(c))
          ? { asset: true, id: toIdRaw(c) } : { id: toId(c) };
    } catch { /* not found */ }
  }
  return { id: toId(base) };
}
function tagOf(id) {
  if (id.includes('components/ui/')) return 'ui';
  if (id.includes('components/')) return 'component';
  if (/(^|\/)(hooks|lib|utils|api|services|store|state)(\/|$)/.test(id)) return 'core';
  if (id.startsWith('app/') || id.startsWith('pages/') || id.startsWith('routes/')) return 'app';
  return 'module';
}
function upsertBlock(file, start, end, body, prepend = false) {
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const block = `${start}\n${body}\n${end}`;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc(start) + '[\\s\\S]*?' + esc(end));
  if (re.test(content)) content = content.replace(re, block);
  else if (!content.trim()) content = block + '\n';
  else if (prepend) content = block + '\n\n' + content;
  else content = content.replace(/\s*$/, '') + '\n\n' + block + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
function installHook(root) {
  const dir = path.join(root, '.claude');
  const file = path.join(dir, 'settings.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new/empty */ }
  cfg.hooks ??= {};
  cfg.hooks.PostToolUse ??= [];
  const cmd = `node "${SELF.split(path.sep).join('/')}" --hook`;
  // drop any previous claude-dependency-mapper hook entries (idempotent)
  cfg.hooks.PostToolUse = cfg.hooks.PostToolUse.filter(entry =>
    !(entry.hooks || []).some(h =>
      typeof h.command === 'string' &&
      h.command.includes('gen-graph.mjs') && h.command.includes('--hook')));
  cfg.hooks.PostToolUse.push({
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: cmd }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return file;
}

// ---------------------------------------------------------------- main
function main() {
  const codeFiles = walk(SRC)
    .filter(f => CODE_EXT.includes(path.extname(f)))
    .filter(f => !f.includes(`${path.sep}obsidian-graph${path.sep}`));

  if (codeFiles.length === 0) {
    if (!QUIET) {
      console.error('No JS/TS-family source files found under ' + SRC);
      console.log('RESULT: files=0 route=none');
    }
    return;
  }

  // parse imports
  const IMPORT_RE =
    /import\s+(?:[\w*\s{},$]+\s+from\s+)?["']([^"']+)["']|export\s+(?:[\w*\s{},$]+\s+)?from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
  const nodes = [];
  for (const file of codeFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const internal = new Set(), external = new Set(), assets = new Set();
    let m; IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec) continue;
      const r = resolveImport(spec, file);
      if (r === null) {
        let pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        external.add(pkg.replace(/@\d[\w.\-]*$/, ''));
      } else if (r.external) external.add(r.label);
      else if (r.asset) assets.add(r.id);
      else if (r.id) internal.add(r.id);
    }
    nodes.push({ id: toId(file), file, internal, external, assets });
  }

  const dependents = new Map();
  for (const n of nodes)
    for (const dep of n.internal) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(n.id);
    }

  const route = FORCE_ROUTE || (codeFiles.length >= THRESHOLD ? 'compact' : 'directed');

  // ---- Obsidian vault
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const writeNote = (rel, content) => {
    const full = path.join(OUT, rel + '.md');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  for (const n of nodes) {
    const deps = [...n.internal].sort();
    const usedBy = [...(dependents.get(n.id) || [])].sort();
    const ext = [...n.external].sort();
    const L = ['---', `type: ${tagOf(n.id)}`,
      `file: ${path.relative(ROOT, n.file).split(path.sep).join('/')}`,
      `tags: [${tagOf(n.id)}]`, '---', '', `# ${path.basename(n.id)}`, '',
      '## Importa (depende de)',
      deps.length ? deps.map(d => `- [[${d}]]`).join('\n') : '_(ninguno interno)_', '',
      '## Usado por',
      usedBy.length ? usedBy.map(d => `- [[${d}]]`).join('\n') : '_(nadie lo importa)_', ''];
    if (ext.length) L.push('## Paquetes externos', ext.map(e => `- \`${e}\``).join('\n'), '');
    writeNote(n.id, L.join('\n'));
  }
  const byType = {};
  for (const n of nodes) (byType[tagOf(n.id)] ??= []).push(n.id);
  const idx = ['# ' + path.basename(ROOT) + ' — Grafo de dependencias', '',
    `> Auto-generado. ${nodes.length} archivos. Ruta IA: ${route}.`, '',
    'Abre esta carpeta como *vault* en Obsidian y pulsa **Ctrl/Cmd+G** (Graph View).', ''];
  for (const t of Object.keys(byType).sort()) {
    idx.push(`## ${t} (${byType[t].length})`,
      byType[t].sort().map(id => `- [[${id}]]`).join('\n'), '');
  }
  writeNote('_INDEX', idx.join('\n'));

  // ---- compact PROJECT_MAP
  let mapWritten = false;
  if (route === 'compact') {
    const lines = [
      '# PROJECT_MAP — auto-generated dependency index (do not edit by hand)',
      `# ${nodes.length} files. Auto-refreshed on source edits; or run /claude-dependency-mapper.`,
      '# format:  <file>  imp: <imports>  by: <dependents>   (paths relative to source base)',
      ''];
    for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const imp = [...n.internal].sort().join(', ');
      const by = [...(dependents.get(n.id) || [])].sort().join(', ');
      let line = n.id;
      if (imp) line += `  imp: ${imp}`;
      if (by) line += `  by: ${by}`;
      lines.push(line);
    }
    fs.writeFileSync(path.join(ROOT, 'PROJECT_MAP.md'), lines.join('\n') + '\n', 'utf8');
    mapWritten = true;
  } else {
    fs.rmSync(path.join(ROOT, 'PROJECT_MAP.md'), { force: true });
  }

  // ---- one-time config (skipped in --hook / --no-config)
  let hookFile = null;
  if (!NO_CONFIG) {
    upsertBlock(path.join(ROOT, '.gitignore'),
      '# >>> claude-dependency-mapper >>>', '# <<< claude-dependency-mapper <<<',
      ['# Dependency graphs generated by /claude-dependency-mapper (not committed)',
        'obsidian-graph/', 'PROJECT_MAP.md'].join('\n'));

    const claudeBody = route === 'compact'
      ? ['## Codebase navigation (managed by /claude-dependency-mapper)', '',
        `This project has a precomputed dependency index at \`PROJECT_MAP.md\` (${nodes.length} files).`,
        "Read it **before** fanning out with Grep/Glob: each line lists a file's imports (`imp:`)",
        "and its dependents (`by:`), so you can find the relevant files and a change's blast radius",
        'cheaply. It is auto-refreshed on source edits. The map is gitignored.', '',
        'A human-facing Obsidian graph also exists in `obsidian-graph/` (gitignored).'].join('\n')
      : ['## Codebase navigation (managed by /claude-dependency-mapper)', '',
        `Small project (${nodes.length} code files) — directed exploration (Grep/Glob/Read) is cheap`,
        'enough, so no static dependency map is maintained. A human-facing Obsidian graph exists in',
        '`obsidian-graph/` (gitignored), auto-refreshed on source edits.'].join('\n');
    upsertBlock(path.join(ROOT, 'CLAUDE.md'),
      '<!-- claude-dependency-mapper:start -->', '<!-- claude-dependency-mapper:end -->', claudeBody, true);

    hookFile = installHook(ROOT);
  }

  // ---- report
  if (!QUIET) {
    console.log(`obsidian-graph/  : ${nodes.length} notes`);
    console.log(`PROJECT_MAP.md   : ${mapWritten ? 'written (compact route)' : 'skipped (directed route)'}`);
    if (!NO_CONFIG) {
      console.log('.gitignore       : managed block updated');
      console.log('CLAUDE.md        : managed block updated');
      console.log(`auto-refresh hook: installed in ${path.relative(ROOT, hookFile)}`);
    }
    console.log(`RESULT: files=${codeFiles.length} route=${route} threshold=${THRESHOLD} src=${path.relative(ROOT, SRC) || '.'}`);
  }
}

try { main(); } catch (e) { if (!HOOK_MODE) throw e; }
