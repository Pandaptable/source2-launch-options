# source 2 launch option reversal


covers all source 2 games now: `hashes/cs2`, `hashes/dota2`, `hashes/deadlock` (deadlock needs an owned steam login, see updater).

`launch-options.txt` is a compiled version of every launch option i could find, from source 1, and previous depots from deadlock and CS2 (add any new launch options found to this as well).

`murmur-check` folder is just an implementation of the hashing that valve uses to easily check the hash of a launch option

```
>mmc.exe meow a
3158276541: meow
516911585: a
```

`bruteforce` has a character bruteforcer, not realistic to run any more than like 9-10 characters, but we did find some from it.

`word-list.txt` is for use with hashcat brute forcing, no proper script for hashcat usage but we did find a few with it

`unmapped.txt` currently unknown hashes that need to be found.

`hashcat.patch` is a patch for hashcat to implement mmh2 32bit into it (it just replaces mmh1, so `hashcat -m 25700 -a 0` is the usage)

in `find-hashes` you can find the rust dumper that checks a dll (or exe) for hashed command line arguments. it understands every way modules reach the command line: the tier0 `CommandLine` import, tier0's own export (so tier0.dll itself now dumps), and direct references to the statically allocated CCommandLine object. it tracks the object through registers, only records calls through known token vtable slots with the token in EDX (no more blocklist, no more `7`), propagates through cached-getter wrappers, and auto-names options that are hashed at runtime through the murmur helper (like `-rtest1`). run it with `-debug` to get `slot 0x20 flag @ 0x...` annotations per hash.

`mc.py` is for use with `launch-options.txt` and the output of `find-hashes`

I have a file up to 11 characters (10 character launch option) of hash collisions, if you want access to search through feel free to reach out.


`updater` is a C# steam CDN fetcher (steamkit2) that downloads only the module binaries from each game's depots, cached so re-runs only fetch what valve changed. anonymous works for cs2 + dota; deadlock needs your account:

```
cd updater
dotnet run -c Release -- ../binaries            # anonymous (cs2 + dota)
dotnet run -c Release -- ../binaries --login    # once: username/password/steam guard, token cached in binaries/updater.config
dotnet run -c Release -- ../binaries            # after: silent token login, deadlock included
```

then `python dump_and_check.py` re-dumps everything under `hashes/`, resolves names via `mc.py`, and prints the remaining unknown hashes.


other commands
```
# check count of unmapped launch options (all games)
grep -hroE "^[0-9]+" ./hashes/cs2 ./hashes/dota2 ./hashes/deadlock | sort -u | wc -l

# output unmapped launch options to file
grep -hroE "^[0-9]+" ./hashes/cs2 ./hashes/dota2 ./hashes/deadlock | sort -u > unmapped.txt
```