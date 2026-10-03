import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { observeWorld, installSafeMovement, shelterLayout, findShelterSite, createGameplayCommands } from '../brain/gameplay.js';
import { AgentRuntime, parsePlan } from '../brain/runtime.js';
import { requestCloud } from '../brain/transport.js';
import { RequestBudgetManager } from '../brain/budget.js';
import { decisionMessages } from '../brain/decision-context.js';

const block=(name,position,solid=false)=>({name,position,boundingBox:solid?'block':'empty'});
function flatBot() {
    return {entity:{position:new Vec3(0,64,0)},entities:{},blockAt:p=>block(p.y<64?'stone':'air',p,p.y<64),inventory:{items:()=>[{name:'cobblestone',count:55}]}};
}
function runtimeFixture(overrides={}) {
    const executed=[],bot={...flatBot(),health:20,food:20,game:{dimension:'overworld'},clearControlStates(){},players:{}};
    const agent={name:'ARENA_GPT',bot,actions:{executing:false,cancelResume(){}},history:{add:async()=>{},turns:[],memory:''},memory_bank:{getJson:()=>({})},requestInterrupt(){},arenaBrainClient:{cancel(){},request:async()=>({text:JSON.stringify({current_goal:'Make tools',decision_summary:'Craft basic tools.',plan:[{command:'!craftRecipe',args:['oak_planks',1]},{command:'!craftRecipe',args:['crafting_table',1]},{command:'!craftRecipe',args:['stick',1]}]})})}};
    const commands={catalog:'!craftRecipe(item:string,num:int)',parseCommandMessage:s=>({commandName:s.split('(')[0],args:[]}),executeCommand:async(_a,s)=>{executed.push(s);return 'Crafted';},...overrides};
    const runtime=new AgentRuntime(agent,{slot:{id:'gpt',minecraftName:'ARENA_GPT',objective:'Survive and build'},brain:{model:'gpt-oss-120b'},brainSettings:{}},()=>{},commands);
    runtime.bot=bot;runtime.ready=true;
    return {runtime,agent,bot,executed};
}

test('structured plan steps preserve quoted item names and numeric recipe counts',()=>{
    let received;
    const result=parsePlan(JSON.stringify({current_goal:'Tools',decision_summary:'Make planks.',plan:[{command:'!craftRecipe',args:['spruce_planks',2]}]}),s=>{received=s;return {commandName:'!craftRecipe',args:['spruce_planks',2]};});
    assert.equal(received,'!craftRecipe("spruce_planks",2)');assert.deepEqual(result.plan,[received]);
});
test('observations include actual local wood, inventory-based recipes and nearby players',()=>{
    const bot=flatBot(),wood=new Vec3(2,64,0);
    bot.registry={blocksByName:{spruce_log:{id:1,name:'spruce_log'}},itemsByName:{spruce_planks:{id:2},crafting_table:{id:3}}};
    bot.findBlocks=()=>[wood];bot.blockAt=p=>block('spruce_log',p,true);
    bot.inventory.items=()=>[{name:'spruce_log',count:2}];
    bot.recipesFor=id=>id===2?[{}]:[];bot.entities={friend:{username:'ARENA_NEMOTRON',position:wood}};
    const observed=observeWorld(bot);
    assert.equal(observed.blocks[0].name,'spruce_log');assert.deepEqual(observed.craftable,['spruce_planks']);
    assert.equal(observed.peers[0].name,'ARENA_NEMOTRON');assert.equal(observed.hasTable,false);
    assert.deepEqual(observed.woodRecipes,[{input:'spruce_log',output:'spruce_planks',inputCount:1,outputCount:4}]);
    bot.inventory.items=()=>[];
    const emptyInventory=observeWorld(bot);
    assert.deepEqual(emptyInventory.woodRecipes,observed.woodRecipes);
});
test('every new pathfinder movement profile retains short drops and no parkour',()=>{
    let applied;
    const bot={pathfinder:{movements:{maxDropDown:4},setMovements:m=>{applied=m;}}};
    installSafeMovement(bot);installSafeMovement(bot);
    assert.equal(bot.pathfinder.movements.maxDropDown,1);
    bot.pathfinder.setMovements({maxDropDown:99,allowParkour:true});
    assert.equal(applied.maxDropDown,1);assert.equal(applied.allowParkour,false);assert.equal(applied.infiniteLiquidDropdownDistance,false);
});
test('shelter layout has supported walls, a roof and a two-block exit',()=>{
    const c=new Vec3(0,64,0),plan=shelterLayout(c);
    assert.equal(plan.length,55);assert.equal(new Set(plan.map(p=>p.toString())).size,55);
    assert.ok(!plan.some(p=>p.x===0&&p.z===-2&&p.y<66));
    assert.equal(plan.filter(p=>p.y===66).length,25);
    const placed=new Set();for(const p of plan){assert.ok(p.y===64 || [p.offset(0,-1,0),p.offset(1,0,0),p.offset(-1,0,0),p.offset(0,0,1),p.offset(0,0,-1)].some(n=>placed.has(n.toString())));placed.add(p.toString());}
});
test('shelter selection refuses cliffs, liquids, unloaded blocks and occupied sites',()=>{
    assert.ok(findShelterSite(flatBot()));
    for(const terrain of ['air','lava',null]) {const bot=flatBot();bot.blockAt=p=>p.y<64?(terrain?block(terrain,p,terrain==='lava'):null):block('air',p);assert.equal(findShelterSite(bot),null);}
    const bot=flatBot();bot.entities={player:{position:new Vec3(0,64,0)}};
    const site=findShelterSite(bot);assert.ok(site && (Math.abs(site.x)>=3||Math.abs(site.z)>=3));
});
test('shelter skill consumes only inventory blocks through normal placement and records completion',async()=>{
    const bot=flatBot(),placed=[];let remaining=55;
    bot.inventory.items=()=>remaining?[{name:'cobblestone',count:remaining}]:[];
    bot.blockAt=p=>block(placed.some(v=>v.equals(p))||p.y<64?'stone':'air',p,placed.some(v=>v.equals(p))||p.y<64);
    const agent={bot,arenaRuntime:{data:{}},actions:{runAction:async(_label,fn)=>({message:String(await fn())})}};
    const commands=createGameplayCommands({},[],{goToGoal:async()=>true,placeBlock:async(_bot,_name,x,y,z,_face,dontCheat)=>{assert.equal(dontCheat,true);placed.push(new Vec3(x,y,z));remaining--;return true;},log(){}},{goals:{GoalNear:class {}}});
    await commands.executeCommand(agent,'!buildShelter()');assert.equal(placed.length,55);assert.equal(remaining,0);assert.ok(agent.arenaRuntime.data.shelter);
});
test('shelter interruption does not report a completed structure',async()=>{
    const bot=flatBot();bot.interrupt_code=true;
    const agent={bot,arenaRuntime:{data:{}},actions:{runAction:async(_label,fn)=>({message:String(await fn())})}};
    const commands=createGameplayCommands({},[],{goToGoal:async()=>true,placeBlock:async()=>assert.fail('placement after interrupt'),log(){}},{goals:{GoalNear:class {}}});
    assert.equal(await commands.executeCommand(agent,'!buildShelter()'),'false');assert.equal(agent.arenaRuntime.data.shelter,undefined);
});
test('a valid multi-step crafting plan continues without another model request between steps',async()=>{
    const {runtime,executed}=runtimeFixture();await runtime.tick();
    await runtime.tick();runtime.lastRequest=Date.now()-700000;await runtime.tick();await runtime.tick();
    assert.equal(executed.length,3);assert.equal(runtime.data.planIndex,3);assert.equal(runtime.requested,3);
});

test('a healthy bot requests the next plan after completion without a hit or chat event',async()=>{
    const {runtime,agent,executed}=runtimeFixture();
    const priorities=[];const request=agent.arenaBrainClient.request;
    agent.arenaBrainClient.request=async(messages,priority)=>{priorities.push(priority);return request(messages,priority);};
    await runtime.tick();await runtime.tick();await runtime.tick();await runtime.tick();
    runtime.lastRequest=Date.now()-11000;
    await runtime.tick();await runtime.tick();
    assert.equal(executed.length,4);assert.deepEqual(priorities,[4,3]);assert.equal(runtime.data.planIndex,1);
});

test('long planning history fits normal 8K TPM allowance without dropping player inventory or latest failure',()=>{
    const {runtime}=runtimeFixture();
    const context=runtime.context();
    context.memory=Array(24).fill('Old history '+ '木'.repeat(200));
    context.events=Array(10).fill('Repeated event '+ 'x'.repeat(200));
    context.chat=Array(5).fill({from:'ARENA_OTHER',text:'x'.repeat(300)});
    context.player.inventory={spruce_log:12,crafting_table:1,stone_pickaxe:1,cobblestone:55};
    context.failures=[{command:'!collectBlocks("stone",20)',reason:'No safe path; explore another location.'}];
    context.world={blocks:Array.from({length:12},(_,i)=>({name:'spruce_log',at:[i,64,i],distance:i})),woodRecipes:[{input:'spruce_log',output:'spruce_planks',inputCount:1,outputCount:4}]};
    const catalog=[...Array(20)].map((_,i)=>`!command${i}(item:string,count:number)`).join('\n');
    const maxBytes=8000*0.8-1536-256;
    const messages=decisionMessages(context,catalog,maxBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(messages))<=maxBytes);
    const sent=JSON.parse(messages[1].content);
    assert.deepEqual(sent.player,context.player);assert.deepEqual(sent.failures,context.failures);
    assert.ok(sent.world.blocks.length>=3);assert.deepEqual(sent.world.woodRecipes,context.world.woodRecipes);
    assert.equal(context.memory.length,24,'compaction must not delete persistent memories');
});
test('failed actions invalidate the plan, preserve cause and block identical retries',async()=>{
    const {runtime,agent,executed}=runtimeFixture({executeCommand:async()=>{agent.arenaLastOutcome='action_failed';executed.push('attempt');return 'Missing crafting table';}});
    runtime.data.plan=['!craftRecipe("wooden_pickaxe",1)'];await runtime.step();
    assert.equal(runtime.data.planInvalid,true);assert.match(runtime.data.failures[0].reason,/table/);
    runtime.data.planInvalid=false;await runtime.step();assert.equal(executed.length,1);
});
test('healthy empty plans cause a bounded replan, not ten minutes of idle',async()=>{
    const {runtime,agent}=runtimeFixture();agent.arenaBrainClient.request=async()=>({text:JSON.stringify({current_goal:'Idle',decision_summary:'Full health.',plan:[]})});
    await runtime.tick();assert.equal(runtime.requested,2);assert.match(runtime.data.events.at(-1).text,/progression/);
});
test('real chat enters context once while repetitive mode chatter is ignored',async()=>{
    const {runtime}=runtimeFixture();await runtime.message('ARENA_GEMINI','I can supply wood.');await runtime.message('ARENA_GEMINI','I can supply wood.');
    await runtime.message('ARENA_GEMINI','Picking up item! ');
    assert.equal(runtime.context().chat.length,1);assert.equal(runtime.context().chat[0].text,'I can supply wood.');
});
test('provider options reduce reasoning and request JSON only for actual plans',async()=>{
    const bodies=[];const fetchImpl=async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));};
    const route={model:'openai/gpt-oss-120b',reasoningEffort:'low',jsonMode:true};const provider={api:'openai',url:'https://test.example/v1'};
    await requestCloud(route,provider,'secret',[],{maxOutputTokens:1536,json:true,fetchImpl});
    await requestCloud(route,provider,'secret',[],{maxOutputTokens:1536,fetchImpl});
    assert.equal(bodies[0].reasoning_effort,'low');assert.deepEqual(bodies[0].response_format,{type:'json_object'});assert.equal(bodies[1].response_format,undefined);
});
test('truncated provider JSON is rejected before execution',async()=>{
    await assert.rejects(()=>requestCloud({model:'x'},{api:'openai',url:'https://test.example/v1'},'secret',[],{maxOutputTokens:128,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'{"plan":['},finish_reason:'length'}]}))}),/truncated/);
});
test('expired sessions renew local allocation without clearing daily usage or provider blocks',()=>{
    let now=0;
    const limits={sessionRequests:2,sessionTokens:100,requestsPerMinute:10,requestsPerHour:10,requestsPerDay:1,tokensPerMinute:1000,tokensPerHour:1000,tokensPerDay:1000,minIntervalMs:1};
    const quota={sessionHours:6,normalBudgetPercent:80,emergencyReservePercent:20};
    const manager=new RequestBudgetManager(limits,quota,{},()=>now);
    const row=manager.reserve(10,1);assert.ok(row);
    now=6*3600000+1;manager.headerBlockUntil=now+1000;
    const permit=manager.inspect(10,1);
    assert.equal(manager.sessionRequests,0);assert.equal(manager.records.length,1);
    assert.equal(permit.allowed,false);assert.equal(permit.retryAt,86400001);
    manager.reconcile(row,20);assert.equal(manager.sessionTokens,0);assert.equal(manager.records[0].tokens,20);
    assert.equal(manager.headerBlockUntil,now+1000);
});
test('mining cannot remove the ground directly under the player',async()=>{
    const bot=flatBot();let dug=false;bot.pathfinder={setMovements(){}};bot.dig=async()=>{dug=true;};
    installSafeMovement(bot);
    await assert.rejects(()=>bot.dig(block('stone',new Vec3(0,63,0),true)),/underneath/);assert.equal(dug,false);
    await bot.dig(block('stone',new Vec3(1,64,0),true));assert.equal(dug,true);
});
test('measured tokens release excess session reservation but retain minute throttle and unknown usage',()=>{
    let now=1000;
    const limits={sessionRequests:20,sessionTokens:10000,requestsPerMinute:20,requestsPerHour:20,requestsPerDay:20,tokensPerMinute:1000,tokensPerHour:10000,tokensPerDay:10000,minIntervalMs:1};
    const manager=new RequestBudgetManager(limits,{sessionHours:6,normalBudgetPercent:80,emergencyReservePercent:20},{},()=>now);
    const row=manager.reserve(900,1);manager.reconcile(row,100);
    assert.equal(manager.sessionTokens,100);assert.equal(manager.snapshot().rolling.hour.tokens,100);assert.equal(manager.snapshot().rolling.minute.tokens,900);
    now+=10;assert.equal(manager.inspect(200,1).allowed,false);
    manager.reconcile(row,100);assert.equal(manager.sessionTokens,100);
    now+=60000;const unknown=manager.reserve(300,1);manager.reconcile(unknown,null);assert.equal(manager.sessionTokens,400);
});
