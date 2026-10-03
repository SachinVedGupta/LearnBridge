import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { previewAgentConfig, applyAgentConfig } from '../apps/local-runtime/src/agent-config.mjs';

function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'learnbridge-agent-config-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test('AC01: Codex preview and idempotent apply preserve unrelated project settings', t => {
  const root = fixture(t); mkdirSync(join(root, '.codex')); const path = join(root, '.codex/config.toml');
  const before = 'model = "test-model"\n[mcp_servers.other]\ncommand = "test-command"\n'; writeFileSync(path, before);
  const preview = previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'private'), destination: 'codex' });
  assert.equal(readFileSync(path, 'utf8'), before); assert(preview.content.startsWith(before));
  assert(!preview.content.includes('OPENAI_API_KEY')); assert(!preview.content.includes('bypass'));
  assert(preview.content.includes('enabled_tools')); assert(preview.content.includes('"-i"'));
  assert.equal(applyAgentConfig(preview).verified, true);
  const repeated = previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'private'), destination: 'codex' });
  assert.equal(repeated.content, preview.content); applyAgentConfig(repeated);
  assert.equal(readFileSync(path, 'utf8'), preview.content);
});
test('AC02: Claude config merges only its managed server and rejects foreign collisions', t => {
  const root = fixture(t), path = join(root, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'other', args: ['sample'] } }, extra: 7 }));
  let preview = previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'data'), destination: 'claude' }); applyAgentConfig(preview);
  const json = JSON.parse(readFileSync(path)); assert.deepEqual(json.mcpServers.other, { command: 'other', args: ['sample'] }); assert.equal(json.extra, 7);
  assert.equal(json.mcpServers.learnbridge.type, 'stdio'); assert.equal(json.mcpServers.learnbridge.args[0], '-i');
  preview = previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'data'), destination: 'claude' }); applyAgentConfig(preview);
  writeFileSync(path, JSON.stringify({ mcpServers: { learnbridge: { command: 'foreign' } } }));
  assert.throws(() => previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'data'), destination: 'claude' }), /unmanaged/);
});
test('AC03: stale previews, malformed config, symlinked parents and unmanaged TOML fail without overwriting', t => {
  const root = fixture(t), path = join(root, '.mcp.json');
  const preview = previewAgentConfig({ projectRoot: root, dataRoot: join(root, 'data'), destination: 'claude' });
  writeFileSync(path, '{"unrelated":1}'); assert.throws(() => applyAgentConfig(preview), /changed/); assert.equal(readFileSync(path, 'utf8'), '{"unrelated":1}');
  writeFileSync(path, '{invalid'); assert.throws(() => previewAgentConfig({ projectRoot: root, dataRoot: root, destination: 'claude' }), /valid JSON/);
  mkdirSync(join(root, 'other')); symlinkSync(join(root, 'other'), join(root, '.codex'));
  assert.throws(() => previewAgentConfig({ projectRoot: root, dataRoot: root, destination: 'codex' }), /unsafe/);
  rmSync(join(root, '.codex')); mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/config.toml'), '[mcp_servers."learnbridge"]\ncommand = "foreign"\n');
  assert.throws(() => previewAgentConfig({ projectRoot: root, dataRoot: root, destination: 'codex' }), /unmanaged/);
  const inline = '[mcp_servers]\n"learnbridge" = { command = "existing-unmanaged-command" }\n';
  writeFileSync(join(root, '.codex/config.toml'), inline);
  assert.throws(() => previewAgentConfig({ projectRoot: root, dataRoot: root, destination: 'codex' }), /unmanaged/);
  assert.equal(readFileSync(join(root, '.codex/config.toml'), 'utf8'), inline);
});
test('AC04: human CLI preview never logs existing unrelated configuration secrets', t => {
  const root = fixture(t), path = join(root, '.mcp.json');
  const original = JSON.stringify({ mcpServers: { other: { command: 'other', env: { API_KEY: 'SYNTHETIC_UNRELATED_SECRET_CANARY' } } } });
  writeFileSync(path, original);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../apps/local-runtime/src/cli.mjs', import.meta.url)), 'agent-config', '--destination', 'claude', '--project-root', root, '--data-root', join(root, 'data')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(child.status, 0); assert(!child.stdout.includes('SYNTHETIC_UNRELATED_SECRET_CANARY')); assert(!child.stderr.includes('SYNTHETIC_UNRELATED_SECRET_CANARY'));
  const preview = JSON.parse(child.stdout); assert.equal(preview.content, undefined); assert(preview.managed_content.includes('learnbridge'));
  assert.equal(readFileSync(path, 'utf8'), original);
});
