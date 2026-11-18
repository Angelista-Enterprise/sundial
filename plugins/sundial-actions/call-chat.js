// Set 3 R3: which chat a look belongs to. The app answers a look by its id only (`screen:looked`), so a look a chat's tool asks
// for is put on the record first, `screen:asked {id, session}`, and privateReads (rules) files the look, or an act's after-look,
// under that chat. The chat rides along a tool call's awaits in an AsyncLocalStorage made per plugin apply: no module state.
import { AsyncLocalStorage } from 'node:async_hooks'

export function callChat(appendSignal, send) {
  const chat = new AsyncLocalStorage()
  return {
    /** The tool, its calls carrying their chat (`exec.agent.session.id`) through every await. */
    wrap: (tool) => ({ ...tool, execute: (args, exec) => chat.run(exec?.agent?.session?.id, () => tool.execute(args, exec)) }),
    /** A command for the app. A look or an act a chat's call asks for is on the record first; the command is sent at once either way. */
    send: (command) => {
      const session = chat.getStore()
      if (typeof session === 'string' && session !== '' && ['look', 'act'].includes(command?.type) && typeof command.id === 'string') void Promise.resolve(appendSignal('screen:asked', { id: command.id, session })).catch(() => {})
      return send(command)
    },
  }
}
