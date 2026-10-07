import type { WorkflowDocument } from '../types/workflow'
import { migrateDocument } from './execution'

export const STORAGE_KEY = 'flowpilot-workspace'

export type PersistedWorkspace = WorkflowDocument

/** 读取持久化工作区；旧版本数据在打开时自动升级兼容 */
export function loadWorkspace(): PersistedWorkspace | null {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY)
    if (!text) return null
    const raw = JSON.parse(text) as Partial<WorkflowDocument>
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
    return migrateDocument(raw as WorkflowDocument)
  } catch {
    return null
  }
}

/** 单键整体写入避免半截状态；写入失败（如配额不足）时降级为内存运行 */
export function saveWorkspace(state: PersistedWorkspace): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}
