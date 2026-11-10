import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../app.ts';
import { getConversation } from '../../core/store/repo.ts';
import { readCompactionStatus } from '../../core/agent/auto-compaction.ts';
import { listCompactionEvents } from '../../core/context/compact.ts';
import { getRecallIndex,getRecallMessage } from '../../core/context/recall.ts';
function fail(message:string,statusCode=400):never{throw Object.assign(new Error(message),{statusCode});}
function number(value:unknown,name:string):number|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail(`Invalid ${name}`);
 return Number(value);
}
export function registerCompactionRoutes(app:FastifyInstance,deps:ServerDeps):void{
 app.get<{Params:{id:string}}>('/api/conversations/:id/compaction-status',async request=>{
  if(!getConversation(deps.db,request.params.id))fail('Conversation not found',404);
  return readCompactionStatus(deps.db,request.params.id,deps.tools);
 });
 app.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/api/conversations/:id/compaction-events',async request=>{
  if(!getConversation(deps.db,request.params.id))fail('Conversation not found',404);
  const q=request.query;if(Object.keys(q).some(key=>!['limit','offset'].includes(key)))fail('Unknown compaction query');
  return listCompactionEvents(deps.db,request.params.id,number(q.limit,'limit')??50,number(q.offset,'offset')??0);
 });
 app.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/api/conversations/:id/recall',async request=>{
  if(!getConversation(deps.db,request.params.id))fail('Conversation not found',404);
  const q=request.query;
  if(Object.keys(q).some(key=>!['mode','fromSeq','toSeq','offset','limit','seq','charOffset','maxChars'].includes(key)))fail('Unknown recall query');
  if(q.mode==='index'||q.mode===undefined)return getRecallIndex(deps.db,request.params.id,{fromSeq:number(q.fromSeq,'fromSeq'),toSeq:number(q.toSeq,'toSeq'),offset:number(q.offset,'offset'),limit:number(q.limit,'limit')});
  if(q.mode==='message')return getRecallMessage(deps.db,request.params.id,{seq:number(q.seq,'seq')??NaN,charOffset:number(q.charOffset,'charOffset'),maxChars:number(q.maxChars,'maxChars')});
  fail('Invalid recall mode');
 });
}
