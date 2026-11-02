import {isVerify,verifyReply} from './verify-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBots,botState,MAX_GOAL} from '../lib/bots.js';
import {createCloud,MAX_BOT_TEXT} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

// Write has no sourcing gate, so these tests isolate length handling.
const bot={id:'write',name:'Write',mode:'write',role:'Write',runId:'fixture'};
const cloudWith=generate=>createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async(body,o)=>isVerify(body)?verifyReply():generate(body,o)}});
const answer=(text,finishReason='STOP')=>({candidates:[{finishReason,content:{role:'model',parts:[{text}]}}]});

test('bots set no output cap of ours; ordinary chat stays short',async()=>{
 const budgets=[];
 const cloud=cloudWith(async body=>{budgets.push(body.generationConfig.maxOutputTokens);return answer('Done.');});
 await cloud.chat({text:'Write the report',bot});await cloud.chat({text:'Hello'});
 assert.equal(budgets[0],undefined,'a bot is limited only by the model');assert.equal(budgets[1],1200);
});

test('a bot reply cut off at the length limit is continued and joined, not saved half-written',async()=>{
 const seen=[];
 const cloud=cloudWith(async body=>{seen.push(body.contents.at(-1));return seen.length===1?answer('Section one. Section tw','MAX_TOKENS'):seen.length===2?answer('o. Section three.','MAX_TOKENS'):answer(' The end.');});
 const result=await cloud.chat({text:'Write the report',bot});
 assert.equal(result.reply,'Section one. Section two. Section three. The end.');
 assert.equal(seen.length,3);assert.match(seen[1].parts[0].text,/cut off by the length limit/i);
});

test('chat replies are never auto-continued',async()=>{
 let calls=0;const cloud=cloudWith(async()=>{calls++;return answer('Short','MAX_TOKENS');});
 const result=await cloud.chat({text:'Hello'});assert.equal(calls,1);assert.equal(result.reply,'Short');
});

test('a long pasted brief reaches the model whole, with its line breaks',async()=>{
 let sent;const cloud=cloudWith(async body=>{sent=body.contents.at(-1).parts[0].text;return answer('Ok');});
 const brief=Array.from({length:300},(_,i)=>`${i+1}. Requirement number ${i+1} for the report`).join('\n');
 assert.ok(brief.length>4000&&brief.length<MAX_BOT_TEXT);
 await cloud.chat({text:brief,bot});
 assert.equal(sent,brief);
});

test('the server accepts a goal up to the new limit and rejects one over it',async t=>{
 const state=botState(),id=randomUUID();
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>({reply:'ok'})});
 t.after(async()=>{await engine.stop('owner',id).catch(()=>{});});
 assert.ok(MAX_GOAL>4000&&MAX_GOAL===MAX_BOT_TEXT);
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'x'.repeat(MAX_GOAL)},{requestId:id});
 await assert.rejects(engine.run('owner',{requestId:randomUUID(),botId:'research',revision:1,goal:'x'.repeat(MAX_GOAL+1)},{requestId:randomUUID()}),/16,000 characters/);
});
