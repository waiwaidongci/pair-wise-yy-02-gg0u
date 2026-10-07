import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import type { RunStatus, WorkflowNode } from '../types/workflow'
import { definitionFor } from '../utils/workflow'

const statusIcon: Record<RunStatus, React.ReactNode> = {
  idle: <ClockCircleOutlined />,
  queued: <ClockCircleOutlined />,
  running: <LoadingOutlined spin />,
  success: <CheckCircleFilled />,
  error: <CloseCircleFilled />,
  skipped: <ClockCircleOutlined />,
}

export default function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowNode>) {
  const definition = definitionFor(data.kind)
  return (
    <div
      className={`workflow-node ${selected ? 'is-selected' : ''} status-${data.status}`}
      style={{ '--node-color': definition.color } as React.CSSProperties}
    >
      {definition.inputs.map((type, index) => (
        <Handle
          key={`in-${index}`}
          id={`in-${index}`}
          type="target"
          position={Position.Left}
          className={`port port-${type}`}
          style={{ top: 46 + index * 34 }}
        />
      ))}
      <div className="workflow-node-head">
        <span className="node-kind">{data.kind}</span>
        <span className={`node-status status-${data.status}`}>
          {statusIcon[data.status]}
          {data.status}
        </span>
      </div>
      <strong>{data.label}</strong>
      <p>{data.description}</p>
      <div className="node-metrics">
        {data.rows !== undefined && <span>{data.rows.toLocaleString('zh-CN')} 行</span>}
        {data.duration !== undefined && <span>{data.duration} ms</span>}
      </div>
      {definition.outputs.map((type, index) => (
        <Handle
          key={`out-${index}`}
          id={`out-${index}`}
          type="source"
          position={Position.Right}
          className={`port port-${type}`}
          style={{ top: 50 + index * 34 }}
        />
      ))}
    </div>
  )
}
