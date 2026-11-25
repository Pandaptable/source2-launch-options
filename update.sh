#!/usr/bin/env bash
# update: dump launch-option hashes from a freshly tracked depot, rebuild site data, optionally commit.
#
# usage: APPID=<steam app id> ./update.sh [--commit]    dump the depot tree, then rebuild site data
#        ./update.sh --names-only [--commit]            only name the existing dumps from launch-options.txt
#
# Binaries are fetched separately: SteamFileDownloader track <appid> --output depots
# (reads files.json from the repo root and writes the depot's own tree under depots/).

set -euo pipefail
cd "$(dirname "$0")"

NAMES_ONLY=0
COMMIT=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--commit) COMMIT=1 ;;
		--names-only) NAMES_ONLY=1 ;;
	esac
	shift
done

OUT="depots"

declare -A APP_TO_GAME=([730]="cs2" [570]="dota2" [1422450]="deadlock")

game=""
buildid="?"
if (( NAMES_ONLY )); then
	game="names"
else
	# `track` writes one app at a time into depots/, so the app id says which game it is
	if [[ -n "${APPID:-}" ]]; then
		game="${APP_TO_GAME[$APPID]:-}"
	fi
	if [[ -z "$game" ]]; then
		echo "usage: APPID=<steam app id> ./update.sh [--commit]   (730=cs2, 570=dota2, 1422450=deadlock)" >&2
		exit 2
	fi
	if [[ ! -d "$OUT/game" ]]; then
		echo "no depot tree under $OUT: run SteamFileDownloader track $APPID --output $OUT first" >&2
		exit 1
	fi
	buildid=$(grep -o '[0-9]*' "$OUT/steam_buildid.txt" 2>/dev/null || echo "?")

	exe=""
	case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) exe=".exe" ;; esac
	DUMPER="${DUMPER:-find-hashes/target/release/cs-hash-reversal$exe}"
	if [[ ! -f "$DUMPER" && -f "find-hashes/bin/cs-hash-reversal-linux" ]]; then
		DUMPER="find-hashes/bin/cs-hash-reversal-linux"
	fi
	if [[ ! -f "$DUMPER" ]]; then
		echo "--- building dumper (no prebuilt found)"
		cargo build --release --manifest-path find-hashes/Cargo.toml --quiet
	fi

	echo "--- dump ($game, build $buildid)"
	n=$("$DUMPER" "$OUT/game" --base game --out "hashes/$game" --names launch-options.txt | grep -cE "^\[\+\] Found and exported" || true)
	if (( n == 0 )); then
		echo "the dumper exported nothing from $OUT/game" >&2
		exit 1
	fi
	echo "dumped $n modules"
fi

echo "--- site data"
python site/scripts/build-data.py | tail -5

if (( COMMIT )); then
	echo "--- commit"
	git add hashes/ unmapped.txt launch-options.txt
	git diff --cached --quiet && echo "nothing to commit" && exit 0

	# <game> | <n> files | <status list, cut to 1024 chars>, then a SteamDB patch notes link
	changed=$(git diff --cached --name-status)
	n=$(echo "$changed" | wc -l)
	msg="$game | $n files | $(echo "$changed" | awk '{printf "%s%s %s", sep, $1, $2; sep=", "}' | cut -c 1-1024)"
	if [[ "$buildid" != "?" ]]; then
		msg+=$'\n\nhttps://steamdb.info/patchnotes/'"$buildid/"
	fi

	git commit --message "$msg" || true
	git push
	git log -1 --format="%h %s" | cut -c1-120
fi
