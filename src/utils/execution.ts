import type {
  CachedResult,
  FlowSnapshot,
  LegacyWorkflowDocument,
  NodeRunRecord,
  RunBatch,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import { topologicalOrder } from './workflow'

/** 稳定哈希（djb2，base36），用于结果指纹与快照标识 */
export function hashString(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

export function shortId(id: string): string {
  return id.replace(/^(batch|snap)-/, '').slice(0, 8)
}

function canonicalConfig(config: WorkflowNode['data']['config']): WorkflowNode['data']['config'] {
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * 结果指纹 = 节点类型 + 配置 + 各输入端口的上游指纹。
 * 节点、连线或上游结果任一变化都会沿依赖链改变下游指纹，
 * 因此指纹未命中的节点即是下次执行需要重算的部分。
 */
export function computeCacheKeys(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, string> {
  const keys: Record<string, string> = {}
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, WorkflowEdge[]>()
  edges.forEach((edge) => {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  })
  for (const id of topologicalOrder(nodes, edges)) {
    const node = byId.get(id)
    if (!node) continue
    const upstreams = (incoming.get(id) ?? [])
      .map((edge) => ({ handle: edge.targetHandle ?? '', key: keys[edge.source] ?? 'missing' }))
      .sort((a, b) => a.handle.localeCompare(b.handle))
    keys[id] = hashString(JSON.stringify({ kind: node.data.kind, config: canonicalConfig(node.data.config), upstreams }))
  }
  for (const node of nodes) {
    if (!keys[node.id]) {
      keys[node.id] = hashString(JSON.stringify({ kind: node.data.kind, config: canonicalConfig(node.data.config), upstreams: [] }))
    }
  }
  return keys
}

/** 找出结果已失效的节点：当前指纹与产生结果时记录的指纹不一致 */
export function staleNodeIds(nodes: WorkflowNode[], edges: WorkflowEdge[]): Set<string> {
  const keys = computeCacheKeys(nodes, edges)
  const stale = new Set<string>()
  nodes.forEach((node) => {
    if (node.data.status === 'success' && node.data.cacheKey !== keys[node.id]) stale.add(node.id)
  })
  return stale
}

/** 拓扑分层：同层节点互不依赖，可并发执行 */
export function computeLevels(nodeIds: string[], edges: Array<{ source: string; target: string }>): string[][] {
  const ids = new Set(nodeIds)
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) return
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const levels: string[][] = []
  const placed = new Set<string>()
  let current = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0)
  while (current.length) {
    levels.push(current)
    current.forEach((id) => placed.add(id))
    const next: string[] = []
    current.forEach((id) => {
      ;(outgoing.get(id) ?? []).forEach((target) => {
        indegree.set(target, (indegree.get(target) ?? 0) - 1)
        if (indegree.get(target) === 0) next.push(target)
      })
    })
    current = next
  }
  const rest = nodeIds.filter((id) => !placed.has(id))
  if (rest.length) levels.push(rest)
  return levels
}

/** 基于当前画布构建不可变快照；内容未变化时复用已有快照版本 */
export function buildSnapshot(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  existing: FlowSnapshot[],
): { snapshot: FlowSnapshot; isNew: boolean } {
  const snapshotNodes = nodes.map((node) => ({
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    config: canonicalConfig(node.data.config),
  }))
  const snapshotEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? null,
    target: edge.target,
    targetHandle: edge.targetHandle ?? null,
  }))
  const fingerprint = hashString(JSON.stringify({
    nodes: snapshotNodes
      .map(({ id, kind, config }) => ({ id, kind, config }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: snapshotEdges
      .map(({ source, sourceHandle, target, targetHandle }) => ({ source, sourceHandle, target, targetHandle }))
      .sort((a, b) => `${a.source}>${a.target}>${a.targetHandle}`.localeCompare(`${b.source}>${b.target}>${b.targetHandle}`)),
  }))
  const id = `snap-${fingerprint}`
  const found = existing.find((item) => item.id === id)
  if (found) return { snapshot: found, isNew: false }
  const version = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1
  return {
    isNew: true,
    snapshot: {
      id,
      version,
      createdAt: new Date().toISOString(),
      nodes: snapshotNodes,
      edges: snapshotEdges,
      cacheKeys: computeCacheKeys(nodes, edges),
    },
  }
}

/** 创建运行批次；启动时冻结每个节点是否可复用上游结果 */
export function createBatch(
  snapshot: FlowSnapshot,
  id: string,
  resultCache: Record<string, CachedResult>,
): RunBatch {
  const records: Record<string, NodeRunRecord> = {}
  snapshot.nodes.forEach((node) => {
    const cacheKey = snapshot.cacheKeys[node.id]
    records[node.id] = { nodeId: node.id, cacheKey, status: 'pending', reused: Boolean(resultCache[cacheKey]) }
  })
  return {
    id,
    snapshotId: snapshot.id,
    snapshotVersion: snapshot.version,
    status: 'running',
    createdAt: new Date().toISOString(),
    records,
  }
}

/** 刷新或写入中断后恢复：进行中的批次标记为已中断，未完成的节点记为取消 */
export function reconcileBatches(batches: RunBatch[]): RunBatch[] {
  return batches.map((batch) => {
    if (batch.status !== 'running') return batch
    const records: Record<string, NodeRunRecord> = {}
    Object.values(batch.records).forEach((record) => {
      records[record.nodeId] = record.status === 'running' || record.status === 'pending'
        ? { ...record, status: 'skipped' as const }
        : record
    })
    return { ...batch, status: 'interrupted' as const, finishedAt: batch.finishedAt ?? new Date().toISOString(), records }
  })
}

/** 旧版文档升级：补齐首版快照，并把已有的成功结果迁入缓存以便下次复用 */
export function migrateDocument(raw: LegacyWorkflowDocument | WorkflowDocument): WorkflowDocument {
  const nodes = raw.nodes ?? []
  const edges = raw.edges ?? []
  nodes.forEach((node) => {
    if (node.data.status === 'running' || node.data.status === 'queued') node.data.status = 'idle'
  })
  const maybeV2 = raw as Partial<WorkflowDocument>
  const snapshots = Array.isArray(maybeV2.snapshots) ? maybeV2.snapshots : null
  const batches = Array.isArray(maybeV2.batches) ? maybeV2.batches : null
  const resultCache = maybeV2.resultCache && typeof maybeV2.resultCache === 'object' ? maybeV2.resultCache : null
  if (maybeV2.version === 2 && snapshots && batches && resultCache) {
    return {
      version: 2,
      name: raw.name ?? '未命名流程',
      nodes,
      edges,
      snapshots,
      batches: reconcileBatches(batches),
      resultCache,
      savedAt: maybeV2.savedAt ?? new Date().toISOString(),
    }
  }
  const { snapshot } = buildSnapshot(nodes, edges, [])
  const migratedCache: Record<string, CachedResult> = {}
  nodes.forEach((node) => {
    if (node.data.status !== 'success') return
    if (node.data.rows === undefined) {
      node.data.status = 'idle'
      node.data.duration = undefined
      return
    }
    const cacheKey = snapshot.cacheKeys[node.id]
    migratedCache[cacheKey] = {
      cacheKey,
      nodeId: node.id,
      rows: node.data.rows,
      duration: node.data.duration ?? 0,
      finishedAt: raw.savedAt ?? new Date().toISOString(),
    }
    node.data.cacheKey = cacheKey
  })
  return {
    version: 2,
    name: raw.name ?? '未命名流程',
    nodes,
    edges,
    snapshots: [snapshot],
    batches: [],
    resultCache: migratedCache,
    savedAt: raw.savedAt ?? new Date().toISOString(),
  }
}

export interface BatchSummary {
  total: number
  computed: number
  reused: number
  failed: number
  skipped: number
  pending: number
  running: number
}

export function summarizeBatch(batch: RunBatch): BatchSummary {
  const summary: BatchSummary = { total: 0, computed: 0, reused: 0, failed: 0, skipped: 0, pending: 0, running: 0 }
  Object.values(batch.records).forEach((record) => {
    summary.total += 1
    if (record.status === 'success' && record.reused) summary.reused += 1
    else if (record.status === 'success') summary.computed += 1
    else if (record.status === 'error') summary.failed += 1
    else if (record.status === 'skipped') summary.skipped += 1
    else if (record.status === 'running') summary.running += 1
    else summary.pending += 1
  })
  return summary
}
