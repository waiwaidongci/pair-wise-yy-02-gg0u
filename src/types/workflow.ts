import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeConfig {
  [key: string]: string | number | boolean
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string
  kind: NodeKind
  description: string
  config: NodeConfig
  status: RunStatus
  duration?: number
  rows?: number
  /** 产生当前结果时的结果指纹，依赖变更后用于立即失效 */
  cacheKey?: string
  /** 当前结果是否来自缓存复用 */
  reused?: boolean
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

/** 快照中冻结的节点配置 */
export interface SnapshotNode {
  id: string
  kind: NodeKind
  label: string
  config: NodeConfig
}

/** 快照中冻结的连接关系 */
export interface SnapshotEdge {
  id: string
  source: string
  sourceHandle: string | null
  target: string
  targetHandle: string | null
}

/** 不可变流程快照：一次执行的唯一输入，启动时冻结配置、连线与结果指纹 */
export interface FlowSnapshot {
  id: string
  version: number
  createdAt: string
  nodes: SnapshotNode[]
  edges: SnapshotEdge[]
  /** 节点结果指纹（内容寻址），随快照一并冻结 */
  cacheKeys: Record<string, string>
}

export type BatchNodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeRunRecord {
  nodeId: string
  cacheKey: string
  status: BatchNodeStatus
  /** 启动时根据冻结的上游结果判定是否复用缓存 */
  reused: boolean
  duration?: number
  rows?: number
  error?: string
}

export type BatchStatus = 'running' | 'success' | 'failed' | 'interrupted'

/** 运行批次：同一批次重复提交不会生成第二份记录 */
export interface RunBatch {
  id: string
  snapshotId: string
  snapshotVersion: number
  status: BatchStatus
  createdAt: string
  finishedAt?: string
  records: Record<string, NodeRunRecord>
}

/** 可复用的节点结果，按结果指纹寻址 */
export interface CachedResult {
  cacheKey: string
  nodeId: string
  rows: number
  duration: number
  finishedAt: string
}

export interface WorkflowDocument {
  version: 2
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  snapshots: FlowSnapshot[]
  batches: RunBatch[]
  resultCache: Record<string, CachedResult>
  savedAt: string
}

/** 旧版（v1）流程文档：没有快照、批次与结果缓存字段 */
export interface LegacyWorkflowDocument {
  version?: 1
  name?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt?: string
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
