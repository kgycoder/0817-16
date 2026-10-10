/* ════════════════════════════════════════════════════════
   LIQUID GLASS ENGINE (SYNC) — 전면 재구현 (SVG 필터 방식 제거)
   ────────────────────────────────────────────────────────
   SYNC 는 WebView 로 로드한 html/css/js 가 UI 이고, 이 파일은 그 WebView 안에서
   backend(AndroidBridge / 재생 로직)와 실시간으로 통신하는 app.js 와 독립적으로 동작한다.
   app.js 의 재생/검색/AndroidBridge 로직은 건드리지 않고, gv() 를 감싸서 탭 이동만 관찰한다.

   참고 구현: Kyant0/AndroidLiquidGlass (Compose Multiplatform, backdrop 라이브러리)
   이 엔진은 해당 라이브러리의 렌더 수식과 파라미터를 WebView 에서 재현한다.
     · lens(refractionHeight, refractionAmount)
         - SDF(둥근 사각형) 가장자리에서 깊이 rh 안쪽까지 circleMap 프로파일로 ra 만큼
           안쪽 픽셀을 샘플링(굴절). 변위 벡터 = -ra * circleMap * grad (Kyant shader 와 동일 부호)
         - depthEffect : grad 에 중심 방향 벡터를 더해 볼록한 렌즈 깊이감을 준다
         - chromaticAberration(분산) 은 WebView 필터 합성에서 재현이 불안정해 생략한다
       → 변위 맵(PNG) + feDisplacementMap 으로 백드롭에 적용 (backdrop-filter: url())
     · vibrancy()  : saturation 1.5
     · blur(r)     : feGaussianBlur. Kyant 와 같이 굴절 "이전"에 적용
     · Highlight   : Default = 45° 방향 가장자리 하이라이트, Plain = 균일 림
     · InnerShadow : 눌렀을 때 안쪽 그림자
     · DampedDragAnimation / InteractiveHighlight : 같은 stiffness / dampingRatio 의 스프링
         (value 1000/1.0, pressProgress 1000/1.0, scaleX 250/0.6, scaleY 250/0.7, highlight 300/0.5)
   dp → CSS px 를 1:1 로 사용. 안드로이드 WebView 에서 1 CSS px ≈ 1 dp.
   backdrop-filter: url() 을 지원하지 않는 WebView 는 html.lg-fallback 로 표시되며,
   CSS 의 반투명 블러(유리 표면) 만 적용된다.
════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    const $ = (s, c) => (c || document).querySelector(s);
    const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const NS = "http://www.w3.org/2000/svg";

    /* ---------- 0. 지원 여부 ---------- */
    const SUPPORTS = (() => {
        try {
            return !!(window.CSS && CSS.supports &&
                (CSS.supports("backdrop-filter", "url(#lg)") || CSS.supports("-webkit-backdrop-filter", "url(#lg)")));
        } catch (e) { return false; }
    })();
    if (!SUPPORTS) document.documentElement.classList.add("lg-fallback");

    /* ---------- 1. Spring (Compose spring(dampingRatio, stiffness) 와 동일한 2차 감쇠계) ---------- */
    class Spring {
        constructor(v, stiffness, dampingRatio) {
            this.v = v; this.t = v; this.x = 0;
            this.k = stiffness;
            this.c = 2 * dampingRatio * Math.sqrt(stiffness);
        }
        step(dt) {
            const n = Math.max(1, Math.ceil(dt / (1 / 240)));
            const h = dt / n;
            for (let i = 0; i < n; i++) {
                this.x += (-this.k * (this.v - this.t) - this.c * this.x) * h;
                this.v += this.x * h;
            }
        }
        get rest() { return Math.abs(this.v - this.t) < 1e-3 && Math.abs(this.x) < 1e-2; }
    }

    /* ---------- 2. SDF / 굴절 수식 (Kyant RoundedRectSDF + circleMap 과 동일) ---------- */
    // R = [topLeft, topRight, bottomRight, bottomLeft]
    function radiusAt(px, py, R) {
        if (px >= 0) return py <= 0 ? R[1] : R[2];
        return py <= 0 ? R[0] : R[3];
    }
    function sdRoundedRect(px, py, hx, hy, r) {
        const cx = Math.abs(px) - (hx - r), cy = Math.abs(py) - (hy - r);
        const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) - r;
        const inside = Math.min(Math.max(cx, cy), 0);
        return outside + inside;
    }
    function gradSdRoundedRect(px, py, hx, hy, r) {
        const cx = Math.abs(px) - (hx - r), cy = Math.abs(py) - (hy - r);
        const sx = Math.sign(px), sy = Math.sign(py);
        if (cx >= 0 || cy >= 0) {
            const ox = Math.max(cx, 0), oy = Math.max(cy, 0);
            const len = Math.hypot(ox, oy) || 1;
            return [sx * ox / len, sy * oy / len];
        }
        const gx = cx >= cy ? 1 : 0; // step(cornerCoord.y, cornerCoord.x)
        return [sx * gx, sy * (1 - gx)];
    }
    function circleMap(x) { return 1 - Math.sqrt(Math.max(0, 1 - x * x)); }

    const MAP_TEXEL = 2; // 굴절 맵: 2 CSS px 당 1 texel (저주파 데이터라 충분)

    // o: { rh, ra, depth, radii }  →  { S, url }
    function buildLensMaps(w, h, o) {
        const mw = clamp(Math.round(w / MAP_TEXEL), 16, 260);
        const mh = clamp(Math.round(h / MAP_TEXEL), 16, 160);
        const hx = w / 2, hy = h / 2;
        const rh = Math.max(0.5, o.rh), ra = o.ra;
        const N = mw * mh;
        const vx = new Float32Array(N), vy = new Float32Array(N);
        let maxAbs = 1e-3;

        for (let j = 0; j < mh; j++) {
            for (let i = 0; i < mw; i++) {
                const k = j * mw + i;
                const px = (i + 0.5) / mw * w - hx;
                const py = (j + 0.5) / mh * h - hy;
                const r = radiusAt(px, py, o.radii);
                const sd = Math.min(sdRoundedRect(px, py, hx, hy, r), 0);
                const depth = -sd;
                if (depth >= rh) continue; // 굴절 영역 밖: 변위 0
                const m = circleMap(1 - depth / rh);
                const g = gradSdRoundedRect(px, py, hx, hy, Math.min(r * 1.5, Math.min(hx, hy)));
                if (o.depth) {
                    const L = Math.hypot(px, py);
                    if (L > 1e-6) { g[0] += px / L; g[1] += py / L; }
                }
                const gl = Math.hypot(g[0], g[1]) || 1;
                const dx = -ra * m * g[0] / gl;
                const dy = -ra * m * g[1] / gl;
                vx[k] = dx; vy[k] = dy;
                maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy));
            }
        }

        const S = 2 * maxAbs; // feDisplacementMap: P(x + scale*(R-0.5)) → 채널값 = 0.5 + v/S
        const enc = v => clamp(Math.round((v / S + 0.5) * 255), 0, 255);
        const c = document.createElement("canvas");
        c.width = mw; c.height = mh;
        const ctx = c.getContext("2d");
        const img = ctx.createImageData(mw, mh);
        const d = img.data;
        for (let k = 0, p = 0; k < N; k++, p += 4) {
            d[p] = enc(vx[k]);
            d[p + 1] = enc(vy[k]);
            d[p + 2] = 128;
            d[p + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return { S, url: c.toDataURL("image/png") };
    }

    // Highlight: Default(45° 방향 가장자리 빛) / Plain(균일 림) — 1px 림 이미지
    function bakeRim(w, h, radii, style) {
        const sc = Math.min(window.devicePixelRatio || 1, 2);
        const cw = Math.max(8, Math.round(w * sc)), ch = Math.max(8, Math.round(h * sc));
        const hx = w / 2, hy = h / 2;
        const lw = 1.0;
        const alpha = style === "plain" ? 0.38 : 0.5;
        const n45x = Math.SQRT1_2, n45y = Math.SQRT1_2;
        const c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        const ctx = c.getContext("2d");
        const img = ctx.createImageData(cw, ch);
        const d = img.data;
        for (let j = 0, p = 0; j < ch; j++) {
            for (let i = 0; i < cw; i++, p += 4) {
                const px = (i + 0.5) / cw * w - hx;
                const py = (j + 0.5) / ch * h - hy;
                const r = radiusAt(px, py, radii);
                const sd = sdRoundedRect(px, py, hx, hy, r);
                const band = clamp(1 - Math.abs(sd + lw * 0.5) / (lw * 0.5 + 0.6), 0, 1);
                if (band <= 0) continue;
                let I = 1;
                if (style !== "plain") {
                    const g = gradSdRoundedRect(px, py, hx, hy, Math.min(r * 1.5, Math.min(hx, hy)));
                    I = Math.abs(g[0] * n45x + g[1] * n45y);
                }
                d[p] = 255; d[p + 1] = 255; d[p + 2] = 255;
                d[p + 3] = Math.round(255 * band * I * alpha);
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL("image/png");
    }

    /* ---------- 3. 표면 설정 (Kyant 컴포넌트의 effects 파라미터 그대로) ---------- */
    const SURFACES = {
        // LiquidButton: blur 2dp, lens(12dp, 24dp), vibrancy
        search: { sel: ".mob-srch-wrap", blur: 2, rh: 12, ra: 24, vib: true, rim: "default" },
        // LiquidBottomTabs 컨테이너: blur 8dp, lens(24dp, 24dp), vibrancy
        nav: { sel: "#mob-nav", blur: 8, rh: 24, ra: 24, vib: true, rim: "default" },
        // 미니 플레이어 바: 탭 컨테이너와 같은 계열
        bar: { sel: "#bar", blur: 8, rh: 24, ra: 24, vib: true, rim: "default" },
        // LiquidBottomTabs 선택 썸: lens(10dp*p, 14dp*p) (분산 제외), Highlight.Default(p), InnerShadow(8dp*p, p)
        thumb: { sel: "#mnPill", blur: 0, rh: 10, ra: 14, vib: false, rim: "default", dynamic: true, inner: true },
        // 컨텍스트 메뉴: 팝업 계열 (Dialog 보다 작게)
        ctx: { sel: "#pl-ctx-menu", blur: 8, rh: 16, ra: 32, vib: true, rim: "plain", squircle: 20 },
        // DialogContent: blur 8dp(dark), lens(24dp, 48dp, depthEffect), Highlight.Plain
        dialog: { sel: "#pl-dialog", blur: 8, rh: 24, ra: 48, depth: true, vib: true, rim: "plain", squircle: 28 },
        confirm: { sel: "#pl-confirm", blur: 8, rh: 24, ra: 48, depth: true, vib: true, rim: "plain", squircle: 28 },
        addmodal: { sel: "#pl-add-modal", blur: 8, rh: 24, ra: 48, depth: true, vib: true, rim: "plain", squircle: 30 },
    };
    const PRESS_SCALE = 1.25; // Kyant pressedScale(78/56) 는 56dp 썸 기준. 60px 내비 안에서 잘리지 않도록 상한

    /* ---------- 4. Continuous Corner (기존 squircle clip-path 유지) ---------- */
    function quarterSuperellipse(cx, cy, sx, sy, a0, a1, e, seg) {
        const pts = [];
        for (let i = 0; i <= seg; i++) {
            const a = a0 + (a1 - a0) * (i / seg);
            const c = Math.cos(a), s = Math.sin(a);
            pts.push([cx + sx * Math.sign(c) * Math.pow(Math.abs(c), 2 / e),
            cy + sy * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
        }
        return pts;
    }
    function squirclePath(w, h, radius, e) {
        const seg = 28;
        const r = Math.max(1, Math.min(radius, w / 2, h / 2));
        const pts = [
            ...quarterSuperellipse(r, r, r, r, Math.PI, Math.PI * 1.5, e, seg),
            ...quarterSuperellipse(w - r, r, r, r, Math.PI * 1.5, Math.PI * 2, e, seg),
            ...quarterSuperellipse(w - r, h - r, r, r, 0, Math.PI * 0.5, e, seg),
            ...quarterSuperellipse(r, h - r, r, r, Math.PI * 0.5, Math.PI, e, seg)
        ];
        let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
        for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
        return d + " Z";
    }
    function applyContinuousCorner(el, radius) {
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) return;
        const rad = Math.min(radius, w / 2, h / 2);
        const d = squirclePath(w, h, rad, 4.4);
        el.style.clipPath = `path("${d}")`;
        el.style.webkitClipPath = `path("${d}")`;
        el.style.borderRadius = rad + "px";
    }

    /* ---------- 5. SVG 필터 빌드 (백드롭 굴절) ---------- */
    let defsGroup = null;
    function defs() {
        if (!defsGroup) {
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("aria-hidden", "true");
            svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
            svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
            defsGroup = document.createElementNS(NS, "defs");
            svg.appendChild(defsGroup);
            document.body.appendChild(svg);
        }
        return defsGroup;
    }
    function node(tag, attrs, parent) {
        const n = document.createElementNS(NS, tag);
        for (const k in attrs) n.setAttribute(k, String(attrs[k]));
        if (parent) parent.appendChild(n);
        return n;
    }
    function buildFilter(st, w, h, lens) {
        const id = "lg-" + st.key;
        const old = document.getElementById(id);
        if (old) old.remove();
        const f = node("filter", {
            id, x: "-20%", y: "-20%", width: "140%", height: "140%",
            filterUnits: "objectBoundingBox", primitiveUnits: "userSpaceOnUse",
            "color-interpolation-filters": "sRGB"
        }, defs());
        let src = "SourceGraphic";
        // Kyant 순서: vibrancy → blur → lens
        if (st.cfg.vib) { node("feColorMatrix", { in: src, type: "saturate", values: "1.5", result: "vib" }, f); src = "vib"; }
        if (st.cfg.blur > 0) { node("feGaussianBlur", { in: src, stdDeviation: st.cfg.blur, result: "blr" }, f); src = "blr"; }
        node("feImage", { href: lens.url, x: 0, y: 0, width: w, height: h, preserveAspectRatio: "none", result: "map" }, f);
        const disp = node("feDisplacementMap", {
            in: src, in2: "map", scale: lens.S, xChannelSelector: "R", yChannelSelector: "G", result: "out"
        }, f);
        st.filterId = id;
        st.nodes = [disp];
        st.S = lens.S;
        st.el.style.backdropFilter = `url(#${id})`;
        st.el.style.webkitBackdropFilter = `url(#${id})`;
    }

    /* ---------- 6. 표면 등록 / 크기 기반 갱신 (캐시로 불필요한 재계산 제거) ---------- */
    const states = [];
    const lensCache = new Map();
    const rimCache = new Map();

    function cached(map, key, make) {
        let v = map.get(key);
        if (v === undefined) {
            if (map.size > 48) map.clear();
            v = make();
            map.set(key, v);
        }
        return v;
    }

    function attach(key, cfg, el) {
        const st = { key, cfg, el, size: null, S: 0, nodes: [], filterId: null, rim: null, inner: null };
        const rim = document.createElement("i");
        rim.className = "lg-rim";
        rim.setAttribute("aria-hidden", "true");
        el.insertBefore(rim, el.firstChild);
        st.rim = rim;
        if (cfg.inner) {
            const inner = document.createElement("b");
            inner.className = "lg-inner";
            inner.setAttribute("aria-hidden", "true");
            el.insertBefore(inner, rim.nextSibling);
            st.inner = inner;
        }
        el.dataset.lg = key;
        states.push(st);
        return st;
    }

    function measureRadii(el, w, h) {
        const cs = getComputedStyle(el);
        const lim = Math.min(w, h) / 2;
        return ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]
            .map(p => Math.min(parseFloat(cs[p]) || 0, lim));
    }

    function refresh(st) {
        const el = st.el;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) { st.size = null; return; } // display:none 등 — 다시 보이면 ResizeObserver 가 호출
        if (st.size && st.size[0] === w && st.size[1] === h) return;
        st.size = [w, h];
        const radii = measureRadii(el, w, h);
        const rkey = [st.key, w, h, radii.join(",")].join("|");

        if (SUPPORTS) {
            const cfg = st.cfg;
            const lens = cached(lensCache, rkey, () => buildLensMaps(w, h, {
                rh: Math.min(cfg.rh, Math.min(w, h) / 2), ra: cfg.ra, depth: !!cfg.depth, radii
            }));
            buildFilter(st, w, h, lens);
            st.rim.style.backgroundImage = `url(${cached(rimCache, rkey + "|" + cfg.rim, () => bakeRim(w, h, radii, cfg.rim))})`;
        }
        if (st.cfg.squircle) applyContinuousCorner(el, st.cfg.squircle);
        if (st.onResize) st.onResize();
        if (st.cfg.dynamic) kickNav();
    }

    let scheduled = false;
    function scheduleRefresh() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; states.forEach(refresh); });
    }

    /* ---------- 7. 하단 내비: Morphing Liquid 썸 (DampedDragAnimation + Kyant 굴절) ---------- */
    let kickNav = () => { };

    function setupNav() {
        const nav = $("#mob-nav");
        const thumbEl = $("#mnPill");
        if (!nav || !thumbEl) return;
        const btns = $$(".mn-btn", nav);
        const n = btns.length;
        if (!n) return;

        const thumbSt = states.find(s => s.key === "thumb");
        const navSt = states.find(s => s.key === "nav");

        // 선택 썸 아래에 "악센트색 복사본" 레이어를 깔고, 썸 영역만 보이도록 clip-path 로 잘라낸다.
        // 썸의 백드롭 굴절 결과가 Kyant 의 tabsBackdrop(강조색 라벨) 굴절과 같은 모습이 된다.
        const tint = document.createElement("div");
        tint.className = "lg-tint";
        tint.setAttribute("aria-hidden", "true");
        btns.forEach(b => {
            const c = b.cloneNode(true);
            c.removeAttribute("onclick"); c.removeAttribute("id"); c.removeAttribute("data-v");
            c.classList.remove("on"); c.tabIndex = -1;
            tint.appendChild(c);
        });
        const hl = document.createElement("div"); // InteractiveHighlight
        hl.className = "lg-hl";
        hl.setAttribute("aria-hidden", "true");
        nav.insertBefore(hl, btns[0]);
        nav.insertBefore(tint, btns[0]);
        nav.style.touchAction = "pan-y";

        const val = new Spring(0, 1000, 1);       // valueAnimationSpec
        const press = new Spring(0, 1000, 1);     // pressProgressAnimationSpec
        const sX = new Spring(1, 250, 0.6);       // scaleXAnimationSpec
        const sY = new Spring(1, 250, 0.7);       // scaleYAnimationSpec
        const hlP = new Spring(0, 300, 0.5);      // InteractiveHighlight pressProgress
        const all = [val, press, sX, sY, hlP];

        let thumbW = -1;
        let hlX = 0, hlY = 0;
        let drag = null;
        let raf = 0, last = 0;

        const idxOf = v => btns.findIndex(b => b.dataset.v === v);
        const curIdx = () => Math.max(0, btns.findIndex(b => b.classList.contains("on")));
        const xOf = v => {
            const i = Math.floor(clamp(v, 0, n - 1));
            const f = clamp(v - i, 0, 1);
            const b = btns[Math.min(i + 1, n - 1)];
            return lerp(btns[i].offsetLeft, b.offsetLeft, f);
        };
        const stepPx = () => (n > 1 ? (btns[1].offsetLeft - btns[0].offsetLeft) : btns[0].offsetWidth) || 1;

        function render() {
            const v = clamp(val.v, 0, n - 1);
            const p = clamp(press.v, 0, 1);
            const W = btns[0].offsetWidth - 6;
            const H = nav.clientHeight - 6;
            // stretch: Kyant 와 같이 속도에 따라 축 방향으로 늘어남
            const vN = val.x / 10;
            const sx = sX.v / (1 - clamp(vN * 0.75, -0.2, 0.2));
            const sy = sY.v * (1 - clamp(vN * 0.25, -0.2, 0.2));
            const x = xOf(v) + 3;

            if (W !== thumbW) { thumbEl.style.width = W + "px"; thumbW = W; }
            thumbEl.style.transform = `translate3d(${x.toFixed(2)}px,0,0) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;

            // 악센트 레이어 클립: 스케일된 썸 영역만 보이게
            const navW = nav.clientWidth, navH = nav.clientHeight;
            const cx = x + W / 2, cy = 3 + H / 2;
            const sw = W * sx, sh = H * sy;
            const cl = cx - sw / 2, cr = navW - (cx + sw / 2);
            const ct = cy - sh / 2, cb = navH - (cy + sh / 2);
            tint.style.clipPath = `inset(${ct.toFixed(2)}px ${cr.toFixed(2)}px ${cb.toFixed(2)}px ${cl.toFixed(2)}px round ${(sh / 2).toFixed(2)}px)`;

            // Kyant: lens(refractionHeight*p, refractionAmount*p) → 변위 스케일을 p 에 비례
            if (thumbSt && thumbSt.filterId) {
                const s = (thumbSt.S * p).toFixed(3);
                thumbSt.nodes.forEach(nd => nd.setAttribute("scale", s));
            }
            if (thumbSt) {
                thumbSt.rim.style.opacity = p.toFixed(3);                       // Highlight.Default.copy(alpha = p)
                if (thumbSt.inner) {
                    thumbSt.inner.style.boxShadow = p > 0.001
                        ? `inset 0 0 ${(8 * p).toFixed(2)}px rgba(0,0,0,${(0.25 * p).toFixed(3)})` : "none";
                }
            }

            // 컨테이너 press 스케일: lerp(1, 1 + 16dp / width, p)
            nav.style.transform = p > 0.001 ? `scale(${(1 + (16 / Math.max(1, navW)) * p).toFixed(4)})` : "";

            // InteractiveHighlight: 누른 위치에 방사형 빛
            const hp = clamp(hlP.v, 0, 1);
            if (hp > 0.001) {
                const R = Math.max(navW, navH) * 0.9;
                hl.style.opacity = "1";
                hl.style.background = `radial-gradient(circle at ${hlX.toFixed(1)}px ${hlY.toFixed(1)}px, rgba(255,255,255,${(0.15 * hp).toFixed(3)}) 0px, rgba(255,255,255,${(0.15 * hp * 0.5).toFixed(3)}) ${(R * 0.5).toFixed(1)}px, transparent ${R.toFixed(1)}px)`;
            } else {
                hl.style.opacity = "0";
            }
        }

        function tick(t) {
            raf = 0;
            const dt = last ? Math.min((t - last) / 1000, 1 / 30) : 1 / 60;
            last = t;
            all.forEach(s => s.step(dt));
            render();
            if (all.every(s => s.rest)) { last = 0; return; }
            raf = requestAnimationFrame(tick);
        }
        function kick() {
            if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
        }
        kickNav = kick;

        function setHL(e) {
            const r = nav.getBoundingClientRect();
            hlX = e.clientX - r.left; hlY = e.clientY - r.top;
        }

        /* 포인터: 탭은 기존 click → gv() 그대로. 가로 드래그가 생기면 썸이 손가락을 따라가고 놓을 때 가장 가까운 탭을 기존 click 으로 선택 */
        nav.addEventListener("pointerdown", e => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            drag = { id: e.pointerId, x0: e.clientX, v0: val.t, moved: false };
            press.t = 1; sX.t = PRESS_SCALE; sY.t = PRESS_SCALE; hlP.t = 1;
            setHL(e);
            kick();
        });
        nav.addEventListener("pointermove", e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x0;
            if (!drag.moved) {
                if (Math.abs(dx) < 6) { setHL(e); kick(); return; }
                drag.moved = true;
                try { nav.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
            val.t = clamp(drag.v0 + dx / stepPx(), 0, n - 1);
            setHL(e);
            kick();
        });
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            const moved = drag.moved;
            drag = null;
            press.t = 0; sX.t = 1; sY.t = 1; hlP.t = 0;
            if (moved) {
                const idx = clamp(Math.round(val.t), 0, n - 1);
                val.t = idx;
                if (idx !== curIdx()) btns[idx].click(); // 기존 onclick → gv() 경로 그대로 사용
            }
            kick();
        };
        nav.addEventListener("pointerup", end);
        nav.addEventListener("pointercancel", end);

        // 기존 gv() 를 감싸서, 탭이 바뀔 때 썸을 스프링으로 이동 (app.js 로직은 그대로 호출)
        function hookGv() {
            if (typeof window.gv !== "function") { setTimeout(hookGv, 50); return; }
            const original = window.gv;
            window.gv = function (v, el) {
                const r = original.apply(this, arguments);
                const i = idxOf(v);
                if (i >= 0 && !drag) { val.t = i; kick(); }
                return r;
            };
        }
        val.v = val.t = curIdx();
        hookGv();
        if (thumbSt) thumbSt.onResize = () => kick();
        if (navSt) navSt.onResize = () => kick();
        kick();
    }

    /* ---------- 8. 부트 ---------- */
    let ro = null;
    function boot() {
        if (SUPPORTS) defs();
        for (const key in SURFACES) {
            const cfg = SURFACES[key];
            $$(cfg.sel).forEach(el => attach(key, cfg, el));
        }
        setupNav();
        if ("ResizeObserver" in window) {
            ro = new ResizeObserver(() => scheduleRefresh());
            states.forEach(st => ro.observe(st.el));
        }
        scheduleRefresh();
        setTimeout(scheduleRefresh, 350); // 폰트/이미지 로드 이후 한 번 더 측정
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();
