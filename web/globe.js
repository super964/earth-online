/* EarthOnline — Three.js 地球场景
 * 昼夜混合着色器 / 大气辉光 / 云层 / 星空 / 真实太阳方向
 * 图层点云(地震、火山、野火) / 警报多边形 / 台风路径 / ISS / 极光
 * 自定义轨道控制 + 射线拾取
 */
"use strict";

const Globe = (() => {
  const R = 100;                      // 地球半径(场景单位)
  const DEG = Math.PI / 180;
  let renderer, scene, camera, canvas;
  let earthMesh, cloudMesh, glowMesh, starMesh, sunDir;
  let textureLoader;
  const layers = {};                  // id -> THREE.Object3D
  const pickables = [];               // 可拾取对象
  let raycaster, pointer;
  let hp = { theta: 2.35, phi: 1.25, dist: 340 };   // 目标视角
  let cp = { ...hp };                 // 当前视角(平滑跟随)
  let dragging = false, lastX = 0, lastY = 0;
  let idleSince = performance.now();
  let onSelect = null, onHover = null, onCoords = null;
  let hovered = null;
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();

  // ------------------------------------------------------------ 工具
  function latLonToVec3(lat, lon, r) {
    const phi = (90 - lat) * DEG;
    const theta = (lon + 180) * DEG;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }

  // NOAA 太阳直射点(真实 UTC)
  function subsolar(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
    let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG;
    const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
    let lon = ((ra - gmst * 15 + 180) % 360 + 360) % 360 - 180;
    return { lat: dec, lon };
  }

  function facing(pos) { // 标记是否朝向相机(不被地球遮挡)
    camera.getWorldPosition(tmpV);
    return pos.clone().normalize().dot(tmpV.sub(pos).normalize()) > 0.02;
  }

  // ------------------------------------------------------------ 着色器
  const EARTH_VS = `
    varying vec2 vUv; varying vec3 vN;
    void main(){
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }`;
  const EARTH_FS = `
    uniform sampler2D dayMap, nightMap, waterMap;
    uniform vec3 uSun; uniform float uNightBoost;
    varying vec2 vUv; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      float sun = dot(n, uSun);
      float day = smoothstep(-0.10, 0.14, sun);
      vec3 dayC = texture2D(dayMap, vUv).rgb;
      vec3 nightC = texture2D(nightMap, vUv).rgb;
      float water = texture2D(waterMap, vUv).r;
      // 白天:光照随太阳高度衰减;夜晚:城市灯光
      vec3 lit = dayC * (0.28 + 0.85 * smoothstep(-0.05, 0.55, sun));
      vec3 dark = nightC * uNightBoost * vec3(1.0, 0.86, 0.62);
      vec3 col = mix(dark, lit, day);
      // 晨昏线暖色
      float tw = 1.0 - smoothstep(0.0, 0.16, abs(sun));
      col += vec3(1.0, 0.42, 0.14) * tw * 0.16 * (0.3 + water * 0.7);
      // 大气边缘
      float fres = pow(1.0 - abs(dot(n, vec3(0.0,0.0,1.0))), 2.5);
      col += vec3(0.22, 0.55, 1.0) * fres * 0.10;
      gl_FragColor = vec4(col, 1.0);
    }`;

  const CLOUD_FS = `
    uniform sampler2D map; uniform vec3 uSun; uniform float uOpacity;
    varying vec2 vUv; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      float day = smoothstep(-0.12, 0.18, dot(n, uSun));
      float a = texture2D(map, vUv).r * uOpacity;
      vec3 col = mix(vec3(0.05,0.08,0.14), vec3(1.0), day);
      gl_FragColor = vec4(col, a);
    }`;

  const GLOW_VS = `
    varying vec3 vN; varying vec3 vP;
    void main(){
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 mv = modelViewMatrix * vec4(position,1.0);
      vP = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`;
  const GLOW_FS = `
    uniform vec3 uColor; uniform float uPower, uStrength;
    varying vec3 vN; varying vec3 vP;
    void main(){
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), uPower);
      gl_FragColor = vec4(uColor, f * uStrength);
    }`;

  // 点云(地震/火山/野火共用)
  const PTS_VS = `
    attribute float aSize; attribute vec3 aColor; attribute float aBirth;
    uniform float uTime, uScale, uSizeMul;
    varying vec3 vColor; varying float vFresh;
    void main(){
      vColor = aColor;
      float age = (aBirth > 0.0) ? (uTime - aBirth) : 1e9;
      vFresh = (age < 5400.0 && age >= 0.0) ? 1.0 : 0.0;
      float pulse = vFresh > 0.5 ? (1.0 + 0.30 * sin(uTime * 4.5 + aBirth * 0.01)) : 1.0;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = min(aSize * pulse * uSizeMul * uScale / max(-mv.z, 1.0), 96.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const PTS_FS = `
    uniform float uTime;
    varying vec3 vColor; varying float vFresh;
    void main(){
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      float alpha = smoothstep(0.5, 0.10, d);
      vec3 col = vColor;
      if (vFresh > 0.5) {
        float rr = fract(uTime * 0.85);
        float ring = smoothstep(0.055, 0.0, abs(d - (0.18 + 0.30 * rr)));
        ring *= (1.0 - rr);
        alpha = max(alpha, ring);
        col = mix(col, vec3(1.0), ring * 0.7);
      }
      gl_FragColor = vec4(col, alpha);
    }`;

  function makePoints(items, opts) {
    const n = items.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const birth = new Float32Array(n);
    items.forEach((it, i) => {
      const v = latLonToVec3(it.lat, it.lon, opts.radius || R + 0.5);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const c = new THREE.Color(it._color || opts.color || "#4ad9ff");
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = it._size || opts.size || 5;
      birth[i] = it._birth || 0;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aBirth", new THREE.BufferAttribute(birth, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: PTS_VS, fragmentShader: PTS_FS,
      uniforms: {
        uTime: { value: 0 }, uScale: { value: 420 },
        uSizeMul: { value: opts.sizeMul || 1 },
      },
      transparent: true, depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.userData = { kind: opts.kind, items };
    return pts;
  }

  // 细线(国界 / 路径)
  function makeLine(points, color, opacity, r) {
    const g = new THREE.BufferGeometry().setFromPoints(
      points.map((p) => latLonToVec3(p[1], p[0], r))
    );
    return new THREE.Line(g, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
    }));
  }

  // 闭合环(警报多边形 / 圆)
  function makeRing(points, color, opacity, r) {
    const pts = points.concat([points[0]]);
    return makeLine(pts, color, opacity, r);
  }

  // 平面环 -> 球面三角扇填充
  function makeFill(ring, color, opacity, r) {
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const center = latLonToVec3(cy, cx, r);
    const verts = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const va = latLonToVec3(a[1], a[0], r);
      const vb = latLonToVec3(b[1], b[0], r);
      verts.push(center.x, center.y, center.z, va.x, va.y, va.z, vb.x, vb.y, vb.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }));
  }

  // 画布贴图(光晕 / 台风图标)
  function glowTexture(inner = "rgba(140,240,255,1)", outer = "rgba(20,120,200,0)") {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const ctx = cv.getContext("2d");
    const gr = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    gr.addColorStop(0, inner);
    gr.addColorStop(0.25, inner.replace("1)", "0.75)"));
    gr.addColorStop(1, outer);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv);
    return t;
  }

  function typhoonTexture(color = "#ff5b7f") {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const ctx = cv.getContext("2d");
    ctx.translate(64, 64);
    ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineCap = "round";
    for (const dir of [1, -1]) {
      ctx.beginPath();
      for (let a = 0; a < 2.6; a += 0.08) {
        const rr = 8 + a * 16;
        const x = Math.cos(dir * a + (dir > 0 ? 0 : Math.PI)) * rr;
        const y = Math.sin(dir * a + (dir > 0 ? 0 : Math.PI)) * rr;
        a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill();
    return new THREE.CanvasTexture(cv);
  }

  // ------------------------------------------------------------ 初始化
  function init(cnv) {
    canvas = cnv;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 3000);
    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 3 };
    pointer = new THREE.Vector2();
    textureLoader = new THREE.TextureLoader();

    sunDir = new THREE.Vector3(1, 0, 0);
    const ss = subsolar(new Date());

    // 星空
    textureLoader.load("img/night-sky.png", (t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.encoding = THREE.sRGBEncoding;
      starMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1600, 48, 32),
        new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, depthWrite: false })
      );
      scene.add(starMesh);
    });

    // 地球
    const dayT = textureLoader.load("img/earth-day.jpg");
    dayT.encoding = THREE.sRGBEncoding;
    const nightT = textureLoader.load("img/earth-night.jpg");
    nightT.encoding = THREE.sRGBEncoding;
    const waterT = textureLoader.load("img/earth-water.png");
    earthMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: EARTH_VS, fragmentShader: EARTH_FS,
        uniforms: {
          dayMap: { value: dayT }, nightMap: { value: nightT }, waterMap: { value: waterT },
          uSun: { value: sunDir.clone() }, uNightBoost: { value: 2.6 },
        },
      })
    );
    scene.add(earthMesh);

    // 云层
    const cloudT = textureLoader.load("img/clouds.jpg");
    cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R + 1.6, 72, 48),
      new THREE.ShaderMaterial({
        vertexShader: EARTH_VS, fragmentShader: CLOUD_FS,
        uniforms: {
          map: { value: cloudT }, uSun: { value: sunDir.clone() },
          uOpacity: { value: 0.62 },
        },
        transparent: true, depthWrite: false,
      })
    );
    scene.add(cloudMesh);

    // 大气辉光(背面)
    glowMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.13, 64, 40),
      new THREE.ShaderMaterial({
        vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
        uniforms: {
          uColor: { value: new THREE.Color(0x3aa8ff) },
          uPower: { value: 3.2 }, uStrength: { value: 0.9 },
        },
        transparent: true, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    scene.add(glowMesh);

    // 太阳方向
    sunDir.copy(latLonToVec3(ss.lat, ss.lon, 1)).normalize();
    earthMesh.material.uniforms.uSun.value.copy(sunDir);
    cloudMesh.material.uniforms.uSun.value.copy(sunDir);

    // 图层容器
    for (const id of ["borders", "graticule", "quakes", "volcanoes", "wildfires",
      "typhoons", "hurricanes", "alerts", "aurora", "iss"]) {
      layers[id] = new THREE.Group();
      layers[id].visible = true;
      scene.add(layers[id]);
    }

    bindEvents();
    addEventListener("resize", onResize);
    renderer.setAnimationLoop(tick);
    return { subsolar: ss };
  }

  // ------------------------------------------------------------ 交互
  function bindEvents() {
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      idleSince = performance.now();
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        hp.theta -= dx * 0.005 * (cp.dist / 340);
        hp.phi = Math.max(0.14, Math.min(Math.PI - 0.14, hp.phi - dy * 0.005 * (cp.dist / 340)));
        idleSince = performance.now();
        if (onCoords) onCoords(e);
      } else if (onCoords) {
        onCoords(e);
      }
      hoverTest(e);
    });
    const up = () => { dragging = false; idleSince = performance.now(); };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      hp.dist = Math.max(128, Math.min(900, hp.dist * Math.pow(1.0013, e.deltaY)));
      idleSince = performance.now();
    }, { passive: false });
    canvas.addEventListener("click", (e) => {
      const hit = pick(e);
      if (hit && onSelect) onSelect(hit);
    });
    canvas.addEventListener("dblclick", (e) => {
      const ll = screenToLatLon(e.clientX, e.clientY);
      if (ll) focus(ll.lat, ll.lon, Math.min(hp.dist, 240));
    });
  }

  function pick(e) {
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    const objs = [];
    for (const id in layers) {
      if (!layers[id].visible) continue;
      layers[id].traverse((o) => { if (o.userData.kind || o.userData.pick) objs.push(o); });
    }
    const hits = raycaster.intersectObjects(objs, false);
    for (const h of hits) {
      const u = h.object.userData;
      if (u.kind === "quakes" || u.kind === "volcanoes" || u.kind === "wildfires") {
        if (h.index == null) continue;
        const item = u.items[h.index];
        if (item && facing(h.point)) return { kind: u.kind, item, point: h.point };
      } else if (u.pick) {
        if (facing(h.point)) return { kind: u.pick, item: u.item, point: h.point };
      }
    }
    return null;
  }

  function hoverTest(e) {
    const hit = pick(e);
    if (onHover) onHover(hit, e);
    canvas.style.cursor = hit ? "pointer" : dragging ? "grabbing" : "grab";
    hovered = hit;
  }

  function setPointer(e) {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function screenToLatLon(cx, cy) {
    setPointer({ clientX: cx, clientY: cy });
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(earthMesh, false)[0];
    if (!hit) return null;
    const p = hit.point.clone().normalize();
    const lat = Math.asin(p.y) / DEG;
    // 逆 latLonToVec3
    const theta = Math.atan2(p.z, -p.x) / DEG;      // = (lon+180)
    let lon = theta - 180;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return { lat, lon };
  }

  // ------------------------------------------------------------ 动画
  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  function tick() {
    const t = clock.getElapsedTime();
    const now = performance.now();

    // 空闲自转
    if (!dragging && now - idleSince > 5000) hp.theta -= 0.00042 * (t > 0 ? 1 : 1) * 16;

    // 平滑跟随
    const k = 0.10;
    cp.theta += (hp.theta - cp.theta) * k;
    cp.phi += (hp.phi - cp.phi) * k;
    cp.dist += (hp.dist - cp.dist) * k;

    camera.position.set(
      cp.dist * Math.sin(cp.phi) * Math.sin(cp.theta),
      cp.dist * Math.cos(cp.phi),
      cp.dist * Math.sin(cp.phi) * Math.cos(cp.theta)
    );
    camera.lookAt(0, 0, 0);

    // 点云 shader 时间 + 缩放补偿
    for (const id in layers) {
      layers[id].traverse((o) => {
        if (o.material && o.material.uniforms && o.material.uniforms.uTime) {
          o.material.uniforms.uTime.value = t;
          if (o.material.uniforms.uScale) o.material.uniforms.uScale.value = 420 * (cp.dist / 340);
        }
      });
    }

    // 云层缓慢漂移 + 太阳每日更新
    if (cloudMesh) cloudMesh.rotation.y += 0.000045;
    if (earthMesh) {
      const ss = subsolar(new Date());
      const sd = latLonToVec3(ss.lat, ss.lon, 1).normalize();
      sunDir.lerp(sd, 0.02);
      earthMesh.material.uniforms.uSun.value.copy(sunDir);
      if (cloudMesh) cloudMesh.material.uniforms.uSun.value.copy(sunDir);
    }

    if (starMesh) starMesh.rotation.y += 0.000004;
    renderer.render(scene, camera);
  }

  // ------------------------------------------------------------ 对外 API
  function clearLayer(id) {
    const g = layers[id];
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map && o.material.map.dispose && o.material.map.isCanvasTexture) o.material.map.dispose();
          o.material.dispose();
        }
      });
      g.remove(c);
    }
  }

  const api = {
    latLonToVec3,
    subsolar,
    _screenLatLon: screenToLatLon,
    setCloudsVisible(v) { if (cloudMesh) cloudMesh.visible = v; },

    init,
    on: { select: (fn) => (onSelect = fn), hover: (fn) => (onHover = fn), coords: (fn) => (onCoords = fn) },

    setVisible(id, v) { if (layers[id]) layers[id].visible = v; },

    focus(lat, lon, dist) {
      hp.phi = Math.max(0.14, Math.min(Math.PI - 0.14, (90 - lat) * DEG));
      // view lon = theta - 90 => theta = lon + 90
      hp.theta = (lon + 90) * DEG;
      if (dist) hp.dist = dist;
      idleSince = performance.now();
    },
    resetView() { hp = { theta: 2.35, phi: 1.25, dist: 340 }; idleSince = performance.now(); },
    camDist: () => cp.dist,

    setBorders(geo) {
      clearLayer("borders");
      const segs = [];
      const push = (ring) => {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], b = ring[i + 1];
          if (Math.abs(a[0] - b[0]) > 180) continue;   // 跨日期线断开
          const va = latLonToVec3(a[1], a[0], R + 0.4);
          const vb = latLonToVec3(b[1], b[0], R + 0.4);
          segs.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
        }
      };
      const walk = (geom) => {
        const t = geom.type, c = geom.coordinates;
        if (t === "Polygon") c.forEach(push);
        else if (t === "MultiPolygon") c.forEach((poly) => poly.forEach(push));
        else if (t === "LineString") push(c);
        else if (t === "MultiLineString") c.forEach(push);
      };
      (geo.features || geo).forEach((f) => {
        const g = f.geometry || f;
        if (!g) return;
        if (g.type === "GeometryCollection") (g.geometries || []).forEach(walk);
        else walk(g);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0x4ad9ff, transparent: true, opacity: 0.38, depthWrite: false,
      }));
      layers.borders.add(line);
    },

    setQuakes(list) {
      clearLayer("quakes");
      const items = list.filter((q) => q.mag != null && q.lat != null).map((q) => {
        const m = Math.max(0.5, q.mag);
        const d = Math.max(0, q.depth || 0);
        let color;
        if (d < 70) color = [0xff4d6d, 0xff7a45][m >= 5 ? 0 : 1];
        else if (d < 300) color = "#ffc53d";
        else color = "#9be15d";
        if (m >= 6) color = "#ff2d55";
        return {
          ...q, _color: color, _size: 2.4 + Math.pow(m, 1.75) * 0.85,
          _birth: q.time ? q.time : 0,
        };
      });
      const pts = makePoints(items, { kind: "quakes", radius: R + 0.6 });
      layers.quakes.add(pts);
      return items.length;
    },

    setVolcanoes(list) {
      clearLayer("volcanoes");
      const items = list.map((v) => ({
        ...v,
        _color: v.recent ? "#ff6b35" : "#7e95b5",
        _size: v.recent ? 6.5 : 4.2,
      }));
      layers.volcanoes.add(makePoints(items, { kind: "volcanoes", radius: R + 0.5 }));
      return items.length;
    },

    setWildfires(list) {
      clearLayer("wildfires");
      const items = list.map((w) => ({ ...w, _color: "#ff9f1c", _size: 4.6 }));
      layers.wildfires.add(makePoints(items, { kind: "wildfires", radius: R + 0.5 }));
      return items.length;
    },

    setAlerts(list) {
      clearLayer("alerts");
      const sevColor = { Extreme: "#ff2d55", Severe: "#ffb703", Moderate: "#4ad9ff" };
      let n = 0;
      for (const a of list) {
        if (!a.rings || !a.rings.length) continue;
        const col = sevColor[a.severity] || "#ffb703";
        const g = new THREE.Group();
        for (const ring of a.rings) {
          let cross = false;
          for (let i = 0; i < ring.length - 1; i++)
            if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) cross = true;
          if (!cross) {
            const fill = makeFill(ring, col, 0.16, R + 0.9);
            fill.userData = { pick: "alert", item: a };
            g.add(fill);
          }
          g.add(makeRing(ring, col, 0.75, R + 1.0));
        }
        layers.alerts.add(g);
        n++;
      }
      return n;
    },

    setTyphoons(list) {
      clearLayer("typhoons");
      const texT = typhoonTexture("#ff5b7f");
      for (const tc of list) {
        const g = new THREE.Group();
        const track = tc.track || [];
        if (track.length > 1) {
          g.add(makeLine(track.map((p) => [p.lon, p.lat]), "#ff8fa3", 0.9, R + 1.4));
        }
        // 预报不确定圈
        for (const p of track) {
          if (!p.hours) continue;
          const km = p.hours <= 24 ? 40 + p.hours * 8 : 95 + p.hours * 3;
          const dLat = km / 111.32, dLon = km / (111.32 * Math.cos(p.lat * DEG) || 1);
          const ring = [];
          for (let a = 0; a <= 36; a++) {
            const th = (a / 36) * Math.PI * 2;
            ring.push([p.lon + Math.cos(th) * dLon, p.lat + Math.sin(th) * dLat]);
          }
          g.add(makeRing(ring, "#ff8fa3", p.hours % 12 === 0 ? 0.55 : 0.22, R + 1.3));
        }
        const cur = tc.current || track[0];
        if (cur) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texT, transparent: true, depthTest: true, opacity: 0.95,
          }));
          sp.position.copy(latLonToVec3(cur.lat, cur.lon, R + 3));
          sp.scale.set(9, 9, 1);
          sp.userData = { pick: "typhoon", item: tc };
          g.add(sp);
        }
        layers.typhoons.add(g);
      }
      return list.length;
    },

    setHurricanes(list) {
      clearLayer("hurricanes");
      const texT = typhoonTexture("#ffb703");
      for (const st of list) {
        const g = new THREE.Group();
        const cone = st.cone || [];
        if (cone.length > 2) {
          let cross = false;
          for (let i = 0; i < cone.length - 1; i++)
            if (Math.abs(cone[i][0] - cone[i + 1][0]) > 180) cross = true;
          if (!cross) {
            const fill = makeFill(cone, "#ffb703", 0.14, R + 1.1);
            fill.userData = { pick: "hurricane", item: st };
            g.add(fill);
            g.add(makeRing(cone, "#ffb703", 0.7, R + 1.2));
          }
        }
        if (st.track_line && st.track_line.length > 1)
          g.add(makeLine(st.track_line, "#ffd166", 0.9, R + 1.4));
        const fc = st.forecast || [];
        const cur = fc[0];
        if (cur) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texT, transparent: true, opacity: 0.95,
          }));
          sp.position.copy(latLonToVec3(cur.lat, cur.lon, R + 3));
          sp.scale.set(9, 9, 1);
          sp.userData = { pick: "hurricane", item: st };
          g.add(sp);
        }
        layers.hurricanes.add(g);
      }
      return list.length;
    },

    // 极光卵形带(Kp 驱动,地磁极偏移)
    setAurora(kp) {
      clearLayer("aurora");
      kp = Math.max(0, Math.min(9, kp || 0));
      const strength = 0.18 + (kp / 9) * 0.82;
      const poles = [
        { lat: 80.7, lon: -72.7 },
        { lat: -80.7, lon: 107.3 },
      ];
      const nAz = 240, nLat = 14;
      const positions = [], colors = [], sizes = [], births = [];
      const baseLat = 66.5 - kp * 1.9;           // 卵形带中心纬度
      const width = 3.2 + kp * 0.55;
      const col = new THREE.Color();
      for (const pole of poles) {
        // 以磁极为中心的局部方位基
        const P = latLonToVec3(pole.lat, pole.lon, 1);
        const U = new THREE.Vector3(0, 1, 0).cross(P).normalize();
        const V = P.clone().cross(U).normalize();
        for (let i = 0; i < nAz; i++) {
          const az = (i / nAz) * Math.PI * 2;
          const dir = U.clone().multiplyScalar(Math.cos(az)).add(V.clone().multiplyScalar(Math.sin(az)));
          for (let j = 0; j < nLat; j++) {
            const latC = baseLat + (j / (nLat - 1) - 0.5) * width * 2;
            const rad = (90 - latC) * DEG;
            const v = P.clone().multiplyScalar(Math.cos(rad))
              .add(dir.clone().multiplyScalar(Math.sin(rad)))
              .multiplyScalar(R + 4 + Math.random() * 1.5);
            positions.push(v.x, v.y, v.z);
            // 边缘暗、中心亮;绿->紫
            const edge = 1 - Math.abs(j / (nLat - 1) - 0.5) * 2;
            col.setHSL(0.38 - 0.28 * (1 - edge) * 0.3, 1.0, 0.5 + edge * 0.18);
            colors.push(col.r, col.g, col.b);
            sizes.push((1.6 + edge * 2.6) * (0.6 + strength));
            births.push(0);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(colors), 3));
      geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(sizes), 1));
      geo.setAttribute("aBirth", new THREE.BufferAttribute(new Float32Array(births), 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: PTS_VS, fragmentShader: PTS_FS,
        uniforms: { uTime: { value: 0 }, uScale: { value: 420 }, uSizeMul: { value: 1 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(geo, mat);
      pts.userData = { kind: "aurora" };
      layers.aurora.add(pts);
      return strength;
    },

    setIss(data) {
      clearLayer("iss");
      if (!data || !data.now) return false;
      const now = data.now;
      const altR = R + Math.min(12, (now.altitude || 420) / 6371 * 100 * 0.55);
      // 轨迹
      if (data.path && data.path.length > 1) {
        const pts = data.path.map((p) => {
          const rr = R + Math.min(12, (p.altitude || 420) / 6371 * 100 * 0.55);
          return latLonToVec3(p.lat, p.lon, rr);
        });
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        layers.iss.add(new THREE.Line(g, new THREE.LineBasicMaterial({
          color: 0x8fe9ff, transparent: true, opacity: 0.8, depthWrite: false,
        })));
        // 足迹圈(覆盖范围)
        const fp = (now.footprint || 4500) / 2;
        const dLat = fp / 111.32;
        const dLon = fp / (111.32 * Math.cos(now.latitude * DEG) || 1);
        const ring = [];
        for (let a = 0; a <= 48; a++) {
          const th = (a / 48) * Math.PI * 2;
          ring.push([now.longitude + Math.cos(th) * dLon, now.latitude + Math.sin(th) * dLat]);
        }
        layers.iss.add(makeRing(ring, "#8fe9ff", 0.4, R + 1.2));
      }
      // 本体光晕
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture("rgba(190,250,255,1)", "rgba(60,160,255,0)"),
        transparent: true, depthTest: true,
      }));
      sp.position.copy(latLonToVec3(now.latitude, now.longitude, altR));
      sp.scale.set(7, 7, 1);
      sp.userData = { pick: "iss", item: now };
      layers.iss.add(sp);
      // 实体点
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xdffbff })
      );
      mesh.position.copy(sp.position);
      mesh.userData = { pick: "iss", item: now };
      layers.iss.add(mesh);
      return true;
    },
  };

  return api;
})();
