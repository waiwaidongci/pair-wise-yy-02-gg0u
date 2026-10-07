import { Empty, Tag } from 'antd'
import { useWorkflowStore } from '../stores/workflow'
import { shortId, summarizeBatch } from '../utils/execution'
import type { BatchStatus } from '../types/workflow'

const statusMeta: Record<BatchStatus, { color: string; label: string }> = {
  running: { color: 'processing', label: '运行中' },
  success: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  interrupted: { color: 'warning', label: '已中断' },
}

export default function BatchHistory() {
  const batches = useWorkflowStore((state) => state.batches)
  const snapshots = useWorkflowStore((state) => state.snapshots)
  const resultCache = useWorkflowStore((state) => state.resultCache)
  const latestVersion = snapshots.reduce((max, item) => Math.max(max, item.version), 0)

  return (
    <div className="batch-history">
      <div className="batch-history-summary">
        <span>当前快照 v{latestVersion}</span>
        <span>缓存结果 {Object.keys(resultCache).length} 份</span>
        <span>批次 {batches.length} 个</span>
      </div>
      {!batches.length && (
        <Empty description="还没有运行批次，点击「执行流程」开始" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
      {[...batches].reverse().map((batch) => {
        const summary = summarizeBatch(batch)
        const meta = statusMeta[batch.status]
        return (
          <div key={batch.id} className="batch-item">
            <div className="batch-item-head">
              <Tag color={meta.color}>{meta.label}</Tag>
              <strong>批次 {shortId(batch.id)}</strong>
              <span className="batch-snapshot">快照 v{batch.snapshotVersion}</span>
            </div>
            <div className="batch-item-stats">
              <span>新算 {summary.computed}</span>
              <span>复用 {summary.reused}</span>
              <span>失败 {summary.failed}</span>
              <span>跳过 {summary.skipped}</span>
              <span>共 {summary.total} 节点</span>
            </div>
            <div className="batch-item-time">{new Date(batch.createdAt).toLocaleString('zh-CN')}</div>
          </div>
        )
      })}
    </div>
  )
}
