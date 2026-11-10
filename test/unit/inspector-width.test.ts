import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ORIGINAL_INSPECTOR_WIDTH, DEFAULT_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH, MIN_CHAT_WIDTH,
  MIN_INSPECTOR_WIDTH, INSPECTOR_SEPARATOR_WIDTH, clampInspectorWidth,
  inspectorWidthBounds, normalizeInspectorPreference, restoreInspectorWidth, serializeInspectorWidth,
} from '../../web/src/useInspectorWidth.ts';

test('default is twice the original real CSS width, not a percentage or a label', () => {
  assert.equal(ORIGINAL_INSPECTOR_WIDTH, 304);
  assert.equal(DEFAULT_INSPECTOR_WIDTH, 608);
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--inspector-width:\s*608px;/);
  assert.match(css, /width:\s*var\(--inspector-width,\s*608px\)/);
  assert.equal(clampInspectorWidth(restoreInspectorWidth(null), 1600), 608);
});

test('missing, invalid and old storage formats restore the new default', () => {
  const invalid = [null, '', ' ', 'oops', 'NaN', 'Infinity', '304', '"608"', 'null', '[]', '{}',
    '{"version":0,"width":800}', '{"version":2,"width":800}', '{"version":1,"width":"800"}',
    '{"version":1,"width":null}', '{"version":1,"width":-1}', '{"version":1,"width":0}',
    '{"version":1,"width":279}', '{"version":1,"width":1401}', '{"version":1,"width":1e999}'];
  for (const raw of invalid) assert.equal(restoreInspectorWidth(raw), 608, String(raw));
});

test('versioned preferences round-trip and retain legal boundaries', () => {
  for (const width of [280, 304, 608, 900, 1400]) {
    assert.equal(restoreInspectorWidth(serializeInspectorWidth(width)), width);
  }
  assert.equal(restoreInspectorWidth('{"version":1,"width":700.4}'), 700);
});

test('interactive widths clamp and invalid numeric input falls back safely', () => {
  assert.equal(normalizeInspectorPreference(-50), MIN_INSPECTOR_WIDTH);
  assert.equal(normalizeInspectorPreference(10000), MAX_INSPECTOR_WIDTH);
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(normalizeInspectorPreference(value), 608);
  assert.equal(clampInspectorWidth(1400, 1600), 848);
  assert.equal(clampInspectorWidth(280, 1600), 280);
});

test('desktop bounds preserve the main chat and match sidebar breakpoints', () => {
  for (const viewport of [1001, 1100, 1240, 1241, 1366, 1600, 1920, 3440]) {
    const sidebar = viewport > 1240 ? 264 : 248;
    const bounds = inspectorWidthBounds(viewport);
    assert.equal(bounds.drawer, false);
    assert.ok(bounds.min <= bounds.max);
    assert.ok(viewport - sidebar - INSPECTOR_SEPARATOR_WIDTH - bounds.max >= MIN_CHAT_WIDTH);
    assert.ok(bounds.max <= MAX_INSPECTOR_WIDTH);
  }
});

test('narrow viewports use a bounded drawer and never request more width than available', () => {
  for (const viewport of [0, 16, 24, 100, 240, 320, 375, 700, 768, 1000]) {
    const bounds = inspectorWidthBounds(viewport);
    assert.equal(bounds.drawer, true);
    const width = clampInspectorWidth(1400, viewport);
    assert.ok(width >= 0);
    assert.ok(width <= Math.max(0, viewport - 24));
  }
  assert.equal(clampInspectorWidth(608, 375), 351);
  for (const viewport of [NaN, Infinity, -100]) assert.equal(clampInspectorWidth(608, viewport), 0);
});

test('close/reopen projects the same preference instead of saving zero', () => {
  const stored = serializeInspectorWidth(820);
  const preference = restoreInspectorWidth(stored);
  assert.equal(clampInspectorWidth(preference, 1920, false), 0);
  assert.equal(clampInspectorWidth(preference, 1920, true), 820);
  assert.equal(serializeInspectorWidth(preference), stored);
});

test('shrinking and expanding a window never destroy the saved preference', () => {
  const preference = restoreInspectorWidth(serializeInspectorWidth(1100));
  assert.equal(clampInspectorWidth(preference, 2200), 1100);
  assert.equal(clampInspectorWidth(preference, 1200), 464);
  assert.equal(clampInspectorWidth(preference, 375), 351);
  assert.equal(clampInspectorWidth(preference, 2200), 1100);
  assert.equal(preference, 1100);
});
