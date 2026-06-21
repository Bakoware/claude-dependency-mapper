---
name: claude-dependency-mapper
description: Map a project's dependency graph. Generates an Obsidian vault (obsidian-graph/) for human visualization and, for medium/large codebases, a compact PROJECT_MAP.md for token-efficient AI navigation. Decides the route by file count, wires up CLAUDE.md, adds .gitignore entries so the graphs are not committed, and installs a PostToolUse hook that auto-refreshes the graphs on source edits. Use when the user runs /claude-dependency-mapper or asks to set up / refresh the project dependency graph.
---

# claude-dependency-mapper

Standardizes dependency-graph generation across all of the user's projects with a
single self-contained Node script. Produces two artifacts from the same analysis:

1. **Human graph** — an Obsidian vault in `obsidian-graph/` (one note per file with
   `[[wikilinks]]`). Open the folder as a vault → Graph View (Ctrl/Cmd+G).
2. **AI graph** — a compact single-file `PROJECT_MAP.md` (adjacency list), generated
   **only for larger projects** where a precomputed index saves more tokens than it
   costs to keep fresh.

## Route decision (by code-file count)

- **< 40 code files → "directed"**: small enough that Grep/Glob exploration is cheap;
  no `PROJECT_MAP.md` is maintained (a stale map would waste more tokens than it saves).
  CLAUDE.md tells future sessions to navigate by directed search.
- **>= 40 code files → "compact"**: a precomputed `PROJECT_MAP.md` is generated and
  CLAUDE.md instructs future sessions to read it first before fanning out.

The Obsidian human vault is generated in **both** cases.

## Procedure

1. Confirm Node.js is available (`node --version`). The script targets JS/TS-family
   projects (`.ts .tsx .js .jsx .mjs .cjs .mts .cts .vue .svelte .astro`). If the
   project is another language, tell the user this skill currently parses JS/TS imports
   and stop.

2. Run the generator against the current project (it does everything and is idempotent):

   ```
   node "<SKILL_DIR>/gen-graph.mjs"
   ```

   where `<SKILL_DIR>` is this skill's directory. The script:
   - finds the source base (`src/` if present, else the project root, excluding
     `node_modules`, build dirs, `.git`, etc.),
   - generates `obsidian-graph/`,
   - decides the route and, if "compact", writes `PROJECT_MAP.md`,
   - inserts/refreshes a managed block in `.gitignore` (ignoring `obsidian-graph/`
     and `PROJECT_MAP.md`),
   - inserts/refreshes a managed block in `CLAUDE.md` with the route-specific guidance,
   - installs/refreshes a `PostToolUse` hook in `<project>/.claude/settings.json`
     (matcher `Edit|Write|MultiEdit`) that re-runs the generator in `--hook` mode,
   - prints a final `RESULT: files=<n> route=<directed|compact> ...` line.

   Optional args: pass a project path as `argv[2]`; override the threshold with
   `--threshold=N`; force a route with `--route=directed|compact`.

3. Read the script's `RESULT:` line and report to the user: file count, chosen route,
   what was created, and how to open the Obsidian vault.

4. Tell the user the graphs now **auto-refresh**: the installed hook re-runs the
   generator whenever a source code file under the source base is edited. The hook runs
   quietly, only regenerates the graphs (it does not touch `.gitignore`/`CLAUDE.md`/the
   hook), is gated to source files (other edits are ignored, no loop on `obsidian-graph/`),
   and never fails an edit. Re-run `/claude-dependency-mapper` manually only to re-apply
   config or change the threshold/route.

## Auto-refresh hook

`installHook()` writes a project-scoped `PostToolUse` hook to
`<project>/.claude/settings.json`:

```json
{ "hooks": { "PostToolUse": [
  { "matcher": "Edit|Write|MultiEdit",
    "hooks": [ { "type": "command", "command": "node \"<skill>/gen-graph.mjs\" --hook" } ] } ] } }
```

In `--hook` mode the script reads the PostToolUse JSON from stdin, extracts
`tool_input.file_path`, and exits 0 immediately unless that file is a code file under the
source base (so non-source edits and writes inside `obsidian-graph/` are no-ops). It then
regenerates the graphs with `--quiet --no-config` semantics, wrapped in try/catch so a
failure can never disrupt editing. Re-installing is idempotent (prior claude-dependency-mapper
hook entries are removed first), and other existing hooks in `settings.json` are preserved.

## Notes / limitations

- Import resolution covers relative paths and the `@/` → source-base alias. Other
  tsconfig `paths` aliases and dynamic string-built imports are not resolved.
- Both graphs are gitignored by design (the user does not want them committed). If the
  user later wants `PROJECT_MAP.md` shared with a team, remove it from the managed
  `.gitignore` block.
