import { describe, it, expect } from 'vitest';
import {
  chooseSendRoute, toApproval, addApproval, removeApproval, approvalEventType,
  approvalNarration, approvalReplyOutcome, runRefusal, describeRunError,
  IMAGE_PROMPT_PREFIX, isExplicitImagePrompt, toImagePrompt, accessChangeNotice,
  isTextAttachment, clipMiddle, userTextOf, contextMessages, conversationContext, buildRunContext,
  CONTEXT_MAX_MESSAGES
} from './agentRunPolicy.js';

describe('chooseSendRoute', () => {
  it('runs the agent for an agentic effort, whatever else is true', () => {
    expect(chooseSendRoute({ agentic: true, access: 'chat', imageRequest: false })).toBe('agent');
    expect(chooseSendRoute({ agentic: true, access: 'chat', imageRequest: true })).toBe('agent');
    expect(chooseSendRoute({ agentic: true, access: 'bypass', imageRequest: true, explicitImage: true })).toBe('agent');
  });

  it('runs the agent for any access above Chat only', () => {
    for (const access of ['read', 'ask', 'bypass']) {
      expect(chooseSendRoute({ agentic: false, access, imageRequest: false })).toBe('agent');
    }
  });

  it('does not divert troubleshooting that happens to use image words when access is on', () => {
    for (const access of ['read', 'ask', 'bypass']) {
      expect(chooseSendRoute({ agentic: false, access, imageRequest: true })).toBe('agent');
    }
  });

  it('sends an explicit image prompt to the image service at any level', () => {
    for (const access of ['chat', 'read', 'ask', 'bypass']) {
      expect(chooseSendRoute({ agentic: false, access, imageRequest: true, explicitImage: true })).toBe('image');
    }
  });

  it('keeps the image heuristic in Chat only', () => {
    expect(chooseSendRoute({ agentic: false, access: 'chat', imageRequest: true })).toBe('image');
  });

  it('uses plain chat for Chat only and for a missing level', () => {
    expect(chooseSendRoute({ agentic: false, access: 'chat', imageRequest: false })).toBe('chat');
    expect(chooseSendRoute({ agentic: false, access: undefined, imageRequest: false })).toBe('chat');
    expect(chooseSendRoute({ agentic: false, access: '', imageRequest: false })).toBe('chat');
  });
});

describe('image prompts', () => {
  it('spots the prompt the Create image tool writes, in any case', () => {
    expect(isExplicitImagePrompt(`${IMAGE_PROMPT_PREFIX} a red bicycle`)).toBe(true);
    expect(isExplicitImagePrompt('  generate an image of a cat')).toBe(true);
    expect(isExplicitImagePrompt('make a snapshot of running processes')).toBe(false);
    expect(isExplicitImagePrompt('show me which photo folders use the most disk space')).toBe(false);
    expect(isExplicitImagePrompt('please generate an image of x')).toBe(false);
    expect(isExplicitImagePrompt(undefined)).toBe(false);
  });

  it('turns the composer text into an explicit prompt', () => {
    expect(toImagePrompt('')).toBe(`${IMAGE_PROMPT_PREFIX} `);
    expect(toImagePrompt('   ')).toBe(`${IMAGE_PROMPT_PREFIX} `);
    expect(toImagePrompt('a red car')).toBe(`${IMAGE_PROMPT_PREFIX} a red car`);
    expect(toImagePrompt('draw a cat')).toBe(`${IMAGE_PROMPT_PREFIX} a cat`);
    expect(toImagePrompt('Please make me a picture of a sunset')).toBe(`${IMAGE_PROMPT_PREFIX} a sunset`);
    expect(toImagePrompt('Generate an image of a fox')).toBe('Generate an image of a fox');
    expect(toImagePrompt('photosynthesis diagram')).toBe(`${IMAGE_PROMPT_PREFIX} photosynthesis diagram`);
  });

  it('always yields text that routes to the image service', () => {
    for (const t of ['', 'draw a cat', 'a photo of my desk', 'create an image', 'sunset']) {
      expect(isExplicitImagePrompt(toImagePrompt(t))).toBe(true);
    }
  });
});

describe('accessChangeNotice', () => {
  it('says a lower level applies to the live run at once', () => {
    expect(accessChangeNotice('bypass', 'read')).toBe('Read only applies to the run in progress right away.');
    expect(accessChangeNotice('ask', 'chat')).toBe('Chat only applies to the run in progress right away.');
  });

  it('says a higher level waits for the next message', () => {
    expect(accessChangeNotice('read', 'bypass')).toBe('The run in progress keeps Read only. Bypass applies from your next message.');
  });

  it('treats a return to the run level as applying at once', () => {
    expect(accessChangeNotice('ask', 'ask')).toBe('Ask first applies to the run in progress right away.');
  });
});

describe('toApproval', () => {
  const event = {
    type: 'approval-required', at: 1200, approvalId: 'a1', kind: 'command', tool: 'run_command',
    title: 'Run a command', detail: 'brew install wget', reason: 'Not read-only.',
    reasonCode: 'not-read-only', alwaysLabel: 'Always allow `brew install`', network: true,
    alwaysRule: { type: 'command', rule: 'brew install' }, args: { command: 'brew install wget' },
    cwd: '/Users/me/project'
  };

  it('keeps the fields the card shows, including where a command runs', () => {
    expect(toApproval(event)).toEqual({
      approvalId: 'a1', kind: 'command', title: 'Run a command', detail: 'brew install wget',
      reason: 'Not read-only.', reasonCode: 'not-read-only', alwaysLabel: 'Always allow `brew install`',
      network: true, tool: 'run_command', cwd: '/Users/me/project'
    });
  });

  it('needs an id', () => {
    expect(toApproval({ ...event, approvalId: '' })).toBeNull();
    expect(toApproval({ title: 'x' })).toBeNull();
    expect(toApproval(null)).toBeNull();
    expect(toApproval('a1')).toBeNull();
  });

  it('fills safe defaults for missing or odd fields', () => {
    expect(toApproval({ approvalId: 'b', alwaysLabel: '', network: 'yes', title: 7, cwd: 3 })).toEqual({
      approvalId: 'b', kind: 'other', title: '', detail: '', reason: '', reasonCode: '',
      alwaysLabel: null, network: false, tool: '', cwd: ''
    });
  });
});

describe('addApproval and removeApproval', () => {
  const a = toApproval({ approvalId: 'a', title: 'First' });
  const b = toApproval({ approvalId: 'b', title: 'Second' });

  it('keeps arrival order, one entry per id', () => {
    const list = addApproval(addApproval(undefined, a), b);
    expect(list.map((x) => x.approvalId)).toEqual(['a', 'b']);
    const again = addApproval(list, { ...a, title: 'First again' });
    expect(again.map((x) => x.approvalId)).toEqual(['a', 'b']);
    expect(again[0].title).toBe('First again');
  });

  it('removes by id and returns the same array when nothing matches', () => {
    const list = addApproval(addApproval([], a), b);
    expect(removeApproval(list, 'a').map((x) => x.approvalId)).toEqual(['b']);
    expect(removeApproval(list, 'zzz')).toBe(list);
    expect(removeApproval(undefined, 'a')).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const list = addApproval([], a);
    addApproval(list, b);
    removeApproval(list, 'a');
    expect(list.map((x) => x.approvalId)).toEqual(['a']);
  });
});

describe('approvalEventType', () => {
  it('reads progress frames by their type', () => {
    expect(approvalEventType('progress', { type: 'approval-required' })).toBe('approval-required');
    expect(approvalEventType('progress', { type: 'approval-resolved' })).toBe('approval-resolved');
    expect(approvalEventType('progress', { type: 'tool-call' })).toBeNull();
    expect(approvalEventType('progress', null)).toBeNull();
  });

  it('accepts the event names on their own', () => {
    expect(approvalEventType('approval-required', {})).toBe('approval-required');
    expect(approvalEventType('approval-resolved', {})).toBe('approval-resolved');
    expect(approvalEventType('result', { type: 'approval-required' })).toBeNull();
  });
});

describe('approvalNarration', () => {
  it('says what the user chose', () => {
    expect(approvalNarration('allow')).toBe('approved');
    expect(approvalNarration('always')).toBe('approved (always)');
    expect(approvalNarration('deny')).toBe('denied');
    expect(approvalNarration('cancelled')).toBe('approval cancelled');
    expect(approvalNarration(undefined)).toBe('approval cancelled');
  });
});

describe('approvalReplyOutcome', () => {
  it('treats any 2xx as sent', () => {
    expect(approvalReplyOutcome(200)).toBe('sent');
    expect(approvalReplyOutcome(204)).toBe('sent');
  });

  it('drops the card when the run or approval is gone or already answered', () => {
    expect(approvalReplyOutcome(404)).toBe('stale');
    expect(approvalReplyOutcome(409)).toBe('stale');
  });

  it('keeps the card for everything else so the user can retry', () => {
    for (const status of [0, 400, 401, 403, 500, 502]) {
      expect(approvalReplyOutcome(status)).toBe('failed');
    }
  });
});

describe('runRefusal', () => {
  it('spots the Chat only refusal that asks for the chat route', () => {
    const body = JSON.stringify({
      error: 'Chat only: send this as a normal chat message, or change Access.',
      useChat: true
    });
    expect(runRefusal(400, body)).toEqual({
      message: 'Chat only: send this as a normal chat message, or change Access.',
      useChat: true
    });
  });

  it('is a plain error otherwise', () => {
    expect(runRefusal(403, JSON.stringify({ error: 'Go Dark is on.' }))).toEqual({ message: 'Go Dark is on.', useChat: false });
    expect(runRefusal(400, JSON.stringify({ error: 'x', useChat: 'yes' })).useChat).toBe(false);
    expect(runRefusal(502, 'Bad gateway')).toEqual({ message: 'Bad gateway', useChat: false });
    expect(runRefusal(500, '').message).toContain('500');
  });
});

describe('describeRunError', () => {
  it('reads the sentence the server sent instead of dumping JSON', () => {
    const body = JSON.stringify({
      error: 'Chat only: send this as a normal chat message, or change Access.',
      useChat: true
    });
    expect(describeRunError(400, body)).toBe(
      'Chat only: send this as a normal chat message, or change Access.'
    );
  });

  it('does not show a JSON payload when there is no error field', () => {
    const out = describeRunError(500, JSON.stringify({ oops: true, stack: 'x'.repeat(50) }));
    expect(out).not.toContain('{');
    expect(out).toContain('500');
  });

  it('keeps a short plain-text body', () => {
    expect(describeRunError(503, 'Engine is starting up')).toBe('Engine is starting up');
  });

  it('falls back to the status when the body is empty or unusable', () => {
    expect(describeRunError(502, '')).toContain('502');
    expect(describeRunError(502, '   ')).toContain('502');
    expect(describeRunError(400, 'x'.repeat(500))).toContain('400');
  });
});

describe('run context', () => {
  const textFile = { name: 'app.log', storedName: 'u1-app.log', mimeType: 'text/plain', size: 10, url: '/api/uploads/u1-app.log', text: true };
  const image = { name: 'shot.png', storedName: 'u2-shot.png', mimeType: 'image/png', size: 10, url: '/api/uploads/u2-shot.png' };
  const binary = { name: 'core.bin', storedName: 'u3-core.bin', mimeType: 'application/octet-stream', size: 10, url: '/api/uploads/u3-core.bin' };

  it('reads only text files served from the uploads route', () => {
    expect(isTextAttachment(textFile)).toBe(true);
    expect(isTextAttachment({ ...textFile, text: undefined, mimeType: 'application/json' })).toBe(true);
    expect(isTextAttachment(image)).toBe(false);
    expect(isTextAttachment(binary)).toBe(false);
    expect(isTextAttachment({ ...textFile, url: 'https://evil.example/x' })).toBe(false);
    expect(isTextAttachment({ ...textFile, storedName: '' })).toBe(false);
    expect(isTextAttachment(null)).toBe(false);
  });

  it('clips long text to its head and tail within the limit', () => {
    expect(clipMiddle('short', 100)).toBe('short');
    const long = `${'a'.repeat(500)}${'z'.repeat(500)}`;
    const out = clipMiddle(long, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith('aaa')).toBe(true);
    expect(out.endsWith('zzz')).toBe(true);
    expect(out).toContain('[...]');
  });

  it('drops the blocks the chat path appended to a saved message', () => {
    expect(userTextOf('why is it slow?\n\nWeb results for "why is it slow". Use them...')).toBe('why is it slow?');
    expect(userTextOf('fix it\n\nEffort: fast. Answer concisely and directly, skip preamble.')).toBe('fix it');
    expect(userTextOf('hi\n\n[Canvas notes - treat as the user\'s working context]\nnotes')).toBe('hi');
    expect(userTextOf('ls\n\n[System: Remote Control is active. Target: pi.]')).toBe('ls');
    expect(userTextOf('plain question')).toBe('plain question');
    expect(userTextOf(undefined)).toBe('');
  });

  it('keeps real turns only, newest last', () => {
    const list = contextMessages([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Error: x', failed: true },
      { role: 'assistant', content: '', imageGenerating: true },
      { role: 'system', content: 'hidden' },
      { role: 'user', type: 'attachments', content: '', attachments: [textFile] },
      { role: 'assistant', content: 'two' }
    ]);
    expect(list.map((m) => m.content)).toEqual(['one', '', 'two']);
    const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    expect(contextMessages(many)).toHaveLength(CONTEXT_MAX_MESSAGES);
    expect(contextMessages(many).at(-1).content).toBe('m39');
    expect(contextMessages(undefined)).toEqual([]);
  });

  it('writes earlier turns oldest first, with attached file text', () => {
    const out = conversationContext([
      { role: 'user', content: 'My backend is slow.' },
      { role: 'assistant', content: 'Which process is busy?' },
      { role: 'user', type: 'attachments', content: 'Uploaded 3 files: app.log, shot.png, core.bin', attachments: [textFile, image, binary] }
    ], { attachmentTexts: new Map([['u1-app.log', 'ERROR port 4000 in use']]) });
    expect(out.startsWith('[Earlier in this chat, oldest first.')).toBe(true);
    expect(out.indexOf('User: My backend is slow.')).toBeLessThan(out.indexOf('Assistant: Which process is busy?'));
    expect(out).toContain('--- app.log ---\nERROR port 4000 in use\n--- end of app.log ---');
    expect(out).toContain('[image: shot.png. Images are not shown to you in this mode.]');
    expect(out).toContain('[file: core.bin, not readable as text]');
  });

  it('is empty when there is nothing earlier', () => {
    expect(conversationContext([])).toBe('');
    expect(conversationContext([{ role: 'assistant', content: '' }])).toBe('');
  });

  it('keeps the newest turns when the budget runs out', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `turn ${i} ${'x'.repeat(300)}` }));
    const out = conversationContext(messages, { maxChars: 1000 });
    expect(out).toContain('turn 9');
    expect(out).not.toContain('turn 0');
    expect(out.length).toBeLessThan(1400);
  });

  it('clips long file text and says so', () => {
    const big = `${'head '.repeat(4000)}${'tail '.repeat(4000)}`;
    const out = conversationContext(
      [{ role: 'user', type: 'attachments', content: 'Uploaded 1 file: app.log', attachments: [textFile] }],
      { attachmentTexts: new Map([['u1-app.log', big]]), maxFileChars: 2000 }
    );
    expect(out).toContain(`of ${big.length} characters, start and end)`);
    expect(out).toContain('head head');
    expect(out).toContain('tail tail');
    expect(out.length).toBeLessThan(2400);
  });

  it('shows a generated image as a note, not its prompt as speech', () => {
    const out = conversationContext([{ role: 'assistant', content: 'a red fox', imageUrl: '/api/uploads/x.png' }]);
    expect(out).toContain('Assistant: [generated an image: a red fox]');
  });

  it('puts the chat modes together in a fixed order and skips empty parts', () => {
    const out = buildRunContext({
      conversation: '[Earlier in this chat]\nUser: hi',
      remoteTarget: 'pi@10.0.0.2',
      canvas: '  plan: check disk  ',
      pinned: '[Watched workspace files]',
      vault: '[Config Vault]',
      web: 'Web results for "x".',
      memory: ['likes short answers', '  ', 'uses zsh'],
      instructions: ['Teaching mode: explain.']
    });
    const order = ['[Earlier in this chat]', 'Remote Control is connected to pi@10.0.0.2', '[Canvas notes', '[Watched workspace files]',
      '[Config Vault]', 'Web results for', '[Personal memory', '[How to answer]'];
    const at = order.map((s) => out.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out).toContain('Your tools act on this computer, not on pi@10.0.0.2.');
    expect(out).toContain('1. likes short answers\n2. uses zsh');
    expect(out).toContain('plan: check disk');
    expect(buildRunContext({})).toBe('');
    expect(buildRunContext({ canvas: '   ', memory: [], instructions: [] })).toBe('');
  });

  it('keeps only the newest memory items', () => {
    const memory = Array.from({ length: 30 }, (_, i) => `note ${i}`);
    const out = buildRunContext({ memory });
    expect(out).not.toContain('note 9\n');
    expect(out).toContain('20. note 29');
  });
});
