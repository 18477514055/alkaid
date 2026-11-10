import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isInside, normalizePath, samePath, toAbsolute } from '../../src/core/paths.ts';

test('normalizePath 消掉 . 与 ..，并统一分隔符', () => {
  assert.equal(normalizePath('C:\\a\\b\\..\\c'), 'C:/a/c');
  assert.equal(normalizePath('/a/./b'), '/a/b');
  assert.equal(normalizePath('a//b///c'), 'a/b/c');
  assert.equal(normalizePath('  D:\\x\\  '), 'D:/x');
});

test('normalizePath 在根处的 .. 不会越界', () => {
  assert.equal(normalizePath('C:\\..\\..\\x'), 'C:/x');
  assert.equal(normalizePath('/../../x'), '/x');
});

test('isInside 认边界：同前缀但不同目录不算在里面', () => {
  assert.equal(isInside('/data/workspaces/abc/file.txt', '/data/workspaces/abc'), true);
  assert.equal(isInside('/data/workspaces/abc', '/data/workspaces/abc'), true);
  // ★ 这一条是最容易写错的地方：裸 startsWith 会把 abcd 误判成在 abc 里
  assert.equal(isInside('/data/workspaces/abcd/x', '/data/workspaces/abc'), false);
});

test('isInside 挡住 .. 穿越', () => {
  assert.equal(isInside('/data/workspace/../secret.txt', '/data/workspace'), false);
  assert.equal(isInside('/data/workspace/sub/../../secret.txt', '/data/workspace'), false);
});

test('Windows 上大小写不敏感（否则就是一个绕过口子）', () => {
  if (process.platform !== 'win32') return;
  assert.equal(isInside('C:\\Users\\X\\a.txt', 'c:/users/x'), true);
  assert.equal(samePath('C:/Users/X', 'c:\\users\\x'), true);
});

test('toAbsolute 相对路径按基准解析', () => {
  const base = 'C:/work/proj';
  assert.equal(toAbsolute('sub/a.txt', base), 'C:/work/proj/sub/a.txt');
  assert.equal(toAbsolute('../out.txt', base), 'C:/work/out.txt');
});
