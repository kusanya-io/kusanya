import { win32 } from 'node:path';

/**
 * Resolve Git for Windows Bash from every path returned by `where.exe git`.
 * The injected predicate must return true only for an existing regular file.
 * This function performs no filesystem access and never searches for generic Bash.
 */
export function resolveGitBash(whereOutput, isFile) {
  if (typeof whereOutput !== 'string' || typeof isFile !== 'function') {
    throw new TypeError(
      'Git discovery output and a file-check function are required.',
    );
  }
  const seenRoots = new Set();
  for (const line of whereOutput.split(/\r?\n/)) {
    const gitPath = win32.normalize(line.trim());
    if (
      !win32.isAbsolute(gitPath) ||
      win32.basename(gitPath).toLowerCase() !== 'git.exe'
    )
      continue;
    const directory = win32.dirname(gitPath);
    const layout = win32.basename(directory).toLowerCase();
    if (layout !== 'cmd' && layout !== 'bin') continue;
    let root = win32.dirname(directory);
    if (layout === 'bin' && /^mingw(?:32|64)$/i.test(win32.basename(root)))
      root = win32.dirname(root);
    const rootKey = root.toLowerCase();
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    for (const parts of [
      ['bin', 'bash.exe'],
      ['usr', 'bin', 'bash.exe'],
    ]) {
      const candidate = win32.join(root, ...parts);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(
    'Git for Windows Bash was not found. Expected bin\\bash.exe or usr\\bin\\bash.exe under an installation reported by where.exe git.',
  );
}
