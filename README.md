# 只只 · zhizhi

> 一个让电脑「活起来」的系统生命体征助手。

它看着这台机器：谁在吃内存、CPU 为什么高、有没有人偷偷加了自启项。
它不只报警 —— 它会说话，有自己的语气（有人味，还会吐槽你），
而且知道**什么时候该闭嘴**。

**当前状态**：🟢 **M0–M3 + M5 + M6 + M7 已完成（7/11，均已监工复验）** —— 内核可独立跑 · 台词可改可换 · **最小可用只只**（浮窗自己养着内核，M4-a ✅）· **只只会主动闲聊**（空闲够久就开口，跟告警完全两套旋钮，M6 ✅）· **状态区上线**（「在干什么」＋「说的话」分两区，M4-c ✅）· 🆕 **只只有记忆了**（说过的话跨重启不重复、台词能说「都第 N 次了」、亲密度 trust 落盘驱动闲聊档位 —— M7 ✅）· 🟡 M4-b 整容搁置

---

## 这是什么

| | |
|---|---|
| 形态 | 常驻桌面小浮窗（类输入法候选框）+ 托盘 |
| 定位 | 系统监控 · 安全哨兵 · 有性格的表达 |
| 面向谁 | 先自己用，然后开源给「想改它」的人 |
| 技术栈 | Node + TypeScript（内核）→ Tauri 或 Electron（外壳，M4 才定） |

## 三个设计坚持

1. **内核稳定 + 一切「扩展点」皆插件** —— 不是"一切皆插件"。内核 7 样绝不外放：
   事件总线 · 调度器 · 状态存储 · 分通道规则 · **沉默机制** · 权限裁决 · 插件加载器
2. **先内核，后外壳** —— 浮窗是"脸"，逻辑是"脑"。**先养脑，再整容。**
3. **不做自动修复** —— 只解释和建议；不杀进程、不删文件

## 现在做到哪了

见 **[docs/只只-开发进度报表.md](docs/只只-开发进度报表.md)** —— **唯一的进度事实源**。

```
M0   M1   M2   |  M3   M4   |  M5   M6   M7   M8   |  M9   M10
✅   ✅   ✅   |  ✅   🟡   |  ✅   ✅   ✅   ⬜   |  ⬜    ⬜
                              ▲ 当前位置（M7 记忆+亲密度 ✅；M4-b 整容搁置）
└─ 内核阶段 ─┘   └─ 外观 ─┘   └──── 性格阶段 ────┘   └─ 收尾 ─┘
   纯 Node / 零安装 / 不需要 Rust        ★ 这一层才是只只
```

## 文档

| 文档 | 内容 |
|---|---|
| [开发进度报表](docs/只只-开发进度报表.md) | ⭐ 进度 / 里程碑 / 下一步 / 已锁定决策 |
| [环境基线](docs/只只-环境基线.md) | ⭐ **动手前必读**：实测版本 / Node 能力清单 / 踩坑，附复核命令 |
| [架构设计与开发计划](docs/只只-架构设计与开发计划.md) | 内核 7 样、6 类扩展点、仓库结构、安全模型、里程碑 |
| [技术方案与开源参考](docs/只只-技术方案与开源参考.md) | 浮窗技术点（`WS_EX_NOACTIVATE` 等）、GitHub 三层参考 |
| [产品方案 · 系统生命体征助手](docs/让电脑活起来-系统生命体征助手方案.md) | 四层架构、四道闸门、安全哨兵、"活"的三个来源 |
| [互动与情绪价值评估](docs/电脑活起来-互动与情绪价值功能评估.md) | 反馈闭环、亲密度 trust、摸摸、Toast 署名坑 ⚠️ 其「反馈闭环」设计已被 2026-10-15 决策简化（不再是独立功能） |

## 快速开始

```bash
pnpm install     # 唯一的前置：装 TypeScript（运行时零依赖，纯 Node 原生）

pnpm start       # 常驻：每 5 秒打印一行指标 JSON
pnpm once        # 只跑 3 轮就退出（验收 / 脚本用）
pnpm typecheck   # 全量类型检查
```

想看得更细：`node packages/cli/src/main.ts --interval=1000 --ticks=5 --verbose`

**两条通道有明确分工**（M4 的外壳会依赖这个约定）：

| 通道 | 内容 |
|---|---|
| stdout | **数据** —— 一行指标 JSON，给外壳 / 管道消费 |
| stderr | **日志** —— 带 `[模块]` 前缀，给人看 |

`packages/core` 零 UI 依赖、零外部依赖 —— 它今天被 `cli` 消费，将来被 `app` 消费，内核一行不改。

## 改台词（M5）

只只的台词**不在代码里**，在 `packages/plugins/persona-zhi/persona.json`：

```json
"mem.high": [
  "内存 {value}% 了，要我帮你数数标签页吗？",
  "内存吃到 {value}% —— 再开下去我就得开始删东西了。（开玩笑的，我不删。）"
]
```

改一句话 → **重启就生效**（不用改代码、不用重新 build）。
`{value}` / `{summary}` / `{drive}` / `{key}` 这些占位符会被真实数值替换；写错的占位符会**原样留着**，一眼就能看出打错。

想**整体换一套**？把 `packages/cli/src/plugins.ts` 里那一行换成一个 JSON 文件的路径即可 —— 纯数据、没有代码：

```ts
{ specifier: 'D:\\my-persona.json', type: 'persona' },
```

> 把台词包**整个删掉**也没关系：只只会改用「事件的客观描述」说话（**降级，不是故障**）。

## 最小可用只只（浮窗）

**一个窗口，自己养着一个内核。** 它会把内核当 sidecar 拉起来、**长连接读它的 stdout**，
所以 CPU / 内存是**实时刷新**的（不用你另外开终端跑 `pnpm start`）；
它还抽干内核的 stderr —— 于是**只只说的话会显示在窗口上**。

```powershell
powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1                  # 右下角
powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Position TopCenter
# 想快点看到它开口（默认要「连续超标 2 分钟」才说）：
powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -Interval 1000 -SustainMs 3000 -CooldownMs 5000
powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -SelfTest        # 自检（含流式读内核），不弹窗
powershell -ExecutionPolicy Bypass -File tools\float-preview.ps1 -RenderCheck     # 渲染回归：真开窗、数「红叉」
```

窗口上有什么：状态行（位置 · node · **已看 N 轮**）· CPU · MEM · **只只说的话** · 说说/安静/位置/设置 · ✕

点「**设置**」可**原地展开**基础设置：**尺寸**（小/中/大）· **透明**（细/中/实）· **置顶**（开/关）· **记住位置**（开/关）。
改完**立即生效**，自动存到 `tools/float-preview.settings.json`（已 gitignore），下次打开自动生效。

点浮窗里的按钮，再切到编辑器按 `Ctrl+V` —— **能粘贴 = 没抢焦点**（`WS_EX_NOACTIVATE` 生效）。

## 闲聊（M6）：它不只会告警，还会陪你说两句

你**不动鼠标键盘**够久（默认 10 分钟），只只会自己开个话题 —— 「歇着呢？我在。有事儿叫我。」
想快点点到它，往 `data/zhizhi.settings.json` 里写（没有就建这个文件）：

```json
{ "chitchatIdleMs": 60000, "chitchatIntervalMs": 120000 }
```

重启浮窗 → 闲 1 分钟它就开口，两次闲聊最少隔 2 分钟。**这些旋钮与告警完全无关** ——
调闲聊永远不会让告警变多或变少（告警有自己的 `--sustain-ms` / `--cooldown-ms`）。

台词分三层，**优先级 `data/user.json`（你手写）> 内置包 > `data/learned.json`（模型补）**：

```json
// data/user.json —— 你手写的台词（优先级最高）
{ "id": "persona-user", "lines": { "chitchat": ["你半天没动了，喝茶去。"] } }
```

删掉 `learned.json` 里的某一行，那句话就再也不出现 —— **记事本就是反馈入口**。
（模型补台词是 M6 加餐，还没接；`learned.json` 的位置和格式现在就留好了。）

> 📌 它还不是最终外壳（M4-b 搁置）：没有托盘、没有开机自启、长得还是 WinForms 那副样子。
> 但**数据接线**（M4-a）已经打通 —— 换成 Tauri / Electron 时这条路一样成立。

> ⚠️ 改这个 `.ps1` 时注意：**必须存成 UTF-8 带 BOM**，否则 PS 5.1 按 GBK 读、中文全乱码（详见《环境基线》第六节）。

> ⚠️ **关闭请点浮窗右上角的 ✕**（它会顺带把内核子进程收掉）。
> **不要在这个控制台里按 `Ctrl+C`** —— 那会停止 PowerShell 管道，之后浮窗点任何按钮都会报
> `PipelineStoppedException`（实测踩过）。真出问题时异常会写进 `tools/float-preview.log`，
> 不会再弹致命对话框、也不会卡死。
