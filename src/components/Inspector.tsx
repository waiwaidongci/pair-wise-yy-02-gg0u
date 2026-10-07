import { Button, Divider, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { statusLabel, useWorkflowStore } from '../stores/workflow'
import { definitionFor } from '../utils/workflow'

export default function Inspector() {
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId)
  const selectedEdgeId = useWorkflowStore((state) => state.selectedEdgeId)
  const node = useWorkflowStore((state) => state.nodes.find((item) => item.id === state.selectedNodeId))
  const edge = useWorkflowStore((state) => state.edges.find((item) => item.id === state.selectedEdgeId))
  const updateNode = useWorkflowStore((state) => state.updateNode)
  const updateConfig = useWorkflowStore((state) => state.updateConfig)
  const deleteSelection = useWorkflowStore((state) => state.deleteSelection)

  if (!selectedNodeId && !selectedEdgeId) {
    return (
      <aside className="inspector-panel empty-inspector">
        <Typography.Title level={5}>属性配置</Typography.Title>
        <Typography.Text type="secondary">选择节点或连线后，可编辑业务参数。</Typography.Text>
      </aside>
    )
  }

  if (edge) {
    return (
      <aside className="inspector-panel">
        <div className="panel-heading"><Typography.Title level={5}>连线属性</Typography.Title></div>
        <Tag color="blue">{edge.data?.portType ?? 'dataset'}</Tag>
        <Form layout="vertical" className="inspector-form">
          <Form.Item label="源节点">
            <Input value={edge.source} disabled />
          </Form.Item>
          <Form.Item label="目标节点">
            <Input value={edge.target} disabled />
          </Form.Item>
        </Form>
        <Button danger block icon={<DeleteOutlined />} onClick={deleteSelection}>删除连线</Button>
      </aside>
    )
  }

  if (!node) return null
  const definition = definitionFor(node.data.kind)
  return (
    <aside className="inspector-panel">
      <div className="panel-heading">
        <div>
          <Typography.Title level={5}>节点属性</Typography.Title>
          <Typography.Text type="secondary">ID: {node.id}</Typography.Text>
        </div>
        <Tag color={definition.color}>{statusLabel(node.data.status)}</Tag>
      </div>
      <Form layout="vertical" className="inspector-form">
        <Form.Item label="节点名称">
          <Input value={node.data.label} onChange={(event) => updateNode(node.id, { label: event.target.value })} />
        </Form.Item>
        <Form.Item label="说明">
          <Input.TextArea
            rows={2}
            value={node.data.description}
            onChange={(event) => updateNode(node.id, { description: event.target.value })}
          />
        </Form.Item>
        <Divider orientation="left">执行参数</Divider>
        {Object.entries(node.data.config).map(([key, value]) => (
          <Form.Item key={key} label={key}>
            {typeof value === 'boolean' ? (
              <Switch checked={value} onChange={(checked) => updateConfig(node.id, key, checked)} />
            ) : typeof value === 'number' ? (
              <InputNumber
                style={{ width: '100%' }}
                value={value}
                onChange={(next) => updateConfig(node.id, key, next ?? 0)}
              />
            ) : key.includes('Type') || key === 'mode' || key === 'refresh' ? (
              <Select
                value={value}
                options={[value, 'left', 'inner', 'upsert', 'append', '实时', '每小时']
                  .filter((item, index, list) => list.indexOf(item) === index)
                  .map((item) => ({ value: item, label: item }))}
                onChange={(next) => updateConfig(node.id, key, next)}
              />
            ) : (
              <Input value={String(value)} onChange={(event) => updateConfig(node.id, key, event.target.value)} />
            )}
          </Form.Item>
        ))}
      </Form>
      <Space direction="vertical" style={{ width: '100%' }}>
        <div className="run-facts">
          <span>输入端口：{definition.inputs.join(' / ') || '无'}</span>
          <span>输出端口：{definition.outputs.join(' / ') || '无'}</span>
          <span>最近耗时：{node.data.duration ?? '--'} ms</span>
          <span>处理行数：{node.data.rows?.toLocaleString('zh-CN') ?? '--'}</span>
        </div>
        <Button danger block icon={<DeleteOutlined />} onClick={deleteSelection}>删除节点</Button>
      </Space>
    </aside>
  )
}
