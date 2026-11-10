import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequestBody, createOpenAiProvider } from '../../src/core/model/openai.ts';
import type { ChatRequest } from '../../src/shared/types.ts';

const config = { id:'offline',name:'local test',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-placeholder',chatPath:'chat/completions',modelsPath:'models' };
const request: ChatRequest = {model:'existing-model',messages:[{role:'user',content:'local transport test'}],maxAttempts:1};
test('closure transport: request cap 1 makes a retryable HTTP failure exactly one attempt and never sends cap on the wire', async()=>{
 let attempts=0;let body='';
 const provider=createOpenAiProvider({config,maxAttempts:3,backoffBaseMs:0,sleep:async()=>{},fetchImpl:async(_url,init)=>{attempts++;body=String(init.body);return new Response('UPSTREAM_PRIVATE_DO_NOT_PERSIST',{status:503});}});
 const events=[];for await(const event of provider.stream(request,new AbortController().signal))events.push(event);
 assert.equal(attempts,1);assert.ok(events.some(event=>event.type==='error'&&event.status===503));
 assert.equal(Object.hasOwn(JSON.parse(body),'maxAttempts'),false);assert.equal(Object.hasOwn(buildRequestBody(request,config),'maxAttempts'),false);
 assert.equal(Object.hasOwn(buildRequestBody({...request,extraBody:{maxAttempts:8}},config),'maxAttempts'),false);
});
test('closure transport: per-request cap can lower but never increase a provider-level cap', async()=>{
 let attempts=0;const provider=createOpenAiProvider({config,maxAttempts:1,sleep:async()=>{},fetchImpl:async()=>{attempts++;return new Response('retryable',{status:429});}});
 for await(const _ of provider.stream({...request,maxAttempts:8},new AbortController().signal)){}
 assert.equal(attempts,1);
});
