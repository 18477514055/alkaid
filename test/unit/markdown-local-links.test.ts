import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { marked } from 'marked';
import { isAllowedLocalLink, protectLocalLinkAttributes } from '../../src/shared/local-links.ts';

const ORIGIN = 'http://127.0.0.1:43123';

function attributeNode(values: Record<string, string>) {
  const attributes = new Map(Object.entries(values));
  return {
    attributes,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => { attributes.delete(name); },
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
  };
}

test('Markdown local links: canonical same Cookie host / different origin cannot navigate', () => {
  const blocked = [
    'http://127.0.0.1:43124/collect',
    'http://127.0.0.1:4312/', // port-prefix confusion
    'https://127.0.0.1:43123/',
    'http://127.0.0.1/',
    '//127.0.0.1:43124/collect',
    'http://trusted.example@127.0.0.1:43124/',
    'http://name:password@127.0.0.1:43124/',
    'http://2130706433:43124/', // decimal IPv4
    'http://0x7f000001:43124/', // hexadecimal IPv4
    'http://127.1:43124/',
    'http://0177.0.0.1:43124/',
    'http://%31%32%37.0.0.1:43124/',
    'http://127.0.0.1.:43124/',
    '\\' + '\\127.0.0.1:43124/collect', // WHATWG special URL backslashes
    '  http://127.0.0.1:43124/collect\n',
    'ht\ttp://127.0.0.1:43124/',
    'ftp://127.0.0.1:43124/',
    'http://127.0.0.1:999999/', // malformed must fail closed
  ];
  for (const href of blocked) assert.equal(isAllowedLocalLink(href, ORIGIN), false, href);
  assert.equal(isAllowedLocalLink('http://LOCALHOST:43124/', 'http://localhost:43123'), false);
  assert.equal(isAllowedLocalLink('http://localhost.:43124/', 'http://localhost:43123'), false);
  assert.equal(isAllowedLocalLink('http://[0:0:0:0:0:0:0:1]:43124/', 'http://[::1]:43123'), false);
  assert.equal(isAllowedLocalLink('https://127.0.0.1:443/', 'http://127.0.0.1:80'), false);
  assert.equal(isAllowedLocalLink('/anything', 'not-an-origin'), false);
});

test('Markdown local links: same origin, relative/hash and ordinary other-host external links remain available', () => {
  for (const href of ['/api/healthz', './doc', '#section', '?q=1', '', ORIGIN, `${ORIGIN}/path`,
    'https://example.com/docs', 'http://127.0.0.1:43123@external.example/',
    'https://127.0.0.1.example.com/', 'mailto:help@example.com']) {
    assert.equal(isAllowedLocalLink(href, ORIGIN), true, href);
  }
  assert.equal(isAllowedLocalLink('http://example.com:80/path', 'http://example.com'), true, 'default port canonicalizes');
});

test('Markdown local links: final attribute guard removes href itself, target/download/ping; normal external href stays', () => {
  // Hook receives DOM attributes after HTML entity decoding; the same guard applies to raw HTML and Markdown output.
  for (const name of ['href', 'xlink:href']) {
    const node = attributeNode({ [name]: 'http://name@127.0.0.1:43124/collect?a=1&b=2', target: '_blank', download: 'dump', ping: 'http://127.0.0.1:43124/ping' });
    protectLocalLinkAttributes(node, ORIGIN);
    assert.equal(node.getAttribute(name), null, 'without an href, middle click/new-window/save-link has no target');
    assert.equal(node.getAttribute('target'), null);
    assert.equal(node.getAttribute('download'), null);
    assert.equal(node.getAttribute('ping'), null);
    assert.equal(node.getAttribute('aria-disabled'), 'true');
    assert.match(node.getAttribute('title')!, /本机授权/);
  }
  const safe = attributeNode({ href: 'https://example.com/', target: '_blank', ping: 'http://127.0.0.1:43124/ping' });
  protectLocalLinkAttributes(safe, ORIGIN);
  assert.equal(safe.getAttribute('href'), 'https://example.com/');
  assert.equal(safe.getAttribute('target'), '_blank');
  assert.equal(safe.getAttribute('ping'), null);
  assert.equal(safe.getAttribute('aria-disabled'), null);
});

test('Markdown local links: standard Markdown and raw HTML converge on final DOMPurify hook', () => {
  const text = `[markdown](http://127.0.0.1:43124/collect)\n\n<a href="http://127.0.0.1:43124/collect" target="_blank">raw</a>`;
  const html = marked.parse(text, { async: false });
  assert.equal([...html.matchAll(/href="http:\/\/127\.0\.0\.1:43124\/collect"/g)].length, 2);
  const renderer = readFileSync(new URL('../../web/src/markdown.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /DOMPurify\.addHook\('afterSanitizeAttributes',[\s\S]*?protectLocalLinkAttributes\(node, window\.location\.origin\)/);
  assert.match(renderer, /return DOMPurify\.sanitize\(withChrome,/);
});
