/**
 * Directory Management
 *
 * Manages the .codegraph/ directory structure for CodeGraph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWslWindowsDrive } from './sync/watch-policy';

/** The default per-project data directory name. */
export const DEFAULT_CODEGRAPH_DIR = '.codegraph';

/**
 * The data directory name WSL gives a fresh project on a Windows drive, so it
 * never shares one index with CodeGraph on Windows (issue #995). Indexing and
 * watching skip every `.codegraph-*` sibling on both sides (#636).
 */
export const WSL_CODEGRAPH_DIR = '.codegraph-wsl';

let warnedBadDirName = false;

/**
 * Resolve the per-project data directory name, honoring the `CODEGRAPH_DIR`
 * environment override (default `.codegraph`). The override is a single path
 * segment that lives in the project root.
 *
 * Why this exists: two environments that share one working tree must NOT share
 * one `.codegraph/` — most concretely Windows-native and WSL (issue #636). The
 * daemon lockfile (`.codegraph/daemon.pid`) records a platform-specific pid and
 * socket path (a Windows named pipe vs a WSL Unix socket), and SQLite file
 * locking across the WSL2 ↔ Windows filesystem boundary is unreliable, so two
 * daemons sharing one index risks corruption. Setting `CODEGRAPH_DIR=.codegraph-win`
 * on one side gives each environment its own index in the same tree.
 *
 * Read live (not captured at load) so it is both process-accurate and testable.
 * An override that isn't a plain directory name — empty, containing a path
 * separator, `.`, `..`/traversal, or absolute — is ignored (we keep the
 * default) rather than risk writing the index outside the project or into the
 * project root itself; we warn once to stderr so the misconfiguration is seen.
 */
export function codeGraphDirName(): string {
  const raw = process.env.CODEGRAPH_DIR?.trim();
  if (!raw) return DEFAULT_CODEGRAPH_DIR;
  const invalid =
    raw === '.' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    path.isAbsolute(raw);
  if (invalid) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // stderr only — stdout is the MCP protocol channel.
      console.warn(
        `[codegraph] Ignoring invalid CODEGRAPH_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_CODEGRAPH_DIR}".`
      );
    }
    return DEFAULT_CODEGRAPH_DIR;
  }
  return raw;
}

/**
 * CodeGraph directory name — a load-time snapshot of {@link codeGraphDirName}.
 * A running process's environment is fixed, so this equals the live value;
 * it's kept as a stable string export for backward compatibility. Internal code
 * resolves the name through {@link codeGraphDirName} / {@link getCodeGraphDir}
 * so the `CODEGRAPH_DIR` override always applies.
 */
export const CODEGRAPH_DIR = codeGraphDirName();

/**
 * Is `name` (a single path segment) a CodeGraph data directory? Matches the
 * default `.codegraph`, the active `CODEGRAPH_DIR` override, and any
 * `.codegraph-*` sibling. File-watching and the indexer skip ALL of these, so
 * when two environments share one working tree (Windows + WSL, issue #636)
 * neither indexes or watches the other's index directory.
 */
export function isCodeGraphDataDir(name: string): boolean {
  return (
    name === DEFAULT_CODEGRAPH_DIR ||
    name === codeGraphDirName() ||
    name.startsWith(DEFAULT_CODEGRAPH_DIR + '-')
  );
}

/**
 * The data directory name for one project: {@link codeGraphDirName}, except
 * for a project on a Windows drive under WSL (`/mnt/c/...`) with no
 * `CODEGRAPH_DIR` set. Windows-native CodeGraph opens `.codegraph` in that
 * same tree, and SQLite's locking doesn't hold across the 9p/DrvFs bridge, so
 * the two sharing one index fails with "disk I/O error" (issue #995). There:
 *
 *   1. `.codegraph-wsl/` exists → it. Once WSL has its own index it keeps it,
 *      even after Windows builds a `.codegraph` beside it.
 *   2. `.codegraph/codegraph.db` exists → `.codegraph`. An index built before
 *      this default is kept rather than silently rebuilt somewhere else.
 *   3. neither → `.codegraph-wsl`, so a fresh WSL index never shares.
 *
 * Every other host keeps the plain name without a stat: the WSL check is
 * cached per process.
 */
export function codeGraphDirNameFor(projectRoot: string): string {
  if (process.env.CODEGRAPH_DIR?.trim() || !isWslWindowsDrive(projectRoot)) return codeGraphDirName();
  try {
    if (fs.statSync(path.join(projectRoot, WSL_CODEGRAPH_DIR)).isDirectory()) return WSL_CODEGRAPH_DIR;
  } catch {
    // absent — fall through
  }
  if (fs.existsSync(path.join(projectRoot, DEFAULT_CODEGRAPH_DIR, 'codegraph.db'))) return DEFAULT_CODEGRAPH_DIR;
  return WSL_CODEGRAPH_DIR;
}

/**
 * Get the .codegraph directory path for a project
 */
export function getCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, codeGraphDirNameFor(projectRoot));
}

/**
 * Check if a project has been initialized with CodeGraph.
 *
 * Requires `.codegraph/codegraph.db` to exist AND to carry the codegraph
 * schema. A file that merely exists — empty, or a SQLite database with no
 * tables, as an interrupted `init` or a stray `touch` leaves behind — used to
 * count as initialized, so one such file in an ANCESTOR directory (worst
 * case: `$HOME`) captured the upward resolution of every project beneath it
 * and made their real indexes unreachable (#1895).
 *
 * The probe is cheap and gated so hot callers (MCP root resolution on
 * every call) pay one `stat`: file size, then a read-only
 * SQLite open with a single `sqlite_master` lookup — memoized per path +
 * mtime + size so an unchanged db is never reopened. A database that cannot
 * be inspected counts as initialized (see probeSchema) — only a proven-absent
 * schema, or a file SQLite refuses as not a database, says no.
 */
export function isInitialized(projectRoot: string): boolean {
  const codegraphDir = getCodeGraphDir(projectRoot);
  if (!fs.existsSync(codegraphDir) || !fs.statSync(codegraphDir).isDirectory()) {
    return false;
  }
  // Must have codegraph.db, not just .codegraph folder
  const dbPath = path.join(codegraphDir, 'codegraph.db');
  let st: fs.Stats;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return false;
  }
  return hasCodeGraphSchema(dbPath, st);
}

/**
 * `codegraph.db` exists at `projectRoot` but does not carry the schema, and
 * `init` can add it in place: an empty file, or a SQLite database without the
 * codegraph tables (#1895). A file that is not SQLite at all is NOT this case —
 * see {@link hasForeignDbFile}.
 */
export function hasSchemalessDb(projectRoot: string): boolean {
  const dbPath = path.join(getCodeGraphDir(projectRoot), 'codegraph.db');
  let st: fs.Stats;
  try { st = fs.statSync(dbPath); } catch { return false; }
  if (!st.isFile() || isInitialized(projectRoot)) return false;
  return st.size === 0 || probeSchema(dbPath) === 'no-schema';
}

/**
 * `codegraph.db` exists at `projectRoot` and is not a SQLite database (no
 * header magic): SQLite refuses to open it, so `init` cannot rebuild it in
 * place. The caller must say so rather than promise a repair; nothing here
 * deletes the file.
 */
export function hasForeignDbFile(projectRoot: string): boolean {
  const dbPath = path.join(getCodeGraphDir(projectRoot), 'codegraph.db');
  let st: fs.Stats;
  try { st = fs.statSync(dbPath); } catch { return false; }
  return st.isFile() && st.size > 0 && probeSchema(dbPath) === 'not-sqlite';
}

/** A SQLite file header is 100 bytes; anything shorter cannot hold a schema. */
const SQLITE_HEADER_SIZE = 100;
/** SQLITE_NOTADB: SQLite read the file and it is not a database. */
const SQLITE_NOTADB = 26;
const schemaProbeCache = new Map<string, { mtimeMs: number; size: number; ok: boolean }>();

function hasCodeGraphSchema(dbPath: string, st: fs.Stats): boolean {
  if (!st.isFile() || st.size < SQLITE_HEADER_SIZE) return false;
  const cached = schemaProbeCache.get(dbPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.ok;
  const probe = probeSchema(dbPath);
  const ok = probe === 'schema' || probe === 'unknown';
  schemaProbeCache.set(dbPath, { mtimeMs: st.mtimeMs, size: st.size, ok });
  return ok;
}

/**
 * What `codegraph.db` holds, asked of SQLite itself through a read-only
 * connection: the codegraph schema, a database without it, not a database at
 * all (SQLITE_NOTADB), or `unknown` — locked, busy, a WAL db in a directory we
 * cannot create `-shm` in (read-only checkout, mount, another user's tree),
 * disk I/O. Callers treat `unknown` as initialized: the pre-existing behaviour
 * for a database we cannot inspect.
 *
 * The file is never read through a descriptor of our own, not even for its
 * 16-byte header. Closing ANY descriptor on a database file drops every POSIX
 * lock this process holds on it, including those of a connection it already
 * has open (sqlite.org/howtocorrupt.html §2.2.1) — and the MCP server resolves
 * projects through isInitialized on every call while it holds the index as
 * its writer. SQLite's own connections share one lock table per file, so a
 * second connection opened and closed here leaves the first one's locks alone.
 */
function probeSchema(dbPath: string): 'schema' | 'no-schema' | 'not-sqlite' | 'unknown' {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  let db: any = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get();
    return row !== undefined ? 'schema' : 'no-schema';
  } catch (error) {
    return (error as { errcode?: number })?.errcode === SQLITE_NOTADB ? 'not-sqlite' : 'unknown';
  } finally {
    // Never hold the handle: Windows file locking would block the owner.
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Find the nearest parent directory containing .codegraph/
 *
 * Walks up from the given path to find a CodeGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .codegraph/, or null if not found
 */
/**
 * Reason a directory is unsafe to use as an index ROOT, or null when it's fine.
 *
 * Indexing your home directory or a filesystem root drags in caches, `Library`,
 * every other project, etc. — a multi-GB index, constant file-watcher churn, and
 * (pre-1.0 on macOS) a file-descriptor blowup that exhausted `kern.maxfiles` and
 * took unrelated apps / the whole machine down (#845). The classic trigger:
 * running the installer or `codegraph init` from `$HOME`, which auto-indexes the
 * current directory. These are never intended project roots, so the installer
 * and `init`/`index` refuse them (overridable with `--force`).
 *
 * Pure-ish (reads only `os.homedir()` + realpath) so it's easy to unit-test.
 * The returned string is a human phrase that slots into "… looks like {reason}".
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // Filesystem root: `/` on POSIX, a drive root like `C:\` on Windows.
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // Case-insensitive on macOS/Windows (case-preserving but case-insensitive FS).
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // An ancestor of home (e.g. `/Users`, `/home`) — even broader than home.
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

/**
 * `dev:ino` for a path, or null if it can't be stat'd or the platform doesn't
 * report a usable inode. Read as bigints: WSL DrvFs (`/mnt/c`) reports inodes
 * above 2^53, where a plain number rounds nearby inodes onto one value. Windows
 * st_ino is unreliable across handle reopens, so we deliberately return null
 * there — the deleted-but-open-inode hazard this guards (#925) is a POSIX
 * file-semantics issue that doesn't arise on Windows (an open file can't be
 * unlinked).
 */
export function statInode(p: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const s = fs.statSync(p, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a project root for IDENTITY: hashing it into a rendezvous key
 * (the daemon's named pipe / tmpdir socket, a registry record). Not for display
 * — the caller-visible root keeps its own spelling.
 *
 * The contract is that two spellings of ONE directory yield ONE string, because
 * a client that derives a different key silently fails to meet the daemon that
 * is already running: it probes a socket nobody bound, spawns a redundant
 * daemon, and that daemon dies on the lock the first one holds, so the session
 * degrades to a single-process engine. `path.resolve` alone does NOT satisfy
 * that contract — NTFS is case-insensitive, so `d:\work\codegraph` and
 * `D:\work\codegraph` name one directory but two strings, and non-native
 * `fs.realpathSync` keeps whichever casing the caller passed (only `.native`
 * asks the filesystem for the on-disk name — the same reason
 * {@link isSameIndexRoot} uses it). Both spellings really do occur: a
 * cwd-derived root is the on-disk case, while a client-supplied
 * `rootUri`/`workspaceFolders` path arrives as `file:///d%3A/…`.
 *
 * The Windows lowercase is belt-and-braces on top of the native realpath — NTFS
 * can't hold two directories differing only by case, and it also absorbs a
 * `\\?\`-prefixed native result diverging from a plain one.
 */
export function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // ENOENT/EACCES/ELOOP — the root is normally there (`.codegraph/` lives in
    // it), so this is a fallback rather than a path we expect to take.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Whether two resolved index roots are one index spelled two ways — a symlinked
 * checkout, or a case-variant on a case-insensitive mount (macOS, NTFS, WSL
 * DrvFs `/mnt/c`), where `realpathSync` keeps the caller's casing (#1057).
 * Compares the identity of both data directories as they are NOW, so an inode
 * reused after a delete can't match: the deleted root no longer stats. Windows
 * has no usable inode, so it compares the on-disk-cased native realpaths.
 */
export function isSameIndexRoot(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform === 'win32') {
    try {
      return fs.realpathSync.native(getCodeGraphDir(a)) === fs.realpathSync.native(getCodeGraphDir(b));
    } catch {
      return false;
    }
  }
  const id = statInode(getCodeGraphDir(a));
  return id !== null && id === statInode(getCodeGraphDir(b));
}

export function findNearestCodeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/** Heavy/irrelevant directory names the sub-project scan never descends into. */
const SUBPROJECT_SCAN_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.turbo', '.idea', '.vscode', 'tmp', 'temp',
]);

/** Manifests that mark a directory as a project/workspace root. The down-scan
 *  is gated on one of these so a non-project cwd (e.g. `$HOME`) is a cheap
 *  no-op instead of a deep filesystem crawl. */
const WORKSPACE_ROOT_MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
  'go.work', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'pyproject.toml', 'composer.json', 'Gemfile', 'rush.json',
  'WORKSPACE', 'WORKSPACE.bazel',
];

function looksLikeProjectRoot(dir: string): boolean {
  return WORKSPACE_ROOT_MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Indexed sub-project roots beneath `root` (bounded breadth-first scan). For
 * the monorepo case behind #964: the index lives in a CHILD
 * (`packages/x/.codegraph/`), not at the workspace root the agent's cwd points
 * at. Descent stops at the first indexed directory on a branch (a project's
 * own sub-dirs aren't separate projects) and is bounded by depth + count so it
 * never turns into a full-tree crawl on a large repo.
 */
export function findIndexedSubprojectRoots(
  root: string,
  opts: { maxDepth?: number; max?: number } = {},
): string[] {
  // A stray workspace manifest must not enable scanning home or broader roots (#1454).
  if (unsafeIndexRootReason(root) !== null) return [];
  const maxDepth = opts.maxDepth ?? 4;
  const max = opts.max ?? 64;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SUBPROJECT_SCAN_SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (isInitialized(child)) { out.push(child); continue; } // don't descend into an indexed project
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** Result of {@link resolveServerRoot}. */
export interface ServerRootResolution {
  /** The project root to serve as the default, or null when none resolved. */
  root: string | null;
  /** True when `root` was adopted from the down-scan rather than the up-walk. */
  viaSubScan: boolean;
  /**
   * Indexed sub-projects the down-scan saw when it ran but could NOT adopt
   * (zero or several candidates). Empty when the up-walk resolved or the scan
   * was skipped. Callers surface these so "no default project" errors can say
   * what IS reachable (#1607).
   */
  candidates: string[];
}

/**
 * Whether `base` is a plausible workspace root for the sub-project down-scan.
 * A workspace manifest qualifies, and so does a bare `.git`
 * entry — the #1606 shape is a workspace container holding only agent config
 * and a `.git`, with every build manifest living in the indexed children. The
 * user's home directory and the filesystem root are never eligible: a stray
 * manifest there must not turn server startup into a scan that could adopt an
 * unrelated project (#1454).
 */
function eligibleForSubprojectScan(base: string): boolean {
  if (base === path.parse(base).root) return false;
  let home: string | null = null;
  try { home = os.homedir(); } catch { home = null; }
  if (home && (base === home || base === path.resolve(home))) return false;
  if (looksLikeProjectRoot(base)) return true;
  return fs.existsSync(path.join(base, '.git'));
}

/**
 * Resolve the project root an MCP server should serve as its DEFAULT project
 * (#1606). Up-walk first (`findNearestCodeGraphRoot` — the common case, and
 * cheap). When nothing is indexed at or above `searchFrom`, run the bounded
 * bounded sub-project down-scan, behind the workspace
 * gate above: EXACTLY ONE indexed sub-project is unambiguous and is adopted
 * as the root; zero or several yield no root, with the candidates carried so
 * the caller can name them instead of failing silently (#1607).
 *
 * `opts.subprojectScan: false` skips the down-scan entirely (the per-tool-call
 * retry path throttles it; the up-walk always runs).
 */
export function resolveServerRoot(
  searchFrom: string,
  opts: { subprojectScan?: boolean } = {},
): ServerRootResolution {
  const up = findNearestCodeGraphRoot(searchFrom);
  if (up) return { root: up, viaSubScan: false, candidates: [] };
  if (opts.subprojectScan === false) return { root: null, viaSubScan: false, candidates: [] };
  const base = path.resolve(searchFrom);
  if (!eligibleForSubprojectScan(base)) return { root: null, viaSubScan: false, candidates: [] };
  const subs = findIndexedSubprojectRoots(base);
  if (subs.length === 1) return { root: subs[0]!, viaSubScan: true, candidates: subs };
  return { root: null, viaSubScan: false, candidates: subs };
}

/**
 * Contents of `.codegraph/.gitignore`. A single wildcard ignore keeps every
 * transient file in the index dir — the database, `daemon.pid`, the socket,
 * logs, cache, and anything future versions add — out of git, without having
 * to enumerate each name (issues #788, #492, #484). Older versions wrote an
 * explicit allowlist that never listed `daemon.pid` or the socket, so those
 * runtime files were silently committed.
 */
const GITIGNORE_CONTENT = `# CodeGraph data files — local to each machine, not for committing.
# Ignore everything in .codegraph/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;

/** Header line that prefixes every .gitignore CodeGraph has auto-generated. */
const GITIGNORE_MARKER = '# CodeGraph data files';

/**
 * Is `content` a stale CodeGraph-generated `.gitignore` that should be
 * regenerated in place? True when it carries our header but predates the
 * wildcard ignore (it has no bare `*` line) — i.e. one of the old explicit
 * allowlists (`*.db`, `cache/`, `.dirty`, …) that never ignored `daemon.pid`
 * or the socket (issue #788). A file WITHOUT our header is user-authored and
 * is left untouched; one that already has the wildcard is current. Matching
 * on the header (not a byte-exact list of past defaults) heals every old
 * variant — v0.7.x through 0.9.9 — and is idempotent once upgraded.
 */
function isStaleDefaultGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

/**
 * Write `.codegraph/.gitignore` if it's absent, or upgrade a stale
 * CodeGraph-generated default in place; a user-customized file is left alone.
 * Best-effort — returns `false` only if a needed write failed.
 */
function ensureGitignore(gitignorePath: string): boolean {
  let existing: string | null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null; // absent (ENOENT) or unreadable — (re)create below
  }
  // Current default or a user-authored file: nothing to do.
  if (existing !== null && !isStaleDefaultGitignore(existing)) return true;
  try {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the .codegraph directory structure
 * Note: Only throws if codegraph.db already exists, not just if .codegraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  // Only throw if CodeGraph is actually initialized (db with a schema).
  // .codegraph/ folder alone — or a schema-less codegraph.db left by an
  // interrupted init (#1895) — is fine: initialize() adds the schema to it.
  if (isInitialized(projectRoot)) {
    throw new Error(`CodeGraph already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(codegraphDir, { recursive: true });

  // Write .gitignore inside .codegraph (create if absent, upgrade a stale
  // pre-wildcard default left by an older version — issue #788).
  ensureGitignore(path.join(codegraphDir, '.gitignore'));
}

/**
 * Remove the .codegraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  // Verify .codegraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(codegraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(codegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(codegraphDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(codegraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .codegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair / upgrade .gitignore (non-critical file). A missing one is
  // recreated; a stale pre-wildcard default that never ignored daemon.pid is
  // regenerated in place (issue #788); a user-authored file is left alone.
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  if (!ensureGitignore(gitignorePath) && !existedBefore) {
    // Only a missing-and-uncreatable file is surfaced; a failed in-place
    // upgrade of an existing file is non-fatal — the index still works.
    errors.push('.gitignore missing in .codegraph directory and could not be created');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
