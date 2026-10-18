# desktop-probe — 在 CLI 里复现「桌面 profile」启动

DSH 的 `desktop` profile 只允许 Electron 应用启动（`dsh --profile desktop` 会直接报
`profile "desktop" is managed exclusively by the Electron application`），但桌面版的很多行为
只在 `profileContext.name === 'desktop'` 时才生效（例如 `@deepseek-ai/dsh-base` 里
`deepseek-account-platform` 的 `desktopPlatform` 配置）。要验证「插件会不会把桌面版启动搞崩」，
就得让 profile 目录名仍然是 `desktop`、运行时仍然是 app.asar 里的那一套。

本目录的三个脚本就是干这个的：把 `@deepseek-ai/dsh-desktop-host` 的入口从 app.asar 里抠出来，
换一个端口、换一个 `DSH_HOME`，用 Electron 的 node 模式跑起来。

## 为什么不能直接跑 `dsh web`

- CLI 拒绝 `desktop` 这个名字；
- CLI 用的是外部安装的 dsh（`~/.dsh/dsh-browser`），里面没有桌面版专有的
  `dsh-deepseek-account-platform` 等包，账号 RPC 路由根本不会出现，测不出真问题。

## 用法

```powershell
$node   = 'D:\Program Files\DSH\DeepSeek Harness.exe'      # 桌面版自身，node 模式
$asar   = 'D:\Program Files\DSH\resources\app.asar'
$probe  = 'C:\Users\<你>\.dsh-desktop-probe'                 # 独立 DSH_HOME，别用真身

# 1) 抠出 host 入口并改端口（源码里写死 19387，会和正在运行的桌面版撞车）
node scripts/desktop-probe/extract-asar.mjs $asar 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' .\host-probe.mjs
(Get-Content -Raw .\host-probe.mjs).Replace('"19387"','"3096"') | Set-Content -NoNewline .\host-probe.mjs

# 2) 造一个同名 profile：目录必须叫 desktop，node_modules 用 junction 指向真 profile
#    （package.json / cordis.patch.yml / pnpm-*.yaml 复制真身；dsh-runtimes 也要 junction，
#      否则 office 插件会试图重装 primary runtime）
# 3) 启动（注意 DSH_HOME 指向 probe home，别污染真身）
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $probe
& $node --expose-internals --import ./scripts/desktop-probe/register-hooks.mjs .\host-probe.mjs `
    "$asar\dsh" "$probe\profiles\desktop" `
    'D:\Program Files\DSH\resources\runtime\primary-runtime' `
    'D:\Program Files\DSH\resources\runtime\pnpm\bin\pnpm.mjs' `
    'D:\Program Files\DSH\resources\runtime\bin'
```

`register-hooks.mjs` + `runtime-fallback-hooks.mjs` 负责让抠出来的入口能 import 到 app.asar 里的
`node_modules`：先按正常规则解析，失败才回退到运行时的 node_modules。
（**不要**无条件改写 parentURL —— 那样连 profile 里的第三方 bundle 名都会被解析到运行时里，误报
`failed to import`。）

## 探测欢迎流程

桌面版外壳启动时会对刚起来的 host 依次请求（`app.asar/lib/main.js` 的 `connectDesktopWelcome`）：

1. `POST /api/settings/describe`
2. `POST /api/llm/listConfigurableProviders`
3. `POST /api/credentials/describe`
4. `POST /api/account/getState` ← 任何一步非 2xx，外壳就报
   `desktop welcome: Web request failed` → 「应用无法启动」对话框

第 4 步的 `account` 命名空间由 `@deepseek-ai/dsh-api-account-controller`（web-app bundle）注册，
**插件若用 `/api/account` 前缀抢路由，这一步就会 404，桌面版直接起不来**。排查时先打这四个
RPC，再看自己插件的路由前缀。

## 收尾

- 关掉 probe 进程，删掉 `host-probe.mjs`（那是 DSH 内部的副本，别提交进仓库）；
- probe home（默认 `C:\Users\<你>\.dsh-desktop-probe`）可以整个删掉。
