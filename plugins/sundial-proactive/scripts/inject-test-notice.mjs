#!/usr/bin/env node
// Drop a synthetic notice for the running harness to deliver.
//
//   node plugins/sundial-proactive/scripts/inject-test-notice.mjs [phasic|tonic]
//
// Simulates DELIVERY only: the gate is not consulted, no budget is spent and
// no key is habituated. Use it to check that an admitted notice reaches the
// companion session, not to check whether it would have been admitted.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const channel = process.argv[2] === 'tonic' ? 'tonic-notice' : 'phasic-notice'
const dir = `${process.env.SUNDIAL_HOME || `${homedir()}/.sundial`}/.daemon`
mkdirSync(dir, { recursive: true })

const notice = {
  channel,
  payload: {
    kind: 'absent',
    observation: 'You have been heads-down in the same file for over two hours without a break, which is unusual for a Friday afternoon.',
    evidence: ['focus block since 15:40', 'no break signal since 13:20'],
    weight: 1.84,
    noticeKey: 'test:long-focus-block',
  },
}

writeFileSync(`${dir}/test-notice.json`, `${JSON.stringify(notice, null, 2)}\n`)
console.log(`dropped a ${channel} notice for the harness to deliver`)
