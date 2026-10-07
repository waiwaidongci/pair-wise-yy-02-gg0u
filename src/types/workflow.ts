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
  /** 结果已过期：节点配置、连线或上游结果变化后，当前画布结果不再可信 */
  stale?: boolean
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

/** 冻结后的节点：配置在启动时固化，运行期间画布改动不影响本次执行 */
export interface FrozenNode {
  id: string
  kind: NodeKind
  label: string
  description: string
  config: NodeConfig
}

/** 冻结后的连线：连接关系在启动时固化 */
export interface FrozenEdge {
  id: string
  source: string
  target: string
  sourceHandle: string | null
  targetHandle: string | null
  portType: PortType
}

/** 不可变流程快照：一次执行对应一份，创建后不再变更 */
export interface FlowSnapshot {
  snapshotId: string
  version: 1
  name: string
  nodes: FrozenNode[]
  edges: FrozenEdge[]
  createdAt: string
}

/** 单个节点的运行结果记录 */
export interface NodeRunResult {
  nodeId: string
  status: 'success' | 'error' | 'skipped'
  rows?: number
  duration?: number
  error?: string
  /** 计算时的节点指纹，用于跨批次复用与失效判断 */
  fingerprint: string
  completedAt: string
}

/** 运行批次：同一份快照（幂等键）只对应一条批次记录，重复提交不生成第二份 */
export interface RunBatch {
  batchId: string
  snapshotId: string
  /** 幂等键：由快照内容稳定哈希得到，相同快照复用同一批次 */
  idempotencyKey: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  results: Record<string, NodeRunResult>
}

export interface WorkflowDocument {
  version: 1
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt: string
  /** 不可变快照列表；旧版文档可能缺失，打开时升级补成首版快照 */
  snapshots?: FlowSnapshot[]
  batches?: RunBatch[]
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
