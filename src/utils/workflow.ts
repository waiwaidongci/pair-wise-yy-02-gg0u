import type { Connection } from '@xyflow/react'
import type { NodeDefinition, PortType, WorkflowEdge, WorkflowNode } from '../types/workflow'

export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    kind: 'source',
    label: '数据源',
    description: '读取订单、用户或日志数据集',
    color: '#2563eb',
    inputs: [],
    outputs: ['dataset'],
  },
  {
    kind: 'transform',
    label: '字段变换',
    description: '清洗、映射与派生字段',
    color: '#0891b2',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'filter',
    label: '条件过滤',
    description: '按表达式筛选数据行',
    color: '#7c3aed',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'aggregate',
    label: '聚合计算',
    description: '分组汇总并输出指标',
    color: '#ca8a04',
    inputs: ['dataset'],
    outputs: ['number'],
  },
  {
    kind: 'join',
    label: '双流关联',
    description: '按关联键合并两路数据',
    color: '#db2777',
    inputs: ['dataset', 'dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'sink',
    label: '结果输出',
    description: '写入数据仓库或消息队列',
    color: '#16a34a',
    inputs: ['dataset', 'number'],
    outputs: [],
  },
]

export function definitionFor(kind: WorkflowNode['data']['kind']) {
  return NODE_DEFINITIONS.find((item) => item.kind === kind) ?? NODE_DEFINITIONS[0]
}

export function defaultConfig(kind: WorkflowNode['data']['kind']) {
  const configs: Record<WorkflowNode['data']['kind'], Record<string, string | number | boolean>> = {
    source: { source: '订单主表', refresh: '实时', sampleRows: 125000 },
    transform: { expression: 'amount * 1.06', outputField: 'amount_with_tax', keepOriginal: true },
    filter: { expression: 'status == "已支付"', limit: 50000 },
    aggregate: { groupBy: 'region', metric: 'sum(amount)', outputField: 'region_total' },
    join: { joinType: 'left', leftKey: 'customer_id', rightKey: 'id' },
    sink: { target: '分析数据集市', mode: 'upsert', partition: 'dt' },
  }
  return configs[kind]
}

export function createWorkflowNode(
  kind: WorkflowNode['data']['kind'],
  position: { x: number; y: number },
  id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): WorkflowNode {
  const definition = definitionFor(kind)
  return {
    id,
    type: 'workflow',
    position,
    data: {
      label: definition.label,
      kind,
      description: definition.description,
      config: defaultConfig(kind),
      status: 'idle',
    },
  }
}

export function portAt(node: WorkflowNode, handle: string | null | undefined): { direction: 'input' | 'output'; type: PortType; index: number } | null {
  if (!handle) return null
  const match = /^(in|out)-(\d+)$/.exec(handle)
  if (!match) return null
  const definition = definitionFor(node.data.kind)
  const index = Number(match[2])
  const direction = match[1] === 'in' ? 'input' : 'output'
  const type = direction === 'input' ? definition.inputs[index] : definition.outputs[index]
  return type ? { direction, type, index } : null
}

export function connectionError(connection: Connection, nodes: WorkflowNode[]): string | null {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
    return '连接缺少有效的源端口或目标端口'
  }
  if (connection.source === connection.target) return '节点不能连接到自身'

  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return '连接节点不存在'

  const sourcePort = portAt(source, connection.sourceHandle)
  const targetPort = portAt(target, connection.targetHandle)
  if (!sourcePort || sourcePort.direction !== 'output') return '源端口类型无效'
  if (!targetPort || targetPort.direction !== 'input') return '目标端口类型无效'

  const compatible = sourcePort.type === 'any'
    || targetPort.type === 'any'
    || sourcePort.type === targetPort.type
  if (!compatible) return `端口类型不兼容：${sourcePort.type} → ${targetPort.type}`

  return null
}

export function createsCycle(connection: Connection, edges: WorkflowEdge[]): boolean {
  if (!connection.source || !connection.target) return false
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  })
  const sourceList = adjacency.get(connection.source) ?? []
  sourceList.push(connection.target)
  adjacency.set(connection.source, sourceList)

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (hasCycle(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...adjacency.keys()].some(hasCycle)
}

export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return result
}

export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const order = topologicalOrder(nodes, edges)
  const depth = new Map<string, number>()
  order.forEach((id) => {
    const parents = edges.filter((edge) => edge.target === id)
    depth.set(id, parents.length ? Math.max(...parents.map((edge) => (depth.get(edge.source) ?? 0) + 1)) : 0)
  })
  const columns = new Map<number, WorkflowNode[]>()
  nodes.forEach((node) => {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  })
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0
    const index = (columns.get(column) ?? []).findIndex((item) => item.id === node.id)
    return { ...node, position: { x: 90 + column * 260, y: 90 + index * 150 } }
  })
}

export function sampleWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const source = createWorkflowNode('source', { x: 60, y: 150 }, 'source-orders')
  source.data.label = '订单实时流'
  const filter = createWorkflowNode('filter', { x: 330, y: 70 }, 'filter-paid')
  filter.data.label = '筛选已支付订单'
  const transform = createWorkflowNode('transform', { x: 330, y: 250 }, 'transform-clean')
  transform.data.label = '清洗收货信息'
  const join = createWorkflowNode('join', { x: 610, y: 160 }, 'join-customer')
  join.data.label = '关联客户画像'
  const aggregate = createWorkflowNode('aggregate', { x: 880, y: 160 }, 'aggregate-region')
  aggregate.data.label = '区域销售聚合'
  const sink = createWorkflowNode('sink', { x: 1150, y: 160 }, 'sink-warehouse')
  sink.data.label = '写入经营看板'
  return {
    nodes: [source, filter, transform, join, aggregate, sink],
    edges: [
      { id: 'e1', source: source.id, sourceHandle: 'out-0', target: filter.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' }, animated: true },
      { id: 'e2', source: source.id, sourceHandle: 'out-0', target: transform.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e3', source: filter.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e4', source: transform.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e5', source: join.id, sourceHandle: 'out-0', target: aggregate.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e6', source: aggregate.id, sourceHandle: 'out-0', target: sink.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'number' } },
    ],
  }
}
