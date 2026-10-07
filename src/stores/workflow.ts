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
  FlowSnapshot,
  NodeKind,
  NodeRunResult,
  RunBatch,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
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
import {
  depthLevels,
  findReusableResult,
  freezeSnapshot,
  idempotencyKey,
  nodeFingerprints,
  snapshotFromDocument,
  uid,
} from '../utils/runEngine'
import { loadPersistedBatches, loadPersistedSnapshots, persistRunState } from '../utils/storage'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface RunSummary {
  batchId: string
  /** 直接复用历史成功结果的节点数 */
  reused: number
  /** 本次实际重算的节点数（含失败） */
  executed: number
  /** 本次重算成功的节点数 */
  succeeded: number
  /** 因上游失败/未开始而被取消的节点数 */
  skipped: number
  failed: boolean
  failedNodeId: string | null
  /** 是否从中断的批次恢复 */
  resumed: boolean
}

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: Snapshot[]
  future: Snapshot[]
  clipboard: WorkflowNode[]
  notice: string
  running: boolean
  /** 不可变流程快照列表（每次执行冻结一份） */
  snapshots: FlowSnapshot[]
  /** 运行批次记录（幂等：同快照只有一条） */
  batches: RunBatch[]
  /** 当前画布关联的批次 */
  currentBatchId: string | null
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
  simulate: () => Promise<RunSummary | void>
  hydrate: () => void
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 依据当前批次结果与节点指纹，把画布节点标记为「结果已过期」。
 * 节点配置、连线或上游结果任一变化，受影响的下游立即失效。
 */
function refreshValidity(state: WorkflowState) {
  const current = state.batches.find((batch) => batch.batchId === state.currentBatchId)
  if (!current) {
    state.nodes.forEach((node) => { node.data.stale = false })
    return
  }
  const fps = nodeFingerprints(state.nodes, state.edges)
  const memo = new Map<string, boolean>()
  const isValid = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id) ?? false
    const stored = current.results[id]
    let ok = !!stored && stored.status === 'success' && stored.fingerprint === fps[id]
    if (ok) {
      for (const edge of state.edges) {
        if (edge.target !== id) continue
        if (!isValid(edge.source)) { ok = false; break }
      }
    }
    memo.set(id, ok)
    return ok
  }
  state.nodes.forEach((node) => {
    node.data.stale = !isValid(node.id)
  })
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: '订单经营分析流程',
  nodes: initial.nodes,
  edges: initial.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: '端口与类型校验已开启',
  running: false,
  snapshots: loadPersistedSnapshots(),
  batches: loadPersistedBatches(),
  currentBatchId: null,

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
    if (changes.some((change) => change.type === 'remove')) refreshValidity(state)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
    if (changes.some((change) => change.type === 'remove')) refreshValidity(state)
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
      const source = draft.nodes.find((node) => node.id === connection.source)
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
      refreshValidity(draft)
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
    refreshValidity(draft)
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
    if (node) {
      node.data = { ...node.data, ...patch }
      refreshValidity(draft)
    }
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (node) {
      node.data.config[key] = value
      refreshValidity(draft)
    }
    draft.past.push(snapshot(draft))
    draft.future = []
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
    refreshValidity(draft)
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
    refreshValidity(draft)
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(snapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    draft.notice = '已撤销上一步操作'
    refreshValidity(draft)
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    draft.notice = '已恢复操作'
    refreshValidity(draft)
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  simulate: async () => {
    const state = get()
    if (state.running) return
    const order = topologicalOrder(state.nodes, state.edges)
    if (order.length !== state.nodes.length) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return
    }
    if (!order.length) {
      set((draft) => { draft.notice = '画布为空，无可执行节点' })
      return
    }

    // 1. 启动时冻结节点配置与连接关系，得到不可变快照
    const snapshot = freezeSnapshot(state.name, state.nodes, state.edges)
    const key = idempotencyKey(snapshot)

    // 2. 幂等：同一份快照只对应一条批次记录，重复提交不生成第二份
    const existing = state.batches.find((batch) => batch.idempotencyKey === key)
    const resumed = existing?.status === 'running'
    const batchId = existing?.batchId ?? `batch-${uid()}`
    const frozenNodes = new Map(snapshot.nodes.map((node) => [node.id, node]))

    set((draft) => {
      draft.running = true
      draft.currentBatchId = batchId
      if (!existing) {
        draft.snapshots.push(snapshot)
        draft.batches.push({
          batchId,
          snapshotId: snapshot.snapshotId,
          idempotencyKey: key,
          status: 'running',
          startedAt: new Date().toISOString(),
          results: {},
        })
      } else {
        const batch = draft.batches.find((item) => item.batchId === batchId)
        if (batch) {
          batch.status = 'running'
          batch.finishedAt = undefined
        }
      }
      draft.nodes.forEach((node) => {
        node.data.status = 'queued'
        node.data.stale = false
      })
      draft.notice = resumed ? '检测到上次中断，从已成功结果继续执行' : '已冻结流程快照，按层并发执行'
    })
    persistRunState(get().batches, get().snapshots)

    // 3. 基于冻结快照计算指纹与分层，同层节点并发执行
    const fps = nodeFingerprints(state.nodes, state.edges)
    const levels = depthLevels(state.nodes, state.edges)
    const outcome: Record<string, 'reused' | 'success' | 'error' | 'skipped'> = {}
    let failedNodeId: string | null = null
    let reused = 0
    let executed = 0
    let succeeded = 0
    let skipped = 0

    const setNodeStatus = (id: string, status: RunStatus, patch?: Partial<WorkflowNode['data']>) => {
      set((draft) => {
        const node = draft.nodes.find((item) => item.id === id)
        if (node) {
          node.data.status = status
          if (patch) Object.assign(node.data, patch)
        }
      })
    }

    for (const level of levels) {
      await Promise.all(level.map(async (id) => {
        // 已有节点失败：后续未开始节点一律取消
        if (failedNodeId) {
          outcome[id] = 'skipped'
          skipped++
          set((draft) => {
            const batch = draft.batches.find((item) => item.batchId === batchId)
            if (batch) {
              batch.results[id] = {
                nodeId: id,
                status: 'skipped',
                fingerprint: fps[id],
                completedAt: new Date().toISOString(),
              }
            }
            const node = draft.nodes.find((item) => item.id === id)
            if (node) node.data.status = 'skipped'
          })
          return
        }

        const fp = fps[id]
        const sources = state.edges.filter((edge) => edge.target === id)
        const sourcesReady = sources.every(
          (edge) => outcome[edge.source] === 'reused' || outcome[edge.source] === 'success',
        )
        // 上游结果就绪且指纹一致：复用历史成功结果，不重算
        const cached = sourcesReady ? findReusableResult(id, fp, get().batches, batchId) : null
        if (cached) {
          outcome[id] = 'reused'
          reused++
          set((draft) => {
            // 复用结果写入当前批次，保证批次自包含、过期判断有据可依
            const batch = draft.batches.find((item) => item.batchId === batchId)
            if (batch) batch.results[id] = { ...cached }
            const node = draft.nodes.find((item) => item.id === id)
            if (node) {
              node.data.status = 'success'
              node.data.duration = cached.duration
              node.data.rows = cached.rows
            }
          })
          return
        }
        if (!sourcesReady) {
          outcome[id] = 'skipped'
          skipped++
          set((draft) => {
            const batch = draft.batches.find((item) => item.batchId === batchId)
            if (batch) {
              batch.results[id] = {
                nodeId: id,
                status: 'skipped',
                fingerprint: fp,
                completedAt: new Date().toISOString(),
              }
            }
            const node = draft.nodes.find((item) => item.id === id)
            if (node) node.data.status = 'skipped'
          })
          return
        }

        // 执行节点：只读冻结快照中的配置，运行期画布改动不会混入本次结果
        setNodeStatus(id, 'running')
        const frozen = frozenNodes.get(id)
        const duration = 240 + Math.round(Math.random() * 620)
        await delay(duration)
        const failReason = frozen?.config.simulateFail ? '节点配置了模拟失败' : null
        const completedAt = new Date().toISOString()

        if (failReason) {
          const result: NodeRunResult = {
            nodeId: id,
            status: 'error',
            error: failReason,
            duration,
            fingerprint: fp,
            completedAt,
          }
          set((draft) => {
            const batch = draft.batches.find((item) => item.batchId === batchId)
            if (batch) batch.results[id] = result
            const node = draft.nodes.find((item) => item.id === id)
            if (node) {
              node.data.status = 'error'
              node.data.duration = duration
            }
          })
          failedNodeId = id
          executed++
        } else {
          const rows = 1200 + Math.round(Math.random() * 88000)
          const result: NodeRunResult = {
            nodeId: id,
            status: 'success',
            rows,
            duration,
            fingerprint: fp,
            completedAt,
          }
          set((draft) => {
            const batch = draft.batches.find((item) => item.batchId === batchId)
            if (batch) batch.results[id] = result
            const node = draft.nodes.find((item) => item.id === id)
            if (node) {
              node.data.status = 'success'
              node.data.duration = duration
              node.data.rows = rows
            }
          })
          outcome[id] = 'success'
          executed++
          succeeded++
        }
        // 写穿透：每个节点完成即落盘，刷新或写入中断最多丢失在途节点
        persistRunState(get().batches, get().snapshots)
      }))
    }

    const failed = failedNodeId !== null
    set((draft) => {
      const batch = draft.batches.find((item) => item.batchId === batchId)
      if (batch) {
        batch.status = failed ? 'failed' : 'succeeded'
        batch.finishedAt = new Date().toISOString()
      }
      draft.running = false
      draft.currentBatchId = batchId
      refreshValidity(draft)
      draft.notice = failed
        ? `执行在节点 ${failedNodeId} 失败：已恢复 ${reused + succeeded} 个成功结果，${skipped} 个未开始节点已取消`
        : `执行完成：重算 ${executed} 个节点，复用 ${reused} 个缓存结果，跳过 ${skipped} 个`
    })
    persistRunState(get().batches, get().snapshots)

    return { batchId, reused, executed, succeeded, skipped, failed, failedNodeId, resumed }
  },

  hydrate: () => set((draft) => {
    // 刷新后恢复当前批次关联，并按落盘结果重算过期标记
    draft.currentBatchId = draft.batches[draft.batches.length - 1]?.batchId ?? null
    refreshValidity(draft)
  }),

  loadDocument: (document) => set((draft) => {
    draft.name = document.name
    draft.nodes = document.nodes
    draft.edges = document.edges
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null

    const incomingSnapshots = document.snapshots ?? []
    const knownSnapshots = new Set(draft.snapshots.map((snapshot) => snapshot.snapshotId))
    incomingSnapshots.forEach((snapshot) => {
      if (!knownSnapshots.has(snapshot.snapshotId)) draft.snapshots.push(snapshot)
    })
    const knownBatches = new Set(draft.batches.map((batch) => batch.batchId))
    ;(document.batches ?? []).forEach((batch) => {
      if (!knownBatches.has(batch.batchId)) draft.batches.push(batch)
    })

    let migrated = false
    if (!incomingSnapshots.length) {
      // 旧文档没有快照字段：升级兼容，补成首版不可变快照
      draft.snapshots.push(snapshotFromDocument(document))
      migrated = true
    }

    draft.currentBatchId = draft.batches[draft.batches.length - 1]?.batchId ?? null
    refreshValidity(draft)
    draft.notice = migrated ? '旧版流程已升级：已补为首版不可变快照' : '流程 JSON 已导入'
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    refreshValidity(draft)
    draft.notice = '已恢复示例流程'
  }),
})))

// 批次或快照一旦变化立即落盘（写穿透），保证刷新后能从成功结果继续
let lastBatches = useWorkflowStore.getState().batches
let lastSnapshots = useWorkflowStore.getState().snapshots
useWorkflowStore.subscribe((state) => {
  if (state.batches !== lastBatches || state.snapshots !== lastSnapshots) {
    lastBatches = state.batches
    lastSnapshots = state.snapshots
    persistRunState(state.batches, state.snapshots)
  }
})

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
