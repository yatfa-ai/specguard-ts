import fs from "node:fs";
import { SourceMap } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A compiled-JavaScript coordinate mapped back to the file it was compiled
 * from: the ABSOLUTE source path and its 1-based line.
 */
export interface MappedPosition {
  file: string;
  line: number;
}

/** Extensions of compiled output the resolver will look for a source map in. */
const COMPILED_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/** A compiled file / map above this size is not read: mapping is best-effort. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * The trailer both `tsc` and bundlers emit: `//# sourceMappingURL=<url>` (the
 * legacy `//@` spelling too), alone on a line.
 */
const MAPPING_URL_LINE = /^\s*\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

/** A URL scheme (`http:`, `webpack:`) — but not a one-letter Windows drive. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

interface LoadedMap {
  map: SourceMap;
  /** The map's own directory, which relative `sources` are resolved against. */
  dir: string;
  sourceRoot: string;
  sources: readonly string[];
}

/**
 * Maps `node:test` events reported against COMPILED output (`dist/cart.test.js`,
 * the `tsc` → `node --test dist/` flow without `--enable-source-maps`) back to
 * the TypeScript source they came from — the coordinates Node itself reports
 * when `--enable-source-maps` is on, which is the spelling `@intent`
 * annotations are keyed under.
 *
 * NEVER-FAIL: every way a mapping can fail — no trailer, an unreadable or
 * corrupt map, no entry for the position, a source outside the repo, under
 * `node_modules`, or not on disk — answers `null`, and the caller keeps the
 * compiled coordinates it already had. Nothing here throws.
 */
export class SourceMapResolver {
  private readonly repoRoot: string;
  private readonly baseDir: string;
  /** One parsed map per compiled file; `null` caches "no usable map". */
  private readonly maps = new Map<string, LoadedMap | null>();

  constructor(repoRoot: string, baseDir: string = repoRoot) {
    this.repoRoot = repoRoot;
    this.baseDir = baseDir;
  }

  /**
   * The source position of a compiled `(line, column)` — both 1-based, as
   * `node:test` reports them. `column` may be absent (then the line's first
   * mapping is used). `null` when nothing maps, or the file is not compiled
   * output (a `.ts` file Node already source-mapped is left alone).
   */
  resolve(file: string, line: number, column?: number): MappedPosition | null {
    try {
      const loaded = this.load(file);
      if (loaded === null) return null;
      const lineOffset = line - 1;
      const columnOffset =
        typeof column === "number" && Number.isInteger(column) && column > 0 ? column - 1 : 0;
      let entry = loaded.map.findEntry(lineOffset, columnOffset);
      if (!isMapped(entry) && columnOffset !== 0) entry = loaded.map.findEntry(lineOffset, 0);
      if (!isMapped(entry)) return null;
      const source = this.sourcePath(loaded, entry.originalSource);
      if (source === null) return null;
      const originalLine = entry.originalLine + 1;
      if (!Number.isInteger(originalLine) || originalLine <= 0) return null;
      return { file: source, line: originalLine };
    } catch {
      return null;
    }
  }

  /**
   * The source file a compiled FILE came from, for file-level events (a
   * crashed file has no meaningful line). A map naming exactly one source
   * answers it; otherwise the file's first mapping does. `null` as above.
   */
  resolveFile(file: string): string | null {
    try {
      const loaded = this.load(file);
      if (loaded === null) return null;
      if (loaded.sources.length === 1) {
        const only = loaded.sources[0];
        return only === undefined ? null : this.sourcePath(loaded, only, true);
      }
      const entry = loaded.map.findEntry(0, 0);
      return isMapped(entry) ? this.sourcePath(loaded, entry.originalSource) : null;
    } catch {
      return null;
    }
  }

  private load(file: string): LoadedMap | null {
    if (!COMPILED_EXTENSIONS.has(extname(file).toLowerCase())) return null;
    const compiled = isAbsolute(file) ? file : resolve(this.baseDir, file);
    const cached = this.maps.get(compiled);
    if (cached !== undefined) return cached;
    const loaded = this.read(compiled);
    this.maps.set(compiled, loaded);
    return loaded;
  }

  private read(compiled: string): LoadedMap | null {
    try {
      const text = readCapped(compiled);
      if (text === null) return null;
      const url = lastMappingUrl(text);
      if (url === null) return null;

      let dir = dirname(compiled);
      let json: string | null;
      if (url.startsWith("data:")) {
        json = decodeDataUrl(url);
      } else {
        if (SCHEME.test(url)) return null; // http:, file: — not a sibling file
        const mapPath = resolve(dirname(compiled), decodeURIComponent(url));
        json = readCapped(mapPath);
        dir = dirname(mapPath);
      }
      if (json === null) return null;

      const payload: unknown = JSON.parse(json);
      if (typeof payload !== "object" || payload === null) return null;
      const raw = payload as { sources?: unknown; sourceRoot?: unknown };
      const sources = Array.isArray(raw.sources)
        ? raw.sources.filter((s): s is string => typeof s === "string")
        : [];
      return {
        map: new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0]),
        dir,
        sourceRoot: typeof raw.sourceRoot === "string" ? raw.sourceRoot : "",
        sources,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a map `sources` entry to an absolute path, then require it to be
   * a real file inside the repo and outside `node_modules`.
   *
   * `findEntry` hands back the raw `sources` string on some Node versions and a
   * pre-resolved one on others, and `sourceRoot` is applied by none of the ones
   * measured. A string that matches a raw `sources` entry therefore gets the
   * map's `sourceRoot` applied here; anything else is taken as already
   * resolved (and only resolved against the map's directory if relative).
   */
  private sourcePath(loaded: LoadedMap, originalSource: string, alwaysRaw = false): string | null {
    const isRaw = alwaysRaw || loaded.sources.includes(originalSource);
    let candidate = originalSource;
    if (isRaw && loaded.sourceRoot !== "" && !isAbsolute(candidate) && !SCHEME.test(candidate)) {
      candidate = `${loaded.sourceRoot}${loaded.sourceRoot.endsWith("/") ? "" : "/"}${candidate}`;
    }
    let absolute: string;
    if (candidate.startsWith("file:")) {
      absolute = fileURLToPath(candidate);
    } else if (SCHEME.test(candidate)) {
      return null; // webpack://, http:// — not a path in this repo
    } else {
      absolute = resolve(loaded.dir, candidate);
    }

    const rel = relative(this.repoRoot, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (rel.split(sep).includes("node_modules")) return null;
    if (!fs.statSync(absolute).isFile()) return null;
    return absolute;
  }
}

/** True when `findEntry` found a mapping (it returns `{}` when it did not). */
function isMapped(entry: unknown): entry is { originalSource: string; originalLine: number } {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as { originalSource?: unknown; originalLine?: unknown };
  return typeof e.originalSource === "string" && typeof e.originalLine === "number";
}

/** The file's text, or `null` when it is unreadable or over the size cap. */
function readCapped(path: string): string | null {
  const stat = fs.statSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  return fs.readFileSync(path, "utf8");
}

/** The URL of the LAST `sourceMappingURL` line, scanning up from the end. */
function lastMappingUrl(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const match = MAPPING_URL_LINE.exec(line);
    return match === null ? null : match[1]!;
  }
  return null;
}

/** The JSON text of a `data:application/json[;…][;base64],…` URL. */
function decodeDataUrl(url: string): string | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice("data:".length, comma);
  const body = url.slice(comma + 1);
  if (!header.startsWith("application/json") && !header.startsWith("text/json")) return null;
  return header.split(";").includes("base64")
    ? Buffer.from(body, "base64").toString("utf8")
    : decodeURIComponent(body);
}
