import { describe, expect, it } from 'vitest'
import { bundleOf, cleanApp, cleanHost, editPrivacy, privacyView } from './privacy.js'

const BUILT_IN = { apps: ['whatsapp', 'mail', 'com.apple.notes', '1password'], hosts: ['outlook.office.com', 'mail.proton.me'] }

describe('private apps and sites', () => {
  it('reads a bundle id from a window id, never the name fallback', () => {
    expect(bundleOf({ name: 'Puzzlebox Chat', windowId: 'com.example.chat:42' })).toBe('com.example.chat')
    expect(bundleOf({ name: 'Puzzlebox Chat', windowId: 'puzzlebox.chat:main' })).toBe(null)
    expect(bundleOf({ name: 'Editor', windowId: null })).toBe(null)
  })

  it('cleans what the owner types, and refuses what cannot be a name or a host', () => {
    expect(cleanApp('  Mira  Bank ')).toBe('Mira Bank')
    expect([cleanApp('a'), cleanApp('[private]'), cleanApp('x'.repeat(81)), cleanApp(7)]).toEqual([null, null, null, null])
    expect(cleanHost('https://www.Bank.example:443/login?x=1')).toBe('bank.example')
    expect(cleanHost('portal.health.example.')).toBe('portal.health.example')
    expect([cleanHost('localhost'), cleanHost('not a host'), cleanHost('@bank.example'), cleanHost(null)]).toEqual([null, null, null, null])
  })

  it('suggests seen apps that look private and no list covers yet, with what they look like and their bundle id', () => {
    const seen = {
      apps: [
        { name: 'Puzzlebox Bank', windowId: 'com.example.bank:1' },
        { name: 'WhatsApp', windowId: 'net.whatsapp.WhatsApp:1' }, // built in
        { name: 'Notes', windowId: 'com.apple.Notes:1' }, // built in by bundle id
        { name: 'Signal', windowId: 'org.whispersystems.signal-desktop:1' }, // the owner's own
        { name: 'Diary Box', windowId: 'diary.box:main' }, // hidden in config.json
        { name: 'Editor', windowId: 'com.example.editor:1' }, // not private-looking
      ],
      hosts: [],
    }
    const config = { privacy: { sensitiveApps: ['Signal'], hiddenApps: ['diary'] } }
    const { apps } = privacyView(config, BUILT_IN, seen)
    expect(apps.suggested).toEqual([{ name: 'Puzzlebox Bank', bundleId: 'com.example.bank', says: 'Looks like banking or money. You used it this month.' }])
    expect(apps.yours).toEqual([{ name: 'Signal', bundleId: 'org.whispersystems.signal-desktop' }])
    expect(apps.hidden).toEqual(['diary'])
    expect(apps.builtIn).toEqual(BUILT_IN.apps)
  })

  it('suggests opened hosts that look private first, then common web mail and chat, minus every covered host', () => {
    const seen = { apps: [], hosts: ['mijn.bank.example', 'docs.example', 'web.whatsapp.com', 'eu.outlook.office.com'] }
    const config = { privacy: { privateHosts: ['mail.yahoo.com'] } }
    const { hosts } = privacyView(config, BUILT_IN, seen)
    const names = hosts.suggested.map((h) => h.name)
    expect(names.slice(0, 2)).toEqual(['mijn.bank.example', 'web.whatsapp.com'])
    expect(hosts.suggested[1].says).toBe('Looks like a chat. You opened it this month.')
    expect(names).toContain('app.fastmail.com')
    expect(hosts.suggested.find((h) => h.name === 'app.fastmail.com').says).toBe('Looks like mail. Common.')
    for (const covered of ['docs.example', 'eu.outlook.office.com', 'mail.yahoo.com', 'mail.proton.me', 'outlook.office.com']) expect(names).not.toContain(covered)
    expect(names.length).toBeLessThanOrEqual(8)
    expect(hosts.yours).toEqual([{ name: 'mail.yahoo.com' }])
  })

  it('suggests nothing from an empty record but the common hosts', () => {
    const view = privacyView({}, BUILT_IN)
    expect(view.apps).toEqual({ builtIn: BUILT_IN.apps, yours: [], hidden: [], suggested: [] })
    expect(view.hosts.suggested.every((h) => h.says.endsWith('Common.'))).toBe(true)
  })

  it('adds and removes the owner’s own entries, keeping every other key', () => {
    const config = { ocr: { enabled: true }, privacy: { redactionTier: 2, sensitiveApps: ['Signal'] } }
    const added = editPrivacy(config, BUILT_IN, { op: 'add', kind: 'app', value: ' Puzzlebox Bank ' })
    expect(added.next).toEqual({ ocr: { enabled: true }, privacy: { redactionTier: 2, sensitiveApps: ['Signal', 'Puzzlebox Bank'] } })
    expect(added.value).toBe('Puzzlebox Bank')
    expect(config.privacy.sensitiveApps).toEqual(['Signal'])
    expect(editPrivacy(config, BUILT_IN, { op: 'remove', kind: 'app', value: 'signal' }).next.privacy.sensitiveApps).toEqual([])
    expect(editPrivacy({}, BUILT_IN, { op: 'add', kind: 'host', value: 'https://www.bank.example/x' }).next).toEqual({ privacy: { privateHosts: ['bank.example'] } })
  })

  it('refuses a covered add, a built-in remove, a bad kind and a bad value, each with what to do', () => {
    expect(editPrivacy({}, BUILT_IN, { op: 'add', kind: 'app', value: 'WhatsApp Beta' }).error).toBe('Already private: the built-in “whatsapp” covers it.')
    expect(editPrivacy({ privacy: { privateHosts: ['bank.example'] } }, BUILT_IN, { op: 'add', kind: 'host', value: 'login.bank.example' }).error).toBe('Already private: your “bank.example” covers it.')
    expect(editPrivacy({}, BUILT_IN, { op: 'remove', kind: 'app', value: 'whatsapp' }).error).toBe('Built in: it always stays private.')
    expect(editPrivacy({}, BUILT_IN, { op: 'remove', kind: 'host', value: 'bank.example' }).error).toBe('That is not on your list.')
    expect(editPrivacy({}, BUILT_IN, { op: 'add', kind: 'file', value: 'x' }).error).toBe('Say app or host.')
    expect(editPrivacy({}, BUILT_IN, { op: 'drop', kind: 'app', value: 'Signal' }).error).toBe('Say add or remove.')
    expect(editPrivacy({}, BUILT_IN, { op: 'add', kind: 'host', value: 'no host' }).error).toBe('Give a web address, like mail.example.com.')
    const full = { privacy: { sensitiveApps: Array.from({ length: 200 }, (_, i) => `App ${i}`) } }
    expect(editPrivacy(full, BUILT_IN, { op: 'add', kind: 'app', value: 'Puzzlebox' }).error).toMatch(/full at 200/)
  })
})
