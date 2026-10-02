import {Composio} from '@composio/core';
import {AppError,appOrigin} from './auth';
export const catalog = [
 {id:'gmail',name:'Gmail',tool:'GMAIL_FETCH_EMAILS',description:'Recent email subjects and senders.'},
 {id:'googlecalendar',name:'Google Calendar',tool:'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',description:'Events in the next seven days.'},
 {id:'googletasks',name:'Google Tasks',tool:'GOOGLETASKS_LIST_TASK_LISTS',description:'Your task lists.'},
 {id:'googledrive',name:'Google Drive / Docs',tool:'GOOGLEDRIVE_FIND_FILE',description:'Files and documents you can access.'},
 {id:'notion',name:'Notion',tool:'NOTION_SEARCH_NOTION_PAGE',description:'Pages shared with your Notion integration.'},
 {id:'microsoft_teams',name:'Microsoft Teams',tool:'MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS',description:'Chats permitted by your school or work tenant.'},
 {id:'one_drive',name:'Microsoft OneDrive',tool:'ONE_DRIVE_ONEDRIVE_LIST_ITEMS',description:'Files in your OneDrive.'},
 {id:'discord',name:'Discord',tool:'DISCORD_LIST_MY_GUILDS',description:'List your servers. Reading or sending channel messages additionally requires an authorized bot.'},
 {id:'github',name:'GitHub',tool:'GITHUB_GET_THE_AUTHENTICATED_USER',description:'Verify your account. Repository and course-project search is not wired into the tutor yet.'},
 {id:'linear',name:'Linear',tool:'LINEAR_GET_CURRENT_USER',description:'Verify your account. Issue and project search is not wired into the tutor yet.'},
 {id:'slack',name:'Slack',tool:'SLACK_ASSISTANT_SEARCH_CONTEXT',description:'Search messages for study-related terms in your workspace.'},
 {id:'twitter',name:'X',tool:undefined,description:'X account sign-in needs a LearnBridge-owned developer OAuth app.'},
 {id:'instagram',name:'Instagram',tool:undefined,description:'Connects Instagram Business or Creator accounts; personal accounts are not supported.'},
 {id:'reddit',name:'Reddit',tool:'REDDIT_SEARCH_ACROSS_SUBREDDITS',description:'Search public study-related discussions.'},
 {id:'linkedin',name:'LinkedIn',tool:'LINKEDIN_GET_MY_INFO',description:'Verify your profile. Learning-content search is not wired into the tutor yet.'},
 {id:'googledocs',name:'Google Docs',tool:undefined,description:'Connect your Google Docs account. Document selection and tutor sharing are the next step.'},
 {id:'googlesheets',name:'Google Sheets',tool:undefined,description:'Connect your Google Sheets account. Spreadsheet selection and tutor sharing are the next step.'},
 {id:'googleslides',name:'Google Slides',tool:undefined,description:'Connect your Google Slides account. Presentation selection and tutor sharing are the next step.'},
 {id:'excel',name:'Microsoft Excel',tool:undefined,description:'Connect your Excel account. Workbook selection and tutor sharing are the next step.'},
] as const;

export function provider(id:string){const p=catalog.find(p=>p.id===id);if(!p)throw new AppError('Unsupported connection.');return p;}
export function composio(){if(!process.env.COMPOSIO_API_KEY)throw new AppError('App connections are not configured yet.',503);return new Composio({apiKey:process.env.COMPOSIO_API_KEY,allowTracking:false});}
function authConfig(id:string){return process.env['COMPOSIO_AUTH_'+id.toUpperCase()];}
export async function connections(userId:string){
 const client=composio();
 const items:Awaited<ReturnType<typeof client.connectedAccounts.list>>['items']=[];let cursor:string|undefined;
 for(let page=0;page<10;page++){
  const result=await client.connectedAccounts.list({userIds:[userId],limit:100,cursor});items.push(...result.items);cursor=result.nextCursor||undefined;if(!cursor)break;
 }
 return catalog.map(p=>({...p,canRead:!!p.tool,configured:!!authConfig(p.id),accounts:items.filter(a=>a.toolkit.slug===p.id&&a.experimental?.accountType!=='SHARED').map(a=>({id:a.id,label:a.alias||a.wordId||p.name,status:a.status}))}));
}
async function session(userId:string,id:string,account?:string){
 const p=provider(id),config=authConfig(id);if(!p.tool||!config)throw new AppError('This connection needs site-owner setup.',503);
 return composio().create(userId,{toolkits:[id],authConfigs:{[id]:config},tools:{[id]:{enable:[p.tool]}},connectedAccounts:account?{[id]:[account]}:undefined,manageConnections:false,sandbox:{enable:false},instant:false});
}
export async function readConnection(userId:string,id:string,account:string){
 const p=provider(id),tool=p.tool;if(!tool)throw new AppError('This connection is linked, but content selection is not available yet.',501);const available=await connections(userId);
 if(!available.find(c=>c.id===id)?.accounts.some(a=>a.id===account&&a.status==='ACTIVE'))throw new AppError('Select one of your active accounts.',403);
 const now=new Date();
 const inputs:Record<string,Record<string,unknown>>={gmail:{max_results:10,verbose:false,include_payload:false,user_id:'me'},googlecalendar:{time_min:now.toISOString(),time_max:new Date(now.getTime()+7*86400000).toISOString(),response_detail:'minimal',max_results_per_calendar:20},googletasks:{maxResults:20},googledrive:{q:'trashed = false',pageSize:20},notion:{page_size:20,direction:'descending',timestamp:'last_edited_time'},microsoft_teams:{top:20,user_id:'me'},one_drive:{top:20,user_id:'me'},discord:{limit:20},slack:{query:'study OR course OR lecture OR assignment',sort:'score'},reddit:{search_query:'study OR course OR lecture OR assignment',sort:'relevance',limit:10}};
 const scoped=await session(userId,id,account);
 try{const result=await scoped.execute(tool,inputs[id]);if(result.error)throw new AppError('Account access failed. Reconnect or check permissions.',502);return {provider:p.name,fetchedAt:new Date().toISOString(),partial:true,data:result.data};}
 finally{await scoped.delete().catch(()=>{});}
}
export async function linkConnection(userId:string,id:string){
 const p=provider(id),config=authConfig(id);if(!config)throw new AppError('This connection needs site-owner setup.',503);
 if(process.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED!=='true')throw new AppError('Connection identity verification is not configured yet.',503);
 // Project verifier must be configured to /api/connectors/callback before enabling links.
 const result=await composio().connectedAccounts.link(userId,config,{callbackUrl:appOrigin()+'/connections'});
 if(!result.redirectUrl)throw new AppError('No sign-in link was returned.',502);
 return {url:result.redirectUrl};
}
