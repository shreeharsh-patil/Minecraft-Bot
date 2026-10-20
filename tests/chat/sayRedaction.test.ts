/**
 * The `say` skill and the redaction gate.
 *
 * `say` posts straight to the facade, so it never passes through the
 * responder layer. The skill therefore has to run the message through the
 * documented gate (safeChatReply) itself: a model-composed reply must never
 * carry a filesystem path, a token or a key into public chat.
 */
import { describe, expect, it } from 'vitest';
import { createSaySkill } from '../../src/skills/basic/say.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { REDACTED } from '../../src/utils/redact.js';

describe('SaySkill - the redaction gate', () => {
  it('does not post a filesystem path verbatim', async () => {
    const facade = new FakeMinecraftFacade();

    const result = await createSaySkill(facade).execute({
      message: 'I read C:\\Users\\bot\\data\\memory.json for you',
    });

    expect(result.ok).toBe(true);
    expect(facade.chatMessages).toHaveLength(1);
    const sent = facade.chatMessages[0] ?? '';
    expect(sent).not.toContain('Users');
    expect(sent).not.toContain('memory.json');
    expect(sent).toContain('[path redacted]');
  });

  it('does not post a JWT verbatim', async () => {
    const facade = new FakeMinecraftFacade();
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';

    await createSaySkill(facade).execute({ message: `here you go: ${jwt}` });

    const sent = facade.chatMessages[0] ?? '';
    expect(sent).not.toContain(jwt);
    expect(sent).toContain(REDACTED);
  });

  it('does not post a provider key verbatim', async () => {
    const facade = new FakeMinecraftFacade();

    await createSaySkill(facade).execute({
      message: 'my key is gsk_abcdefghijklmnopqrstuvwxyz012345',
    });

    const sent = facade.chatMessages[0] ?? '';
    expect(sent).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz012345');
    expect(sent).toContain(REDACTED);
  });

  it('does not post a server address verbatim', async () => {
    const facade = new FakeMinecraftFacade();

    await createSaySkill(facade).execute({ message: 'connected to 192.168.0.5:25565' });

    expect(facade.chatMessages[0] ?? '').not.toContain('192.168.0.5');
  });

  it('posts an ordinary message unchanged', async () => {
    const facade = new FakeMinecraftFacade();

    const result = await createSaySkill(facade).execute({ message: 'Done! I mined 16 oak logs.' });

    expect(result.ok).toBe(true);
    expect(facade.chatMessages).toEqual(['Done! I mined 16 oak logs.']);
  });

  it('keeps the line inside the server limit', async () => {
    const facade = new FakeMinecraftFacade();

    await createSaySkill(facade).execute({ message: 'x'.repeat(1_000) });

    expect((facade.chatMessages[0] ?? '').length).toBeLessThanOrEqual(256);
  });
});
