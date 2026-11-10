import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 运行期配置。**只放路径与端口**，不放任何密钥。
 *
 * 数据根目录默认 `~/.alkaid`，可用 `ALKAID_HOME` 覆盖 —— 这样测试可以完全隔离
 * （每个用例一个临时目录），不需要去动用户真实的家目录。
 */
export type Config = {
  /** 数据根，绝对路径 */
  readonly home: string;
  /** SQLite 数据库文件 */
  readonly dbPath: string;
  /** 凭据文件（不进 git、不进日志；V0.1 不加密，见设计稿 §4） */
  readonly secretsPath: string;
  /** 项目共享目录的父目录：<projectsDir>/<projectId>/shared */
  readonly projectsDir: string;
  readonly logsDir: string;
  /** 只绑回环，单用户本机应用（设计稿 §14） */
  readonly host: string;
  readonly port: number;
  /**
   * 额外的可信 `Host` 白名单（`ALKAID_TRUSTED_HOSTS`，逗号分隔）。
   *
   * ★ 只在"绑到非回环地址"时才真的需要：那时浏览器信任围栏
   *   （`server/trust.ts`）除了绑定地址本身，只认这个白名单里的主机名。
   *   典型用法：绑 `0.0.0.0` 用手机访问 `http://192.168.1.5:8787` ——
   *   IP 字面量会被自动认（它就是绑定地址）；但若你用域名（`alkaid.lan`），
   *   就得把它写进这里，否则会被 403。
   */
  readonly trustedHosts: readonly string[];
};

const DEFAULT_PORT = 8787;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawHome = env['ALKAID_HOME']?.trim();
  const home = resolve(rawHome && rawHome.length > 0 ? rawHome : join(homedir(), '.alkaid'));

  const rawPort = env['ALKAID_PORT']?.trim();
  const port = rawPort && rawPort.length > 0 ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ALKAID_PORT 不是合法端口: ${String(rawPort)}`);
  }

  const rawHost = env['ALKAID_HOST']?.trim();
  const trustedHosts = (env['ALKAID_TRUSTED_HOSTS'] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  return {
    home,
    dbPath: join(home, 'alkaid.db'),
    secretsPath: join(home, 'secrets.json'),
    projectsDir: join(home, 'projects'),
    logsDir: join(home, 'logs'),
    host: rawHost && rawHost.length > 0 ? rawHost : '127.0.0.1',
    port,
    trustedHosts,
  };
}

/** 建齐运行期目录。幂等。 */
export function ensureHome(config: Config): void {
  for (const dir of [config.home, config.projectsDir, config.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
