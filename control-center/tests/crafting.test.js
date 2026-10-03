import test from 'node:test';
import assert from 'node:assert/strict';
import {Vec3} from 'vec3';
import {craftWithPrerequisites,placeWorkstation} from '../brain/gameplay.js';

function fixture(initial={}) {
    const inventory={...initial},placed=new Map(),calls=[];
    const names=['oak_log','oak_planks','spruce_log','spruce_planks','stick','crafting_table','wooden_pickaxe','stone_pickaxe','cobblestone','stone'];
    const registry={itemsByName:Object.fromEntries(names.map((name,id)=>[name,{name,id}])),blocksByName:{oak_log:{id:0,name:'oak_log'},crafting_table:{id:5,name:'crafting_table'},stone:{id:9,name:'stone'}}};
    const block=(name,p)=>({name,position:p,boundingBox:name==='air'?'empty':'block'});
    const bot={registry,entity:{position:new Vec3(0.5,64,0.5)},entities:{},interrupt_code:false,
        inventory:{items:()=>Object.entries(inventory).filter(([,count])=>count>0).map(([name,count])=>({name,count}))},
        blockAt:p=>block(placed.get(p.toString()) || (p.y<64?'stone':p.equals(new Vec3(3,64,3))?'oak_log':'air'),p),
        findBlocks:({matching})=>matching.includes(0)?[new Vec3(3,64,3)]:matching.includes(5)?[...placed.keys()].filter(key=>placed.get(key)==='crafting_table').map(key=>{
            const values=key.replace(/[()]/g,'').split(',').map(Number);return new Vec3(...values);
        }):[],
        recipesFor:(id,_metadata,_count,table)=>{
            const name=names[id];const wood=['oak_planks','spruce_planks'].find(n=>(inventory[n] || 0)>0) || 'oak_planks';
            const recipe=name.endsWith('_planks')?{need:{[name.replace('_planks','_log')]:1},out:4}:
                name==='stick'?{need:{[wood]:2},out:4}:
                name==='crafting_table'?{need:{[wood]:4},out:1}:
                name==='wooden_pickaxe'?{need:{[wood]:3,stick:2},out:1,table:true}:
                name==='stone_pickaxe'?{need:{cobblestone:3,stick:2},out:1,table:true}:null;
            return recipe && (!recipe.table || table) && Object.entries(recipe.need).every(([n,c])=>(inventory[n] || 0)>=c)?[{...recipe,name}]:[];
        },
        craft:async(recipe,num,table)=>{
            assert.ok(!recipe.table || table?.name==='crafting_table');
            for(const [name,count] of Object.entries(recipe.need)){assert.ok((inventory[name] || 0)>=count*num);inventory[name]-=count*num;}
            inventory[recipe.name]=(inventory[recipe.name] || 0)+recipe.out*num;calls.push(['craft',recipe.name,num]);
        }};
    const skills={log(){},collectBlock:async(_bot,name,num)=>{calls.push(['collect',name,num]);const item=name==='stone'?'cobblestone':name;inventory[item]=(inventory[item] || 0)+num;return true;},
        placeBlock:async(_bot,name,x,y,z,_side,noCheats)=>{assert.equal(noCheats,true);calls.push(['place',name]);assert.ok(inventory[name]>0);inventory[name]--;placed.set(new Vec3(x,y,z).toString(),name);return true;}};
    return {bot,skills,inventory,placed,calls};
}

test('one wooden pickaxe command gathers a sufficient complete bill of materials and crafts it',async()=>{
    const f=fixture();assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',1,f.skills),true);
    assert.equal(f.inventory.wooden_pickaxe,1);assert.equal(f.calls.filter(c=>c[0]==='collect').length,1);
    assert.deepEqual(f.calls.find(c=>c[0]==='collect'),['collect','oak_log',3]);
    assert.ok(f.calls.findIndex(c=>c[1]==='crafting_table')<f.calls.findIndex(c=>c[1]==='wooden_pickaxe'));
});

test('craft preparation uses held spruce and an existing table instead of collecting assumed oak',async()=>{
    const f=fixture({spruce_log:2,crafting_table:1,stick:4});
    assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',1,f.skills),true);
    assert.equal(f.inventory.wooden_pickaxe,1);assert.equal(f.calls.some(c=>c[0]==='collect'),false);
});

test('stone tool preparation first builds a real mining tool then collects stone',async()=>{
    const f=fixture();assert.equal(await craftWithPrerequisites(f.bot,'stone_pickaxe',1,f.skills),true);
    assert.equal(f.inventory.stone_pickaxe,1);
    assert.ok(f.calls.findIndex(c=>c[1]==='wooden_pickaxe')<f.calls.findIndex(c=>c[1]==='stone'));
});

test('failed gathering stops preparation without falsely reporting a crafted item',async()=>{
    const f=fixture();let attempts=0;f.skills.collectBlock=async()=>{attempts++;return false;};
    assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',1,f.skills),false);
    assert.equal(attempts,1);assert.equal(f.inventory.wooden_pickaxe,undefined);
});

test('unconfirmed workstation placement has four bounded attempts and never crafts without a table',async()=>{
    const f=fixture({oak_planks:3,stick:2,crafting_table:1});let attempts=0;
    f.skills.placeBlock=async()=>{attempts++;return true;};
    assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',1,f.skills),false);
    assert.equal(attempts,4);assert.equal(f.inventory.wooden_pickaxe,undefined);
});

test('paused/interrupted and excessive crafting batches perform no preparation',async()=>{
    const f=fixture();f.bot.interrupt_code=true;
    assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',1,f.skills),false);
    f.bot.interrupt_code=false;assert.equal(await craftWithPrerequisites(f.bot,'wooden_pickaxe',17,f.skills),false);
    assert.deepEqual(f.calls,[]);
});

test('workstation placement refuses unsupported ground rather than carving into it',async()=>{
    const f=fixture({crafting_table:1});f.bot.blockAt=p=>({name:'air',position:p,boundingBox:'empty'});
    assert.equal(await placeWorkstation(f.bot,'crafting_table',f.skills),false);assert.deepEqual(f.calls,[]);
});
