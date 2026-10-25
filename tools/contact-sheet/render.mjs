/**
 * 服务端合成渲染：把画布项目里已出图的节点排成一张分镜 contact sheet。
 *
 * 为什么要它：画布里的「导出」走的是浏览器 DOM 截图（html-to-image），节点一多、
 * 图一大就受 DOM / foreignObject / 跨域图 / 8192px 上限的约束。这条路线绕开浏览器，
 * 直接按数据在 Node 里重画成图，分辨率与尺寸只受内存限制。
 *
 * 依赖：leafer-ui（MIT）+ @napi-rs/canvas（原生 canvas 后端）。
 * 本工具独立安装，不参与插件构建，产物也不会进 lib/。
 *
 * 用法见同目录 README.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import { useCanvas, Leafer, Rect, Text, Image } from '@leafer-ui/node'

// 原生 canvas 后端：@napi-rs/canvas 的平台二进制是 optionalDependency，
// pnpm 偶发不装（镜像/平台不匹配），这里给一句能照着做的报错。
let createCanvas, loadImage
try {
  ;({ createCanvas, loadImage } = await import('@napi-rs/canvas'))
} catch (error) {
  console.error('[contact-sheet] 原生 canvas 后端加载失败：' + error.message)
  console.error('  先装平台二进制再试，例如 Windows x64：')
  console.error('  pnpm add @napi-rs/canvas-win32-x64-msvc')
  process.exit(2)
}

useCanvas('napi', { Canvas: createCanvas, loadImage })

const FONT = 'Microsoft YaHei' // 中文必须显式指定，napi 侧不会按 fallback 自动挑

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { cols: 4, cellWidth: 360, scale: 2, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--storage') out.storage = next()
    else if (a === '--project') out.project = next()
    else if (a === '--out') out.out = next()
    else if (a === '--cols') out.cols = Number(next())
    else if (a === '--cell-width') out.cellWidth = Number(next())
    else if (a === '--scale') out.scale = Number(next())
    else if (a === '--title') out.title = next()
    else if (a === '--list') out.list = true
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  out.storage = out.storage || (process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'storages', 'dsh-aifisher-canvas'))
  if (out.help) return out
  if (!out.storage) throw new Error('缺少 --storage（且环境变量 DSH_HOME 为空）')
  if (!fs.existsSync(path.join(out.storage, 'canvas.json'))) throw new Error(`不是画布数据目录：${out.storage}`)
  return out
}

const USAGE = `用法: node render.mjs [--storage <画布数据目录>] [--project <id|标题片段>] [--out <png>]
                            [--cols 4] [--cell-width 360] [--scale 2] [--title <标题>] [--list]

  --storage     默认 $DSH_HOME/storages/dsh-aifisher-canvas
  --project     项目 id 或标题片段；默认取已出图节点最多的项目
  --out         默认 <storage>/exports/contact-sheet-<projectId>.png
  --cols        列数，默认 4
  --cell-width  单元格宽（逻辑像素），默认 360
  --scale       像素倍率，默认 2
  --list        只列出项目，不渲染`

// ---------------------------------------------------------------- 数据

function loadDocument(storage) {
  const doc = JSON.parse(fs.readFileSync(path.join(storage, 'canvas.json'), 'utf8'))
  const documents = doc.documents || {}
  return Object.values(documents).filter((d) => d && d.id)
}

/** 节点上记录的素材地址 → 本机文件；找不到就返回 null（跳过，不报错） */
function resolveMediaFile(storage, node) {
  const raw = node.resultUrl || node.url || node.resultUrls?.[0]
  if (!raw) return null
  const clean = String(raw).split('?')[0]
  const m = clean.match(/\/media\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!m) return null
  const file = path.join(storage, 'media', m[1], m[2], m[3])
  return fs.existsSync(file) ? file : null
}

function collectItems(storage, project) {
  const nodes = (project.nodes || []).slice()
  // 画布阅读顺序：先上后下、先左后右
  nodes.sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))

  const items = []
  const skipped = { empty: 0, missing: 0, video: 0 }
  for (const node of nodes) {
    if (node.type === 'Video' || node.type === 'Upload Video') {
      skipped.video++
      continue
    }
    if (node.type !== 'Image' && node.type !== 'Upload Image') continue
    const file = resolveMediaFile(storage, node)
    if (!file) {
      if (node.resultUrl || node.url) skipped.missing++
      else skipped.empty++
      continue
    }
    items.push({ node, file })
  }
  return { items, skipped, total: nodes.filter((n) => n.type === 'Image' || n.type === 'Upload Image').length }
}

function pickProject(projects, hint) {
  if (hint) {
    const hit = projects.find((p) => p.id === hint) ||
      projects.find((p) => p.id.startsWith(hint)) ||
      projects.find((p) => String(p.title || '').includes(hint))
    if (!hit) throw new Error(`没找到项目：${hint}（用 --list 看有哪些）`)
    return hit
  }
  const scored = projects
    .map((p) => ({ p, n: (p.nodes || []).filter((x) => x.resultUrl || x.url).length }))
    .sort((a, b) => b.n - a.n)
  if (!scored[0]) throw new Error('canvas.json 里没有项目')
  return scored[0].p
}

// ---------------------------------------------------------------- 版式

// Leafer 的 maxLines/textOverflow 在 node 渲染里不裁行，长标题会压到元信息行上，
// 所以标题自己按字宽折行 + 截断（用 napi 的 measureText 量，中英混排都准）。
const measureCtx = createCanvas(8, 8).getContext('2d')
function fitLines(text, { width, fontSize, maxLines }) {
  measureCtx.font = `${fontSize}px ${FONT}`
  const clean = String(text).replace(/\s+/g, ' ').trim()
  const lines = []
  let line = ''
  for (const ch of clean) {
    const next = line + ch
    if (measureCtx.measureText(next).width > width && line) {
      lines.push(line)
      if (lines.length === maxLines) break
      line = ch.trimStart()
    } else line = next
  }
  if (lines.length < maxLines && line) lines.push(line)
  const truncated = lines.join('').length < clean.length
  if (truncated) lines[lines.length - 1] = lines[lines.length - 1].replace(/.$/, '') + '…'
  return lines.join('\n')
}

const FILENAME_RE = /^[\w-]{12,}\.(png|jpe?g|webp|gif|mp4|webm)$/i
function captionOf(node) {
  const title = String(node.title || '').trim()
  if (title && !FILENAME_RE.test(title)) return title
  const prompt = String(node.prompt || '').trim()
  // 上传节点的 title 与 prompt 常常都是原始文件名，两处都判
  if (prompt && !FILENAME_RE.test(prompt)) return prompt
  return node.type === 'Upload Image' ? '上传素材' : '（无标题）'
}

function buildSheet({ title, items, skipped, total, projectId, cols, cellWidth, scale, subtitle }) {
  const pad = Math.round(cellWidth * 0.18)
  const gap = Math.round(cellWidth * 0.066)
  const cellH = Math.round(cellWidth * 0.667)
  const capH = Math.round(cellWidth * 0.24)
  const headerH = Math.round(cellWidth * 0.4)
  const footerH = Math.round(cellWidth * 0.16)

  const rows = Math.max(1, Math.ceil(items.length / cols))
  const W = pad * 2 + cols * cellWidth + (cols - 1) * gap
  const H = headerH + rows * (cellH + capH + gap) + footerH

  const leafer = new Leafer({ width: W, height: H, pixelRatio: scale })
  leafer.add(new Rect({ width: W, height: H, fill: '#0b0e13' }))
  leafer.add(new Rect({ width: W, height: headerH - gap, fill: '#11161f' }))

  const titleSize = Math.round(cellWidth * 0.115)
  const titleW = W - pad * 2 - Math.round(cellWidth * 0.8)
  leafer.add(new Text({
    x: pad, y: Math.round(headerH * 0.22),
    text: fitLines(title, { width: titleW, fontSize: titleSize, maxLines: 1 }),
    fill: '#f2f6ff',
    fontSize: titleSize, fontWeight: 'bold', fontFamily: FONT, textWrap: 'normal',
  }))
  const subSize = Math.round(cellWidth * 0.05)
  leafer.add(new Text({
    x: pad, y: Math.round(headerH * 0.62),
    text: fitLines(subtitle, { width: W - pad * 2 - Math.round(cellWidth * 0.9), fontSize: subSize, maxLines: 1 }),
    fill: '#7f8ca0',
    fontSize: subSize, fontFamily: FONT, textWrap: 'normal',
  }))
  leafer.add(new Text({
    x: W - pad - Math.round(cellWidth * 0.75), y: Math.round(headerH * 0.28),
    width: Math.round(cellWidth * 0.75), textAlign: 'right',
    text: new Date().toISOString().slice(0, 16).replace('T', ' '),
    fill: '#5d6b80', fontSize: Math.round(cellWidth * 0.042), fontFamily: FONT,
  }))

  items.forEach((it, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = pad + col * (cellWidth + gap)
    const y = headerH + row * (cellH + capH + gap)
    const { node, image } = it

    leafer.add(new Rect({ x, y, width: cellWidth, height: cellH, fill: '#151a22', cornerRadius: Math.round(cellWidth * 0.028) }))

    const k = Math.min(cellWidth / image.width, cellH / image.height)
    const dw = Math.round(image.width * k)
    const dh = Math.round(image.height * k)
    leafer.add(new Image({
      x: x + (cellWidth - dw) / 2, y: y + (cellH - dh) / 2,
      width: dw, height: dh, url: it.file,
    }))

    const capY = y + cellH + Math.round(cellWidth * 0.033)
    const capX = x + Math.round(cellWidth * 0.072)
    const capW = cellWidth - Math.round(cellWidth * 0.072)
    const titleSize = Math.round(cellWidth * 0.045)
    const titleLines = fitLines(captionOf(node), { width: capW, fontSize: titleSize, maxLines: 2 })

    leafer.add(new Text({
      x, y: capY, width: Math.round(cellWidth * 0.08),
      text: String(i + 1).padStart(2, '0'),
      fill: '#4c9dff', fontSize: Math.round(cellWidth * 0.039), fontWeight: 'bold', fontFamily: FONT,
    }))
    leafer.add(new Text({
      x: capX, y: capY - Math.round(cellWidth * 0.003), width: capW,
      text: titleLines,
      fill: '#dbe4f0', fontSize: titleSize, fontFamily: FONT,
      lineHeight: Math.round(titleSize * 1.45), textWrap: 'normal',
    }))
    const meta = [node.model, node.aspectRatio, node.resolution].filter(Boolean).join(' · ')
    if (meta) {
      const lineH = Math.round(titleSize * 1.45)
      const titleRows = titleLines.split('\n').length
      leafer.add(new Text({
        x: capX, y: capY + titleRows * lineH + Math.round(cellWidth * 0.008), width: capW,
        text: fitLines(meta, { width: capW, fontSize: Math.round(cellWidth * 0.036), maxLines: 1 }),
        fill: '#6c7a8f',
        fontSize: Math.round(cellWidth * 0.036), fontFamily: FONT, textWrap: 'normal',
      }))
    }
  })

  if (!items.length) {
    leafer.add(new Text({
      x: pad, y: headerH + cellH * 0.3, text: '该项目还没有可用的出图素材',
      fill: '#5d6b80', fontSize: Math.round(cellWidth * 0.06), fontFamily: FONT,
    }))
  }

  leafer.add(new Text({
    x: pad, y: H - footerH + Math.round(footerH * 0.28),
    text: `dsh-aifisher-canvas · contact sheet · ${projectId}`,
    fill: '#3d4757', fontSize: Math.round(cellWidth * 0.033), fontFamily: FONT,
  }))

  return { leafer, W, H }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

const projects = loadDocument(args.storage)

if (args.list) {
  for (const p of projects) {
    const imgs = (p.nodes || []).filter((n) => n.resultUrl || n.url)
    console.log(`${p.id}  ${(p.title || 'Untitled').padEnd(20)} 节点 ${String((p.nodes || []).length).padStart(3)}  已出图 ${String(imgs.length).padStart(3)}`)
  }
  process.exit(0)
}

const project = pickProject(projects, args.project)
const { items, skipped, total } = collectItems(args.storage, project)

// 预先 loadImage 一遍：既拿到真实宽高用于 contain 布局，也把解码做在渲染之前
for (const it of items) it.image = await loadImage(it.file)

const notes = []
if (skipped.empty) notes.push(`未出图 ${skipped.empty}`)
if (skipped.missing) notes.push(`素材缺失 ${skipped.missing}`)
if (skipped.video) notes.push(`视频节点 ${skipped.video}（不参与拼版）`)
const subtitle = `分镜板 · 已出图 ${items.length} / 图片节点 ${total}` + (notes.length ? ` · 跳过：${notes.join('，')}` : '')

const { leafer, W, H } = buildSheet({
  title: args.title || project.title || 'Untitled',
  items, skipped, total, projectId: project.id,
  cols: Math.max(1, args.cols), cellWidth: Math.max(160, args.cellWidth), scale: Math.max(1, args.scale),
  subtitle,
})

const outFile = args.out || path.join(args.storage, 'exports', `contact-sheet-${project.id}.png`)
fs.mkdirSync(path.dirname(outFile), { recursive: true })

// 图片元素是异步解码的；这里等一小拍再导出，避免首批像素还没画上
await new Promise((r) => setTimeout(r, 80))

const t0 = Date.now()
await leafer.export(outFile)
const bytes = fs.statSync(outFile).size
console.log(`[contact-sheet] ${project.title || project.id}`)
console.log(`  版式 ${W}x${H} @${args.scale}x（${Math.round(W * args.scale)}x${Math.round(H * args.scale)} px）`)
console.log(`  ${items.length} 张图，耗时 ${Date.now() - t0} ms，输出 ${(bytes / 1024).toFixed(0)} KB`)
console.log(`  → ${outFile}`)
if (notes.length) console.log(`  跳过：${notes.join('，')}`)
process.exit(0)
