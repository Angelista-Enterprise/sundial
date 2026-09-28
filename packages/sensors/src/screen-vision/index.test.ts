import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFacts, ScreenVisionSensor } from './index.js';

describe('ScreenVisionSensor (J3.3)', () => {
  it('parses the model\'s facts defensively', () => {
    expect(parseFacts('{"facts":["Editing runtime.ts in VS Code","A failing vitest run is shown","x","y"]}')).toEqual(['Editing runtime.ts in VS Code', 'A failing vitest run is shown', 'x']);
    expect(parseFacts('```json\n{"facts": []}\n```')).toEqual([]);
    expect(parseFacts('not json')).toEqual([]);
  });

  it('sends the frame to the local model once per interval and emits the facts on the next poll; nothing without a fresh frame', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-vision-'));
    const frame = path.join(dir, 'screen-frame.jpg');
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push(url);
      const body = JSON.parse(init.body) as { model: string; images: string[]; stream: boolean };
      expect(body).toMatchObject({ model: 'gemma4:e4b-mlx', stream: false });
      expect(body.images[0]).toBe(Buffer.from('jpegbytes').toString('base64'));
      return new Response(JSON.stringify({ response: '{"facts":["A pull request diff is open"]}' }), { status: 200 });
    }) as unknown as typeof fetch;
    const sensor = new ScreenVisionSensor({ enabled: true, model: 'gemma4:e4b-mlx', intervalMs: 1000, framePath: frame, fetchImpl });
    expect(sensor.poll(10_000)).toEqual([]);
    fs.writeFileSync(frame, 'jpegbytes');
    const now = Date.now();
    expect(sensor.poll(now)).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    const events = sensor.poll(now + 10);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ facts: ['A pull request diff is open'], model: 'gemma4:e4b-mlx' });
    // Same frame, next interval: not sent again.
    expect(sensor.poll(now + 5000)).toEqual([]);
    expect(calls).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
