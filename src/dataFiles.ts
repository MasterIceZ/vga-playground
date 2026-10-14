/**
 * Data files are the files a design reads with $readmemh / $readmemb. A
 * project stores them keyed by the path as written in the Verilog source,
 * which is relative to src/ (e.g. "../data/image.mem"); the UI shows them by
 * their path from the project root (e.g. "data/image.mem").
 */

const SOURCE_EXTENSIONS = ['.v', '.sv', '.vh', '.svh'];

/** Maps a $readmem path (relative to src/) to its path from the project root. */
export function dataFileDisplayPath(path: string) {
  const resolved: string[] = [];
  for (const part of `src/${path}`.split('/')) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

/** Maps a path from the project root to the $readmem path (relative to src/) that loads it. */
export function dataFileKey(displayPath: string) {
  return displayPath.startsWith('src/') ? displayPath.slice('src/'.length) : `../${displayPath}`;
}

/**
 * Looks up a data file by the path a $readmem call asked for, matching any
 * spelling of the same file (e.g. "../data/a.mem" and "./../data/a.mem").
 */
export function findDataFile(dataFiles: Record<string, string> | undefined, path: string) {
  if (!dataFiles) return undefined;
  if (dataFiles[path] != null) return dataFiles[path];
  const target = dataFileDisplayPath(path);
  for (const [key, content] of Object.entries(dataFiles)) {
    if (dataFileDisplayPath(key) === target) return content;
  }
  return undefined;
}

/**
 * Validates a data file path typed by the user, relative to the project root.
 *
 * @returns the normalized path, or an error message
 */
export function parseDataFilePath(input: string): { path: string } | { error: string } {
  const path = input.trim().replace(/^(\.\/)+/, '');
  if (path === '' || path.endsWith('/')) {
    return { error: 'Enter a file name, e.g. data/image.mem' };
  }
  if (path.startsWith('/') || path.includes('\\')) {
    return { error: 'Use a path relative to the project root, with "/" between folders' };
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { error: 'The path must stay inside the project' };
  }
  if (SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return { error: 'Verilog files must be directly in src/, e.g. my_module.v' };
  }
  return { path };
}
