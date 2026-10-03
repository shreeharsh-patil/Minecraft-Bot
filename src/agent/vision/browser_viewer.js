import settings from '../settings.js';

export async function addBrowserViewer(bot, count_id) {
    if (settings.render_bot_view) {
        const { default: viewer } = await import('prismarine-viewer');
        viewer.mineflayer(bot, { port: 3000+count_id, firstPerson: true, });
    }
}
