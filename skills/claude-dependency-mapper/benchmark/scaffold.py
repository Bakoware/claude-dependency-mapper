# -*- coding: utf-8 -*-
"""Scaffold synthetic JS projects with REALISTIC file sizes and a real import DAG."""
import os, sys, random, shutil

FILLER_LINES = 70  # padding per module so files resemble real components (~2-4 KB)

def make_body(i, imported):
    callexpr = " + ".join(f"f{t}()" for t in imported) or "1"
    lines = []
    lines.append("// Auto-generated synthetic module for dependency-graph benchmarking.")
    lines.append("// This padding makes the file a realistic size, like a real component,")
    lines.append("// so that 'agent reads the file to trace imports' has a realistic cost.")
    lines.append("")
    for t in imported:
        lines.append(f'import {{ f{t} }} from "./m{t}.js";')
    lines.append("")
    lines.append("const CONFIG = {")
    for k in range(FILLER_LINES):
        lines.append(f'  option_{k}: "value-{i}-{k}", // descriptive comment to add realistic line length here')
    lines.append("};")
    lines.append("")
    lines.append(f"export function f{i}() {{")
    lines.append(f"  // combine dependencies; reference CONFIG so it is 'used'")
    lines.append(f"  const base = {callexpr};")
    lines.append(f"  return base + Object.keys(CONFIG).length;")
    lines.append("}")
    return "\n".join(lines) + "\n"

def build(root, n, seed=0):
    random.seed(seed)
    src = os.path.join(root, "src")
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(src, exist_ok=True)
    for i in range(n):
        imported = []
        if i > 0:
            k = min(i, random.randint(1, 3))
            imported = sorted(random.sample(range(i), k))
        with open(os.path.join(src, f"m{i}.js"), "w", encoding="utf-8") as fh:
            fh.write(make_body(i, imported))
    top = list(range(max(0, n - 5), n))
    callexpr = " + ".join(f"f{t}()" for t in top) or "0"
    imp = "\n".join(f'import {{ f{t} }} from "./m{t}.js";' for t in top)
    with open(os.path.join(src, "main.js"), "w", encoding="utf-8") as fh:
        fh.write(imp + "\n\nconsole.log(" + callexpr + ");\n")
    with open(os.path.join(root, "package.json"), "w", encoding="utf-8") as fh:
        fh.write('{ "name": "%s", "version": "1.0.0", "type": "module" }\n' % os.path.basename(root))
    total = len([f for f in os.listdir(src) if f.endswith(".js")])
    sizes = [os.path.getsize(os.path.join(src, f)) for f in os.listdir(src) if f.endswith(".js")]
    print(f"built {root}: {total} src files, avg {sum(sizes)//len(sizes)} bytes/file")

if __name__ == "__main__":
    base = sys.argv[1]
    build(os.path.join(base, "proj_small"), 12, seed=1)
    build(os.path.join(base, "proj_medium"), 50, seed=2)
    build(os.path.join(base, "proj_large"), 150, seed=3)
