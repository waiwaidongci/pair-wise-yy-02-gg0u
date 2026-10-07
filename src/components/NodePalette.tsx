import { Input, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useState } from 'react'
import { useWorkflowStore } from '../stores/workflow'
import { NODE_DEFINITIONS } from '../utils/workflow'

export default function NodePalette() {
  const [keyword, setKeyword] = useState('')
  const addNode = useWorkflowStore((state) => state.addNode)
  const filtered = NODE_DEFINITIONS.filter((item) =>
    `${item.label}${item.description}${item.kind}`.toLowerCase().includes(keyword.toLowerCase()),
  )

  function dragStart(event: React.DragEvent, kind: string) {
    event.dataTransfer.setData('application/x-workflow-node', kind)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className="palette-panel">
      <div className="panel-heading">
        <div>
          <Typography.Title level={5}>节点库</Typography.Title>
          <Typography.Text type="secondary">拖入画布或双击添加</Typography.Text>
        </div>
      </div>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索节点"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />
      <div className="palette-list">
        {filtered.map((item) => (
          <button
            key={item.kind}
            type="button"
            className="palette-card"
            draggable
            onDragStart={(event) => dragStart(event, item.kind)}
            onDoubleClick={() => addNode(item.kind)}
          >
            <span className="palette-icon" style={{ background: item.color }} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="port-legend">
        <strong>端口类型</strong>
        <span><i className="legend-dot dataset" /> dataset 数据集流</span>
        <span><i className="legend-dot number" /> number 指标值</span>
      </div>
    </aside>
  )
}
