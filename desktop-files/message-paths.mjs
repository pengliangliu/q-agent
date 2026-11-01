import fs from 'node:fs/promises';
import path from 'node:path';

const windowsPath = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value);
const within = (value, root) => value === root || value.startsWith(root + path.sep);

export function isLocalWslUNC(value) {
  const match = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\/i.exec(value);
  return Boolean(match && process.env.WSL_DISTRO_NAME &&
    match[1].toLowerCase() === process.env.WSL_DISTRO_NAME.toLowerCase());
}

function reference(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return '';
  let result = value.trim();
  if (result.length > 1 && ['"', "'"].includes(result[0]) && result.at(-1) === result[0]) result = result.slice(1, -1);
  return result.replace(/:\d+(?::\d+)?$/, '');
}

async function existing(candidates, directoriesOnly = false) {
  const found = new Map();
  for (const candidate of new Set(candidates)) {
    const info = await fs.stat(candidate).catch(() => null);
    if (!info || (directoriesOnly ? !info.isDirectory() : !info.isDirectory() && !info.isFile())) continue;
    const real = await fs.realpath(candidate).catch(() => candidate);
    if (!found.has(real)) found.set(real, candidate);
  }
  return [...found.values()];
}

// Resolve only paths anchored by this message's recorded location or explicit
// directory references. Never scan a project tree or pick one of several files.
export async function resolveMessagePath(rawPath, { projectPath, messageCwd, directoryHints = [] } = {}) {
  const value = reference(rawPath);
  if (!value) throw new Error('文件路径无效。');
  // Explicit absolute references retain the existing reveal/Windows conversion.
  if (path.isAbsolute(value) || windowsPath(value)) return { path: value, candidates: [value] };
  if (/^[A-Za-z][\w+.-]*:/.test(value)) throw new Error('不支持此文件路径。');
  const project = reference(projectPath);
  const cwd = reference(messageCwd);
  const projectRoot = project && path.isAbsolute(project) ? path.resolve(project) : '';
  const bases = new Set();
  if (cwd && path.isAbsolute(cwd)) {
    let cursor = path.resolve(cwd);
    bases.add(cursor);
    if (projectRoot) {
      // Keep ancestor candidates inside the registered project.
      while (within(cursor, projectRoot) && cursor !== projectRoot) {
        cursor = path.dirname(cursor);
        bases.add(cursor);
      }
    }
  }
  if (projectRoot) bases.add(projectRoot);
  const directories = new Set();
  for (const hint of (Array.isArray(directoryHints) ? directoryHints : []).slice(0, 24)) {
    const directory = reference(hint);
    if (!directory || !/[\\/]$/.test(directory) || windowsPath(directory) || /^[A-Za-z][\w+.-]*:/.test(directory)) continue;
    const normalized = directory.replaceAll('\\', '/');
    const candidates = path.isAbsolute(normalized) ? [normalized]
      : [...bases, ...directories].map(base => path.resolve(base, normalized));
    const matches = await existing(candidates, true);
    // An ambiguous directory cannot supply a trustworthy base for later links.
    if (matches.length === 1) {
      let cursor = path.resolve(matches[0]);
      directories.add(cursor);
      // Native cwd history can point inside the linked directory. Its recorded
      // project-local ancestors are also valid bases for a relative reference.
      if (path.isAbsolute(normalized) && projectRoot) {
        while (within(cursor, projectRoot) && cursor !== projectRoot) {
          cursor = path.dirname(cursor);
          directories.add(cursor);
        }
      }
    }
  }
  const normalized = value.replaceAll('\\', '/');
  const candidates = await existing([...bases, ...directories].map(base => path.resolve(base, normalized)));
  return { path: candidates.length === 1 ? candidates[0] : null, candidates };
}
