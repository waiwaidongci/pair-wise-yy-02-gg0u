// @ts-nocheck
// 集成验证：store 级别的执行/复用/失败/失效/幂等行为
import { useWorkflowStore } from '../src/stores/workflow'

const memory = new Map<string, string>()
;(globalThis as any).window = {
  setTimeout,
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) },
    removeItem: (key: string) => { memory.delete(key) },
  },
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

const store = useWorkflowStore
const get = store.getState
const lastBatch = () => get().batches[get().batches.length - 1]
const currentBatch = () => get().batches.find((b) => b.batchId === get().currentBatchId)

// 1. 首次执行：全部成功，生成一条批次 + 一份快照
let summary = await get().simulate()
check('首次执行无失败', summary!.failed === false)
check('首次重算全部 6 个节点', summary!.executed === 6 && summary!.reused === 0)
check('批次状态 succeeded', lastBatch().status === 'succeeded')
check('批次记录只有一条', get().batches.length === 1)
check('快照只有一份', get().snapshots.length === 1)
check('节点全部 success', get().nodes.every((n) => n.data.status === 'success'))

// 2. 同画布重复执行：全部复用，不生成新记录
summary = await get().simulate()
check('二次执行全部复用', summary!.reused === 6 && summary!.executed === 0)
check('批次记录仍为一条（幂等）', get().batches.length === 1)
check('快照仍为一份', get().snapshots.length === 1)

// 3. 改节点配置：受影响下游立即过期
get().updateConfig('source-orders', 'sampleRows', 200000)
const staleAfterEdit = get().nodes.filter((n) => n.data.stale).map((n) => n.id).sort()
check('改 source 配置后全部节点过期', JSON.stringify(staleAfterEdit) === JSON.stringify(['aggregate-region', 'filter-paid', 'join-customer', 'sink-warehouse', 'source-orders', 'transform-clean']))
check('批次记录仍为一条', get().batches.length === 1)

// 4. 再次执行：配置变化 -> 新批次，全部重算
summary = await get().simulate()
check('配置变化后生成新批次', get().batches.length === 2)
check('全部重算成功', summary!.executed === 6 && summary!.reused === 0)
check('执行后无过期', get().nodes.every((n) => !n.data.stale))

// 5. 失败演练：filter 失败，上游成功结果恢复，下游取消
get().updateConfig('filter-paid', 'simulateFail', true)
summary = await get().simulate()
check('失败执行返回 failed', summary!.failed === true)
check('失败节点为 filter-paid', summary!.failedNodeId === 'filter-paid')
check('上游 source/transform 成功结果已恢复', summary!.reused + summary!.succeeded === 2)
check('失败节点自身已重算', summary!.executed === 1)
check('当前批次状态 failed', lastBatch().status === 'failed')
const errorNode = get().nodes.find((n) => n.id === 'filter-paid')
check('失败节点状态 error', errorNode!.data.status === 'error' && errorNode!.data.stale === true)
const skippedNodes = get().nodes.filter((n) => n.data.status === 'skipped')
check('3 个未开始下游被取消', skippedNodes.length === 3)
const recoveredSource = get().nodes.find((n) => n.id === 'source-orders')
check('上游 source 仍 success 且未过期', recoveredSource!.data.status === 'success' && recoveredSource!.data.stale === false)

// 6. 修复后重跑：回到已知快照，全部复用恢复
get().updateConfig('filter-paid', 'simulateFail', false)
summary = await get().simulate()
check('修复后无失败', summary!.failed === false)
check('filter 恢复 success', get().nodes.find((n) => n.id === 'filter-paid')!.data.status === 'success')
check('当前批次状态 succeeded', currentBatch()!.status === 'succeeded')
check('无过期标记', get().nodes.every((n) => !n.data.stale))

// 7. 删连线：sink 过期
get().onEdgesChange([{ type: 'remove', id: 'e5' }])
check('删连线后 sink 过期', get().nodes.find((n) => n.id === 'sink-warehouse')!.data.stale === true)

// 8. 中断恢复：把当前批次置 running，删两个结果，再执行
get().onEdgesChange([{ type: 'add', item: { id: 'e5', source: 'join-customer', sourceHandle: 'out-0', target: 'aggregate-region', targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } } }])
await get().simulate()  // 先恢复到完整成功
const batchIdBefore = get().currentBatchId!
useWorkflowStore.setState((draft) => {
  // 模拟中断：当前批次置 running，并从所有批次删除 aggregate/sink 结果（使其无处复用）
  draft.batches.forEach((b) => {
    delete b.results['sink-warehouse']
    delete b.results['aggregate-region']
  })
  const b = draft.batches.find((x) => x.batchId === batchIdBefore)!
  b.status = 'running'
})
get().hydrate()
summary = await get().simulate()
check('中断恢复：resumed=true', summary!.resumed === true)
check('中断恢复：复用 4 个未受影响节点', summary!.reused === 4)
check('中断恢复：重算缺失的 2 个节点', summary!.executed === 2)
check('恢复后仍是同一条批次', get().currentBatchId === batchIdBefore)
check('恢复后批次状态 succeeded', currentBatch()!.status === 'succeeded')

// 9. 落盘验证
const persisted = JSON.parse(memory.get('flowpilot:batches:v1') ?? '[]')
check('批次已写穿透到 localStorage', persisted.length === get().batches.length && persisted[persisted.length - 1].batchId === lastBatch().batchId)
const persistedSnaps = JSON.parse(memory.get('flowpilot:snapshots:v1') ?? '[]')
check('快照已写穿透到 localStorage', persistedSnaps.length >= 1)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
