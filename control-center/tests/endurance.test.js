import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { RequestBudgetManager, WINDOWS } from '../brain/budget.js';
import { ProviderGateway } from '../brain/gateway.js';
import { endurancePreflight } from '../brain/preflight.js';
import { retryAfter, rateHints, requestCloud } from '../brain/transport.js';
import { validateBrainConfig, routeProblem } from '../brain/config.js';
import { parsePlan, AgentRuntime } from '../brain/runtime.js';
import { RuntimeStore } from '../backend/runtime-store.js';
import { RunStore } from '../backend/run-store.js';
import { createRedactor } from '../shared/security.js';

const quota = { sessionHours: 6, normalBudgetPercent: 80, emergencyReservePercent: 20 };
const limits = { requestsPerMinute:100000,requestsPerHour:100000,requestsPerDay:100000,tokensPerMinute:100000000,tokensPerHour:100000000,tokensPerDay:100000000,sessionRequests:100000,sessionTokens:100000000,minIntervalMs:1 };
const reply = { text:'{"current_goal":"Shelter","decision_summary":"Stay safe.","plan":["!stay(1)"]}', reportedModel:'gpt-oss-120b', tokens:50, hints:{} };
function configuration() {
    return { version:1,quota,allowPaidFallback:false,maxOutputTokens:128,timeoutMs:1000,providers:Object.fromEntries(['nvidia','cerebras','groq'].map(id=>[id,{api:'openai',url:`https://${id}.example/v1`,keyEnv:'TEST_API_KEY',limits:{...limits},maxConcurrency:1,freeAccessConfirmed:true,limitsConfirmed:true,paid:false}])),brains:{gpt:{model:'gpt-oss-120b',routes:['nvidia','cerebras','groq'].map(provider=>({provider,model:'gpt-oss-120b',brain:'gpt-oss-120b',enabled:true}))}} };
}
function fixture(t, transport, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'arena-endurance-')), events=[];
    const gateway = new ProviderGateway({root,config:configuration(),keys:{TEST_API_KEY:'test-secret-only'},onEvent:(id,type,payload)=>events.push({id,type,payload}),transport,...overrides});
    t.after(()=>{gateway.close();fs.rmSync(root,{recursive:true,force:true});});
    return {gateway,root,events};
}
const messages = [{role:'user',content:'Observe and plan.'}];
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('preflight permits Minecraft while cloud is temporarily deferred but rejects configuration and permanent failures',async t=>{
    const {gateway,root}=fixture(t,async()=>reply);
    gateway.config.brains.gpt.routes=gateway.config.brains.gpt.routes.slice(0,1);
    const args={gateway,root,slots:[{id:'gpt',brainId:'gpt',displayName:'GPT'}],minecraft:{available:true,message:'LAN ready'}};
    for(const error of [Object.assign(new Error('Budget wait'),{code:'BRAIN_DEFERRED'}),Object.assign(new Error('Already deciding'),{code:'BRAIN_PENDING'}),Object.assign(new Error('Service unavailable'),{status:503})]) {
        gateway.request=async()=>{throw error;};
        const result=await endurancePreflight(args);
        assert.equal(result.ready,true);assert.equal(result.rows.at(-1).waiting,true);
    }
    for(const status of [401,403,404,410]) {
        gateway.request=async()=>{throw Object.assign(new Error('Permanent provider failure'),{status});};
        assert.equal((await endurancePreflight(args)).ready,false);
    }
    gateway.keys={};gateway.request=async()=>{throw new Error('Must not send request without a key');};
    assert.equal((await endurancePreflight(args)).ready,false);
    assert.equal((await endurancePreflight({...args,minecraft:{available:false}})).ready,false);
});

test('a budget-deferred preflight sends no cloud request or quota reservation',async t=>{
    let calls=0;
    const {gateway,root}=fixture(t,async()=>{calls++;return reply;});
    gateway.config.brains.gpt.routes=gateway.config.brains.gpt.routes.slice(0,1);
    gateway.budgets.nvidia.nextStart=Date.now()+300000;
    const result=await endurancePreflight({gateway,root,slots:[{id:'gpt',brainId:'gpt',displayName:'GPT'}],minecraft:{available:true}});
    assert.equal(result.ready,true);assert.equal(result.rows.at(-1).waiting,true);assert.equal(calls,0);
    assert.equal(gateway.budgets.nvidia.records.length,0);
});

test('players sharing a verified model reuse preflight without spending another cloud request',async t=>{
    let calls=0;const {gateway,root}=fixture(t,async()=>{calls++;return reply;});
    gateway.config.brains.gpt.routes=gateway.config.brains.gpt.routes.slice(0,1);
    const args={gateway,root,minecraft:{available:true},slots:[{id:'first',brainId:'gpt',displayName:'First'}]};
    assert.equal((await endurancePreflight(args)).ready,true);
    args.slots=[{id:'second',brainId:'gpt',displayName:'Second'}];
    assert.equal((await endurancePreflight(args)).ready,true);assert.equal(calls,1);
    gateway.keys={};assert.equal((await endurancePreflight(args)).ready,false,'cached success never bypasses missing-key validation');
});

test('preflight leaves room for reasoning before the public reply',async t=>{
    const {gateway}=fixture(t,async(_route,_provider,_key,_messages,options)=>{
        if(options.maxOutputTokens < 64) throw new Error('Provider returned no public text.');
        return {...reply,text:'OK'};
    });
    const result=await gateway.request('gpt','gpt',messages,4,{preflight:true,onlyProvider:'groq'});
    assert.equal(result.text,'OK');
});

test('critical danger cancels a queued normal decision and preserves emergency priority',async()=>{
    let rejectRequest,cancelled=0;
    const bot={health:5,food:10,entity:{position:{x:0,y:64,z:0}},inventory:{items:()=>[]},clearControlStates(){}};
    const agent={bot,actions:{cancelResume(){}},requestInterrupt(){},history:{memory:'Cave north',turns:[]},arenaBrainClient:{request:()=>new Promise((resolve,reject)=>{rejectRequest=reject;}),cancel(){cancelled++;rejectRequest(new Error('cancelled'));}}};
    const runtime=new AgentRuntime(agent,{slot:{id:'gpt',minecraftName:'ARENA_GPT',objective:'Survive'},brain:{model:'gpt-oss-120b'},brainSettings:{}},()=>{},{catalog:''});
    runtime.bot=bot;runtime.ready=true;runtime.data.goal='Keep shelter';const pending=runtime.tick();
    runtime.trigger(1,'Critical danger',true);await pending;
    assert.equal(cancelled,1);assert.equal(runtime.requested,1);assert.equal(runtime.busy,false);assert.equal(runtime.data.goal,'Keep shelter');assert.equal(agent.history.memory,'Cave north');runtime.closed=true;
});

test('remaining token headers prevent a request before the provider reaches zero',()=>{
    let now=1000;const b=new RequestBudgetManager(limits,quota,{},()=>now);
    b.applyHints(rateHints(new Headers({'x-ratelimit-remaining-tokens':'100','x-ratelimit-reset-tokens':'30s'}),now));
    assert.equal(b.inspect(101).allowed,false);assert.equal(b.inspect(101).retryAt,31000);
    assert.ok(b.reserve(60,1));assert.equal(b.inspect(60,1).allowed,false);
    now=31001;assert.equal(b.inspect(101).allowed,true);
});

test('recording feed hides handled provider noise while developer history retains it',()=>{
    const source=fs.readFileSync(new URL('../frontend/app.js',import.meta.url),'utf8');
    const prefix=source.slice(0,source.indexOf('function overview('));
    const rows=[{type:'provider_failure',agent_id:'gpt',timestamp:new Date().toISOString(),payload:{message:'Handled failure'}}];
    const sandbox={rows};
    vm.runInNewContext(prefix+'\nstate={agents:{}};recording=true;globalThis.recorded=feed(rows,false);recording=false;globalThis.developer=feed(rows,false);',sandbox);
    assert.ok(!sandbox.recorded.includes('Handled failure'));assert.ok(sandbox.developer.includes('Handled failure'));
});

test('cloud request succeeds with actual identity and measured usage',async t=>{
    const {gateway,events}=fixture(t,async()=>reply);
    assert.equal((await gateway.request('a','gpt',messages)).model,'gpt-oss-120b');
    assert.equal(events.filter(e=>e.type==='model_request_started').length,1);
    assert.equal(gateway.budgets.nvidia.sessionRequests,1);
});
test('429 honors Retry-After, logs diagnosis and fails over to the same brain',async t=>{
    const called=[], now=100000;
    const {gateway,events}=fixture(t,async route=>{called.push(route.provider);if(route.provider==='nvidia')throw Object.assign(new Error('HTTP 429'),{status:429,hints:{blockedUntil:now+120000}});return reply;},{now:()=>now});
    const result=await gateway.request('a','gpt',messages);
    assert.deepEqual(called,['nvidia','cerebras']);assert.equal(result.model,'gpt-oss-120b');assert.equal(result.provider,'cerebras');
    assert.equal(gateway.health.nvidia.openUntil,220000);assert.ok(events.some(e=>e.type==='provider_failure'&&e.payload.status===429));assert.ok(!events.some(e=>e.type==='error'));
});
test('Retry-After dates and provider remaining/reset headers are parsed',()=>{
    assert.equal(retryAfter('3',1000),4000);assert.equal(retryAfter('Wed, 21 Oct 2015 07:28:00 GMT',0),1445412480000);
    assert.equal(rateHints(new Headers({'x-ratelimit-remaining-tokens':'0','x-ratelimit-reset-tokens':'2m3s'}),1000).blockedUntil,124000);
});
test('provider timeout aborts transport and selects next same-model route',async t=>{
    let aborted=false;
    const {gateway}=fixture(t,async(route,p,k,m,{signal})=>route.provider==='nvidia'?new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true})):reply);
    assert.equal((await gateway.request('a','gpt',messages)).provider,'cerebras');assert.equal(aborted,true);
});
test('503 opens a bounded circuit instead of rapid retries',async t=>{
    let calls=0;
    const {gateway}=fixture(t,async route=>{calls++;if(route.provider==='nvidia')throw Object.assign(new Error('HTTP 503'),{status:503});return reply;});
    await gateway.request('a','gpt',messages);assert.equal(calls,2);assert.ok(gateway.health.nvidia.openUntil>Date.now());
});
test('all routes unavailable keep one pending request; recovery continues it',async t=>{
    let now=100000, failing=true, calls=0;
    const {gateway}=fixture(t,async()=>{calls++;if(failing)throw Object.assign(new Error('overload'),{status:503});return reply;},{now:()=>now,random:()=>0});
    let done=false;const pending=gateway.request('a','gpt',messages).then(r=>{done=true;return r;});
    await delay(30);assert.equal(done,false);assert.equal(gateway.queue.length,1);assert.equal(calls,3);
    for(let i=0;i<50;i++)gateway.pump();assert.equal(calls,3);
    failing=false;now+=60000;gateway.pump();assert.equal((await pending).model,'gpt-oss-120b');
});
test('shared provider schedule spaces three agents fairly without bursts',async t=>{
    let now=100000;const cfg=configuration();cfg.brains.gpt.routes=cfg.brains.gpt.routes.slice(0,1);cfg.providers.nvidia.limits.minIntervalMs=2000;
    const calls=[];const {gateway}=fixture(t,async()=>{calls.push(now);return reply;},{config:cfg,now:()=>now});
    const results=['a','b','c'].map(id=>gateway.request(id,'gpt',messages));
    await delay(20);assert.deepEqual(calls,[100000]);now+=2000;gateway.pump();await delay(20);now+=2000;gateway.pump();await Promise.all(results);
    assert.deepEqual(calls,[100000,102000,104000]);assert.equal(gateway.queue.length,0);
});
test('normal budget cannot spend emergency reserve; life-critical can',()=>{
    let now=100000;const b=new RequestBudgetManager({...limits,sessionRequests:10,sessionTokens:10000},quota,{},()=>now);
    // Exhaust the normal pool within one six-hour session, before renewal.
    for(let i=0;i<8;i++){assert.ok(b.reserve(100,4));if(i<7)now+=2700000;}
    assert.equal(b.reserve(100,4),null);assert.equal(b.snapshot().reserveRemaining,2);
    now+=1000;
    assert.ok(b.reserve(100,1));now+=1000;assert.ok(b.reserve(100,1));now+=1000;assert.equal(b.reserve(100,1),null);assert.equal(b.snapshot().reserveRemaining,0);
});

test('active pacing removes six-hour spacing while preserving minute, daily and reserve caps',()=>{
    let now=100000;
    const caps={...limits,requestsPerMinute:10,requestsPerDay:10,sessionRequests:10,sessionTokens:100000,minIntervalMs:30000};
    const active=new RequestBudgetManager(caps,{...quota,paceAcrossSession:false},{},()=>now);
    const endurance=new RequestBudgetManager(caps,quota,{},()=>now);
    assert.ok(active.reserve(100,4));assert.ok(endurance.reserve(100,4));
    assert.equal(active.inspect(100,4).allowed,false,'minimum spacing remains');
    now+=30000;
    assert.ok(active.reserve(100,4));assert.equal(endurance.inspect(100,4).allowed,false,'old six-hour pacing is still opt-in');
    for(let i=0;i<6;i++){now+=30000;assert.ok(active.reserve(100,4));}
    now+=30000;assert.equal(active.reserve(100,4),null,'normal reserve remains protected');
    assert.ok(active.reserve(100,1));now+=30000;assert.ok(active.reserve(100,1));
    now+=6*3600000;assert.equal(active.reserve(100,4),null,'daily accounting survives session renewal');
    const minute=new RequestBudgetManager({...caps,requestsPerMinute:2,minIntervalMs:1},{...quota,paceAcrossSession:false},{},()=>now);
    assert.ok(minute.reserve(100,4));now+=2;assert.equal(minute.reserve(100,4),null,'normal minute cap remains');
});

test('oversized normal requests reject immediately rather than waiting forever until an emergency',async t=>{
    let calls=0;const config=configuration();config.maxOutputTokens=1536;
    for(const p of Object.values(config.providers))p.limits.tokensPerMinute=8000;
    const {gateway}=fixture(t,async()=>{calls++;return reply;},{config});
    assert.equal(gateway.inputBudget('gpt'),4608);
    await assert.rejects(gateway.request('gpt','gpt',[{role:'user',content:'x'.repeat(5000)}],4),/input allowance/);
    assert.equal(gateway.queue.length,0);assert.equal(calls,0);
    await gateway.request('gpt','gpt',[{role:'user',content:'x'.repeat(4000)}],4);
    assert.equal(calls,1);
});
test('accelerated six-hour governor never exceeds RPM/RPH/RPD/TPM/TPH/TPD/session caps',()=>{
    let now=100000;const start=now, caps={requestsPerMinute:4,requestsPerHour:60,requestsPerDay:300,tokensPerMinute:1000,tokensPerHour:9000,tokensPerDay:40000,sessionRequests:250,sessionTokens:32000,minIntervalMs:2000};
    const b=new RequestBudgetManager(caps,quota,{},()=>now), sent=[];
    for(let step=0;step<4320;step++,now+=5000){const r=b.reserve(150,step%83===0?1:4);if(r)sent.push({...r});}
    assert.ok(sent.length>100);assert.ok(b.sessionRequests<=250);assert.ok(b.sessionTokens<=32000);assert.ok(b.normalRequests<=200);assert.ok(b.normalTokens<=25600);
    for(const row of sent)for(const[unit,ms]of WINDOWS){const window=sent.filter(r=>r.at<=row.at&&r.at>row.at-ms);assert.ok(window.length<=caps['requestsPer'+unit]);assert.ok(window.reduce((n,r)=>n+r.tokens,0)<=caps['tokensPer'+unit]);}
    assert.equal(now-start,21600000);
});
test('budget persistence survives backend restart without resetting daily/session use',async t=>{
    const{gateway,root}=fixture(t,async()=>reply);await gateway.request('a','gpt',messages);
    const restored=new ProviderGateway({root,config:configuration(),keys:{TEST_API_KEY:'test-secret-only'},transport:async()=>reply});
    assert.equal(restored.budgets.nvidia.sessionRequests,1);assert.equal(restored.budgets.nvidia.records.length,1);restored.close();
});
test('model substitution and paid/unconfirmed routes are rejected',()=>{
    const cfg=configuration();cfg.brains.gpt.routes[1].model='qwen';assert.throws(()=>validateBrainConfig(cfg),/alias/);
    const c=configuration(),r=c.brains.gpt.routes[0];c.providers.nvidia.paid=true;assert.match(routeProblem(c,r,{TEST_API_KEY:'x'}),/Paid/);
    c.providers.nvidia.paid=false;c.providers.nvidia.freeAccessConfirmed=false;assert.match(routeProblem(c,r,{TEST_API_KEY:'x'}),/free-only/);
});
test('provider-reported wrong model is rejected without consuming its text',async t=>{
    const {gateway}=fixture(t,async route=>route.provider==='nvidia'?{...reply,reportedModel:'qwen'}:reply);
    assert.equal((await gateway.request('a','gpt',messages)).provider,'cerebras');assert.ok(gateway.health.nvidia.openUntil>Date.now()+1000000);
});
test('explicit local-cap operation still requires free access and rejects paid routes',()=>{
    const c=configuration(),r=c.brains.gpt.routes[0],p=c.providers.nvidia;
    p.limitsConfirmed=false;
    assert.match(routeProblem(c,r,{TEST_API_KEY:'x'}),/limits/);
    p.allowUnverifiedLimits=true;
    assert.equal(routeProblem(c,r,{TEST_API_KEY:'x'}),null);
    p.freeAccessConfirmed=false;
    assert.match(routeProblem(c,r,{TEST_API_KEY:'x'}),/free-only/);
    p.freeAccessConfirmed=true;p.paid=true;
    assert.match(routeProblem(c,r,{TEST_API_KEY:'x'}),/Paid/);
});
test('bounded plan parser rejects host coding, reset commands and hidden reasoning',()=>{
    const validate=s=>({commandName:s.split('(')[0],args:[]});
    assert.equal(parsePlan('<think>private</think>'+reply.text,validate).plan[0],'!stay(1)');
    assert.throws(()=>parsePlan(JSON.stringify({current_goal:'x',decision_summary:'x',plan:['!restart']}),validate),/Forbidden/);
    assert.throws(()=>parsePlan(JSON.stringify({current_goal:'x',decision_summary:'x',plan:['!digDown(3)']}),validate),/Forbidden/);
    assert.throws(()=>parsePlan(JSON.stringify({current_goal:'x',decision_summary:'x',plan:['!goToCoordinates(1,64,1,1)']}),validate),/Forbidden/);
    assert.throws(()=>parsePlan('<think>unfinished',validate));
});
test('death preserves objective, memories and strategy; invalidates only physical plan',()=>{
    const bot=new EventEmitter();Object.assign(bot,{health:20,food:20,entity:{position:{x:1,y:64,z:2}},game:{dimension:'overworld'},inventory:{items:()=>[{name:'iron_ore',count:3}]},clearControlStates(){},respawn(){}});
    const events=[],agent={bot,history:{memory:'Cave north',turns:[]},memory_bank:{getJson:()=>({cave:[1,64,2]})},actions:{cancelResume(){}},requestInterrupt(){},arenaBrainClient:{cancel(){}}};
    const runtime=new AgentRuntime(agent,{slot:{id:'gpt',minecraftName:'ARENA_GPT',objective:'Survive'},brain:{model:'gpt-oss-120b'},brainSettings:{}},(type,payload)=>events.push({type,payload}),{});
    runtime.bot=bot;runtime.data.goal='Mine iron';runtime.data.plan=['!stay(1)'];runtime.data.memories=['Cave north'];runtime.ready=true;runtime.data.player={inventory:bot.inventory.items()};bot.health=0;
    runtime.onDeath();runtime.onDeath();assert.equal(runtime.data.deaths,1);assert.equal(runtime.data.goal,'Mine iron');assert.equal(runtime.data.objective,'Survive');assert.deepEqual(runtime.data.memories,['Cave north']);assert.equal(runtime.data.planInvalid,true);assert.deepEqual(runtime.data.lastDeath.inventory,[{name:'iron_ore',count:3}]);assert.equal(events.filter(e=>e.type==='death').length,1);runtime.closed=true;
});
test('runtime snapshot restores identity/context and removes known secrets',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'arena-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const storage=new RuntimeStore(root,createRedactor(['secret-123'])),snapshot={minecraftName:'ARENA_GPT',model:'gpt-oss-120b',objective:'Survive',goal:'Iron',plan:['!stay(1)'],planIndex:0,history:{memory:'Cave secret-123'}};
    storage.save('gpt',snapshot,{stats:{deaths:2}});const restored=storage.load({id:'gpt',minecraftName:'ARENA_GPT',model:'gpt-oss-120b'});
    assert.equal(restored.snapshot.goal,'Iron');assert.equal(restored.observer.stats.deaths,2);assert.ok(!JSON.stringify(restored).includes('secret-123'));
    assert.throws(()=>storage.load({id:'gpt',minecraftName:'ARENA_GPT',model:'qwen'}),/identity/);
});
test('runtime restart preserves strategy but discards a saved physical plan',()=>{
    const agent={history:{memory:'',turns:[]},memory_bank:{getJson:()=>({})},actions:{cancelResume(){}},requestInterrupt(){},arenaBrainClient:{cancel(){}}};
    const runtime=new AgentRuntime(agent,{slot:{id:'gemini',minecraftName:'ARENA_GEMINI',objective:'Survive'},brain:{model:'gemini'},brainSettings:{},runtime:{goal:'Recover items',memories:['avoid caves'],plan:['!goToCoordinates(3,100,5,1)'],planIndex:0}},()=>{},{});
    assert.equal(runtime.data.goal,'Recover items');
    assert.deepEqual(runtime.data.memories,['avoid caves']);
    assert.deepEqual(runtime.data.plan,[]);
    assert.equal(runtime.data.planIndex,0);
    assert.equal(runtime.data.planInvalid,true);
});
test('transient provider failures are diagnostic events, not fatal card errors',async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'arena-ui-')),store=new RunStore(root,[{id:'gpt',profile:{},displayName:'GPT'}]);
    t.after(async()=>{await store.close();fs.rmSync(root,{recursive:true,force:true});});
    store.event('gpt','agent_connected',{});store.event('gpt','decision_created',{current_goal:'Iron',decision_summary:'Keep mining.'});
    store.event('gpt','provider_failure',{status:429,provider:'nvidia',message:'HTTP 429'});store.event('gpt','brain_state',{state:'WAITING_FOR_BUDGET'});
    assert.equal(store.agents.gpt.status,'online');assert.equal(store.agents.gpt.goal,'Iron');assert.equal(store.agents.gpt.plan,'Keep mining.');assert.equal(store.agents.gpt.error,null);assert.equal(store.agents.gpt.lastProviderFailure.status,429);
});
test('transport excludes hidden reasoning, abort signal and secrets from returned metadata',async()=>{
    const route={model:'gpt-oss-120b'},provider={api:'openai',url:'https://test.example/v1'};let supplied;
    const result=await requestCloud(route,provider,'test-secret',messages,{maxOutputTokens:128,signal:new AbortController().signal,fetchImpl:async(url,options)=>{supplied=options;return new Response(JSON.stringify({model:'gpt-oss-120b',choices:[{message:{content:'Public answer',reasoning_content:'private'}}],usage:{total_tokens:12}}),{status:200});}});
    assert.equal(result.text,'Public answer');assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('test-secret'));assert.ok(supplied.signal);assert.equal(JSON.parse(supplied.body).max_tokens,128);
});
test('duplicate requests are bounded; cancelled work does not accumulate',async t=>{
    let now=100000;const{gateway}=fixture(t,async()=>reply,{now:()=>now});await gateway.request('a','gpt',messages);
    // All routes cooling down means a stable queue of one, not a new retry per tick.
    for(const p of Object.keys(gateway.config.providers))gateway.health[p]={active:0,failures:1,openUntil:now+60000};
    const pending=gateway.request('a','gpt',messages);await assert.rejects(gateway.request('a','gpt',messages),/pending/);gateway.cancel('a');await assert.rejects(pending,/cancelled/);assert.equal(gateway.queue.length,0);now+=60000;
});
