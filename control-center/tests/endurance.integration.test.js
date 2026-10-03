import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import mc from 'minecraft-protocol';
import { ROOT } from '../backend/config.js';
import { RunStore } from '../backend/run-store.js';
import { RuntimeStore } from '../backend/runtime-store.js';
import { ProcessManager } from '../backend/process-manager.js';
import { ProviderGateway } from '../brain/gateway.js';
import { createRedactor } from '../shared/security.js';

test('real worker: spawn health, knockback, 429/503/timeout, recovery, death/respawn and reconnect preserve its brain', {timeout:130000}, async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'arena-real-endurance-'));
    const name='ARENA_REL_'+String(process.pid).slice(-5), botDir=path.join(ROOT,'bots',name);
    assert.ok(!fs.existsSync(botDir));
    const server=mc.createServer({host:'127.0.0.1',port:0,version:'1.21.6','online-mode':false,motd:'ARENA DEVELOPMENT LIFECYCLE FIXTURE'});
    await once(server,'listening');
    const require=createRequire(import.meta.url),data=createRequire(require.resolve('minecraft-protocol'))('minecraft-data')('1.21.6');
    let client,connections=0,teleport=0;const packets=[];
    const position=c=>c.write('position',{teleportId:++teleport,x:2,y:64,z:3,dx:0,dy:0,dz:0,yaw:0,pitch:0,flags:{}});
    server.on('playerJoin',c=>{
        client=c;connections++;c.on('error',()=>{});
        c.write('login',{...data.loginPacket,entityId:c.id,isHardcore:false});position(c);
        c.write('update_health',{health:20,food:20,foodSaturation:5});c.write('update_time',{age:24000n,time:1000n,tickDayTime:true});
        c.on('packet',(p,meta)=>{if(['position','position_look'].includes(meta.name))packets.push(p);});
        c.on('client_command',p=>{if(p.actionId===0){c.write('respawn',{worldState:data.loginPacket.worldState,copyMetadata:3});position(c);c.write('update_health',{health:20,food:20,foodSaturation:5});}});
    });
    const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'brain.config.example.json'),'utf8'));
    cfg.timeoutMs=1000;cfg.quota.sessionHours=1;
    for(const p of Object.values(cfg.providers)){p.freeAccessConfirmed=true;p.limitsConfirmed=true;p.paid=false;p.limits={requestsPerMinute:100000,requestsPerHour:100000,requestsPerDay:100000,tokensPerMinute:100000000,tokensPerHour:100000000,tokensPerDay:100000000,sessionRequests:100000,sessionTokens:100000000,minIntervalMs:1};}
    cfg.brains.gpt.routes.forEach(r=>r.enabled=true);
    const slot={id:'gpt',brainId:'gpt',enabled:true,displayName:'GPT',model:'gpt-oss-120b',minecraftName:name,objective:'Survive and remember the cave.',profile:{name,model:{api:'openai',model:'gpt-oss-120b'}}};
    const redact=createRedactor(['fixture-key']),store=new RunStore(root,[slot],redact),runtimeStore=new RuntimeStore(root,redact),events=[];
    // Store's event return is authoritative even if its emitter interface changes.
    const originalEvent=store.event.bind(store);store.event=(id,type,payload)=>{events.push({agent_id:id,type,payload});return originalEvent(id,type,payload);};
    let mode='success',calls=0,manager;
    const gateway=new ProviderGateway({root,config:cfg,keys:{NVIDIA_API_KEY:'fixture-key',CEREBRAS_API_KEY:'fixture-key',GROQ_API_KEY:'fixture-key',GEMINI_API_KEY:'fixture-key'},onEvent:(id,type,payload)=>{store.event(id,type,payload);const child=manager?.children.get(id);if(type==='brain_state'&&child?.connected)child.send({kind:'brain_state',payload});},transport:async(route,p,k,m,{signal})=>{
        calls++;
        if(mode==='429')throw Object.assign(new Error('fixture HTTP 429'),{status:429,hints:{blockedUntil:Date.now()+2000}});
        if(mode==='503')throw Object.assign(new Error('fixture HTTP 503'),{status:503});
        if(mode==='timeout')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true}));
        return {text:JSON.stringify({current_goal:'Preserve shelter plan',decision_summary:'Wait safely and remember the cave.',plan:['!stay(1)','!stay(1)']}),reportedModel:'gpt-oss-120b',tokens:100,hints:{}};
    }});
    manager=new ProcessManager({root:ROOT,config:{minecraft:{host:'127.0.0.1',port:server.socketServer.address().port,version:'1.21.6'}},slots:[slot],store,gateway,runtimeStore});
    t.after(async()=>{await manager.shutdown();gateway.close();await store.close();server.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(botDir,{recursive:true,force:true});});
    const until=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert.ok(fn(),label+' '+JSON.stringify(events.slice(-8)));};
    // Cold Windows imports have taken ~50 seconds in the live worker. Keep
    // gameplay/recovery deadlines unchanged, but allow that initial engine load.
    await manager.start('gpt');await until(()=>events.some(e=>e.type==='decision_created'),'first strategic decision',60000);
    const child=manager.children.get('gpt'),pid=child.pid;
    assert.equal(store.agents.gpt.health,20);assert.equal(store.agents.gpt.playerPreflight.health,20);
    client.write('entity_velocity',{entityId:client.id,velocity:{x:800,y:1600,z:0}});client.write('update_health',{health:19,food:20,foodSaturation:5});
    await until(()=>runtimeStore.load(slot)?.snapshot.player?.health===19,'hurt snapshot');
    const hurt=runtimeStore.load(slot).snapshot;assert.ok(Object.values(hurt.player.velocity).every(Number.isFinite));assert.equal(store.agents.gpt.stats.deaths,0);assert.equal(manager.children.get('gpt').pid,pid);
    for(const failure of ['429','503','timeout']){
        mode=failure;for(const h of Object.values(gateway.health))h.openUntil=0;for(const b of Object.values(gateway.budgets))b.headerBlockUntil=0;
        const before=calls;await until(()=>calls>before,'provider '+failure,25000);
        await until(()=>events.some(e=>e.type==='provider_failure'&&(failure==='timeout'?e.payload.status==='TIMEOUT':e.payload.status===Number(failure))),'diagnostic '+failure,10000);
        assert.equal(manager.children.get('gpt').pid,pid);assert.equal(connections,1);assert.equal(runtimeStore.load(slot).snapshot.goal,'Preserve shelter plan');assert.equal(runtimeStore.load(slot).snapshot.objective,slot.objective);
        assert.deepEqual(runtimeStore.load(slot).snapshot.plan,['!stay(1)','!stay(1)']);
        assert.ok(runtimeStore.load(slot).snapshot.history.turns.length>0);
    }
    mode='success';for(const h of Object.values(gateway.health))h.openUntil=0;for(const b of Object.values(gateway.budgets))b.headerBlockUntil=0;gateway.pump();
    const beforeDecision=events.filter(e=>e.type==='decision_created').length;await until(()=>events.filter(e=>e.type==='decision_created').length>beforeDecision,'provider recovery');
    client.write('update_health',{health:0,food:20,foodSaturation:5});
    await until(()=>events.some(e=>e.type==='death'),'death event');await until(()=>events.some(e=>e.type==='respawn'),'respawn');
    assert.equal(manager.children.get('gpt').pid,pid);assert.equal(connections,1);assert.equal(runtimeStore.load(slot).snapshot.deaths,1);assert.equal(runtimeStore.load(slot).snapshot.objective,slot.objective);assert.ok(runtimeStore.load(slot).snapshot.history.turns.length>0);
    client.end('Fixture real connection loss');await until(()=>connections===2,'actual Minecraft reconnect',20000);await until(()=>manager.children.get('gpt')?.pid!==pid&&store.agents.gpt.status==='online','restored worker',20000);
    const restored=runtimeStore.load(slot).snapshot;assert.equal(restored.goal,'Preserve shelter plan');assert.equal(restored.deaths,1);assert.equal(restored.objective,slot.objective);assert.ok(restored.history.turns.length>0);
    // Short real-time soak of the actual worker after lifecycle recovery.
    const stablePid=manager.children.get('gpt').pid,soakEnd=Date.now()+15000,startCalls=calls;
    while(Date.now()<soakEnd){
        await new Promise(resolve=>setTimeout(resolve,500));
        assert.equal(manager.children.get('gpt').pid,stablePid);assert.equal(connections,2);
        assert.ok(gateway.queue.length<=1);assert.ok(gateway.active.size<=1);
        assert.ok(store.feed.length<=120);assert.ok(store.agents.gpt.events.length<=60);
        assert.ok(JSON.stringify(runtimeStore.load(slot)).length<100000);
    }
    assert.ok(calls-startCalls<=3,'No duplicate decision storm during soak');
    assert.ok(packets.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));
});
