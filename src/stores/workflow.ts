import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  CachedResult,
  FlowSnapshot,
  LegacyWorkflowDocument,
  NodeKind,
  RunBatch,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import {
  buildSnapshot,
  computeLevels,
  createBatch,
  migrateDocument,
  shortId,
  staleNodeIds,
  summarizeBatch,
} from '../utils/execution'
import { loadWorkspace, saveWorkspace } from '../utils/persistence'
import {
  autoLayout,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  NODE_DEFINITIONS,
  sampleWorkflow,
  topologicalOrder,
} from '../utils/workflow'

interface HistoryEntry {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: HistoryEntry[]
  future: HistoryEntry[]
  clipboard: WorkflowNode[]
  notice: string
  running: boolean
  snapshots: FlowSnapshot[]
  batches: RunBatch[]
  activeBatchId: string | null
  resultCache: Record<string, CachedResult>
  setName: (name: string) => void
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  connect: (connection: Connection) => boolean
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateNode: (id: string, patch: Partial<WorkflowNode['data']>) => void
  updateConfig: (id: string, key: string, value: string | number | boolean) => void
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  run: () => Promise<RunBatch | null>
  submitBatch: (snapshot: FlowSnapshot, batchId: string) => boolean
  loadDocument: (document: WorkflowDocument | LegacyWorkflowDocument) => void
  reset: () => void
}

/** 模拟节点计算时的失败概率，用于演示失败恢复与断点续跑 */
const FAILURE_RATE = 0.1
const MAX_BATCHES = 50
const MAX_SNAPSHOTS = 50
const MAX_CACHE_ENTRIES = 300

const persistedWorkspace = loadWorkspace()
const fallback = sampleWorkflow()
const initialSnapshot = buildSnapshot(fallback.nodes, fallback.edges, []).snapshot

function historySnapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): HistoryEntry {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(historySnapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 依赖变更后，把结果指纹不再匹配的节点结果立即失效 */
function invalidateStaleResults(draft: Pick<WorkflowState, 'nodes' | 'edges'>): number {
  const stale = staleNodeIds(draft.nodes, draft.edges)
  if (!stale.size) return 0
  draft.nodes.forEach((node) => {
    if (!stale.has(node.id)) return
    node.data.status = 'idle'
    node.data.rows = undefined
    node.data.duration = undefined
    node.data.cacheKey = undefined
    node.data.reused = undefined
  })
  return stale.size
}

function withInvalidation(draft: WorkflowState) {
  const count = invalidateStaleResults(draft)
  if (count > 0) draft.notice = `依赖变更：${count} 个节点结果已失效，下次执行仅重算受影响部分`
}

/** 重置 / 中断当前批次：未完成的节点记为取消，已成功结果保留 */
function interruptActiveBatch(draft: WorkflowState) {
  const active = draft.batches.find((item) => item.id === draft.activeBatchId && item.status === 'running')
  if (active) {
    active.status = 'interrupted'
    active.finishedAt = new Date().toISOString()
    Object.values(active.records).forEach((record) => {
      if (record.status === 'running' || record.status === 'pending') record.status = 'skipped'
    })
  }
  draft.activeBatchId = null
  draft.running = false
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: persistedWorkspace?.name ?? '订单经营分析流程',
  nodes: persistedWorkspace?.nodes ?? fallback.nodes,
  edges: persistedWorkspace?.edges ?? fallback.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: persistedWorkspace ? '已恢复上次工作区（含快照、批次与结果缓存）' : '端口与类型校验已开启',
  running: false,
  snapshots: persistedWorkspace?.snapshots ?? [initialSnapshot],
  batches: persistedWorkspace?.batches ?? [],
  activeBatchId: null,
  resultCache: persistedWorkspace?.resultCache ?? {},

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
    withInvalidation(state)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
    withInvalidation(state)
  }),

  connect: (connection) => {
    const state = get()
    const error = connectionError(connection, state.nodes)
    if (error) {
      set((draft) => { draft.notice = error })
      return false
    }
    if (createsCycle(connection, state.edges)) {
      set((draft) => { draft.notice = '连接被拒绝：检测到环形依赖' })
      return false
    }
    set((draft) => {
      pushHistory(draft)
      const sourceHandle = connection.sourceHandle ?? ''
      const type = sourceHandle.startsWith('out-1') ? 'number' : 'dataset'
      draft.edges = addEdge({
        ...connection,
        id: `edge-${Date.now().toString(36)}`,
        type: 'smoothstep',
        animated: true,
        data: { portType: type },
      }, draft.edges) as WorkflowEdge[]
      draft.notice = '连接成功，端口类型兼容'
      withInvalidation(draft)
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
    draft.notice = `已添加${definitionFor(kind).label}`
    withInvalidation(draft)
  }),

  selectNode: (id) => set((state) => {
    state.selectedNodeId = id
    state.selectedEdgeId = null
  }),

  selectEdge: (id) => set((state) => {
    state.selectedEdgeId = id
    state.selectedNodeId = null
  }),

  updateNode: (id, patch) => set((draft) => {
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data = { ...node.data, ...patch }
    withInvalidation(draft)
  }),

  updateConfig: (id, key, value) => set((draft) => {
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data.config[key] = value
    withInvalidation(draft)
  }),

  deleteSelection: () => set((draft) => {
    if (!draft.selectedNodeId && !draft.selectedEdgeId) return
    pushHistory(draft)
    if (draft.selectedNodeId) {
      const id = draft.selectedNodeId
      draft.nodes = draft.nodes.filter((node) => node.id !== id)
      draft.edges = draft.edges.filter((edge) => edge.source !== id && edge.target !== id)
      draft.selectedNodeId = null
    }
    if (draft.selectedEdgeId) {
      draft.edges = draft.edges.filter((edge) => edge.id !== draft.selectedEdgeId)
      draft.selectedEdgeId = null
    }
    withInvalidation(draft)
  }),

  copySelection: () => set((draft) => {
    const selected = draft.nodes.filter((node) => node.id === draft.selectedNodeId)
    draft.clipboard = JSON.parse(JSON.stringify(selected)) as WorkflowNode[]
    if (selected.length) draft.notice = `已复制 ${selected.length} 个节点`
  }),

  pasteSelection: () => set((draft) => {
    if (!draft.clipboard.length) return
    pushHistory(draft)
    const copies = draft.clipboard.map((source) => {
      const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode
      copy.id = `${source.data.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      copy.position = { x: source.position.x + 36, y: source.position.y + 36 }
      copy.selected = false
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
    draft.notice = `已粘贴 ${copies.length} 个节点`
    withInvalidation(draft)
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
    withInvalidation(draft)
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(historySnapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    draft.notice = '已撤销上一步操作'
    withInvalidation(draft)
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(historySnapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    draft.notice = '已恢复操作'
    withInvalidation(draft)
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  submitBatch: (snapshot, batchId) => {
    // 幂等：同一批次重复提交不会生成第二份记录
    if (get().batches.some((batch) => batch.id === batchId)) return false
    set((draft) => {
      if (!draft.snapshots.some((item) => item.id === snapshot.id)) {
        draft.snapshots.push(snapshot)
        if (draft.snapshots.length > MAX_SNAPSHOTS) draft.snapshots.shift()
      }
      draft.batches.push(createBatch(snapshot, batchId, draft.resultCache))
      if (draft.batches.length > MAX_BATCHES) draft.batches.shift()
      draft.activeBatchId = batchId
      draft.running = true
    })
    persistWorkspaceNow()
    return true
  },

  run: async () => {
    const state = get()
    if (state.running) return null
    if (!state.nodes.length) {
      set((draft) => { draft.notice = '画布为空，请先添加节点' })
      return null
    }
    const order = topologicalOrder(state.nodes, state.edges)
    if (order.length !== state.nodes.length) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return null
    }
    // 启动即冻结：节点配置、连接关系与结果指纹一并收入不可变快照
    const { snapshot, isNew } = buildSnapshot(state.nodes, state.edges, state.snapshots)
    const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!get().submitBatch(snapshot, batchId)) return null
    set((draft) => {
      draft.nodes.forEach((node) => {
        node.data.status = 'queued'
        node.data.duration = undefined
        node.data.rows = undefined
        node.data.reused = undefined
      })
      draft.notice = isNew
        ? `批次 ${shortId(batchId)} 已启动：冻结为快照 v${snapshot.version}`
        : `批次 ${shortId(batchId)} 已启动：复用快照 v${snapshot.version}`
    })
    persistWorkspaceNow()

    const levels = computeLevels(snapshot.nodes.map((node) => node.id), snapshot.edges)
    let failed = false
    for (const level of levels) {
      if (failed) {
        // 上游失败后，未开始的节点取消
        set((draft) => {
          const batch = draft.batches.find((item) => item.id === batchId)
          level.forEach((id) => {
            const record = batch?.records[id]
            if (record && record.status === 'pending') record.status = 'skipped'
            const node = draft.nodes.find((item) => item.id === id)
            if (node) node.data.status = 'skipped'
          })
        })
        continue
      }
      // 同层节点并发执行，只读取冻结快照
      await Promise.all(level.map((id) => executeSnapshotNode(batchId, snapshot, id)))
      const batch = get().batches.find((item) => item.id === batchId)
      if (!batch) return null
      failed = level.some((id) => batch.records[id]?.status === 'error')
      // 运行期间的画布改动，让受影响的已出结果立即失效
      set((draft) => { invalidateStaleResults(draft) })
    }

    set((draft) => {
      const batch = draft.batches.find((item) => item.id === batchId)
      let notice = ''
      if (batch) {
        batch.status = failed ? 'failed' : 'success'
        batch.finishedAt = new Date().toISOString()
        const summary = summarizeBatch(batch)
        notice = failed
          ? `批次 ${shortId(batchId)} 未全部成功：失败 ${summary.failed} · 跳过 ${summary.skipped}，成功结果已保留，修复后可直接续跑`
          : `批次 ${shortId(batchId)} 完成：新算 ${summary.computed} · 复用 ${summary.reused} · 快照 v${batch.snapshotVersion}`
      }
      const invalidated = invalidateStaleResults(draft)
      if (invalidated > 0) notice += `${notice ? '；' : ''}运行期间变更使 ${invalidated} 个结果失效`
      if (notice) draft.notice = notice
      if (draft.activeBatchId === batchId) {
        draft.running = false
        draft.activeBatchId = null
      }
    })
    persistWorkspaceNow()
    return get().batches.find((item) => item.id === batchId) ?? null
  },

  loadDocument: (document) => set((draft) => {
    const wasLegacy = document.version !== 2
    const migrated = migrateDocument(JSON.parse(JSON.stringify(document)) as WorkflowDocument)
    draft.name = migrated.name
    draft.nodes = migrated.nodes
    draft.edges = migrated.edges
    draft.snapshots = migrated.snapshots
    draft.batches = migrated.batches
    draft.resultCache = migrated.resultCache
    draft.activeBatchId = null
    draft.running = false
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    invalidateStaleResults(draft)
    const latestVersion = migrated.snapshots.reduce((max, item) => Math.max(max, item.version), 0)
    draft.notice = wasLegacy
      ? `流程 JSON 已导入：旧版数据已升级，补建首版快照 v${latestVersion}`
      : `流程 JSON 已导入：快照 v${latestVersion} · 缓存 ${Object.keys(migrated.resultCache).length} 份结果可复用`
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    interruptActiveBatch(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.notice = '已恢复示例流程'
    withInvalidation(draft)
  }),
})))

/** 执行冻结快照中的单个节点：命中缓存直接复用，否则模拟计算并写入缓存 */
async function executeSnapshotNode(batchId: string, snapshot: FlowSnapshot, nodeId: string) {
  const cacheKey = snapshot.cacheKeys[nodeId]
  const batch = useWorkflowStore.getState().batches.find((item) => item.id === batchId)
  const record = batch?.records[nodeId]
  if (!record) return

  const cached = useWorkflowStore.getState().resultCache[cacheKey]
  if (record.reused && cached) {
    useWorkflowStore.setState((draft) => {
      const currentRecord = draft.batches.find((item) => item.id === batchId)?.records[nodeId]
      if (currentRecord) {
        currentRecord.status = 'success'
        currentRecord.rows = cached.rows
        currentRecord.duration = cached.duration
      }
      const node = draft.nodes.find((item) => item.id === nodeId)
      if (node) {
        node.data.status = 'success'
        node.data.rows = cached.rows
        node.data.duration = cached.duration
        node.data.cacheKey = cacheKey
        node.data.reused = true
      }
    })
    return
  }

  useWorkflowStore.setState((draft) => {
    const currentRecord = draft.batches.find((item) => item.id === batchId)?.records[nodeId]
    if (currentRecord) currentRecord.status = 'running'
    const node = draft.nodes.find((item) => item.id === nodeId)
    if (node) node.data.status = 'running'
  })
  persistWorkspaceNow()

  const duration = 240 + Math.round(Math.random() * 620)
  await delay(duration)
  if (!useWorkflowStore.getState().batches.some((item) => item.id === batchId)) return

  const failed = Math.random() < FAILURE_RATE
  useWorkflowStore.setState((draft) => {
    const currentRecord = draft.batches.find((item) => item.id === batchId)?.records[nodeId]
    const node = draft.nodes.find((item) => item.id === nodeId)
    if (failed) {
      if (currentRecord) {
        currentRecord.status = 'error'
        currentRecord.error = '节点执行异常（模拟故障），已成功的上游结果保留在缓存中'
      }
      if (node) node.data.status = 'error'
      return
    }
    const rows = 1200 + Math.round(Math.random() * 88000)
    if (currentRecord) {
      currentRecord.status = 'success'
      currentRecord.rows = rows
      currentRecord.duration = duration
    }
    draft.resultCache[cacheKey] = { cacheKey, nodeId, rows, duration, finishedAt: new Date().toISOString() }
    const entries = Object.entries(draft.resultCache)
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries.sort((a, b) => a[1].finishedAt.localeCompare(b[1].finishedAt))
      entries.slice(0, entries.length - MAX_CACHE_ENTRIES).forEach(([key]) => { delete draft.resultCache[key] })
    }
    if (node) {
      node.data.status = 'success'
      node.data.rows = rows
      node.data.duration = duration
      node.data.cacheKey = cacheKey
      node.data.reused = false
    }
  })
  persistWorkspaceNow()
}

let persistTimer: number | undefined

function persistable(state: WorkflowState): WorkflowDocument {
  return {
    version: 2,
    name: state.name,
    nodes: state.nodes,
    edges: state.edges,
    snapshots: state.snapshots,
    batches: state.batches,
    resultCache: state.resultCache,
    savedAt: new Date().toISOString(),
  }
}

/** 立即落盘：批次状态翻转与节点完成时调用，保证刷新 / 写入中断后能从成功结果继续 */
export function persistWorkspaceNow() {
  window.clearTimeout(persistTimer)
  saveWorkspace(persistable(useWorkflowStore.getState()))
}

useWorkflowStore.subscribe((state, previous) => {
  if (
    state.nodes === previous.nodes
    && state.edges === previous.edges
    && state.name === previous.name
    && state.snapshots === previous.snapshots
    && state.batches === previous.batches
    && state.resultCache === previous.resultCache
  ) return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistWorkspaceNow, 300)
})

window.addEventListener('beforeunload', persistWorkspaceNow)

export const nodeDefinitions = NODE_DEFINITIONS

export function statusLabel(status: RunStatus) {
  return {
    idle: '待执行',
    queued: '已排队',
    running: '运行中',
    success: '执行成功',
    error: '执行失败',
    skipped: '已跳过',
  }[status]
}
