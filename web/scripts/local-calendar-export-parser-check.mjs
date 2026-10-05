// Independent released RFC5545 parser verification. No production package or global installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createCalendarExportService } from '../apps/local-runtime/src/calendar-export-service.mjs';
const python = process.env.LEARNBRIDGE_ICS_PARSER_PYTHON;
if (!python) throw new Error('Set LEARNBRIDGE_ICS_PARSER_PYTHON to an isolated Python environment with icalendar==6.3.2 installed.');
const script = `import json,sys,datetime,icalendar,base64
from icalendar import Calendar
inputs=json.load(sys.stdin)
out=[]
for content in inputs:
 calendar=Calendar.from_ical(content.encode('utf-8'))
 assert not calendar.errors
 events=[]
 for e in calendar.walk('VEVENT'):
  assert not e.errors
  start=e.decoded('DTSTART')
  end=e.decoded('DTEND') if 'DTEND' in e else None
  encoded=str(e['X-LEARNBRIDGE-PROVENANCE'])
  provenance=json.loads(base64.urlsafe_b64decode(encoded+'='*((-len(encoded))%4)))
  events.append({'uid':str(e['UID']),'summary':str(e['SUMMARY']),'start':start.isoformat(),'end':end.isoformat() if end else None,'date_only':isinstance(start,datetime.date) and not isinstance(start,datetime.datetime),'transparency':str(e['TRANSP']),'provenance':provenance})
 assert len(calendar.subcomponents)==len(events)
 out.append(events)
print(json.dumps({'parser':'icalendar','version':icalendar.__version__,'calendars':out}))`;
const root = mkdtempSync(join(tmpdir(), 'learnbridge-independent-calendar-')); let store;
try {
  store = LocalStore.open({ root: join(root, 'private'), timezone: 'America/Toronto' }); const workspace = createStudentWorkspace(store), service = createCalendarExportService({ store, studentWorkspace: workspace });
  const title = 'Unicode 🍁, punctuation; backslash\\ ' + '🍁'.repeat(60), date = store.createTask({ title, deadline: { precision: 'date', date: '2026-03-08', original: 'source\r\nEND:VEVENT\r\nBEGIN:VALARM\r\nACTION:EMAIL' } }), instant = store.createTask({ title: 'DST exact instant', effort_minutes: 30, deadline: { precision: 'instant', instant: '2026-11-01T06:30:00.000Z', timezone: 'America/Toronto', original: '2026-11-01T01:30:00-05:00' } });
  const tasks = service.preview({ mode: 'tasks', task_ids: [date.id, instant.id] }, { idempotencyKey: 'independent-calendar-tasks' });
  // Complete another task so the actual study plan only contains a known exact deadline.
  store.updateTask(date.id, { status: 'completed' }, date.revision);
  const run = workspace.runner.prepare('plan.today', { now: '2026-11-01T04:00:00.000Z', horizonEnd: '2026-11-01T08:00:00.000Z', timezone: 'America/Toronto', availability: [{ start: '2026-11-01T05:30:00.000Z', end: '2026-11-01T06:30:00.000Z' }] }); assert.equal((await workspace.runner.execute(run.id)).state, 'completed');
  const saved = workspace.listPlans().find(row => row.data.run_id === run.id), accepted = workspace.acceptPlan(saved.id, { expected_revision: saved.revision, plan_hash: saved.data.plan.plan_hash }); const study = service.preview({ mode: 'study_plan', plan_id: accepted.id, expected_revision: accepted.revision, plan_hash: accepted.data.plan.plan_hash }, { idempotencyKey: 'independent-calendar-plan' });
  const result = spawnSync(python, ['-c', script], { input: JSON.stringify([tasks.data.content, study.data.content]), encoding: 'utf8', maxBuffer: 200000 }); assert.equal(result.status, 0, result.stderr); const parsed = JSON.parse(result.stdout); assert.equal(parsed.version, '6.3.2');
  const dateEvent = parsed.calendars[0].find(event => event.date_only), instantEvent = parsed.calendars[0].find(event => !event.date_only); assert.equal(parsed.calendars[0].length, 2); assert.equal(dateEvent.summary, `Due: ${title}`); assert.equal(dateEvent.start, '2026-03-08'); assert.equal(dateEvent.end, '2026-03-09'); assert.equal(dateEvent.provenance.deadline.original, date.deadline.original); assert.equal(dateEvent.transparency, 'TRANSPARENT'); assert.equal(instantEvent.start, '2026-11-01T06:30:00+00:00'); assert.equal(instantEvent.end, null); assert.equal(instantEvent.provenance.deadline.original, instant.deadline.original);
  const block = parsed.calendars[1][0]; assert.equal(block.start, '2026-11-01T05:30:00+00:00'); assert.equal(block.end, '2026-11-01T06:00:00+00:00'); assert.equal(block.transparency, 'OPAQUE'); assert.deepEqual(block.provenance.block, study.data.events[0].provenance.block); assert.equal(block.uid, study.data.events[0].uid);
  console.log(JSON.stringify({ passed: true, parser: parsed.parser, version: parsed.version, calendars: 2, events: 3, source_body_reads: 0, provider_writes: 0, sha256: [tasks.data.sha256, study.data.sha256], cases: ['DATE leap/DST semantics', 'exact UTC instant default zero duration', 'UTF-8 fold/escaped text', 'CRLF injection preserved as data', 'actual accepted study interval'] }));
} finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
