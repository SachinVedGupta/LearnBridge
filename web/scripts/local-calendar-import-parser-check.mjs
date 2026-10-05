import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parseCalendarFile} from '../apps/local-runtime/src/calendar-import-service.mjs';
const python=process.env.CALENDAR_IMPORT_ORACLE_PYTHON;
if(!python)throw new Error('Set CALENDAR_IMPORT_ORACLE_PYTHON to an isolated Python with audited icalendar 6.3.2; no package installation or global Python change is performed.');
const event=(uid,start,end)=>`BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261004T160000Z\r\nSUMMARY:Literal\\, lecture\\; practice\\nnext line\r\n${start}\r\n${end}\r\nEND:VEVENT\r\n`;
const wrap=events=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Independent synthetic oracle//EN\r\n${events}END:VCALENDAR\r\n`;
const cases=[
  {filename:'utc.ics',timezone:'UTC',content:wrap(event('utc','DTSTART:20261006T170000Z','DTEND:20261006T180000Z'))},
  {filename:'spring.ics',timezone:'America/Toronto',content:wrap(event('spring','DTSTART;VALUE=DATE:20260308','DTEND;VALUE=DATE:20260309'))},
  {filename:'fall.ics',timezone:'America/Toronto',content:wrap(event('fall','DTSTART;VALUE=DATE:20261101','DTEND;VALUE=DATE:20261102'))},
  {filename:'leap.ics',timezone:'America/Toronto',content:wrap(event('leap','DTSTART;VALUE=DATE:20280229','DTEND;VALUE=DATE:20280301'))},
  {filename:'gap.ics',timezone:'Pacific/Apia',content:wrap(event('gap','DTSTART;VALUE=DATE:20111230','DTEND;VALUE=DATE:20111231'))},
  {filename:'fold.ics',timezone:'America/Havana',content:wrap(event('fold','DTSTART;VALUE=DATE:20261101','DTEND;VALUE=DATE:20261102'))},
];
const script=String.raw`
import sys,json,datetime
import icalendar
from zoneinfo import ZoneInfo
assert icalendar.__version__=='6.3.2'
utc=datetime.timezone.utc
def stamp(value,zone):
  if isinstance(value,datetime.datetime):return value.astimezone(utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
  target=datetime.datetime.combine(value,datetime.time());tz=ZoneInfo(zone);matches=set()
  for fold in (0,1):
    candidate=target.replace(tzinfo=tz,fold=fold).astimezone(utc)
    if candidate.astimezone(tz).replace(tzinfo=None)==target:matches.add(candidate)
  if len(matches)!=1:return None
  return next(iter(matches)).isoformat(timespec='milliseconds').replace('+00:00','Z')
result=[]
for case in json.load(sys.stdin):
  rows=[]
  for event in icalendar.Calendar.from_ical(case['content']).walk('VEVENT'):
    start=stamp(event.decoded('DTSTART'),case['timezone']);end=stamp(event.decoded('DTEND'),case['timezone'])
    if start is not None and end is not None:rows.append({'uid':str(event['UID']),'title':str(event['SUMMARY']),'start':start,'end':end})
  result.append(rows)
json.dump(result,sys.stdout)
`;
const expected=JSON.parse(execFileSync(python,['-c',script],{input:JSON.stringify(cases),encoding:'utf8',timeout:15000,maxBuffer:100000}));
for(let i=0;i<cases.length;i++){const actual=parseCalendarFile(cases[i]).events.map(({uid,title,start,end})=>({uid,title,start,end}));assert.deepEqual(actual,expected[i],cases[i].filename);}
console.log(JSON.stringify({format:'learnbridge-calendar-import-independent-oracle',oracle:'icalendar 6.3.2 plus Python ZoneInfo exact fold/gap round-trip',cases:cases.length,passed:true,verified:['UTC explicit exclusive end','literal escaped TEXT','chosen-zone DATE exclusive end','23-hour spring day','25-hour fall day','leap date','missing midnight rejection','ambiguous midnight rejection'],data:'synthetic only',provider_requests:0}));
