import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, ContextAssembler, type MessageAttachment } from '../src/index.js';

describe('Image attachments in core', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-core-att-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SessionManager persists and restores message attachments in JSONL tree', () => {
    const session = SessionManager.create(tmpDir, 'test-session-att');
    const attachment: MessageAttachment = {
      id: 'att-123',
      type: 'image',
      mimeType: 'image/png',
      name: 'screenshot.png',
      size: 1024,
      url: '/api/attachments/att-123_screenshot.png',
      path: '/path/to/screenshot.png'
    };

    const msg = session.appendMessage({
      role: 'user',
      content: 'Look at this screenshot',
      attachments: [attachment]
    });

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0].id).toBe('att-123');
    expect(msg.attachments![0].url).toBe('/api/attachments/att-123_screenshot.png');

    const reloaded = SessionManager.open(session.getFilePath());
    const context = reloaded.buildSessionContext();
    expect(context).toHaveLength(1);
    expect(context[0].attachments).toHaveLength(1);
    expect(context[0].attachments![0].name).toBe('screenshot.png');
    expect(context[0].attachments![0].mimeType).toBe('image/png');
  });

  it('ContextAssembler converts attachments to AI SDK ImageParts', () => {
    const session = SessionManager.create(tmpDir, 'test-assembler-att');
    const testImgPath = path.join(tmpDir, 'sample.png');
    const sampleBytes = Buffer.from('fake-image-binary-data');
    fs.writeFileSync(testImgPath, sampleBytes);

    session.appendMessage({
      role: 'user',
      content: 'Analyze this photo',
      attachments: [
        {
          id: 'att-path',
          type: 'image',
          mimeType: 'image/png',
          name: 'sample.png',
          path: testImgPath
        },
        {
          id: 'att-data',
          type: 'image',
          mimeType: 'image/jpeg',
          name: 'data.jpg',
          data: 'data:image/jpeg;base64,ZmFrZQ=='
        }
      ]
    });

    const assembler = new ContextAssembler({ session, workspaceDir: tmpDir });
    const contextMessages = session.buildSessionContext();
    const coreMessages = assembler.toCoreMessages(contextMessages);

    expect(coreMessages).toHaveLength(1);
    const userMsg = coreMessages[0];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);

    const parts = userMsg.content as Array<{ type: string; [key: string]: unknown }>;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: 'Analyze this photo' });
    expect(parts[1].type).toBe('image');
    expect(parts[1].mimeType).toBe('image/png');
    expect(parts[2].type).toBe('image');
    expect(parts[2].mimeType).toBe('image/jpeg');
    expect(parts[2].image).toBe('data:image/jpeg;base64,ZmFrZQ==');
  });
});
