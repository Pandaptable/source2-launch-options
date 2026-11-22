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
		e["requires"] = set()
		e["alternatives"] = set()
	SITES_SHOWN = 10
	for mod_name, mod in modules.items():
		by_mod: dict[int, list[dict]] = {}
		for site in mod["sites"]:
			e = by_hash.get(site["hash"])
			if e is None:
				continue
			by_mod.setdefault(site["hash"], []).append(
				{
					"m": mod_name,
					"va": site["va"],
					"fn": site.get("fn"),
					"method": site["method"],
					"gate": site["gate"],
					"value": site.get("value"),
					"inlined": site.get("inlined", False),
				}
			)
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
	GATE_TOKENS = {"-tools", "-dedicated", "-insecure"}
	alias_pair_count: dict[tuple[str, str], int] = {}
	raw_relations = []
	for mod_name, mod in modules.items():
		for rel in mod["relations"]:
			earlier = hash_to_name.get(rel["earlier"])
			later = hash_to_name.get(rel["later"])
			if earlier is None or later is None or earlier == later:
				continue
			if earlier in GATE_TOKENS and later in GATE_TOKENS:
				continue
			target = by_hash.get(rel["later"] if later else rel["earlier"])
			if target is None:
				continue
			raw_relations.append((rel, earlier, later, target))
			if rel["relation"] == "alternative":
				pair = tuple(sorted((earlier, later)))
				alias_pair_count[pair] = alias_pair_count.get(pair, 0) + 1

	def alias_holds_everywhere(a: str, b: str) -> bool:
		count = alias_pair_count.get(tuple(sorted((a, b))), 0)
		sites_a = len(by_hash.get(next((h for h, e in by_hash.items() if e["name"] == a), 0), {}).get("sites", []))
		sites_b = len(by_hash.get(next((h for h, e in by_hash.items() if e["name"] == b), 0), {}).get("sites", []))
		return sites_a > 0 and sites_b > 0 and count >= sites_a and count >= sites_b

	for rel, earlier, later, target in raw_relations:
		if rel["relation"] == "requires":
			target["requires"].add(earlier)
		else:
			if not alias_holds_everywhere(earlier, later):
				continue
			target["alternatives"].add(earlier)
			by_hash[rel["earlier"]]["alternatives"].add(later)

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
			if e["requires"]:
				entry["requires"] = sorted(e["requires"])
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

def main() -> None:
	if not HASHES_DIR.is_dir():
		sys.exit(f"no hashes/ directory at {ROOT}")
	out = SITE / "schemas"
	out.mkdir(exist_ok=True)
	unmapped_all = set()
	for gid in GAME_ORDER:
		data = build_game(gid)
		(out / f"{gid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
		rich = sum(1 for o in data["options"] if o.get("sites"))
		unmapped_all.update(o["hash"] for o in data["options"] if o["name"] is None)
		print(
			f"{gid}: {len(data['options'])} options ({rich} with site detail) "
			f"across {len(data['modules'])} modules -> schemas/{gid}.json"
		)
	(ROOT / "unmapped.txt").write_text(
		"".join(f"{h}\n" for h in sorted(unmapped_all)), encoding="utf-8"
	)
	print(f"unmapped.txt: {len(unmapped_all)} hashes")

if __name__ == "__main__":
	main()
