import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error JS release utility is intentionally separate from compiled app sources.
import { assertDesktopClosed } from '../../scripts/release-guard.mjs';

test('release guard: only an explicit clear process probe allows Windows release mutation',()=>{
 assert.doesNotThrow(()=>assertDesktopClosed({platform:'win32',probe:()=> 'CLEAR\r\n'}));
 for(const state of ['RUNNING','', 'unknown','CLEAR\nRUNNING']) assert.throws(()=>assertDesktopClosed({platform:'win32',probe:()=>state}),/No release files were changed/);
});
test('release guard: unavailable process inspection fails closed and never kills anything',()=>{
 assert.throws(()=>assertDesktopClosed({platform:'win32',probe:()=>{throw new Error('unavailable');}}),/release files were not changed/);
});
