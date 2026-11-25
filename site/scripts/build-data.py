#!/usr/bin/env python3
"""Generate site/schemas/<game>.json from the repo's hashes/ dumps.
Each dump module has a flat `<name>, <hash>` list (written by the dumper's
`--names launch-options.txt`) plus a `<module>.json` sidecar (written by
find-hashes) with per-site detail: slot
family (locked/open gate), value use, addresses, enclosing function,
option relations, and the module's import / dynamic-load edges.

Usage: python site/scripts/build-data.py   (run from anywhere)
"""

import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
ROOT = SITE.parent
HASHES_DIR = ROOT / "hashes"

GAME_DIRS = {
	"cs2": ["cs2"],
	"dota2": ["dota2"],
	"deadlock": ["deadlock"],
}
GAME_ORDER = ["cs2", "dota2", "deadlock"]
REPO_DIRS = {"cs2": "cs2", "dota2": "dota2", "deadlock": "deadlock"}

NAMED_RE = re.compile(r"^(?P<name>[^,]+),\s*(?P<hash>\d+)\s*$")
BARE_RE = re.compile(r"^\d+$")

def parse_dump(path: Path) -> tuple[dict[str, int], list[int]]:
	options: dict[str, int] = {}
	unmapped: list[int] = []
	for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
		line = line.strip()
		if not line:
			continue
		m = NAMED_RE.match(line)
		if m:
			options[m.group("name")] = int(m.group("hash"))
		elif BARE_RE.match(line):
			unmapped.append(int(line))
	return options, unmapped

def load_names() -> dict[int, str]:
	names: dict[int, str] = {}
	for line in (ROOT / "launch-options.txt").read_text(encoding="utf-8", errors="replace").splitlines():
		m = NAMED_RE.match(line.strip())
		if m:
			names[int(m.group("hash"))] = m.group("name")
	return names

def apply_names(names: dict[int, str]) -> int:
	"""Name the bare hash lines in the dumps that launch-options.txt has named since they were written."""
	renamed = 0
	for path in sorted(HASHES_DIR.rglob("*.txt")):
		lines = path.read_text(encoding="utf-8", errors="replace").split("\n")
		named = [f"{names[int(line)]}, {line}" if BARE_RE.match(line) and int(line) in names else line for line in lines]
		if named != lines:
			path.write_text("\n".join(named), encoding="utf-8")
			renamed += sum(a != b for a, b in zip(named, lines))
	return renamed

def load_sidecar(path: Path) -> dict:
	sidecar = path.with_suffix(".json")
	if not sidecar.is_file():
		return {"sites": [], "relations": [], "imports": [], "dynamic": []}
	try:
		data = json.loads(sidecar.read_text(encoding="utf-8"))
		return {
			"sites": data.get("sites", []),
			"relations": data.get("relations", []),
			"imports": data.get("imports", []),
			"dynamic": data.get("dynamic", []),
		}
	except (OSError, ValueError):
		return {"sites": [], "relations": [], "imports": [], "dynamic": []}

def build_game(gid: str) -> dict:
	modules: dict[str, dict] = {}
	for d in GAME_DIRS[gid]:
		base = HASHES_DIR / d
		if not base.is_dir():
			continue
		for f in sorted(base.rglob("*.txt")):
			key = f.relative_to(base).as_posix()[: -len(".txt")]
			name = key.rsplit("/", 1)[-1]
			if name in modules:
				continue  # the preferred directory already supplied this module
			options, unmapped = parse_dump(f)
			sidecar = load_sidecar(f)
			modules[name] = {
				"path": f"hashes/{REPO_DIRS[gid]}/{key}.txt",
				"options": options,
				"unmapped": unmapped,
				"sites": sidecar["sites"],
				"relations": sidecar["relations"],
				"imports": sidecar["imports"],
				"dynamic": sidecar["dynamic"],
			}

	hash_to_name: dict[int, str] = {}
	for mod in modules.values():
		for name, h in mod["options"].items():
			hash_to_name.setdefault(h, name)

	by_hash: dict[int, dict] = {}
	for mod_name, mod in sorted(modules.items()):
		for name, h in mod["options"].items():
			e = by_hash.setdefault(h, {"name": name, "hash": h, "modules": set()})
			e["modules"].add(mod_name)
		for h in mod["unmapped"]:
			e = by_hash.setdefault(h, {"name": None, "hash": h, "modules": set()})
			e["modules"].add(mod_name)

	for h, e in by_hash.items():
		e["sites"] = []
		e["needs"] = set()
		e["or"] = set()
		e["alternatives"] = set()
	SITES_SHOWN = 10
	GATE_TOKENS = {"-tools", "-dedicated", "-insecure"}
	site_total: dict[int, int] = {}
	alias_pair_count: dict[tuple[str, str], int] = {}
	alias_pairs = []

	def va_of(site: dict) -> int:
		return int(site["va"], 16)

	def hash_of(name: str) -> int | None:
		return next((h for h, e in by_hash.items() if e["name"] == name), None)

	for mod_name, mod in modules.items():
		by_mod: dict[int, list[dict]] = {}
		shown: dict[int, dict] = {}
		for site in mod["sites"]:
			site_total[site["hash"]] = site_total.get(site["hash"], 0) + 1
			if site["hash"] not in by_hash:
				continue
			shown[id(site)] = {
				"m": mod_name,
				"va": site["va"],
				"fn": site.get("fn"),
				"method": site["method"],
				"gate": site["gate"],
				"value": site.get("value"),
				"inlined": site.get("inlined", False),
			}
			by_mod.setdefault(site["hash"], []).append(shown[id(site)])
		for h, lst in by_mod.items():
			e = by_hash[h]
			if len(lst) > SITES_SHOWN:
				lst = sorted(lst, key=lambda s: (s["fn"] or "", s["va"]))
				fns = {s["fn"] for s in lst}
				inlined = sum(1 for x in lst if x.get("inlined"))
				lst[SITES_SHOWN - 1]["more"] = {
					"count": len(lst),
					"fns": len(fns),
					"inlined": inlined == len(lst),
				}
				lst = lst[:SITES_SHOWN]
			e["sites"].extend(lst)

		# A pair of checks is a fact about those two checks, so it is kept on them. The pair is
		# the last check of the earlier option before its branch, and the next check after it
		ordered = sorted(mod["sites"], key=va_of)
		for rel in mod["relations"]:
			earlier = hash_to_name.get(rel["earlier"])
			later = hash_to_name.get(rel["later"])
			if earlier is None or later is None or earlier == later:
				continue
			if earlier in GATE_TOKENS and later in GATE_TOKENS:
				continue
			if rel["relation"] == "alternative":
				pair = tuple(sorted((earlier, later)))
				alias_pair_count[pair] = alias_pair_count.get(pair, 0) + 1
				alias_pairs.append((earlier, later))
			elif rel["relation"] != "requires":
				continue
			first = next(
				(s for s in ordered if s["hash"] == rel["earlier"] and 0 <= rel["branch_va"] - va_of(s) < 0x40),
				None,
			)
			second = next((s for s in ordered if va_of(s) == rel.get("later_va")), None)
			if first is None or second is None:
				continue
			# Only the later check depends on the earlier one. Standing in for each other is mutual
			key, mutual = ("needs", False) if rel["relation"] == "requires" else ("or", True)
			for site, other in ([(first, later)] if mutual else []) + [(second, earlier)]:
				shown[id(site)].setdefault(key, []).append(other)
				by_hash[site["hash"]][key].add(other)

	def sites_of(name: str) -> int:
		"""Every recorded check of the option, across modules"""
		h = hash_of(name)
		return site_total.get(h, 0) if h is not None else 0

	# Two options only stand in for each other when their pair holds at every check of both
	for earlier, later in alias_pairs:
		count = alias_pair_count[tuple(sorted((earlier, later)))]
		if count < sites_of(earlier) or count < sites_of(later):
			continue
		by_hash[hash_of(earlier)]["alternatives"].add(later)
		by_hash[hash_of(later)]["alternatives"].add(earlier)

	options = []
	VALUE_METHODS = {"string", "cstr", "float", "int", "buffer", "parm"}
	for h, e in sorted(by_hash.items(), key=lambda kv: (kv[1]["name"] is None, kv[1]["name"] or str(kv[0]))):
		sites = sorted(e["sites"], key=lambda s: (s["method"], s["m"], s["va"]))
		any_value = any(s.get("value") is True for s in sites)
		all_locked = bool(sites) and all(s["gate"] == "locked" for s in sites)
		entry = {
			"name": e["name"],
			"hash": h,
			"modules": sorted(e["modules"]),
		}
		if e["name"] is not None:
			if any_value:
				entry["value"] = True
				types = sorted({s["method"] for s in sites if s.get("value") is True and s["method"] in VALUE_METHODS})
				if types:
					entry["valueTypes"] = types
			if all_locked:
				entry["locked"] = True
			if e["needs"]:
				entry["needs"] = sorted(e["needs"])
			if e["or"]:
				entry["or"] = sorted(e["or"])
			if e["alternatives"]:
				entry["alternatives"] = sorted(e["alternatives"])
		if sites:
			entry["sites"] = sites
		options.append(entry)

	module_list = [
		{
			"name": n,
			"path": m["path"],
			"imports": m["imports"],
			"dynamic": m["dynamic"],
		}
		for n, m in sorted(modules.items())
	]

	return {
		"generated": time.strftime("%Y-%m-%d", time.gmtime()),
		"modules": module_list,
		"options": options,
	}

def dump_binary(path: str) -> str:
	"""`hashes/<game>/<binary>.txt` dump path -> `<binary>`, its path inside the game tree."""
	return path.split("/", 2)[2].removesuffix(".txt")

def main() -> None:
	if not HASHES_DIR.is_dir():
		sys.exit(f"no hashes/ directory at {ROOT}")
	out = SITE / "schemas"
	out.mkdir(exist_ok=True)
	renamed = apply_names(load_names())
	unmapped: set[tuple[int, str, str]] = set()
	for gid in GAME_ORDER:
		data = build_game(gid)
		(out / f"{gid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
		rich = sum(1 for o in data["options"] if o.get("sites"))
		binaries = {m["name"]: dump_binary(m["path"]) for m in data["modules"]}
		unmapped.update(
			(o["hash"], gid, binaries[m])
			for o in data["options"]
			if o["name"] is None
			for m in o["modules"]
		)
		print(
			f"{gid}: {len(data['options'])} options ({rich} with site detail) "
			f"across {len(data['modules'])} modules -> schemas/{gid}.json"
		)
	(ROOT / "unmapped.txt").write_text(
		"".join(line + "\n" for line in sorted(f"{h} {gid} {binary}" for h, gid, binary in unmapped)),
		encoding="utf-8",
	)
	print(
		f"unmapped.txt: {len({h for h, _, _ in unmapped})} hashes "
		f"in {len({(g, b) for _, g, b in unmapped})} binaries"
	)
	print(f"named {renamed} dump line(s) from launch-options.txt")

if __name__ == "__main__":
	main()
