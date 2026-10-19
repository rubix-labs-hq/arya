import path from 'node:path'

// Existing writer fault fixtures use minimal {name} projects. The recovery service's
// real envelope, durable receipts and restore routes are covered by project-recovery.test.mjs.
export function recoveryDouble(root, fs) {
  const file = path.join(root, 'reel.project.json')
  return {
    warning: null,
    observe() {
      if (!fs.existsSync(file)) return { status: 'missing', text: null, token: 'missing', writable: true }
      const text = fs.readFileSync(file, 'utf8')
      let status = 'valid'; try { JSON.parse(text) } catch { status = 'invalid' }
      return { text, status, token: text, sha256: null, writable: Boolean(fs.statSync(file).mode & 0o222), utf8: true }
    },
    assertExpected(expected) {
      const observed = this.observe()
      if (observed.text !== expected) throw new Error('Fixture project changed on disk')
      if (!observed.writable) throw new Error('Fixture project is read-only')
      if (observed.status === 'invalid') throw new Error('Fixture project is invalid')
      return observed
    },
    capture() { return { id: 'fixture-snapshot' } },
  }
}
