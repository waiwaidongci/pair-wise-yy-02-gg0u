import { freezeSnapshot, idempotencyKey, nodeFingerprints, depthLevels, findReusableResult, snapshotFromDocument } from '../src/utils/runEngine'
import { sampleWorkflow, createWorkflowNode } from '../src/utils/workflow'
import type { RunBatch } from '../src/types/workflow'

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

const { nodes, edges } = sampleWorkflow()

// 1. 快照冻结
const snap1 = freezeSnapshot('test', nodes, edges)
check('快照版本为 1', snap1.version === 1)
check('快照节点数一致', snap1.nodes.length === nodes.length)
check('快照不可变（严格模式下冻结）', Object.isFrozen(snap1) && Object.isFrozen(snap1.nodes[0]))

// 2. 幂等键：相同内容 -> 相同键；改配置 -> 不同键
const snap2 = freezeSnapshot('test', nodes, edges)
check('相同画布幂等键一致', idempotencyKey(snap1) === idempotencyKey(snap2))
const nodesCloned = JSON.parse(JSON.stringify(nodes)) as typeof nodes
nodesCloned[0].data.config.sampleRows = 999
const snap3 = freezeSnapshot('test', nodesCloned, edges)
check('节点配置变化后幂等键变化', idempotencyKey(snap1) !== idempotencyKey(snap3))

// 3. 指纹：配置/连线/上游变化都会改变指纹
const fps1 = nodeFingerprints(nodes, edges)
check('所有节点都有指纹', nodes.every((n) => typeof fps1[n.id] === 'string'))
const nodesCloned2 = JSON.parse(JSON.stringify(nodes)) as typeof nodes
nodesCloned2[0].data.config.sampleRows = 1
const fps2 = nodeFingerprints(nodesCloned2, edges)
check('源节点配置变化 -> 自身指纹变化', fps2['source-orders'] !== fps1['source-orders'])
check('源节点配置变化 -> 下游指纹变化', fps2['filter-paid'] !== fps1['filter-paid'] && fps2['sink-warehouse'] !== fps1['sink-warehouse'])
// 连线变化
const edgesCloned = JSON.parse(JSON.stringify(edges)) as typeof edges
edgesCloned.pop()
const fps3 = nodeFingerprints(nodes, edgesCloned)
check('连线变化 -> 相关节点指纹变化', fps3['sink-warehouse'] !== fps1['sink-warehouse'])

// 4. 分层：同层无依赖
const levels = depthLevels(nodes, edges)
check('分层覆盖所有节点', levels.flat().length === nodes.length)
check('第 0 层只有 source', levels[0].length === 1 && levels[0][0] === 'source-orders')
check('同层节点互不相连', levels.every((level) => level.every((id) => !edges.some((e) => (e.source === id && level.includes(e.target)) || (e.target === id && level.includes(e.source))))))

// 5. 结果复用：指纹一致 + success 才可复用
const batch: RunBatch = {
  batchId: 'b1', snapshotId: snap1.snapshotId, idempotencyKey: idempotencyKey(snap1),
  status: 'succeeded', startedAt: '', results: {},
}
batch.results['source-orders'] = { nodeId: 'source-orders', status: 'success', fingerprint: fps1['source-orders'], completedAt: '' }
check('指纹一致的成功结果可复用', findReusableResult('source-orders', fps1['source-orders'], [batch], 'b1') !== null)
check('指纹不一致不可复用', findReusableResult('source-orders', fps2['source-orders'], [batch], 'b1') === null)
batch.results['filter-paid'] = { nodeId: 'filter-paid', status: 'error', fingerprint: fps1['filter-paid'], completedAt: '' }
check('失败结果不可复用', findReusableResult('filter-paid', fps1['filter-paid'], [batch], 'b1') === null)

// 6. 旧文档升级
const oldDoc = { name: '旧流程', nodes, edges, savedAt: '2024-01-01T00:00:00.000Z' }
const upgraded = snapshotFromDocument(oldDoc)
check('旧文档升级为首版快照', upgraded.version === 1 && upgraded.name === '旧流程')
check('升级快照保留节点配置', upgraded.nodes[0].config.sampleRows === nodes[0].data.config.sampleRows)

// 7. 新节点加入 -> 自身及下游指纹变化
const extra = createWorkflowNode('transform', { x: 0, y: 0 })
const nodesWithExtra = [...nodes, extra]
const edgesWithExtra = [...edges, { id: 'ex', source: 'source-orders', sourceHandle: 'out-0', target: extra.id, targetHandle: 'in-0', type: 'smoothstep' as const }]
const fps4 = nodeFingerprints(nodesWithExtra, edgesWithExtra)
check('新节点有指纹', typeof fps4[extra.id] === 'string')
check('新节点加入不影响无关节点指纹', fps4['sink-warehouse'] === fps1['sink-warehouse'])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
