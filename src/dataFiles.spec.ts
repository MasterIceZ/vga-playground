import { describe, expect, test } from 'vitest';
import { dataFileDisplayPath, dataFileKey, findDataFile, parseDataFilePath } from './dataFiles';

describe('dataFileDisplayPath', () => {
  test('resolves a $readmem path from src/', () => {
    expect(dataFileDisplayPath('../data/image.mem')).toBe('data/image.mem');
    expect(dataFileDisplayPath('./../data/image.mem')).toBe('data/image.mem');
    expect(dataFileDisplayPath('rom.hex')).toBe('src/rom.hex');
  });
});

describe('dataFileKey', () => {
  test('is the inverse of dataFileDisplayPath', () => {
    for (const path of ['data/image.mem', 'image.mem', 'src/rom.hex', 'a/b/c.bin']) {
      expect(dataFileDisplayPath(dataFileKey(path))).toBe(path);
    }
  });
});

describe('findDataFile', () => {
  const files = { '../data/image.mem': 'aa' };

  test('matches the exact key', () => {
    expect(findDataFile(files, '../data/image.mem')).toBe('aa');
  });

  test('matches another spelling of the same path', () => {
    expect(findDataFile(files, './../data/image.mem')).toBe('aa');
    expect(findDataFile(files, '../data//image.mem')).toBe('aa');
  });

  test('returns undefined for a missing file', () => {
    expect(findDataFile(files, '../data/other.mem')).toBeUndefined();
    expect(findDataFile(undefined, '../data/image.mem')).toBeUndefined();
  });
});

describe('parseDataFilePath', () => {
  test('accepts paths inside the project', () => {
    expect(parseDataFilePath('data/image.mem')).toEqual({ path: 'data/image.mem' });
    expect(parseDataFilePath(' ./image.hex ')).toEqual({ path: 'image.hex' });
  });

  test('rejects paths that leave the project or are malformed', () => {
    for (const bad of [
      '',
      'data/',
      '/abs.mem',
      '../up.mem',
      'a/../b.mem',
      'a//b.mem',
      'a\\b.mem',
    ]) {
      expect(parseDataFilePath(bad)).toHaveProperty('error');
    }
  });

  test('rejects Verilog sources', () => {
    expect(parseDataFilePath('data/top.v')).toHaveProperty('error');
  });
});
