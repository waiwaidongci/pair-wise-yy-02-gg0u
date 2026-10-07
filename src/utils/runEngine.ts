import type { FlowSnapshot, NodeRunResult, RunBatch, WorkflowDocument, WorkflowEdge, WorkflowNode } from '../types/workflow'
import { topologicalOrder } from './workflow'

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 稳定序列化：对象按键名排序，保证结构相同的值哈希一致 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** cyrb53 稳定哈希 */
export function fingerprintOf(value: unknown): string {
  const str = stableStringify(value)
  let h1 = 0xdeadbeef ^ str.length
  let h2 = 0x41c6ce57 ^ str.length
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 启动时冻结节点配置与连接关系，返回不可变快照 */
export function freezeSnapshot(name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): FlowSnapshot {
  const snapshot: FlowSnapshot = {
    snapshotId: `snap-${uid()}`,
    version: 1,
    name,
    nodes: nodes.map((node) => Object.freeze({
      id: node.id,
      kind: node.data.kind,
      label: node.data.label,
      description: node.data.description,
      config: Object.freeze({ ...node.data.config }),
    })),
    edges: edges.map((edge) => Object.freeze({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      portType: edge.data?.portType ?? 'dataset',
    })),
    createdAt: new Date().toISOString(),
  }
  return Object.freeze(snapshot)
}

/** 旧版文档升级：本身没有快照字段，打开时补成首版快照 */
export function snapshotFromDocument(
  document: Pick<WorkflowDocument, 'name' | 'nodes' | 'edges' | 'savedAt'>,
): FlowSnapshot {
  const snapshot = freezeSnapshot(document.name, document.nodes, document.edges)
  return { ...snapshot, createdAt: document.savedAt ?? snapshot.createdAt }
}

/** 幂等键：由快照内容稳定哈希得到，同一份快照重复提交不会生成第二条批次 */
export function idempotencyKey(snapshot: FlowSnapshot): string {
  return `idem-${fingerprintOf({ name: snapshot.name, nodes: snapshot.nodes, edges: snapshot.edges })}`
}

/**
 * 计算每个节点的结果指纹。
 * 指纹覆盖：节点配置（kind/label/description/config）+ 连线结构（入边集合）+ 上游节点指纹。
 * 节点配置、连线或上游结果任一变化，指纹都会改变，下游据此立即失效。
 */
export function nodeFingerprints(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, string> {
  const order = topologicalOrder(nodes, edges)
  const result: Record<string, string> = {}
  for (const id of order) {
    const node = nodes.find((item) => item.id === id)
    if (!node) continue
    const incoming = edges
      .filter((edge) => edge.target === id)
      .map((edge) => ({
        edgeId: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        portType: edge.data?.portType ?? 'dataset',
      }))
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId))
    const upstream = incoming.map((edge) => result[edge.source] ?? '').sort()
    result[id] = fingerprintOf({
      kind: node.data.kind,
      label: node.data.label,
      description: node.data.description,
      config: node.data.config,
      incoming,
      upstream,
    })
  }
  return result
}

/** 按依赖深度分层，同层节点互不依赖，可并发执行 */
export function depthLevels(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const order = topologicalOrder(nodes, edges)
  const depth = new Map<string, number>()
  for (const id of order) {
    const parents = edges.filter((edge) => edge.target === id)
    depth.set(id, parents.length ? Math.max(...parents.map((edge) => (depth.get(edge.source) ?? 0) + 1)) : 0)
  }
  const levelCount = depth.size ? Math.max(...depth.values()) + 1 : 0
  const levels: string[][] = Array.from({ length: levelCount }, () => [])
  for (const id of order) levels[depth.get(id) ?? 0].push(id)
  return levels
}

/**
 * 查找可复用的历史成功结果：先看当前批次，再倒序翻历史批次。
 * 只有状态为 success 且指纹一致的结果才可复用；失败/跳过结果不可复用。
 */
export function findReusableResult(
  nodeId: string,
  fp: string,
  batches: RunBatch[],
  currentBatchId: string | null,
): NodeRunResult | null {
  const current = batches.find((batch) => batch.batchId === currentBatchId)
  const candidates: NodeRunResult[] = []
  if (current?.results[nodeId]) candidates.push(current.results[nodeId])
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i]
    if (batch.batchId === currentBatchId) continue
    const candidate = batch.results[nodeId]
    if (candidate) candidates.push(candidate)
  }
  return candidates.find((result) => result.status === 'success' && result.fingerprint === fp) ?? null
}
