# source 2 launch option reversal


covers all source 2 games now: `hashes/cs2`, `hashes/dota2`, `hashes/deadlock` (deadlock needs an owned steam login).

contact me on discord (@pandaptable) or check my website for additional contact methods https://pandaptable.moe if you have a launch option to an unmapped hash.

## site

there's a static explorer for the dumps at https://hashes.pandaptable.moe/, a port of [ValveResourceFormat/SchemaExplorer](https://github.com/ValveResourceFormat/SchemaExplorer) (MIT) with the schema views replaced by launch options: per-game option lists with murmur hashes and module filters, plus a paste-your-launch-options checker. only cs2, dota2 and deadlock are included (other games ship older source 2 builds without hashed launch options).

the site lives in `site/` (react + vite, prerendered to static files). regenerate its data after dumping with `python site/scripts/build-data.py`, then `npm run build` inside `site/`. the pages workflow rebuilds and deploys on push, so committing fresh `hashes/` data is enough. to work on it locally:

```
python site/scripts/build-data.py
cd site && npm install && npm run dev
```

`launch-options.txt` is a compiled version of every launch option i could find, from source 1, and previous depots from deadlock and CS2 (add any new launch options found to this as well).

`murmur-check` folder is just an implementation of the hashing that valve uses to easily check the hash of a launch option

```
>mmc.exe meow a
3158276541: meow
516911585: a
```

`bruteforce` has a character bruteforcer, not realistic to run any more than like 9-10 characters, but we did find some from it.

`word-list.txt` is for use with hashcat brute forcing, no proper script for hashcat usage but we did find a few with it

`unmapped.txt` currently unknown hashes that need to be found. one `<hash> <game> <binary>` line per hash per binary that references it (`cut -d' ' -f1 unmapped.txt` gives the bare hashes for hashcat).

to name one of them: `python add-launch-option.py -novt` prints the name's hash. add it with the hash from `unmapped.txt` as the second argument: the line goes into `launch-options.txt` in order, unless the name hashes to something else.

```
python add-launch-option.py -novt 840103314
```

then `./update.sh --names-only` applies it to the existing dumps and rebuilds the site data. no dump needed for that: the `.txt` dumps are the only files that carry names, every sidecar is hashes only.

`hashcat.patch` is a patch for hashcat to implement mmh2 32bit into it (it just replaces mmh1, so `hashcat -m 25700 -a 0` is the usage)

in `find-hashes` you can find the rust dumper that checks a dll (or exe) for hashed command line arguments. it understands every way modules reach the command line: the tier0 `CommandLine` import, tier0's own export (so tier0.dll itself now dumps), and direct references to the statically allocated CCommandLine object. it tracks the object through registers, only records calls through known token vtable slots with the token in EDX (no more blocklist, no more `7`), propagates through cached-getter wrappers, and auto-names options that are hashed at runtime through the murmur helper (like `-rtest1`). run it with `-debug` to get `slot 0x20 flag @ 0x...` annotations per hash.

the dumper resolves names itself: pass `--names launch-options.txt` and it writes `name, hash` lines directly.

I have a file up to 11 characters (10 character launch option) of hash collisions, if you want access to search through feel free to reach out.


binaries are fetched by [SteamFileDownloader](https://github.com/SteamTracking/SteamFileDownloader) (SFD) with `track`, driven by `files.json` at the repo root. `track --output depots` writes the depot's own tree under `depots/`, one app at a time. anonymous works for cs2 + dota; deadlock needs an owned account (pass `--username`/`--password` to SFD).

`./update.sh` runs the pipeline after a fetch: dump (names resolved via `launch-options.txt`) → regenerate site data + `unmapped.txt`. `APPID=<steam app id>` says which game is in `depots/` (730=cs2, 570=dota2, 1422450=deadlock), `--commit` commits and pushes after. locally: `SteamFileDownloader track <appid> --output depots`, then `APPID=<appid> ./update.sh`. CI does the same in `.github/workflows/update.yml`.
other commands
```
# check count of unmapped launch options (all games)
grep -hroE "^[0-9]+" ./hashes/cs2 ./hashes/dota2 ./hashes/deadlock | sort -u | wc -l

# output unmapped launch options to file: hash, game, binary (what build-data.py writes)
grep -roE '^[0-9]+' ./hashes/cs2 ./hashes/dota2 ./hashes/deadlock | sed -E 's#^\./hashes/([^/]+)/(.+)\.txt:([0-9]+)$#\3 \1 \2#' | sort -u > unmapped.txt
```

on windows run these in git bash: its `sort` is the same GNU sort as on linux. the `sort.exe` in system32 is not equivalent, it orders lines differently.