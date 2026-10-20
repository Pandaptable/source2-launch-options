#!/usr/bin/env bash
# update: fetch binaries via SteamFileDownloader, dump, resolve, optionally commit.
#
# usage: ./update.sh [--no-fetch] [--commit]
#
# Prerequisite: SteamFileDownloader on PATH, logged in once ("SteamFileDownloader login").

set -euo pipefail
cd "$(dirname "$0")"

FETCH=1
COMMIT=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--no-fetch) FETCH=0 ;;
		--commit)   COMMIT=1 ;;
	esac
	shift
done

SFD="${SFD:-SteamFileDownloader}"
OUT="depots"

declare -A DEPOT_TO_GAME=([2347771]="cs2" [373303]="dota2" [1422452]="deadlock")
declare -A APPS=([cs2]=730 [dota2]=570 [deadlock]=1422450)

# [250831]="steamvr" [546563]="hla"
# [steamvr]=250820 [hla]=546560
# 250820/250831 546560/546563

if (( FETCH )); then
	"$SFD" get 730/2347771 570/373303 1422450/1422452  --output "$OUT" \
		-- 'regex:game/bin/win64/[^/]+\.(dll|exe|so)$' 'regex:game/bin/win64/(tools|subtools)/[^/]+\.(dll|exe)$' \
		2>&1 | grep -E "^Files:|::error::" || true
fi

echo "--- dump"
total=0
for depot_dir in "$OUT"/*/; do
	depot=$(basename "$depot_dir")
	game="${DEPOT_TO_GAME[$depot]:-}"
	[[ -n "$game" ]] || continue
	n=$(find-hashes/target/release/cs-hash-reversal.exe "$depot_dir" --base game --out "hashes/$game" 2>/dev/null | grep -cE "^\[\+\]" || true)
	total=$((total + n))
done
echo "dumped $total modules"

echo "--- resolve"
python mc.py -d hashes -f launch-options.txt | tail -1

echo "--- unknown"
grep -hroE "^[0-9]+" hashes/cs2 hashes/dota2 hashes/deadlock hashes/steamvr 2>/dev/null | sort -u > unmapped.txt
echo "$(wc -l < unmapped.txt) unmapped (unmapped.txt)"

if (( COMMIT )); then
	echo "--- commit"
	git add hashes/ unmapped.txt
	git diff --cached --quiet && echo "nothing to commit" && exit 0

	msg=""
	for game in cs2 dota2 deadlock steamvr; do
		files=$(git diff --cached --name-only -- "hashes/$game/" 2>/dev/null | wc -l)
		(( files > 0 )) || continue
		build=$("$SFD" depots "${APPS[$game]}" 2>&1 | grep -o 'build [0-9]*' | head -1 | grep -o '[0-9]*' || echo "?")
		sample=$(git diff --cached --name-only -- "hashes/$game/" 2>/dev/null | sed "s|^hashes/$game/||" | head -3 | paste -sd,)
		if [[ "$build" != "?" && "$build" != "0" ]]; then
			msg+="$game ($build | $files files | $sample...)
https://steamdb.info/patchnotes/$build/
"
		else
			msg+="$game (unknown build | $files files | $sample...)
"
		fi
	done
	if [[ -n "${COMMIT_NAME:-}" && -n "${COMMIT_EMAIL:-}" ]]; then
		git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" commit -m "$msg"
	else
		git commit -m "$msg"
	fi
	[[ -n "${PUSH_REMOTE:-}" ]] && git push "$PUSH_REMOTE" HEAD:main
	git log -1 --stat | head -8
fi
