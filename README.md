# dsh-checkpoints

DSH 对话检查点插件：把**每次你发送的用户指令**当作一个检查点列出来，支持：

- **定位**：点击检查点，平滑滚动到聊天记录里对应的那条指令，不用自己滚轮。
- **回退**：把当前会话的可见对话回退到某个检查点——该检查点之后的 AI 回复/工具结果都会从可见历史中折叠掉，你可以在原会话继续。
- **文件一起回退（可选）**：回退检查点时询问你是否同时恢复该检查点时的文件状态。
- **编辑**：把某条已发送的指令连同它之后的内容撤回，并在原位打开编辑框——可以切换模型和思考强度；改完按发送，AI 就会基于修改后的指令重新回答。
- **文件改动统计**：侧边栏下半实时显示本次会话/最近检查点以来的文件改动，类似 VS Code 的 `+a -d` 列表，并且每个文件都可以单独撤销。

## 原理

DSH 的会话日志是 **append-only** 的，不能真的删除/改写旧事件。本插件用 DSH 官方支持的 surface `replace` 机制追加一条“替换节点”，让**模型可见的历史**和**网页对话流**折叠到目标位置；原始日志仍然完整保留。

文件侧：

- 每次你发送一条真实用户指令时，插件会为该会话的工作目录拍一个**文件快照**。当前采用 **VS Code 式混合策略**：
  - Git 仓库：已跟踪文件用轻量 Git 快照，未跟踪/新建文件用复制快照；
  - 非 Git 仓库：直接用完整复制快照。
- “最近检查点”统计 = 当前工作区 vs 最近一条用户指令时的快照。
- “本次会话”统计 = 当前工作区 vs 会话开始时的快照。
- 回退文件 = 用对应检查点的快照覆盖当前工作区（只覆盖快照里存在的文件，检查点之后新建的文件默认保留）。
- 单文件撤销 = 从当前选中的基准快照恢复该文件（如果该文件在快照里不存在，会删除这个新建文件）。

## 安装

在 DSH checkout 之外开发/安装：

```sh
cd dsh-checkpoints
npm install
npm run build

dsh plugin --profile web add /absolute/path/to/dsh-checkpoints
# 然后重启 web profile
```

如果使用本地 DSH checkout 做类型链接，参考 DSH 插件文档把 `@deepseek-ai/*` peer 依赖链接到 checkout 的构建产物。

## 使用

1. 安装并重启后，网页右缘会出现一个 **检查点** 侧边标签。
2. 点击标签打开右侧边栏：上半是**检查点**列表，下半是**文件改动**统计，两栏各占一半、各自独立滚动。
3. 检查点列表按顺序列出你发过的每条用户指令：
   - 点击任意一条即可**定位**：平滑滚动到聊天记录里那条指令（必要时自动加载更早的历史）。
   - 带 **⭯** 徽标表示该检查点有文件快照，编辑时可同时恢复文件。
4. 聊天里你发过的消息下方有**编辑**按钮：
   - 原消息被撤回并在原位打开编辑框，可切换模型与思考强度；
   - 发送前会询问是否同时回退代码改动；
   - AI 会基于修改后的指令重新回答。
5. 下半的**文件改动**统计条：
   - 可切换“最近检查点”/“本次会话”，点“刷新”立即重算；
   - 展开后显示每个文件的 `+新增 -删除` 行数（二进制文件单独标注）；
   - 点“撤销”可把单个文件恢复到当前基准；
   - 若所选基准没有快照，会提示当前对比的是会话开始时的状态。

> 编辑功能采用“撤回并原位重写”的方式实现：旧回复会被移除，编辑后的内容通过普通输入框路径发出。这是为了避免在 append-only 日志里产生重复消息。若自动发送失败，插件会把编辑文本弹窗展示出来，不会静默丢失。

## HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-checkpoints/list?sessionId=<id>` | 返回当前可见的用户指令检查点，含 `hasSnapshot`（该检查点是否有文件快照） |
| GET | `/plugins/dsh-checkpoints/surface?sessionId=<id>` | 返回被 surface replace 折叠的事件 seq（客户端刷新后据此隐藏旧消息行） |
| GET | `/plugins/dsh-checkpoints/diff?sessionId=<id>&baseline=checkpoint\|session` | 返回文件改动统计；`degraded: true` 表示所选基准没有快照，实际对比的是会话开始 |
| POST | `/plugins/dsh-checkpoints/rewind` | body `{ sessionId, seq, rollbackFiles?, deleteNewFiles? }`，回退对话，可选回退文件，可选删除检查点后新建文件（移入回收区）；返回 `filesRestored`（文件回滚失败时为 `false`，对话回退仍生效） |
| POST | `/plugins/dsh-checkpoints/recall` | body `{ sessionId, seq }`，撤回该指令及其后内容，返回 `removedText` 与 `filesRestored` |
| POST | `/plugins/dsh-checkpoints/undo-file` | body `{ sessionId, path, baseline }`，撤销单个文件改动 |

所有 POST 路由要求 `content-type: application/json` 且请求同源（`Origin` 与 `Host` 一致），以阻断跨站伪造请求。

> 回退/撤销文件时，如果目标检查点没有自己的快照，插件会**直接报错**而不是静默回退到会话开始的状态；diff 路由则通过 `degraded` 字段如实标注实际对比的基准。

## 配置

可通过 `cordis.patch.yml` 或 profile 配置传入：

```yaml
- insert:
    - id: dsh-checkpoints
      name: dsh-checkpoints
      config:
        snapshotRoot: /absolute/path/to/snapshot-dir
```

- `routePrefix`：路由前缀，默认 `/plugins/dsh-checkpoints`。
- `snapshotRoot`：文件快照根目录，默认 `$DSH_HOME/dsh-checkpoints`。

## 构建

```sh
npm run build      # 产物输出到 lib/
npm run typecheck  # 双目标类型检查
```

## 最近更新

- **性能**：文件改动改为事件驱动刷新（不再每 2 秒轮询全量 diff）；行差计算加“未修改短路”与低内存 LCS；`/list` 单次读取快照索引；快照复制并发执行。
- **快照**：Git 快照提交钉入 `refs/dsh-checkpoints/*` 命名空间，不再怕被 `git gc` 回收；跳过快照根自身与超过 64MB 的单文件。
- **正确性**：目标检查点没有快照时，回退/撤销文件直接报错（不再静默回退到会话开始）；diff 返回 `degraded` 如实标注实际基准；修复中文路径转义、二进制文件、重命名文件的统计。
- **安全**：POST 路由校验 `content-type: application/json` 与同源 Origin，阻断跨站伪造。
- **界面**：侧边栏上下两栏各占一半、独立滚动；检查点行显示 ⭯ 快照徽标；编辑框支持选择思考强度；发送失败时明确提示，不丢文本。

## 限制

- 会话正在运行时（`agent.status === 'running'`）会拒绝回退/编辑/单文件撤销，请先停止当前回合。
- 编辑第一条消息时，插件会用一条空 assistant 消息作为替换节点把可见对话清空；空 assistant 不产生模型消息，因此可以正常重发。
- 当前采用**混合快照**：Git 仓库里，已跟踪文件走 Git，未跟踪/新建文件走复制；非 Git 仓库走完整复制。快照会跳过 `node_modules`、`.git`、`dist`、`build` 等目录，也会跳过快照根目录自身和超过 64MB 的单个文件。Git 快照提交会钉在 `refs/dsh-checkpoints/<会话>/` 命名空间下，避免被 `git gc` 回收。
- 整体文件回退是“覆盖式”的：恢复 Git 已跟踪文件 + 复制回来的未跟踪快照文件；检查点之后新建的未跟踪文件默认保留，不会自动删除。
- 如果回退时选择“删除检查点之后新建的文件”，这些文件不会被永久删除，而是先移入快照根目录下的 `quarantine/<session>/<时间戳>/` 回收区，需要时还可以手动找回。
- 单文件撤销：如果该文件在快照中不存在，也会移入上述回收区，而不是永久删除。
- 插件不负责数据库、远程 API、外部进程等非文件副作用。
- 原始日志中的旧事件仍然存在；如果你需要“彻底删除”日志事件，当前 DSH 设计不支持，请使用 fork 分支或等待官方 recall/rewind 能力。
