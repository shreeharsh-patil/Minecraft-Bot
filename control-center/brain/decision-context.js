// Fit public planning context to the normal allowance, not the emergency reserve.
// Essential player state stays intact; older observations are the first to go.
const RULES = 'Play survival proactively: craft tools, food/light, shelter, explore and upgrade. Use inventory before gathering more. Choose 3-8 feasible steps; healthy players must not idle. Avoid cliffs, weak combat and repeated failures. Cooperate in short public chat. Return ONLY JSON: {current_goal,decision_summary,plan:[{command:"!name",args:[]}],message?}. Use exact item IDs from observations: "planks" and "log" are INVALID. Craft counts are recipe repetitions. 1 spruce_log -> 4 spruce_planks; 4 planks -> crafting_table; 2 planks -> 4 stick; 3 planks + 2 stick + table -> wooden_pickaxe; 3 cobblestone + 2 stick + table -> stone_pickaxe; 8 cobblestone + table -> furnace. Make table before tools. All command arguments required. !explore takes 4-24 blocks. !buildShelter needs 55 inventory building blocks and flat ground; add door/light/bed afterward. Empty plans only for immediate danger. Commands:\n';

export function decisionMessages(context, catalog, maxBytes = 4608) {
    const state = structuredClone(context);
    const commands = String(catalog).split('\n').map(line=>line.split(' — ')[0]).join('\n');
    const messages = [{role:'system',content:RULES+commands},{role:'user',content:''}];
    const fits = () => {
        messages[1].content=JSON.stringify(state);
        return Buffer.byteLength(JSON.stringify(messages),'utf8')<=maxBytes;
    };
    if (fits()) return messages;
    // Remove oldest redundant history before losing current observations.
    for (const field of ['memory','events','chat','visited']) {
        while (state[field]?.length) { state[field].shift(); if(fits()) return messages; }
        delete state[field];
    }
    delete state.objective; // The concise survival objective is in the system message.
    if(fits()) return messages;
    for (const [field,minimum] of [['peers',2],['blocks',3],['craftable',3],['woodRecipes',1]]) {
        while(state.world?.[field]?.length>minimum) {state.world[field].pop();if(fits()) return messages;}
    }
    while(state.failures?.length>1) {state.failures.shift();if(fits()) return messages;}
    delete state.previousAction;
    if(fits()) return messages;
    // Never silently discard inventory, health, position or the latest failure.
    throw new Error('Planning context cannot fit the normal API allowance; check configured token limits.');
}
