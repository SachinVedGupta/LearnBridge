import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Documentation validation only. This never starts the app or reads student data.
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const read = (file) => fs.readFileSync(path.join(directory, file), 'utf8');
const index = JSON.parse(read('FEATURE_INDEX.json'));
assert.equal(index.document_kind, 'design_traceability_not_product_results');
assert.equal(index.implementation_tests_executed, false);
assert.equal(index.features.length, 29);
assert.equal(index.work_packages.length, 24);
const features = new Map(index.features.map((feature) => [feature.id, feature]));
assert.equal(features.size, 29, 'Duplicate feature ID');
const packages = new Map(index.work_packages.map((work) => [work.id, work]));
assert.equal(packages.size, 24, 'Duplicate work package ID');
const visiting = new Set();
const visited = new Set();
function visit(id) {
  assert(packages.has(id), `Unknown package ${id}`);
  assert(!visiting.has(id), `Dependency cycle at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of packages.get(id).required_dependencies) visit(dependency);
  for (const dependency of packages.get(id).optional_dependencies) {
    assert(packages.has(dependency), `Unknown optional dependency ${dependency}`);
    assert.notEqual(dependency, id, 'Self dependency');
  }
  visiting.delete(id);
  visited.add(id);
}
for (const id of packages.keys()) visit(id);
const cases = new Set();
for (let n = 1; n <= 29; n++) {
  const id = `F${String(n).padStart(2, '0')}`;
  const feature = features.get(id);
  assert(feature, `Missing ${id}`);
  assert.equal(feature.status, 'SPECIFIED_NOT_IMPLEMENTATION_EVIDENCE');
  const text = read(feature.specification);
  assert(new RegExp(`^## ${id}\\b`, 'm').test(text), `Missing specification heading ${id}`);
  assert(feature.acceptance_ids.length > 0, `No acceptance cases for ${id}`);
  const definitions = id === 'F03' ? read('ONBOARDING.md') : text;
  for (const acceptance of feature.acceptance_ids) {
    assert(acceptance.startsWith(`${id}-A`), `Wrong feature in ${acceptance}`);
    assert(!cases.has(acceptance), `Duplicate acceptance ${acceptance}`);
    assert(definitions.includes(acceptance), `Missing ${acceptance} definition`);
    cases.add(acceptance);
  }
  const actualIds = new Set(definitions.match(new RegExp(`${id}-A\\d{2}`, 'g')) || []);
  assert.deepEqual([...actualIds].sort(), [...feature.acceptance_ids].sort(), `Traceability mismatch ${id}`);
  for (const work of feature.implementation_packages) assert(packages.has(work), `Unknown work ${work}`);
}
const markdownFiles = fs.readdirSync(directory).filter((name) => name.endsWith('.md'))
  .map((name) => path.join(directory, name));
markdownFiles.push(path.join(root, 'SETUP_LEARNBRIDGE.md'), path.join(root, 'README.md'),
  path.join(root, 'docs/LOCAL_FIRST_VISION.md'));
const headingCache = new Map();
function anchors(file) {
  if (headingCache.has(file)) return headingCache.get(file);
  const counts = new Map();
  const result = new Set();
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/[`*_]/g, '')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    result.add(count ? `${base}-${count}` : base);
    counts.set(base, count + 1);
  }
  headingCache.set(file, result);
  return result;
}
let checkedLinks = 0;
for (const file of markdownFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const fences = text.match(/^\s*```/gm) || [];
  assert.equal(fences.length % 2, 0, `Unbalanced code fence ${file}`);
  for (const match of text.matchAll(/!?\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const destination = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
    assert(fs.existsSync(destination), `Missing link in ${path.basename(file)}: ${target}`);
    if (fragment && destination.endsWith('.md')) {
      assert(anchors(destination).has(fragment), `Missing anchor in ${path.basename(file)}: ${target}`);
    }
    checkedLinks++;
  }
}
const examples = fs.readdirSync(path.join(directory, 'examples')).filter((file) => file.endsWith('.json'));
for (const file of examples) JSON.parse(read(`examples/${file}`));
const consent = JSON.parse(read('examples/onboarding-consent.example.json'));
assert.equal(consent.productionAccessAllowed, false);
assert.equal(consent.runtimeImplemented, false);
assert.deepEqual([...consent.fixtureAssertions.acceptanceIds].sort(), [...features.get('F03').acceptance_ids].sort());
const workflow = JSON.parse(read('examples/workflow.example.json'));
assert.equal(workflow.production_access_allowed, false);
assert.equal(workflow.runtime_implemented, false);
for (const step of workflow.steps) {
  if (step.execution_surface === 'human_ui_only') continue;
  assert(workflow.required_capabilities.includes(step.operation), `Undeclared operation ${step.operation}`);
}
const report = JSON.parse(read('examples/verification-report.example.json'));
assert.equal(report.execution.performed, false);
assert.equal(report.release.eligible, false);
assert(report.results.every((result) => result.status !== 'PASS'), 'Example falsely claims product passes');
const diagram = read('learnbridge-architecture.drawio');
assert(diagram.includes('<mxGraphModel') && diagram.includes('n:CORE'), 'Missing diagram graph');
assert(!diagram.includes('<!--'), 'Unexpected XML comment');
console.log(JSON.stringify({status: 'PASS', scope: 'documentation_only', features: features.size,
  acceptanceCases: cases.size, workPackages: packages.size, localLinks: checkedLinks,
  syntheticExamples: examples.length, productTestsExecuted: false}, null, 2));
