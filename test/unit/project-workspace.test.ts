import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { ensureHome, loadConfig, type Config } from '../../src/config.ts';
import { createProject } from '../../src/core/project/service.ts';
import { listWorkspaces } from '../../src/core/store/repo.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { WorkspaceError, registerWorkspace } from '../../src/core/workspace/service.ts';

function withEnv(run: (ctx: { db: DatabaseSync; config: Config; home: string }) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-pw-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  try {
    run({ db, config, home });
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('创建项目会在数据根下建出 shared 目录，且行里的路径就是那个目录', () => {
  withEnv(({ db, config }) => {
    const project = createProject(db, config, { name: '测试项目' });

    assert.ok(existsSync(project.sharedDir), `共享目录没建出来：${project.sharedDir}`);
    assert.ok(project.sharedDir.includes(project.id), '共享目录名应包含项目 id');
    assert.ok(project.sharedDir.replaceAll('\\', '/').endsWith('/shared'));
    // 目录必须落在数据根里，而不是项目仓库或用户工作区里
    assert.ok(project.sharedDir.startsWith(config.projectsDir), '共享目录应在数据根的 projects/ 下');
  });
});

test('登记工作区：不存在 / 不是目录 / 重复（含不同写法）都被明确拒绝', () => {
  withEnv(({ db, home }) => {
    assert.throws(
      () => registerWorkspace(db, { name: '不存在', path: join(home, 'nope') }),
      (error: unknown) => error instanceof WorkspaceError && error.code === 'not_found',
    );

    const filePath = join(home, 'a.txt');
    writeFileSync(filePath, 'x', 'utf8');
    assert.throws(
      () => registerWorkspace(db, { name: '是文件', path: filePath }),
      (error: unknown) => error instanceof WorkspaceError && error.code === 'not_directory',
    );

    const dir = join(home, 'work');
    mkdirSync(dir);
    const workspace = registerWorkspace(db, { name: '工作区', path: dir });
    assert.ok(workspace.rootPath.length > 0);

    assert.throws(
      () => registerWorkspace(db, { name: '重复', path: dir }),
      (error: unknown) => error instanceof WorkspaceError && error.code === 'duplicate',
    );
    // 同一个目录换个写法（末尾 `\.`）也必须认出来
    assert.throws(
      () => registerWorkspace(db, { name: '重复写法', path: `${dir}${sep}.` }),
      (error: unknown) => error instanceof WorkspaceError && error.code === 'duplicate',
    );

    assert.equal(listWorkspaces(db).length, 1);
  });
});
