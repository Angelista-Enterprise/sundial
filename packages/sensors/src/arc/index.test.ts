import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcTabsSensor, readArcSpace } from './index.js';

const tab = (id: string, url: string, at: number, title: string | null = null) => ({ id, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle: `saved ${id}`, timeLastActiveAt: at } } });
const sidebar = {
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: ['s-work', { id: 's-work', title: 'Work', containerIDs: ['pinned', 'c-pin', 'unpinned', 'c-today'] }, 's-home', { id: 's-home', title: 'Home', containerIDs: ['pinned', 'c-home'] }],
        items: [
          'c-pin', { id: 'c-pin', childrenIds: ['t1', 'folder'], data: { itemContainer: {} } },
          'folder', { id: 'folder', childrenIds: ['t2'], data: { list: {} } },
          't1', tab('t1', 'https://example.test/board?token=secret#top', 100, 'Board'),
          't2', tab('t2', 'https://example.test/pull/812', 300),
          'c-today', { id: 'c-today', childrenIds: ['t3', 't4'], data: { itemContainer: {} } },
          't3', tab('t3', 'arc://settings', 400),
          't4', tab('t4', 'http://localhost:3000/a/b?x=1', 200),
          'c-home', { id: 'c-home', childrenIds: ['t5'], data: { itemContainer: {} } },
          't5', tab('t5', 'https://elsewhere.test/', 999),
        ],
      },
    ],
  },
};
const windows = { windows: [{ focusedSpaceID: 's-home' }], lastFocusedSpaceID: 's-work' };

describe('readArcSpace (UC2 item 5)', () => {
  it('lists the focused space tabs, newest first, with no query, no fragment and no internal pages', () => {
    expect(readArcSpace(sidebar, windows)).toEqual({
      title: 'Work',
      tabs: [
        { url: 'https://example.test/pull/812', title: 'saved t2' },
        { url: 'http://localhost:3000/a/b', title: 'saved t4' },
        { url: 'https://example.test/board', title: 'Board' },
      ],
    });
  });

  it('reads nothing it does not recognise', () => {
    expect(readArcSpace({}, windows)).toBeNull();
    expect(readArcSpace(sidebar, { lastFocusedSpaceID: 'gone' })).toBeNull();
  });

  it('emits once per change, from the files on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
    fs.writeFileSync(path.join(dir, 'StorableSidebar.json'), JSON.stringify(sidebar));
    fs.writeFileSync(path.join(dir, 'StorableWindows.json'), JSON.stringify(windows));
    const sensor = new ArcTabsSensor(dir);
    expect(sensor.poll(1_000_000)?.payload.tabs).toHaveLength(3);
    expect(sensor.poll(1_100_000)).toBeNull();
    fs.writeFileSync(path.join(dir, 'StorableWindows.json'), JSON.stringify({ lastFocusedSpaceID: 's-home' }));
    fs.utimesSync(path.join(dir, 'StorableWindows.json'), new Date(), new Date(Date.now() + 5000));
    expect(sensor.poll(1_200_000)?.payload).toMatchObject({ title: 'Home', tabs: [{ url: 'https://elsewhere.test/' }] });
    expect(new ArcTabsSensor(path.join(dir, 'missing')).poll()).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  it('drops a sensitive site\'s tab entirely, as the browser sensor drops a sensitive app', () => {
    const bank = JSON.parse(JSON.stringify(sidebar));
    const items = bank.sidebar.containers[1].items;
    items.push('t6', tab('t6', 'https://www.paypal.com/myaccount/summary', 500, 'Summary'), 't7', tab('t7', 'https://vault.bitwarden.com/', 450));
    items[items.indexOf('c-today') + 1].childrenIds.push('t6', 't7');
    const urls = readArcSpace(bank, windows)!.tabs.map((t) => t.url);
    expect(urls).toEqual(['https://example.test/pull/812', 'http://localhost:3000/a/b', 'https://example.test/board']);
  });

  it('a tab switch alone is no new event: only the set of tabs is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
    const write = (sb: unknown) => {
      fs.writeFileSync(path.join(dir, 'StorableSidebar.json'), JSON.stringify(sb));
      fs.writeFileSync(path.join(dir, 'StorableWindows.json'), JSON.stringify(windows));
      const t = new Date(Date.now() + Math.random() * 1e6);
      fs.utimesSync(path.join(dir, 'StorableSidebar.json'), t, t);
    };
    const sensor = new ArcTabsSensor(dir);
    write(sidebar);
    expect(sensor.poll(1_000_000)).not.toBeNull();
    const switched = JSON.parse(JSON.stringify(sidebar));
    const items = switched.sidebar.containers[1].items;
    items[items.indexOf('t1') + 1].data.tab.timeLastActiveAt = 10_000;
    write(switched);
    expect(sensor.poll(1_100_000)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});
