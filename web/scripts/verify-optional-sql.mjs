/** Disposable PostgreSQL/WASM check only. No project dependency, global install,
 * personal config, cloud account or production data is used.
 * Run explicitly: node web/scripts/verify-optional-sql.mjs --install-runtime
 * Official runtime/extension docs: https://pglite.dev/docs/ and
 * https://pglite.dev/extensions/ (pgcrypto and pgtap).
 * This single-session synthetic auth fixture is NOT live Supabase proof.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REMOTE_VERSION, remoteHash, parseRemoteStudyRequest } from '../packages/core/src/remote-companion.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME = Object.freeze({ pglite: '0.5.8', pgtap: '0.0.9' });
const migrations = ['202610020001_student_workspace.sql', '202610030002_adoption_metrics.sql', '202610030003_remote_companion_foundation.sql'];
const fixtures = ['student_isolation.sql', 'adoption_isolation.sql', 'adoption_bounds.sql', 'remote_companion_isolation.sql'];
const hash = value => createHash('sha256').update(value).digest('hex');
const bootstrap = `
create schema auth;
create schema extensions;
create role anon nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role authenticated nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role service_role nologin nosuperuser nocreatedb nocreaterole noinherit bypassrls;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
create table auth.users (
 id uuid primary key, email text, email_confirmed_at timestamptz,
 raw_user_meta_data jsonb not null default '{}'::jsonb
);
-- Synthetic stand-in only. The harness does not implement GoTrue or JWT signing.
create table auth.sessions (
 id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 not_after timestamptz, created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
 (nullif(current_setting('request.jwt.claims',true),'')::jsonb)->>'sub')::uuid;
$$;
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb);
$$;
revoke all on auth.users,auth.sessions from public,anon,authenticated;
grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
`;

async function main() {
  const args = process.argv.slice(2), adoptionOnly = args.includes('--adoption-only');
  if (!args.includes('--install-runtime') || args.some(arg => !['--install-runtime', '--adoption-only'].includes(arg)) || new Set(args).size !== args.length) {
    console.error('Explicit test-only runtime opt-in required: node web/scripts/verify-optional-sql.mjs --install-runtime [--adoption-only]');
    process.exitCode = 2; return;
  }
  const temporary = await mkdtemp(join(tmpdir(), 'learnbridge-sql-verification-'));
  let db;
  const evidence = { schema_version: 1, verified_at: new Date().toISOString(), runtime: RUNTIME, postgres_version: null, suite: adoptionOnly ? 'student_and_adoption' : 'student_adoption_remote',
    scope: 'disposable_single_session_postgresql_wasm_synthetic_auth', production_configuration_changed: false,
    live_supabase_verified: false, concurrent_sessions_verified: false, real_jwt_session_revocation_verified: false,
    deployed_retention_scheduler_verified: false, migrations: [], fixtures: [], protocol_hash_checks: [], status: 'failed' };
  try {
    await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    await writeFile(join(temporary, 'user.npmrc'), '', { mode: 0o600 });
    await writeFile(join(temporary, 'global.npmrc'), '', { mode: 0o600 });
    // Explicit config/cache/prefix plus a narrow environment keep npm away from
    // personal project/account configuration. Package lifecycle scripts are off.
    await promisify(execFile)('npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
      '--registry=https://registry.npmjs.org', `--userconfig=${join(temporary, 'user.npmrc')}`, `--globalconfig=${join(temporary, 'global.npmrc')}`,
      `--cache=${join(temporary, 'cache')}`, `@electric-sql/pglite@${RUNTIME.pglite}`, `@electric-sql/pglite-pgtap@${RUNTIME.pgtap}`],
    { cwd: temporary, env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: temporary }, timeout: 60000, maxBuffer: 65536 });
    const runtimeRequire = createRequire(join(temporary, 'package.json'));
    const { PGlite } = runtimeRequire('@electric-sql/pglite');
    const { pgcrypto } = runtimeRequire('@electric-sql/pglite/contrib/pgcrypto');
    const { pgtap } = runtimeRequire('@electric-sql/pglite-pgtap');
    db = await PGlite.create({ extensions: { pgcrypto, pgtap } });
    evidence.postgres_version = (await db.query('select version() as version')).rows[0].version;
    await db.exec(bootstrap);
    await db.exec('create extension pgcrypto with schema extensions; create extension pgtap with schema extensions;');
    for (const name of migrations.filter(name => !adoptionOnly || !name.includes('remote_companion'))) {
      const sql = await readFile(join(ROOT, 'supabase/migrations', name), 'utf8');
      const result = { name, sha256: hash(sql), status: 'failed' }; evidence.migrations.push(result);
      await db.exec(sql); result.status = 'passed';
    }
    for (const name of fixtures.filter(name => !adoptionOnly || !name.includes('remote_companion'))) {
      const sql = await readFile(join(ROOT, 'supabase/tests', name), 'utf8');
      const result = { name, sha256: hash(sql), assertions: 0, status: 'failed', tap: [] }; evidence.fixtures.push(result);
      const outputs = await db.exec(sql), tap = outputs.flatMap(output => output.rows ?? []).filter(row => typeof row.result === 'string').map(row => row.result);
      result.tap = tap; const plan = tap.find(line => /^1\.\.\d+$/.test(line));
      assert(plan, `${name}: missing pgTAP plan`); result.assertions = Number(plan.slice(3));
      const assertions = tap.filter(line => /^(?:not )?ok \d+/.test(line));
      assert.equal(assertions.length, result.assertions, `${name}: assertion count differs from plan`);
      assert(!tap.some(line => /^not ok|^# Looks like/.test(line)), `${name}: pgTAP failure`);
      // Every fixture is rollback-only, including its temporary test records.
      assert.equal((await db.query('select count(*)::integer as count from auth.users')).rows[0].count, 0, `${name}: rollback left synthetic users`);
      result.status = 'passed';
    }
    if (!adoptionOnly) for (const [name, prompt] of Object.entries({ ascii: 'Synthetic student context', quoting: 'Quotes " and backslash \\', whitespace: 'Line\nand\ttab', unicode: 'Emoji 🧠 and café', separator: 'Unicode separator\u2028end' })) {
      const request = parseRemoteStudyRequest({ schema_version: 1, binding_id: '11111111-1111-4111-8111-111111111111', client_request_id: '22222222-2222-4222-8222-222222222222', recipe_id: 'study.explain', recipe_version: REMOTE_VERSION, prompt });
      const expected = remoteHash(request), observed = (await db.query('select public.remote_study_hash($1::jsonb) as hash', [JSON.stringify(request)])).rows[0].hash;
      evidence.protocol_hash_checks.push({ name, expected_sha256: expected, observed_sha256: observed, status: expected === observed ? 'passed' : 'failed' });
      assert.equal(observed, expected, `Cross-runtime canonical request hash differs for ${name}`);
    }
    evidence.status = 'passed';
  } catch (error) {
    evidence.failure = { code: typeof error.code === 'string' ? error.code : 'TEST_RUNTIME_ERROR', message: String(error.message).slice(0, 500) };
    process.exitCode = 1;
  } finally {
    if (db) await db.close();
    await rm(temporary, { recursive: true, force: true });
    await mkdir(join(ROOT, 'artifacts'), { recursive: true });
    await writeFile(join(ROOT, 'artifacts/optional-sql-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  }
  console.log(JSON.stringify({ status: evidence.status, migrations: evidence.migrations.map(({ name, status }) => ({ name, status })),
    fixtures: evidence.fixtures.map(({ name, status, assertions }) => ({ name, status, assertions })), failure: evidence.failure,
    evidence: 'artifacts/optional-sql-verification.json', live_supabase_verified: false, concurrent_sessions_verified: false }));
}
await main();
