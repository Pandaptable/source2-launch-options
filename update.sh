#!/usr/bin/env bash
# update: dump launch-option hashes from freshly tracked depots, rebuild site data, optionally commit.
#
# usage: APPID=<steam app id> ./update.sh [--commit]
#
# Binaries are fetched separately: SteamFileDownloader track <appid> --output depots
# (reads files.json from the repo root; CI does this before calling this script).

set -euo pipefail
cd "$(dirname "$0")"

COMMIT=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--commit) COMMIT=1 ;;
	esac
	shift
done

OUT="depots"

declare -A DEPOT_TO_GAME=([2347771]="cs2" [373303]="dota2" [1422452]="deadlock" [250831]="steamvr" [546563]="hla")
declare -A APP_TO_GAME=([730]="cs2" [570]="dota2" [1422450]="deadlock" [250820]="steamvr" [546560]="hla")

# With APPID set, only that game's depot is dumped; otherwise every cached depot.
declare -A GAME_TO_DEPOT
for depot in "${!DEPOT_TO_GAME[@]}"; do GAME_TO_DEPOT["${DEPOT_TO_GAME[$depot]}"]=$depot; done
if [[ -n "${APPID:-}" ]]; then
	game="${APP_TO_GAME[$APPID]:-}"
	if [[ -z "$game" ]]; then
		echo "unknown appid $APPID" >&2
		exit 1
	fi
	depots=("${GAME_TO_DEPOT[$game]}")
else
	depots=("${!DEPOT_TO_GAME[@]}")
fi

DUMPER="${DUMPER:-find-hashes/target/release/cs-hash-reversal.exe}"
if [[ ! -f "$DUMPER" && -f "find-hashes/bin/cs-hash-reversal-linux" ]]; then
	DUMPER="find-hashes/bin/cs-hash-reversal-linux"
fi
if [[ ! -f "$DUMPER" ]]; then
	echo "--- building dumper (no prebuilt found)"
	cargo build --release --manifest-path find-hashes/Cargo.toml --quiet
	DUMPER="find-hashes/target/release/cs-hash-reversal.exe"
fi

total=0
echo "--- dump"
for depot in "${depots[@]}"; do
	game="${DEPOT_TO_GAME[$depot]}"
	[[ -d "$OUT/$depot" ]] || continue
	# Only the newest cached manifest: older ones would overwrite the fresh dump.
	latest=$(ls -t "$OUT/$depot" | head -1)
	[[ -n "$latest" ]] || continue
	depot_dir="$OUT/$depot/$latest"
	n=$("$DUMPER" "$depot_dir" --base game --out "hashes/$game" --names launch-options.txt 2>/dev/null | grep -cE "^\[\+\]" || true)
	total=$((total + n))
done
echo "dumped $total modules"

echo "--- site data"
python site/scripts/build-data.py 2>/dev/null | tail -1 || echo "site scripts not found, skipping"

if (( COMMIT )); then
	echo "--- commit"
	git add hashes/ unmapped.txt site/schemas/ 2>/dev/null || git add hashes/ unmapped.txt
	git diff --cached --quiet && echo "nothing to commit" && exit 0

	# <game> | <n> files | <status list, cut to 1024 chars> + SteamDB patchnotes link
	game="${APP_TO_GAME[${APPID:-}]:-unknown}"
	changed=$(git diff --cached --name-status)
	n=$(echo "$changed" | wc -l)
	msg="$game | $n files | $(echo "$changed" | awk '{printf "%s%s %s", sep, $1, $2; sep=", "}' | cut -c 1-1024)"

	if [[ -f "$OUT/steam_buildid.txt" ]]; then
		buildid=$(grep -o '[0-9]*' "$OUT/steam_buildid.txt" || true)
		if [[ -n "$buildid" ]]; then
			msg+=$'\n\nhttps://steamdb.info/patchnotes/'"$buildid/"
		fi
	fi

	git commit --message "$msg" || true
	git push
	git log -1 --stat | head -8
fi
