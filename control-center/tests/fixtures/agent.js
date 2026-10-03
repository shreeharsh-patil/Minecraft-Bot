// TEST FIXTURE ONLY. Production launchers never import or select this worker.
let timer;
const emit = (type, payload) => process.send?.({ kind: 'event', type, payload });
process.on('message', message => {
    if (message.kind === 'init') {
        emit('agent_connected', { version: 'TEST_FIXTURE' });
        emit('health_changed', { health: 20 }); emit('hunger_changed', { hunger: 17 });
        timer = setInterval(() => emit('position_updated', { position: { x: 1, y: 64, z: 2 }, distance: 0 }), 500);
    }
    if (message.command === 'pause') emit('agent_status', { status: 'paused' });
    if (message.command === 'resume') emit('agent_status', { status: 'online' });
    if (message.command === 'stop') { clearInterval(timer); process.exit(0); }
});
process.on('disconnect', () => process.exit(0));
