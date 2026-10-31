# 宣传片与截图素材

本目录是 README 用的成片与静帧，**不是插件运行需要的资源**（插件运行只要 `lib/` 与 `public/`）。

| 文件 | 说明 |
|---|---|
| `same-canvas-78s.mp4` | 完整宣传片《同一块画布》：78 秒 / 1920×1080 / 30fps / H.264 + AAC，`+faststart` |
| `promo-poster.jpg` | 片头标题帧（README 顶部的可点击海报，1600×900） |
| `same-canvas-preview.gif` | 片中第 02 场「它的手」（17.5–31.5s），640 宽 / 10fps，README 里自动循环 |
| `scene-01-custom.jpg` … `scene-05-inside-dsh.jpg` | 分场静帧，1280 宽 |

## 出处

成片的源工程在 `E:\AllAssets\项目\画布关系片`（静态 SVG 舞台 + 时间轴逐帧求值 + 无头 Chrome
逐帧截图 + ffmpeg 编码；另见该目录 `README.md` 的分场表）。片中画布外壳按 v1.86.0 真机对齐，
不做摄像机运动，只靠元素进场 / 生长 / 描边制造动感。

片中出现的命令、工具名与数字（`canvas_control` 的 `read / recipe / configure / connect /
preview / progress`、「6 项生成已准备 · 在画布内批准」、9 节点 / 6 镜头）都对应真实行为与
回归用例，不是装饰性文案。

## 重新压缩

```bash
# 海报 / 静帧
ffmpeg -i 终.mp4 -ss 2.2 -frames:v 1 -vf scale=1600:-1 -q:v 3 promo-poster.jpg

# 循环 GIF（第 02 场）
ffmpeg -ss 17.5 -to 31.5 -i 终.mp4 \
  -vf "fps=10,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
  -loop 0 same-canvas-preview.gif

# 成片转 faststart（不重编码）
ffmpeg -i 终.mp4 -c copy -movflags +faststart same-canvas-78s.mp4
```
