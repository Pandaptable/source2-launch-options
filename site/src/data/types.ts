
/** kind "convar" is a "-" flag and "command" a "+" command, named after the console items this app was ported from */
export interface ConsoleItem {
  kind: "convar" | "command" | "unmapped";
  /** The token as passed on the command line, dash or plus included. Null when only the hash is known */
  name: string | null;
  /** MurmurHash2 (32-bit, seed 0x31415926) of the token */
  hash: number;
  modules: string[];
  /** The call reads a value after the token (ParmValue, or CheckParm with an out pointer) */
  value?: boolean;
  /** Value kinds the checks read: int, float, cstr, string, buffer */
  valueTypes?: string[];
  /** Every check site is lock-gated: it only answers when the process launched with -tools, -dedicated or -insecure */
  locked?: boolean;
  /** Options whose presence this option's check depends on (&& of two checks) */
  requires?: string[];
  /** Options that stand in for this one in an || of two checks */
  alternatives?: string[];
  /** Other games whose binaries also check this token */
  elsewhere?: string[];
  /** Where the binary checks the token */
  sites?: SiteInfo[];
}

/** One call site that consumed the token. */
export interface SiteInfo {
  /** Module file name, like engine2.dll */
  m: string;
  /** VA of the call, like 0x18020CBD5 */
  va: string;
  /** Start of the enclosing function, when .pdata covered it */
  fn?: string | null;
  /** Token method: flag (HasParm), index (FindParm), parm, string, float, int, cstr */
  method: string;
  /** "locked": only answers with -tools/-dedicated/-insecure. "open": always answers */
  gate: string;
  /** Whether this call reads a value after the token, when known */
  value?: boolean | null;
  /** One copy of an inlined helper stamped across functions */
  inlined?: boolean;
  /** Present on the last shown site when the module's list was capped: full count, function count, whether all are inlined copies */
  more?: { count: number; fns: number; inlined?: boolean };
}

export interface ModuleInfo {
  /** Dump file name, like engine2.dll */
  name: string;
  /** Path of the dump in the repository, like hashes/cs2/game/bin/win64/engine2.dll.txt */
  path: string;
  /** DLL names from the module's PE import table */
  imports?: string[];
  /** DLL names passed to LoadLibrary calls as string literals */
  dynamic?: string[];
}

export interface OptionsJson {
  generated: string;
  modules: {
    name: string;
    path: string;
    imports?: string[];
    dynamic?: string[];
  }[];
  options: {
    name: string | null;
    hash: number;
    modules: string[];
    value?: boolean;
    valueTypes?: string[];
    locked?: boolean;
    requires?: string[];
    alternatives?: string[];
    sites?: {
      m: string;
      va: string;
      fn?: string | null;
      method: string;
      gate: string;
      value?: boolean | null;
      inlined?: boolean;
      more?: { count: number; fns: number; inlined?: boolean };
    }[];
  }[];
}
