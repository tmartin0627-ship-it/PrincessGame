// ═══════════════════════════════════════════════════════════════
// 3D CARD BOARD (Three.js r149, loaded from three.min.js)
// ═══════════════════════════════════════════════════════════════
// Renders the memory cards as real 3D cards lying on a play mat.
// It implements the same small interface as DomBoard in index.html
// (build / flipUp / flipDown / match / mismatch / celebrate /
// refreshBacks / clear), so the game rules never need to know which
// renderer is in use.
const Board3D = (() => {
  const CARD = 1;            // cards are square, 1 world unit wide
  const THICK = 0.055;       // card thickness
  const RADIUS = 0.12;       // corner radius
  const GAP = 0.2;           // space between cards
  const MAT_MARGIN = 0.42;   // play mat border around the cards
  const MAT_THICK = 0.12;
  const TEX = 512;           // card texture size in pixels
  const R_PX = RADIUS / CARD * TEX;
  const ELEV = 62 * Math.PI / 180; // camera angle above the table
  const EDGE = 0xfff6ee;     // card stock colour
  const GOLD = 0xffd54f;
  const SPARK_COLORS = ['#ffd54f', '#f48fb1', '#ce93d8', '#80deea', '#c5e1a5'];
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif';
  const TEXT_FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";

  let supported = null, ready = false;
  let container, renderer, scene, camera, hemi, sun;
  let cardsRoot, matGroup = null, raycaster, ndc, maxAniso = 1;
  let bodyGeo, backGeo, frontGeo, haloGeo, haloTex, sparkleTex;
  let backTex = null, backMat = null;
  let cardObjs = [], tweens = [], particles = [];
  let layout = null, onTap = null, downInfo = null;
  let reduceMotion = false, lastTime = 0, clock = 0;
  let camDist = 10;
  const camTarget = { x: 0, y: 0, z: 0 };

  // ── Setup ────────────────────────────────────────────────────
  function isSupported() {
    if (supported !== null) return supported;
    try {
      const c = document.createElement('canvas');
      supported = typeof THREE !== 'undefined' && !!window.WebGLRenderingContext &&
        !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { supported = false; }
    return supported;
  }

  function init(el) {
    if (ready) return true;
    if (!el || !isSupported()) return false;
    container = el;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) { supported = false; return false; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    maxAniso = renderer.capabilities.getMaxAnisotropy();
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    hemi = new THREE.HemisphereLight(0xffffff, 0xf3d1e4, 0.62);
    sun = new THREE.DirectionalLight(0xfff6ee, 0.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 4;
    scene.add(hemi, sun, sun.target);

    cardsRoot = new THREE.Group();
    scene.add(cardsRoot);
    raycaster = new THREE.Raycaster();
    ndc = new THREE.Vector2();

    const shape = roundedShape(CARD, CARD, RADIUS);
    bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: THICK, bevelEnabled: false, curveSegments: 8 });
    bodyGeo.translate(0, 0, -THICK / 2);
    backGeo = faceGeometry(shape, false);
    frontGeo = faceGeometry(shape, true);
    haloGeo = new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2);
    haloTex = makeHaloTexture();
    sparkleTex = makeSparkleTexture();
    reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

    const cv = renderer.domElement;
    cv.addEventListener('pointerdown', onPointerDown);
    cv.addEventListener('pointerup', onPointerUp);
    cv.addEventListener('pointermove', onPointerMove);
    cv.addEventListener('pointerleave', () => setHover(-1));
    cv.addEventListener('pointercancel', () => { downInfo = null; });
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 300));

    ready = true;
    lastTime = performance.now();
    requestAnimationFrame(tick);
    return true;
  }

  // Rounded square centred on the origin (used for geometry and canvases alike)
  function roundedShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  // A flat card face whose texture fills the rounded square exactly.
  // The front face points the other way, so it shows once the card turns.
  function faceGeometry(shape, front) {
    const g = new THREE.ShapeGeometry(shape, 8);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / CARD + 0.5, pos.getY(i) / CARD + 0.5);
    const z = THICK / 2 + 0.0015;
    if (front) g.rotateY(Math.PI);
    g.translate(0, 0, front ? -z : z);
    return g;
  }

  // ── Canvas helpers ───────────────────────────────────────────
  function makeCanvas(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function canvasTexture(cv) {
    const t = new THREE.CanvasTexture(cv);
    t.anisotropy = maxAniso;
    return t;
  }

  function disposeTexture(t) {
    if (!t) return;
    t.userData.dead = true; // late SVG loads must not draw into it
    t.dispose();
  }

  // Load an inline SVG string as an image (cached), sized from its viewBox
  const svgCache = new Map();
  function loadSvg(svg, cb) {
    if (!svg) return;
    if (svgCache.has(svg)) {
      const entry = svgCache.get(svg);
      if (entry.img) cb(entry.img); else entry.waiting.push(cb);
      return;
    }
    const entry = { img: null, waiting: [cb] };
    svgCache.set(svg, entry);
    const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
    const [, , vw, vh] = vb ? vb.split(/[\s,]+/).map(Number) : [0, 0, 100, 100];
    const sized = /<svg[^>]*\swidth=/.test(svg) ? svg
      : svg.replace('<svg', `<svg width="${vw * 10}" height="${vh * 10}"`);
    const img = new Image();
    img.onload = () => { entry.img = img; entry.waiting.forEach(f => f(img)); entry.waiting = []; };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
  }

  // Shrink a font until the text fits the given width
  function fitFont(ctx, text, weight, size, maxW, family) {
    let s = size;
    ctx.font = `${weight} ${s}px ${family}`;
    while (s > 12 && ctx.measureText(text).width > maxW) {
      s -= 4;
      ctx.font = `${weight} ${s}px ${family}`;
    }
    return s;
  }

  function cssColors(gradient, fallback) {
    const found = gradient && gradient.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi);
    return found && found.length ? found : fallback;
  }

  // ── Textures ────────────────────────────────────────────────
  function makeBackTexture(back) {
    const cv = makeCanvas(TEX, TEX), ctx = cv.getContext('2d');
    const colors = cssColors(back && back.gradient, ['#d81b60', '#8e24aa', '#e91e90']);
    const border = (back && back.border) || '#f8bbd0';
    const tex = canvasTexture(cv);
    const draw = (img) => {
      ctx.clearRect(0, 0, TEX, TEX);
      ctx.fillStyle = border;
      ctx.fillRect(0, 0, TEX, TEX);
      const bw = 16;
      const g = ctx.createLinearGradient(0, 0, TEX, TEX);
      colors.forEach((c, k) => g.addColorStop(colors.length > 1 ? k / (colors.length - 1) : 0, c));
      roundRectPath(ctx, bw, bw, TEX - 2 * bw, TEX - 2 * bw, R_PX - bw);
      ctx.fillStyle = g;
      ctx.fill();
      const sheen = ctx.createLinearGradient(0, 0, 0, TEX);
      sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
      sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fill();
      if (img) {
        const boxH = TEX * 0.72, ratio = img.width / img.height;
        const h = ratio > 1 ? boxH / ratio : boxH, w = h * ratio;
        ctx.globalAlpha = 0.75;
        ctx.drawImage(img, (TEX - w) / 2, (TEX - h) / 2, w, h);
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([22, 14]);
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      roundRectPath(ctx, 40, 40, TEX - 80, TEX - 80, R_PX - 30);
      ctx.stroke();
      ctx.setLineDash([]);
      tex.needsUpdate = true;
    };
    draw(null);
    loadSvg(back && back.pattern, img => { if (!tex.userData.dead) draw(img); });
    return tex;
  }

  function drawStar(ctx, cx, cy, outer, inner, points) {
    ctx.beginPath();
    for (let k = 0; k < points * 2; k++) {
      const r = k % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + k * Math.PI / points;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  function makeFrontTexture(spec) {
    const cv = makeCanvas(TEX, TEX), ctx = cv.getContext('2d');
    const tex = canvasTexture(cv);
    const bg = spec.kind === 'text' ? (spec.bg || '#ffffff') : '#ffffff';
    ctx.fillStyle = '#f8bbd0';
    ctx.fillRect(0, 0, TEX, TEX);
    roundRectPath(ctx, 14, 14, TEX - 28, TEX - 28, R_PX - 14);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (spec.kind === 'joker') {
      ctx.beginPath();
      ctx.arc(TEX / 2, TEX * 0.43, TEX * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff9c4';
      ctx.fill();
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#f9a825';
      ctx.stroke();
      drawStar(ctx, TEX / 2, TEX * 0.44, TEX * 0.22, TEX * 0.09, 5);
      ctx.fillStyle = '#ffd54f';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.stroke();
      fitFont(ctx, 'BONUS!', 800, 72, TEX * 0.8, TEXT_FONT);
      ctx.fillStyle = '#e65100';
      ctx.fillText('BONUS!', TEX / 2, TEX * 0.85);
    } else if (spec.kind === 'emoji') {
      const label = spec.label || '';
      const drawLabel = () => {
        if (!label) return;
        fitFont(ctx, label, 700, 54, TEX * 0.86, TEXT_FONT);
        ctx.fillStyle = '#ad1457';
        ctx.fillText(label, TEX / 2, TEX * 0.86);
      };
      if (spec.emoji) {
        ctx.font = `${Math.round(TEX * 0.5)}px ${EMOJI_FONT}`;
        ctx.fillText(spec.emoji, TEX / 2, TEX * (label ? 0.43 : 0.5));
        drawLabel();
      } else if (spec.svg) {
        drawLabel();
        loadSvg(spec.svg, img => {
          if (tex.userData.dead) return;
          const s = TEX * 0.62;
          ctx.drawImage(img, (TEX - s) / 2, TEX * 0.1, s, s * img.height / img.width);
          tex.needsUpdate = true;
        });
      }
    } else {
      const text = spec.text || '';
      const len = text.length;
      const start = len <= 2 ? TEX * 0.46 : len <= 3 ? TEX * 0.36 : len <= 4 ? TEX * 0.3 : TEX * 0.24;
      fitFont(ctx, text, 800, Math.round(start), TEX * 0.8, TEXT_FONT);
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillText(text, TEX / 2 + 4, TEX / 2 + 8);
      ctx.fillStyle = spec.color || '#ad1457';
      ctx.fillText(text, TEX / 2, TEX / 2 + 4);
    }
    tex.needsUpdate = true;
    return tex;
  }

  function makeHaloTexture() {
    const cv = makeCanvas(128, 128), ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,213,79,0.95)');
    g.addColorStop(0.5, 'rgba(255,193,7,0.45)');
    g.addColorStop(1, 'rgba(255,193,7,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  }

  function makeSparkleTexture() {
    const cv = makeCanvas(64, 64), ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    drawStar(ctx, 32, 32, 30, 9, 4);
    ctx.fill();
    return new THREE.CanvasTexture(cv);
  }

  // ── Play mat ─────────────────────────────────────────────────
  function disposeMat() {
    if (!matGroup) return;
    matGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { disposeTexture(o.material.map); o.material.dispose(); }
    });
    scene.remove(matGroup);
    matGroup = null;
  }

  function makeMat(lay) {
    disposeMat();
    matGroup = new THREE.Group();
    const w = lay.width, d = lay.depth;
    const shape = roundedShape(w, d, 0.32);

    const sideGeo = new THREE.ExtrudeGeometry(shape, { depth: MAT_THICK, bevelEnabled: false, curveSegments: 10 });
    sideGeo.rotateX(-Math.PI / 2);
    sideGeo.translate(0, -MAT_THICK, 0);
    const side = new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ color: 0xf8bbd0, roughness: 0.85 }));
    side.receiveShadow = true;

    // Quilted top: soft gradient, tiny stars and a stitched border
    const pw = 1024, ph = Math.max(64, Math.round(1024 * d / w));
    const cv = makeCanvas(pw, ph), ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, pw, ph);
    g.addColorStop(0, '#fff0f6');
    g.addColorStop(1, '#f3e6fb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, pw, ph);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const dots = ['#f48fb1', '#ce93d8', '#ffd54f', '#90caf9'];
    for (let k = 0; k < 70; k++) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = dots[k % dots.length];
      drawStar(ctx, rnd() * pw, rnd() * ph, 7 + rnd() * 6, 3, 5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const unit = pw / w, inset = 0.14 * unit;
    ctx.setLineDash([18, 12]);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(236,64,122,0.45)';
    roundRectPath(ctx, inset, inset, pw - 2 * inset, ph - 2 * inset, 0.32 * unit - inset * 0.6);
    ctx.stroke();
    const topTex = canvasTexture(cv);
    topTex.generateMipmaps = false;
    topTex.minFilter = THREE.LinearFilter;

    const topGeo = new THREE.ShapeGeometry(shape, 10);
    const pos = topGeo.attributes.position, uv = topGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / d + 0.5);
    topGeo.rotateX(-Math.PI / 2);
    topGeo.translate(0, 0.001, 0);
    const top = new THREE.Mesh(topGeo, new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.95 }));
    top.receiveShadow = true;

    // Soft contact shadow under the whole mat
    const scv = makeCanvas(256, 256), sctx = scv.getContext('2d');
    const sg = sctx.createRadialGradient(128, 128, 60, 128, 128, 128);
    sg.addColorStop(0, 'rgba(120,40,90,0.28)');
    sg.addColorStop(1, 'rgba(120,40,90,0)');
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 256, 256);
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.25, d * 1.3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(scv), transparent: true, depthWrite: false })
    );
    blob.position.y = -MAT_THICK - 0.02;

    matGroup.add(blob, side, top);
    scene.add(matGroup);

    const span = Math.max(w, d) / 2 + 1.5;
    sun.position.set(-w * 0.35 - 2, 7.5, d * 0.3 + 3);
    sun.target.position.set(0, 0, 0);
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: 25 });
    sun.shadow.camera.updateProjectionMatrix();
  }

  // ── Layout & camera ─────────────────────────────────────────
  function availableHeight() {
    const top = container.getBoundingClientRect().top;
    return Math.max(240, Math.floor(window.innerHeight - Math.max(0, top) - 14));
  }

  function sizeContainer() {
    container.style.height = availableHeight() + 'px';
  }

  // Pick the grid that makes the cards biggest on this screen
  // (e.g. 3 × 4 on a phone held upright, 4 × 3 on a tablet in landscape).
  function chooseLayout(n, pref) {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    let best = null;
    for (let c = 2; c <= 5; c++) {
      const r = Math.ceil(n / c);
      if (r < 1 || (c > n && n > 1)) continue;
      const bw = c * (CARD + GAP) - GAP + 2 * MAT_MARGIN;
      const bd = r * (CARD + GAP) - GAP + 2 * MAT_MARGIN;
      const empty = r * c - n;
      const score = Math.min(w / bw, h / (bd * Math.sin(ELEV) + 0.6)) *
        (c === pref ? 1.04 : 1) * (1 - 0.05 * empty);
      if (!best || score > best.score) best = { cols: c, rows: r, score };
    }
    return {
      cols: best.cols, rows: best.rows, pref,
      width: best.cols * (CARD + GAP) - GAP + 2 * MAT_MARGIN,
      depth: best.rows * (CARD + GAP) - GAP + 2 * MAT_MARGIN
    };
  }

  function slotPosition(i, n, lay) {
    const row = Math.floor(i / lay.cols), col = i % lay.cols;
    const inRow = Math.min(lay.cols, n - row * lay.cols);
    const pitch = CARD + GAP;
    return { row, col, x: (col - (inRow - 1) / 2) * pitch, z: (row - (lay.rows - 1) / 2) * pitch };
  }

  const _v = { a: null };
  function placeCamera(dist, sway) {
    const yaw = sway || 0;
    camera.position.set(
      camTarget.x + Math.sin(yaw) * Math.cos(ELEV) * dist,
      camTarget.y + Math.sin(ELEV) * dist,
      camTarget.z + Math.cos(yaw) * Math.cos(ELEV) * dist
    );
    camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
    camera.updateMatrixWorld();
  }

  // Move the camera back just far enough that the mat (plus room for cards
  // lifting off it) fills the view, then centre it vertically.
  function fitCamera() {
    if (!layout) return;
    if (!_v.a) _v.a = new THREE.Vector3();
    const hw = layout.width / 2, hd = layout.depth / 2;
    const cw = hw - MAT_MARGIN + 0.15, cd = hd - MAT_MARGIN + 0.15; // where cards can lift
    const pts = [];
    [-hw, hw].forEach(x => [-hd, hd].forEach(z => [-MAT_THICK, 0].forEach(y => pts.push([x, y, z]))));
    [-cw, cw].forEach(x => [-cd, cd].forEach(z => pts.push([x, 0.75, z])));
    const range = () => {
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      pts.forEach(p => {
        const q = _v.a.set(p[0], p[1], p[2]).project(camera);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      });
      return { minX, maxX, minY, maxY };
    };
    camTarget.x = 0; camTarget.y = 0; camTarget.z = 0;
    for (let iter = 0; iter < 4; iter++) {
      let lo = 1, hi = 80;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        placeCamera(mid);
        const r = range();
        if (r.minX >= -0.95 && r.maxX <= 0.95 && r.minY >= -0.93 && r.maxY <= 0.93) hi = mid; else lo = mid;
      }
      camDist = hi;
      placeCamera(camDist);
      const r = range();
      const cy = (r.minY + r.maxY) / 2;
      camTarget.z -= cy * camDist * Math.tan(camera.fov * Math.PI / 360) / Math.sin(ELEV);
    }
    placeCamera(camDist);
  }

  function resize() {
    if (!ready) return;
    sizeContainer();
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (layout && cardObjs.length) {
      const next = chooseLayout(cardObjs.length, layout.pref);
      if (next.cols !== layout.cols) {
        layout = next;
        makeMat(layout);
        cardObjs.forEach((c, i) => {
          const p = slotPosition(i, cardObjs.length, layout);
          Object.assign(c, { baseX: p.x, baseZ: p.z, row: p.row, col: p.col });
          c.halo.position.set(p.x, 0.003, p.z);
        });
      }
    }
    fitCamera();
  }

  // ── Cards ───────────────────────────────────────────────────
  function makeBackMaterial(back) {
    disposeTexture(backTex);
    backTex = makeBackTexture(back);
    if (!backMat) backMat = new THREE.MeshStandardMaterial({ roughness: 0.45 });
    backMat.map = backTex;
    backMat.needsUpdate = true;
  }

  function makeCard(i, spec, p) {
    const group = new THREE.Group();   // sits on the mat, lifts and spins
    const flipper = new THREE.Group(); // turns the card over
    const body = new THREE.Group();    // lays the card flat
    body.rotation.x = -Math.PI / 2;
    flipper.position.y = THICK / 2;
    const edgeMat = new THREE.MeshStandardMaterial({ color: EDGE, roughness: 0.7, emissive: 0x000000 });
    const frontTex = makeFrontTexture(spec);
    const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.85 });
    const meshes = [new THREE.Mesh(bodyGeo, edgeMat), new THREE.Mesh(backGeo, backMat), new THREE.Mesh(frontGeo, frontMat)];
    meshes.forEach(m => { m.castShadow = true; m.receiveShadow = true; m.userData.index = i; });
    body.add(...meshes);
    flipper.add(body);
    group.add(flipper);
    group.userData.index = i;

    const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.raycast = () => {};
    halo.position.set(p.x, 0.003, p.z);
    cardsRoot.add(halo, group);

    return {
      index: i, group, flipper, edgeMat, frontMat, frontTex, halo, haloMat,
      baseX: p.x, baseZ: p.z, row: p.row, col: p.col,
      angle: 0, flipLift: 0, celLift: 0, hover: 0, hoverTarget: 0,
      spinY: 0, wobbleY: 0, dealX: 0, dealY: 0, dealZ: 0,
      glow: 0, matched: false, slots: {}
    };
  }

  function applyCard(c) {
    c.group.position.set(c.baseX + c.dealX, c.flipLift + c.celLift + c.hover + c.dealY, c.baseZ + c.dealZ);
    c.group.rotation.y = c.spinY + c.wobbleY;
    c.flipper.rotation.z = c.angle;
  }

  function setGlow(c, k) {
    c.glow = k;
    c.edgeMat.color.setHex(EDGE).lerp(new THREE.Color(GOLD), k);
    c.edgeMat.emissive.setHex(GOLD).multiplyScalar(0.35 * k);
  }

  // ── Tweens ──────────────────────────────────────────────────
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const linear = t => t;

  // One running tween per card "slot", so a new flip smoothly takes over
  // from a flip that is still in progress.
  function animate(card, slot, dur, fn, opts) {
    const o = opts || {};
    const tw = { start: performance.now() + (o.delay || 0), dur: Math.max(1, dur), fn,
      ease: o.ease || easeInOut, done: o.done, onBegin: o.onBegin, card, slot };
    if (card) {
      if (card.slots[slot]) card.slots[slot].cancelled = true;
      card.slots[slot] = tw;
    }
    tweens.push(tw);
    return tw;
  }

  function runTweens(now) {
    const list = tweens;
    for (let k = 0; k < list.length; k++) {
      const tw = list[k];
      if (tw.cancelled || tw.finished) continue;
      const p = (now - tw.start) / tw.dur;
      if (p < 0) continue;
      if (!tw.began) { tw.began = true; if (tw.onBegin) tw.onBegin(); }
      const t = Math.min(1, p);
      tw.fn(tw.ease(t), t);
      if (t >= 1) {
        tw.finished = true;
        if (tw.card && tw.card.slots[tw.slot] === tw) tw.card.slots[tw.slot] = null;
        if (tw.done) tw.done();
      }
    }
    tweens = tweens.filter(tw => !tw.cancelled && !tw.finished);
  }

  function flipTo(c, target) {
    const a0 = c.angle, l0 = c.flipLift;
    animate(c, 'flip', reduceMotion ? 200 : 440, (e, t) => {
      c.angle = a0 + (target - a0) * e;
      c.flipLift = l0 * (1 - e) + Math.sin(Math.PI * t) * 0.42;
    });
  }

  // ── Effects ─────────────────────────────────────────────────
  function burst(c) {
    const origin = new THREE.Vector3(c.baseX, 0.35, c.baseZ);
    for (let k = 0; k < 16; k++) {
      const mat = new THREE.SpriteMaterial({ map: sparkleTex, color: new THREE.Color(SPARK_COLORS[k % SPARK_COLORS.length]),
        transparent: true, depthWrite: false });
      const s = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2, speed = 1.1 + Math.random() * 1.4;
      s.position.copy(origin);
      s.userData = { vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, vy: 1.8 + Math.random() * 1.6,
        life: 0, max: 0.75 + Math.random() * 0.4, size: 0.13 + Math.random() * 0.12 };
      s.scale.setScalar(s.userData.size);
      scene.add(s);
      particles.push(s);
    }
  }

  function updateParticles(dt) {
    particles = particles.filter(s => {
      const u = s.userData;
      u.life += dt;
      if (u.life >= u.max) { scene.remove(s); s.material.dispose(); return false; }
      u.vy -= 5 * dt;
      s.position.x += u.vx * dt;
      s.position.y = Math.max(0.05, s.position.y + u.vy * dt);
      s.position.z += u.vz * dt;
      s.material.opacity = 1 - u.life / u.max;
      s.material.rotation += dt * 4;
      return true;
    });
  }

  // ── Input ───────────────────────────────────────────────────
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(cardsRoot.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.index === undefined) o = o.parent;
      if (o) return o.userData.index;
    }
    return -1;
  }

  function setHover(i) {
    cardObjs.forEach(c => { c.hoverTarget = (c.index === i && !c.matched) ? 0.07 : 0; });
    if (renderer) renderer.domElement.style.cursor = i >= 0 ? 'pointer' : 'default';
  }

  function onPointerDown(ev) {
    downInfo = { i: pick(ev), x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  }

  function onPointerUp(ev) {
    if (!downInfo || downInfo.id !== ev.pointerId) return;
    const moved = Math.hypot(ev.clientX - downInfo.x, ev.clientY - downInfo.y);
    const i = pick(ev);
    const start = downInfo.i;
    downInfo = null;
    if (i >= 0 && i === start && moved < 30 && onTap) onTap(i);
  }

  function onPointerMove(ev) {
    if (ev.pointerType === 'mouse') setHover(pick(ev));
  }

  // ── Frame loop ──────────────────────────────────────────────
  function isVisible() {
    if (!document.body.classList.contains('mode-3d')) return false;
    const gs = document.getElementById('gameScreen');
    return !!gs && gs.classList.contains('visible');
  }

  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now(); // same clock as animate()
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    runTweens(now);
    if (!isVisible() || !layout) return;
    clock += dt;
    const k = Math.min(1, dt * 12);
    cardObjs.forEach(c => {
      c.hover += (c.hoverTarget - c.hover) * k;
      applyCard(c);
      if (c.matched) c.haloMat.opacity = c.glow * (0.6 + 0.25 * Math.sin(clock * 2.4 + c.index));
    });
    updateParticles(dt);
    placeCamera(camDist, reduceMotion ? 0 : Math.sin(clock * 0.35) * 0.035);
    renderer.render(scene, camera);
  }

  // ── Public interface ────────────────────────────────────────
  function clear() {
    tweens.forEach(tw => { tw.cancelled = true; });
    tweens = [];
    cardObjs.forEach(c => {
      disposeTexture(c.frontTex);
      c.frontMat.dispose();
      c.edgeMat.dispose();
      c.haloMat.dispose();
      cardsRoot.remove(c.group, c.halo);
    });
    cardObjs = [];
    particles.forEach(s => { scene.remove(s); s.material.dispose(); });
    particles = [];
    downInfo = null;
  }

  function deal(onDealt) {
    const n = cardObjs.length;
    if (!n) { if (onDealt) onDealt(); return; }
    cardObjs.forEach((c, i) => {
      const s0 = (Math.random() - 0.5) * Math.PI;
      const y0 = 1.3 + i * 0.04;
      // Start as a deck hovering over the middle of the mat
      Object.assign(c, { dealX: -c.baseX, dealZ: -c.baseZ, dealY: y0, spinY: s0 });
      applyCard(c);
      animate(c, 'deal', reduceMotion ? 250 : 560, (e, t) => {
        c.dealX = -c.baseX * (1 - e);
        c.dealZ = -c.baseZ * (1 - e);
        c.dealY = y0 * (1 - e) + Math.sin(Math.PI * t) * 0.5;
        c.spinY = s0 * (1 - e);
      }, {
        delay: 150 + (n - 1 - i) * (reduceMotion ? 30 : 75),
        ease: easeOut,
        onBegin: () => { if (typeof Sound !== 'undefined') Sound.deal(n - 1 - i, n); },
        done: () => {
          Object.assign(c, { dealX: 0, dealY: 0, dealZ: 0, spinY: 0 });
          if (i === 0 && onDealt) onDealt();
        }
      });
    });
  }

  function build(specs, cols, opts) {
    const o = opts || {};
    clear();
    onTap = o.onTap || null;
    sizeContainer();
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    layout = chooseLayout(specs.length, cols);
    makeBackMaterial(o.back);
    makeMat(layout);
    specs.forEach((spec, i) => cardObjs.push(makeCard(i, spec, slotPosition(i, specs.length, layout))));
    fitCamera();

    if (o.states) {
      o.states.forEach((s, i) => {
        const c = cardObjs[i];
        if (!c) return;
        if (s.up || s.matched) c.angle = Math.PI;
        if (s.matched) { c.matched = true; setGlow(c, 1); }
      });
      cardObjs.forEach(applyCard);
      if (o.onDealt) o.onDealt();
    } else {
      deal(o.onDealt);
    }
  }

  function flipUp(i) { const c = cardObjs[i]; if (c) flipTo(c, Math.PI); }
  function flipDown(i) { const c = cardObjs[i]; if (c && !c.matched) flipTo(c, 0); }

  function match(i) {
    const c = cardObjs[i];
    if (!c) return;
    c.matched = true;
    c.hoverTarget = 0;
    const a0 = c.angle, l0 = c.flipLift;
    animate(c, 'flip', reduceMotion ? 300 : 720, (e, t) => {
      c.angle = a0 + (Math.PI - a0) * Math.min(1, t * 2);
      c.flipLift = l0 * (1 - e) + Math.sin(Math.PI * t) * 0.6;
    }, { ease: easeOut });
    animate(c, 'fx', reduceMotion ? 300 : 720, e => { c.spinY = e * Math.PI * 2; },
      { done: () => { c.spinY = 0; } });
    animate(c, 'glow', 450, e => setGlow(c, e), { delay: 200 });
    burst(c);
  }

  function mismatch(a, b) {
    [a, b].forEach(i => {
      const c = cardObjs[i];
      if (!c) return;
      animate(c, 'wobble', 420, (e, t) => { c.wobbleY = Math.sin(t * Math.PI * 5) * 0.13 * (1 - t); },
        { ease: linear, delay: 380, done: () => { c.wobbleY = 0; } });
    });
  }

  // A happy wave across the board when the last pair is found
  function celebrate() {
    cardObjs.forEach(c => {
      animate(c, 'cel', 520, (e, t) => { c.celLift = Math.sin(Math.PI * t) * 0.4; },
        { delay: 450 + (c.row + c.col) * 90, ease: linear, done: () => { c.celLift = 0; } });
    });
  }

  function refreshBacks(back) {
    if (!ready) return;
    makeBackMaterial(back);
  }

  return { isSupported, init, build, clear, flipUp, flipDown, match, mismatch, celebrate, refreshBacks, resize };
})();
