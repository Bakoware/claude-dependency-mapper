# -*- coding: utf-8 -*-
"""
Reproducible benchmark: a transitive blast-radius query
WITH the precomputed PROJECT_MAP index vs WITHOUT it (recursive Grep).

Task = "list every file transitively affected if module T changes".

WITHOUT the map, an agent must discover the dependents recursively:
  * one Grep per node in the blast radius (the import specifier "mX.js")  -> ROUND-TRIPS
  * tokens (best case)  = bytes of those grep results (surgical, zero noise)
  * tokens (realistic)  = best case + reading each affected file once to trace it
                          (observed real-agent behaviour)
WITH the map, a single Read of PROJECT_MAP.md resolves the whole `by:` graph -> 1 call.

Tokens estimated as chars/4, applied identically to both sides, so the RATIO is what matters.
We report the hub module m0 (worst case) AND the mean over every module as target (typical).
"""
import os, sys, re, glob, json, statistics

def parse_project(root):
    files = sorted(glob.glob(os.path.join(root, "src", "*.js")))
    imports, lines_by_file, file_size = {}, {}, {}
    for f in files:
        rel = os.path.relpath(f, root).replace("\\", "/")
        mid = rel[:-3]
        with open(f, encoding="utf-8") as fh:
            txt = fh.read()
        imports[mid] = set("src/" + m for m in re.findall(r'from "\./(m\d+)\.js"', txt))
        lines_by_file[rel] = list(enumerate(txt.splitlines(), 1))
        file_size[mid] = len(txt)
    dependents = {m: set() for m in imports}
    for m, deps in imports.items():
        for d in deps:
            if d in dependents:
                dependents[d].add(m)
    return imports, dependents, lines_by_file, file_size

def build_grep_cache(imports, lines_by_file):
    """For each module mid: (grep_output_chars, set_of_importer_module_ids)."""
    cache = {}
    for mid in imports:
        token = mid.split("/")[-1] + ".js"
        chars, importers = 0, set()
        for rel, lines in lines_by_file.items():
            for no, text in lines:
                if token in text:
                    chars += len(f"{rel}:{no}:{text}\n")
                    if 'from "./' in text:
                        importers.add(rel[:-3])
        cache[mid] = (chars, importers)
    return cache

def blast(target, cache):
    """BFS; returns (calls, grep_chars, affected_set)."""
    visited, queue, calls, chars, affected = set(), [target], 0, 0, set()
    while queue:
        n = queue.pop(0)
        if n in visited:
            continue
        visited.add(n); calls += 1
        c, importers = cache[n]
        chars += c
        for imp in importers:
            affected.add(imp)
            if imp not in visited:
                queue.append(imp)
    return calls, chars, affected

def map_size(root, imports, dependents):
    pm = os.path.join(root, "PROJECT_MAP.md")
    if os.path.exists(pm):
        return os.path.getsize(pm), True
    L = ["# PROJECT_MAP", f"# {len(imports)} files"]
    for mid in sorted(imports):
        seg = mid
        if imports[mid]: seg += "  imp: " + ", ".join(sorted(imports[mid]))
        if dependents[mid]: seg += "  by: " + ", ".join(sorted(dependents[mid]))
        L.append(seg)
    return len("\n".join(L)) + 1, False

def analyze(root):
    imports, dependents, lbf, fsize = parse_project(root)
    cache = build_grep_cache(imports, lbf)
    msize, real_map = map_size(root, imports, dependents)
    map_tok = round(msize / 4)

    def one(target):
        calls, gchars, affected = blast(target, cache)
        best_tok = round(gchars / 4)
        real_chars = gchars + sum(fsize[a] for a in affected)
        real_tok = round(real_chars / 4)
        return dict(target=target, blast=len(affected), calls=calls,
                    best_tok=best_tok, real_tok=real_tok)

    hub = one("src/m0")
    allr = [one(m) for m in imports]
    def mean(key): return round(statistics.mean(r[key] for r in allr), 1)
    agg = dict(blast=mean("blast"), calls=mean("calls"),
               best_tok=mean("best_tok"), real_tok=mean("real_tok"))
    return dict(nfiles=len(imports), map_tok=map_tok, real_map=real_map,
                hub=hub, mean=agg)

def main(base):
    out = {}
    for name in ("small", "medium", "large"):
        out[name] = analyze(os.path.join(base, f"proj_{name}"))
    return out

if __name__ == "__main__":
    base = sys.argv[1]
    res = main(base)
    def line(name, d, scope):
        mt = res[name]["map_tok"]
        txb = d["best_tok"]/mt if mt else 0
        txr = d["real_tok"]/mt if mt else 0
        cx = d["calls"]/1
        print(f"  {scope:7} blast={d['blast']:>5}  noMap[calls={d['calls']:>5} best={d['best_tok']:>6}tok real={d['real_tok']:>7}tok]  "
              f"map[1call {mt:>5}tok]  =>  tok x(best)={txb:5.1f}  tok x(real)={txr:6.1f}  calls x={cx:5.0f}")
    for name in ("small", "medium", "large"):
        r = res[name]
        tag = "" if r["real_map"] else "   *route=directed: product does NOT generate a map here (figure hypothetical)"
        print(f"\n### proj_{name}: {r['nfiles']} files{tag}")
        line(name, r["hub"], "hub m0")
        line(name, r["mean"], "avg")
    with open(os.path.join(base, "_bench.json"), "w") as fh:
        json.dump(res, fh, indent=2)
    print("\nsaved _bench.json")
