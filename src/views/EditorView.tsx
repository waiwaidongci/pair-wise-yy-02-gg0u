import { App as AntApp, Button, Input, Popover, Space, Tooltip, Upload } from 'antd'
import {
  ApartmentOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SnippetsOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useRef } from 'react'
import type { UploadProps } from 'antd'
import NodePalette from '../components/NodePalette'
import Inspector from '../components/Inspector'
import WorkflowCanvas from '../components/WorkflowCanvas'
import BatchHistory from '../components/BatchHistory'
import { useWorkflowStore } from '../stores/workflow'
import type { LegacyWorkflowDocument, WorkflowDocument } from '../types/workflow'

export default function EditorView() {
  const { message } = AntApp.useApp()
  const uploadRef = useRef<HTMLInputElement>(null)
  const store = useWorkflowStore()

  function exportJson() {
    const document: WorkflowDocument = {
      version: 2,
      name: store.name,
      nodes: store.nodes,
      edges: store.edges,
      snapshots: store.snapshots,
      batches: store.batches,
      resultCache: store.resultCache,
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name.replace(/\s+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    message.success('流程 JSON 已导出（含快照与结果缓存）')
  }

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        const document = JSON.parse(await file.text()) as WorkflowDocument | LegacyWorkflowDocument
        if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) throw new Error('JSON 缺少 nodes 或 edges')
        store.loadDocument(document)
        message.success('流程导入成功')
      } catch (error) {
        message.error(error instanceof Error ? error.message : '流程 JSON 无效')
      }
      return false
    },
  }

  async function run() {
    const batch = await store.run()
    if (!batch) return
    if (batch.status === 'success') {
      message.success({ content: `批次执行完成（快照 v${batch.snapshotVersion}）`, key: 'run' })
    } else {
      message.warning({ content: '批次未全部成功，成功结果已保留可续跑', key: 'run' })
    }
  }

  return (
    <div className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">FP</div>
          <div><strong>FlowPilot</strong><span>数据工作流编排平台</span></div>
        </div>
        <Input
          className="flow-name"
          value={store.name}
          onChange={(event) => store.setName(event.target.value)}
          prefix={<SnippetsOutlined />}
        />
        <Space wrap>
          <Tooltip title="撤销"><Button icon={<UndoOutlined />} disabled={!store.past.length} onClick={store.undo} /></Tooltip>
          <Tooltip title="重做"><Button icon={<RedoOutlined />} disabled={!store.future.length} onClick={store.redo} /></Tooltip>
          <Tooltip title="复制"><Button icon={<CopyOutlined />} onClick={store.copySelection} /></Tooltip>
          <Tooltip title="粘贴"><Button icon={<SnippetsOutlined />} onClick={store.pasteSelection} /></Tooltip>
          <Tooltip title="删除"><Button danger icon={<DeleteOutlined />} onClick={store.deleteSelection} /></Tooltip>
          <Button icon={<ApartmentOutlined />} onClick={store.layout}>自动布局</Button>
          <Upload {...uploadProps}><Button icon={<CloudUploadOutlined />}>导入</Button></Upload>
          <Button icon={<CloudDownloadOutlined />} onClick={exportJson}>导出</Button>
          <Button icon={<ReloadOutlined />} onClick={store.reset}>重置</Button>
          <Popover
            trigger="click"
            placement="bottomRight"
            content={<div className="batch-popover"><BatchHistory /></div>}
          >
            <Button icon={<HistoryOutlined />}>运行记录</Button>
          </Popover>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={store.running} onClick={run}>执行流程</Button>
        </Space>
      </header>
      <main className="editor-grid">
        <NodePalette />
        <WorkflowCanvas />
        <Inspector />
      </main>
    </div>
  )
}
