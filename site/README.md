# Source 2 Launch Options

A static explorer for the launch options of CS2, Dota 2 and Deadlock: every option recovered from
the game binaries, its MurmurHash2 token hash, and the modules that reference it. Ported from
[ValveResourceFormat/SchemaExplorer](https://github.com/ValveResourceFormat/SchemaExplorer) (MIT),
with the schema views replaced by this repo's launch option dumps.

The data comes from `../hashes/` in the parent repository. `scripts/build-data.py` turns the per
module dumps into `schemas/<game>.json`; only cs2, dota2 and deadlock are included, because games
on older Source 2 builds do not hash their launch options.

## Development

```bash
python scripts/build-data.py   # regenerate schemas/ from ../hashes (run after every dump)
npm install
npm run dev                    # serves at /source2-launch-options/
```

## Build

```bash
npm run build
```

Prerenders every page into `build/client/` and flattens it for GitHub Pages. `npm run preview`
serves the built site.

## License

The code is licensed under the [MIT License](LICENSE), copyright ValveResourceFormat Contributors,
as ported from SchemaExplorer. The license does not cover the third-party material below.

## Third-party notices

- Most icons are from [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft,
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with modifications.
- The Inter typeface is [inter-ui](https://github.com/rsms/inter), licensed under the SIL Open
  Font License.
- Counter-Strike 2, Dota 2, Deadlock and their logos are trademarks of Valve Corporation. This
  project is not affiliated with or endorsed by Valve.
