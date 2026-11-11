/**
 * 本机令牌主动攻击验收：真内核/真实 HTTP/Windows Low-IL，所有数据在临时家。
 * node scripts/verify-local-token.ts [--serve] [--desktop] [--disabled]
 * --serve 保留隔离服务供真实浏览器验收；收到 SIGINT/SIGTERM 后清理。
 * --desktop 真启动打包 exe（不是 ELECTRON_RUN_AS_NODE 冒充桌面）。
 * 回执不包含令牌、配对码、Cookie、请求正文或上游响应正文。
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const disabled = args.has('--disabled');
const desktop = args.has('--desktop');
const serve = args.has('--serve');
const home = mkdtempSync(join(tmpdir(), 'alkaid-local-token-'));
const out = join(home, 'attack-output');
const plugins = join(home, 'empty-plugins');
mkdirSync(plugins);
mkdirSync(out);
let modelRequests = 0;
// 只提供隔离假模型。任何消息都不会送往真实厂商。
const mock = createServer(async (req, res) => {
  for await (const _chunk of req) { /* 不保存 prompt 或响应正文到诊断 */ }
  if (req.url?.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'local-a' }, { id: 'local-b' }] }));
    return;
  }
  modelRequests += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'local-check', choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_TOKEN_UI_OK' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((done) => mock.listen(0, '127.0.0.1', done));
const mockAddress = mock.address();
assert.ok(mockAddress && typeof mockAddress === 'object');
const probe = netServer();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((done) => probe.close(() => done()));
const url = `http://127.0.0.1:${port}`;
const binary = join(root, 'release', 'YaoGuang-win32-x64', 'YaoGuang.exe');
const env: NodeJS.ProcessEnv = { ...process.env, ALKAID_HOME: home, ALKAID_PORT: String(port), ALKAID_HOST: '127.0.0.1', ALKAID_PLUGINS: plugins };
if (disabled) env['ALKAID_DISABLE_LOCAL_TOKEN'] = '1';
else delete env['ALKAID_DISABLE_LOCAL_TOKEN'];
if (desktop) delete env['ELECTRON_RUN_AS_NODE'];
else env['ELECTRON_RUN_AS_NODE'] = '1';
const child = spawn(desktop ? binary : process.execPath, desktop ? [`--remote-debugging-port=${port + 1}`] : [join(root, 'src', 'main.ts')], {
  cwd: root, env, windowsHide: !desktop, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });
// 启动日志只含路径/诊断，绝不转储来自 HTTP 的 Cookie。
child.stdout.resume();
const report: Record<string, unknown> = { mode: desktop ? 'real-desktop' : 'real-kernel', disabled, home, url, modelRequests: 0 };
let closed = false;
async function cleanup(): Promise<void> {
  if (closed) return;
  closed = true;
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    if (process.platform === 'win32' && child.pid !== undefined) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { child.kill(); }
    } else child.kill();
    await exited;
  }
  await new Promise<void>((done) => mock.close(() => done()));
  report['modelRequests'] = modelRequests;
  // 输出完整 stderr（其中按合同不得含凭据），方便核对真实 Electron 警告而非只看成功码。
  report['stderr'] = stderr;
  console.log(JSON.stringify(report, null, 2));
  if (process.env['ALKAID_VERIFY_REPORT_DIR']) {
    const dir = process.env['ALKAID_VERIFY_REPORT_DIR'];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `local-token-${desktop ? 'desktop' : disabled ? 'disabled' : 'http'}.json`), JSON.stringify(report, null, 2), 'utf8');
  }
  const { clearLowLabel } = await import('../src/core/sandbox/win32-confine.ts');
  if (process.platform === 'win32') clearLowLabel(out);
  // home 是本脚本mkdtemp返回的绝对路径，已作为非秘密回执输出；不删除用户数据家。
  assert.ok(resolve(home).startsWith(resolve(tmpdir())) && home.includes('alkaid-local-token-'));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
try {
  let health: any;
  for (let i = 0; i < 300; i += 1) {
    if (child.exitCode !== null) throw new Error(`Kernel exited before ready (${child.exitCode}); ${stderr}`);
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* 等内核真实监听 */ }
    await delay(100);
  }
  assert.ok(health, '内核未就绪');
  assert.equal(health.trust.localToken, disabled ? 'disabled' : 'enabled');
  const token = disabled ? null : readFileSync(health.trust.tokenPath, 'utf8').trim();
  assert.ok(disabled || (typeof token === 'string' && token.length >= 40));
  const headers = token ? { 'content-type': 'application/json', 'x-alkaid-token': token } : { 'content-type': 'application/json' };
  const providerRes = await fetch(`${url}/api/providers`, { method: 'POST', headers, body: JSON.stringify({ name: '隔离本机令牌验收', baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`, apiKey: 'isolated-placeholder', defaultModel: 'local-a' }) });
  assert.equal(providerRes.status, 201);
  const provider: any = await providerRes.json();
  const models = await fetch(`${url}/api/providers/${provider.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabledModels: ['local-a', 'local-b'] }) });
  assert.equal(models.status, 200);
  const conversationRes = await fetch(`${url}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ providerId: provider.id, model: 'local-a', title: '本机令牌隔离验收', permissionMode: 'workspace' }) });
  assert.equal(conversationRes.status, 201);
  const conversation: any = await conversationRes.json();
  report['conversationId'] = conversation.id;
  report['cliHeaderWrite'] = providerRes.status;
  report['healthWithoutToken'] = 200;
  const board = await fetch(`${url}/api/conversations/${conversation.id}/delegations`);
  assert.equal(board.status, 200);
  report['boardWithoutToken'] = board.status;
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('set-cookie'), null, '公开首页不得发凭证');
  report['publicIndexCookie'] = false;
  const before = await (await fetch(`${url}/api/conversations`)).json() as any[];
  assert.equal(before.find((c) => c.id === conversation.id)?.permissionMode, 'workspace');
  function storedPermission(): string {
    const db = new DatabaseSync(join(home, 'alkaid.db'), { readOnly: true });
    try { return String((db.prepare('SELECT permission_mode FROM conversations WHERE id = ?').get(conversation.id) as { permission_mode: string }).permission_mode); }
    finally { db.close(); }
  }
  const dbBefore = storedPermission();
  assert.equal(dbBefore, 'workspace');
  const marker = join(out, 'mcp-actually-started.txt');
  const mcpBody = { name: 'low-attack', transport: 'stdio', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], enabled: true, groupMode: 'lazy' };
  const mcpBefore = await (await fetch(`${url}/api/mcp/servers`)).json() as any[];
  if (process.platform === 'win32') {
    const { spawnConfined } = await import('../src/core/sandbox/win32-confine.ts');
    const ps = (v: string) => `'${v.replaceAll("'", "''")}'`;
    // 强制.NET客户端，读取GET返回cookie再主动回送；伪造浏览器头也不能授权。
    const script = `
$ErrorActionPreference='Stop';
$base=${ps(url)};
$jar=New-Object System.Net.CookieContainer;
$get=[System.Net.HttpWebRequest]::Create($base+'/'); $get.CookieContainer=$jar;
$resp=$get.GetResponse(); $cookieCount=$jar.Count; $resp.Close();
function SendAttack($path,$method,$body) {
  $r=[System.Net.HttpWebRequest]::Create($base+$path); $r.Method=$method; $r.CookieContainer=$jar;
  $r.ContentType='application/json'; $r.Headers.Add('Origin',$base); $r.Headers.Add('Sec-Fetch-Site','same-origin'); $r.Headers.Add('Sec-Fetch-Mode','cors'); $r.Headers.Add('x-alkaid-human-intent','principle-approval');
  $data=[Text.Encoding]::UTF8.GetBytes($body); $r.ContentLength=$data.Length; $s=$r.GetRequestStream(); $s.Write($data,0,$data.Length); $s.Close();
  try { $res=$r.GetResponse(); $code=[int]$res.StatusCode; $res.Close(); return $code } catch [System.Net.WebException] { if ($_.Exception.Response) { $code=[int]$_.Exception.Response.StatusCode; $_.Exception.Response.Close(); return $code }; throw }
}
$beforeIds=@(Get-Process | ForEach-Object {$_.Id});
$permission=SendAttack ${ps(`/api/conversations/${conversation.id}`)} 'PATCH' '{"permissionMode":"full"}';
$mcp=SendAttack '/api/mcp/servers' 'POST' ${ps(JSON.stringify(mcpBody))};
$approval=SendAttack '/api/projects/not-a-project/memory/principles/proposals/not-a-proposal/approval-intent' 'POST' '{}';
$tokenDenied=${disabled ? '$null' : '$true'}; $pairDenied=${disabled ? '$null' : '$true'};
${disabled ? '' : `try { $null=[IO.File]::ReadAllText(${ps(health.trust.tokenPath)}); $tokenDenied=$false } catch [UnauthorizedAccessException] { };
try { $null=[IO.File]::ReadAllText(${ps(health.trust.pairingPath)}); $pairDenied=$false } catch [UnauthorizedAccessException] { };`}
$afterIds=@(Get-Process | ForEach-Object {$_.Id});
$newIds=@($afterIds | Where-Object {$beforeIds -notcontains $_});
@{indexCookieCount=$cookieCount;permissionStatus=$permission;mcpStatus=$mcp;approvalStatus=$approval;tokenReadDenied=$tokenDenied;pairReadDenied=$pairDenied;newProcessCount=$newIds.Count} | ConvertTo-Json -Compress;
`;
    const low = await spawnConfined({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], cwd: home, outputDir: out, timeoutMs: 60_000, maxOutputChars: 8_000 });
    assert.equal(low.code, 0, `Low攻击探针未完成（不是防护通过）：${low.stderr}`);
    const attack = JSON.parse(low.stdout.trim());
    assert.equal(attack.indexCookieCount, 0);
    assert.equal(attack.permissionStatus, disabled ? 200 : 403);
    assert.equal(attack.mcpStatus, disabled ? 201 : 403);
    if (!disabled) {
      assert.equal(attack.approvalStatus, 403);
      assert.equal(attack.tokenReadDenied, true);
      assert.equal(attack.pairReadDenied, true);
    }
    report['lowAttack'] = attack;
    const after = await (await fetch(`${url}/api/conversations`)).json() as any[];
    assert.equal(after.find((c) => c.id === conversation.id)?.permissionMode, disabled ? 'full' : 'workspace');
    const mcpAfter = await (await fetch(`${url}/api/mcp/servers`)).json() as any[];
    assert.equal(mcpAfter.length, mcpBefore.length + (disabled ? 1 : 0));
    assert.equal(existsSync(marker), disabled);
    const dbAfter = storedPermission();
    assert.equal(dbAfter, disabled ? 'full' : dbBefore);
    report['dbPermissionBefore'] = dbBefore;
    report['dbPermissionAfter'] = dbAfter;
    report['permissionUnchanged'] = dbAfter === dbBefore;
    report['mcpMarkerExists'] = existsSync(marker);
    report['mcpRowsDelta'] = mcpAfter.length - mcpBefore.length;
  } else report['lowAttack'] = 'SKIPPED: Windows-only; not claimed verified';
  report['attacks'] = 'pass';
  if (serve) {
    console.log(JSON.stringify({ serving: url, home, conversationId: conversation.id, desktop, cdpPort: desktop ? port + 1 : null, pairingPath: health.trust.pairingPath ?? null, authEnabled: !disabled }));
    // Windows taskkill cannot deliver Node's graceful SIGINT path. A non-secret control file
    // in this exact mkdtemp home lets acceptance finish and persist its receipt without killing the harness.
    await new Promise<void>((resolveDone) => {
      const done = () => {
        watcher.close();
        process.removeListener('SIGINT', done);
        process.removeListener('SIGTERM', done);
        resolveDone();
      };
      const watcher = watch(home, (_event, filename) => {
        if (String(filename) === 'acceptance-finished' && existsSync(join(home, 'acceptance-finished'))) done();
      });
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  }
} finally { await cleanup(); }
