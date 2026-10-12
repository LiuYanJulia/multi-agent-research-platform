# Paper 2 实验平台改造计划：Multi-Agent Manipulation System

状态：**v22 —— Phase 0 + Phase 1 已实施完成并通过编译验证；测试模式调试面板（第 11 节）已实施完成并按分段方式展示转录；刷新页面清空状态的平台级 bug、数据库列名 bug、OpenAI API key 均已修复/更新；语音转录模型已改回 `gpt-4o-transcribe`——`gpt-live-transcribe` 这次实测确认依然会对 turn_detection 报 400，v18 的切换已回退，详见第 0 节 v19；`delay: 'low'`（v20）这次实测确认 `gpt-4o-transcribe` 不支持，已移除（v22）；`transcription.prompt` 场景上下文提示（v21）保留，尚未单独验证效果；确定了 Decision Agent（D/C 判断）架构设计，Phase 4/5 时落地；Phase 2（语音转录实时上传 `speech_segments`）已实施完成；Phase 3/4/5/6 仍未开始，是接下来的主线工作**
对应文档：`Project 2 - V2.pptx`（Slide 17–22）+ `/Users/yanliu/Projects/Pipeline Code`（离线 event timeline / move segmentation / link construction pipeline）+ 你上传的 `move_segmentation_multi_agent.ipynb`
目标代码库：`/Users/yanliu/Projects/Manipulation research-platform`

---

## 0. 更新日志

- v1：读完 pptx + 平台代码后的初版架构 + 8 个待确认问题。
- v2：问题 1–4 回复后更新了 group id 输入、eval agent 调用方式、Low-TF 两阶段结构、guidance 可见性。
- v3：读完 `Pipeline Code` 仓库 + multi-agent notebook，确定了 evaluation agent 的具体调用方式、real-time event timeline 的设计、agent 执行记录表，回复了问题 5/6/7/8。
- v4：根据 cooldown 澄清，重新设计 Controller 触发机制——去掉 light nudge，改成"强干预或静默"，cooldown = 干预后把连续计数器清零。
- v5：确认 streak 计数**排除 Ask/AI Response**，只统计 Generate/Evaluate/Adopt/Reject 四类内容型 move。所有问题已确认完毕，进入等待开始实施状态。
- v6：Phase 0（数据库）+ Phase 1（前端可见部分 + STUB evaluator 打通端到端）已全部实施完成，详见第 9 节的完成状态标注。backend `tsc --noEmit` / `npm run build` 与 frontend `tsc --noEmit` / `npm run build` 均通过（frontend 仅有与本次改动无关的既有 `useInteractionLogger.ts` lint 警告）。
- v7：收到最终 `EVAL_MODEL_ID`：`ft:gpt-4o-mini-2024-07-18:personal:design-moves-tvt:Dj0Wo9or`。已存入 `backend/.env`（`.env.example` 同步加了占位说明），但**尚未接入任何代码逻辑**——`moveTypeEvaluator.ts` 仍是 Phase 1 的 gpt-4o-mini 粗分类 stub，真正读取并调用这个 finetuned 模型是 Phase 4 的工作。Julia 先在真实平台上实测 Phase 1 的交互体验，Phase 4 等她确认后再开始。
- v8：Phase 1 实测反馈——入口页 Group ID 字段之前显示了"As provided by the researcher: HighTF_HighTM / HighTF_LowTM / ..."这种提示文字，暴露了条件名称和映射关系给参与者，不符合双盲要求。已改为：入口页不再显示任何提示或示例，参与者只需要输入一个数字 1-5；后端 `parseGroupId` 新增数字映射（1=control，2=HighTF_HighTM，3=HighTF_LowTM，4=LowTF_HighTM，5=LowTF_LowTM），同时保留原来的条件名称字符串输入方式（内部/手动测试用，不影响参与者流程）。
- **v9（本版）**：
  1. **修复了一个和本次改动无关的既有 bug**：`sessions` 表 schema 定义用的是 `participant_id`，但 `chat.ts`（×4）、`session.ts`（×1）、`submission.ts`（×1）、`logging.ts`（×2）里所有的 `INSERT INTO sessions` 语句写的却是不存在的 `user_id` 列，共 8 处。这是 Julia 实测时遇到的 "Failed to create session: 500"（在 `/api/session/create` 这条路径下）的真正原因之一——推测是因为她测试用的是全新数据库，`CREATE TABLE IF NOT EXISTS` 按 `index.ts` 里的定义新建了 `participant_id` 列，旧库里可能历史上就是 `user_id`，所以这个 bug 之前没暴露。已统一改成 `participant_id`，`tsc --noEmit` 验证通过。
  2. **另一个"Failed to create session: 500"是同名但完全不同的 bug**：这条其实来自 `WebRTCTranscript.tsx`（语音转录组件）里硬编码的错误提示文案，和 session 创建无关，根因是 `backend/src/routes/transcript.ts` 调的 OpenAI Realtime API 已经过期（`OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview-2024-10-01` + 旧版 `/v1/realtime/sessions` 端点）。Julia 确认新模型是 `gpt-live-transcribe`。
  3. **v10 补充：语音转录 API 迁移已完成实施**。改动点：
     - `backend/.env` / `.env.example`：`OPENAI_REALTIME_MODEL` 改成 `gpt-live-transcribe`。
     - `backend/src/routes/transcript.ts` `/session`：改调 `POST https://api.openai.com/v1/realtime/client_secrets`（原来是已废弃的 `/v1/realtime/sessions`），请求体改成 `{ session: { type: "transcription", audio: { input: { format, transcription: { model: "gpt-live-transcribe" }, turn_detection: {server_vad...} } } } }`；响应里 ephemeral client secret 的字段名 OpenAI 官方文档没有给出完全确定的渲染结果，代码做了防御性解析（同时兼容顶层 `value`/`expires_at` 和嵌套 `client_secret.value`），已用 `tsc --noEmit` 验证类型正确，但**实际响应字段名还没有用真实 API key 跑过一次来确认**，第一次测试如果还报错，最可能的点就是这里。
     - `backend/src/routes/transcript.ts` `/realtime-connect`：改调 `POST https://api.openai.com/v1/realtime/calls`（原来是 `/v1/realtime?model=...`），不再需要 `model` 查询参数（model 已经在 client_secrets 那一步固化进 ephemeral token 里了）。
     - 前端 `WebRTCTranscript.tsx`：连接后发的 `session.update` 消息改成新的嵌套 schema（`session.type: "transcription"` + `session.audio.input.transcription.model` + `session.audio.input.turn_detection`），不再用旧的顶层 `input_audio_transcription`/`turn_detection`/`modalities` 字段。
     - backend `tsc --noEmit`、frontend `tsc --noEmit` 均验证通过。**还没有用真实 OpenAI API key 实际跑通一次录音+转录**，需要 Julia 重启后端（`.env` 改了环境变量，必须重启才生效）之后实测确认。如果 `/session` 那步还报错，请把浏览器 Network 面板里 `/api/transcript/session` 请求返回的 body 贴给我，里面会有 OpenAI 原始的错误信息。
  4. **确定了 Decision Agent（D/C 判断）的架构设计**，见新增第 10 节，落地时机定为 Phase 4/5（现在只是把设计记录下来，不实施）。
  5. **记录了"测试模式"调试面板的设计构想**，见新增第 11 节，暂未开始实施。
- **v11（本版）**：Julia 重启后端后反馈了两条新的报错日志，澄清/修复如下：
  1. **v9 的猜测方向猜反了**：真实报错是 `ER_BAD_FIELD_ERROR: Unknown column 'participant_id' in 'field list'`——说明 Julia 实际在用的那个 MySQL 数据库，`sessions` 表里历史上就是 `user_id` 列，而不是 v9 猜测的"新库会是 participant_id、旧库才是 user_id"。原因是 `CREATE TABLE IF NOT EXISTS` 对已存在的表完全不生效，所以不管 `index.ts` 里怎么定义，只要表已经建好过，物理列名就不会自动变。v9 把 8 处 `INSERT` 语句从 `user_id` 统一改成了 `participant_id`，这对全新数据库是对的，但对 Julia 这个已经存在的旧库反而变成了新 bug。
  2. **修复方式：让后端启动时自动改列名，而不是去猜数据库状态**。`backend/src/index.ts` 新增 `renameColumnIfNeeded(table, oldColumn, newColumn, definition)`：每次后端启动、`createTables()` 跑到 `sessions` 表时，检查如果存在 `user_id` 列且不存在 `participant_id` 列，就自动执行 `ALTER TABLE sessions CHANGE COLUMN user_id participant_id VARCHAR(255) NOT NULL`，把列改名过去。这样不管数据库处于哪种历史状态（原生 user_id / 已经是 participant_id / 全新建表），重启一次后端就能自动收敛到统一的 `participant_id`，之后 8 处 INSERT 语句用 `participant_id` 就都是对的了。`tsc --noEmit` 已验证通过。**需要 Julia 再重启一次后端，触发这次迁移。**
  3. **另一条日志是完全独立、和数据库无关的问题**：`OpenAI API error: 401 Incorrect API key provided: sk-proj-...MZUA`。这是 `backend/.env` 里配置的 `OPENAI_API_KEY` 本身不是一个有效的 key（可能过期/被撤销/输入错误），和这次任何代码改动都无关。语音转录报错卡住、界面一直显示 Disconnected，很大一部分原因就是这个——`/api/transcript/session` 直接在调用 OpenAI 那一步就被拒绝了。**需要 Julia 去 https://platform.openai.com/account/api-keys 确认这个 key 还有效，或者换一个新的有效 key 填进 `backend/.env` 的 `OPENAI_API_KEY`。**
- **v12（本版）**：
  1. **OpenAI API key 已更新**：Julia 提供了新 key，已直接写入 `backend/.env` 的 `OPENAI_API_KEY`（重启后端后生效）。401 报错解决。
  2. **新报错**：换了 key 之后，`/session` 报 `400 Turn detection is not supported for this transcription model`，指向 `session.audio.input.turn_detection` 这个字段——说明 v10 里给它配了一个 `server_vad` 对象（后来在修另一个问题时又直接删掉了这个字段）都是错的。
  3. **Julia 提供了 OpenAI 官方的 gpt-live-transcribe 使用指南原文**，关键信息澄清了这个模型的真实行为，和 v10 的假设不一样：
     - `turn_detection` 对 `gpt-live-transcribe` 必须**显式传 `null`**（不是不传、也不是配置 VAD 参数）——这个模型根本不支持自动语音活动检测/自动断句。
     - 既然没有自动断句，**客户端必须自己在合适的时机发送 `input_audio_buffer.commit`** 来手动结束一个"回合"，服务端才会针对这一段已提交的音频返回 `conversation.item.input_audio_transcription.delta`（流式片段）和 `.completed`（最终结果）事件。不 commit 就永远不会有 `.completed` 事件。
  4. **对应代码改动**：
     - `backend/src/routes/transcript.ts` `/session`（`client_secrets` 创建请求）：`turn_detection` 显式设为 `null`。
     - 前端 `WebRTCTranscript.tsx` 连接后发的 `session.update`：同样把 `turn_detection` 显式设为 `null`。
     - 前端新增**定时手动 commit** 机制：新增常量 `COMMIT_INTERVAL_MS = 4000`（4 秒），数据通道打开后启动一个 `setInterval`，每 4 秒往数据通道发一次 `{type: 'input_audio_buffer.commit'}`，这样长时间的 think-aloud 录音也能持续产出转录片段；`cleanup()` 里对应清掉这个 interval。
     - **已知的简化/权衡**：4 秒定时 commit 是按固定时间切分，不一定切在自然的说话停顿处，可能会把一句话从中间切断成两段转录文本（各自完整可读，只是分段点不完美）。这比之前假设的"服务端自动检测语音起止"要糙一些，但保证转录功能稳定可用。如果后续 Julia 觉得转录片段切得太生硬，可以考虑用浏览器端 Web Audio API 自己做静音检测（AnalyserNode 监测音量），在检测到停顿时才触发 commit，取代现在的定长定时器——这个属于锦上添花的优化，先记在这里，不是现在的阻塞项。
     - backend `tsc --noEmit`、frontend `tsc --noEmit` 均验证通过。**还没有用真实录音实际验证过转录效果**，需要 Julia 重启后端后实测。
- **v13（本版）**：Julia 提出两个方向的思考，促成了这次改动——
  1. **Julia 的方案 1（把"转录怎么切段"和"怎么分析"解耦）**：把当前 API 的原始转录当成一份持续输出的流水账来维护，真正的"这段转录属于哪个分析节点"由分析层自己判断——即在每次触发 move 分析的时候，取"上一个分析节点到现在为止累积的转录内容"作为这次分析的输入，和离线 pipeline 里 `design_move_separation.py` 按时间戳 smart-merge behavior/chat/speech 的逻辑是一回事。**这个理解是对的，而且这本来就是第 6 节里 Phase 3 `eventTimelineBuilder.ts` 要做的事**——不管底层转录 API 是按什么颗粒度切片（自然停顿、还是我们自己定时硬切），最终都要靠时间戳重新和 behavior/chat 事件对齐、合并成 event timeline，所以"转录 API 自己切得好不好看"，理论上不影响最终 move 分析的正确性，只影响原始转录文本本身好不好读。也就是说，方案 1 描述的"更复杂"那部分，其实是无论选哪个模型都逃不掉的、本来就规划要做的 Phase 3 工作，不是方案 1 独有的额外成本。
  2. **Julia 的方案 2（换成能自动断句的模型）**：她提到的 `gpt-realtime-whisper` 确实是一个真实存在的模型（不是记错名字），但研究确认它和 `gpt-live-transcribe`行为一样——**同样不支持 `turn_detection`，同样需要手动 commit**。真正支持服务端自动 VAD 断句（`turn_detection: {type:"server_vad",...}`）的是 `gpt-4o-transcribe`——这是上一代的转录模型，OpenAI 现在把 `gpt-live-transcribe` 作为首选推荐（大概率是低延迟场景优化过），但 `gpt-4o-transcribe` 仍然可用，且专门支持自动断句这个特性。
  3. **采纳方案 2，替换模型**：`OPENAI_REALTIME_MODEL` 改成 `gpt-4o-transcribe`，`turn_detection` 恢复成 `server_vad` 配置（threshold 0.5, prefix_padding_ms 300, silence_duration_ms 500），去掉了 v12 里那个"每 4 秒定时手动 commit"的临时方案（相关代码已删除：`COMMIT_INTERVAL_MS` 常量、`commitIntervalRef`、interval 启动/清理逻辑）。选这个方向的原因：（a）比方案 1 简单，不需要额外维护"累积转录+分析节点对齐"这层新逻辑（这层逻辑本来就该在 Phase 3 做，和转录模型选择无关，方案 2 不会跟它冲突或重复）；（b）自动 VAD 断句产出的原始转录片段边界更自然，不会被我们自己拍的定长定时器硬切在句子中间，这对着重语音内容质量的 think-aloud 研究场景更合适。
  4. **需要说明的验证缺口**：`gpt-4o-transcribe` 支持 `turn_detection` 这一点，是从一个已废弃端点的示例 + 一个社区报告交叉验证出来的，不是从当前 GA `client_secrets` 文档页面直接、逐字确认的，所以**存在小概率这次换模型后 GA 接口仍然拒绝 `turn_detection` 参数**。如果重启测试后又报类似 "Turn detection is not supported" 的 400 错误，说明 `gpt-4o-transcribe` 在新版 GA 接口下也不支持，那就要退回 v12 那个"手动定时 commit"的方案（代码逻辑不复杂，需要的话可以很快加回来）。
  5. backend `tsc --noEmit`、frontend `tsc --noEmit` 均验证通过。**还没有用真实录音实际验证过 `gpt-4o-transcribe` + server_vad 是否真的能跑通**，需要 Julia 重启后端后实测。
- **v14（本版）**：Julia 反馈"在 practice test 页面直接刷新，看不到测试模式调试按钮"，排查后发现一个比调试按钮本身严重得多的平台级 bug：
  1. **根因**：`userId`、`groupId`、`sessionId`、`sessionStartTime` 这些字段全部只存在 `frontend/src/App.tsx` 的 React state 里，从来没有持久化过。只要参与者在 `/practice` 或 `/research` 页面刷新一次（不管是手动刷新、网络抖动导致的重连、还是浏览器意外重载），React state 全部清空回初始值：`userId`/`groupId`/`sessionId` 变回空字符串，`sessionStartTime` 变回 0。这不只是"调试按钮消失"这么简单——`sessionId` 变空之后，`useInteractionLogger` 还在继续往 `/api/logging/batch` 发请求，但 `sessionId` 是空字符串，后端 `logging.ts` 校验 `if (!sessionId ...)` 直接拒绝，前端控制台会看到持续的 `400 Bad Request`（这正是 Julia 这次贴的报错）；同时 `sessionStartTime` 变 0 之后，`ResearchPageActual.tsx` 里 20 分钟提醒/25 分钟强制提交的计时器、Low-TF 的 5/15 分钟阶段计时器，全部会算出一个从 1970 年到现在的荒谬"已用时长"，逻辑会整个错乱——这是一个会影响正式实验数据质量的问题，不只是调试功能用不了。
  2. **修复：加了一层 localStorage 续存机制**（`frontend/src/App.tsx`）：`userId`/`groupId`/`practiceSessionId`/`practiceSessionStartTime`/`actualSessionId`/`actualSessionStartTime` 这几项，每次关键节点变化时（填完入口页、进入正式任务）都会存一份到 `localStorage`（12 小时过期，避免几天前的旧会话被误续上）。App 挂载时，如果当前 URL 已经不在入口页（`/`）——说明这是一次刷新，不是全新访问——就从 localStorage 里把这些字段恢复回来；如果 URL 停在 `/` 就完全不做恢复，保证换一个新参与者用同一台电脑访问入口页时，不会不小心接到上一个参与者的会话里。如果 localStorage 里什么都没有（比如清过缓存、换了浏览器），会自动跳回入口页，而不是用一堆空值渲染一个坏掉的页面。
  3. **顺带修了计时器本身的一个关联 bug**：`ResearchPagePractice.tsx` 的倒计时（2 分钟）、`ResearchPageActual.tsx` 的正计时（20/25 分钟）之前都是"组件一挂载就从头开始数"，即使 `sessionStartTime` 现在能正确恢复了，计时器本身也不会知道"其实已经过去了多久"。改成挂载时先算 `Math.floor((Date.now() - sessionStartTime) / 1000)` 得到真实已过去的秒数，倒计时场景传入"剩余秒数"，正计时场景直接把这个已过去的秒数作为计时起点（`Timer.tsx` 也相应改成两种模式都认 `initialSeconds` 这个初始值，而不是只有倒计时模式才认）。practice 页面还加了一个"如果刷新的时候剩余时间已经是 0 了，直接弹出完成弹窗"的兜底，不会出现"倒计时永远到不了 0"的情况。
  4. **已知的剩余限制（诚实说明，不是这次修复范围）**：刷新仍然会丢失两类东西——（a）刷新那一刻还没提交的录音/转录内容，因为浏览器的 `MediaRecorder`/WebRTC 连接状态本来就只存在于内存里，刷新等于重新连接，这部分数据本身没法跨刷新保留；（b）`WritingSection` 里还没提交的草稿文字，目前也只在 React state 里，刷新会丢。这两点如果之后觉得需要处理，可以再单独讨论（比如草稿文字可以顺手也存进 localStorage，做法和这次是一样的），但这次先解决"整个会话状态被清空、参与者被迫从头再来"这个更严重的问题。
  5. `frontend` 的 `tsc --noEmit` 已验证通过。**测试模式调试面板（第 11 节）本身依然还没有实施**——之前 Julia 看不到按钮，一部分原因也是因为这个 bug（`userId` 刷新后变空字符串，即使按钮逻辑写好了也不会显示），但更根本的原因是这个功能这次修复之前根本还没写代码，是下一步要做的事。
- **v15（本版）**：实施了第 11 节的测试模式调试面板，代码改动如下：
  1. **触发条件**：新增 `backend/src/utils/sessionUtils.ts` 的 `isTestSession(sessionId)` 和前端各页面里的 `userId.toLowerCase().startsWith('test')`——两边各自判断一次、逻辑保持一致，服务端这次判断是为了确保只有测试会话才会多付出那些额外的 SSE 事件写入成本，不影响真实参与者的会话。
  2. **Agent 执行时间线（后端）**：`manipulationPipeline.ts` 新增 `AgentStageEvent` 类型和 `onStage` 可选回调参数，`runTurnPipeline` 在 Evaluation Agent、Manipulation Controller 各自开始/结束时都会调用它（比如结束时会带上 `"'Generate' (D), 'Ask' (D)"` 这种可读描述）；`chat.ts` 的 `/stream` 路由把 SSE 响应头的设置时机提前到了 pipeline 调用之前（这样 pipeline 跑的过程中就能实时往前端推事件，而不是等它跑完），只有 `isTestSession` 为真时才会构造这个 `onStage` 回调（并往里传），并在调用 Main Response Agent（真正的 OpenAI 流式请求）前后也各推了一条 started/completed 事件；新事件通过既有 SSE 通道以 `data: {agentStage: {...}}` 的形式发送，和已有的 `data.guidance` 事件走同一条通道。
  3. **实时转录（前端）**：`WebRTCTranscript.tsx` 新增 `onTranscriptUpdate` 回调 prop，每次转录片段完成时都会把累计的完整转录文本回调给父组件。
  4. **调试面板 UI**：新增 `frontend/src/components/DebugPanel.tsx`——右上角一个小的"🐛 Debug"按钮（`isTestUser` 为 false 时整个组件不渲染任何东西），点击后从右侧滑出一个深色面板，上半部分展示实时转录文本，下半部分展示 agent 执行时间线（每条带 agent 名字、状态、可读描述、时间戳，按状态用颜色区分 started/completed/error）。
  5. **接入两个页面**：`ResearchPagePractice.tsx` 和 `ResearchPageActual.tsx` 都加了 `debugTranscript`/`debugStages` 两个 state，分别通过 `onTranscriptUpdate`/`onAgentStage` 从 `WebRTCTranscript`/`ChatInterface` 收集，渲染 `<DebugPanel isTestUser={...} transcript={...} stages={...} />`。**注意 practice 页面的调试面板不会显示 Evaluation Agent / Manipulation Controller 的事件**——因为 practice session 从来不会有 `manipulation_state` 行，`runTurnPipeline` 一开始就会直接返回 `{ran:false}`，这两个 agent 根本不会跑；只有 Main Response Agent（普通的 OpenAI 回复）的 started/completed 事件会出现，这是符合实际情况的正确行为，不是 bug。
  6. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 用 `CI=true npm run build` 额外跑了一次完整构建，唯一报错的警告都在 `useInteractionLogger.ts`（和这次改动无关的既有警告，之前的版本就有记录）,这次新增/改动的文件都没有报错。**还没有用真实的 test 前缀 userId 实际点开面板验证过效果**，需要 Julia 实测确认。
- **v16（本版）**：实施了第 9 节 Phase 2（语音转录实时上传到 `speech_segments`），代码改动如下：
  1. **新增后端路由** `backend/src/routes/transcript.ts` 的 `POST /segments/batch`：接收 `{ sessionId, segments: [{timestampStart, timestampEnd, transcription}, ...] }`，校验参数后批量 `INSERT INTO speech_segments (session_id, timestamp_start, timestamp_end, transcription) VALUES ...`；如果 `sessions` 表里还没有这个 `sessionId`（理论上不该发生，但为了稳健性）会像 `logging.ts` 现有的做法一样自动补一行，避免外键约束报错。
  2. **前端批量上报机制**（`WebRTCTranscript.tsx`），完全照搬 `useInteractionLogger.ts` 已有的"内存队列 + 定时 flush + 卸载时 flush"模式：新增 `sessionId`（必填 prop）、`pendingSegmentsRef`（内存队列）、`SEGMENT_FLUSH_INTERVAL_MS = 5000`（5 秒定时器，数据通道打开时启动）、`flushPendingSegments`（`POST /api/transcript/segments/batch`，失败只打印 console.error，不阻塞录音流程）；每次转录片段 `.completed` 时把 `{timestampStart, timestampEnd, transcription}` 推进队列；`cleanup()` 里在清理 WebRTC 连接之前先清掉定时器并做最后一次 flush，尽量不丢最后几句还没来得及定时上报的转录。
  3. **一个需要记住的设计决定（时间戳约定不一致）**：`speech_segments.timestamp_start`/`timestamp_end` 这次存的是**绝对 epoch 毫秒**（`recordingStartTimeRef.current + 相对偏移`），而 `interaction_logs.timestamp`（行为日志）用的是**相对会话开始的毫秒数**——两边约定不一样。这是有意为之（转录片段的时间戳本来就是相对录音开始计算的，转成绝对时间戳更省事、也更不容易算错），但明确记录在这里：**Phase 3 的 `eventTimelineBuilder.ts` 在合并 behavior/chat/speech 三类事件时，必须先把这两种时间戳约定对齐（比如都转成绝对时间戳，或都转成相对会话开始的毫秒），否则合并出来的 event timeline 顺序会错乱**。
  4. **接入两个页面**：`ResearchPagePractice.tsx`、`ResearchPageActual.tsx` 的 `<WebRTCTranscript>` 都补上了 `sessionId={sessionId}`（组件早先只加了 prop 类型定义，这次才真正从父组件传进去）。
  5. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关，历次版本一致），这次新增/改动的文件（`transcript.ts`、`WebRTCTranscript.tsx`、两个 `ResearchPage*.tsx`）都没有报错。**还没有用真实录音实际验证过 `speech_segments` 表里落库的数据是否正确**，需要 Julia 实测确认（可以直接查一下数据库表，或者等 Phase 3 做 event timeline 的时候顺带验证）。
- **v17（本版）**：Julia 提了两个问题，促成了这次改动——
  1. **调试面板转录改成按分段展示**：之前 "Live Transcript" 区域是把所有转录片段拼成一整段文字（`prev + ' ' + transcriptText`），现在改成维护一个分段数组（`WebRTCTranscript.tsx` 的 `transcriptChunks: string[]`，替代原来的 `transcript: string`），`onTranscriptUpdate` 回调签名也相应从 `(fullText: string) => void` 改成 `(chunks: string[]) => void`。`DebugPanel.tsx` 改成把每个 chunk 渲染成单独一行（用细分隔线区分），标题旁边显示当前累计的 chunk 数量；面板本身的这块区域维持"标题固定不滚动、下面的转录列表内容超出高度就单独滚动"的布局（`maxHeight: 35%` + 内层 `overflowY: auto`，和之前一样，只是现在滚动的是分段列表而不是一整段文字）。两个页面（`ResearchPagePractice.tsx`/`ResearchPageActual.tsx`）的 `debugTranscript` state 类型同步从 `string` 改成 `string[]`。
  2. **Julia 的朋友用的是另外两个转录模型（`gpt-realtime-whisper`/`gpt-live-transcribe`），并且给了具体的停顿断点阈值**：公共对话转写（`gpt-realtime-whisper`）用 650ms 断点，L1/私下 delegation 转写（`gpt-live-transcribe`）用 350ms 断点——这意味着这两个模型在朋友的平台上是**能**配置 `turn_detection`（自动停顿断句）的，而不是像我们 v12/v13 遇到的那样只能手动 commit。这和我们代码里的注释（"这两个模型都拒绝 turn_detection"）直接矛盾，所以专门去查了 OpenAI 当前的官方 API 文档（transcription_sessions 的 create 接口）来核实：**文档原文是"Only `server_vad` is currently supported for transcription sessions"，没有按模型单独列出限制**（唯一提到的模型专属限制是 `gpt-realtime-whisper` 在 GA Realtime session 里不支持 `prompt` 参数，跟 `turn_detection` 无关）。也就是说，我们之前那次 400 报错（"Turn detection is not supported for this transcription model"）大概率是当时那个 API 版本/那次请求本身的问题，不是这两个模型的永久限制——`transcript.ts` 里的过时注释已经改正，明确记录了这次修正的依据，但**没有改动实际使用的模型**（仍然是 `gpt-4o-transcribe`，理由见下面的评估）。
  3. **评估：Julia 现在的方法 vs 朋友的方法，哪个更合适**——结论是两者在"能不能自动断句"这一点上其实是等价的（都基于 OpenAI 官方支持的 `server_vad`），真正的差异只有两点：(a) 具体用哪个转录模型，(b) `silence_duration_ms`（断点阈值）具体调成多少。这两点都是"哪个更适合特定的说话场景"的问题，不是"哪个技术上可行"的问题，所以不存在绝对意义上"更好"的答案，只有"更适合当前这个研究场景"的答案：
     - **朋友的两档阈值是按场景专门调过的**：650ms 用于"公共对话"（多人轮流说话，需要更长的停顿容忍度，否则容易在说话人还没说完时就被打断/切段）；350ms 用于"私下 delegation"（单人快速下指令，追求低延迟、能接受切得更碎）。这是有明确场景依据的调参，不是随便选的。
     - **Julia 平台现在的 500ms，是 OpenAI 官方文档里 `silence_duration_ms` 本身的默认值**（文档写明默认 500ms），并不是针对 think-aloud 场景专门调过的——这次查证顺带确认了这一点。
     - **Julia 的实际场景（参与者一边做设计任务一边对着系统说出想法）更接近"个人独白式思考"，既不是朋友说的"多人公共对话"，也不是"快速下指令式 delegation"**——think-aloud 场景的典型特征是说话中间会有明显的"边想边停"的停顿（组织语言、回忆、犹豫），如果阈值调得太短（比如 350ms），很可能把同一个完整想法从中间切断成好几段割裂的转录（对 Phase 3 之后要做的 move 判断不利，一句完整表达被切成两截，finetuned 模型看到的是残缺上下文）；但如果调得太长（比如 650ms），后面如果参与者停顿后紧接着换了个新话题，也可能被合并到同一段里，导致边界不够清晰。500ms 正好卡在朋友那两个阈值中间，从"不确定专门测过、只是恰好用了官方默认值"这个角度看，与其说是"经过验证的最优值"，不如说是"还没针对这个具体场景专门调过的默认值"。
     - **模型选择（`gpt-4o-transcribe` vs `gpt-live-transcribe`/`gpt-realtime-whisper`）在转录准确率上谁更好，尤其是中英文混说场景下的表现，目前没有找到任何权威资料能直接下结论**——这需要用参与者真实的中英混说录音分别跑一遍做对比测试才能知道，属于经验性问题而不是文档能回答的问题，所以这次没有给"哪个模型更准"下结论，如果 Julia 想知道，需要实际录几段有代表性的中英混说 think-aloud 语音，分别喂给两个模型比较转录结果。
     - **建议（不是马上要做的改动，供参考）**：`gpt-4o-transcribe` 目前已经在平台上跑通、验证过端到端可用，不建议现在无缘无故换模型；但 `silence_duration_ms` 这个参数值得针对 think-aloud 场景单独测几个值（比如 400/500/600ms），用真实参与者的说话节奏找一个真正适合这个研究场景的阈值，而不是继续沿用 API 默认值——这个是纯参数调整，改起来很快，但需要 Julia 拿真实录音试听/对比几个候选值的分段效果之后再定，不是我能单方面判断的。
  4. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关）。
- **v18（本版）**：Julia 决定采纳，正式把转录模型切换成 `gpt-live-transcribe`，`silence_duration_ms` 仍然保持 500ms 不变——改动如下：
  1. `backend/.env`、`backend/.env.example`：`OPENAI_REALTIME_MODEL` 从 `gpt-4o-transcribe` 改成 `gpt-live-transcribe`；`transcript.ts` 里的兜底默认值（`process.env.OPENAI_REALTIME_MODEL || '...'`）也同步改成 `gpt-live-transcribe`，避免环境变量万一读取失败时静默退回旧模型。
  2. **顺手修了一个之前埋的潜在 bug**：前端 `WebRTCTranscript.tsx` 在数据通道打开时会重新发一次 `session.update` 来"确认"转录模型和 VAD 配置，但这条消息里的模型名之前是**硬编码的字符串 `'gpt-4o-transcribe'`**，完全没有用它自己已经从后端 `/session` 接口拿到的那个 `model` 变量（`const { session, model } = await response.json()`）。也就是说，如果只改 `.env` 里的 `OPENAI_REALTIME_MODEL`，后端创建 ephemeral client secret 时用的是新模型，但前端这条"确认"消息会继续声称是旧模型——这次干脆让它统一读同一个 `model` 变量（`transcription: { model: model }`），不再硬编码，这样以后再想换模型，只需要改 `.env` 一处，不用同时记得改前端代码。
  3. **代码注释同步更新**：之前后端/前端各有一处注释断言"`gpt-live-transcribe`/`gpt-realtime-whisper` 会拒绝 `turn_detection`（报 400）"，这次都改成了准确描述：v12/v13 确实遇到过这个 400，但 v17 已经用 OpenAI 当前官方文档核实过，文档并未把 `turn_detection`（`server_vad`）按模型单独限制，所以这次切换回 `gpt-live-transcribe` 是基于"当时那次 400 大概率是那个 API 版本的问题，不是这个模型的永久限制"这个修正后的结论，而不是盲目重复以前踩过的坑。**同时明确记录了万一这次还是报同样的 400 该怎么办**：直接退回 `gpt-4o-transcribe`（已知可用），或者用回 v12 里那套"手动 `input_audio_buffer.commit`"的方案（代码逻辑当时已经写过一次，需要的话可以照抄）。
  4. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关）。**还没有用真实录音实际验证过 `gpt-live-transcribe` + `server_vad`（500ms）这次是否真的不报 400**——这是这次改动里唯一还没有验证过的风险点，需要 Julia 重启后端（`.env` 改了必须重启）之后实测确认。如果又报 "Turn detection is not supported for this transcription model"，说明这次的推测是错的，请把报错贴回来，我会按上面第 3 点说的两个备选方案之一处理。
- **v19（本版）**：Julia 重启后端实测，**确认还是报同样的 400 "Turn detection is not supported for this transcription model"**——v18 里"这次应该能跑通"的推测被证伪了，而且 Julia 顺手贴了 OpenAI 官方"Realtime transcription"指南原文，这次直接给出了明确证据：
  1. **问题出在哪**：官方"Realtime transcription"指南里，`gpt-live-transcribe`（以及 `gpt-transcribe`）的**每一个** `session.update` 示例，`turn_detection` 字段全部是显式的 `null`；指南里紧接着写"如果想让服务端自动检测并 commit 回合边界，请改用 voice activity detection（配置方式）"，附了另一篇独立的 VAD 指南链接。我去查了那篇 VAD 指南，里面又说 `gpt-live-transcribe` 是支持 `server_vad` 的（只有 `gpt-realtime-whisper` 需要 `null`）——**这和"Realtime transcription"指南本身的示例直接矛盾**。也就是说 OpenAI 自己的两篇文档在这一点上互相打架。面对这种文档自相矛盾的情况，唯一可信的是**实际跑出来的结果**：这个 400 已经在两次独立的重启测试里都稳定复现（v12 一次，这次又一次），说明至少在 Julia 当前这个账号/API 版本下，`gpt-live-transcribe` 配 `turn_detection: {type: "server_vad", ...}` 就是会被拒绝，不是巧合，也不是"当时那个版本的问题"（这是我在 v16/v17 里的错误推测，这次被证明不成立，在这里明确记一笔更正）。
  2. **修复：改回 `gpt-4o-transcribe`**——这是目前唯一一个在这个平台上**从来没有**因为 `turn_detection` 报过 400 的模型，`backend/.env`、`.env.example`、`transcript.ts` 里的兜底默认值全部改回 `gpt-4o-transcribe`；`transcript.ts` 顶部的注释也重写了，如实记录这次反复的经过和教训（不要只信通用 schema 文档，per-model 的指南页面 + 实际报错才是准数）；前端 `WebRTCTranscript.tsx` 因为 v18 已经把模型名改成动态读取（不再硬编码），这次不需要改代码，只把注释更新了一下，提醒以后不要在不改 `turn_detection` 逻辑的情况下单独把 `OPENAI_REALTIME_MODEL` 改回 `gpt-live-transcribe`（那样会立刻重新触发这个 400）。
  3. **如果之后还是想用 `gpt-live-transcribe`**（比如为了转录质量，或者想匹配朋友的模型选择）：那就必须放弃"服务端自动断句"这条路，改用 `turn_detection: null` + 手动定时/智能触发 `input_audio_buffer.commit`——也就是回到 v12 那套方案（之前写过一次代码，逻辑还在，需要的话可以照抄复用），或者做一个更好的版本：不用固定 4 秒定时器，而是在浏览器端用 Web Audio API 的 `AnalyserNode` 实时监测音量，检测到连续静音超过某个阈值（比如 Julia 想要的 500ms）才触发 commit——这样即使服务端不支持自动 VAD，效果也能接近"停顿断句"，而不是生硬地按固定时间切。**这个改动目前还没有实施**，因为这次先把平台改回能跑的状态（`gpt-4o-transcribe`）优先解决"能用"的问题；如果 Julia后续明确想换成 `gpt-live-transcribe`，需要专门做这个客户端静音检测的功能，工作量比单纯改一个环境变量大不少，需要先确认这是否值得做。
  4. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过。**这次改回 `gpt-4o-transcribe` 本身没有再单独验证过**（因为它是之前长期在用、没报过这个错的配置），但理论上应该是回到了之前工作正常的状态；仍然建议 Julia 重启后端后实测确认一次，确保没有引入新问题。
- **v20（本版）**：Julia 想把 `audio.input.transcription.delay` 设成 `"low"`，追求更低延迟——已加上，改动如下：
  1. `backend/src/routes/transcript.ts`（`/session` 创建 client_secret 请求）+ 前端 `WebRTCTranscript.tsx`（数据通道打开后重发的 `session.update`）都在 `transcription` 对象里加了 `delay: 'low'`，和 `model` 字段同级：`transcription: { model: transcriptionModel, delay: 'low' }`。
  2. **一个需要如实说明的不确定性**：Julia 之前贴的官方"Realtime transcription"指南里，`delay` 参数出现的那个示例（"Add transcription context"那节）是配在 `gpt-live-transcribe` + `turn_detection: null` 的组合上的，不是我们现在实际在用的 `gpt-4o-transcribe` + `server_vad`（自动模式）组合。指南正文本身在"Tune latency and accuracy"那节谈 `delay` 的时候没有限定只对某个模型有效，看起来是个通用的流式转录参数；但鉴于这次 `gpt-live-transcribe`/`turn_detection` 那一轮教训——文档字面表述和实际账号里跑出来的结果不一定一致——**这次没有办法在实施前百分百确认 `delay` 对 `gpt-4o-transcribe` 一定生效**，需要 Julia 实测确认。如果重启后端后又看到类似 "xxx is not supported for this transcription model" 这种针对 `delay` 字段的 400 报错，那就是这次的推测又错了，需要把这个字段去掉或者只在 `gpt-live-transcribe` 下用（但 `gpt-live-transcribe` 现在因为 turn_detection 的问题没法用自动断句模式，除非先做 v19 第 3 点提到的手动 commit 改造）。
  3. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关）。**还没有用真实录音验证过这个改动本身**，需要 Julia 重启后端后实测确认——如果一切正常，应该会感觉到转录出来得更快一些（代价是文档里说的"可能牺牲一些准确率"，这个也需要实测感受一下是否明显）。
- **v21（本版）**：Julia 提出可以用 `transcription.prompt` 字段告诉模型"一个用户正在和 AI chatbot 协作制作一个 adult learning platform proposal"这个场景上下文——已加上，改动如下：
  1. `backend/src/routes/transcript.ts` 新增模块级常量 `TRANSCRIPTION_PROMPT`（英文，描述"这是一段 think-aloud 录音，参与者正在和 AI chatbot 协作设计、撰写一份成人学习平台的 proposal，可能会聊到课程设计、课程结构、学习者需求、平台功能，以及自己的设计思路"），加进 `/session` 请求体的 `transcription: { model, delay, prompt: TRANSCRIPTION_PROMPT }`；前端 `WebRTCTranscript.tsx` 里 `session.update` 重发的那份配置同步加了同一段 `prompt`（保持前后端一致，和 `delay`/`model` 一样是"双重确认"的写法）。
  2. **为什么用英文写 prompt，而不是中文**：这个 `prompt` 是给模型看的上下文提示，不是参与者看到的界面文案，用英文写更符合 OpenAI 官方示例的写法习惯，理论上不影响它同时帮助识别中英文混说内容里的专业词汇（课程设计相关术语）。如果 Julia 希望换成中文版本的 prompt，或者想让内容更具体（比如提到实验设计本身、AI 引导等细节），告诉我可以随时改。
  3. **依据**：Julia 之前贴的 OpenAI 官方指南里"Add transcription context"这节明确写了"Use `prompt` to describe the recording or its setting"，是专门为这种场景设计的字段，用于提升生僻词汇/专业术语的转录准确率——这个字段本身没有像 `turn_detection` 那样在实测里出过岔子，风险比之前几次改动低，但同样还没有拿真实录音验证过效果。
  4. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关）。**还没有用真实录音验证过 prompt 对转录准确率的实际影响**，效果好坏需要 Julia 实测感受（比如说到"curriculum design"、"learner persona"这类术语的时候转录是否更准）。
- **v22（本版）**：Julia 重启后端实测，**v20 加的 `delay: 'low'` 报了 400**："The 'delay' parameter is not supported for this model"（`param: session.audio.input.transcription.delay`）——这次没有歧义，OpenAI 明确说了这个字段对当前模型（`gpt-4o-transcribe`）不支持。事后回头看，我之前用 WebFetch 查 `transcription_sessions` create 接口文档时，其实已经拿到过一条结果说"`delay` 字段 Only supported with `gpt-realtime-whisper`"——当时因为这条结果和 Julia 贴的官方指南文本（那份指南在讨论 `delay` 时没有限定模型）看起来矛盾，而且当天 `turn_detection` 那轮已经让人对 WebFetch 摘要结果不敢完全信任，所以在 v20 里选择了"先加上、注释里写清楚不确定性、让实测说话"的做法——这次实测正好验证了那条"仅支持 `gpt-realtime-whisper`"的结果反而是准的。这也印证了 v19 学到的教训：**遇到 OpenAI 文档自相矛盾或来源不确定时，实际报错永远是最终依据，不需要纠结"哪篇文档更权威"，跑一次就知道了**。
  1. **修复**：`backend/src/routes/transcript.ts`、`frontend/src/components/WebRTCTranscript.tsx` 两处都把 `delay: 'low'` 去掉了，只保留 `model` 和 `prompt`；相关注释同步更新，记录了这次确认的结论（`delay` 在当前 GA 接口下看起来是 `gpt-realtime-whisper` 专属字段，不是通用的流式转录参数）。
  2. **`prompt` 字段保留不变**——这次的 400 报错明确指向 `delay`（`param` 字段写的是 `session.audio.input.transcription.delay`），跟 `prompt` 无关，所以没有理由跟着一起去掉；但因为这次连接直接在 `delay` 那步就失败了，`prompt` 对转录准确率的实际效果这次也还没有机会被验证到，需要 Julia 这次重启后再测一次。
  3. `backend`、`frontend` 的 `tsc --noEmit` 均验证通过；`frontend` 额外跑了一次 `CI=true npm run build`，唯一报错的警告仍然只在 `useInteractionLogger.ts`（既有、和本次改动无关）。**这是这一串转录配置调整里第一次没有再新加任何"待验证"的不确定项**——目前 `gpt-4o-transcribe` 的配置是：`model` + `prompt`（场景上下文） + `turn_detection: server_vad`（500ms，已知可用）。如果这次重启后还有报错，请把日志贴过来。

---

## 1. Controller 触发机制（v4，修正版）

你的澄清整理成机制如下（我按自己的理解复述一遍，确认我没理解错）：

- Controller 持续追踪"当前连续同方向 move 的计数"：`streak_orientation`（当前连续的是 D 还是 C）+ `streak_count`（连续了几个）。
- 每当 Evaluation Agent 给出新的 move 分类结果：
  - 如果新 move 的 orientation 和 `streak_orientation` 一致 → `streak_count += 1`；
  - 如果不一致 → `streak_orientation` 切换成新方向，`streak_count` 重置为 1。
- **一旦 `streak_count >= 2`**：Controller 判定需要"强干预"——生成一条引导用户转向反方向的 guidance（淡蓝气泡 + 💡），**同时立刻把 `streak_count` 清零**（`streak_orientation` 也清空/重置）。这个"清零"就是 cooldown 的全部含义——不是"接下来 N 轮不管发生什么都不说话"，而是"干预发生后，必须重新累积够 2 个连续同方向 move，才可能触发下一次干预"。因为 main response agent 已经把这条 guidance 消化成一轮新的回复了，紧接着的新一轮 move 会重新开始计数，天然不会立刻又触发一次。
- **`streak_count < 2` 的所有情况都完全静默**——不再有"已经在交替→light nudge"这个中间档。Controller 要么不说话，要么给一次明确的强干预。

这样一来，`manipulation_state` 不再需要单独的 `cooldown_turns_remaining` 字段，用 `streak_orientation` + `streak_count` 就能同时实现"检测连续同向"和"干预后冷却"两件事，逻辑更简单。

**已确认**：streak 只统计 move_type 1/3/4/6（Generate/Evaluate/Adopt/Reject）这几种"内容型" move，**排除 Ask（type2）/AI Response（type5）**这两类结构性 move。

Low-TF 的"反向纠偏"逻辑也统一改成同样的机制（不再有"轻推"）：phase=collect 时，如果内容型 move（同样排除 Ask/AIResponse）连续 2 次是 C → 强干预拉回 D，并清零计数；phase=synthesize 反之。

---

## 2. manipulation_state 表（v4，最终字段）

- `session_id` (PK)
- `tf_level` ('high' | 'low')
- `tm_level` ('high' | 'low')
- `is_control` (bool)
- `phase` ('collect' | 'synthesize' | 'na')　— 只有 Low-TF 用，其余为 'na'
- `phase_advanced_at`　— 记录 Phase1→Phase2 切换时间
- `streak_orientation` ('D' | 'C' | NULL)
- `streak_count` (INT DEFAULT 0)
- `turn_count` (INT)
- `updated_at`

（取代 v2/v3 里提到的 `cooldown_turns_remaining` 字段。）

---

## 3. 已确认的问题回复（累计，含本次）

- 1 group id：参与者自己输入文本框，**输入的是数字 1-5**（1=control / 2=HighTF_HighTM / 3=HighTF_LowTM / 4=LowTF_HighTM / 5=LowTF_LowTM），界面上不显示任何条件名称或映射提示。
- 2 eval agent：OpenAI fine-tuned model，复用 partition 分段+校验重试逻辑。`EVAL_MODEL_ID` 已收到：`ft:gpt-4o-mini-2024-07-18:personal:design-moves-tvt:Dj0Wo9or`（存于 `backend/.env`，Phase 4 时接入 `moveTypeEvaluator.ts`）。
- 3 Low-TF：结构化两阶段，A（同页面锁定/解锁写作区）。
- 4 guidance：淡蓝色气泡 + 💡图标，单轮生效不进持久 system prompt。
- 5 adopt/reject 需要接入 WritingSection 编辑事件：确认需要。
- 6 control 组也全程跑 evaluation agent 打标：确认。
- 7 think-aloud 转录保留：确认需要。
- 8 cooldown 语义：已按澄清改为"streak 清零"机制，不再有 light nudge（见第1节）。
- 9 streak 计数范围：**已确认排除 Ask/AI Response**，只统计 Generate/Evaluate/Adopt/Reject。

---

## 4. 关键发现：你现成的离线 pipeline 是怎么工作的（不变，来自 v3）

1. **Event timeline 构成**：`behavior_narration.py` 把交互日志清洗+分组+生成人类可读 `action_description`；`design_move_separation.py` 把 behavior + chat + voice transcript smart-merge（speech 完全落在某 behavior 时间窗口内则合并进它的 `speech` 字段，否则单独成 `user_speech` 事件），chat 的 user_message/ai_response 各自成事件，按时间排序、编号 `event_id`，最终字段 `{event_id, timestamp_start, timestamp_end, action_description, speech, user_message, ai_response}`。
2. **Move type 判定主要看交互行为和语音，不是聊天文本**：复制 AI 文本粘贴进写作区=Adopt，打字内容和 AI 回复相似=Adopt，全新想法=Generate，删除/无视/反对=Reject。move type 2(Ask)/5(AI Response) 完全确定性（消息非空即是）。
3. **Evaluation Agent 实际调用方式**：`use_finetuned_model_partition_final.ipynb` 的 `predict_design_moves_partitioned`——在每个 `user_message` 处切 partition（=上次 AI 回复+期间行为/语音事件+这次新提问），对每个 partition 一次性调用 fine-tuned model 输出完整 move 列表，校验 Ask/AI_Response 数量不符则重试≤3 次。这个 partition 边界天然对应每轮聊天节奏。
4. **建议**：real-time Evaluation Agent 复用 finetuned-partition 这套（简单、且真正训练验证过），不要照搬你上传的 LangGraph 多 agent 增量式方案（怀疑效果不好是因为未微调的 gpt-4o-mini 做逐事件边界判断不稳定）。
5. **语音转录目前不是实时进后端的**：`interaction_logs`/`messages` 已实时写库，但 `WebRTCTranscript.tsx` 的转录段只在客户端攒着，提交时才导出文件——需要新增实时上传。

---

## 5. 新增设计：agent_execution_log（多 agent 每步执行记录）

`agent_execution_log`: `id, session_id, turn_index, agent_name`(evaluation_agent/manipulation_controller/main_response_agent)`, step_order, input_payload, output_payload, model_used, started_at, completed_at, duration_ms, status`(success/error/timeout/fallback_used)`, error_message, retry_count, created_at`。统一记录三个 agent 每一步的输入输出和耗时。

---

## 6. 新增设计：Real-time Event Timeline

新表 `speech_segments`（原始语音段实时写入）+ `session_events`（合并后统一 timeline，实时增量构建，字段对齐离线版：`id, session_id, event_id, timestamp_start, timestamp_end, event_type, action_description, speech, user_message, ai_response, created_at`）。新增后端服务 `eventTimelineBuilder.ts`：移植 `behavior_narration.py` 的分组叙述规则（先覆盖打字/删除/复制粘贴进写作区/悬停查看AI回复/滚动/点击）+ `design_move_separation.py` 的 smart-merge 逻辑，增量更新。副作用：这个 real-time timeline 建成后，实验结束不再需要额外跑离线 event timeline 构建脚本。风险：real-time 叙述文本风格需贴近离线版模板措辞，否则可能影响 finetuned 模型判断质量。

---

## 7. move_ledger（对齐 finetuned 模型输出结构）

`move_ledger`: `id, session_id, move_id, move_type`(1-6)`, orientation`(派生：1/2/5→D，3/4/6→C)`, description, event_id_start, event_id_end, turn_index, created_at`。

---

## 8. Runtime Flow（v4）

```
用户发消息（第 N 轮）
  │
  ▼
记录 messages(role=user, is_guidance=false)
  │
  ▼
[eventTimelineBuilder] 关闭上一个 partition：上次 ai_response 事件 + 期间 session_events + 这次新 user_message
  │
  ▼
[moveTypeEvaluator] 调用 EVAL_MODEL_ID 对该 partition 一次性预测 move 列表（校验数量，重试≤3次）
  │  → 写 move_ledger；写 agent_execution_log(evaluation_agent)
  ▼
[manipulationController]
  │  更新 streak_orientation/streak_count（只看内容型move 1/3/4/6，已排除Ask/AIResponse）
  │  High-TF: streak_count>=2 → 强干预+清零；否则静默
  │  Low-TF: phase由前端Next驱动；偏离phase目标方向streak>=2 → 强干预+清零；否则静默
  │  Control: 永远静默
  │  → 更新 manipulation_state；写 agent_execution_log(manipulation_controller)
  ▼
若有guidance → 存messages(role=user, is_guidance=true) → SSE先推给前端(淡蓝气泡+💡)
  │
  ▼
[Main Response Agent] 用含guidance的历史消息生成回复 → 写 agent_execution_log(main_response_agent)
  │
  ▼
记录 assistant 回复 (messages 表)，作为下一轮 partition 起点
```

---

## 9. 分阶段实施计划

**✅ Phase 0 — 数据库基础（已完成）**：`sessions.group_id`；`messages.is_guidance`；新建 `move_ledger`、`manipulation_state`、`agent_execution_log`、`session_events`、`speech_segments`。全部通过 `backend/src/index.ts` 的 `createTables()`（含 `ensureColumn` 兼容旧库）落地，并留了一份 `backend/database/migrate_add_paper2_manipulation_system.sql` 作为参考迁移脚本。

**✅ Phase 1 — 前端可见部分 + STUB evaluator 打通端到端（已完成）**：
- `backend/src/agents/manipulationController.ts`：完整 streak 状态机（v5 机制，非简化版）——`parseGroupId`、`initManipulationState`、`getManipulationState`、`advancePhase`、`runManipulationController`。
- `backend/src/agents/moveTypeEvaluator.ts`：Phase 1 stub（Ask 确定性 + gpt-4o-mini 粗分类 Generate/Evaluate/Adopt/Reject，超时/失败自动降级），文件头明确标注会在 Phase 4 被替换。
- `backend/src/services/manipulationPipeline.ts`：`runTurnPipeline`（跑 evaluator + controller，写 `agent_execution_log` + `move_ledger`，必要时插入 guidance 消息）+ `logMainResponseTurn`（记录 main response agent 执行 + 确定性 AI-Response move）。对没有 `manipulation_state` 行的旧会话完全不介入（`{ ran: false }`）。
- `backend/src/routes/chat.ts`：`/send` 和 `/stream` 都接入了上述 pipeline（`/` 别名路由未改，确认前端只走 `/stream`）；`/stream` 在设置 SSE 头之后、开始流式输出模型回复之前，先把 guidance 作为独立 SSE 事件推送给前端；成功/中断/失败三条路径都补了 `logMainResponseTurn` 调用。
- `backend/src/routes/session.ts`：`/create` 新增 `groupId` 校验 + 落库 + `initManipulationState`；新增 `POST /:sessionId/advance-phase`（服务端校验 5 分钟最短 collect 时长）；新增 `GET /:sessionId/manipulation-state`（给前端读取条件/phase 用）；顺手把 `manipulation_state`/`move_ledger`/`agent_execution_log` 也加进了 `/:sessionId/export` 的导出数据里。
- 前端 `UserIdEntry.tsx` + `App.tsx`：入口页新增 Group ID 文本输入框（参与者自己填，前端先做一次白名单校验），随「开始正式任务」一起提交给 `/api/session/create`；practice session 不带 group id，完全不受影响。
- 前端 `ChatInterface.tsx`：guidance 消息走独立气泡渲染（淡蓝背景 + 🧭 Guidance 标签），通过 SSE `data.guidance` 事件在助手回复开始流式输出前插入；历史记录接口和本地 `Message` 类型都加了 `isGuidance` 字段，刷新页面后气泡样式不丢。
- 前端 `WritingSection.tsx` + `ResearchPageActual.tsx`：新增 `locked` 属性——Low-TF 条件下 collect phase 期间写作区显示锁定遮罩（🔒 + 提示文案）、Clear/Submit 按钮同步禁用；`ResearchPageActual.tsx` 在挂载时拉取 `manipulation-state`，5 分钟后显示"Next"按钮（调用 `advance-phase`），15 分钟仍未切换则显示一次软提醒横幅（不重复弹）。High-TF / control 条件完全没有这层锁定 UI，行为和原来一致。
- 验证：backend `tsc --noEmit` / `npm run build` 通过；frontend `tsc --noEmit` 通过、`npm run build` 成功产出（仅有与本次改动无关的既有 `useInteractionLogger.ts` lint 警告，非本次引入）。

**✅ Phase 2 — 语音转录实时化（已完成）**：`WebRTCTranscript.tsx` 批量上报转录段到新的 `speech_segments`（新增后端路由 `POST /api/transcript/segments/batch`，前端沿用 `useInteractionLogger` 的队列+定时 flush 模式）。时间戳用绝对 epoch 毫秒，与 `interaction_logs` 的相对毫秒约定不同，Phase 3 需要对齐——详见第 0 节 v16 changelog。

**Phase 3 — Real-time Event Timeline Builder**：移植叙述+smart-merge逻辑，增量写 `session_events`，和离线脚本产出比对验证。

**Phase 4 — 接入真正 Evaluation Agent + Decision Agent**：`moveTypeEvaluator.ts` 照搬 partition 预测+校验+重试逻辑，调用 `process.env.EVAL_MODEL_ID`（已就绪：`ft:gpt-4o-mini-2024-07-18:personal:design-moves-tvt:Dj0Wo9or`）；写 `move_ledger`+`agent_execution_log`；超时/失败降级到 Phase1 简化逻辑；会话结束额外评估最后一个 partition。同时按第 10 节的设计接入 Decision Agent（与 Evaluation Agent 并行调用），落地前 Julia 会先单独测试 finetuned 模型能否直接输出 D/C——如果能，第 10 节的方案可以简化/合并，具体以那次测试结果为准。

**Phase 5 — Controller 切换到真实 move_ledger + Decision Agent 输出**：接入真实 streak 计算（排除 Ask/AIResponse，只看内容型 move），streak 的 D/C 判断改用 Decision Agent 的实时输出，而不是 move_type→orientation 的静态映射表（后者继续作为 `move_ledger.orientation` 字段保留，供分析用，不再驱动 Controller）。

**Phase 6 — 端到端联调**：5 个条件各跑一遍，检查 guidance 触发时机是否符合预期、Low-TF 锁定/解锁、数据质量、响应延迟。

---

## 10. Decision Agent 设计（v9 新增，Phase 4/5 落地，现阶段仅记录设计）

### 10.1 Planned Evaluation-Model Ablation (recorded 2026-09-18)

Current implementation path: retain the fine-tuned `EVAL_MODEL_ID` for move-type prediction and use the separate Decision Agent for D/C judgement.

Future experiment to run before changing the production path: compare this against a general-purpose model supplied with the move-coding guidance as a system prompt. Test whether it can produce both `move_type` (1-6) and D/C orientation directly, without fine-tuning, while preserving the partition boundaries and Ask/AI_Response count checks. Compare classification quality, agreement with coded data, latency, and cost before deciding whether the two-agent flow can be collapsed.

**动机**：目前 D/C（divergent/convergent）判断完全依赖 `move_type → orientation` 的静态映射（1/2/5→D，3/4/6→C）。Julia 提出：orientation 不应该是 move_type 的机械推导，而应该由一个单独的 Decision Agent，基于这个 move 的**实际内容**、结合此前的 move sequence，来判断"这次新增的 move 相对于之前的想法，是在引申已有想法（convergent）还是提出新想法（divergent）"。

**Decision Agent 的判断逻辑（Julia 原话整理）**：
1. 最高优先级：看内容本身——如果这个 move 主要是对前面想法的引申/引用/检测/支持/反驳，判 convergent；如果主要是提出新想法，判 divergent。
2. 如果 move_type 是 Evaluate / Adopt / Reject，倾向于判 convergent（这三类大概率是在回顾之前的 move），但不是硬编码规则，只是先验倾向。
3. 输入：最新新增的 move + 目前已有的 move sequence（不断累加）。
4. 一旦某个 move 被打上了 D/C 标签并加入 move sequence，Controller 才开始用它计算是否达到干预标准。

**已确认的设计结论（Julia 2026-09 回复，本次记录）**：
- **`move_ledger` 同时保留 `move_type` 和 `orientation` 两个独立字段**——不是互相替代关系。`orientation` 字段将改由 Decision Agent 的实时判断结果写入（Phase 5 起驱动 Controller），静态映射表退化为一个后备/参考值，方便后续做分析对比。
- **Decision Agent 是独立于 Evaluation Agent 的另一次模型调用**，现阶段按"finetuned 模型不能直接输出 D/C"来设计。Julia 会单独测试她的 finetuned 模型能否在给出 move_type 的同时直接输出 D/C；**如果能，这个方案需要重新评估**（可能可以合并进 Evaluation Agent 一次调用里，省掉一次单独的 LLM 调用和延迟）。在测试结果出来之前，先按两个独立 agent 来实施。
- **执行方式：与 Evaluation Agent 并行调用，而不是串行等待**，以避免两次模型调用叠加延迟：
  - 每一轮触发 Evaluation Agent 的同时，一并触发 Decision Agent。
  - Decision Agent 读取的 move sequence，是"上一轮 Evaluation Agent 更新完之后"的状态（即截止到上一轮为止的 sequence + 上一轮已判定的 D/C），而不是等本轮 Evaluation Agent 跑完再读。
  - 本轮 Decision Agent 的输出，直接决定本轮新 move 的 D/C，供 Controller 立刻使用。
  - 本轮 Evaluation Agent 的输出（move_type 分类）只用于把新 move 追加/更新进 move sequence，作为**下一轮** Decision Agent 调用时的输入上下文。
  - 效果：两个 agent 各自读到的"当前状态"总是相差一轮，但避免了同一轮内的串行依赖，不增加单轮响应延迟。
- **落地时机：Phase 4/5**，现在只是把设计定下来记录，不在 Phase 1 阶段实施。Phase 4/5 的具体改动点：`agent_execution_log.agent_name` 的 ENUM 需要新增 `decision_agent` 值；`manipulationPipeline.ts` 需要改成并行发起 evaluation + decision 两次调用（`Promise.all` 或等价方式）；`manipulationController.ts` 的 streak 计算改读 Decision Agent 的输出而不是静态映射。
- **v15 补充（Julia 提问后确认）：Decision Agent 的执行动态也要接入第 11 节的测试模式调试面板**——和 Evaluation Agent、Manipulation Controller 一样，展示开始/结束、判断结果。这个面板从设计上就是给"多 agent 协同过程"做实时可视化用的，Decision Agent 是这套 pipeline 里同等重要的一环，没有理由不放进去。已经提前把类型定义扩展好：`manipulationPipeline.ts` 的 `AgentStageEvent.agent` 联合类型、`DebugPanel.tsx` 的同名类型和 `AGENT_LABELS` 都加了 `decision_agent` 这个值（标注为"Phase 4/5 保留，目前没有任何代码会真正发出这个事件"）。这样 Phase 4/5 真正写 Decision Agent 的时候，只需要照抄 Evaluation Agent 那两行 `onStage?.({agent:'decision_agent', status:'started'/'completed', ...})` 调用加进 `runTurnPipeline`（并行发起那部分），调试面板不需要再改一行代码就会自动显示出来。`tsc --noEmit`（backend + frontend）已验证通过。

---

## 11. 测试模式调试面板（v9 设计，✅ v15 已实施完成）

**触发条件**：`userId` 以 `test` 开头（大小写不敏感）时，进入和正式界面完全一样的交互界面，额外在右上角加一个小按钮。

**面板内容**：点击后从右侧滑出一个面板，展示：
1. 用户的实时语音转录文本（realtime transcript）。
2. 后端 agent 执行阶段的实时时间线，例如"evaluation agent is initiated"、"evaluation agent returned move type 'Generate' (D)"这种逐步骤日志。

**实际实现（v15）**：复用了 `/stream` 的 SSE 通道，新增 `data.agentStage` 事件类型，和已有的 `data.guidance` 走同一条通道；`manipulationPipeline.ts` 的 `runTurnPipeline` 新增可选 `onStage` 回调参数，在 Evaluation Agent、Manipulation Controller 各自开始/结束时调用；`chat.ts` 只在 `isTestSession(sessionId)` 为真时才构造并传入这个回调（新增 `backend/src/utils/sessionUtils.ts` 的 `isTestSession`），真实参与者的会话完全不受影响、不多付出任何额外开销；`WebRTCTranscript.tsx` 新增 `onTranscriptUpdate` 回调把实时转录文本往上传；新增 `frontend/src/components/DebugPanel.tsx` 承载面板 UI；`ResearchPagePractice.tsx`/`ResearchPageActual.tsx` 两个页面都接入了。详见第 0 节 v15 changelog 的完整改动清单。**Decision Agent 落地后（Phase 4/5），需要在 `manipulationPipeline.ts` 里补一个 `decision_agent` 的 onStage 调用**，才能让调试面板也显示它的执行过程——目前面板代码结构已经支持扩展第三种 agent 类型，届时只需要照着 evaluation_agent 的写法加一份。

---

*此文件由 Claude 生成，作为实现前的对齐文档。Phase 0/1 已实施完成并通过编译/构建验证，`EVAL_MODEL_ID` 已就绪，group id 入口已按参与者实际填写的数字 1-5 调整；`sessions` 表 user_id/participant_id 列名问题已改成后端启动时自动迁移（`renameColumnIfNeeded`）；OpenAI API key 已更新；语音转录 API 已迁移到支持自动 VAD 断句的 `gpt-4o-transcribe`；刷新页面清空会话状态的平台级 bug 已修复（localStorage 续存 + 计时器按真实已过时间恢复，v14）；测试模式调试面板已实施完成（v15，第 11 节）；Decision Agent 架构设计已确定（第 10 节），落地时机为 Phase 4/5；Phase 2（语音转录实时上传到 `speech_segments`）已实施完成（v16）；调试面板转录展示改成按分段单独一行（v17）；已用 OpenAI 最新官方文档修正了 v12/v13 里"gpt-live-transcribe/gpt-realtime-whisper 拒绝 turn_detection"这个过时结论，曾短暂切换到 `gpt-live-transcribe`（v18）但实测确认 turn_detection 依然报 400，已改回 `gpt-4o-transcribe`（v19，第 0 节有完整的踩坑记录和教训）；前端 session.update 里硬编码模型名的潜在 bug 已顺带修复（v18）；`silence_duration_ms` 阈值是否需要针对 think-aloud 场景专门调优仍待 Julia 用真实录音测试后再定；如果之后仍想用 `gpt-live-transcribe`，需要改造成 `turn_detection: null` + 手动/客户端静音检测触发 commit 的方案（v19 第 3 点已记录思路，尚未实施）；曾加上 `delay: 'low'`（v20）但实测确认 `gpt-4o-transcribe` 不支持这个字段（400），已移除（v22）；`transcription.prompt` 场景上下文提示（v21，描述参与者正在和 AI 协作制作 adult learning platform proposal，帮助识别专业词汇）保留，效果尚未实测确认。接下来的主线工作是第 9 节里还没开始的 Phase 3（Real-time Event Timeline Builder，需要对齐 Phase 2 留下的绝对/相对时间戳约定差异）、Phase 4（接入真正的 Evaluation Agent + Decision Agent）、Phase 5（Controller 切换到真实 move_ledger）、Phase 6（端到端联调）。*
