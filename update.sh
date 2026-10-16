#!/usr/bin/env bash
# update: fetch binaries, dump hashes, resolve, report unknowns, optionally commit.
#
# usage: ./update.sh [--no-fetch] [--commit] [--login]
#   --no-fetch   skip the updater, only dump/resolve/report
#   --commit     git add + commit the hashes/ tree with a build-id message
#   --login      pass --login to the updater (first run, or after token expiry)
#
# unknown hashes are printed but never block the commit.

set -euo pipefail
cd "$(dirname "$0")"

FETCH=1
COMMIT=0
LOGIN_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--no-fetch) FETCH=0 ;;
		--commit)   COMMIT=1 ;;
		--login)    LOGIN_ARGS+=(--login) ;;
	esac
	shift
done

if (( FETCH )); then
	echo "--- fetch"
	"C:/Program Files/dotnet/dotnet.exe" updater/bin/Release/net9.0/updater.dll binaries "${LOGIN_ARGS[@]}"
fi

echo "--- dump"
for game in binaries/*/; do
	game=$(basename "$game")
	find-hashes/target/release/cs-hash-reversal.exe "binaries/$game" --base game --out "hashes/$game" 2>/dev/null | grep -E "^\[\+\]" || true
done

echo "--- resolve"
python mc.py -d hashes -f launch-options.txt | tail -1

echo "--- unknown"
	grep -hroE "^[0-9]+" hashes/cs2 hashes/dota2 hashes/deadlock hashes/steamvr 2>/dev/null | sort -u > unmapped.txt
	echo "$(wc -l < unmapped.txt) unmapped (unmapped.txt)"

if (( COMMIT )); then
	echo "--- commit"
	git add hashes/ unmapped.txt
	if git diff --cached --quiet; then
		echo "nothing to commit"
	else
		# GameTracking-style: game name + build id + file count,
		# each game on its own line, steamdb links inline
		msg=""
		for game in cs2 dota2 deadlock steamvr; do
			files=$(git diff --cached --name-only -- "hashes/$game/" | wc -l)
			(( files > 0 )) || continue
			build=$(python -c "import json; b=json.load(open('binaries/updater.config'))['Builds']['$game']['BuildId']; print(b if b else '?')" 2>/dev/null | tr -d '[:space:]')
			sample=$(git diff --cached --name-only -- "hashes/$game/" | sed "s|^hashes/$game/||" | head -3 | paste -sd,)
			if [[ "$build" != "?" && "$build" != "0" ]]; then
				msg+="$game ($build | $files files | $sample...)
https://steamdb.info/patchnotes/$build/
"
			else
				msg+="$game (unknown build | $files files | $sample...)
"
			fi
		done
		git commit -m "$msg"
		git log -1 --stat | head -8
	fi
fi
