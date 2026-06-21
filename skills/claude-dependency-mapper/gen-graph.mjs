#!/usr/bin/env node
// claude-dependency-mapper — multi-language dependency-graph generator.
//
// Produces, from a static-import analysis of a project:
//   * obsidian-graph/    — a human Obsidian vault (one note per file, [[wikilinks]])
//   * PROJECT_MAP.md     — a compact AI-facing adjacency list (only for larger projects)
// and idempotently updates .gitignore, CLAUDE.md and a PostToolUse hook in
// .claude/settings.json that auto-refreshes the graphs when source files change.
//
// Languages: JavaScript/TypeScript, Python, Rust, Dart. Resolution is best-effort,
// regex-based, zero-dependency — great for visualization, not a compiler-grade graph.
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
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.turbo', '.cache', '.parcel-cache', 'obsidian-graph', '.obsidian',
  'vendor', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', 'target',
  'bin', 'obj', '.dart_tool', '.mypy_cache', '.pytest_cache', '.tox', 'site-packages',
]);
const ASSET_EXT = ['.css', '.scss', '.sass', '.less', '.json', '.svg', '.png',
  '.jpg', '.jpeg', '.gif', '.webp'];
// basenames that represent "the directory" rather than a distinct module
const COLLAPSE = new Set(['index', '__init__', 'mod']);

const ALIAS_BASE = existsDir(path.join(ROOT, 'src')) ? path.join(ROOT, 'src') : ROOT;
const OUT = path.join(ROOT, 'obsidian-graph');

// ---------------------------------------------------------------- fs helpers
function existsDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
function tryFile(p) { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } }
function firstExisting(cands) { for (const c of cands) { const f = tryFile(c); if (f) return f; } return null; }
const posix = p => p.split(path.sep).join('/');

let _dartPkg; // cache
function dartPkgName() {
  if (_dartPkg !== undefined) return _dartPkg;
  try {
    const m = fs.readFileSync(path.join(ROOT, 'pubspec.yaml'), 'utf8').match(/^name:\s*(\S+)/m);
    _dartPkg = m ? m[1] : null;
  } catch { _dartPkg = null; }
  return _dartPkg;
}

// ---------------------------------------------------------------- language registry
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'];
const JS_IMPORT_RE =
  /import\s+(?:[\w*\s{},$]+\s+from\s+)?["']([^"']+)["']|export\s+(?:[\w*\s{},$]+\s+)?from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

const LANGS = {
  js: {
    exts: JS_EXT,
    extract(src) {
      const out = []; let m; JS_IMPORT_RE.lastIndex = 0;
      while ((m = JS_IMPORT_RE.exec(src))) {
        const spec = m[1] || m[2] || m[3] || m[4];
        if (spec) out.push({ spec });
      }
      return out;
    },
    resolve({ spec, fromFile }) {
      let base;
      if (spec.startsWith('@/')) base = path.join(ALIAS_BASE, spec.slice(2));
      else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
      else if (spec.startsWith('figma:asset/')) return { external: 'figma:asset' };
      else { // npm package
        let pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        return { external: pkg.replace(/@\d[\w.\-]*$/, '') };
      }
      const f = firstExisting([
        base,
        ...[...JS_EXT, ...ASSET_EXT].map(e => base + e),
        ...JS_EXT.map(e => path.join(base, 'index' + e)),
      ]);
      if (!f) return { id: toId(base) };
      return ASSET_EXT.includes(path.extname(f)) ? { asset: posix(path.relative(ROOT, f)) } : { id: toId(f) };
    },
  },

  python: {
    exts: ['.py', '.pyi'],
    extract(src) {
      const out = [];
      const reFrom = /^[ \t]*from[ \t]+(\.*[A-Za-z0-9_.]*)[ \t]+import\b/gm;
      const reImp = /^[ \t]*import[ \t]+([A-Za-z0-9_.]+(?:[ \t]*,[ \t]*[A-Za-z0-9_.]+)*)/gm;
      let m;
      while ((m = reFrom.exec(src))) out.push({ spec: m[1], kind: 'rel-or-abs' });
      while ((m = reImp.exec(src))) for (const mod of m[1].split(',')) out.push({ spec: mod.trim(), kind: 'abs' });
      return out;
    },
    resolve({ spec, fromFile }) {
      if (!spec || spec === '__future__') return null;
      if (spec.startsWith('.')) {
        let dots = 0; while (spec[dots] === '.') dots++;
        let dir = path.dirname(fromFile);
        for (let k = 1; k < dots; k++) dir = path.dirname(dir);
        const rest = spec.slice(dots).replace(/\./g, '/');
        const base = rest ? path.join(dir, rest) : dir;
        const f = firstExisting([base + '.py', base + '.pyi', path.join(base, '__init__.py')]);
        return f ? { id: toId(f) } : null;
      }
      const segs = spec.split('.');
      const roots = [ROOT, path.join(ROOT, 'src')].filter(existsDir);
      for (const r of roots) {
        const base = path.join(r, ...segs);
        let f = firstExisting([base + '.py', base + '.pyi', path.join(base, '__init__.py')]);
        if (!f && segs.length > 1) {
          const b2 = path.join(r, ...segs.slice(0, -1));
          f = firstExisting([b2 + '.py', b2 + '.pyi', path.join(b2, '__init__.py')]);
        }
        if (f) return { id: toId(f) };
      }
      return { external: segs[0] };
    },
  },

  dart: {
    exts: ['.dart'],
    extract(src) {
      const out = []; const re = /(?:^|\s)(?:import|export|part)[ \t]+['"]([^'"]+)['"]/gm;
      let m; while ((m = re.exec(src))) out.push({ spec: m[1] });
      return out;
    },
    resolve({ spec, fromFile }) {
      if (spec.startsWith('dart:')) return { external: spec.split('/')[0] };
      if (spec.startsWith('package:')) {
        const rest = spec.slice('package:'.length);
        const slash = rest.indexOf('/');
        const pkg = slash >= 0 ? rest.slice(0, slash) : rest;
        const sub = slash >= 0 ? rest.slice(slash + 1) : '';
        if (pkg === dartPkgName() && sub) {
          const f = tryFile(path.join(ROOT, 'lib', sub));
          if (f) return { id: toId(f) };
        }
        return { external: 'package:' + pkg };
      }
      const base = path.resolve(path.dirname(fromFile), spec);
      const f = firstExisting([base, base + '.dart']);
      return f ? { id: toId(f) } : null;
    },
  },

  rust: {
    exts: ['.rs'],
    extract(src) {
      const out = [];
      const reMod = /(?:^|\s)(?:pub[ \t]+)?mod[ \t]+([A-Za-z0-9_]+)[ \t]*;/gm;
      const reUse = /(?:^|\s)(?:pub[ \t]+)?use[ \t]+((?:r#)?[A-Za-z0-9_:]+)/gm;
      let m;
      while ((m = reMod.exec(src))) out.push({ spec: m[1], kind: 'mod' });
      while ((m = reUse.exec(src))) out.push({ spec: m[1].replace(/r#/g, ''), kind: 'use' });
      return out;
    },
    resolve({ spec, kind, fromFile }) {
      const crateSrc = existsDir(path.join(ROOT, 'src')) ? path.join(ROOT, 'src') : ROOT;
      const dir = path.dirname(fromFile);
      const stem = path.basename(fromFile).replace(/\.rs$/, '');
      const isRoot = ['mod', 'lib', 'main'].includes(stem);
      const selfDir = isRoot ? dir : path.join(dir, stem);

      if (kind === 'mod') {
        const bases = isRoot ? [dir] : [path.join(dir, stem)];
        for (const b of bases) {
          const f = firstExisting([path.join(b, spec + '.rs'), path.join(b, spec, 'mod.rs')]);
          if (f) return { id: toId(f) };
        }
        return null;
      }
      // use — consume a leading run of crate / self / super (super may chain)
      const segs = spec.split('::').filter(Boolean);
      if (!segs.length) return null;
      let baseDir, i = 0;
      if (segs[0] === 'crate') { baseDir = crateSrc; i = 1; }
      else if (segs[0] === 'self' || segs[0] === 'super') {
        baseDir = selfDir;
        while (segs[i] === 'self' || segs[i] === 'super') {
          if (segs[i] === 'super') baseDir = path.dirname(baseDir);
          i++;
        }
      } else return { external: segs[0] };
      const rel = segs.slice(i);
      for (let take = rel.length; take >= 1; take--) {
        const base = path.join(baseDir, ...rel.slice(0, take));
        const f = firstExisting([base + '.rs', path.join(base, 'mod.rs')]);
        if (f && path.resolve(f) !== path.resolve(fromFile)) return { id: toId(f) };
      }
      return null;
    },
  },
};

const CODE_EXT = [...new Set(Object.values(LANGS).flatMap(l => l.exts))];
const EXT2LANG = {};
for (const [name, l] of Object.entries(LANGS)) for (const e of l.exts) EXT2LANG[e] = name;

// ---------------------------------------------------------------- ids
function isCodeExt(ext) { return CODE_EXT.includes(ext); }
function toId(abs) {
  let rel = posix(path.relative(ROOT, abs));
  const ext = path.extname(rel);
  if (isCodeExt(ext)) rel = rel.slice(0, -ext.length);
  const parts = rel.split('/');
  if (parts.length > 1 && COLLAPSE.has(parts[parts.length - 1])) parts.pop();
  rel = parts.join('/');
  if (!rel) rel = path.basename(ROOT);
  return rel;
}

// ---------------------------------------------------------------- hook gate
if (HOOK_MODE) {
  let fp;
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    fp = payload?.tool_input?.file_path || payload?.tool_input?.filePath;
  } catch { /* ignore */ }
  if (!fp) process.exit(0);
  const abs = path.resolve(ROOT, fp);
  const inGraph = abs.includes(`${path.sep}obsidian-graph${path.sep}`);
  if (!isCodeExt(path.extname(abs)) || inGraph) process.exit(0);
}

// ---------------------------------------------------------------- collect files
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

// ---------------------------------------------------------------- presentation
function folderTag(id, lang) {
  if (id.includes('components/ui/')) return 'ui';
  if (id.includes('components/')) return 'component';
  if (/(^|\/)(hooks|lib|utils|api|services|store|state)(\/|$)/.test(id)) return 'core';
  if (/(^|\/)(app|pages|routes|cmd|bin)(\/|$)/.test(id)) return 'app';
  return lang;
}
function upsertBlock(file, start, end, body, prepend = false) {
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
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
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  cfg.hooks ??= {};
  cfg.hooks.PostToolUse ??= [];
  const cmd = `node "${posix(SELF)}" --hook`;
  cfg.hooks.PostToolUse = cfg.hooks.PostToolUse.filter(entry =>
    !(entry.hooks || []).some(h =>
      typeof h.command === 'string' && h.command.includes('gen-graph.mjs') && h.command.includes('--hook')));
  cfg.hooks.PostToolUse.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd }] });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return file;
}

// ---------------------------------------------------------------- main
function main() {
  const codeFiles = walk(ROOT)
    .filter(f => isCodeExt(path.extname(f)))
    .filter(f => !posix(f).includes('/obsidian-graph/'));

  if (codeFiles.length === 0) {
    if (!QUIET) { console.error('No supported source files found under ' + ROOT); console.log('RESULT: files=0 route=none'); }
    return;
  }

  // parse + resolve
  const nodes = [];
  for (const file of codeFiles) {
    const lang = EXT2LANG[path.extname(file)];
    const src = fs.readFileSync(file, 'utf8');
    const internal = new Set(), external = new Set(), assets = new Set();
    const selfId = toId(file);
    for (const item of LANGS[lang].extract(src)) {
      const r = LANGS[lang].resolve({ ...item, fromFile: file });
      if (!r) continue;
      if (r.external) external.add(r.external);
      else if (r.asset) assets.add(r.asset);
      else if (r.id && r.id !== selfId) internal.add(r.id);
    }
    nodes.push({ id: selfId, file, lang, internal, external, assets });
  }
  // keep only edges that point to real nodes; the rest become "unresolved"
  const idSet = new Set(nodes.map(n => n.id));
  for (const n of nodes) {
    n.unresolved = [...n.internal].filter(d => !idSet.has(d)).sort();
    n.internal = new Set([...n.internal].filter(d => idSet.has(d)));
  }

  const dependents = new Map();
  for (const n of nodes)
    for (const dep of n.internal) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(n.id);
    }

  const route = FORCE_ROUTE || (codeFiles.length >= THRESHOLD ? 'compact' : 'directed');
  const langCounts = {};
  for (const n of nodes) langCounts[n.lang] = (langCounts[n.lang] || 0) + 1;

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
    const tag = folderTag(n.id, n.lang);
    const L = ['---', `lang: ${n.lang}`, `type: ${tag}`,
      `file: ${posix(path.relative(ROOT, n.file))}`,
      `tags: [${tag}, ${n.lang}]`, '---', '', `# ${path.basename(n.id)}`, '',
      '## Imports (depends on)',
      deps.length ? deps.map(d => `- [[${d}]]`).join('\n') : '_(none internal)_', '',
      '## Used by',
      usedBy.length ? usedBy.map(d => `- [[${d}]]`).join('\n') : '_(no importers)_', ''];
    if (ext.length) L.push('## External packages', ext.map(e => `- \`${e}\``).join('\n'), '');
    if (n.unresolved.length) L.push('## Unresolved', n.unresolved.map(e => `- \`${e}\``).join('\n'), '');
    writeNote(n.id, L.join('\n'));
  }
  const byType = {};
  for (const n of nodes) (byType[folderTag(n.id, n.lang)] ??= []).push(n.id);
  const idx = ['# ' + path.basename(ROOT) + ' — Dependency graph', '',
    `> Auto-generated. ${nodes.length} files (${Object.entries(langCounts).map(([k, v]) => `${k}:${v}`).join(', ')}). AI route: ${route}.`, '',
    'Open this folder as a *vault* in Obsidian and press **Ctrl/Cmd+G** (Graph View).', ''];
  for (const t of Object.keys(byType).sort()) {
    idx.push(`## ${t} (${byType[t].length})`, byType[t].sort().map(id => `- [[${id}]]`).join('\n'), '');
  }
  writeNote('_INDEX', idx.join('\n'));

  // ---- compact PROJECT_MAP
  let mapWritten = false;
  if (route === 'compact') {
    const lines = [
      '# PROJECT_MAP — auto-generated dependency index (do not edit by hand)',
      `# ${nodes.length} files (${Object.entries(langCounts).map(([k, v]) => `${k}:${v}`).join(', ')}). Auto-refreshed on source edits; or run /claude-dependency-mapper.`,
      '# format:  <file>  imp: <imports>  by: <dependents>   (paths relative to project root)',
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
        "Each line lists a file's imports (`imp:`) and its dependents (`by:`).", '',
        'Pick the token-cheapest tool for the task at hand:',
        '- Structural / blast-radius / "what depends on X" / multi-file change → read `PROJECT_MAP.md`',
        '  first; one read resolves the whole graph (far cheaper and more accurate than recursive Grep).',
        '- Single targeted lookup of one symbol or string → Grep directly and skip the map.', '',
        'It is auto-refreshed on source edits and gitignored. A human-facing Obsidian graph also',
        'exists in `obsidian-graph/` (gitignored).'].join('\n')
      : ['## Codebase navigation (managed by /claude-dependency-mapper)', '',
        `Small project (${nodes.length} source files) — directed exploration (Grep/Glob/Read) is cheap`,
        'enough, so no static dependency map is maintained. A human-facing Obsidian graph exists in',
        '`obsidian-graph/` (gitignored), auto-refreshed on source edits.'].join('\n');
    upsertBlock(path.join(ROOT, 'CLAUDE.md'),
      '<!-- claude-dependency-mapper:start -->', '<!-- claude-dependency-mapper:end -->', claudeBody, true);

    hookFile = installHook(ROOT);
  }

  // ---- report
  if (!QUIET) {
    console.log(`obsidian-graph/  : ${nodes.length} notes (${Object.entries(langCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`);
    console.log(`PROJECT_MAP.md   : ${mapWritten ? 'written (compact route)' : 'skipped (directed route)'}`);
    if (!NO_CONFIG) {
      console.log('.gitignore       : managed block updated');
      console.log('CLAUDE.md        : managed block updated');
      console.log(`auto-refresh hook: installed in ${path.relative(ROOT, hookFile)}`);
    }
    console.log(`RESULT: files=${codeFiles.length} route=${route} threshold=${THRESHOLD} langs=${Object.keys(langCounts).join('+')}`);
  }
}

try { main(); } catch (e) { if (!HOOK_MODE) throw e; }
