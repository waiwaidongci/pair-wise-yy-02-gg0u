import type { FlowSnapshot, RunBatch } from '../types/workflow'

const BATCHES_KEY = 'flowpilot:batches:v1'
const SNAPSHOTS_KEY = 'flowpilot:snapshots:v1'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式或存储已满时静默降级为内存态 */
  }
}

export function loadPersistedBatches(): RunBatch[] {
  return read<RunBatch[]>(BATCHES_KEY, [])
}

export function loadPersistedSnapshots(): FlowSnapshot[] {
  return read<FlowSnapshot[]>(SNAPSHOTS_KEY, [])
}

/** 写穿透：批次/快照一旦变化立即落盘，保证刷新或写入中断后能从成功结果继续 */
export function persistRunState(batches: RunBatch[], snapshots: FlowSnapshot[]): void {
  write(BATCHES_KEY, batches)
  write(SNAPSHOTS_KEY, snapshots)
}
