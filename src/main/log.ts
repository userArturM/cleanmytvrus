// Log lines and download progress go to the window as events; tests and scripts print them instead.
import type { DownloadProgress, LogLine } from '@shared/api'

let sink: (line: LogLine) => void = (l) => console.log(`[${l.task}] ${l.level === 'cmd' ? '$ ' : ''}${l.text}`)
let progressSink: (p: DownloadProgress) => void = () => {}

export function setSinks(onLog: (line: LogLine) => void, onProgress: (p: DownloadProgress) => void): void {
  sink = onLog
  progressSink = onProgress
}

export function log(task: string, level: LogLine['level'], text: string): void {
  sink({ task, level, text, time: Date.now() })
}

export function progress(p: DownloadProgress): void {
  progressSink(p)
}
