# 10/23 Pilot Study：AI Guidance 与任务介绍优化计划

## 目标

根据 pilot study 的观察，降低 AI guidance 的阅读负担，建立参与者对两类 guidance 的正确预期，并让参与者在开始任务前理解最终方案将同时从 **usefulness** 和 **creativity** 两方面评判。

本轮修改不改变实验的触发规则、D/C 条件分配、High/Low manipulation，或已有的 guidance 后两个 content move 不计入 streak 的规则。60 秒 notification 间隔仍保留。

## Pilot study 发现与对应修改

| 发现 | 修改 |
| --- | --- |
| Guidance 卡片文字多，阅读成本高。 | 收紧 participant-facing 文案，尤其是 direction guidance；主 AI response 保持完成当前设计任务所需的信息，但避免重复背景、长前言和泛泛鼓励。 |
| 参与者不清楚 guidance 三部分各自的含义。 | 在实验前 instruction 明确说明三段结构、用途与阅读顺序；卡片维持简洁，只修改有歧义的 `Previous ideas` 名称。 |
| `Previous ideas` 被理解为其他参与者的想法。 | 改名为 **Your earlier ideas**，并在介绍中明确其只总结当前参与者先前说过、写过或讨论过的设计想法。 |
| 突然收到与当前方向不同的建议时，参与者认为 guidance 很奇怪或无关。 | 在 instruction 中预先解释两种 guidance 方式：deviation 用于扩展广度，synthesis 用于整合深度；两者都是预期内的帮助。 |
| 顶部横条 notification 容易被忽略。 | 保留为后续迭代候选项；当前不改 notification，以免需要重制 demo video。 |
| 参与者不知道 AI guidance、普通 Main Response AI 和最终评价之间的关系。 | 在任务介绍中明确区分两种 AI 输出，说明最终 proposal 以 usefulness 与 creativity 评判，并说明 AI guidance 的建议旨在支持创造性设计思考。 |

## 1. 实验前介绍：PPT 完整版本与 Welcome 简洁版本

实验 instruction PPT 承担完整解释；Welcome 页面只保留完成任务所需的短提示。两者不应逐字重复。

### 1.1 实验 instruction PPT：可直接粘贴的英文文本

以下内容供实验 instruction PPT 使用。可按 slide 分段，但不需要在 Welcome 页面完整展示。

#### Your goal

> Your task is to develop a product design proposal that is useful and creative. Continue to think aloud as you explore and develop your ideas.

#### How your final proposal will be evaluated

> Your final proposal will be evaluated for both:
>
> - **Usefulness:** how well the design addresses meaningful user needs and could provide practical value.
> - **Creativity:** how original, thoughtful, and well-developed the design ideas are.

#### Working with the AI chatbot

> You can discuss your ideas with the AI chatbot throughout the task. It responds when you ask it questions.

#### About AI guidance

> The chat assistant responds when you ask it questions. Separately, AI guidance may occasionally appear automatically in the conversation. It is generated to support your design thinking and creativity; use it as a resource alongside your own judgment and ideas.

#### Why AI guidance may take different directions

> AI guidance is informed by creativity research and can support your thinking in two ways. Sometimes it may invite you to explore a direction that differs from your current idea (**deviation**), which can help you consider distinct possibilities in breadth. At other times it may help you connect compatible parts of your earlier ideas (**synthesis**), which can help you develop an idea with greater depth. Both kinds of guidance are expected.

#### How to read an AI guidance card

> Each AI guidance card has three parts: a short direction based on the ideas you have just shared, a reminder of your earlier ideas, and a detailed AI response. “Your earlier ideas” refers only to ideas from your own conversation and writing in this task.

> A five-second countdown notification will appear before an AI guidance card and its AI response are added automatically to the conversation.

PPT 中不说明 D/C、High/Low、streak、trigger、evaluator 或任何内部实验机制。这里的 deviation 是预期中的探索提示，不是系统认为参与者的当前想法有问题。

### 1.2 Welcome 页面：简洁版本

Welcome 页面不完整解释评价标准、三段卡片结构或两种 AI 输出的机制。保留以下短提示即可。

将现有 `AI Assistant` 项改为：

> **AI Assistant:** You can discuss your ideas with the AI chatbot. It will respond to the questions you ask.

将现有绿色 AI guidance 提示改为：

> **AI guidance may occasionally appear automatically in the chat.** It generates guidance based on creativity research theory and may invite you to explore a different direction or combine compatible ideas. A five-second countdown will appear before the guidance and its AI response are added to the conversation.

正式任务和 practice Welcome 都采用这个短版本；task goal 中已有的 `helpful and creative` 表述保留即可。

## 2. AI guidance 卡片内容与视觉结构

### 2.1 固定四种 direction guidance

不再让 guidance-generation LLM 生成 participant-facing direction。每个实验 condition 使用固定的一句话 direction；它们直接用第二人称，明确建立在参与者刚刚分享的想法上，并保留该条件的核心 manipulation。这样可消除方向文字的无谓波动，缩短卡片，也让 LLM 专注于提取关键词。

| Condition | 固定 participant-facing direction guidance |
| --- | --- |
| High-D | `Building on the {contextIdeaCount} {ideaLabel} you just shared, please consider exploring 6 clearly different directions that rethink key aspects of your design.` |
| Low-D | `Building on the {contextIdeaCount} {ideaLabel} you just shared, please consider exploring 2 variations that keep the core direction while changing one small element.` |
| High-C | `Building on the {contextIdeaCount} {ideaLabel} you just shared, please consider integrating the distinct roles represented across these ideas into one coherent design, including how its key connections and trade-offs work.` |
| Low-C | `Building on the {contextIdeaCount} {ideaLabel} you just shared, please consider making one small connection between two of these ideas to refine your current direction.` |

`contextIdeaCount` 由程序从本次 guidance context 所选的 eligible content moves 得到；`ideaLabel` 在数量为 1 时为 `idea`，其他数量为 `ideas`。因此 participant 会看到自然的 `the 1 idea` 或 `the 3 ideas`，而不是内部 move、event 或 model 术语。

措辞选择依据：

- `6`、`clearly different` 保留 High-D 的广度和数量要求；
- `2`、`one small element` 保留 Low-D 的邻近变化要求；
- `distinct roles represented across these ideas`、`key connections and trade-offs` 要求 High-C 整合多个 ideas；
- `one small connection between two of these ideas` 要求 Low-C 只以两个 selected moves 作小范围组合与既有方向的 refinement。

固定 direction 不应直接提及「Divergent」「Convergent」「High」「Low」、实验、模型或触发机制。

建议卡片结构保持紧凑：

```text
Building on the 2 ideas you just shared, please consider …

[Your earlier ideas: educational toy for girls aged 5–10; role-play learning]

[具体 AI response]
```

### 2.2 将 guidance-generation LLM 收窄为关键词提取

把现有 structured guidance contract 改为：后端根据 condition 直接赋予固定 `directionGuidance`；guidance-generation LLM 仅从 selected moves 与近期 writing context 中提取 `previousIdeas`。

- LLM 输出 contract 只保留 `previousIdeas`；
- `Your earlier ideas` 继续显示为弱化、小字体的关键词行；
- 将现有 `[Previous ideas: ...]` 改为 `[Your earlier ideas: ...]`，不再使用 `Previous user` 或单独的 `Previous ideas`；
- 保留已有关键词过滤要求：不能输出 `user`、`ask`、`AI response`、行为描述或完整原始句子；
- 关键词提取失败时使用安全的短占位摘要；固定 direction 不因 LLM 失败而改变。

三段含义主要由实验前 instruction 说明。卡片本身不新增 `Guidance focus`、`AI response` 等段落标签，以避免增加视觉文字；只有 `Your earlier ideas` 保持弱化标签，用于消除来源歧义。

### 2.3 压缩具体 AI response 的输出风格

更新 Main Response Agent 对 direct-guidance response 的指令，要求：

- 直接开始给出设计内容，不重复解释 guidance、历史对话或用户任务；
- 优先使用短段落或短列表；
- 删除泛化的开场、重复的总结和不必要的 follow-up questions；
- 当 High-D 必须给出多个方向时，每个方向用短标题加 1–2 句，而不是每项长篇解释；
- 当 C guidance 要求整合时，给出一个清楚的合并概念与简短场景/取舍，而不是反复复述被整合的 ideas。

在传给 Main Response Agent 的内部 prompt 中加入不可见的输出要求：`Keep the output concise and coherent.`；High-D 另加 `Stay within 160 English words.`，其他条件另加 `Stay within 110 English words.`。同时保留 `Start directly with the requested design content. Do not add a preamble, repeat the guidance, or end with a follow-up question.` 这些句子不显示在 participant-facing direction 中。

direct-guidance Main Response 的当前长度预算为：High-D 160 英文词；High-C、Low-D、Low-C 均为 110 英文词。最终长度应在不损害各条件操纵强度的前提下确定。

### 2.4 保持审计内容完整

参与者卡片可精简，但 `messages`、`interaction_logs`、`evaluation_agent_audit` 与 `agent_execution_log` 中仍保留完整结构化 direction、previous ideas、response、模型输入和显示时间，保证后续研究审计与分析不丢信息。

## 3. AI guidance notification

### 3.1 当前范围：保留现有 notification

当前继续使用 chat 区顶部的 5 秒倒计时 notification，不改变视觉位置、交互或 demo video。此轮只更新 instruction 与 guidance card 内容。

居中 modal 仍记录为后续可能的改进：若再次 pilot 显示顶部 notification 容易被忽略，可评估使用居中、带半透明 backdrop 的 5→1 倒计时 modal；届时需要重录或更新 demo video，并重新检查它是否遮挡 timer、writing area 或关键控件。

### 3.2 保留 60 秒频率限制

notification 前继续检查上一次实际 notification 的时间。60 秒内即使 evaluator 与 controller 正常运行、生成 guidance，也不向参与者显示新 notification 或卡片。Debug / audit 需要明确记录该 guidance 被 notification cooldown 抑制，便于区分「没有触发」与「已触发但未显示」。

## 4. 修改位置

| 位置 | 需要修改 |
| --- | --- |
| 实验 instruction PPT（待定位源文件） | 加入最终评价、两类 AI 输出、deviation/synthesis、三段卡片结构和创造力研究依据。 |
| `frontend/src/components/WelcomeActual.tsx` | 使用第 1.2 节的简洁 chatbot 与 AI guidance 提示，不复制 PPT 的完整说明。 |
| `frontend/src/components/WelcomePractice.tsx` | 使用同一简洁版本，帮助参与者在 practice 熟悉 chatbot、guidance 和 notification。 |
| `frontend/src/components/ChatInterface.tsx` | 保持 notification 位置不变；将弱化关键词行改名为 `Your earlier ideas`，保留恢复与自动插入逻辑。 |
| `backend/src/agents/manipulationController.ts` | 用 condition-to-template 映射固定可见 `directionGuidance`；将 LLM 输出收窄为关键词；更新 `promptForResponse`，加入不可见的简洁输出约束，同时保留条件操纵。 |
| `backend/src/routes/chat.ts` | 若需要，传递 guidance 类型/卡片 display metadata，并记录 cooldown 抑制状态。 |
| `AI_GUIDANCE_DIRECT_INSERTION_PLAN.md` | 更新 direction guidance、关键词提取与 `Your earlier ideas` 的设计决定；notification modal 仅作为后续候选项记录。 |

## 5. 交付前验证

1. 检查 PPT 使用完整文本、正式与 practice Welcome 使用简洁文本；三者的含义一致，且没有泄露 D/C、High/Low、streak、evaluator 等内部实验机制。
2. 以一个 deviation guidance 和一个 synthesis guidance 各走一遍：现有倒计时、三段内容、自动滚动和 history refresh 都正确。
3. 检查 `Your earlier ideas` 只包含当前参与者的简短主题词，不出现 `user`、`ask`、`AI response` 或完整行为描述。
4. 对四个 manipulation condition 各生成至少一张卡片，确认精简文案没有改变数量、差异度、整合范围或整合深度。
5. 触发两次相隔少于 60 秒的 guidance：第二次保留 evaluator/controller audit，但不显示 modal 或 card；相隔超过 60 秒时可正常显示。
6. 用 mobile 和 desktop 宽度检查更名后的关键词行和精简内容都可阅读。

## 未决事项

- instruction PPT 的源文件尚未出现在当前 repository；实施前需要确认其存放位置或由谁更新。
- 需要在 pilot transcript 上共同确认 direct-guidance AI response 的最终长度上限，尤其是 High-D 条件中「足够多样」与「足够简洁」之间的平衡。
- 决定参与者是否在 UI 中直接看到 `Deviation` / `Synthesis` 两个词，还是只在实验前说明中使用。建议：在 instruction 中保留术语并解释，具体卡片只显示自然语言的 direction sentence，避免把实验标签放进每次 interaction。
