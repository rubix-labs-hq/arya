// The server and the CLIs it starts need USER, LOGNAME and HOME. A process started by a launch
// agent, by `env -i` or by some task runners has none of them. Claude Code then finds no stored
// login and reports loggedIn:false, and the whisper model under ~/.reel/models is not found.
// Importing this module fills the missing ones from the account that runs the process. server.mjs
// imports it first, so every later module and every child process sees them.
import os from 'node:os'

const usable = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')

/** Sets USER, LOGNAME and HOME in `env` only where they are missing or empty. Returns `env`. */
export function ensureIdentityEnv(env = process.env, userInfo = os.userInfo) {
  const missing = ['USER', 'LOGNAME', 'HOME'].filter(key => !env[key])
  if (!missing.length) return env
  let account
  // No passwd entry for this user ID: leave the environment as it is.
  try { account = userInfo() } catch { return env }
  for (const key of missing) {
    const value = key === 'HOME' ? account?.homedir : account?.username
    if (usable(value) && (key !== 'HOME' || value.startsWith('/'))) env[key] = value
  }
  return env
}

ensureIdentityEnv()
