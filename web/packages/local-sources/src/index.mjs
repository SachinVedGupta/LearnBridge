import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { LearnBridgeError, invalidInput } from '@learnbridge/core';
import { PDF_LIMITS, PDF_PARSER_VERSION, nativePdfPrerequisites, runNativePdf, runNativePdfPage } from './pdf-native.mjs';
import { OFFICE_LIMITS, OFFICE_PARSER_VERSION, officePrerequisites, runOfficeParser } from './office-native.mjs';

export { PDF_LIMITS, PDF_PARSER_VERSION } from './pdf-native.mjs';
export { OFFICE_LIMITS, OFFICE_PARSER_VERSION } from './office-native.mjs';

export const SOURCE_ADAPTER_VERSION = '0.1.0';
export const SOURCE_LIMITS = Object.freeze({ maxEntries: 500, maxFiles: 100, maxDepth: 8, maxBytes: 256_000, maxDurationMs: 5000 });
const PYTHON = fileURLToPath(new URL('../../../../.venv/bin/python3', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,24})$/;
const COUNT_KEYS = ['entriesVisited', 'directoriesVisited', 'eligibleFiles', 'excludedEntries', 'totalBytes'];
const EXCLUSION_KEYS = ['secret', 'symlink', 'special', 'unsupportedType', 'hardlink', 'depth', 'permission', 'changed'];
const REASONS = ['entry_limit', 'file_limit', 'depth_limit', 'permission_denied', 'source_changed', 'cancelled', 'time_limit'];
const DENIED_COMPONENTS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.codex', '.claude', '.agents', '.config', '.local',
  'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'library', 'appdata', 'system', 'applications', 'browser_profiles', 'vault']);
const SECRET_NAME = /(^|[._ -])(keys?|tokens?|credentials?|secrets?|passwords?|cookies?|sessions?)([._ -]|$)/i;
const fail = (code, next_action = null) => { throw new LearnBridgeError(code, { next_action }); };
function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)
    || required.some(key => !Object.hasOwn(value, key))) invalidInput();
  return value;
}
function string(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) invalidInput();
  return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalidInput();
  return value;
}
function decimal(value) { if (typeof value !== 'string' || !DECIMAL.test(value)) invalidInput(); return value; }
function sha(value) { if (typeof value !== 'string' || !SHA.test(value)) invalidInput(); return value; }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalidInput(); return value.toLowerCase(); }
function array(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) invalidInput();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) if (!properties[index] || !('value' in properties[index])) invalidInput();
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function excludedName(value) {
  return value.startsWith('.') || DENIED_COMPONENTS.has(value.toLowerCase()) || SECRET_NAME.test(value)
    || /\.(pem|key|p12|pfx|keystore|keychain|sqlite|sqlite3|db)$/i.test(value);
}
function relativePath(value, { directory = false } = {}) {
  string(value, 1024, directory);
  if (directory && value === '') return value;
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || excludedName(part))) invalidInput();
  return value;
}
function lexicalRoot(value) {
  string(value, 4096);
  if (!isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) invalidInput();
  return resolve(value);
}
async function approvedRootPath(value) {
  const supplied = lexicalRoot(value);
  let initial;
  try { initial = await lstat(supplied); } catch { fail('SCOPE_DENIED', 'review_scope'); }
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail('SCOPE_DENIED', 'review_scope');
  let root;
  try { root = await realpath(supplied); } catch { fail('SCOPE_DENIED', 'review_scope'); }
  lexicalRoot(root);
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  const temp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const forbidden = new Set(['/', '/Users', '/home', '/root', '/private', '/var', '/private/var', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', home, temp]);
  if (forbidden.has(root) || root.split('/').filter(Boolean).some(excludedName)
    || ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev', '/proc', '/sys', '/run', '/boot', '/opt'].some(path => root === path || root.startsWith(path + '/'))
    || ((root.startsWith('/Users/') || root.startsWith('/home/')) && !root.startsWith(home + '/'))) fail('SCOPE_DENIED', 'review_scope');
  return root;
}
function rootIdentity(value) {
  object(value, ['dev', 'ino']); return { dev: decimal(value.dev), ino: decimal(value.ino) };
}
function directoryIdentity(value) {
  object(value, ['dev', 'ino', 'mtimeNs', 'ctimeNs']);
  return { ...rootIdentity({ dev: value.dev, ino: value.ino }), mtimeNs: decimal(value.mtimeNs), ctimeNs: decimal(value.ctimeNs) };
}
function snapshot(value) {
  object(value, ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'version']);
  const result = { ...directoryIdentity({ dev: value.dev, ino: value.ino, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs }),
    size: integer(value.size), nlink: integer(value.nlink, 1, 1) };
  if (sha(value.version) !== digest(result)) fail('VERSION_MISMATCH', 'refresh');
  return { ...result, version: value.version };
}
function descriptor(value) {
  object(value, ['schema_version', 'kind', 'root', 'label', 'identity', 'version']);
  if (value.schema_version !== 1 || value.kind !== 'local-directory') invalidInput();
  const result = { schema_version: 1, kind: 'local-directory', root: lexicalRoot(value.root), label: string(value.label, 128), identity: rootIdentity(value.identity) };
  if (sha(value.version) !== digest({ schema_version: result.schema_version, kind: result.kind, root: result.root, identity: result.identity })) fail('VERSION_MISMATCH', 'refresh');
  return result;
}
function stableEntryId(sourceVersion, path, identity) {
  const bytes = Buffer.from(digest({ sourceVersion, path, identity }), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function entry(value, source) {
  object(value, ['id', 'relativePath', 'kind', 'title', 'snapshot', 'directories']);
  const path = relativePath(value.relativePath);
  const expectedKind = /\.md$/i.test(path) ? 'markdown' : /\.txt$/i.test(path) ? 'text' : /\.pdf$/i.test(path) ? 'pdf'
    : /\.docx$/i.test(path) ? 'docx' : /\.pptx$/i.test(path) ? 'pptx' : null;
  if (!expectedKind || value.kind !== expectedKind || value.title !== basename(path)) invalidInput();
  const file = snapshot(value.snapshot);
  const dirs = array(value.directories, 9).map(item => { object(item, ['relativePath', 'identity']); return { relativePath: relativePath(item.relativePath, { directory: true }), identity: directoryIdentity(item.identity) }; });
  const components = path.split('/');
  if (dirs.length !== components.length || dirs.some((item, index) => item.relativePath !== components.slice(0, index).join('/'))
    || dirs[0].identity.dev !== source.identity.dev || dirs[0].identity.ino !== source.identity.ino) invalidInput();
  const result = { id: uuid(value.id), relativePath: path, kind: expectedKind, title: string(value.title, 1024), snapshot: file, directories: dirs };
  if (result.id !== stableEntryId(source.version, path, { dev: file.dev, ino: file.ino })) fail('VERSION_MISMATCH', 'refresh');
  return result;
}
function budget(value) {
  object(value, ['maxEntries', 'maxFiles', 'maxDepth']);
  return { maxEntries: integer(value.maxEntries, SOURCE_LIMITS.maxEntries, 1), maxFiles: integer(value.maxFiles, SOURCE_LIMITS.maxFiles, 1), maxDepth: integer(value.maxDepth, SOURCE_LIMITS.maxDepth) };
}
function inventoryVersion(value) {
  return digest({ schema_version: value.schema_version, source_version: value.source_version, entries: value.entries,
    counts: value.counts, coverage: value.coverage, exclusions: value.exclusions, budget: value.budget });
}
function validateInventory(value, source) {
  object(value, ['schema_version', 'id', 'source_version', 'version', 'entries', 'counts', 'coverage', 'exclusions', 'budget', 'retrieved_at']);
  if (value.schema_version !== 1 || value.source_version !== source.version) fail('VERSION_MISMATCH', 'refresh');
  const limits = budget(value.budget);
  const entries = array(value.entries, limits.maxFiles).map(item => entry(item, source));
  if (new Set(entries.map(item => item.id)).size !== entries.length || new Set(entries.map(item => item.relativePath)).size !== entries.length) invalidInput();
  object(value.counts, COUNT_KEYS); const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, integer(value.counts[key])]));
  object(value.exclusions, EXCLUSION_KEYS); const exclusions = Object.fromEntries(EXCLUSION_KEYS.map(key => [key, integer(value.exclusions[key], limits.maxEntries)]));
  object(value.coverage, ['state', 'reasons']);
  if (!['complete', 'partial', 'cancelled', 'blocked'].includes(value.coverage.state)) invalidInput();
  const reasons = array(value.coverage.reasons, REASONS.length).map(reason => { if (!REASONS.includes(reason)) invalidInput(); return reason; });
  if (new Set(reasons).size !== reasons.length || (value.coverage.state === 'complete' && reasons.length)
    || counts.eligibleFiles !== entries.length || counts.entriesVisited > limits.maxEntries
    || counts.totalBytes !== entries.reduce((sum, item) => sum + item.snapshot.size, 0)
    || counts.excludedEntries !== Object.values(exclusions).reduce((sum, count) => sum + count, 0)
    || counts.eligibleFiles + counts.excludedEntries > counts.entriesVisited
    || counts.directoriesVisited > counts.entriesVisited + 1) invalidInput();
  const retrievedAt = string(value.retrieved_at, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(retrievedAt)) invalidInput();
  try { if (new Date(retrievedAt).toISOString() !== retrievedAt) invalidInput(); } catch { invalidInput(); }
  const result = { schema_version: 1, id: uuid(value.id), source_version: source.version, entries,
    counts, coverage: { state: value.coverage.state, reasons }, exclusions, budget: limits, retrieved_at: retrievedAt };
  if (sha(value.version) !== inventoryVersion(result)) fail('VERSION_MISMATCH', 'refresh');
  return result;
}

// The isolated stdlib worker is deliberately fixed code. It runs no selected
// script, shell, macro, dependency hook or user-supplied executable. os.open's
// dir_fd anchors each child lookup to a directory descriptor; every component
// uses O_NOFOLLOW. There is intentionally no path-based Node read fallback.
const WORKER = String.raw`
import os, sys, json, stat, hashlib, re, base64

class Refused(Exception):
    def __init__(self, code): self.code = code

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',',':'))+'\n'); sys.stdout.flush()

request = json.loads(sys.stdin.readline(1000001))
if not (os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd and os.scandir in os.supports_fd and hasattr(os,'O_NOFOLLOW') and hasattr(os,'O_DIRECTORY')):
    emit({'event':'result','ok':False,'code':'UNSUPPORTED'}); sys.exit(0)
FOLDER = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | getattr(os,'O_NONBLOCK',0)
SECRET = re.compile(r'(^|[._ -])(keys?|tokens?|credentials?|secrets?|passwords?|cookies?|sessions?)([._ -]|$)',re.I)
DENIED = set(['.git','.ssh','.gnupg','.aws','.azure','.codex','.claude','.agents','.config','.local','node_modules','.venv','venv','__pycache__','dist','build','library','appdata','system','applications','browser_profiles','vault'])

def checkpoint(name, payload=None):
    if request.get('testMode'):
        emit({'event':'phase','phase':name,'payload':payload or {}})
        if sys.stdin.readline(100) != 'continue\n': raise Refused('CANCELLED')

def body_observation(st, size):
    if request.get('testMode'):
        emit({'event':'body_read','payload':{'dev':str(st.st_dev),'ino':str(st.st_ino),'bytes':size}})
        if sys.stdin.readline(100) != 'continue\n': raise Refused('CANCELLED')

def canonical_hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()

def identity(st):
    return {'dev':str(st.st_dev),'ino':str(st.st_ino)}

def directory(st):
    return dict(identity(st),mtimeNs=str(st.st_mtime_ns),ctimeNs=str(st.st_ctime_ns))

def snapshot(st):
    value=dict(directory(st),size=st.st_size,nlink=st.st_nlink)
    return dict(value,version=canonical_hash(value))

def same(st, expected, folder=False):
    if (folder and not stat.S_ISDIR(st.st_mode)) or (not folder and not stat.S_ISREG(st.st_mode)): return False
    observed=directory(st) if folder else snapshot(st)
    return observed==expected

def root_fd(source, with_hook=True):
    root=source['root']
    parts=root.split('/')[1:]
    if not root.startswith('/') or any(not part or part in ['.','..'] for part in parts): raise Refused('INVALID_INPUT')
    fd=os.open('/',FOLDER)
    try:
        for part in parts:
            following=os.open(part,FOLDER,dir_fd=fd); os.close(fd); fd=following
        if identity(os.fstat(fd))!=source['identity']: raise Refused('VERSION_MISMATCH')
        if with_hook: checkpoint('after_root_open',{'identity':identity(os.fstat(fd))})
        return fd
    except:
        os.close(fd); raise

def validate_chain(source, chosen):
    fd=root_fd(source,False)
    try:
        for index, pinned in enumerate(chosen['directories']):
            if index:
                name=pinned['relativePath'].split('/')[-1]
                following=os.open(name,FOLDER,dir_fd=fd); os.close(fd); fd=following
            if not same(os.fstat(fd),pinned['identity'],True): raise Refused('VERSION_MISMATCH')
        # Compare the current no-follow directory entry too. An old open handle
        # must not justify reading a file that has moved out of selected scope.
        leaf=chosen['relativePath'].split('/')[-1]
        current=os.stat(leaf,dir_fd=fd,follow_symlinks=False)
        if not same(current,chosen['snapshot']): raise Refused('VERSION_MISMATCH')
    finally: os.close(fd)

def blocked(name):
    return name.startswith('.') or name.lower() in DENIED or SECRET.search(name) or re.search(r'\.(pem|key|p12|pfx|keystore|keychain|sqlite|sqlite3|db)$',name,re.I)

def safe_name(name):
    return bool(name) and len(name)<=255 and '\\' not in name and all(ord(ch)>=32 and ord(ch)!=127 and not 0xD800<=ord(ch)<=0xDFFF for ch in name)

def inventory(source, limits):
    entries=[]
    counts={'entriesVisited':0,'directoriesVisited':0,'eligibleFiles':0,'excludedEntries':0,'totalBytes':0}
    exclusions={key:0 for key in ['secret','symlink','special','unsupportedType','hardlink','depth','permission','changed']}
    reasons=set()
    def progress(chosen=None):
        emit({'event':'progress','counts':counts,'exclusions':exclusions,'reasons':sorted(reasons),'entry':chosen})
    def exclude(category,reason=None):
        exclusions[category]+=1; counts['excludedEntries']+=1
        if reason: reasons.add(reason)
        progress()
    def walk(fd,path,chain,depth):
        counts['directoriesVisited']+=1
        names=[]
        with os.scandir(fd) as stream:
            while counts['entriesVisited']<limits['maxEntries']:
                try: candidate=next(stream)
                except StopIteration: break
                counts['entriesVisited']+=1; names.append(candidate.name)
            if counts['entriesVisited']>=limits['maxEntries']: reasons.add('entry_limit')
        progress()
        for name in sorted(names):
            if counts['eligibleFiles']>=limits['maxFiles']: reasons.add('file_limit'); return
            checkpoint('inventory_entry',{'relativePath':(path+'/' if path else '')+name})
            if blocked(name): exclude('secret'); continue
            if not safe_name(name): exclude('unsupportedType'); continue
            try: st=os.stat(name,dir_fd=fd,follow_symlinks=False)
            except PermissionError: exclude('permission','permission_denied'); continue
            except FileNotFoundError: exclude('changed','source_changed'); continue
            relative=(path+'/' if path else '')+name
            if len(relative)>1024: exclude('unsupportedType'); continue
            if stat.S_ISLNK(st.st_mode): exclude('symlink'); continue
            if stat.S_ISDIR(st.st_mode):
                if depth>=limits['maxDepth']: exclude('depth','depth_limit'); continue
                checkpoint('before_directory_open',{'relativePath':relative})
                try: child=os.open(name,FOLDER,dir_fd=fd)
                except PermissionError: exclude('permission','permission_denied'); continue
                except OSError: exclude('changed','source_changed'); continue
                try:
                    if not same(os.fstat(child),directory(st),True): exclude('changed','source_changed'); continue
                    child_chain=chain+[{'relativePath':relative,'identity':directory(os.fstat(child))}]
                    checkpoint('after_directory_open',{'relativePath':relative})
                    walk(child,relative,child_chain,depth+1)
                finally: os.close(child)
                continue
            if not stat.S_ISREG(st.st_mode): exclude('special'); continue
            if not re.search(r'\.(txt|md|pdf|docx|pptx)$',name,re.I): exclude('unsupportedType'); continue
            if st.st_nlink!=1: exclude('hardlink'); continue
            if st.st_size<0 or st.st_size>1000000000000: exclude('unsupportedType'); continue
            kind='markdown' if name.lower().endswith('.md') else name.lower().rsplit('.',1)[-1] if name.lower().endswith(('.pdf','.docx','.pptx')) else 'text'
            if kind in ('pdf','docx','pptx') and st.st_size>4000000: exclude('unsupportedType'); continue
            chosen={'relativePath':relative,'kind':kind,'title':name,'snapshot':snapshot(st),'directories':chain}
            entries.append(chosen); counts['eligibleFiles']+=1; counts['totalBytes']+=st.st_size; progress(chosen)
    fd=root_fd(source)
    try:
        root_snapshot=directory(os.fstat(fd))
        walk(fd,'',[{'relativePath':'','identity':root_snapshot}],0)
        if counts['eligibleFiles']>=limits['maxFiles']: reasons.add('file_limit')
        current=root_fd(source,False)
        try:
            if not same(os.fstat(current),root_snapshot,True): reasons.add('source_changed')
        finally: os.close(current)
        if reasons: state='partial'
        else: state='complete'
        return {'entries':entries,'counts':counts,'exclusions':exclusions,'coverage':{'state':state,'reasons':sorted(reasons)}}
    finally: os.close(fd)

def read_entry(source,chosen,max_bytes,binary=False):
    root=root_fd(source)
    held=[root]
    fd=None
    try:
        for index,pinned in enumerate(chosen['directories']):
            if index:
                checkpoint('before_directory_open',{'relativePath':pinned['relativePath']})
                name=pinned['relativePath'].split('/')[-1]
                held.append(os.open(name,FOLDER,dir_fd=held[-1]))
                checkpoint('after_directory_open',{'relativePath':pinned['relativePath']})
            if not same(os.fstat(held[-1]),pinned['identity'],True): raise Refused('VERSION_MISMATCH')
        checkpoint('before_file_open',{'relativePath':chosen['relativePath']})
        leaf=chosen['relativePath'].split('/')[-1]
        fd=os.open(leaf,FILE,dir_fd=held[-1])
        checkpoint('after_file_open',{'relativePath':chosen['relativePath'],'identity':identity(os.fstat(fd))})
        if not same(os.fstat(fd),chosen['snapshot']) or os.fstat(fd).st_nlink!=1: raise Refused('VERSION_MISMATCH')
        if chosen['snapshot']['size']>max_bytes: raise Refused('BUDGET_EXCEEDED')
        checkpoint('before_body_read',{'relativePath':chosen['relativePath']})
        validate_chain(source,chosen)
        if not same(os.fstat(fd),chosen['snapshot']): raise Refused('VERSION_MISMATCH')
        chunks=[]; size=0
        while True:
            current=os.fstat(fd)
            if not same(current,chosen['snapshot']): raise Refused('VERSION_MISMATCH')
            data=os.read(fd,min(65536,max_bytes-size+1))
            body_observation(current,len(data))
            size+=len(data)
            if size>max_bytes: raise Refused('BUDGET_EXCEEDED')
            if not same(os.fstat(fd),chosen['snapshot']): raise Refused('VERSION_MISMATCH')
            if not data: break
            chunks.append(data)
        validate_chain(source,chosen)
        if not same(os.fstat(fd),chosen['snapshot']) or size!=chosen['snapshot']['size']: raise Refused('VERSION_MISMATCH')
        data=b''.join(chunks)
        if binary: return {'base64':base64.b64encode(data).decode('ascii'),'source_sha256':hashlib.sha256(data).hexdigest(),'source_bytes':size,'version':chosen['snapshot']['version'],'title':chosen['title']}
        try: text=data.decode('utf-8','strict')
        except UnicodeDecodeError: raise Refused('UNSUPPORTED')
        if '\x00' in text: raise Refused('UNSUPPORTED')
        return {'text':text,'sha256':hashlib.sha256(data).hexdigest(),'version':chosen['snapshot']['version'],'title':chosen['title']}
    finally:
        if fd is not None: os.close(fd)
        for item in reversed(held): os.close(item)

try:
    operation=request['operation']
    if operation=='probe': result={'python_version':sys.version.split()[0],'anchored_directory_fd':True,'nofollow_components':True}
    elif operation=='describe':
        source={'root':request['root'],'identity':request['identity']}
        fd=root_fd(source)
        try: result={'identity':identity(os.fstat(fd))}
        finally: os.close(fd)
    elif operation=='inventory': result=inventory(request['descriptor'],request['budget'])
    elif operation=='read': result=read_entry(request['descriptor'],request['entry'],request['maxBytes'])
    elif operation in ('read_pdf','read_office'): result=read_entry(request['descriptor'],request['entry'],request['maxBytes'],True)
    elif operation=='verify':
        validate_chain(request['descriptor'],request['entry'])
        result={'version':request['entry']['snapshot']['version']}
    else: raise Refused('INVALID_INPUT')
    emit({'event':'result','ok':True,'result':result})
except Refused as error: emit({'event':'result','ok':False,'code':error.code})
except PermissionError: emit({'event':'result','ok':False,'code':'SCOPE_DENIED'})
except (FileNotFoundError,NotADirectoryError): emit({'event':'result','ok':False,'code':'VERSION_MISMATCH'})
except OSError: emit({'event':'result','ok':False,'code':'VERSION_MISMATCH'})
except Exception: emit({'event':'result','ok':False,'code':'PROVIDER_FAILURE'})
`;

function zeroProgress() {
  return { entries: [], counts: Object.fromEntries(COUNT_KEYS.map(key => [key, 0])), exclusions: Object.fromEntries(EXCLUSION_KEYS.map(key => [key, 0])), reasons: [] };
}
function runWorker(request, { signal, hooks = {} } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) return Promise.reject(new LearnBridgeError('UNSUPPORTED'));
  if (signal?.aborted) return Promise.resolve({ interrupted: 'cancelled', progress: zeroProgress() });
  const input = JSON.stringify({ ...request, testMode: Boolean(hooks.onPhase || hooks.onBodyRead) });
  if (Buffer.byteLength(input) > 1_000_000) invalidInput();
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', '-u', '-c', WORKER], { env: { TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let output = '';
    const decoder = new StringDecoder('utf8');
    let total = 0;
    let stderrBytes = 0;
    let result;
    let settled = false;
    let interruption;
    const progress = zeroProgress();
    const stop = reason => { interruption = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('time_limit'), SOURCE_LIMITS.maxDurationMs);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? rejectWorker(error) : resolveWorker(value);
    };
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) stop('worker_failure'); });
    child.on('error', () => finish(new LearnBridgeError('UNSUPPORTED')));
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > (['read_pdf', 'read_office'].includes(request.operation) ? 6_000_000 : 2_000_000)) { stop('worker_failure'); return; }
      output += decoder.write(chunk);
      let boundary;
      while ((boundary = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, boundary); output = output.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch { stop('worker_failure'); return; }
        if (message.event === 'result') result = message;
        else if (message.event === 'progress') {
          progress.counts = message.counts; progress.exclusions = message.exclusions; progress.reasons = message.reasons;
          if (message.entry) progress.entries.push(message.entry);
        } else if (message.event === 'phase' || message.event === 'body_read') {
          const callback = message.event === 'phase' ? hooks.onPhase : hooks.onBodyRead;
          Promise.resolve().then(() => callback?.(message.event === 'phase' ? { phase: message.phase, ...message.payload } : message.payload))
            .then(() => { if (!settled && !interruption) child.stdin.write('continue\n'); })
            .catch(() => stop('worker_failure'));
        } else stop('worker_failure');
      }
    });
    child.on('close', code => {
      if (interruption === 'cancelled' || interruption === 'time_limit') return finish(null, { interrupted: interruption, progress });
      if (interruption || code !== 0 || !result) return finish(new LearnBridgeError('PROVIDER_FAILURE'));
      if (!result.ok) return finish(new LearnBridgeError(['UNSUPPORTED', 'INVALID_INPUT', 'SCOPE_DENIED', 'VERSION_MISMATCH', 'BUDGET_EXCEEDED', 'CANCELLED', 'PROVIDER_FAILURE'].includes(result.code) ? result.code : 'PROVIDER_FAILURE', { next_action: result.code === 'VERSION_MISMATCH' ? 'refresh' : null }));
      if (signal?.aborted) return finish(null, { interrupted: 'cancelled', progress });
      finish(null, { value: result.result });
    });
    child.stdin.write(input + '\n');
  });
}

function signalOption(value) { if (value !== undefined && !(value instanceof AbortSignal)) invalidInput(); return value; }
function nativePdfResult(value, acquired, selected, maxBytes) {
  object(value, ['status', 'parser_version', 'page_count', 'pages']);
  if (!['available', 'text_unavailable', 'encrypted', 'malformed'].includes(value.status)
    || value.parser_version !== PDF_PARSER_VERSION) fail('VERSION_MISMATCH');
  const pageCount = integer(value.page_count, PDF_LIMITS.maxPages);
  const suppliedPages = array(value.pages, PDF_LIMITS.maxPages);
  if (value.status === 'available' && (pageCount < 1 || suppliedPages.length !== pageCount)) fail('VERSION_MISMATCH');
  if (['encrypted', 'malformed'].includes(value.status) && suppliedPages.length) fail('VERSION_MISMATCH');
  let text = '', cursor = 0;
  const pages = suppliedPages.map((page, index) => {
    object(page, ['physical_page', 'printed_label', 'text'], ['physical_page', 'text']);
    if (page.physical_page !== index + 1 || typeof page.text !== 'string' || page.text.includes('\0')) fail('VERSION_MISMATCH');
    const label = page.printed_label === undefined ? null : string(page.printed_label, 128);
    if (label !== null && Buffer.byteLength(label) > 128) fail('VERSION_MISMATCH');
    const header = `${index ? '\n\n' : ''}[PDF page ${page.physical_page}]\n`;
    const start = cursor + Buffer.byteLength(header);
    const end = start + Buffer.byteLength(page.text);
    text += header + page.text; cursor = end;
    if (cursor > maxBytes) fail('BUDGET_EXCEEDED');
    return { physical_page: page.physical_page, printed_label: label, text: page.text,
      sha256: createHash('sha256').update(page.text).digest('hex'), byte_range: { start, end } };
  });
  const readable = pages.filter(page => page.text.trim()).length;
  if ((value.status === 'available') !== (readable > 0)) fail('VERSION_MISMATCH');
  const available = value.status === 'available';
  // Unavailable documents do not expose guessed page text or citation ranges.
  if (!available) text = '';
  const reasons = available ? (readable === pageCount ? [] : ['pages_without_extractable_text'])
    : [value.status === 'text_unavailable' ? 'no_extractable_text' : `${value.status}_document`];
  const pdf = { schema_version: 1, format: 'pdf_text', parser_version: PDF_PARSER_VERSION,
    source_sha256: acquired.source_sha256, source_bytes: acquired.source_bytes, page_count: pageCount,
    pages: available ? pages : [], extraction_status: value.status,
    coverage: { state: available ? (reasons.length ? 'partial' : 'complete') : 'unavailable', reasons } };
  if (Buffer.byteLength(JSON.stringify(pdf)) > PDF_LIMITS.maxMetadataBytes) fail('BUDGET_EXCEEDED');
  const result = { text, sha256: createHash('sha256').update(text).digest('hex'), version: selected.snapshot.version, title: selected.title, pdf };
  if (Buffer.byteLength(JSON.stringify(result)) > PDF_LIMITS.maxResultBytes) fail('BUDGET_EXCEEDED');
  return result;
}
function officeResult(value, acquired, selected, maxBytes) {
  object(value, ['status', 'parser_version', 'document_type', 'section_count', 'sections', 'reasons']);
  if (!['available', 'text_unavailable', 'encrypted', 'malformed', 'unsupported'].includes(value.status)
    || value.parser_version !== OFFICE_PARSER_VERSION || value.document_type !== selected.kind) fail('VERSION_MISMATCH');
  const count = integer(value.section_count, OFFICE_LIMITS.maxSections);
  const sections = array(value.sections, OFFICE_LIMITS.maxSections);
  const reasons = array(value.reasons, 20).map(reason => { if (typeof reason !== 'string' || !/^[a-z_]{1,80}$/.test(reason)) fail('VERSION_MISMATCH'); return reason; });
  if (new Set(reasons).size !== reasons.length || !reasons.length
    || (value.status === 'available' && (count < 1 || sections.length !== count || !reasons.includes('layout_not_preserved')))
    || (value.status !== 'available' && sections.length)) fail('VERSION_MISMATCH');
  const unit = selected.kind === 'docx' ? 'paragraph' : 'slide';
  let text = '', cursor = 0;
  const records = sections.map((content, index) => {
    if (typeof content !== 'string' || content.includes('\0') || /[\ud800-\udfff]/u.test(content)) fail('VERSION_MISMATCH');
    const header = `${index ? '\n\n' : ''}[${selected.kind.toUpperCase()} ${unit} ${index + 1}]\n`;
    const start = cursor + Buffer.byteLength(header), end = start + Buffer.byteLength(content);
    text += header + content; cursor = end;
    if (cursor > maxBytes) fail('BUDGET_EXCEEDED');
    return { position: index + 1, unit, text: content, sha256: createHash('sha256').update(content).digest('hex'), byte_range: { start, end } };
  });
  if ((value.status === 'available') !== records.some(section => section.text.trim())) fail('VERSION_MISMATCH');
  const office = { schema_version: 1, format: 'office_text', parser_version: OFFICE_PARSER_VERSION, document_type: selected.kind,
    source_sha256: acquired.source_sha256, source_bytes: acquired.source_bytes, section_count: count, sections: records,
    extraction_status: value.status, coverage: { state: value.status === 'available' ? 'partial' : 'unavailable', reasons } };
  if (Buffer.byteLength(JSON.stringify(office)) > OFFICE_LIMITS.maxMetadataBytes) fail('BUDGET_EXCEEDED');
  const result = { text, sha256: createHash('sha256').update(text).digest('hex'), version: selected.snapshot.version, title: selected.title, office };
  if (Buffer.byteLength(JSON.stringify(result)) > OFFICE_LIMITS.maxResultBytes) fail('BUDGET_EXCEEDED');
  return result;
}
function assembleInventory(source, limits, raw, interruption) {
  const entries = raw.entries.map(value => ({ id: stableEntryId(source.version, value.relativePath, { dev: value.snapshot.dev, ino: value.snapshot.ino }), ...value }));
  const value = { schema_version: 1, id: randomUUID(), source_version: source.version, entries,
    counts: raw.counts, exclusions: raw.exclusions,
    coverage: interruption ? { state: interruption === 'cancelled' ? 'cancelled' : 'partial', reasons: [...new Set([...raw.reasons, interruption])] } : raw.coverage,
    budget: limits, retrieved_at: new Date().toISOString() };
  value.version = inventoryVersion(value);
  return freeze({ ...validateInventory(value, source), version: value.version });
}
function createAdapter(hooks = {}) {
  return {
    async probeSourceCapability() {
      try {
        const result = await runWorker({ operation: 'probe' });
        if (!result.value?.anchored_directory_fd || !result.value?.nofollow_components) return freeze({ state: 'unsupported', version: SOURCE_ADAPTER_VERSION, reason: 'source_runtime_unavailable' });
        return freeze({ state: 'available', version: SOURCE_ADAPTER_VERSION, platform: process.platform, python_version: result.value.python_version, anchored_directory_fd: true });
      } catch { return freeze({ state: 'unsupported', version: SOURCE_ADAPTER_VERSION, reason: 'source_runtime_unavailable' }); }
    },
    async probePdfCapability(options = {}) {
      object(options, ['verify', 'signal'], []);
      if (options.verify !== undefined && typeof options.verify !== 'boolean') invalidInput();
      const signal = signalOption(options.signal);
      if (signal?.aborted) fail('CANCELLED');
      if (process.platform !== 'darwin') return freeze({ state: 'unsupported', parser_version: PDF_PARSER_VERSION, reason: 'native_pdf_platform_unsupported' });
      try {
        if (!await nativePdfPrerequisites()) fail('UNSUPPORTED');
        if (signal?.aborted) fail('CANCELLED');
        if (options.verify === true) {
          const result = await runNativePdf(null, { signal });
          object(result, ['status', 'parser_version', 'probe']);
          if (result.status !== 'available' || result.parser_version !== PDF_PARSER_VERSION || result.probe !== true) fail('UNSUPPORTED');
        }
        return freeze({ state: 'available', parser_version: PDF_PARSER_VERSION, platform: 'darwin', processing: 'local_text_only', ocr: false,
          verification: options.verify === true ? 'native_probe_passed' : 'prerequisites_only', limits: PDF_LIMITS });
      } catch (value) { if (value?.code === 'CANCELLED') throw value; return freeze({ state: 'unsupported', parser_version: PDF_PARSER_VERSION, reason: 'native_pdf_runtime_unavailable' }); }
    },
    async probeOfficeCapability(options = {}) {
      object(options, [], []);
      const available = await officePrerequisites();
      return freeze(available ? { state: 'available', parser_version: OFFICE_PARSER_VERSION, platform: process.platform,
        processing: 'local_text_only', rendering: false, verification: 'prerequisites_only', limits: OFFICE_LIMITS }
        : { state: 'unsupported', parser_version: OFFICE_PARSER_VERSION, reason: 'office_text_runtime_unavailable' });
    },
    async describeRoot(path, options = {}) {
      object(options, ['label'], []);
      const root = await approvedRootPath(path);
      const stat = await lstat(root, { bigint: true });
      const identity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
      await runWorker({ operation: 'describe', root, identity }, { hooks });
      const value = { schema_version: 1, kind: 'local-directory', root, label: options.label === undefined ? basename(root) : string(options.label, 128), identity };
      value.version = digest({ schema_version: value.schema_version, kind: value.kind, root: value.root, identity: value.identity });
      return freeze(value);
    },
    async inventorySource(value, options = {}) {
      object(options, ['maxEntries', 'maxFiles', 'maxDepth', 'signal'], []);
      const source = { ...descriptor(value), version: value.version };
      if (await approvedRootPath(source.root) !== source.root) fail('VERSION_MISMATCH', 'refresh');
      const limits = budget({ maxEntries: options.maxEntries ?? SOURCE_LIMITS.maxEntries, maxFiles: options.maxFiles ?? SOURCE_LIMITS.maxFiles, maxDepth: options.maxDepth ?? SOURCE_LIMITS.maxDepth });
      const signal = signalOption(options.signal);
      const result = await runWorker({ operation: 'inventory', descriptor: source, budget: limits }, { signal, hooks });
      return assembleInventory(source, limits, result.interrupted ? result.progress : result.value, result.interrupted);
    },
    async readSelectedEntry(value, suppliedInventory, entryId, options = {}) {
      object(options, ['maxBytes', 'signal'], []);
      const source = { ...descriptor(value), version: value.version };
      if (await approvedRootPath(source.root) !== source.root) fail('VERSION_MISMATCH', 'refresh');
      const inventory = validateInventory(suppliedInventory, source);
      if (inventory.coverage.state === 'cancelled' || inventory.coverage.state === 'blocked') fail('CONSENT_REQUIRED', 'review_scope');
      const selected = inventory.entries.find(item => item.id === uuid(entryId));
      if (!selected) fail('SCOPE_DENIED', 'review_scope');
      if (selected.kind === 'pdf') fail('UNSUPPORTED', 'use_pdf_import');
      if (['docx', 'pptx'].includes(selected.kind)) fail('UNSUPPORTED', 'use_office_import');
      const maxBytes = integer(options.maxBytes ?? SOURCE_LIMITS.maxBytes, SOURCE_LIMITS.maxBytes, 1);
      const signal = signalOption(options.signal);
      const result = await runWorker({ operation: 'read', descriptor: source, entry: selected, maxBytes }, { signal, hooks });
      if (result.interrupted) fail(result.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(result.value, ['text', 'sha256', 'version', 'title']);
      if (typeof result.value.text !== 'string' || Buffer.byteLength(result.value.text) > maxBytes
        || result.value.version !== selected.snapshot.version || result.value.title !== selected.title
        || sha(result.value.sha256) !== createHash('sha256').update(result.value.text, 'utf8').digest('hex')) fail('VERSION_MISMATCH', 'refresh');
      return freeze(result.value);
    },
    async readSelectedPdf(value, suppliedInventory, entryId, options = {}) {
      object(options, ['maxBytes', 'signal'], []);
      if (process.platform !== 'darwin') fail('UNSUPPORTED', 'native_pdf_platform_unsupported');
      const source = { ...descriptor(value), version: value.version };
      if (await approvedRootPath(source.root) !== source.root) fail('VERSION_MISMATCH', 'refresh');
      const inventory = validateInventory(suppliedInventory, source);
      if (inventory.coverage.state === 'cancelled' || inventory.coverage.state === 'blocked') fail('CONSENT_REQUIRED', 'review_scope');
      const selected = inventory.entries.find(item => item.id === uuid(entryId));
      if (!selected || selected.kind !== 'pdf') fail('SCOPE_DENIED', 'review_scope');
      const maxBytes = integer(options.maxBytes ?? 48_000, PDF_LIMITS.maxTextBytes, 1);
      const signal = signalOption(options.signal);
      const acquired = await runWorker({ operation: 'read_pdf', descriptor: source, entry: selected, maxBytes: PDF_LIMITS.maxPdfBytes }, { signal, hooks });
      if (acquired.interrupted) fail(acquired.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(acquired.value, ['base64', 'source_sha256', 'source_bytes', 'version', 'title']);
      const original = acquired.value;
      if (typeof original.base64 !== 'string' || original.base64.length > Math.ceil(PDF_LIMITS.maxPdfBytes / 3) * 4
        || integer(original.source_bytes, PDF_LIMITS.maxPdfBytes) !== selected.snapshot.size
        || original.version !== selected.snapshot.version || original.title !== selected.title) fail('VERSION_MISMATCH', 'refresh');
      const bytes = Buffer.from(original.base64, 'base64');
      if (bytes.length !== original.source_bytes || bytes.toString('base64') !== original.base64
        || sha(original.source_sha256) !== createHash('sha256').update(bytes).digest('hex')) fail('VERSION_MISMATCH', 'refresh');
      if (signal?.aborted) fail('CANCELLED');
      if (hooks.onPhase) await hooks.onPhase({ phase: 'before_pdf_parse', source_bytes: bytes.length });
      const parsed = await runNativePdf(bytes, { signal, maxTextBytes: maxBytes,
        ...(hooks.pdfTimeoutMs === undefined ? {} : { timeoutMs: hooks.pdfTimeoutMs }), onSpawn: hooks.onPhase });
      if (signal?.aborted) fail('CANCELLED');
      if (hooks.onPhase) await hooks.onPhase({ phase: 'after_pdf_parse', source_bytes: bytes.length });
      // PDFKit only sees the immutable buffer read from the approved file FD.
      // Parsing may take time, so do not return that buffer's text if its source
      // path/version moved or changed while the native parser was working.
      const checked = await runWorker({ operation: 'verify', descriptor: source, entry: selected }, { signal });
      if (checked.interrupted) fail(checked.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(checked.value, ['version']);
      if (checked.value.version !== selected.snapshot.version || signal?.aborted) fail(signal?.aborted ? 'CANCELLED' : 'VERSION_MISMATCH', 'refresh');
      return freeze(nativePdfResult(parsed, original, selected, maxBytes));
    },
    async readSelectedPdfAsset(value, suppliedInventory, entryId, options = {}) {
      object(options, ['physicalPage', 'signal'], ['physicalPage']);
      if (process.platform !== 'darwin') fail('UNSUPPORTED');
      const source = { ...descriptor(value), version: value.version };
      if (await approvedRootPath(source.root) !== source.root) fail('VERSION_MISMATCH', 'refresh');
      const inventory = validateInventory(suppliedInventory, source);
      if (['cancelled', 'blocked'].includes(inventory.coverage.state)) fail('CONSENT_REQUIRED');
      const selected = inventory.entries.find(item => item.id === uuid(entryId));
      if (!selected || selected.kind !== 'pdf') fail('SCOPE_DENIED');
      const physicalPage = integer(options.physicalPage, PDF_LIMITS.maxPages, 1), signal = signalOption(options.signal);
      const acquired = await runWorker({ operation: 'read_pdf', descriptor: source, entry: selected, maxBytes: PDF_LIMITS.maxPdfBytes }, { signal, hooks });
      if (acquired.interrupted) fail(acquired.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(acquired.value, ['base64', 'source_sha256', 'source_bytes', 'version', 'title']);
      const original = acquired.value;
      if (typeof original.base64 !== 'string' || original.base64.length > Math.ceil(PDF_LIMITS.maxPdfBytes / 3) * 4 || original.source_bytes !== selected.snapshot.size || original.version !== selected.snapshot.version || original.title !== selected.title) fail('VERSION_MISMATCH');
      const bytes = Buffer.from(original.base64, 'base64');
      if (bytes.length !== original.source_bytes || bytes.toString('base64') !== original.base64 || sha(original.source_sha256) !== createHash('sha256').update(bytes).digest('hex')) fail('VERSION_MISMATCH');
      const rendered = await runNativePdfPage(bytes, { physicalPage, signal, ...(hooks.pdfTimeoutMs === undefined ? {} : { timeoutMs: hooks.pdfTimeoutMs }), onSpawn: hooks.onPhase });
      object(rendered, ['status', 'renderer_version', 'physical_page', 'page_count', 'width', 'height', 'png_base64', 'text_regions', 'text_coordinates_available']);
      if (rendered.status !== 'available' || rendered.renderer_version !== 'macos_pdfkit_page.v1' || rendered.physical_page !== physicalPage || integer(rendered.page_count, PDF_LIMITS.maxPages, 1) < physicalPage || integer(rendered.width, 1600, 1) < 1 || integer(rendered.height, 1600, 1) < 1 || typeof rendered.png_base64 !== 'string' || rendered.png_base64.length > 2_800_000) fail('VERSION_MISMATCH');
      const png = Buffer.from(rendered.png_base64, 'base64');
      if (png.toString('base64') !== rendered.png_base64 || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(16) !== rendered.width || png.readUInt32BE(20) !== rendered.height) fail('VERSION_MISMATCH');
      if (typeof rendered.text_coordinates_available !== 'boolean') fail('VERSION_MISMATCH');
      array(rendered.text_regions, 150).forEach(region => {
        object(region, ['text', 'x', 'y', 'width', 'height']);
        if (typeof region.text !== 'string' || region.text.length > 512 || region.text.includes('\0') || ['x', 'y', 'width', 'height'].some(key => typeof region[key] !== 'number' || !Number.isFinite(region[key]) || region[key] < 0 || region[key] > 1) || region.width <= 0 || region.height <= 0 || region.x + region.width > 1.000001 || region.y + region.height > 1.000001) fail('VERSION_MISMATCH');
      });
      if (!rendered.text_coordinates_available && rendered.text_regions.length) fail('VERSION_MISMATCH');
      const checked = await runWorker({ operation: 'verify', descriptor: source, entry: selected }, { signal });
      if (checked.interrupted) fail(checked.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      if (checked.value.version !== selected.snapshot.version || signal?.aborted) fail(signal?.aborted ? 'CANCELLED' : 'VERSION_MISMATCH');
      return freeze({ ...rendered, source_sha256: original.source_sha256, source_version: original.version, png_sha256: createHash('sha256').update(png).digest('hex') });
    },
    async readSelectedOffice(value, suppliedInventory, entryId, options = {}) {
      object(options, ['maxBytes', 'signal'], []);
      if (!['darwin', 'linux'].includes(process.platform)) fail('UNSUPPORTED', 'office_text_runtime_unavailable');
      const source = { ...descriptor(value), version: value.version };
      if (await approvedRootPath(source.root) !== source.root) fail('VERSION_MISMATCH', 'refresh');
      const inventory = validateInventory(suppliedInventory, source);
      if (inventory.coverage.state === 'cancelled' || inventory.coverage.state === 'blocked') fail('CONSENT_REQUIRED', 'review_scope');
      const selected = inventory.entries.find(item => item.id === uuid(entryId));
      if (!selected || !['docx', 'pptx'].includes(selected.kind)) fail('SCOPE_DENIED', 'review_scope');
      const maxBytes = integer(options.maxBytes ?? 48_000, OFFICE_LIMITS.maxTextBytes, 1), signal = signalOption(options.signal);
      const acquired = await runWorker({ operation: 'read_office', descriptor: source, entry: selected, maxBytes: OFFICE_LIMITS.maxOfficeBytes }, { signal, hooks });
      if (acquired.interrupted) fail(acquired.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(acquired.value, ['base64', 'source_sha256', 'source_bytes', 'version', 'title']);
      const original = acquired.value;
      if (typeof original.base64 !== 'string' || original.base64.length > Math.ceil(OFFICE_LIMITS.maxOfficeBytes / 3) * 4
        || integer(original.source_bytes, OFFICE_LIMITS.maxOfficeBytes) !== selected.snapshot.size
        || original.version !== selected.snapshot.version || original.title !== selected.title) fail('VERSION_MISMATCH', 'refresh');
      const bytes = Buffer.from(original.base64, 'base64');
      if (bytes.length !== original.source_bytes || bytes.toString('base64') !== original.base64
        || sha(original.source_sha256) !== createHash('sha256').update(bytes).digest('hex')) fail('VERSION_MISMATCH', 'refresh');
      if (signal?.aborted) fail('CANCELLED');
      if (hooks.onPhase) await hooks.onPhase({ phase: 'before_office_parse', source_bytes: bytes.length });
      const parsed = await runOfficeParser(bytes, { documentType: selected.kind, signal, maxTextBytes: maxBytes,
        ...(hooks.officeTimeoutMs === undefined ? {} : { timeoutMs: hooks.officeTimeoutMs }), onSpawn: hooks.onPhase });
      if (signal?.aborted) fail('CANCELLED');
      if (hooks.onPhase) await hooks.onPhase({ phase: 'after_office_parse', source_bytes: bytes.length });
      const checked = await runWorker({ operation: 'verify', descriptor: source, entry: selected }, { signal });
      if (checked.interrupted) fail(checked.interrupted === 'cancelled' ? 'CANCELLED' : 'BUDGET_EXCEEDED');
      object(checked.value, ['version']);
      if (checked.value.version !== selected.snapshot.version || signal?.aborted) fail(signal?.aborted ? 'CANCELLED' : 'VERSION_MISMATCH', 'refresh');
      return freeze(officeResult(parsed, original, selected, maxBytes));
    },
  };
}

const adapter = createAdapter();
export const probeSourceCapability = (...args) => adapter.probeSourceCapability(...args);
export const probePdfCapability = (...args) => adapter.probePdfCapability(...args);
export const probeOfficeCapability = (...args) => adapter.probeOfficeCapability(...args);
export const describeRoot = (...args) => adapter.describeRoot(...args);
export const inventorySource = (...args) => adapter.inventorySource(...args);
export const readSelectedEntry = (...args) => adapter.readSelectedEntry(...args);
export const readSelectedPdf = (...args) => adapter.readSelectedPdf(...args);
export const readSelectedPdfAsset = (...args) => adapter.readSelectedPdfAsset(...args);
export const readSelectedOffice = (...args) => adapter.readSelectedOffice(...args);

/** Test construction only. Runtime API inputs cannot install callbacks, change
 * the worker executable, or replace any native filesystem operation. */
export function createSourceAdapterForTests(hooks) {
  object(hooks, ['onPhase', 'onBodyRead', 'pdfTimeoutMs', 'officeTimeoutMs'], []);
  for (const [key, value] of Object.entries(hooks)) if (key === 'pdfTimeoutMs') integer(value, PDF_LIMITS.maxDurationMs, 100); else if (key === 'officeTimeoutMs') integer(value, OFFICE_LIMITS.maxDurationMs, 100); else if (typeof value !== 'function') invalidInput();
  return Object.freeze(createAdapter(hooks));
}
