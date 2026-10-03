// Shared observations and motor skills. Strategy remains with each cloud model.
const useful = /(_log|_stem|_ore|_leaves|_planks)$|^(stone|cobblestone|coal|crafting_table|furnace|water|wheat|carrots|potatoes|sweet_berry_bush)$/;
const dangerous = /lava|fire|magma|cactus|campfire|powder_snow/;
const empty = b => b && ['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'fern', 'snow'].includes(b.name);
const solid = b => b?.boundingBox === 'block' && !dangerous.test(b.name);
const buildingMaterial = name => /_planks$/.test(name) || ['cobblestone', 'dirt', 'stone', 'cobbled_deepslate'].includes(name);
export const CORE_COMMANDS = new Set(['!collectBlocks','!craftRecipe','!smeltItem','!searchForBlock','!searchForEntity','!goToPlayer','!givePlayer','!consume','!equip','!attack','!goToBed','!placeHere','!putInChest','!takeFromChest','!viewChest','!moveAway','!goToSurface','!useOn','!clearFurnace']);

export function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory?.items?.() || []) counts[item.name] = (counts[item.name] || 0) + item.count;
    return counts;
}

export async function placeWorkstation(bot, name, skills) {
    if(!inventoryCounts(bot)[name]) {skills.log(bot,`No ${name} in inventory.`);return false;}
    const origin=bot.entity.position.floored();let attempts=0;
    placement: for(const radius of [2,3]) for(const dy of [0,-1,1]) for(const [dx,dz] of [[radius,0],[-radius,0],[0,radius],[0,-radius]]) {
        if(bot.interrupt_code) return false;
        const p=origin.offset(dx,dy,dz);
        if(!empty(bot.blockAt(p)) || !solid(bot.blockAt(p.offset(0,-1,0)))) continue;
        if(Object.values(bot.entities || {}).some(e=>e.position && Math.abs(e.position.x-p.x-0.5)<0.9 && Math.abs(e.position.z-p.z-0.5)<0.9 && Math.abs(e.position.y-p.y)<2)) continue;
        const placed=await skills.placeBlock(bot,name,p.x,p.y,p.z,'bottom',true);
        if(bot.blockAt(p)?.name===name) return true;
        if(placed) skills.log(bot,'Placement was not confirmed in the world.');
        if(++attempts>=4) break placement;
    }
    skills.log(bot,`No supported reachable space for ${name}; move to clear ground.`);return false;
}

const basicCrafts={
    stick:{planks:2},crafting_table:{planks:4},chest:{planks:8,table:true},
    wooden_pickaxe:{planks:3,sticks:2,table:true},wooden_axe:{planks:3,sticks:2,table:true},wooden_sword:{planks:2,sticks:1,table:true},
    stone_pickaxe:{stone:3,sticks:2,table:true},stone_axe:{stone:3,sticks:2,table:true},stone_sword:{stone:2,sticks:1,table:true},furnace:{stone:8,table:true}
};

export async function craftWithPrerequisites(bot, name, repetitions, skills, budget={logs:8,stone:24}) {
    const spec=basicCrafts[name];
    if(bot.interrupt_code || !spec || !Number.isInteger(repetitions) || repetitions<1 || repetitions>16) return false;
    const counts=()=>inventoryCounts(bot);
    const planks=()=>Object.entries(counts()).filter(([n])=>n.endsWith('_planks')).reduce((sum,[,v])=>sum+v,0);
    const table=()=>{
        const id=bot.registry?.blocksByName?.crafting_table?.id;
        if(id===undefined) return null;
        return bot.findBlocks({matching:[id],maxDistance:6,count:4}).map(p=>bot.blockAt(p)).find(b=>b?.name==='crafting_table') || null;
    };
    const craft=async(item,num,workbench=null)=>{
        if(bot.interrupt_code) return false;
        const id=bot.registry?.itemsByName?.[item]?.id;
        const recipe=id===undefined ? null : bot.recipesFor(id,null,1,workbench)[0];
        if(!recipe) {skills.log(bot,`Missing ingredients or workstation for ${item}.`);return false;}
        const before=counts()[item] || 0;
        await bot.craft(recipe,num,workbench);
        return (counts()[item] || 0)>before;
    };
    // Prepare the complete bill of materials once, rather than spending a cloud
    // request for each missing stick, plank or workbench.
    if(spec.stone && (counts().cobblestone || 0)<spec.stone*repetitions) {
        if(!Object.keys(counts()).some(n=>n.endsWith('_pickaxe'))) {
            if(!await craftWithPrerequisites(bot,'wooden_pickaxe',1,skills,budget)) return false;
        }
        const missing=spec.stone*repetitions-(counts().cobblestone || 0);
        if(missing>budget.stone) {skills.log(bot,'Craft preparation needs too much stone; choose a smaller batch.');return false;}
        budget.stone-=missing;
        await skills.collectBlock(bot,'stone',missing);
        if(bot.interrupt_code || (counts().cobblestone || 0)<spec.stone*repetitions) return false;
    }
    const sticks=Math.ceil(Math.max(0,(spec.sticks || 0)*repetitions-(counts().stick || 0))/4);
    const needTable=spec.table && !counts().crafting_table && !table();
    const needed=(spec.planks || 0)*repetitions+sticks*2+(needTable ? 4 : 0);
    for(const [log,count] of Object.entries(counts()).filter(([n])=>/_(log|stem)$/.test(n))) {
        if(planks()>=needed) break;
        if(!await craft(log.replace(/_(log|stem)$/,'_planks'),Math.min(count,Math.ceil((needed-planks())/4)))) return false;
    }
    if(planks()<needed) {
        const wood=observeWorld(bot).woodRecipes[0];const missing=Math.ceil((needed-planks())/4);
        if(!wood || missing>budget.logs) {skills.log(bot,'Craft preparation needs nearby wood or a smaller batch.');return false;}
        budget.logs-=missing;await skills.collectBlock(bot,wood.input,missing);
        if(bot.interrupt_code || (counts()[wood.input] || 0)<missing || !await craft(wood.output,missing)) return false;
    }
    if(needTable && !await craft('crafting_table',1)) return false;
    if(sticks && !await craft('stick',sticks)) return false;
    let workbench=spec.table ? table() : null;
    if(spec.table && !workbench) {
        if(!await placeWorkstation(bot,'crafting_table',skills)) return false;
        workbench=table();
        if(!workbench) return false;
    }
    if(workbench && bot.entity.position.distanceTo(workbench.position)>4) {
        await skills.goToNearestBlock(bot,'crafting_table',3,6);
        if(bot.interrupt_code || bot.entity.position.distanceTo(workbench.position)>4.5) return false;
    }
    const result=await craft(name,repetitions,workbench);
    skills.log(bot,result ? `Crafted ${name}; prerequisites prepared using normal inventory and gathering.` : `Could not craft ${name}.`);
    return result;
}

export function observeWorld(bot) {
    const origin = bot.entity?.position;
    if (!origin) return {};
    const counts = inventoryCounts(bot), blocks = [];
    if (bot.findBlocks && bot.registry?.blocksByName) {
        // Separate resources from common terrain so dirt/stone cannot hide nearby wood.
        for (const group of [/(_log|_stem)$/, /_ore$|^(stone|cobblestone)$/, /^(crafting_table|furnace|water|wheat|carrots|potatoes|sweet_berry_bush)$/]) {
            const ids = Object.values(bot.registry.blocksByName).filter(b => useful.test(b.name) && group.test(b.name)).map(b => b.id);
            if (!ids.length) continue;
            for (const pos of bot.findBlocks({ matching: ids, maxDistance: 24, count: 16 })) {
                const b = bot.blockAt(pos);
                if (b && !blocks.some(v => v.name === b.name)) blocks.push({name:b.name,at:[pos.x,pos.y,pos.z],distance:Math.round(origin.distanceTo(pos))});
            }
        }
    }
    const tableBlock = blocks.find(b => b.name === 'crafting_table');
    const hasTable = !!counts.crafting_table || !!tableBlock;
    const names = Object.keys(counts);
    // Include recipes for nearby wood before it is collected, so an empty inventory
    // does not lead the model to invent the invalid generic item "planks".
    const woodRecipes = [...new Set([...names, ...blocks.map(b => b.name)])]
        .filter(n => /_(log|stem)$/.test(n))
        .map(input => ({input,output:input.replace(/_(log|stem)$/, '_planks'),inputCount:1,outputCount:4}))
        .filter(r => bot.registry?.itemsByName?.[r.output]);
    const candidates = ['crafting_table','stick','wooden_pickaxe','stone_pickaxe','stone_axe','stone_sword','furnace','torch','chest','bread','iron_pickaxe','iron_sword','shield','bucket','white_bed'];
    for (const name of names.filter(n => /(_log|_stem)$/.test(n))) candidates.unshift(name.replace(/_(log|stem)$/, '_planks'));
    const craftable = [];
    if (bot.recipesFor) for (const name of [...new Set(candidates)]) {
        const item = bot.registry?.itemsByName?.[name];
        if (item && bot.recipesFor(item.id, null, 1, hasTable).length) craftable.push(name);
    }
    const peers = Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && origin.distanceTo(e.position) <= 24)
        .sort((a,b) => origin.distanceTo(a.position) - origin.distanceTo(b.position)).slice(0,8)
        .map(e => ({name:e.username || e.name,distance:Math.round(origin.distanceTo(e.position))}));
    const biomeId = bot.blockAt?.(origin)?.biome?.id ?? bot.blockAt?.(origin)?.biome;
    return { blocks:blocks.slice(0,12), craftable, woodRecipes, hasTable, peers, dayTime:bot.time?.timeOfDay,
        biome:bot.registry?.biomes?.[biomeId]?.name,
        milestones:{wood:names.some(n => /_(log|planks|stem)$/.test(n)),pickaxe:names.find(n=>/_pickaxe$/.test(n)) || null,furnace:!!counts.furnace || blocks.some(b=>b.name==='furnace'),shelterBlocks:Object.entries(counts).filter(([n])=>buildingMaterial(n)).reduce((n,[,v])=>n+v,0)} };
}

export function installSafeMovement(bot) {
    if (!bot.pathfinder || bot.pathfinder.arenaSafetyInstalled) return;
    const constrain = movements => {
        if (!movements) return movements;
        movements.maxDropDown = 1;
        movements.allowParkour = false;
        movements.allow1by1towers = false;
        movements.allowFreeMotion = false;
        movements.infiniteLiquidDropdownDistance = false;
        movements.dontMineUnderFallingBlock = true;
        return movements;
    };
    const original = bot.pathfinder.setMovements.bind(bot.pathfinder);
    bot.pathfinder.setMovements = movements => original(constrain(movements));
    constrain(bot.pathfinder.movements);
    bot.pathfinder.arenaSafetyInstalled = true;
    if(bot.dig) {
        const dig=bot.dig.bind(bot);
        bot.dig=(block,...args)=>{
            const feet=bot.entity?.position?.floored();
            if(feet && block?.position && block.position.x===feet.x && block.position.z===feet.z && block.position.y<feet.y && block.position.y>=feet.y-1) {
                return Promise.reject(new Error('Move onto supported ground before mining the block underneath you.'));
            }
            return dig(block,...args);
        };
    }
}

export function shelterLayout(center) {
    const positions = [];
    // Small 3x3 interior, two-block doorway, two-high walls and a supported roof.
    for (let y=0;y<2;y++) for (let x=-2;x<=2;x++) for (let z=-2;z<=2;z++) {
        if ((Math.abs(x)===2 || Math.abs(z)===2) && !(x===0 && z===-2)) positions.push(center.offset(x,y,z));
    }
    for (let x=-2;x<=2;x++) for (let z=-2;z<=2;z++) positions.push(center.offset(x,2,z));
    return positions;
}

export function findShelterSite(bot) {
    const origin = bot.entity.position.floored();
    for (let radius=0;radius<=8;radius+=2) for (let dx=-radius;dx<=radius;dx+=2) for (let dz=-radius;dz<=radius;dz+=2) {
        if (Math.max(Math.abs(dx),Math.abs(dz))!==radius) continue;
        const c=origin.offset(dx,0,dz);
        let safe=true;
        for(let x=-2;x<=2 && safe;x++) for(let z=-2;z<=2 && safe;z++) {
            if(!solid(bot.blockAt(c.offset(x,-1,z)))) {safe=false;break;}
            for(let y=0;y<=2;y++) if(!empty(bot.blockAt(c.offset(x,y,z)))) {safe=false;break;}
        }
        // Keep an exit to supported ground; never build over another player.
        if(safe && solid(bot.blockAt(c.offset(0,-1,-3))) && empty(bot.blockAt(c.offset(0,0,-3))) && empty(bot.blockAt(c.offset(0,1,-3))) &&
            !Object.values(bot.entities || {}).some(e=>e!==bot.entity && e.position && Math.abs(e.position.x-c.x)<3 && Math.abs(e.position.z-c.z)<3 && Math.abs(e.position.y-c.y)<3)) return c;
    }
    return null;
}

export function createGameplayCommands(base, actions, skills, pf) {
    const extra = {
        '!explore': {params:1,description:'!explore(distance:number) — travel 4–24 blocks along a verified safe path to new terrain.',run:async(agent,distance)=>{
            const bot=agent.bot, origin=bot.entity.position, visited=agent.arenaRuntime.data.visited || [];
            const targets=[];
            for(let i=0;i<8;i++) for(const dy of [0,1,-1]) {
                const p=origin.floored().offset(Math.round(Math.cos(i*Math.PI/4)*distance),dy,Math.round(Math.sin(i*Math.PI/4)*distance));
                if(!solid(bot.blockAt(p.offset(0,-1,0))) || !empty(bot.blockAt(p)) || !empty(bot.blockAt(p.offset(0,1,0)))) continue;
                targets.push(p);
            }
            targets.sort((a,b)=> Math.min(...visited.map(v=>Math.hypot(b.x-v.x,b.z-v.z)),1000)-Math.min(...visited.map(v=>Math.hypot(a.x-v.x,a.z-v.z)),1000));
            for(const p of targets) {
                if(bot.interrupt_code) return false;
                const moves=new pf.Movements(bot);moves.canDig=false;bot.pathfinder.setMovements(moves);
                const goal=new pf.goals.GoalNear(p.x,p.y,p.z,1);
                const route=bot.pathfinder.getPathTo(moves,goal,250);
                if(route.status!=='success') continue;
                await bot.pathfinder.goto(goal);
                agent.arenaRuntime.data.visited=[...visited,{x:Math.floor(bot.entity.position.x),z:Math.floor(bot.entity.position.z)}].slice(-12);
                skills.log(bot,'Explored new terrain. Reobserve resources before choosing the next destination.');return true;
            }
            skills.log(bot,'No loaded, supported exploration path found. Choose a nearby resource or another route.');return false;
        }},
        '!buildShelter': {params:0,description:'!buildShelter() — build a 5x5 roofed shelter with doorway on nearby flat ground; requires 55 dirt/cobblestone/planks.',run:async agent=>{
            const bot=agent.bot, counts=inventoryCounts(bot);
            if(Object.entries(counts).filter(([n])=>buildingMaterial(n)).reduce((sum,[,n])=>sum+n,0)<55) {skills.log(bot,'Need 55 solid building blocks (dirt, cobblestone, stone or planks) for the shelter.');return false;}
            const center=findShelterSite(bot);
            if(!center) {skills.log(bot,'No clear supported 5x5 shelter site nearby. Explore flatter terrain first.');return false;}
            await skills.goToGoal(bot,new pf.goals.GoalNear(center.x,center.y,center.z,0));
            for(const target of shelterLayout(center)) {
                if(bot.interrupt_code) return false;
                if(!empty(bot.blockAt(target))) {skills.log(bot,'Shelter site changed; stop rather than remove an existing block.');return false;}
                const item=bot.inventory.items().find(i=>buildingMaterial(i.name));
                if(!item) return false;
                if(!await skills.placeBlock(bot,item.name,target.x,target.y,target.z,'bottom',true)) return false;
            }
            agent.arenaRuntime.data.shelter={x:center.x,y:center.y,z:center.z};
            skills.log(bot,'Built a roofed shelter with an open doorway. Add a door, light, workbench and bed before treating it as secure.');return true;
        }}
    };
    const parse = step => {
        const name=step.match(/^!\w+/)?.[0];
        if(!extra[name]) return base.parseCommandMessage(step);
        const match=step.match(/^!\w+\((.*)\)$/);
        if(!match) return 'Use parentheses for this command.';
        let args;try {args=JSON.parse('['+match[1]+']');}catch{return 'Invalid command arguments.';}
        if(args.length!==extra[name].params || (name==='!explore' && (!Number.isFinite(args[0]) || args[0]<4 || args[0]>24))) return 'Explore distance must be 4–24 blocks; buildShelter takes no arguments.';
        return {commandName:name,args};
    };
    return {...base,parseCommandMessage:parse,catalog:actions.filter(c=>CORE_COMMANDS.has(c.name)).map(c=>c.name+'('+Object.entries(c.params || {}).map(([k,p])=>k+':'+p.type).join(',')+')').concat(Object.values(extra).map(v=>v.description)).join('\n'),
        observe:observeWorld,executeCommand:async(agent,step)=>{
            const parsed=parse(step);
            if(typeof parsed==='string') throw new Error(parsed);
            if(parsed.commandName==='!craftRecipe' && basicCrafts[parsed.args[0]]) {
                const fn=()=>craftWithPrerequisites(agent.bot,parsed.args[0],Number(parsed.args[1]),skills);
                fn.arena={command:'craftRecipe',args:parsed.args};
                return (await agent.actions.runAction('action:craftRecipe',fn,{timeout:3,resume:false})).message;
            }
            if(parsed.commandName==='!placeHere' && ['crafting_table','furnace','chest'].includes(parsed.args[0])) {
                const fn=()=>placeWorkstation(agent.bot,parsed.args[0],skills);fn.arena={command:'placeHere',args:parsed.args};
                return (await agent.actions.runAction('action:placeHere',fn,{timeout:1,resume:false})).message;
            }
            if(!extra[parsed.commandName]) return base.executeCommand(agent,step);
            const fn=()=>extra[parsed.commandName].run(agent,...parsed.args);
            fn.arena={command:parsed.commandName.slice(1),args:parsed.args};
            const result=await agent.actions.runAction('action:'+parsed.commandName.slice(1),fn,{timeout:3,resume:false});
            return result.message;
        }};
}
