/**
 * 启动动画（boot splash）：打开「无限画布」时，先用一层全屏动画盖住画布，
 * 播完溶解，露出项目库（v1.85 起的画布首屏）。
 *
 * 设计来源与决策：
 *   - 视觉是「光环式」：粗弧 + 细弧 + 内环 + 三粒点，缺口朝右上，字标压环心。
 *     v1 那版「节点卡片 + 连线」被否掉 —— 开场不复述产品功能图，只给抽象几何。
 *   - 只用一支 rAF 画点阵 + CSS 过渡，无图片、无音频、无第三方依赖。
 *   - 固定 1280×720 设计稿整体等比缩放，面板多大都不变形。
 *
 * 三条硬约束（踩过的坑都在这儿）：
 *   1. **失败一律放行**：任一步抛错、或总时长超 6s，都必须把这一层摘掉，
 *      绝不能留下黑屏把画布锁死（dsh-startup-screen 修了三版才修好这个）。
 *   2. 只加 DOM，不碰 vendor 树；层挂成 container 的最后一个孩子 + 高 z-index。
 *   3. 卸载时把 rAF / 定时器 / 监听器 / 样式全撤掉，否则退出画布会留下孤儿。
 */

const STYLE_ID = 'afb-style';
const ROOT_ID = 'afb-root';
const SESSION_KEY = 'aifisher.boot-splash.played';

/** 想改成「一个会话只播一次」，把它打开即可。 */
const ONCE_PER_SESSION = false;
/** 总时长（与时间轴末幕对齐）+ 兜底上限。 */
const TOTAL_MS = 4200;
const HARD_CAP_MS = 6000;

/** 关掉的开关：设置里写 localStorage aifisher.bootSplash = '0' 即不播。 */
function disabledByUser(): boolean {
  try {
    return window.localStorage.getItem('aifisher.bootSplash') === '0';
  } catch {
    return false;
  }
}

function playedThisSession(): boolean {
  if (!ONCE_PER_SESSION) return false;
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markPlayed(): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

const CSS = `
#${ROOT_ID}{
  position:absolute; inset:0; z-index:2147483000; overflow:hidden;
  background:#0b0d11; cursor:default;
  transition:opacity 620ms cubic-bezier(.4,0,.2,1);
}
#${ROOT_ID}.is-gone{opacity:0; pointer-events:none;}
#${ROOT_ID} .afb-stage{
  position:absolute; left:50%; top:50%; width:1280px; height:720px;
  transform:translate(-50%,-50%) scale(var(--afb-scale,1)); transform-origin:center center;
}
#${ROOT_ID} .afb-glow{
  position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(640px 460px at 50% 44%, rgba(94,234,212,.05), transparent 66%),
    radial-gradient(520px 380px at 82% 78%, rgba(139,124,246,.045), transparent 68%);
}
#${ROOT_ID} canvas{position:absolute; inset:0; width:1280px; height:720px;}
#${ROOT_ID} svg.afb-rings{position:absolute; inset:0; width:1280px; height:720px; overflow:visible;}
#${ROOT_ID} .afb-spin{transform-origin:640px 330px; animation:afb-spin 180s linear infinite;}
@keyframes afb-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
#${ROOT_ID} .afb-arc{fill:none; stroke:#e9eef6; opacity:0; transition:opacity 300ms linear;}
#${ROOT_ID} .afb-arc-thick{stroke-width:6; stroke-linecap:round;}
#${ROOT_ID} .afb-arc-thin{stroke-width:1; stroke-opacity:.55;}
#${ROOT_ID} .afb-arc-inner{stroke-width:1; stroke-opacity:.28;}
#${ROOT_ID} .afb-knob{fill:#e9eef6; opacity:0; transition:opacity 320ms linear;}
#${ROOT_ID} .afb-dot{opacity:0; transition:opacity 360ms linear;}
#${ROOT_ID} .afb-knob.is-in,#${ROOT_ID} .afb-dot.is-in{opacity:1;}
#${ROOT_ID} .afb-corner{position:absolute; width:14px; height:14px; opacity:0; transition:opacity 420ms linear;}
#${ROOT_ID} .afb-corner.is-in{opacity:1;}
#${ROOT_ID} .afb-corner::before,#${ROOT_ID} .afb-corner::after{content:""; position:absolute; background:rgba(255,255,255,.18);}
#${ROOT_ID} .afb-corner::before{width:100%; height:1px;}
#${ROOT_ID} .afb-corner::after{width:1px; height:100%;}
#${ROOT_ID} .afb-tl{left:36px; top:36px;}
#${ROOT_ID} .afb-tr{right:36px; top:36px;}
#${ROOT_ID} .afb-bl{left:36px; bottom:36px;}
#${ROOT_ID} .afb-br{right:36px; bottom:36px;}
#${ROOT_ID} .afb-tl::before,#${ROOT_ID} .afb-tl::after{left:0; top:0;}
#${ROOT_ID} .afb-tr::before,#${ROOT_ID} .afb-tr::after{right:0; top:0;}
#${ROOT_ID} .afb-bl::before,#${ROOT_ID} .afb-bl::after{left:0; bottom:0;}
#${ROOT_ID} .afb-br::before,#${ROOT_ID} .afb-br::after{right:0; bottom:0;}
#${ROOT_ID} .afb-meta{
  position:absolute; left:60px; top:56px; display:flex; gap:14px;
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10px; letter-spacing:.2em; color:#6c7688; opacity:0; transition:opacity 420ms linear;
}
#${ROOT_ID} .afb-meta.is-in{opacity:1;}
#${ROOT_ID} .afb-meta b{color:#a7b2c3; font-weight:400;}
#${ROOT_ID} .afb-meta .afb-on{color:#5eead4;}
#${ROOT_ID} .afb-status{
  position:absolute; right:60px; top:56px; text-align:right;
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10px; letter-spacing:.24em; color:#a7b2c3; opacity:0; transition:opacity 420ms linear;
}
#${ROOT_ID} .afb-status.is-in{opacity:1;}
#${ROOT_ID} .afb-status span{display:block; margin-top:6px; color:#6c7688; letter-spacing:.18em;}
#${ROOT_ID} .afb-word{
  position:absolute; left:0; right:0; top:288px; text-align:center;
  font-family:"Bahnschrift","DIN Alternate","Arial Narrow","Microsoft YaHei",sans-serif;
  font-size:40px; font-weight:600; letter-spacing:.22em; text-indent:.22em; line-height:1;
  color:#e9eef6;
}
#${ROOT_ID} .afb-ch{
  display:inline-block; opacity:0; transform:translateY(.18em);
  transition:opacity 340ms cubic-bezier(.4,0,.2,1), transform 340ms cubic-bezier(.4,0,.2,1);
}
#${ROOT_ID} .afb-ch.is-in{opacity:1; transform:none;}
#${ROOT_ID} .afb-sub{
  position:absolute; left:0; right:0; top:352px; text-align:center;
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10.5px; letter-spacing:.34em; text-indent:.34em; color:#a7b2c3;
  opacity:0; transform:translateY(8px);
  transition:opacity 460ms cubic-bezier(.4,0,.2,1), transform 460ms cubic-bezier(.4,0,.2,1);
}
#${ROOT_ID} .afb-sub.is-in{opacity:1; transform:none;}
#${ROOT_ID} .afb-progress{position:absolute; left:60px; bottom:62px; display:flex; align-items:center; gap:12px;}
#${ROOT_ID} .afb-track{width:220px; height:2px; background:rgba(255,255,255,.09);}
#${ROOT_ID} .afb-track i{display:block; height:100%; width:0; background:#5eead4; transition:width 200ms linear;}
#${ROOT_ID} .afb-pct{
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10px; letter-spacing:.18em; color:#6c7688; min-width:34px;
}
#${ROOT_ID} .afb-tags{
  position:absolute; right:60px; bottom:62px;
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10px; letter-spacing:.22em; color:#6c7688;
}
#${ROOT_ID} .afb-skip{
  position:absolute; right:60px; top:100px;
  font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;
  font-size:10px; letter-spacing:.2em; color:#6c7688;
  background:transparent; border:1px solid rgba(255,255,255,.075);
  padding:7px 12px; border-radius:4px; cursor:pointer; opacity:0;
  transition:opacity 300ms linear, color 200ms, border-color 200ms;
}
#${ROOT_ID} .afb-skip.is-in{opacity:1;}
#${ROOT_ID} .afb-skip:hover{color:#e9eef6; border-color:rgba(255,255,255,.13);}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 640;
const CY = 330;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
  return node;
}

function polar(radius: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}

function arcPath(radius: number, from: number, sweep: number): string {
  const p0 = polar(radius, from);
  const p1 = polar(radius, from + sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
}

/**
 * 挂一层启动动画。返回 dispose：立刻摘层、撤定时器与监听器。
 * 任何异常都被吞掉并且放行 —— 动画再好看也不能挡着画布。
 */
export function mountBootSplash(container: HTMLElement): () => void {
  try {
    if (!container.isConnected) return () => {};
    if (disabledByUser() || playedThisSession()) return () => {};
    if (document.getElementById(ROOT_ID)) return () => {};

    const style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = el('div');
    root.id = ROOT_ID;

    const stage = el('div', 'afb-stage');
    stage.appendChild(el('div', 'afb-glow'));

    const dotCanvas = el('canvas');
    dotCanvas.width = 1280;
    dotCanvas.height = 720;
    stage.appendChild(dotCanvas);

    /* ---- 光环 ---- */
    const rings = svg('svg', { class: 'afb-rings', viewBox: '0 0 1280 720' });
    const spin = svg('g', { class: 'afb-spin' });

    const thick = svg('path', { class: 'afb-arc afb-arc-thick', d: arcPath(198, 345, 300) });
    const thin = svg('path', { class: 'afb-arc afb-arc-thin', d: arcPath(142, 150, 215) });
    const inner = svg('circle', {
      class: 'afb-arc afb-arc-inner',
      cx: String(CX),
      cy: String(CY),
      r: '110',
    });

    const knobAt = polar(198, 345);
    const knob = svg('circle', {
      class: 'afb-knob',
      cx: knobAt[0].toFixed(2),
      cy: knobAt[1].toFixed(2),
      r: '7',
    });

    const dotDefs: Array<[number, number, string, string]> = [
      [142, 300, '4', '#5eead4'],
      [142, 205, '3.5', '#8b7cf6'],
      [142, 100, '2.5', 'rgba(167,178,195,.75)'],
    ];
    const dots = dotDefs.map(([radius, angle, dotR, fill]) => {
      const p = polar(radius, angle);
      const c = svg('circle', {
        class: 'afb-dot',
        cx: p[0].toFixed(2),
        cy: p[1].toFixed(2),
        r: dotR,
        fill,
      });
      return c;
    });

    spin.append(knob, thick, thin, inner, ...dots);
    rings.appendChild(spin);
    stage.appendChild(rings);

    /* ---- 四角 / 微字 ---- */
    const corners = ['afb-tl', 'afb-tr', 'afb-bl', 'afb-br'].map((cls) => {
      const node = el('span', `afb-corner ${cls}`);
      stage.appendChild(node);
      return node;
    });

    const meta = el('div', 'afb-meta');
    meta.append(
      (() => {
        const s = el('span');
        s.append('AIFISHER ', el('b', undefined, 'CANVAS'));
        return s;
      })(),
      el('span', 'afb-on', '●'),
      el('span', undefined, 'INITIALIZING'),
    );
    stage.appendChild(meta);

    const status = el('div', 'afb-status');
    status.append('LOADING WORKSPACE', el('span', undefined, '初始化画布运行时'));
    stage.appendChild(status);

    /* ---- 字标 ---- */
    const word = el('div', 'afb-word');
    const chars: HTMLSpanElement[] = [];
    for (const ch of 'AIFISHER') {
      const c = el('span', 'afb-ch', ch);
      word.appendChild(c);
      chars.push(c);
    }
    stage.appendChild(word);

    const sub = el('div', 'afb-sub', 'AI CANVAS · INFINITE WORKSPACE');
    stage.appendChild(sub);

    /* ---- 底部 ---- */
    const progress = el('div', 'afb-progress');
    const track = el('span', 'afb-track');
    const bar = el('i');
    track.appendChild(bar);
    const pct = el('span', 'afb-pct', '0%');
    progress.append(track, pct);
    stage.appendChild(progress);

    stage.appendChild(el('div', 'afb-tags', 'COMFYUI · CLOUD · AGENT · LOCAL'));

    const skip = el('button', 'afb-skip', 'ESC 跳过');
    skip.type = 'button';
    stage.appendChild(skip);

    root.appendChild(stage);

    /**
     * ⚠️ 不能挂在 container 里：React 19 的 createRoot 首次提交会清空容器子节点，
     * 挂在里面会在第一帧就被摘掉（v1.91.0 实测「动画没出来」就是这个原因）。
     *
     * 挂到 body 并 position:fixed —— 用户要的是「点击无限画布之后**全屏**播放这个动画」，
     * 面板内挂法会把 1280×720 设计稿缩进主区域、四周留黑边，和样张观感不一致（v1.91.2）。
     */
    const host = document.body;
    root.style.position = 'fixed';
    host.appendChild(root);

    /* 再兜一刀：万一宿主自己清理子节点，下一帧补回一次 */
    window.requestAnimationFrame(() => {
      if (!root.isConnected) host.appendChild(root);
    });

    // 真机排查用：控制台能直接看到这一行，判断「到底有没有挂上」
    try {
      (window as unknown as Record<string, unknown>).__AFISHER_BOOT_SPLASH__ = {
        mounted: true,
        host: 'body-fixed',
        at: Date.now(),
      };
      console.info('[aifisher-canvas] 启动动画已挂载', { host: 'body-fixed' });
    } catch {
      /* ignore */
    }

    /* ---- 等比缩放：按整个视口铺，和样张一致 ---- */
    const fit = () => {
      const w = window.innerWidth || document.documentElement.clientWidth || 1280;
      const h = window.innerHeight || document.documentElement.clientHeight || 720;
      const scale = Math.min(w / 1280, h / 720);
      stage.style.setProperty('--afb-scale', String(Math.max(0.2, Math.round(scale * 1000) / 1000)));
    };
    fit();
    // 首帧布局可能还没量到真实尺寸，补两次
    window.requestAnimationFrame(fit);
    window.setTimeout(fit, 60);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(fit);
      observer.observe(document.documentElement);
    }
    window.addEventListener('resize', fit);

    /* ---- 点阵 ---- */
    const ctx = dotCanvas.getContext('2d');
    const GAP = 36;
    const dotsGrid: Array<{ x: number; y: number; delay: number }> = [];
    const maxD = Math.hypot(CX, CY);
    for (let y = GAP / 2; y < 720; y += GAP) {
      for (let x = GAP / 2; x < 1280; x += GAP) {
        dotsGrid.push({
          x,
          y,
          delay: (Math.hypot(x - CX, y - CY) / maxD) * 780 + Math.random() * 40,
        });
      }
    }

    const startedAt = performance.now();
    let raf = 0;
    let alive = true;
    const timers: number[] = [];
    /**
     * 动画时钟：按帧推进，单帧最多前进 64ms。
     * 主线程被 vendor 初始化卡住时，rAF 会掉帧；直接用 performance.now() 会让弧线
     * 「一帧跳到终点」，所以用这个时钟 —— 卡了只是变慢，绝不会跳过生长过程。
     */
    let clock = 0;
    let lastFrame = startedAt;

    const drawDots = (now: number) => {
      if (!ctx) return;
      clock += Math.min(64, Math.max(0, now - lastFrame));
      lastFrame = now;
      const t = clock;
      ctx.clearRect(0, 0, 1280, 720);
      for (const p of dotsGrid) {
        const k = Math.min(1, (t - p.delay) / 260);
        if (k <= 0) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(233,238,246,${(0.075 * k).toFixed(4)})`;
        ctx.fill();
      }
      // 弧线生长（自己算，见 drawArc 的说明）
      for (const arc of arcs) {
        const raw = Math.min(1, Math.max(0, (clock - arc.from) / arc.ms));
        const eased = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
        arc.node.style.strokeDashoffset = String(arc.len * (1 - eased));
      }
      if (alive) raf = window.requestAnimationFrame(drawDots);
    };
    raf = window.requestAnimationFrame(drawDots);

    const at = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };
    const show = (node: Element | null | undefined) => {
      if (node) node.classList.add('is-in');
    };
    /**
     * 弧线生长：**不用 CSS transition，自己按 rAF 算 dashoffset**。
     *
     * 两种写法都试过，都不行：
     *   1. 同一批次写 dasharray + dashoffset + transition —— 浏览器合成一次样式计算，过渡不触发，
     *      圆弧一出现就是画完的样子；
     *   2. 先提交初值、强制布局、双 rAF 再挂过渡 —— 单页测试能长，但在画布里不行：
     *      开画布时 vendor 正在初始化、主线程长时间被占，过渡会直接跳到终点。
     * 所以改成自己算，每帧写一次 dashoffset，线程再卡也只是掉帧，不会「直接完成」。
     */
    const arcs: Array<{ node: SVGElement; len: number; from: number; ms: number }> = [];
    const drawArc = (node: SVGElement, ms: number) => {
      const len = typeof (node as SVGPathElement).getTotalLength === 'function'
        ? (node as SVGPathElement).getTotalLength()
        : 1200;
      node.style.transition = 'none';
      node.style.strokeDasharray = `${len} ${len}`;
      node.style.strokeDashoffset = String(len);
      node.style.opacity = '1';
      arcs.push({ node, len, from: clock, ms });
    };
    const setProgress = (v: number) => {
      bar.style.width = `${v}%`;
      pct.textContent = `${Math.round(v)}%`;
    };

    /* ---- 时间轴（与 prototype v2 一致）---- */
    at(120, () => show(meta));
    at(400, () => corners.forEach(show));
    at(600, () => show(status));
    at(900, () => drawArc(thick, 900));
    at(1250, () => drawArc(thin, 700));
    at(1520, () => show(knob));
    at(1650, () => drawArc(inner, 520));
    at(1900, () => show(dots[0]));
    at(2050, () => show(dots[1]));
    at(2150, () => show(dots[2]));
    at(2400, () => {
      chars.forEach((c, i) => at(i * 46, () => c.classList.add('is-in')));
    });
    at(2800, () => show(sub));
    at(2500, () => show(skip));
    at(TOTAL_MS, () => finish());

    /* 进度：按总时长线性，真实实现可换成画布加载态 */
    const tick = () => {
      if (!alive) return;
      const v = Math.min(100, ((performance.now() - startedAt) / TOTAL_MS) * 100);
      setProgress(v);
      if (v < 100) timers.push(window.setTimeout(tick, 90));
    };
    timers.push(window.setTimeout(tick, 90));

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    document.addEventListener('keydown', onKey, true);
    skip.addEventListener('click', finish);

    const hardCap = window.setTimeout(() => finish(), HARD_CAP_MS);

    let finished = false;
    function finish(): void {
      if (finished) return;
      finished = true;
      alive = false;
      markPlayed();
      window.cancelAnimationFrame(raf);
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(hardCap);
      document.removeEventListener('keydown', onKey, true);
      skip.removeEventListener('click', finish);
      window.removeEventListener('resize', fit);
      observer?.disconnect();
      try {
        setProgress(100);
      } catch {
        /* ignore */
      }
      root.classList.add('is-gone');
      window.setTimeout(() => {
        root.remove();
        if (!document.getElementById(ROOT_ID)) style.remove();
      }, 640);
    }

    return () => {
      try {
        finish();
      } catch {
        root.remove();
      }
    };
  } catch (error) {
    // 任何异常都不许挡住画布
    try {
      document.getElementById(ROOT_ID)?.remove();
    } catch {
      /* ignore */
    }
    console.error('[aifisher-canvas] 启动动画挂载失败，已跳过', error);
    return () => {};
  }
}
