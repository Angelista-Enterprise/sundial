// What each macOS permission lets Sundial see, in plain words, and the System
// Settings pane that grants it. One list, read by the setup page and by the
// Permissions block in Settings, so the two never describe a grant differently.

export const PANE = 'x-apple.systempreferences:com.apple.preference.security?'

/** What each permission lets Sundial see, in plain words, and where to grant it. */
export const PERMS = {
  accessibility: {
    what: 'Reads which app is in front and the title of its window. This is how Sundial knows what you are working on. It never clicks or types for you.',
    pane: 'Privacy_Accessibility',
  },
  inputMonitoring: {
    what: 'Counts key presses and clicks per minute, to tell working from away. It never records which keys you press.',
    pane: 'Privacy_ListenEvent',
  },
  calendar: {
    what: 'Reads the times and titles of your events, so a meeting shows as a meeting.',
    pane: 'Privacy_Calendars',
  },
  screenRecording: {
    what: 'Only for the screen-text reader (ocr.enabled in config.json). Skip this if you do not use it.',
    pane: 'Privacy_ScreenCapture',
    optional: true,
  },
  fullDiskAccess: {
    what: 'Only for Mail capture (privacy.mail in config.json) and to read the Focus mode name. Skip this unless you want those.',
    pane: 'Privacy_AllFiles',
    optional: true,
  },
  microphone: {
    what: 'Only for hearing (audio.enabled in config.json): meetings and calls are transcribed on this Mac. Skip this if you do not use it.',
    pane: 'Privacy_Microphone',
    optional: true,
  },
  locationServices: {
    what: 'Not needed. Sundial never asks where you are. Without it macOS hides Wi-Fi names, so you name places yourself.',
    pane: 'Privacy_LocationServices',
    optional: true,
  },
}

/** Keys macOS can raise its own prompt for; the rest only open their pane. */
const PROMPTS = new Set(['accessibility', 'inputMonitoring', 'screenRecording'])

/** Inside Sundial.app, where the page can talk to the app. */
export const inApp = () => Boolean(window.webkit?.messageHandlers?.sundial)

/** Tell the app something: `{ grant: key }` or `{ setupDone: true }`. A no-op in a browser. */
export const tellApp = (message) => window.webkit?.messageHandlers?.sundial?.postMessage(message)

/**
 * The action on a row that is not granted. Inside the app a button: the app
 * opens the pane, then raises macOS's own prompt, and restarts what needs the
 * grant when you come back. In a browser, a plain link to the pane.
 */
export function grantAction(key, className) {
  const node = document.createElement(inApp() ? 'button' : 'a')
  node.className = className
  node.textContent = inApp() && PROMPTS.has(key) ? 'Grant' : 'Open settings'
  if (inApp()) {
    node.type = 'button'
    node.addEventListener('click', () => tellApp({ grant: key }))
  } else node.href = PANE + PERMS[key].pane
  return node
}
