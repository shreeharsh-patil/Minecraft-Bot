import { createArena } from './backend/server.js';
try {
    const args = process.argv.slice(2);
    const count = args.includes('--test') ? 1 : Number(args.find(a => a.startsWith('--agents='))?.split('=')[1] || 4);
    if (![1, 2, 3, 4].includes(count)) throw new Error('Choose --agents=1, 2, 3 or 4.');
    const arena = await createArena({ autoStart: !args.includes('--no-agents'), limit: count });
    console.log(`TECH GPT — AI ARENA\n${arena.url}\n${arena.state().minecraft.message}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => arena.close().then(() => process.exit(0)));
    if (!args.includes('--no-open')) {
        const { default: open } = await import('open');
        await open(arena.url);
    }
} catch (error) { console.error(`Arena could not start: ${error.code === 'EADDRINUSE' ? 'Dashboard port is already in use. Open the existing dashboard or run STOP_AI_ARENA.bat.' : error.message}`); process.exitCode = 1; }
