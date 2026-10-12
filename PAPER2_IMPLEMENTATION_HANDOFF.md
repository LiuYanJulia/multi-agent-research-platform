# Paper 2 实验平台 — Phase 3-6 实施交接文档

**写给**：接下来负责实施 Phase 3/4/5/6 的其他 agent（不一定是我）。
**目的**：这不是一份 high-level 路线图，而是把之前所有讨论中确定下来的具体实现逻辑、数据结构、边界情况都摆出来，让接手的 agent 不需要再和 Julia 反复确认设计问题，可以直接开始写代码。
**不在本文档范围内**：语音转录 API 的模型选择/配置调优（`gpt-live-transcribe` vs `gpt-4o-transcribe`、`turn_detection`、`delay`、`prompt` 等）——这部分 Julia 已经安排另一个 agent 单独处理，接手 Phase 3-6 的 agent **不需要碰** `backend/src/routes/transcript.ts` 和 `frontend/src/components/WebRTCTranscript.tsx` 里和 OpenAI Realtime 连接/session 配置相关的代码，除非 Julia 明确要求。

---

## 0. 必读参考文件清单

在开始写代码之前，请先读完以下文件，很多设计决策的"为什么"都在里面：

1. **`Project 2 - V2.pptx`**（Slide 17–22）—— 实验设计的原始文档（SOI 模型、TF/TM 条件设计、六类 move 分类体系），在 Julia 的 claude.ai Project "paper2 research platform" 里能找到。
2. **`PAPER2_MANIPULATION_PLAN.md`**（仓库根目录 `/Users/yanliu/Projects/Manipulation research-platform/PAPER2_MANIPULATION_PLAN.md`，同步版本也在 claude.ai Project 的 `claude/paper2-manipulation-system-plan.md`）—— 这是从项目一开始到现在（当前版本 v22）完整的设计讨论 + 实施记录 + 踩坑历史，本文档里引用的所有设计结论都可以在这份文档里找到原始出处和讨论过程。**这份文档的第 0 节（更新日志）记录了大量语音转录 API 调试的来回过程，那部分是另一个 agent 在负责的范围，可以跳过不看，但第 1/2/3/4/5/6/7/8/9/10/11 节都是 Phase 3-6 需要的设计依据。**
3. **`/Users/yanliu/Projects/Pipeline Code`**（Julia 本地的离线数据处理仓库，不在本项目代码库里，需要 Julia 单独提供访问）—— 这是 Phase 3（event timeline）和 Phase 4（evaluation agent）要移植/复用的逻辑来源：
   - `behavior_narration.py` —— 把交互日志（interaction_logs）清洗、分组，生成人类可读的 `action_description` 文本。
   - `design_move_separation.py` —— 把 behavior 事件 + chat 消息 + 语音转录做 smart-merge，生成统一的 event timeline。
4. **`use_finetuned_model_partition_final.ipynb`**（Julia 提供的 notebook）—— Evaluation Agent 实际的调用方式：`predict_design_moves_partitioned` 函数，这是 Phase 4 要照搬的核心逻辑。
5. **`move_segmentation_multi_agent.ipynb`**（Julia 上传过的 notebook）—— 一个 LangGraph 多 agent 增量式方案。**已经讨论过、明确不建议照搬**：怀疑效果不好是因为用未微调的 gpt-4o-mini 做逐事件边界判断不稳定，不如 partition 方式简单可靠。可以看，但不要按它的架构实施 Phase 4。
6. **目标代码库**：`/Users/yanliu/Projects/Manipulation research-platform`（本项目所有代码改动的落地位置）。

---

## 1. 项目背景（一句话版）

参与者一边和 AI chatbot 协作设计、撰写一份 adult learning platform proposal，一边全程 think-aloud（说出自己的思考过程）；系统会实时评估参与者每一步的设计行为属于哪种"move"类型，判断其倾向是发散（divergent）还是收敛（convergent），并根据实验条件（TF/TM 2×2 + control，共 5 组）决定是否要通过一条 guidance 消息去"操纵"参与者的思考方向。这是一个研究生成式 AI 如何影响人类设计认知行为（design cognition）的实验平台。具体的条件设计、SOI 理论背景，请看 `Project 2 - V2.pptx` Slide 17–22——这里不展开重复，避免和原始设计文档产生偏差。

---

## 2. 当前已完成的部分（Phase 0/1/2，不需要重做）

- **Phase 0（数据库）**：`sessions.group_id`、`messages.is_guidance`；新表 `move_ledger`、`manipulation_state`、`agent_execution_log`、`session_events`（**建了表，但 Phase 3 之前一直是空的**）、`speech_segments`（Phase 2 已经在写入数据）。
- **Phase 1（前端可见部分 + STUB evaluator 打通端到端）**：完整的 streak 状态机（`manipulationController.ts`）、Phase 1 版本的 move 分类 stub（`moveTypeEvaluator.ts`，用未微调的 gpt-4o-mini 粗分类，**Phase 4 要替换成真正的 finetuned 模型**）、`runTurnPipeline` 主流程（`manipulationPipeline.ts`）、guidance 消息的独立气泡渲染、Low-TF 两阶段锁定 UI、group id 数字化输入（1-5）。
- **Phase 2（语音转录实时上传）**：`WebRTCTranscript.tsx` 批量把转录段上传到 `speech_segments` 表（`POST /api/transcript/segments/batch`）。**注意**：`speech_segments.timestamp_start/timestamp_end` 存的是**绝对 epoch 毫秒**，而 `interaction_logs.timestamp`（行为日志）存的是**相对会话开始的毫秒数**——这两种约定不一致，是 Phase 3 必须处理的一个坑（见下面第 4 节）。
- **测试模式调试面板**：`userId` 以 `test` 开头会看到一个可以展开的调试面板，实时显示语音转录（按分段展示）+ agent 执行时间线（`evaluation_agent`/`manipulation_controller`/`main_response_agent`，`decision_agent` 的类型已经预留好，Phase 4/5 只需要在 `manipulationPipeline.ts` 里加两行 `onStage` 调用，不需要改面板 UI）。**这个面板是 Phase 4/5 开发时最好用的调试工具**，可以直接建一个 `test` 开头的 userId 实时看到每个 agent 的输入输出。
- **Decision Agent 的架构设计已经确定**（见第 6 节），但代码还没写，是 Phase 4/5 的工作。

---

## 3. 已经确定、不需要再讨论的核心机制

这些是之前反复讨论确认过的设计，实施时直接照做，不需要再问 Julia：

### 3.1 Controller 触发机制（streak 机制）

- Controller 持续追踪"当前连续同方向 move 的计数"：`streak_orientation`（D 或 C）+ `streak_count`。
- 每次 Evaluation Agent 给出新的 move 分类结果：方向和 `streak_orientation` 一致 → `streak_count += 1`；不一致 → 切换方向、`streak_count` 重置为 1。
- **一旦 `streak_count >= 2`**：判定需要"强干预"——生成一条引导用户转向反方向的 guidance，**同时立刻把 `streak_count` 清零**。这个"清零"就是唯一的 cooldown 机制，没有独立的 cooldown 字段或计时器。
- **`streak_count < 2` 时完全静默**——没有"轻推"这个中间档，要么不说话，要么明确强干预。
- **streak 只统计内容型 move**：move_type 1(Generate)/3(Evaluate)/4(Adopt)/6(Reject)，**排除** 2(Ask)/5(AI Response) 这两类结构性 move。
- Low-TF 的"反向纠偏"逻辑用同一套机制：phase=collect 时连续 2 次 C → 强干预拉回 D；phase=synthesize 反之。
- High-TF / control 组：High-TF 全程用这套机制判断是否干预；control 组永远静默（但依然全程跑 Evaluation Agent 打标，只是不触发 Controller 干预）。

### 3.2 Group ID 数字映射

参与者在入口页输入数字 1-5，界面上不显示任何条件名称（双盲要求）：
`1=control, 2=HighTF_HighTM, 3=HighTF_LowTM, 4=LowTF_HighTM, 5=LowTF_LowTM`

### 3.3 move_ledger 字段设计

`move_ledger` 同时保留 `move_type`（1-6 的分类结果）和 `orientation`（D/C）两个独立字段，不是互相替代关系：
- `move_type`：来自 Evaluation Agent 的分类结果。
- `orientation`：**Phase 5 起改由 Decision Agent 的实时判断驱动**（不是 move_type 的机械映射），驱动 Controller 的 streak 计算。静态映射表（1/2/5→D，3/4/6→C）退化为一个参考基准，可以在分析阶段拿来和 Decision Agent 的实际判断做对比，不需要单独存一个字段，需要时基于 move_type 现算就行。

---

## 4. Phase 3：Real-time Event Timeline Builder

**目标**：新增服务 `eventTimelineBuilder.ts`，增量构建 `session_events` 表（表已建好，字段对齐离线版：`id, session_id, event_id, timestamp_start, timestamp_end, event_type, action_description, speech, user_message, ai_response, created_at`）。

**要移植的逻辑**（来自 `Pipeline Code` 仓库）：

1. **`behavior_narration.py` 的叙述规则**：把 `interaction_logs` 里的原始交互事件清洗、分组，生成人类可读的 `action_description`。分组优先级（原脚本的处理顺序）：打字 → 删除 → 复制粘贴进写作区 → 悬停查看 AI 回复 → 滚动 → 点击。**这个优先级顺序要保持一致，不要自己重新设计**，因为下游的 Evaluation Agent（finetuned 模型）是在这套叙述风格的文本上训练的。
2. **`design_move_separation.py` 的 smart-merge 逻辑**：
   - 语音转录（speech）如果完全落在某个 behavior 事件的时间窗口内，合并进那个 behavior 事件的 `speech` 字段；否则单独成一个 `user_speech` 事件。
   - chat 的 `user_message`/`ai_response` 各自成独立事件。
   - 所有事件按时间排序，编号 `event_id`。

**⚠️ 必须处理的坑：时间戳约定不一致**
- `speech_segments.timestamp_start/timestamp_end`：**绝对 epoch 毫秒**（Phase 2 的设计决定）。
- `interaction_logs.timestamp`：**相对会话开始的毫秒数**。
- `session_events` 建表时用的是哪种约定需要在实施时统一决定并全表保持一致（建议：全部转成绝对 epoch 毫秒，因为 `speech_segments` 已经是这个约定，转换 `interaction_logs` 只需要加上 `session.created_at`/`sessionStartTime` 即可；反过来转 `speech_segments` 则需要额外记录 `recordingStartTime` 的绝对时间戳做减法，麻烦一些）。不管选哪种，**合并 behavior/chat/speech 三类事件之前必须先归一化，否则排序和窗口匹配会全错**。

**验证方式**：这个模块建议做完之后拿一段真实录制的 session，实时构建出来的 `session_events` 和离线跑 `behavior_narration.py` + `design_move_separation.py` 的输出做逐行比对，确认叙述文本风格和事件切分基本一致。

**副作用**：这个 real-time timeline 建成后，实验结束不需要再额外跑离线脚本构建 event timeline 了。

**风险提示**（来自原始讨论）：real-time 叙述文本的风格必须贴近离线版模板的措辞，否则可能影响 Phase 4 finetuned 模型的判断质量（模型是在离线版风格的文本上训练的）。

---

## 5. Phase 4：接入真正的 Evaluation Agent

**替换对象**：`backend/src/agents/moveTypeEvaluator.ts`（当前是 Phase 1 的 gpt-4o-mini 粗分类 stub，文件头已经标注了会在这里被替换）。

**要照搬的逻辑**（来自 `use_finetuned_model_partition_final.ipynb` 的 `predict_design_moves_partitioned`）：

1. **Partition 切分**：在每个 `user_message` 处切一个 partition，一个 partition = "上一次 AI 回复 + 期间的行为/语音事件（来自 Phase 3 的 session_events）+ 这次新的用户提问"。这个 partition 边界天然对应每一轮聊天节奏，不需要额外设计切分规则。
2. **模型调用**：`EVAL_MODEL_ID` 已经就绪，存在 `backend/.env` 里：`ft:gpt-4o-mini-2024-07-18:personal:design-moves-tvt:Dj0Wo9or`。对每个 partition **一次性**调用这个 finetuned model，输出这个 partition 里完整的 move 列表（不是逐个事件单独调用）。
3. **校验 + 重试**：Ask（move_type 2）/AI_Response（move_type 5）这两类是确定性的（消息非空即存在，不需要模型判断），所以可以拿来校验模型输出的数量是否合理——如果模型输出的 Ask/AI_Response 数量和实际不符，重试 ≤3 次。
4. **超时/失败降级**：沿用 Phase 1 stub 的逻辑作为兜底（这部分代码不用大改，Phase 1 已经写好，只是作为 fallback 保留）。
5. **会话结束时的收尾**：额外评估最后一个还没被新 `user_message` 关闭的 partition（尾部数据不能丢）。
6. **写入**：结果写 `move_ledger`（`move_type` 字段）+ `agent_execution_log`（`agent_name: 'evaluation_agent'`）。

---

## 6. Phase 4/5：Decision Agent（D/C 判断）

### 6.7 Future evaluation-model ablation (recorded 2026-09-18)

Keep the current implementation path first: use the fine-tuned evaluation model for move types and the separate Decision Agent for D/C. In a later experiment, test a general-purpose model with the move-coding guidance supplied as a system prompt to determine whether it can directly produce both move type and D/C without fine-tuning. Evaluate coding agreement, Ask/AI_Response count reliability, latency, and cost before replacing the current path.

这是本项目里讨论最细的一块设计，请完整看完再动手，不要凭直觉简化。

### 6.1 动机

D/C（divergent/convergent）判断**不应该**是 move_type 的机械映射（1/2/5→D, 3/4/6→C 只是一个参考基准），而应该由一个独立的 Decision Agent，基于这个 move 的**实际内容**、结合此前的 move sequence，判断"这次新增的 move 相对于之前的想法，是在引申已有想法（convergent）还是提出新想法（divergent）"。

### 6.2 判断逻辑（优先级顺序）

1. **最高优先级：看内容本身**——如果这个 move 主要是对前面想法的引申/引用/检测/支持/反驳，判 convergent；如果主要是提出新想法，判 divergent。
2. **次要先验**：如果 move_type 是 Evaluate/Adopt/Reject，倾向于判 convergent（这三类大概率是在回顾之前的 move），但**不是硬编码规则**，只是模型判断时的先验倾向，最终还是要看内容。
3. **输入**：最新新增的 move + 目前已有的 move sequence（不断累加）。
4. 一旦某个 move 被打上 D/C 标签并加入 move sequence，Controller 才开始用它计算是否达到干预标准。

### 6.3 执行方式（最容易实现错的部分，务必仔细看）

**与 Evaluation Agent 并行调用，而不是串行等待**，避免两次模型调用叠加延迟：

- 每一轮触发 Evaluation Agent 的同时，一并触发 Decision Agent。
- **Decision Agent 读取的 move sequence，是"上一轮 Evaluation Agent 更新完之后"的状态**（截止到上一轮为止的 sequence + 上一轮已判定的 D/C），**而不是等本轮 Evaluation Agent 跑完再读**。
- 本轮 Decision Agent 的输出，**直接决定本轮新 move 的 D/C，供 Controller 立刻使用**。
- 本轮 Evaluation Agent 的输出（move_type 分类）**只用于把新 move 追加/更新进 move sequence，作为下一轮 Decision Agent 调用时的输入上下文**（这一轮本身不影响这一轮的 D/C 判断）。
- 效果：两个 agent 各自读到的"当前状态"总是相差一轮，但避免了同一轮内的串行依赖，不增加单轮响应延迟。用伪代码表示：

```
第 N 轮触发时（用户发送新消息）：
  parallel:
    A) EvaluationAgent(本轮 partition) → 得到本轮 move_type
       → 写入 move sequence，供第 N+1 轮 DecisionAgent 使用
    B) DecisionAgent(本轮新 move 的内容, 截止到第 N-1 轮为止已经打好 D/C 标签的 move sequence)
       → 得到本轮 move 的 D/C
       → Controller 立刻用这个 D/C 更新 streak
```

### 6.4 实施前必须确认的一件事

**Julia 会单独测试她的 finetuned 模型（`EVAL_MODEL_ID`）能否在给出 move_type 的同时直接输出 D/C。如果可以，上面这套"两个独立 agent 并行调用"的方案需要重新评估**（有可能可以合并进 Evaluation Agent 一次调用里，省掉一次单独的模型调用和延迟，整个 6.3 节的并行/错位读取逻辑就不需要了）。**实施 Decision Agent 之前，请先向 Julia 确认这项测试是否已经有结果**，不要默认按"两个独立 agent"的方案直接开始写，以免做了之后又要推倒重来。

### 6.5 数据库改动

`agent_execution_log.agent_name` 的 ENUM 需要新增 `decision_agent` 值（真正的 `ALTER TABLE` 迁移，Phase 1-3 都没有做这个，是 Phase 4/5 才需要的）。

### 6.6 调试面板已经预留好扩展点

`manipulationPipeline.ts` 的 `AgentStageEvent.agent` 联合类型、`frontend/src/components/DebugPanel.tsx` 的同名类型和 `AGENT_LABELS`，都已经加了 `decision_agent` 这个值（当前没有任何代码真正发出这个事件）。实施时只需要照抄 Evaluation Agent 那两行 `onStage?.({agent:'decision_agent', status:'started'/'completed', ...})` 调用加进 `runTurnPipeline` 的并行发起逻辑里，**调试面板不需要再改一行代码**就会自动显示 Decision Agent 的执行过程。

---

## 7. Phase 5：Controller 切换到真实数据源

- Controller 的 streak 计算逻辑本身不变（见第 3.1 节），只是数据来源从"静态映射"换成"Decision Agent 的实时输出"。
- 继续排除 Ask/AIResponse，只看内容型 move（1/3/4/6）。
- `move_ledger.orientation` 字段这时候就是 Decision Agent 写入的真实值，Controller 直接读这个字段做 streak 计算，不再需要在 Controller 内部做 move_type→orientation 的映射计算。

---

## 8. Phase 6：端到端联调

5 个条件（control / HighTF_HighTM / HighTF_LowTM / LowTF_HighTM / LowTF_LowTM）各跑一遍完整流程，检查：
- guidance 触发时机是否符合 streak>=2 的预期（可以用测试模式调试面板实时观察 Controller 的判断过程）。
- Low-TF 的锁定/解锁 UI 行为是否正确（5 分钟后出现 Next 按钮，15 分钟软提醒）。
- 全部相关表（`move_ledger`/`manipulation_state`/`agent_execution_log`/`session_events`/`speech_segments`）的数据完整性和正确性。
- 端到端响应延迟是否在可接受范围（尤其是 Evaluation Agent + Decision Agent 并行调用之后，单轮响应时间有没有明显变长）。

---

## 9. 已经建好、可以直接用的数据库 schema（不用重新设计）

```
sessions: id, participant_id, group_id, status, created_at, ...
manipulation_state: session_id (PK), tf_level, tm_level, is_control, phase, phase_advanced_at,
                     streak_orientation, streak_count, turn_count, updated_at
move_ledger: id, session_id, move_id, move_type (1-6), orientation, description,
             event_id_start, event_id_end, turn_index, created_at
agent_execution_log: id, session_id, turn_index, agent_name, step_order, input_payload,
                      output_payload, model_used, started_at, completed_at, duration_ms,
                      status, error_message, retry_count, created_at
speech_segments: id, session_id, timestamp_start (绝对 epoch ms), timestamp_end, transcription
session_events: id, session_id, event_id, timestamp_start, timestamp_end, event_type,
                action_description, speech, user_message, ai_response, created_at
                （Phase 3 之前这张表是空的，字段已经和离线版对齐）
```

---

## 10. Runtime Flow（完整流程，Phase 3-5 全部接入后的样子）

```
用户发消息（第 N 轮）
  │
  ▼
记录 messages(role=user, is_guidance=false)
  │
  ▼
[eventTimelineBuilder / Phase 3] 关闭上一个 partition：
  上次 ai_response 事件 + 期间 session_events + 这次新 user_message
  │
  ▼
并行触发：
  ├─ [moveTypeEvaluator / Phase 4] 调用 EVAL_MODEL_ID 预测本 partition 的 move 列表
  │    → 写 move_ledger(move_type)；写 agent_execution_log(evaluation_agent)
  │    → 更新 move sequence，供下一轮 Decision Agent 使用
  │
  └─ [Decision Agent / Phase 4] 判断本轮新 move 的 D/C
       （读取截止到上一轮为止已经标好 D/C 的 move sequence）
       → 写 move_ledger(orientation)；写 agent_execution_log(decision_agent)
       → Controller 立刻可用
  │
  ▼
[manipulationController / Phase 5] 用 Decision Agent 刚给出的 D/C 更新 streak：
  更新 streak_orientation/streak_count（只看内容型 move，排除 Ask/AIResponse）
  High-TF: streak_count>=2 → 强干预+清零；否则静默
  Low-TF: phase 由前端 Next 驱动；偏离 phase 目标方向 streak>=2 → 强干预+清零；否则静默
  Control: 永远静默
  → 更新 manipulation_state；写 agent_execution_log(manipulation_controller)
  │
  ▼
若有 guidance → 存 messages(role=user, is_guidance=true) → SSE 先推给前端（淡蓝气泡+💡）
  │
  ▼
[Main Response Agent] 用含 guidance 的历史消息生成回复 → 写 agent_execution_log(main_response_agent)
  │
  ▼
记录 assistant 回复 (messages 表)，作为下一轮 partition 起点
```

---

## 11. 验证标准（每个 Phase 完成后都要做）

- backend、frontend 分别跑 `npx tsc --noEmit`，必须无报错。
- frontend 额外跑一次 `CI=true npm run build`，确认没有新增的 ESLint 报错（目前唯一已知的、和历史改动无关的既有警告在 `useInteractionLogger.ts`，3 条，不需要顺手修掉）。
- 有条件的话，建议用 `test` 开头的 userId 跑一次真实的对话流程，打开调试面板，肉眼确认每个 agent 的 started/completed 事件、返回内容是否符合预期，而不是只看编译通过。
- Phase 3 完成后，建议额外做一次和离线 pipeline 输出的比对验证（见第 4 节）。

---

## 12. Current testing observations (recorded 2026-10-03)

### 12.1 Practice versus Actual session behaviour

- Practice sessions are deliberately created without `groupId`, so there is no `manipulation_state` row.
- `runTurnPipeline()` therefore returns immediately for practice sessions: Evaluation Agent, Decision Agent, and Manipulation Controller do not run. A test-prefixed practice session can still show Main Response Agent stage events because the ordinary chat response continues to stream.
- To test the multi-agent flow, use a `test...` participant ID, progress to the **Actual** task, enter a valid group code (`1` to `5`), and send a message there.

### 12.2 Agent initiation and observability

- On every Actual-session Send, after the user message is saved, `/api/chat/stream` calls `runTurnPipeline()` before the main response is generated.
- The pipeline rebuilds the timeline and starts Evaluation Agent (`EVAL_MODEL_ID`) and Decision Agent (`DECISION_MODEL`, default `gpt-4o-mini`) concurrently. It then persists the move ledger, runs the deterministic Controller, and finally starts Main Response Agent.
- All four execution records are written to `agent_execution_log`; move types and the Decision Agent's D/C classification are written to `move_ledger`.
- Known debug-panel observability gap: the current frontend `DebugPanel` type/label map does not yet include `decision_agent`, and the panel shows agent stages but not the Controller's current D/C streak count. This does not prevent backend execution or database logging, but it makes manual testing less transparent. Treat it as a future debug-UI improvement.

### 12.3 Deferred issue: transcript after browser refresh

- Observed behaviour: refreshing an active task page stops the live WebRTC transcription connection; the user needs to start recording again.
- The session/timer state can be restored, but the active live-transcription connection is not resumable across a browser refresh.
- This is recorded for future work only. Do not change the current transcription behaviour as part of the manipulation-system work.

---

*本文档基于 `PAPER2_MANIPULATION_PLAN.md` v22（2026-09-18）整理，所有设计结论的完整讨论过程和历史背景都能在那份文档里找到。如果实施过程中发现这份交接文档和 `PAPER2_MANIPULATION_PLAN.md` 有冲突，以后者的最新版本为准，并请更新回这份文档。*
