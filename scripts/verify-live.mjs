/**
 * live 自检：对着**正在运行的 DSH**（默认 127.0.0.1:19387）看插件当前状态。
 *
 * 用途：agent 没有浏览器控制权，重启/刷新之后用它确认：
 *   - host 半的三条路由是否真的挂上了（未挂上时 DSH 的 /api 鉴权层会返回 401）；
 *   - 画布应用产物能不能取到（大小对不对）；
 *   - 画布有没有在桥接里注册（说明页面里画布跑起来了、且打开了项目）；
 *   - 画布回传的运行时错误（含它自报的容器尺寸）。
 *
 * 用法：node scripts/verify-live.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:19387';

async function get(path) {
  try {
    const response = await fetch(new URL(path, BASE));
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  } catch (error) {
    return { status: 0, text: String(error), headers: new Headers() };
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('host 路由');
for (const path of [
  '/api/comfy/ping',
  '/api/aifisher/skills',
  '/api/aifisher/canvas/status',
  '/api/aifisher/canvas/comfy/capabilities?outputType=videos',
  '/api/aifisher/canvas/generation-status/verify-live-probe',
  '/api/aifisher/canvas/media/thumbnail?url=%2Fapi%2Faifisher%2Fcanvas%2Fmedia%2Fnope%2Fimages%2Fnope.png',
]) {
  const result = await get(path);
  const note = result.status === 401 ? '（401 = 该路由没挂上，被 DSH 的 /api 鉴权层拦下）' : '';
  console.log(`${String(result.status).padStart(4)}  ${path}  ${result.text.slice(0, 200).replace(/\s+/g, ' ')}${note}`);
}

section('ComfyUI（本机）');
{
  const result = await get('/api/comfy/ping');
  if (result.status === 200) {
    try {
      const ping = JSON.parse(result.text);
      console.log(ping.online ? `在线：${ping.url}` : `未连上：${ping.url}（本地工作流生成会以 COMFY_UNAVAILABLE 失败）`);
      if (!ping.online) {
        console.log('  启动方式：绘世启动器（G:\\ComfyUI-aki-v3.2-duyumingze\\绘世启动器.exe）或 run_nvidia_gpu.bat');
      }
    } catch {
      console.log(result.text.slice(0, 200));
    }
  } else {
    console.log(`status=${result.status}`);
  }
}

section('画布应用产物');
{
  const result = await get('/api/aifisher/canvas-app/canvas-app.js');
  const size = result.headers.get('content-length') ?? result.text.length;
  console.log(`${String(result.status).padStart(4)}  /api/aifisher/canvas-app/canvas-app.js  ${size} bytes  cache-control=${result.headers.get('cache-control')}`);
  if (result.status !== 200) {
    console.log('      提示：产物取不到时，宿主侧路由要先重启 DSH 才会挂上。');
  }
}

section('画布状态 / 桥接');
{
  const result = await get('/api/aifisher/canvas/status');
  if (result.status === 200) {
    try {
      const status = JSON.parse(result.text);
      console.log(`数据文件：${status.store.path}（项目 ${status.store.documents} / 文件夹 ${status.store.folders} / ${status.store.bytes} bytes）`);
      const clients = status.bridge?.clients ?? [];
      console.log(`桥接：客户端 ${clients.length} 个，排队 ${status.bridge?.queued}，等回执 ${status.bridge?.pendingRequests}，长轮询挂起=${status.bridge?.polling}`);
      for (const client of clients) {
        console.log(`  - projectId=${client.projectId} idle=${client.idleMs}ms`);
      }
      if (clients.length === 0) {
        console.log('  （没有客户端 = 页面里还没打开画布面板，或画布里还没进入任何项目）');
      }
    } catch (error) {
      console.log('解析失败：', String(error), result.text.slice(0, 200));
    }
  } else {
    console.log(`status=${result.status}`);
  }
}

section('画布回传的诊断');
{
  const result = await get('/api/aifisher/canvas/diagnostics?limit=50');
  if (result.status !== 200) {
    console.log(`status=${result.status}`);
  } else {
    const entries = JSON.parse(result.text).entries ?? [];
    if (entries.length === 0) console.log('（空：页面里还没加载过画布）');
    for (const entry of entries) {
      const detail = entry.detail ? JSON.stringify(entry.detail) : '';
      console.log(`${entry.level.toUpperCase().padEnd(5)} ${entry.message}  ${detail.slice(0, 220)}`);
    }
    const errors = entries.filter((entry) => entry.level === 'error');
    console.log(errors.length === 0 ? '\n结论：没有运行时错误。' : `\n结论：有 ${errors.length} 条运行时错误，见上。`);
  }
}
console.log();
