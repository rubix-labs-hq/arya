// Type contract for the Reel mod: what its launcher pane draws from.

export type ReelServer = {
  port: number
  url: string
  isRunning: boolean
  editors: number
  version: number
  /** The server process, so a status check never applies to a server started after it. */
  pid?: number
}

export type ReelLogEntry = { who: 'you' | 'claude' | 'reel'; text: string }

export type ReelRef = { kind: string; id: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    reel: {
      isOn: boolean
      server: ReelServer | null
      log: ReelLogEntry[]
      isWorking: boolean
    }
  }
}
