import {Composio} from '@composio/core';
import {OpenAIResponsesProvider} from '@composio/openai';
import {AppError,appOrigin} from './auth';
export const catalog = [
 {id:'gmail',name:'Gmail',tools:['GMAIL_FETCH_EMAILS'],description:'Search and read email messages.'},
 {id:'googlecalendar',name:'Google Calendar',tools:['GOOGLECALENDAR_EVENTS_LIST'],description:'Search calendar events.'},
 {id:'googletasks',name:'Google Tasks',tools:['GOOGLETASKS_LIST_ALL_TASKS','GOOGLETASKS_LIST_TASKS'],description:'Read your task lists and tasks.'},
 {id:'googledrive',name:'Google Drive',tools:['GOOGLEDRIVE_FIND_FILE'],description:'Search for files in your Drive.'},
 {id:'notion',name:'Notion',tools:['NOTION_SEARCH_NOTION_PAGE','NOTION_GET_PAGE_MARKDOWN'],description:'Search and read your Notion pages.'},
 {id:'microsoft_teams',name:'Microsoft Teams',tools:['MICROSOFT_TEAMS_SEARCH_MESSAGES'],description:'Search messages available to your account.'},
 {id:'one_drive',name:'Microsoft OneDrive',tools:['ONE_DRIVE_SEARCH_DRIVE_ITEMS'],description:'Search files in your OneDrive.'},
 {id:'discord',name:'Discord',tools:[],description:'Account can connect; private channel message reading is not configured yet.'},
 {id:'github',name:'GitHub',tools:['GITHUB_SEARCH_ISSUES'],description:'Search issues in repositories you can access.'},
 {id:'linear',name:'Linear',tools:['LINEAR_SEARCH_ISSUES'],description:'Search issues in your Linear workspace.'},
 {id:'slack',name:'Slack',tools:['SLACK_SEARCH_MESSAGES'],description:'Search messages in your workspace.'},
 {id:'twitter',name:'X',tools:[],description:'X account sign-in needs a LearnBridge-owned developer OAuth app.'},
 {id:'instagram',name:'Instagram',tools:[],description:'Connects Instagram Business or Creator accounts; content reading is not wired into the tutor yet.'},
 {id:'reddit',name:'Reddit',tools:['REDDIT_SEARCH_ACROSS_SUBREDDITS'],description:'Search public Reddit discussions.'},
 {id:'linkedin',name:'LinkedIn',tools:[],description:'Profile can connect; learning-content search is not wired into the tutor yet.'},
 {id:'googledocs',name:'Google Docs',tools:['GOOGLEDOCS_SEARCH_DOCUMENTS','GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT'],description:'Search and read your Google Docs.'},
 {id:'googlesheets',name:'Google Sheets',tools:['GOOGLESHEETS_SEARCH_SPREADSHEETS','GOOGLESHEETS_VALUES_GET'],description:'Find spreadsheets and read selected cell ranges.'},
 {id:'googleslides',name:'Google Slides',tools:['GOOGLESLIDES_PRESENTATIONS_GET'],description:'Read your presentations.'},
 {id:'excel',name:'Microsoft Excel',tools:['EXCEL_SEARCH_FILES','EXCEL_GET_RANGE'],description:'Find workbooks and read selected cell ranges.'},
] as const;

// Only tools that retrieve user content are available to the model. Write,
// delete, send, share and account-management tools are deliberately excluded.
type ReadProvider = {id:string;name:string;tools:readonly string[];description:string};

export function provider(id:string){const p=catalog.find(p=>p.id===id);if(!p)throw new AppError('Unsupported connection.');return p;}
export function composio(){if(!process.env.COMPOSIO_API_KEY)throw new AppError('App connections are not configured yet.',503);return new Composio({apiKey:process.env.COMPOSIO_API_KEY,allowTracking:false});}
function authConfig(id:string){return process.env['COMPOSIO_AUTH_'+id.toUpperCase()];}
export async function connections(userId:string){
 const client=composio();
 const items:Awaited<ReturnType<typeof client.connectedAccounts.list>>['items']=[];let cursor:string|undefined;
 for(let page=0;page<10;page++){
  const result=await client.connectedAccounts.list({userIds:[userId],limit:100,cursor});items.push(...result.items);cursor=result.nextCursor||undefined;if(!cursor)break;
 }
 return catalog.map(p=>({...p,tool:p.tools[0],canRead:p.tools.length>0,configured:!!authConfig(p.id),accounts:items.filter(a=>a.toolkit.slug===p.id&&a.experimental?.accountType!=='SHARED').map(a=>({id:a.id,label:a.alias||a.wordId||p.name,status:a.status}))}));
}
async function session(userId:string,id:string,account?:string){
 const p=provider(id) as unknown as ReadProvider,config=authConfig(id);if(!p.tools.length||!config)throw new AppError('This connection needs site-owner setup.',503);
 return composio().create(userId,{toolkits:[id],authConfigs:{[id]:config},tools:{[id]:{enable:[...p.tools]}},connectedAccounts:account?{[id]:[account]}:undefined,manageConnections:false,sandbox:{enable:false},instant:false,sessionPreset:'direct_tools'});
}
export async function readConnection(userId:string,id:string,account:string){
 const p=provider(id),tool=p.tools[0];if(!tool)throw new AppError('This connection is linked, but content selection is not available yet.',501);const available=await connections(userId);
 if(!available.find(c=>c.id===id)?.accounts.some(a=>a.id===account&&a.status==='ACTIVE'))throw new AppError('Select one of your active accounts.',403);
 const now=new Date();
 const inputs:Record<string,Record<string,unknown>>={gmail:{max_results:10,verbose:false,include_payload:false,user_id:'me'},googlecalendar:{time_min:now.toISOString(),time_max:new Date(now.getTime()+7*86400000).toISOString(),response_detail:'minimal',max_results_per_calendar:20},googletasks:{maxResults:20},googledrive:{q:'trashed = false',pageSize:20},notion:{page_size:20,direction:'descending',timestamp:'last_edited_time'},microsoft_teams:{top:20,user_id:'me'},one_drive:{top:20,user_id:'me'},discord:{limit:20},slack:{query:'study OR course OR lecture OR assignment',sort:'score'},reddit:{search_query:'study OR course OR lecture OR assignment',sort:'relevance',limit:10}};
 const scoped=await session(userId,id,account);
 try{const result=await scoped.execute(tool,inputs[id]);if(result.error)throw new AppError('Account access failed. Reconnect or check permissions.',502);return {provider:p.name,fetchedAt:new Date().toISOString(),partial:true,data:result.data};}
 finally{await scoped.delete().catch(()=>{});}
}

/** Create a request-scoped set of content-reading tools for accounts verified
 * as belonging to this signed-in student. No connection is selected by default. */
export async function createTutorTools(userId:string,selections:Array<{provider:string;accountId:string}>){
 if(!selections.length)return {client:null,session:null,tools:[]};
 if(selections.length>5)throw new AppError('Choose up to five connected accounts at a time.');
 const seen=new Set<string>();
 const available=await connections(userId);
 const toolkitIds:string[]=[];const authConfigs:Record<string,string>={};const enabled:Record<string,{enable:string[]}>={};const connectedAccounts:Record<string,string[]>={};
 for(const choice of selections){
  if(!choice||typeof choice.provider!=='string'||typeof choice.accountId!=='string'||choice.accountId.length>200)throw new AppError('Choose valid connected accounts.');
  const p=provider(choice.provider) as unknown as ReadProvider;
  if(seen.has(p.id))throw new AppError('Choose only one account for each app.');seen.add(p.id);
  const account=available.find(x=>x.id===p.id)?.accounts.find(a=>a.id===choice.accountId&&a.status==='ACTIVE');
  const config=authConfig(p.id);
  if(!account||!config||!p.tools.length)throw new AppError('One selected account is unavailable. Refresh Connections and try again.',403);
  toolkitIds.push(p.id);authConfigs[p.id]=config;enabled[p.id]={enable:[...p.tools]};connectedAccounts[p.id]=[choice.accountId];
 }
 const client=new Composio({apiKey:process.env.COMPOSIO_API_KEY,provider:new OpenAIResponsesProvider(),allowTracking:false});
 const scoped=await client.create(userId,{toolkits:toolkitIds,authConfigs,tools:enabled,connectedAccounts,manageConnections:false,sandbox:{enable:false},instant:false,sessionPreset:'direct_tools'});
 try{return {client,session:scoped,tools:await scoped.tools()};}catch(error){await scoped.delete().catch(()=>{});throw error;}
}
export async function linkConnection(userId:string,id:string){
 const p=provider(id),config=authConfig(id);if(!config)throw new AppError('This connection needs site-owner setup.',503);
 if(process.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED!=='true')throw new AppError('Connection identity verification is not configured yet.',503);
 // Project verifier must be configured to /api/connectors/callback before enabling links.
 const result=await composio().connectedAccounts.link(userId,config,{callbackUrl:appOrigin()+'/connections'});
 if(!result.redirectUrl)throw new AppError('No sign-in link was returned.',502);
 return {url:result.redirectUrl};
}
