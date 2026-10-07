# FlowPilot 节点式数据工作流编辑器

基于 React、TypeScript、Vite、React Flow、Ant Design、Zustand、Immer 与 React Router。

## 功能

- 从节点库拖拽数据源、变换、过滤、聚合、双流关联和输出节点。
- 连线时校验输入/输出端口类型，实时拒绝类型冲突和环形依赖。
- 支持框选、复制粘贴、删除、撤销重做、缩略图与依赖层级自动布局。
- 模拟执行按拓扑顺序展示每个节点的运行状态、处理行数和耗时。
- 流程保存为 JSON 并可重新导入。

## 运行

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```
