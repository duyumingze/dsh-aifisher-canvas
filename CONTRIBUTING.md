# 贡献指南

先说清楚许可证：本项目基于上游 AIFISHER 源码构建，采用 **AIFISHER Noncommercial Source License 1.0**
（见 [LICENSE](LICENSE)）——可以学习、修改、非商业使用与再分发，**不能商用**。提交 PR 即表示你同意
自己的贡献以同一许可证发布。

---

## 1. 环境

| 需要 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.19 | 插件本身与构建脚本都跑在 Node 上 |
| pnpm | 11（见 `package.json` 的 `packageManager`） | 仓库是 pnpm workspace 布局 |
| DeepSeek Harness | ≥ 0.1.0-rc.7 | 桌面版或 Web 版都行；只构建不运行可以不装 |
| ComfyUI | 可选 | 只有跑本地生成才需要（默认 `http://127.0.0.1:8188`） |

```bash
pnpm install
```

> Windows 上如果用 pnpm 的默认布局遇到「找不到兄弟包」的怪报错，先确认
> `pnpm install --config.node-linker=hoisted --config.enableGlobalVirtualStore=false`
> 是不是 tooling 需要的布局（`tools/contact-sheet` 就需要，见它自己的 README）。

---

## 2. 构建

```bash
# 完整构建：clean → vendor（从上游源码树重新复制并打补丁）→ css → tsdown
AIFISHER_SRC=/path/to/AIFISHER-main pnpm build      # Windows: $env:AIFISHER_SRC = 'D:\path\to\AIFISHER-main'
```

- `vendor/aifisher/` 是**构建产物**，每次 `pnpm vendor` 会整个重建；补丁写在
  `scripts/patches/aifisher/**`（整文件覆盖），改 vendor 里的文件不会活过一次构建。
- **没有上游源码树时**（只改了本仓库的 host/client 代码）：

  ```bash
  pnpm build:offline     # 跳过 vendor 步骤，直接用仓库里已提交的 vendor/ 构建
  ```

  这就是 CI 用的路径，也是贡献者最常用的路径。

产物（DSH 实际加载的就是这三个）：

| 文件 | 用途 |
|---|---|
| `lib/index.js` | host 半：工具、路由、ComfyUI、生成 |
| `lib/client/apply.js` | client 半：面板与槽位注册（`window.__ModuleLoader__` 形态） |
| `lib/canvas/canvas-app.js` | 画布应用本体（浏览器 ESM，自带 React 19） |

装进 DSH：**设置 → 插件 → 添加插件**，填仓库绝对路径，重启 DSH（host 半进程内加载，刷新页面不生效）。

---

## 3. 三条纪律

### 3.1 不手改 `vendor/`

所有对上游的改动都进 `scripts/patches/aifisher/**`（整文件覆盖），并且**每条补丁都带命中次数断言**：
上游改了写法，构建会直接报「命中 0 次」而不是静默失效。加补丁时请顺手加断言。

### 3.2 契约三处同步

`canvas_control` 的可见面有三份，改一处就要改另外两处：

1. `src/host/index.ts` —— 工具 `description` 与 `action` 枚举；
2. `docs/canvas-agent-contract.md` —— 给外部 Agent 与人看的完整契约；
3. `README.md` / `CHANGELOG.md` —— 对外说明与版本记录。

跑 `pnpm check:contract` 会机器对账：枚举里的动作必须在契约里出现、契约里提到的动作必须能在
枚举或逃生舱白名单里找到、描述长度 ≤ 3000 字符、README 版本号与 `package.json` 一致。

> 为什么盯描述长度：`canvas_control` 是全局工具，描述会注入**每一个** DSH 会话。v1.70 把它从
> 7,657 字符压到 2,710 字符，省下的是每个会话的固定开销。要加细节，请加到契约文档里。

### 3.3 审批红线

生成（花钱）只能由**用户在画布 UI 上按确认**：

- `canvas_control` 只有 `prepareGeneration`，没有 `approve`、没有「自动生成开关」；
- `action:"command"` 的逃生舱白名单同样拒绝 `runGeneration` / `prepareBudget` / `revokeBudget`；
- 不要把「Agent 跑不通生成」当缺陷去修。设计见 `docs/canvas-agent-contract.md` §4。

---

## 4. 测试

```bash
pnpm check:contract          # 机器对账（秒级，不需要构建）
pnpm typecheck               # src 零错误；vendor 是上游源码，不进门禁
pnpm build:offline           # 需要产物才能跑的测试，先建一次
node scripts/test-canvas-agent-tools.mjs   # 单套
pnpm test                    # 全量：约 50 套 / 2600+ 项，5~10 分钟
```

判绿只认每套末尾的 `SUMMARY pass=N fail=0`（退出码同时为准）。

真机校验（要开着 DSH，脚本自带浏览器）：

```bash
# PowerShell
$env:DSH_WEB_URL = 'http://127.0.0.1:<GUI 端口>'
node scripts/verify-live-canvas-bundle.mjs
```

**CI 覆盖什么**：类型门禁、契约对账、离线构建、产物契约、4 套核心回归（见
`.github/workflows/ci.yml`）。它**不跑**完整回归与浏览器校验——那两条依赖上游源码树、ffmpeg 和
真实页面，请在本地跑过再提 PR。

---

## 5. 提 PR

1. 一个 PR 只做一件事；界面截图前后对比（如果改了画布 UI）。
2. 必须跑过：`pnpm check:contract` + `pnpm typecheck` + 你改动对应的单套回归。
3. 改了 `canvas_control` 的表面（动作/参数/错误码）→ 必须同时更新契约文档与 `CHANGELOG.md`。
4. 改了 vendor 补丁 → 说明「为什么不能在本仓库里解决」。
5. 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 前缀，版本相关的写进 `CHANGELOG.md`。

## 6. 发版

1. 改 `package.json` 的 `version`（`vendor/package.json` 的版本号由构建自动对齐）。
2. 在 `CHANGELOG.md` 顶部加一节（对外可见的行为变化 + 踩过的坑）。
3. `pnpm build`（有上游源码时）或 `pnpm build:offline` → 跑全量 `pnpm test`。
4. 提交并推送；把 `lib/` 同步到实际安装目录（如果用 junction 安装就同步到那个目录）。

---

## 7. AI 协作与署名

这个仓库大量由 DSH 原生 Agent 参与编写。想把 AI 记进提交历史，用 Git 的 co-author trailer，
放在提交信息**末尾**、与正文空一行、一人一行：

```
feat: 画布调色面板支持拖拽压线插入

Co-authored-by: DeepSeek Harness Agent <agent@localhost>
```

约定：

- **只在真有 AI 参与的提交上加**。署名是事实声明，不是装饰；没参与就不写。
- **占位邮箱**用 `agent@localhost` 这类不存在的地址即可。不要填任何人的真实邮箱，
  也不要用别人的账号邮箱冒充。
- 没有绑定 GitHub 账号时，GitHub 会在提交页显示**名字 + 默认头像**，该提交**不计入**
  仓库的 Contributors 人数图（贡献图只认已与账号关联的邮箱）。这是署名，不是协作者权限。
- GitHub 的 Collaborator 必须是账号；AI 没有账号，**不要**为它开一个账号再加权限。
- 已经推送的提交**不要改写作者**（改作者等于改 commit hash）；要补署名就补在下一个提交里。
- 不想动提交历史时，也可以在 `README.md` 的致谢里写一行，效果一样是“公开署名”。

