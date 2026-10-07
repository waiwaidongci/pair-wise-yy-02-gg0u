import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useRef } from 'react'
import { useWorkflowStore } from '../stores/workflow'
import WorkflowNodeCard from './WorkflowNodeCard'
import type { WorkflowNode } from '../types/workflow'

const nodeTypes = { workflow: WorkflowNodeCard }

function CanvasInner() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const reactFlow = useReactFlow<WorkflowNode>()
  const nodes = useWorkflowStore((state) => state.nodes)
  const edges = useWorkflowStore((state) => state.edges)
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange)
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange)
  const connect = useWorkflowStore((state) => state.connect)
  const addNode = useWorkflowStore((state) => state.addNode)
  const selectNode = useWorkflowStore((state) => state.selectNode)
  const selectEdge = useWorkflowStore((state) => state.selectEdge)
  const copySelection = useWorkflowStore((state) => state.copySelection)
  const pasteSelection = useWorkflowStore((state) => state.pasteSelection)
  const deleteSelection = useWorkflowStore((state) => state.deleteSelection)
  const undo = useWorkflowStore((state) => state.undo)
  const redo = useWorkflowStore((state) => state.redo)
  const notice = useWorkflowStore((state) => state.notice)
  const clearNotice = useWorkflowStore((state) => state.clearNotice)

  useEffect(() => {
    const timer = window.setTimeout(clearNotice, 3200)
    return () => window.clearTimeout(timer)
  }, [notice, clearNotice])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, [contenteditable="true"]')) return
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        copySelection()
      } else if (command && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        pasteSelection()
      } else if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? redo() : undo()
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        deleteSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [copySelection, deleteSelection, pasteSelection, redo, undo])

  function handleConnect(connection: Connection) {
    connect(connection)
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    const kind = event.dataTransfer.getData('application/x-workflow-node')
    if (!kind) return
    const bounds = wrapperRef.current?.getBoundingClientRect()
    const position = reactFlow.screenToFlowPosition({
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
    })
    addNode(kind as WorkflowNode['data']['kind'], position)
  }

  return (
    <div ref={wrapperRef} className="flow-wrapper" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, node) => selectNode(node.id)}
        onEdgeClick={(_, edge) => selectEdge(edge.id)}
        onPaneClick={() => { selectNode(null); selectEdge(null) }}
        fitView
        minZoom={0.2}
        maxZoom={1.8}
        selectionOnDrag
        panOnDrag={[1, 2]}
        colorMode="light"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="#c8d3e1" />
        <MiniMap nodeColor={(node) => node.data.kind === 'sink' ? '#16a34a' : '#2563eb'} pannable zoomable />
        <Controls />
        {notice && <Panel position="top-center"><div className="canvas-notice">{notice}</div></Panel>}
      </ReactFlow>
    </div>
  )
}

export default function WorkflowCanvas() {
  return <ReactFlowProvider><CanvasInner /></ReactFlowProvider>
}
