import net from 'node:net';
export function checkMinecraft({ host, port }, timeout = 1500) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: host === 'localhost' ? '127.0.0.1' : host, port });
        const finish = available => { socket.destroy(); resolve({ available, host, port, message: available ? 'Minecraft LAN port detected' : `Minecraft LAN world not detected on ${host}:${port}. Open your Minecraft world to LAN and try again.` }); };
        socket.setTimeout(timeout, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}
