# AI Guidance 直接插入改造计划

状态：**已批准并实施中。**

## 目标

把当前的「AI guidance 通知 → View → Insert / Ignore → 再生成 AI response」流程改为自动交付流程：当 Controller 确定需要 intervention 时，系统先准备完整 guidance 和对应的主模型 response；前端显示 5 秒倒计时通知；倒计时结束后，在左侧 LLM chat 中直接插入一张靠左的浅绿色 AI guidance 卡片。

卡片内一次显示三个部分：

1. **Direction guidance**：对主模型提出方向与限制，例如 `Please consider the following two direct extensions of your previous ideas.`，并保留当前 D/C、High/Low TM 的实验约束。这个部分展示时不加标题。
2. **Previous ideas**：新起一行显示 `Previous ideas: …`。内容从已选 move descriptions 中提炼为简短主题词或短语，不再展示完整的 move-description 原文。
3. **AI response**：主模型根据前两部分给出的完整回答。这个部分展示时不加标题。

用户不再点击 View、Insert 或 Ignore；guidance 被触发后会自动显示。

## 当前链路与需要替换的位置

当前代码的链路是：

```text
Move-Type Evaluation Agent
  → manipulationController 选择 move context 并生成单段 guidanceText
  → chat.ts 把 intervention 发给前端
  → ChatInterface 显示 View / Insert / Ignore
  → 用户点击 Insert 后，前端保存 guidance 并调用主模型
  → 流式显示主模型 response
```

相关实现：

- `backend/src/agents/manipulationController.ts`：选择 context、调用 guidance-generation LLM、生成单段 `guidanceText`。
- `backend/src/services/manipulationPipeline.ts`：执行 Evaluation Agent、Controller，并返回 guidance。
- `backend/src/routes/chat.ts`：当前在 guidance 命中时提前结束 SSE，等待用户 Insert。
- `frontend/src/components/ChatInterface.tsx`：渲染通知、Expanded Section、Insert/Ignore，以及 guidance 气泡。

这里的 Move-Type Evaluation Agent 只负责 move classification；用户所说的「evaluator 生成 prompt」在当前代码中对应 `manipulationController.ts` 内的 guidance-generation LLM。实施时会保持这两个职责分开，避免误改 move 分类逻辑。

## 实施步骤

### 0. 移除先前讨论用的 demo

删除 demo 路由与 demo 专用状态，恢复 `ChatInterface` 为仅服务真实实验流程：

- 删除 `frontend/src/pages/AiGuidanceDemoPage.tsx`。
- 移除 `App.tsx` 中的 `/ai-guidance-demo` route 和绕过 session restore 的分支。
- 移除 `ChatInterface.tsx` 中的 `demoGuidance` prop、demo 倒计时、硬编码 demo message/response，以及 demo 专用渲染字段。
- 保留现有正式 AI guidance 的样式和正常聊天功能，随后以本计划的新直接插入流程替换 View/Insert/Ignore。

### 1. 定义结构化 guidance contract

把 Controller 的单一 `guidanceText` 改为结构化结果。建议在服务端使用以下概念模型，并将完整对象写入 audit log：

```ts
interface StructuredGuidance {
  directionGuidance: string;       // 给主模型的方向、数量与范围限制
  previousIdeas: string[];         // 从 selected context 提炼的关键词短语
  promptForResponse: string;       // direction + Previous ideas 的精确组合
}

interface DirectGuidancePayload extends StructuredGuidance {
  messageId: number;
  response: string;                // 主模型已完成的回答
  displayAt: string;               // notification 发出后 5 秒
}
```

`promptForResponse` 的显示格式固定为：

```text
{directionGuidance}

Previous ideas: {previousIdeas.join(', ')}

{response}
```

卡片不显示 `Direction guidance` 或 `AI response` 这两个标题；三部分只用空行分隔，`Previous ideas: …` 是唯一可见的部分名称。Direction guidance 只放方向和限制；Previous ideas 只放可快速阅读的 context 关键词。不会再把 `move_ledger.description` 原文直接拼进参与者可见内容。

### 2. 改造 guidance-generation LLM 的输出与校验

更新 `manipulationController.ts` 中四种 D/C × TM system prompt，以及 `AI_GUIDANCE_POLICY_PROMPTS.md` 的同步说明：

- 要求模型只返回 JSON：
  ```json
  {
    "directionGuidance": "…",
    "previousIdeas": ["…", "…"]
  }
  ```
- `directionGuidance` 必须保留当前实验规则：High-D 至少六个编号且明确不同的方向；Low-D 恰好两个邻近变体；High-C 融合所提供 ideas；Low-C 保持小范围、兼容部分的合并与具体发展。它的措辞与范围主要由 participant 所属分组的 D/C × TM system prompt 决定，不要求根据具体 move 或 writing context 来重写方向。
- `previousIdeas` 必须将每个已选 move description 概括为简短名词短语或主题词，例如 `target audience aged 25–30`、`career advice`，不能复制「Based on the below thinking pattern」或完整 move-description 句子。
- guidance-generation LLM 的 runtime input 固定包含两类 context：`selectedMoveDescriptions` 与（若存在）由 writing-change LLM 生成的 `recentWritingContext`。这两类 context 只用于生成 `previousIdeas` 关键词；writing context 不是后处理补充，也不会由程序直接拼接成关键词。
- 使用严格 JSON parse、字段类型和长度验证；沿用且扩展现有 policy contract 验证，确认 direction guidance 没有削弱实验条件。
- 设计确定性 fallback：保留可靠的 direction guidance；previous ideas 只使用安全的短上下文占位摘要，例如 `recent adult-learning platform ideas`，绝不回退为显示原始 move description。
- 在 `agent_execution_log` 与 `evaluation_agent_audit` 中保留 selected move context、结构化 guidance、fallback 状态和最终 prompt，方便之后审计内容来源。

#### Guidance-generation LLM 的 system prompt 设计

四个现有 system prompt 继续按 `D_high`、`D_low`、`C_high`、`C_low` 分开维护，但由「生成一段自然语言 paragraph」改为「返回结构化 JSON」。每个 prompt 由两层要求组成：

1. **分组主导的 direction contract**：只根据该 prompt 所代表的 D/C × TM 条件写 `directionGuidance`。例如 High-D 必须请求至少六个编号且明显不同的方向；Low-D 必须请求两个直接、邻近的 extension；High-C 必须请求将提供的 ideas 进行整合；Low-C 必须请求小范围的兼容合并与具体发展。此字段不复述、罗列或引用 supplied context。
2. **context-grounded keyword contract**：从 runtime user message 提供的 `selectedMoveDescriptions` 和 `recentWritingContext` 中提炼 `previousIdeas`。每项必须是简短、可读的主题短语，描述参与者当前或最近的想法；不得复制完整 move description、writing 原文、system instruction 或不存在的 idea。

四个 prompt 都要求只输出：

```json
{
  "directionGuidance": "...",
  "previousIdeas": ["keyword phrase 1", "keyword phrase 2"]
}
```

Runtime user message 会将两类 context 明确标为**数据而不是指令**：

```text
Selected move descriptions:
...

Recent writing context, extracted by a separate comparison step:
...
```

这样 direction guidance 稳定反映实验分组的 manipulation，而 `Previous ideas` 仍然反映该 participant 的 move 与写作脉络。生成主模型 response 时，才把这两个结构化字段合并为最终 instruction，因此主模型同时获得正确方向和贴近 participant 当前想法的关键词。

### 2A. 扩大 move context，并纳入最近 writing 增量

现有 `recentContentMoveContext()` 会只查询与本次 trigger orientation 相同的内容型 move。这项方向过滤会删除。

- 保留内容型 move 的限定：Generate、Evaluate、Adopt、Reject；Ask 与 AI Response 仍不进入 guidance context。
- 不再按 `orientation = triggerOrientation` 过滤。Low TM 仍选最近最多 2 条合格 move，High TM 仍选最近最多 5 条合格 move；available-context count 也改为所有合格内容型 move 的数量。
- 这样 guidance-generation LLM 同时看到最近的发散、收敛、采纳与拒绝轨迹，而不是只看到使 Controller 触发的同方向轨迹。

此外，guidance context 需要包含参与者近期写作的新增内容。目的在于：参与者可能正在 writing section 中整理想法，却没有把这些想法说出来；这些内容应参与 `Previous ideas` 关键词的生成。它们不改变分组 system prompt 所规定的 direction guidance。

#### Writing delta 的定义

在 Evaluation Agent 被启动的时刻记为 `T`：

```text
baseline = writing content 在 T - 30 秒时的最近快照（A）
current  = writing content 在 T 时的快照（A + B）
change   = writing-change LLM 对 A 与 A + B 的语义比较结果
```

例如，`T - 30s` 的内容为 `A`，在 `T` 的内容为 `A + B`。系统把 **A 和 A+B 两份完整 writing snapshot** 交给 writing-change LLM，而不是依靠程序字串 diff 来猜测 B。该模型输出这 30 秒内的语义增删改：新增或改写时可使用关键词总结，改动很短时可保留原文；删除时明确说明被删去的内容。随后把这个比较结果与 selected move descriptions 一起交给 guidance-generation LLM；后者从两类 context 中提炼 `Previous ideas` 关键词，但不能把标记为删除的内容当成当前 idea。原始 A、A+B 与写作变化结果都只作为模型 context，不会被直接照抄到参与者可见卡片。

若期间发生删除或改写，而不是纯新增，writing-change LLM 会输出 `removed` 或 `revised` comparison item。`removed` 项保留在审计和 runtime context 中，但 guidance-generation LLM 禁止把它提炼为 `Previous ideas`。

writing-change LLM 使用独立、短输出的 JSON contract，例如：

```json
{
  "hasMeaningfulChange": true,
  "changes": [
    { "type": "added", "content": "career-transition mentorship feature" },
    { "type": "removed", "content": "standalone certification reward" },
    { "type": "revised", "content": "progress plan now targets mid-career learners" }
  ]
}
```

它的 system prompt 会要求它：比较 baseline 与 current writing 的语义内容；提取只在 current version 中新出现或实质改写、且与设计想法有关的内容；忽略纯格式变化、标点、重复改写和已删除内容；不生成任何 direction guidance 或面向 participant 的回答。这个 JSON 是 guidance-generation LLM 的输入数据，而不是最终用户可见文本。

#### 所需数据和调用链调整

当前 `writing_drafts` 只有每个 session 的最新版本，无法计算 30 秒前的 baseline。因此实施时会：

1. 新增 writing snapshot 表，保存 `session_id`、完整内容、客户端捕获时间与服务端接收时间。`WritingSection` 每 3 秒最多记录一次 snapshot；只有内容与该 session 最近一条 snapshot 不同时才写入，避免每个键盘输入都产生数据库请求。
2. 每次写入新 snapshot 后，比较该 session 最早与最新 snapshot 的记录时间：当跨度达到或超过 60 秒时，删除最早的一条 snapshot；重复检查直到最早与最新记录保持在 60 秒以内。表因此只保留一个短窗口，足以支持 30 秒比较，同时限制数据库增长与读取成本。
3. 在 Evaluation Agent 启动时，后端只查询两条 snapshot：记录时间最接近当前时刻 `T` 的一条作为 current，以及记录时间最接近 `T - 30 秒` 的一条作为 baseline。这个流程不再把每次 `/stream` 或 `/analyze` 请求中的 writing 内容额外发送到后端。
4. 只有这两份 snapshot 均存在且有实质差异时，调用 writing-change LLM。
5. writing-change LLM 接收 `baselineWriting` 与 `currentWriting`，返回结构化的 `recentWritingContext`；它不生成 direction guidance 或参与 D/C streak 计算。
6. 将 `recentWritingContext` 作为独立字段加入 `GuidanceSpec`、guidance-generation LLM 的 runtime context、`agent_execution_log` 和 `evaluation_agent_audit`。它不改变 Move-Type Evaluation Agent 的 event-timeline 输入。
7. guidance-generation LLM prompt 明确要求：只使用 selected move descriptions 与 `recentWritingContext` 来提炼简短 `Previous ideas` 关键词；禁止直接把原始写作片段或完整 move descriptions 放到输出中。

需要新增或调整的文件包括 `WritingSection.tsx`、`routes/writing.ts`、`services/manipulationPipeline.ts`、`agents/manipulationController.ts`、数据库初始化与 migration。practice 与正式页面都可按相同 3 秒规则保存 snapshot；只有有 manipulation state 的正式 treatment session 才会真正将这两条 snapshot 的比较结果用于 guidance。

### 3. 在后端预先生成并保存主模型 response

调整 `chat.ts` 的 `/stream` 和自动 `/analyze` 路径，使二者在 Controller 触发 guidance 后共用同一套 direct-guidance delivery helper：

1. Evaluation Agent 和 Controller 完成，得到 `StructuredGuidance`。
2. 以 `promptForResponse` 作为主模型此次需要执行的用户指令，并附加明确约束：`Keep the answers concise and coherent.`
3. 主模型在服务器端完成 response 收集，不提前将 token 流显示给参与者。
4. 服务端写入完整 guidance payload，再通过 SSE 或 `/analyze` JSON 返回 `notification + displayAt + payload`。
5. 将 Main Response Agent 的真实输入、输出、模型、耗时和失败信息按现有方式写入 `agent_execution_log`；AI Response move 的时间线语义保持一致。

为避免 response 过长，除了上述精确指令外，会把 direct-guidance main-response 调用使用独立、较低的 completion token 上限；具体上限会在实施前按当前模型的 hidden-reasoning token 行为选定并记录在代码注释中。

普通用户提问的现有流式回复不改变。只有 Controller 触发的 guidance 改为「先完整生成，再定时显示」。

### 4. 持久化与历史恢复

为使刷新后仍能完整还原绿色卡片，并让它在 chat history 中和 participant message、普通 assistant response 明确区分，扩展 `messages` 记录：

- 将 `messages.role` 从 `user | assistant` 扩展为 `user | assistant | ai_guidance`。每一张新的直接插入卡片都写为 `role = ai_guidance`，不再伪装成 assistant message。
- 最终 response 继续保存在既有 `content` 中；`guidance_direction`、`guidance_previous_ideas` 与 `guidance_display_at` 保存卡片的其余部分。
- `is_guidance` 仅保留为历史旧记录的兼容字段；新 direct guidance 以 `role = ai_guidance` 作为唯一的语义类型。
- 新增 nullable 字段保存 `guidance_direction`、`guidance_previous_ideas`（JSON）和 `guidance_display_at`。
- 通过 `backend/src/index.ts` 的 `ensureColumn()`、对应 SQL migration 和 history API 一起支持新字段；旧记录仍按现在的单段 guidance 样式兼容渲染。

history API、导出文件和前端 `Message` 类型都会原样返回 `ai_guidance` role，供研究分析清楚区分。构建下一轮 Main Response Agent 输入时，服务端会将 `ai_guidance` 记录转换为只含其 `content` response 的 assistant-context，或按该轮上下文需要排除 direction instruction；不会把 direction guidance 当作 participant 的新 user message。`guidance_display_at` 也让刷新发生在 5 秒通知期内时，页面能继续等待剩余时间而不是立即跳出卡片。

### 4A. 将 guidance 卡片作为独立记录类型，但在 event timeline 中视为 AI response

每张 guidance card 除了独立 chat-history role，也会有独立 interaction log 类型：

- 扩展前端 `EventType` 和数据库 `interaction_logs.event_type` enum，新增 `ai_guidance`。
- notification 显示、倒计时结束和卡片实际插入分别记录 `ai_guidance_notification_shown`、`ai_guidance_notification_completed`、`ai_guidance_displayed`。
- `ai_guidance_displayed` event 的 `text_content` / metadata 保存完整的 direction guidance、Previous ideas、AI response、message id、display delay、是否从 history 恢复和 payload 长度；它不再被记录为一般 `ui` interaction。
- event timeline 不新增 `ai_guidance` event type。`eventTimelineBuilder.ts` 会把 `role=ai_guidance` 的 message 正规化为既有的 `ai_response` event，时间排序、Evaluation Agent 输入和 move 分类都沿用普通 AI response 的处理方式。
- 写入该 `ai_response` event 的内容使用完整卡片文本（direction guidance、`Previous ideas`、AI response），使系统能够看到参与者实际收到的完整 AI 内容。
- 因此：**系统时间线语义为 `ai_guidance = ai_response`；研究数据层则通过 `messages.role=ai_guidance` 和 `interaction_logs.event_type=ai_guidance` 区分它。**不需要新增 `session_events` schema enum 或修改 Evaluation Agent 的 event-type contract。

### 5. 前端 notification 与直接插入

在 `ChatInterface.tsx` 中替换现有 `interventionPreview` / `guidanceExpanded` / `insertIntervention` / `ignoreIntervention` UI：

1. 收到准备完成的 direct-guidance payload 后，保留当前绿色长 notification 的视觉语言，但文本改为：`AI guidance will appear in 5s`，并显示 5 到 1 的实时倒计时。
2. 倒计时结束时，notification 消失；在 LLM chat 左侧、与普通 assistant response 相同的起始位置插入一张浅绿色卡片。
3. 卡片按固定三区布局渲染：先显示 direction guidance（无标题）；空行后以弱化的方括号提示显示 `[Previous ideas: …]`；再空行后显示完整 AI response（无标题）。Previous ideas 使用较小、较浅的辅助文字，AI response 使用卡片的主要阅读层级和 Markdown 处理（列表、粗体等），让 response 成为视觉重点。
4. 不渲染 View、Hide、Insert 或 Ignore，也不发出这些旧 UI interaction events。
5. 将新事件记录为独立事件，例如 `ai_guidance_notification_shown`、`ai_guidance_notification_completed`、`ai_guidance_displayed`，并记录 message id、display delay、payload 长度与是否从 history 恢复。
6. 清理所有旧的「Insert 后重置 streak / 抑制两次 content move」逻辑；新 guidance 由系统自动生成和展示，不应再依赖 participant acceptance。Controller 在触发 guidance 后原有的 streak reset 仍保留。

### 6. 自动分析与并发处理

当前 `/analyze`（语音触发）和 `/stream`（聊天发送）都可以产生 guidance。实施时会为每个 session 复用现有 `activePipelines` 串行化机制，并增加一项 delivery guard，确保同一 intervention 只会：

- 生成一次主模型 response；
- 写入一条直接插入的 guidance message；
- 发出一套 notification/display 事件。

若主模型调用失败，系统不会展示只有 direction 没有 response 的半成品卡片；会记录失败并走明确的受控 fallback response 或保持本轮正常聊天回复，具体失败路径将在实现中写入 audit log 并测试。

### 6A. 调整 Evaluation Agent 的触发时机，不阻塞正常聊天回复

当前实现实际有四个触发入口：

1. participant 每次发送 chat prompt 时，在 `/stream` 内同步运行一次 pipeline；
2. 新语音后静默 2 秒；
3. 自上次分析后累计 60 个新的转录词；
4. 连续语音达到 45 秒。

按本次要求，实施后删除每次 chat send 的 pipeline 调用，保留**三个**自动判断时机：静默 2 秒、累计 60 个新的转录词，以及连续语音达到 45 秒。

具体改动：

- `/stream` 和 `/send` 不再调用 `runTurnPipeline`，也不再因为 guidance 判定而提前结束或延迟本次普通 Main Response Agent 的流式回复。
- 移除当前「Controller 命中 guidance 时立刻返回 intervention，等待 participant Insert」的分支。
- `/analyze` 保留为仅有的 evaluation/guidance 入口；它由静默、60-word 与连续语音三个自动条件调用，在独立请求中完成 timeline evaluation、context gathering、guidance generation 与 direct-guidance response generation，随后返回 notification payload。
- 普通聊天请求照常立即开始 main AI response；automatic analysis 即使仍在运行，也不会令 participant 等待 guidance 判定。
- 保留每个 session 的 pipeline 串行化，避免静默和 60-word 触发同时创建重复 guidance。

### 7. 新 chatbot 内容的定位滚动

目前 `ChatInterface` 的 `autoScrollToBottom()` 被刻意完全禁用，因此新 assistant 内容和新 guidance 都要求用户自行滚动。实施时改为以**最新 block/card 的顶部**为目标，而不是滚到整个 message container 的 `scrollHeight`。

- 给每一条 assistant response 与 direct-guidance card 保留稳定 DOM anchor/ref。
- 当新 assistant loading block 首次加入、或 5 秒倒计时结束且 direct-guidance card 插入时，在布局完成后的 `requestAnimationFrame` 中执行容器内滚动。
- 目标位置为最新 block/card 的起始 `offsetTop`（保留少量顶部间距），使用户首先看到这条新内容的开头，而不是长回答或长绿色卡片的尾部。
- 流式 response 的后续 token 不重复强制滚动，避免持续抢夺用户滚动位置或影响文本选择；只在该 response block 初次出现时定位一次。

### 7A. 可拉伸的 chat prompt box

Chat composer 的 textarea 保留原生上下拉伸，方便参与者输入或检查较长 prompt；但现有可用高度可能太窄或与页面高度脱节。实施时会：

- 保持垂直 resize handle，不启用横向拉伸。
- 以左侧 chatbot 的实际可用高度为基准，将 textarea/composer 的最大展开高度限制在约三分之一，而不是固定 `40vh`。
- 达到最大高度后在 textarea 内部滚动，避免把 message area 挤到不可读或把 Send 按钮推出视区。
- 在窄屏尺寸下使用同一比例限制，并确保 guidance notification 与 composer 不互相遮挡。

### 8. 正式任务改为 Career Development

将正式任务统一明确为 career development，并强调方案应当有帮助且有创意：

- `WelcomeActual.tsx` 标题改为 `Your Task: Design a Platform for Adults to Learn Career Development`。
- 改写 welcome task description，要求参与者设计一个能有效帮助成年人学习 career development、同时体现原创和有创意设计思考的平台，并在右侧写下产品设计方案。
- 更新正式任务页面的 Writing Section 辅助文案，使它引用同一任务名称。
- 更新 Main Response Agent system prompt、前后端 transcription prompt 的任务背景为 career-development learning platform，避免模型、转录与参与者看到的任务目标不一致。

Practice task `Design a Toy` 保持不变。

### 9. 修复 Main AI response 的 Markdown table 显示

当前 response 使用 `react-markdown`，但没有启用 GitHub-Flavored Markdown table parsing，也没有 scoped table layout 样式，因此模型输出表格时会显示为杂乱的管道文本或挤压的布局。

- 增加 `remark-gfm`，并在 Main AI response 与 guidance card 内的 Markdown renderer 启用它。
- 为 `.markdown.prose table`、`th`、`td` 添加边框、padding、表头背景、换行规则和横向溢出容器；窄屏时可横向滚动，不破坏聊天区宽度。
- 不改变普通段落、列表、粗体或卡片的既有 Markdown 渲染。

### 10. 隐藏可恢复的音频 buffer 错误，同时保留诊断

`Error committing input audio buffer: buffer too small. Expected at least 100ms ...` 来自 OpenAI Realtime transcription：浏览器本地 VAD 在静默时手动 commit audio buffer，但偶尔会遇到 VAD/commit 时序竞争，实际 buffer 已空或不足 100ms。连接通常仍然有效，所以后续转录可继续进行。

- 在 `WebRTCTranscript.tsx` 对这条特定的、可恢复的 input-audio-buffer-too-small 错误分类为 non-fatal：保留 `console.warn` 和必要的研究调试记录，但不调用会显示给参与者的 `setError()`。
- 同时加强 manual commit guard：仅在追踪到有未提交语音且其估算持续时间至少 100ms 时才发送 commit；收到该可恢复错误时清理对应的 pending commit bookkeeping，避免重复提交空 buffer。
- 其他 OpenAI error、连接错误、麦克风权限错误和真实转录失败仍维持现有用户可见错误提示。

## 数据与研究记录变化

- `evaluation_agent_audit.aiGuidance` 将记录结构化 direction、previous-ideas 关键词、最终 prompt、main response、display time、chat-history role=`ai_guidance` 和 fallback 状态。
- `evaluation_agent_audit.aiGuidance` 也会记录选中的跨方向 content moves、30 秒 writing baseline 的时间点、current snapshot 时间点和计算出的 writing delta，便于之后审计关键词来源。
- `agent_execution_log` 保留 guidance-generation LLM 与 Main Response Agent 的输入输出，便于检查「关键词是否来自正确的 move context」和「主回答是否遵守 concise/coherent 指令」。
- `messages` history 以一条 `role=ai_guidance` message 表达完整卡片，避免旧的 guidance-user-message + assistant-message 双记录让导出和后续 history 难以解释。
- interaction logs 不再包含 participant 的 Insert/Ignore 行为，改为 `event_type=ai_guidance` 的系统 notification 与卡片呈现事件，并保留完整 guidance payload。

## 验证计划

1. **结构化 guidance 单元测试**：四种 D/C × TM 条件分别检查 JSON parse、关键词不复述原始 move description、数量/范围规则和 fallback；验证 context 会选取不同 orientation 的最近 content moves。
2. **Writing delta 测试**：覆盖 `A → A+B`、无变化、纯删除、替换、无 30 秒 baseline、3 秒 snapshot 采样和 60 秒历史清理的情况，确认只把正确的新增/替换内容交给 guidance-generation LLM。
3. **后端流程测试**：模拟 guidance 触发，确认主模型被调用一次且输入含 `Keep the answers concise and coherent.`；确认完整 payload 先持久化，再交给前端。
4. **触发与并发测试**：验证 chat send 不再启动 evaluator；静默、60-word 与连续语音 45 秒三个自动触发器都可正确启动分析；正常流式回复不会等待 guidance 判定；多个自动触发器并发时不重复发 guidance。
5. **前端交互与数据类型测试**：notification 从 5 倒计时至 1；到期后消失；浅绿色卡片靠左出现；三区内容、Markdown response、history reload 均正确；chat history 将卡片返回为 `role=ai_guidance`，interaction log 将其记录为 `event_type=ai_guidance`，event timeline 将同一张卡片记录为既有 `ai_response`；新 assistant block 和 guidance card 都滚动到自身开头；页面中没有 View/Insert/Ignore。
6. **Composer 尺寸测试**：prompt box 可上下拉伸，最大高度约为左侧 chatbot 可用高度三分之一；达到上限后内容在输入框内滚动，message area 和 Send 按钮仍可用。
7. **Markdown 与音频回归**：表格可读且窄屏可横向滚动；buffer-too-small error 不显示给参与者；其他转录和连接错误仍可见。
8. **任务文案检查**：welcome、Writing Section、Main Response Agent 和 transcription prompt 都使用 career development 任务表述，practice task 不变。
9. **构建与类型检查**：执行 backend TypeScript 检查、frontend TypeScript 检查和 frontend production build。

## 实施后文件范围

- `frontend/src/App.tsx`
- `frontend/src/pages/AiGuidanceDemoPage.tsx`（删除）
- `frontend/src/components/ChatInterface.tsx`
- `frontend/src/components/WebRTCTranscript.tsx`
- `frontend/src/components/WelcomeActual.tsx`
- `frontend/src/hooks/useInteractionLogger.ts`
- `frontend/src/pages/ResearchPagePractice.tsx`
- `frontend/src/pages/ResearchPageActual.tsx`
- `backend/src/agents/manipulationController.ts`
- `backend/src/services/manipulationPipeline.ts`
- `backend/src/services/eventTimelineBuilder.ts`
- `backend/src/routes/chat.ts`
- `backend/src/routes/writing.ts`
- `backend/src/index.ts`
- `backend/database/migrate_add_paper2_manipulation_system.sql` 或新增等价 migration
- `AI_GUIDANCE_POLICY_PROMPTS.md`
- `frontend/src/index.css`
- `frontend/package.json` / lockfile（加入 `remark-gfm`）
- 与现有测试结构相符的相关测试文件
