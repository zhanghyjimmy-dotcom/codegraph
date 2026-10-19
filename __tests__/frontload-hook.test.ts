/**
 * Indexed sub-project discovery (#964).
 *
 * In the monorepo case the agent's cwd is an un-indexed workspace root and the
 * index lives in a sub-project. These test `findIndexedSubprojectRoots`
 * directly, including the home-directory guard (#1454).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { findIndexedSubprojectRoots, unsafeIndexRootReason } from '../src/directory';

// Make the built-in exports configurable so HOME can point at a real temp
// fixture without changing the process environment or the user's home files.
vi.mock('os', async (importOriginal) => ({ ...await importOriginal<typeof import('os')>() }));

/**
 * Make `dir` indexed. isInitialized needs `.codegraph/codegraph.db` WITH the
 * codegraph schema — an empty file no longer counts (#1895).
 */
function mkIndexed(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  CodeGraph.initSync(dir).close();
  return dir;
}
/** A workspace-root manifest, as a stray one in a home directory would look (#1454). */
function mkWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
  return dir;
}

describe('findIndexedSubprojectRoots', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-subscan-'))); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds indexed projects a couple levels down and skips node_modules/.git', () => {
    mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(tmp, 'services', 'auth'));
    // Decoys that must NOT be scanned into.
    mkIndexed(path.join(tmp, 'node_modules', 'dep'));
    mkIndexed(path.join(tmp, '.git', 'x'));
    const found = findIndexedSubprojectRoots(tmp).map((p) => path.relative(tmp, p)).sort();
    expect(found).toEqual([path.join('packages', 'api'), path.join('services', 'auth')].sort());
  });

  it('does not descend INTO an indexed project (a project\'s sub-dirs are not separate projects)', () => {
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(api, 'submodule')); // nested index under an already-indexed project
    const found = findIndexedSubprojectRoots(tmp);
    expect(found).toEqual([api]);
  });

  it('respects the depth bound', () => {
    mkIndexed(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep'));
    expect(findIndexedSubprojectRoots(tmp, { maxDepth: 2 })).toEqual([]);
  });

  it.each([
    { root: 'home', manifest: 'package.json', children: 1 },
    { root: 'home', manifest: 'package.json', children: 2 },
    { root: 'home', manifest: 'WORKSPACE', children: 1 },
    { root: 'parent of home', manifest: 'package.json', children: 1 },
  ])('$root with stray $manifest and $children indexed children → no scan (#1454)', ({ root, manifest, children }) => {
    const homeDir = root === 'home' ? tmp : path.join(tmp, 'user');
    fs.mkdirSync(homeDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    if (manifest === 'package.json') mkWorkspaceRoot(tmp);
    else fs.mkdirSync(path.join(tmp, manifest));
    mkIndexed(path.join(tmp, 'packages', 'api'));
    if (children === 2) mkIndexed(path.join(tmp, 'packages', 'web'));
    expect(unsafeIndexRootReason(tmp)).toBe(root === 'home' ? 'your home directory' : 'a parent of your home directory');
    expect(findIndexedSubprojectRoots(tmp)).toEqual([]);
  });
});
