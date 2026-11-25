#!/usr/bin/env python3
import sys
from pathlib import Path

path = Path(__file__).with_name("launch-options.txt")


def token(s):
	b = s.encode()
	h = 0x31415926 ^ len(b)
	for i in range(0, len(b) // 4 * 4, 4):
		k = int.from_bytes(b[i:i + 4], "little") * 0x5BD1E995 & 0xFFFFFFFF
		h = (h * 0x5BD1E995 & 0xFFFFFFFF) ^ ((k >> 24 ^ k) * 0x5BD1E995 & 0xFFFFFFFF)
	if len(b) % 4:
		h = (h ^ int.from_bytes(b[len(b) // 4 * 4:], "little")) * 0x5BD1E995 & 0xFFFFFFFF
	h = (h >> 13 ^ h) * 0x5BD1E995 & 0xFFFFFFFF
	return h >> 15 ^ h


name = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: add-launch-option.py <name> [<hash>]")
h = token(name)
if len(sys.argv) == 2:
	print(f"{h}: {name}")
	sys.exit()
if h != int(sys.argv[2]):
	sys.exit(f"{name} hashes to {h}, not {sys.argv[2]}")
lines = path.read_text(encoding="utf-8").splitlines()
if not any(line.startswith(f"{name}, ") for line in lines):
	lines.append(f"{name}, {h}")
path.write_text("\n".join(sorted(lines, key=str.upper)) + "\n", encoding="utf-8")
