import { describe, expect, it } from 'vitest';
import { sidebarOf } from '../daemon/cmux';
import { entriesOf, parseLines } from '../daemon/pi';
import { callerOf } from '../src/access';
import { locationOf, pathOf } from '../client/src/route';
import { panelAfter } from '../client/src/update';

describe('sidebarOf', () => {
  it('keeps cmux order, pins, colors, unread and groups, and links Pi sessions by surface', () => {
    const raw = {
      groups: [{ id: 'g1', name: 'Team', is_pinned: false, is_collapsed: true, icon_symbol: 'folder.fill', member_workspace_ids: ['w2'] }],
      workspaces: [
        { id: 'w1', title: 'lee', is_pinned: true, custom_color: '#C0392B', has_unread: true, surfaces: [{ surface_id: 'abc', title: 'LEE', kind: 'terminal', is_focused: true }] },
        { id: 'w2', title: 'coil', is_pinned: false, group_id: 'g1', surfaces: [{ surface_id: 's2', title: 'docs', kind: 'filePreview' }] },
      ],
    };
    const sidebar = sidebarOf(raw, new Map([['ABC', { sessionId: 'p1', status: 'running' }]]), 5);
    expect(sidebar.workspaces.map((workspace) => [workspace.title, workspace.pinned, workspace.color, workspace.unread])).toEqual([
      ['lee', true, '#C0392B', true],
      ['coil', false, null, false],
    ]);
    expect(sidebar.workspaces[0]?.surfaces[0]?.pi).toEqual({ sessionId: 'p1', status: 'running' });
    expect(sidebar.workspaces[1]?.surfaces[0]?.kind).toBe('file');
    expect(sidebar.groups[0]).toEqual({ id: 'g1', name: 'Team', pinned: false, collapsed: true, icon: 'folder.fill', members: ['w2'] });
  });
});

describe('Pi session parsing', () => {
  it('turns session lines into entries and skips thinking and bad lines', () => {
    const lines = [
      JSON.stringify({ type: 'message', id: 'u1', timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'hi from the phone' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text: 'hello' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'message', id: 'r1', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'a\nb' }] } }),
      '{"broken',
      JSON.stringify({ type: 'compaction', id: 'c1' }),
    ].join('\n');
    const entries = parseLines(lines);
    expect(entries.map((entry) => [entry.role, entry.text, entry.tool])).toEqual([
      ['user', 'hi from the phone', null],
      ['assistant', 'hello', null],
      ['toolCall', '{"command":"ls"}', 'bash'],
      ['toolResult', 'a\nb', 'bash'],
      ['notice', 'context compacted', null],
    ]);
  });

  it('ignores non-message lines', () => {
    expect(entriesOf({ type: 'custom' })).toEqual([]);
  });
});

describe('access caller', () => {
  it('identifies a person by email and a machine by service token', () => {
    expect(callerOf({ email: 'Me@Example.com' })).toEqual({ kind: 'person', email: 'me@example.com' });
    expect(callerOf({ common_name: 'abc.access' })).toEqual({ kind: 'machine', tokenId: 'abc.access' });
    expect(callerOf({})).toBeNull();
  });
});

describe('routes', () => {
  it('round-trips workspace and surface paths', () => {
    const location = { workspaceId: 'W 1', surfaceId: 'S/2' };
    expect(locationOf(pathOf(location))).toEqual(location);
    expect(locationOf('/')).toEqual({ workspaceId: null, surfaceId: null });
    expect(pathOf({ workspaceId: null, surfaceId: null })).toBe('/');
  });
});

describe('panelAfter', () => {
  it('appends new Pi entries without duplicates and resets on a fresh open', () => {
    const first = panelAfter({ _tag: 'Waiting' }, { _tag: 'Pi', surfaceId: 's', sessionId: 'p', status: 'idle', entries: [{ id: '1', role: 'user', text: 'a', tool: null, at: null }], reset: true });
    const second = panelAfter(first, { _tag: 'Pi', surfaceId: 's', sessionId: 'p', status: 'running', entries: [{ id: '1', role: 'user', text: 'a', tool: null, at: null }, { id: '2', role: 'assistant', text: 'b', tool: null, at: null }], reset: false });
    expect(second._tag === 'Pi' ? second.entries.map((entry) => entry.id) : []).toEqual(['1', '2']);
    const reset = panelAfter(second, { _tag: 'Pi', surfaceId: 's', sessionId: 'p', status: 'idle', entries: [], reset: true });
    expect(reset._tag === 'Pi' ? reset.entries : null).toEqual([]);
  });
});
