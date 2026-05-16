/* ==========================================================================
 * もじレーシング（MojiRacing）
 * タイピングしたひらがなが、そのままタイヤの形状になるレースゲーム。
 *
 * 物理: Matter.js（凹形分解には poly-decomp を使用）
 * 形状抽出: Canvas にひらがなを描画 → Marching Squares でアウトラインを取得
 * ========================================================================== */

const {
  Engine,
  World,
  Bodies,
  Body,
  Composite,
  Constraint,
  Common,
  Events,
  Vector,
} = Matter;

// poly-decomp は凹ポリゴンを Matter.js が内部で分解する際に使用する
if (typeof decomp !== "undefined") {
  Common.setDecomp(decomp);
}

/* --------------------------------------------------------------------------
 * 定数
 * -------------------------------------------------------------------------- */

const WORLD_WIDTH = 240000;         // ワールドの全長（広め）
const GROUND_BASE_Y = 620;         // 地面の基準 y 座標
const TERRAIN_THICKNESS = 260;     // 地面の厚み

// 「ひらがな 1 個」が車両そのもの。車体（シャーシ）もタイヤも持たず、
// この 1 つの剛体が地形を転がっていく。形状の差がそのまま走行特性に
// 出るシンプルな設計。
const CHARACTER_SIZE = 140;        // ひらがな剛体の最大サイズ（バウンディングボックス）

const START_X = 280;
const START_Y = 380;
const GOAL_X = 135000;

const PIXELS_PER_METER = 50;       // 距離表示用のスケール

/** 1 より大きいほどカメラが引く（見えるワールド範囲が縦横ともにこの倍率で広がる） */
const VIEW_ZOOM = 1.2;

/* --------------------------------------------------------------------------
 * 地形セクター
 *
 * コースは複数の地形タイプで構成され、各タイプは異なる起伏・摩擦・特殊
 * 物理を持つ。タイヤの形状によって得意・不得意が出るようバランスする。
 *
 *   plain : 平野。誰でも素直に走れる。丸い形が少し速い。
 *   bumpy : 砂利・ゴツゴツ。高摩擦＋細かい凹凸。ギザギザ多脚な
 *           形（ま・そ・き・さ）がグリップして強い。丸い形は跳ねる。
 *   slope : 長い坂道。大きな波。丸くて滑らかな形（の・お・ろ）が転がりやすい。
 *   water : 水上。タイヤと地面の摩擦が極小。タイヤの「水掻き」（=
 *           半径の振れ幅）に応じて推進力が出るので、突起のある形
 *           （へ・く・し・い・ノ）が速い。丸い形は空転して進まない。
 * -------------------------------------------------------------------------- */

const SECTOR_PLAN = [
  { type: "plain", endX: 15000 },   // スタートからの平野
  { type: "bumpy", endX: 45000 },   // ゴツゴツ砂利地帯
  { type: "slope", endX: 80000 },   // 長い坂道（うねり）
  { type: "plain", endX: 90000 },   // ひと息つく平野
  { type: "water", endX: 120000 },  // 水上区間
  { type: "plain", endX: 240000 },  // ゴール後の平野（水上出口〜終端まで＝従来 8万px を 1.5 倍の 12万px）
];

const SECTOR_BLEND = 240;          // セクター境界の地形ブレンド距離
// 水面 Y = GROUND_BASE_Y + WATER_LEVEL_DELTA。水面は地面より少し低く（池状に）
// 配置して、岸に近づくと滑らかに数十 px 下がって水面に降りる演出にする。
const WATER_LEVEL_DELTA = 24;

const SECTOR_INFO = {
  plain: { label: "平野", short: "PLAIN", color: "#6fae45" },
  bumpy: { label: "ゴツゴツ", short: "ROUGH", color: "#c19a5a" },
  slope: { label: "長い坂", short: "SLOPE", color: "#7eaf38" },
  water: { label: "水上", short: "WATER", color: "#3a8fd0" },
};

function getSectorIdx(x) {
  for (let i = 0; i < SECTOR_PLAN.length; i++) {
    if (x < SECTOR_PLAN[i].endX) return i;
  }
  return SECTOR_PLAN.length - 1;
}
function getSectorAt(x) {
  return SECTOR_PLAN[getSectorIdx(x)];
}
function getSectorStart(idx) {
  return idx === 0 ? 0 : SECTOR_PLAN[idx - 1].endX;
}

/* --------------------------------------------------------------------------
 * Marching Squares によるひらがなのアウトライン抽出
 *
 * - Canvas に文字を描画してピクセル単位の二値画像にする
 * - 2x2 のサンプル（4 つのピクセル）ごとに 16 通りのケースを判定し、
 *   セル境界の中点同士を結ぶ線分を生成する
 * - 線分を辿って閉じたポリゴン（輪郭）を構築する
 * -------------------------------------------------------------------------- */

// セル内エッジ index: 0=上, 1=右, 2=下, 3=左
// 4 隅は TL=8 TR=4 BR=2 BL=1 のビット重みでインデックス化
// 各エントリは [from-edge, to-edge] の有向セグメント。"塗りが進行方向の左"
// となるよう向きを揃えてある（外輪は CCW, 穴は CW）
const MS_TABLE = [
  [],                       // 0000
  [[2, 3]],                 // 0001 BL
  [[1, 2]],                 // 0010 BR
  [[1, 3]],                 // 0011 BL+BR
  [[0, 1]],                 // 0100 TR
  [[2, 3], [0, 1]],         // 0101 BL+TR (saddle)
  [[0, 2]],                 // 0110 BR+TR
  [[0, 3]],                 // 0111 BL+BR+TR
  [[3, 0]],                 // 1000 TL
  [[2, 0]],                 // 1001 TL+BL
  [[3, 0], [1, 2]],         // 1010 TL+BR (saddle)
  [[1, 0]],                 // 1011 TL+BL+BR
  [[3, 1]],                 // 1100 TL+TR
  [[2, 1]],                 // 1101 TL+TR+BL
  [[3, 2]],                 // 1110 TL+TR+BR
  [],                       // 1111
];

function buildBinaryGrid(char, fontSize) {
  // 余白を確保してから文字を描画。アンチエイリアスは Marching Squares 用に閾値で 2 値化
  const padding = Math.floor(fontSize * 0.25);
  const size = fontSize + padding * 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  ctx.font = `900 ${fontSize}px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(char, size / 2, size / 2);

  const data = ctx.getImageData(0, 0, size, size).data;
  const grid = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    grid[i] = data[i * 4] < 128 ? 1 : 0;
  }
  return { grid, w: size, h: size };
}

function marchingSquares(grid, w, h) {
  const nextMap = new Map();

  function v(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    return grid[y * w + x];
  }

  function edgePoint(cx, cy, edge) {
    switch (edge) {
      case 0: return [cx + 0.5, cy];
      case 1: return [cx + 1, cy + 0.5];
      case 2: return [cx + 0.5, cy + 1];
      case 3: return [cx, cy + 0.5];
    }
  }

  const key = (p) => `${p[0]},${p[1]}`;

  // 全セルを走査して有向セグメントを Map に積む
  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const tl = v(cx, cy);
      const tr = v(cx + 1, cy);
      const br = v(cx + 1, cy + 1);
      const bl = v(cx, cy + 1);
      const idx = tl * 8 + tr * 4 + br * 2 + bl;

      const segs = MS_TABLE[idx];
      for (let i = 0; i < segs.length; i++) {
        const [eFrom, eTo] = segs[i];
        const p1 = edgePoint(cx, cy, eFrom);
        const p2 = edgePoint(cx, cy, eTo);
        nextMap.set(key(p1), p2);
      }
    }
  }

  // 線分を順に辿って閉じたポリゴンを抽出
  const contours = [];
  while (nextMap.size > 0) {
    const startKey = nextMap.keys().next().value;
    const polygon = [];
    let curKey = startKey;
    let safety = 0;
    while (nextMap.has(curKey) && safety++ < 100000) {
      const next = nextMap.get(curKey);
      polygon.push(curKey.split(",").map(Number));
      nextMap.delete(curKey);
      curKey = key(next);
      if (curKey === startKey) break;
    }
    if (polygon.length >= 3) contours.push(polygon);
  }
  return contours;
}

/* --------------------------------------------------------------------------
 * ポリゴンユーティリティ
 * -------------------------------------------------------------------------- */

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function polygonCentroid(pts) {
  let cx = 0,
    cy = 0,
    a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
    a += cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-6) {
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    return [mx / pts.length, my / pts.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

// Douglas-Peucker でポリゴン頂点を間引く
function simplifyDP(points, epsilon) {
  if (points.length < 3) return points.slice();
  function pdist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function rec(start, end) {
    let maxD = 0, maxI = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pdist(points[i], points[start], points[end]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI !== -1) {
      const left = rec(start, maxI);
      const right = rec(maxI, end);
      return left.concat(right.slice(1));
    }
    return [points[start], points[end]];
  }
  return rec(0, points.length - 1);
}

/**
 * 形状から「物理的な相性スコア」を算出する。
 * すべて 0..1 程度に正規化し、各地形の物理パラメータ（推力・ドライブ倍率
 * など）を変調するのに使う。
 *
 *   roundness   : 丸さ。1 に近いほどきれいな円に近い（4πA / P²）。
 *                  - 平野・坂で有利。
 *   paddleScore : 半径の振れ幅。突起が大きい形ほど高い。
 *                  - 水上のパドル推力に効く（突き出しが水を蹴る）。
 *   spikiness   : ローカルな尖り。隣接頂点の半径差が大きいほど高い。
 *                  - ゴツゴツのグリップに効く（凹凸が地形にハマる）。
 *   aspect      : 縦横比（>= 1）。1 が正方形、大きいほど細長い。
 *                  - 水上で「縦に細長い」形（し・へ・く）を伸ばす。
 *
 * 半径は「面積加重重心 = 原点」を前提に、頂点 (x,y) からの r = √(x²+y²) で
 * 計算する。`getCharacterShape` 側で原点を重心に揃えた contours を渡す。
 */
function computeShapeStats(contours) {
  let area = 0;
  let perimeter = 0;
  const radii = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (const c of contours) {
    area += Math.abs(polygonArea(c));
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      const np = c[(i + 1) % c.length];
      perimeter += Math.hypot(np[0] - p[0], np[1] - p[1]);
      const r = Math.hypot(p[0], p[1]);
      radii.push(r);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (radii.length < 3 || perimeter <= 0 || area <= 0) {
    return { roundness: 0.5, paddleScore: 0.4, spikiness: 0.3, aspect: 1.0 };
  }

  const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
  const varR = radii.reduce((a, r) => a + (r - meanR) ** 2, 0) / radii.length;
  const stdR = Math.sqrt(varR);

  // 4πA / P²：完全な円で 1、不規則になるほど 0 に近づく
  const compactness = (4 * Math.PI * area) / (perimeter * perimeter);
  const roundness = Math.max(0, Math.min(1, compactness * 1.15));

  // 半径の標準偏差を「平均半径」で割って正規化。だいたい 0..0.6 くらいに
  // 収まるので 0..1 にスケールしておく。
  const paddleScore = Math.max(0, Math.min(1, (stdR / Math.max(meanR, 1)) * 1.7));

  // 隣接頂点間の半径差の和（ローカルな尖り）。輪郭一周ぶんで割って正規化。
  let localDiff = 0;
  let totalSegLen = 0;
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      const np = c[(i + 1) % c.length];
      const r1 = Math.hypot(p[0], p[1]);
      const r2 = Math.hypot(np[0], np[1]);
      const segLen = Math.hypot(np[0] - p[0], np[1] - p[1]);
      localDiff += Math.abs(r2 - r1);
      totalSegLen += segLen;
    }
  }
  const spikiness = Math.max(
    0,
    Math.min(1, (localDiff / Math.max(totalSegLen, 1)) * 1.6)
  );

  const bbW = Math.max(1, maxX - minX);
  const bbH = Math.max(1, maxY - minY);
  const aspect = Math.max(bbW, bbH) / Math.min(bbW, bbH);

  return { roundness, paddleScore, spikiness, aspect };
}

/**
 * ひらがな1文字を Matter.js 用の頂点データに変換する。
 *
 * 戻り値:
 *   {
 *     contours: 各ストロークのポリゴン（重心が原点に来るように平行移動済み）
 *     size:    バウンディングボックスのサイズ（描画用）
 *     stats:   地形相性に使う物理特徴量（roundness / paddleScore / ...）
 *   }
 */
function getCharacterShape(char, targetSize = CHARACTER_SIZE) {
  const fontSize = 220;
  const { grid, w, h } = buildBinaryGrid(char, fontSize);
  const rawContours = marchingSquares(grid, w, h);

  // 外輪のみ採用（穴は今回は無視。穴は CW = 正の符号付き面積）
  // 我々の MS テーブルは「塗りが左」となる向きで線分を生成しているため、
  // 外輪はスクリーン座標で CCW = 負の面積になる
  const outers = rawContours.filter((c) => polygonArea(c) < -10);
  if (outers.length === 0) return null;

  // 全外輪の包括バウンディングボックスを計算
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of outers) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;
  const bboxSize = Math.max(maxX - minX, maxY - minY);
  const scale = targetSize / bboxSize;

  // 中央寄せ・スケール・簡略化
  const normalized = [];
  for (const c of outers) {
    let pts = c.map(([x, y]) => [(x - bcx) * scale, (y - bcy) * scale]);
    pts = simplifyDP(pts, 0.6);
    if (pts.length >= 3) normalized.push(pts);
  }
  if (normalized.length === 0) return null;

  // 全パーツの面積加重重心を計算し、それが原点になるようにシフト
  let totalA = 0, ccx = 0, ccy = 0;
  for (const c of normalized) {
    const [px, py] = polygonCentroid(c);
    const a = Math.abs(polygonArea(c));
    ccx += a * px;
    ccy += a * py;
    totalA += a;
  }
  ccx /= totalA;
  ccy /= totalA;

  const shifted = normalized.map((c) => c.map(([x, y]) => [x - ccx, y - ccy]));

  // poly-decomp は CCW 入力を要求する（数学座標系基準）。
  // スクリーン座標系では正の符号付き面積が CCW（数学）に相当するため、
  // 必要に応じて頂点順を反転する
  const finalContours = shifted.map((c) => {
    if (polygonArea(c) < 0) return c.slice().reverse();
    return c;
  });

  const stats = computeShapeStats(finalContours);
  return { contours: finalContours, size: targetSize, stats };
}

function isHiragana(s) {
  return /^[\u3041-\u3096\u309D\u309E]$/.test(s);
}

/* --------------------------------------------------------------------------
 * Matter.js: ひらがな剛体（タイヤ）の生成
 * -------------------------------------------------------------------------- */

function createCharacterBody(worldX, worldY, contours, options) {
  // 全ての凸パーツ（poly-decomp 後の最小構成単位）を 1 つの配列にフラット化
  // して集める。Matter.js は parts のネスト（compound の中に compound）を
  // サポートしないため、複数ストロークの文字を 1 つの剛体にまとめるには
  // 凸パーツに展開してから単一階層の compound を作る必要がある。
  const flatParts = [];
  for (const contour of contours) {
    const verts = contour.map(([x, y]) => ({ x, y }));
    try {
      const body = Bodies.fromVertices(0, 0, [verts], options, true);
      if (!body) continue;

      const [cx, cy] = polygonCentroid(contour);
      Body.setPosition(body, { x: cx, y: cy });

      if (body.parts && body.parts.length > 1) {
        // 凹形が分解された結果の compound: 子パーツのみ取り出す
        for (let i = 1; i < body.parts.length; i++) {
          const child = body.parts[i];
          child.parent = child;
          child.parts = [child];
          flatParts.push(child);
        }
      } else {
        flatParts.push(body);
      }
    } catch (e) {
      console.warn("fromVertices failed for contour:", e);
    }
  }
  if (flatParts.length === 0) return null;

  let body;
  if (flatParts.length === 1) {
    body = flatParts[0];
  } else {
    body = Body.create({ ...options, parts: flatParts });
  }
  Body.setPosition(body, { x: worldX, y: worldY });
  return body;
}

/* --------------------------------------------------------------------------
 * 車両（= ひらがな 1 個の剛体）
 *
 * 車体（シャーシ）もタイヤも別々には持たない。getCharacterShape が返す
 * 凹ポリゴンを 1 つの compound body にして、それ自体が地形を転がる。
 * 拘束やシャーシ角度の固定は無し。形状の物理特性（円に近い・ギザギザ・
 * 縦長）がそのまま走り味に出る、scribble-rider 風の素朴な車両。
 * -------------------------------------------------------------------------- */

function makeBodyOpts() {
  return {
    // 1 個でこの世界を走るので、自重は車 3 体ぶんを 1 個にまとめる感覚
    density: 0.0024,
    friction: 1.05,
    frictionStatic: 1.6,
    restitution: 0.0,
    slop: 0.02,
    // 空気抵抗を少しだけ入れて、空中で無限に滑らないようにする
    frictionAir: 0.006,
    label: "character",
  };
}

function makeRemoteBodyOpts() {
  return {
    ...makeBodyOpts(),
    label: "remote-character",
    frictionAir: 0.008,
  };
}

function createVehicle(x, y, charShape) {
  const body = createCharacterBody(
    x,
    y,
    charShape.contours,
    makeBodyOpts()
  );
  if (!body) return null;
  // 横向き・上下逆さまで生まれて即詰みにならないよう、最初は水平向きで起こす
  Body.setAngle(body, 0);
  Body.setAngularVelocity(body, 0);
  return { body };
}

/**
 * 走行中に「ひらがな剛体」だけを差し替える（ホットスワップ）。
 * 位置・姿勢・速度・回転速度・タイマー・カメラはそのまま引き継ぐ。
 * 失敗したら false を返し、呼び出し側で何もしない。
 */
function swapShape(newShape) {
  const v = state.vehicle;
  if (!v) return false;

  const old = v.body;
  const newBody = createCharacterBody(
    old.position.x,
    old.position.y,
    newShape.contours,
    makeBodyOpts()
  );
  if (!newBody) return false;

  // 旧ボディの姿勢・運動量を引き継ぐ
  Body.setAngle(newBody, old.angle);
  Body.setVelocity(newBody, { x: old.velocity.x, y: old.velocity.y });
  Body.setAngularVelocity(newBody, old.angularVelocity);

  Composite.remove(world, old);
  Composite.add(world, newBody);
  v.body = newBody;
  return true;
}

/* --------------------------------------------------------------------------
 * マルチプレイ: 他プレイヤー剛体（ローカル物理世界に参加・衝突あり）
 * -------------------------------------------------------------------------- */

const remotePlayers = new Map();

function swapRemoteBody(remote, newShape) {
  const old = remote.body;
  if (!old) return false;
  const newBody = createCharacterBody(
    old.position.x,
    old.position.y,
    newShape.contours,
    makeRemoteBodyOpts()
  );
  if (!newBody) return false;
  Body.setAngle(newBody, old.angle);
  Body.setVelocity(newBody, { x: old.velocity.x, y: old.velocity.y });
  Body.setAngularVelocity(newBody, old.angularVelocity);
  Composite.remove(world, old);
  Composite.add(world, newBody);
  remote.body = newBody;
  remote.shape = newShape;
  return true;
}

function applyTargetToBody(body, target, blend) {
  Body.setPosition(body, {
    x: lerp(body.position.x, target.x, blend),
    y: lerp(body.position.y, target.y, blend),
  });
  let da = target.angle - body.angle;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  Body.setAngle(body, body.angle + da * blend);
  Body.setVelocity(body, {
    x: lerp(body.velocity.x, target.vx, blend),
    y: lerp(body.velocity.y, target.vy, blend),
  });
  Body.setAngularVelocity(
    body,
    lerp(body.angularVelocity, target.av, blend)
  );
}

function ensureRemotePlayer(id, data) {
  const char = data.char || "あ";
  let remote = remotePlayers.get(id);
  if (!remote) {
    remote = {
      id,
      name: data.name || "???",
      color: data.color || "#e11d48",
      charText: char,
      shape: null,
      body: null,
      target: {
        x: data.x ?? START_X,
        y: data.y ?? START_Y,
        angle: data.angle ?? 0,
        vx: data.vx ?? 0,
        vy: data.vy ?? 0,
        av: data.av ?? 0,
      },
    };
    remotePlayers.set(id, remote);
  }

  remote.name = data.name || remote.name;
  remote.color = data.color || remote.color;
  remote.target.x = data.x ?? remote.target.x;
  remote.target.y = data.y ?? remote.target.y;
  remote.target.angle = data.angle ?? remote.target.angle;
  remote.target.vx = data.vx ?? remote.target.vx;
  remote.target.vy = data.vy ?? remote.target.vy;
  remote.target.av = data.av ?? remote.target.av;

  if (!state.vehicle) return remote;

  if (remote.charText !== char) {
    const newShape = getCharacterShape(char);
    if (newShape) {
      newShape.charText = char;
      if (remote.body) {
        swapRemoteBody(remote, newShape);
      } else {
        remote.shape = newShape;
      }
      remote.charText = char;
    }
  }

  if (!remote.shape) {
    const shape = getCharacterShape(char);
    if (!shape) return remote;
    shape.charText = char;
    remote.shape = shape;
    remote.charText = char;
  }

  if (!remote.body) {
    const t = remote.target;
    let sx = t.x;
    let sy = t.y;
    if (sx < 200) {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      sx = START_X + (h % 100);
      sy = START_Y;
      t.x = sx;
      t.y = sy;
    }
    const body = createCharacterBody(
      sx,
      sy,
      remote.shape.contours,
      makeRemoteBodyOpts()
    );
    if (!body) return remote;
    Body.setAngle(body, t.angle);
    Body.setVelocity(body, { x: t.vx, y: t.vy });
    Body.setAngularVelocity(body, t.av);
    remote.body = body;
    World.add(world, body);
  }

  return remote;
}

function syncRemotePlayersBeforePhysics(dt) {
  if (remotePlayers.size === 0) return;
  const blend = 1 - Math.exp(-dt / 70);
  for (const remote of remotePlayers.values()) {
    if (!remote.body) continue;
    applyTargetToBody(remote.body, remote.target, blend);
  }
}

function removeRemotePlayer(id) {
  const remote = remotePlayers.get(id);
  if (!remote) return;
  if (remote.body) Composite.remove(world, remote.body);
  remotePlayers.delete(id);
}

function clearRemotePlayers() {
  for (const remote of remotePlayers.values()) {
    if (remote.body) Composite.remove(world, remote.body);
  }
  remotePlayers.clear();
}

function drawColoredCharacter(body, shape, color) {
  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const contour of shape.contours) {
    ctx.beginPath();
    ctx.moveTo(contour[0][0], contour[0][1]);
    for (let i = 1; i < contour.length; i++) {
      ctx.lineTo(contour[i][0], contour[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawRemotePlayers() {
  for (const remote of remotePlayers.values()) {
    if (!remote.body || !remote.shape) continue;
    drawColoredCharacter(remote.body, remote.shape, remote.color);
    ctx.save();
    ctx.font = "bold 12px sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const nx = remote.body.position.x;
    const ny = remote.body.position.y - remote.shape.size * 0.9;
    ctx.fillRect(nx - 40, ny, 80, 18);
    ctx.fillStyle = remote.color;
    ctx.textAlign = "center";
    ctx.fillText(remote.name, nx, ny + 14);
    ctx.restore();
  }
}

function getMinimapPlayers() {
  const players = [];
  if (state.vehicle) {
    players.push({
      x: state.vehicle.body.position.x,
      name: "あなた",
      color: state.playerColor,
      isLocal: true,
    });
  }
  for (const remote of remotePlayers.values()) {
    const x = remote.body
      ? remote.body.position.x
      : remote.target.x;
    players.push({
      x,
      name: remote.name,
      color: remote.color,
      isLocal: false,
    });
  }
  return players;
}

/* --------------------------------------------------------------------------
 * コース（地形）
 *
 * 地形高さは複数の sin で起伏を作る。各セグメントは細長い回転矩形として
 * 生成して連結することで、滑らかかつ確実な静的衝突体になる。
 * -------------------------------------------------------------------------- */

// セクターごとの「素」の地面高さ。境界の段差はあとで surfaceY 側でブレンドする。
function rawSectorSurfaceY(x, sector, sectorStartX) {
  switch (sector.type) {
    case "plain": {
      // 平野: 軽いゆらぎだけ
      return (
        GROUND_BASE_Y +
        Math.sin(x * 0.0011) * 10 +
        Math.sin(x * 0.0028 + 0.7) * 6
      );
    }
    case "bumpy": {
      // ゴツゴツ: 細かい多重バンプ。タイヤより小さい凸凹で、丸い
      // タイヤだとぴょんぴょん跳ねるが、ギザギザ系は引っかかって進める。
      // 位相 0 起点で「セクター入口の y = GROUND_BASE_Y」になり、ブレンド
      // 帯で前のセクターと滑らかに繋がる。
      const t = x - sectorStartX;
      return (
        GROUND_BASE_Y +
        Math.sin(t * 0.045) * 16 +
        Math.sin(t * 0.082) * 11 +
        Math.sin(t * 0.135) * 6 +
        Math.sin(t * 0.020) * 14
      );
    }
    case "slope": {
      // 坂: 長周期の大きなうねり。位相 0 起点で入口は水平。
      const t = x - sectorStartX;
      return (
        GROUND_BASE_Y +
        Math.sin(t * 0.0023) * 220 +
        Math.sin(t * 0.0049) * 60 +
        Math.sin(t * 0.011) * 12
      );
    }
    case "water": {
      // 水面はほぼフラット（描画側で波を乗せる）
      return GROUND_BASE_Y + WATER_LEVEL_DELTA;
    }
  }
  return GROUND_BASE_Y;
}

function smoothstep01(t) {
  return 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, t)) * Math.PI);
}

// 各セクターの「重み」を距離ベースで計算し、隣接セクター同士を加重平均する。
// セクター境界 B を中心に、x が [B - HALF, B + HALF] に入る区間で
// 双方の重みが 0..1 で滑らかに切り替わる。これで境界での段差・不連続が
// なくなり、車両が崖や見えない壁に衝突せずに走り抜けられる。
function surfaceY(x) {
  if (x < 500) return GROUND_BASE_Y;
  if (x > GOAL_X) return GROUND_BASE_Y;

  const HALF = SECTOR_BLEND / 2;

  let totalY = 0;
  let totalW = 0;
  for (let i = 0; i < SECTOR_PLAN.length; i++) {
    const sector = SECTOR_PLAN[i];
    const sStart = getSectorStart(i);
    const sEnd = sector.endX;

    // セクター境界からの符号付き距離（内部 +、外部 -）
    const distInside = Math.min(x - sStart, sEnd - x);
    if (distInside < -HALF) continue;
    if (distInside > HALF) {
      // 完全に内部、これ単独で確定
      const yVal = rawSectorSurfaceY(x, sector, sStart);
      return yVal;
    }
    // ブレンド帯
    const w = smoothstep01((distInside + HALF) / SECTOR_BLEND);
    if (w <= 0) continue;
    const yVal = rawSectorSurfaceY(x, sector, sStart);
    totalY += yVal * w;
    totalW += w;
  }
  if (totalW <= 0) return GROUND_BASE_Y;
  return totalY / totalW;
}

// セクターごとの地表側マテリアル（タイヤとの摩擦・反発）。
// label を "water" / "bumpy" / "slope" / "terrain" にして、ループ側からも
// 「いまどの地形に乗っているか」が判別できるようにする。
function terrainMaterialFor(midX) {
  const sector = getSectorAt(midX);
  switch (sector.type) {
    case "water":
      // 水面はぬるぬる滑る低摩擦＆無反発。タイヤは地面とのフリクションでは
      // 進めず、別途ループ側で形状依存のパドル推力を与える。
      return {
        friction: 0.04,
        frictionStatic: 0.06,
        restitution: 0.0,
        label: "water",
      };
    case "bumpy":
      // ゴツゴツは高摩擦＆ほぼ無反発。ギザギザ形のグリップ感を出す。
      return {
        friction: 1.15,
        frictionStatic: 1.5,
        restitution: 0.0,
        label: "bumpy",
      };
    case "slope":
      // 坂はなめらかに転がるよう中庸
      return {
        friction: 0.85,
        frictionStatic: 1.0,
        restitution: 0.0,
        label: "slope",
      };
    case "plain":
    default:
      return {
        friction: 0.9,
        frictionStatic: 1.0,
        restitution: 0.0,
        label: "terrain",
      };
  }
}

function createTerrain() {
  const segments = [];
  const dx = 40;
  let prevX = 0,
    prevY = surfaceY(0);
  for (let x = dx; x <= WORLD_WIDTH; x += dx) {
    const y = surfaceY(x);
    const angle = Math.atan2(y - prevY, x - prevX);
    const len = Math.hypot(x - prevX, y - prevY) + 2;
    // 矩形の上端をサーフェス線に合わせるため、中心を法線方向にオフセット
    const cx = (prevX + x) / 2 - Math.sin(angle) * (TERRAIN_THICKNESS / 2);
    const cy = (prevY + y) / 2 + Math.cos(angle) * (TERRAIN_THICKNESS / 2);
    const mat = terrainMaterialFor((prevX + x) / 2);
    const seg = Bodies.rectangle(cx, cy, len, TERRAIN_THICKNESS, {
      isStatic: true,
      angle,
      friction: mat.friction,
      frictionStatic: mat.frictionStatic,
      restitution: mat.restitution,
      label: mat.label,
    });
    segments.push(seg);
    prevX = x;
    prevY = y;
  }
  // 左右の壁
  segments.push(
    Bodies.rectangle(-50, GROUND_BASE_Y - 200, 100, 1000, {
      isStatic: true, label: "wall",
    })
  );
  return segments;
}

/* --------------------------------------------------------------------------
 * Matter エンジン初期化
 * -------------------------------------------------------------------------- */

const engine = Engine.create({
  enableSleeping: false,
  positionIterations: 8,
  velocityIterations: 8,
  constraintIterations: 4,
});
engine.gravity.y = 5.8;
engine.timing.timeScale = 1.0;
const world = engine.world;

/* --------------------------------------------------------------------------
 * 描画 & ゲームループ
 * -------------------------------------------------------------------------- */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
function resize() {
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}
window.addEventListener("resize", resize);
resize();

const camera = { x: START_X, y: START_Y };

const state = {
  vehicle: null,
  charShape: null,
  charText: "",
  playerColor: "#e11d48",
  startTime: 0,
  finished: false,
  lastJump: 0,
  goalBody: null,
  startMarkerBody: null,
};

function setPlayerColor(color) {
  if (!color) return;
  state.playerColor = color;
  updatePreview();
  updateLobbyPreview();
}

const speedEl = document.getElementById("speed");
const statusEl = document.getElementById("status");
const goalBanner = document.getElementById("goalBanner");
const goalTimeEl = document.getElementById("goalTime");
const minimapWrapEl = document.getElementById("minimapWrap");
const minimapEl = document.getElementById("minimap");
let minimapCtx = null;
let minimapDpr = 1;

function resizeMinimap() {
  if (!minimapEl) return;
  minimapDpr = window.devicePixelRatio || 1;
  const cssW = minimapEl.clientWidth || 240;
  const cssH = minimapEl.clientHeight || 56;
  minimapEl.width = Math.round(cssW * minimapDpr);
  minimapEl.height = Math.round(cssH * minimapDpr);
  minimapCtx = minimapEl.getContext("2d");
  minimapCtx.setTransform(minimapDpr, 0, 0, minimapDpr, 0, 0);
}
window.addEventListener("resize", resizeMinimap);
resizeMinimap();

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* --------------------------------------------------------------------------
 * 背景: ループ素材を遠景としてゆっくりパララックススクロール
 *
 * - background.png は左右に継ぎ目なくタイリング可能な素材
 * - スクリーン空間に直接描く（ワールド変換の外）。camera.x に
 *   "パララックス係数" を掛けた量だけスライドして「ゆっくり動く」感じに。
 * -------------------------------------------------------------------------- */

const bgImage = new Image();
let bgImageLoaded = false;
bgImage.addEventListener("load", () => { bgImageLoaded = true; });
bgImage.addEventListener("error", () => { bgImageLoaded = false; });
bgImage.src = "background.png";

function drawBackground(viewW, viewH, padX = 0, padY) {
  const py = padY === undefined ? padX : padY;
  const x0 = -padX;
  const y0 = -py;
  const bw = viewW + 2 * padX;
  const bh = viewH + 2 * py;
  // フォールバック / 画像読み込み前のための空グラデーション
  const grad = ctx.createLinearGradient(0, y0, 0, y0 + bh);
  grad.addColorStop(0, "#7ec5f2");
  grad.addColorStop(0.7, "#c5e7fa");
  grad.addColorStop(1, "#e8f4fc");
  ctx.fillStyle = grad;
  ctx.fillRect(x0, y0, bw, bh);

  if (!bgImageLoaded) return;

  const aspect = bgImage.width / bgImage.height;
  const tileH = bh;
  const tileW = tileH * aspect;
  let offsetX = (-camera.x * 0.04) % tileW;
  if (offsetX > 0) offsetX -= tileW;
  const xEnd = viewW + padX + tileW;
  for (let x = offsetX; x < xEnd; x += tileW) {
    ctx.drawImage(bgImage, x, y0, tileW, tileH);
  }
}

function drawTerrainFill(sector, drawStart, drawEnd, step) {
  ctx.beginPath();
  ctx.moveTo(drawStart, GROUND_BASE_Y + 1600);
  for (let x = drawStart; x <= drawEnd; x += step) {
    ctx.lineTo(x, surfaceY(x));
  }
  ctx.lineTo(drawEnd, surfaceY(drawEnd));
  ctx.lineTo(drawEnd, GROUND_BASE_Y + 1600);
  ctx.closePath();

  switch (sector.type) {
    case "water": {
      // 深さによってグラデーションの濃い水色
      const grad = ctx.createLinearGradient(
        0, GROUND_BASE_Y - 60, 0, GROUND_BASE_Y + 400
      );
      grad.addColorStop(0, "#65b6e8");
      grad.addColorStop(0.4, "#3a8fd0");
      grad.addColorStop(1, "#1d4f86");
      ctx.fillStyle = grad;
      ctx.fill();
      break;
    }
    case "bumpy": {
      // 砂利・砂地の色
      const grad = ctx.createLinearGradient(
        0, GROUND_BASE_Y - 30, 0, GROUND_BASE_Y + 200
      );
      grad.addColorStop(0, "#d6b078");
      grad.addColorStop(0.5, "#b88c4a");
      grad.addColorStop(1, "#7a5a2a");
      ctx.fillStyle = grad;
      ctx.fill();
      break;
    }
    case "slope": {
      // 坂は深い緑
      ctx.fillStyle = "#5fa033";
      ctx.fill();
      break;
    }
    case "plain":
    default: {
      ctx.fillStyle = "#6fae45";
      ctx.fill();
      break;
    }
  }
}

function drawSectorDecorations(sector, drawStart, drawEnd, step) {
  if (sector.type === "bumpy") {
    // 散在する小石: x 起点で擬似乱数を計算して安定して同じ位置に出す
    ctx.save();
    ctx.fillStyle = "#5d4322";
    const count = Math.floor((drawEnd - drawStart) / 32);
    for (let i = 0; i < count; i++) {
      const seed = Math.floor((drawStart + i * 32) * 13.7);
      const px = drawStart + ((Math.abs(Math.sin(seed)) * 1e4) % (drawEnd - drawStart));
      const py = surfaceY(px) + 6 + ((Math.abs(Math.cos(seed * 1.3)) * 12));
      const r = 2 + (Math.abs(Math.sin(seed * 0.7)) * 4);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (sector.type === "water") {
    // 水面に動きのあるさざ波（パフォーマンス維持のため間引き描画）
    ctx.save();
    const t = performance.now() * 0.001;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let x = drawStart; x <= drawEnd; x += step) {
      const wY = surfaceY(x) + Math.sin(x * 0.04 + t * 2.0) * 1.6;
      if (x === drawStart) ctx.moveTo(x, wY);
      else ctx.lineTo(x, wY);
    }
    ctx.stroke();
    // 軽いハイライト帯
    ctx.fillStyle = "rgba(255,255,255,0.13)";
    ctx.beginPath();
    for (let x = drawStart; x <= drawEnd; x += step) {
      ctx.lineTo(x, surfaceY(x) + Math.sin(x * 0.04 + t * 2.0) * 1.6);
    }
    for (let x = drawEnd; x >= drawStart; x -= step) {
      ctx.lineTo(x, surfaceY(x) + 6 + Math.sin(x * 0.04 + t * 2.0) * 1.6);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (sector.type === "slope") {
    // 草の縦線（簡易）。坂全面に大量に出すと重いので疎にする。
    ctx.save();
    ctx.strokeStyle = "rgba(40, 80, 30, 0.45)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = drawStart; x <= drawEnd; x += 22) {
      const y = surfaceY(x);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 1, y - 6);
    }
    ctx.stroke();
    ctx.restore();
  }
}

function drawTerrain(viewMinX, viewMaxX) {
  const viewStart = Math.max(0, viewMinX - 40);
  const viewEnd = Math.min(WORLD_WIDTH, viewMaxX + 40);
  const step = 8;

  // セクターごとに塗り分け。境界の地形 Y は surfaceY 側でブレンド済み。
  for (let i = 0; i < SECTOR_PLAN.length; i++) {
    const sector = SECTOR_PLAN[i];
    const sStart = getSectorStart(i);
    const sEnd = sector.endX;
    if (sEnd < viewStart || sStart > viewEnd) continue;

    const drawStart = Math.max(viewStart, sStart);
    const drawEnd = Math.min(viewEnd, sEnd);

    drawTerrainFill(sector, drawStart, drawEnd, step);
    drawSectorDecorations(sector, drawStart, drawEnd, step);

    // 表面ライン（水面は白っぽく、地面は濃い緑/茶色）
    ctx.strokeStyle =
      sector.type === "water" ? "rgba(255,255,255,0.75)"
      : sector.type === "bumpy" ? "#5d4322"
      : "#3f7423";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(drawStart, surfaceY(drawStart));
    for (let x = drawStart + step; x <= drawEnd; x += step) {
      ctx.lineTo(x, surfaceY(x));
    }
    ctx.stroke();

    // セクター名の看板（先頭に小さく、画面に入った時だけ）
    if (sStart >= viewStart && sStart <= viewEnd && sStart > 0) {
      const info = SECTOR_INFO[sector.type];
      const sy = surfaceY(sStart) - 110;
      ctx.save();
      ctx.fillStyle = info.color;
      ctx.fillRect(sStart - 2, sy, 4, 90);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(sStart + 6, sy - 2, 96, 26);
      ctx.fillStyle = info.color;
      ctx.fillRect(sStart + 6, sy - 2, 6, 26);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 13px sans-serif";
      ctx.fillText(info.label, sStart + 18, sy + 16);
      ctx.restore();
    }
  }

  // 距離マーカー（500px ごと）
  ctx.font = "bold 14px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 3;
  for (let m = 500; m < WORLD_WIDTH; m += 500) {
    if (m < viewStart || m > viewEnd) continue;
    const sy = surfaceY(m);
    const meters = Math.round((m - START_X) / PIXELS_PER_METER);
    if (meters <= 0) continue;
    ctx.strokeText(meters + "m", m - 10, sy - 8);
    ctx.fillText(meters + "m", m - 10, sy - 8);
  }
}

function drawStartGoal() {
  // スタート
  ctx.save();
  ctx.fillStyle = "#1e3c72";
  ctx.fillRect(START_X - 2, surfaceY(START_X) - 80, 4, 80);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("START", START_X - 22, surfaceY(START_X) - 88);

  // ゴール: チェッカー旗
  const gx = GOAL_X;
  const gy = surfaceY(gx);
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(gx - 2, gy - 120, 4, 120);
  // 旗
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? "#fff" : "#1a1a1a";
      ctx.fillRect(gx + 2 + c * 10, gy - 120 + r * 10, 10, 10);
    }
  }
  ctx.fillStyle = "#1e3c72";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("GOAL", gx - 6, gy - 130);
  ctx.restore();
}

function drawVehicle(v) {
  drawCharacterRoller(v.body, state.charShape, state.playerColor);
}

function drawCharacterRoller(body, shape, fillColor = "#000000") {
  // 接地影（回転と独立に、剛体の真下に楕円で薄く落とす）
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(
    body.position.x,
    body.position.y + shape.size * 0.55,
    shape.size * 0.50,
    shape.size * 0.10,
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();

  // 剛体本体（ひらがなを回転表示）
  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);

  ctx.fillStyle = fillColor;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const contour of shape.contours) {
    ctx.beginPath();
    ctx.moveTo(contour[0][0], contour[0][1]);
    for (let i = 1; i < contour.length; i++) {
      ctx.lineTo(contour[i][0], contour[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // 中心の小さな目印（重心 = 回転の中心がわかると遊んでいて楽しい）
  ctx.fillStyle = "rgba(26,26,26,0.7)";
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function render() {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;

  // カメラ追従
  if (state.vehicle) {
    const target = state.vehicle.body.position;
    camera.x = lerp(camera.x, target.x + 80, 0.08);
    camera.y = lerp(camera.y, target.y - 40, 0.06);
  }
  const visHalfW = (viewW * VIEW_ZOOM) / 2;
  camera.x = Math.max(visHalfW, Math.min(WORLD_WIDTH - visHalfW, camera.x));

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(1 / VIEW_ZOOM, 1 / VIEW_ZOOM);
  ctx.translate(-viewW / 2, -viewH / 2);

  const bgPadX = (viewW * (VIEW_ZOOM - 1)) / 2;
  const bgPadY = (viewH * (VIEW_ZOOM - 1)) / 2;
  drawBackground(viewW, viewH, bgPadX, bgPadY);

  ctx.save();
  ctx.translate(viewW / 2 - camera.x, viewH / 2 - camera.y);

  const viewMinX = camera.x - visHalfW - 60;
  const viewMaxX = camera.x + visHalfW + 60;
  drawTerrain(viewMinX, viewMaxX);
  drawStartGoal();

  if (state.vehicle) {
    drawRemotePlayers();
    drawVehicle(state.vehicle);
  }

  ctx.restore();
  ctx.restore();

  drawMinimap();
}

function drawMinimap() {
  if (!minimapEl || !minimapCtx || !state.vehicle) {
    if (minimapWrapEl) minimapWrapEl.classList.add("hidden");
    return;
  }
  if (minimapWrapEl) minimapWrapEl.classList.remove("hidden");

  const w = minimapEl.clientWidth || 240;
  const h = minimapEl.clientHeight || 56;
  const padX = 10;
  const padY = 14;
  const trackX = padX;
  const trackY = padY + 8;
  const trackW = w - padX * 2;
  const trackH = 10;
  const courseLen = GOAL_X - START_X;

  minimapCtx.clearRect(0, 0, w, h);

  minimapCtx.fillStyle = "rgba(13, 27, 42, 0.88)";
  if (typeof minimapCtx.roundRect === "function") {
    minimapCtx.beginPath();
    minimapCtx.roundRect(0, 0, w, h, 10);
    minimapCtx.fill();
  } else {
    minimapCtx.fillRect(0, 0, w, h);
  }

  // 地形セクター（コース上の色分け）
  let prevEnd = START_X;
  for (const sector of SECTOR_PLAN) {
    const sStart = prevEnd;
    const sEnd = Math.min(sector.endX, GOAL_X);
    if (sEnd <= START_X) {
      prevEnd = sector.endX;
      continue;
    }
    const x0 = trackX + ((sStart - START_X) / courseLen) * trackW;
    const x1 = trackX + ((sEnd - START_X) / courseLen) * trackW;
    minimapCtx.fillStyle = SECTOR_INFO[sector.type]?.color || "#6fae45";
    minimapCtx.fillRect(x0, trackY, Math.max(1, x1 - x0), trackH);
    prevEnd = sector.endX;
  }

  minimapCtx.strokeStyle = "rgba(255,255,255,0.35)";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(trackX, trackY, trackW, trackH);

  // スタート / ゴール
  minimapCtx.fillStyle = "#fff";
  minimapCtx.font = "bold 9px sans-serif";
  minimapCtx.textAlign = "left";
  minimapCtx.fillText("S", trackX - 2, trackY - 2);
  minimapCtx.textAlign = "right";
  minimapCtx.fillText("G", trackX + trackW + 2, trackY - 2);

  const players = getMinimapPlayers();
  for (const p of players) {
    const px =
      trackX +
      Math.max(0, Math.min(1, (p.x - START_X) / courseLen)) * trackW;
    const py = trackY + trackH / 2;
    const r = p.isLocal ? 5 : 4;
    minimapCtx.beginPath();
    minimapCtx.arc(px, py, r, 0, Math.PI * 2);
    minimapCtx.fillStyle = p.color;
    minimapCtx.fill();
    minimapCtx.strokeStyle = p.isLocal ? "#fff" : "rgba(255,255,255,0.85)";
    minimapCtx.lineWidth = p.isLocal ? 2 : 1.5;
    minimapCtx.stroke();
  }

  // 凡例（プレイヤー名）
  minimapCtx.font = "10px sans-serif";
  minimapCtx.textAlign = "left";
  let legendX = padX;
  const legendY = h - 6;
  for (const p of players) {
    minimapCtx.fillStyle = p.color;
    minimapCtx.beginPath();
    minimapCtx.arc(legendX + 4, legendY - 3, 3, 0, Math.PI * 2);
    minimapCtx.fill();
    minimapCtx.fillStyle = "rgba(255,255,255,0.9)";
    const label = p.isLocal ? "あなた" : p.name;
    minimapCtx.fillText(label, legendX + 10, legendY);
    legendX += minimapCtx.measureText(label).width + 22;
    if (legendX > w - 40) break;
  }
}

/* --------------------------------------------------------------------------
 * 入力
 * -------------------------------------------------------------------------- */

// 矢印キー/Space は文字入力に使われない（IME が消費しない）ので、
// 入力欄にフォーカスがあっても常にゲームキーとして使う。
const ARROW_SPACE_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);
// アルファベット系のゲームキーは入力欄にフォーカスがあるとローマ字 IME に
// 使われるため、入力欄が外れているときだけ反応させる。
const LETTER_GAME_KEYS = new Set(["KeyA", "KeyD", "KeyW", "KeyS"]);
const keys = {};

window.addEventListener("keydown", (e) => {
  const inputFocused = document.activeElement === charInputEl;

  if (ARROW_SPACE_KEYS.has(e.code)) {
    keys[e.code] = true;
    e.preventDefault();
    return;
  }

  if (LETTER_GAME_KEYS.has(e.code) && !inputFocused) {
    keys[e.code] = true;
    return;
  }

  // R: リスタート（タイピング無効化のため入力欄フォーカスは問わない）
  if (e.code === "KeyR") {
    restart();
  }
});
window.addEventListener("keyup", (e) => {
  if (ARROW_SPACE_KEYS.has(e.code) || LETTER_GAME_KEYS.has(e.code)) {
    keys[e.code] = false;
  }
});

/**
 * いま「ひらがな」が乗っている地形タイプを判定し、地形依存の力を加える。
 *
 *   plain : 何もしない（自然な物理 = 丸い形が転がりやすい）
 *   bumpy : ギザギザ形（spikiness 高）に追加グリップ。丸い形には軽い減衰。
 *   slope : 丸い形（roundness 高）に転がり補正で少しだけブースト。
 *   water : ・地面摩擦がほぼ無い（createTerrain 側で friction=0.04）ので
 *             ふつうの駆動では進まない。
 *           ・代わりに「半径の振れ幅 ≒ 水掻き断面（paddleScore）」と
 *             縦長度（aspect）に応じてパドル推力を出す。
 *           ・水抵抗で 1ステップごとに 3〜4% 減衰させる。
 *
 * applyForce のスケールは Matter.js の Verlet 積分（実効 dt² ≈ 278）を踏まえ、
 * 「ふつうの駆動力 ≒ 0.02」と同じくらいのオーダで効くように調整。
 */
function applyTerrainEffects() {
  if (!state.vehicle || state.finished || !state.charShape) return;
  const b = state.vehicle.body;
  const stats = state.charShape.stats || {
    roundness: 0.5, paddleScore: 0.4, spikiness: 0.3, aspect: 1.0,
  };

  const sector = getSectorAt(b.position.x);
  switch (sector.type) {
    case "water": {
      // パドル推力: 半径の振れ幅 × 縦長度 × ω。ω が正（前回り）なら +x。
      // aspect が大きい（縦長な「し」「へ」など）ほど水を強く蹴る。
      const paddleAmp =
        stats.paddleScore *
        (0.55 + Math.min(stats.aspect, 2.5) * 0.32);
      const thrust = b.angularVelocity * paddleAmp * 0.0042 * b.mass;
      Body.applyForce(b, b.position, { x: thrust, y: 0 });
      // 水抵抗（ステップごとに 3.5% 減衰）
      Body.setVelocity(b, {
        x: b.velocity.x * 0.965,
        y: b.velocity.y * 0.965,
      });
      break;
    }
    case "bumpy": {
      // 凹凸が地形バンプに引っかかって牽引する効果（spikiness が大きいほど効く）
      const gripBonus = stats.spikiness * 0.0020 * b.mass;
      Body.applyForce(b, b.position, {
        x: b.angularVelocity * gripBonus,
        y: 0,
      });
      // 丸い形はバンプで跳ねてエネルギーをロス → 軽い減衰
      if (stats.roundness > 0.55) {
        const k = 0.012 * (stats.roundness - 0.55);
        Body.setVelocity(b, {
          x: b.velocity.x * (1 - k),
          y: b.velocity.y * (1 - k),
        });
      }
      break;
    }
    case "slope": {
      // 丸い形ほど転がりロスが少ない → 少しだけ前にブースト
      const rollBonus = stats.roundness * 0.0010 * b.mass;
      Body.applyForce(b, b.position, {
        x: b.angularVelocity * rollBonus,
        y: 0,
      });
      break;
    }
    // plain: 何もしない
  }
}

function applyControls() {
  if (!state.vehicle || state.finished) return;
  const b = state.vehicle.body;

  // 駆動力: デフォルトで CRUISE を常時ON。右キー/ D での上乗せ加速はオフ。
  const CRUISE = 0.0019;
  const BRAKE_RATIO = 0.85;
  const isBrake = keys["ArrowLeft"] || keys["KeyA"];
  let driveBase = CRUISE * b.mass;
  if (isBrake) driveBase = -CRUISE * BRAKE_RATIO * b.mass;

  const MAX_AV = 0.85;
  const r = CHARACTER_SIZE / 2;
  const canDrive =
    (driveBase > 0 && b.angularVelocity < MAX_AV) ||
    (driveBase < 0 && b.angularVelocity > -MAX_AV * 0.7);
  if (canDrive) {
    Body.applyForce(
      b,
      { x: b.position.x, y: b.position.y - r * 0.55 },
      { x: driveBase, y: 0 }
    );
  }

  // ジャンプ: 質量比例の上向き力 + 少しだけ前向き角速度を加えて
  // 「ジャンプして体を回しながら飛ぶ」感じにする
  const now = performance.now();
  if ((keys["ArrowUp"] || keys["Space"]) && now - state.lastJump > 700) {
    state.lastJump = now;
    Body.applyForce(b, b.position, {
      x: -0.0 * b.mass,
      y: -0.08 * b.mass,
    });
    Body.setAngularVelocity(b, b.angularVelocity + 0.15);
  }
}

/* --------------------------------------------------------------------------
 * UI
 * -------------------------------------------------------------------------- */

const charInputEl = document.getElementById("charInput");
const previewEl = document.getElementById("preview");
const bannerRestart = document.getElementById("bannerRestart");

function drawShapePreview(canvas, char, color, size = 90) {
  if (!canvas) return;
  const pctx = canvas.getContext("2d");
  pctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!char || !isHiragana(char)) return;
  const shape = getCharacterShape(char, size);
  if (!shape) return;
  pctx.save();
  pctx.translate(canvas.width / 2, canvas.height / 2);
  pctx.fillStyle = color;
  pctx.strokeStyle = "#ffffff";
  pctx.lineWidth = 2;
  pctx.lineJoin = "round";
  pctx.lineCap = "round";
  for (const contour of shape.contours) {
    pctx.beginPath();
    pctx.moveTo(contour[0][0], contour[0][1]);
    for (let i = 1; i < contour.length; i++) {
      pctx.lineTo(contour[i][0], contour[i][1]);
    }
    pctx.closePath();
    pctx.fill();
    pctx.stroke();
  }
  pctx.restore();
}

function updatePreview() {
  const ch = charInputEl.value.trim() || "あ";
  if (!isHiragana(ch)) {
    const pctx = previewEl.getContext("2d");
    pctx.clearRect(0, 0, previewEl.width, previewEl.height);
    pctx.fillStyle = "#ef4444";
    pctx.font = "12px sans-serif";
    pctx.textAlign = "center";
    pctx.fillText("ひらがな1文字", previewEl.width / 2, previewEl.height / 2);
    return;
  }
  drawShapePreview(previewEl, ch, state.playerColor, 90);
}

const lobbyPreviewEl = document.getElementById("lobbyPreview");

function updateLobbyPreview() {
  const ch = charInputEl?.value?.trim() || "あ";
  drawShapePreview(lobbyPreviewEl, ch, state.playerColor, 72);
}

// IME 入力中フラグ（音声経由の handleCharInput では未使用だが互換のため残す）
state.composing = false;

/* --- タイピングによるタイヤ切り替え（オフ） ---
charInputEl.addEventListener("compositionstart", () => {
  state.composing = true;
});
charInputEl.addEventListener("compositionend", () => {
  state.composing = false;
  handleCharInput();
});
charInputEl.addEventListener("focus", () => {
  setTimeout(() => {
    if (document.activeElement === charInputEl) charInputEl.select();
  }, 0);
});
charInputEl.addEventListener("input", () => {
  handleCharInput();
});
--- */

/* --- 入力欄への強制オートフォーカス（タイピング用・オフ） ---
function ensureInputFocus() {
  if (document.activeElement !== charInputEl) {
    try { charInputEl.focus({ preventScroll: true }); } catch { charInputEl.focus(); }
  }
}
let focusBoot = 0;
const focusBootTimer = setInterval(() => {
  ensureInputFocus();
  if (++focusBoot > 12) clearInterval(focusBootTimer);
}, 60);
window.addEventListener("load", ensureInputFocus);
document.addEventListener("DOMContentLoaded", ensureInputFocus);
window.addEventListener("focus", ensureInputFocus);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ensureInputFocus();
});
charInputEl.addEventListener("blur", () => {
  setTimeout(() => {
    const ae = document.activeElement;
    const onButton = ae && ae.tagName === "BUTTON";
    if (!onButton) ensureInputFocus();
  }, 0);
});
canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  ensureInputFocus();
});
document.addEventListener("mousedown", (e) => {
  if (e.target === charInputEl || (e.target && e.target.tagName === "BUTTON")) return;
  setTimeout(ensureInputFocus, 0);
});
window.addEventListener("keydown", () => {
  if (document.activeElement !== charInputEl) ensureInputFocus();
});
let focusGuardCount = 0;
function focusGuard() {
  if (++focusGuardCount % 30 === 0) {
    const ae = document.activeElement;
    const onButton = ae && ae.tagName === "BUTTON";
    if (ae !== charInputEl && !onButton) {
      ensureInputFocus();
    }
  }
  requestAnimationFrame(focusGuard);
}
requestAnimationFrame(focusGuard);
--- */

canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
});

/**
 * 現在の入力欄の文字からタイヤを更新する。
 * タイピング経路はオフのため、基本的に音声認識（applyVoiceCharacter）からだけ呼ばれる。
 */
function handleCharInput() {
  const raw = charInputEl.value;
  // 入力欄に現れているひらがなのうち、もっとも最後のものを採用する。
  // （古い文字 + 新しい文字 と並んだとき、新しく打った方を反映するため）
  let cleaned = "";
  for (const c of raw) {
    if (isHiragana(c)) cleaned = c;
  }

  // composition 中は IME 状態が壊れるので value を書き換えない
  if (!state.composing && charInputEl.value !== cleaned) {
    charInputEl.value = cleaned;
  }
  if (!cleaned) return;
  updatePreview();
  if (cleaned === state.charText) return;

  // 形状抽出
  const shape = getCharacterShape(cleaned);
  if (!shape) {
    setStatus("文字の形状を抽出できませんでした");
    return;
  }
  setStatus("");

  // 走行中なら剛体だけを差し替えて、レース状態（位置・タイマー・速度）を維持
  if (state.vehicle && !state.finished) {
    if (swapShape(shape)) {
      state.charText = cleaned;
      state.charShape = shape;
      window.MojiMP?.onCharChange?.(cleaned);
      return;
    }
  }
  // 初期 / ゴール後 はフルリスタート
  startGame();
}

/* --- Enter でスタート（タイピング用・オフ） ---
charInputEl.addEventListener("keydown", (e) => {
  if (e.code === "Enter") {
    e.preventDefault();
    startGame();
  }
});
--- */

/* --------------------------------------------------------------------------
 * 音声認識（Web Speech API）
 *
 * マイク入力で話したひらがなを受け取って、現在の文字（タイヤ）を差し替える。
 * - 認識結果は ja-JP で取得し、カタカナ → ひらがなに変換
 * - 「最後に現れたひらがな1文字」を抽出してタイヤに反映
 * - continuous + interimResults で話している途中でもどんどん切り替わる
 * -------------------------------------------------------------------------- */

const micStatusEl = document.getElementById("micStatus");
const voiceStateEl = document.getElementById("voiceState");

const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const voice = {
  recognition: null,
  active: false,
  // 同じ文字が連続認識された場合の不要な reload を防ぐためのキャッシュ
  lastApplied: "",
};

function setMicStatus(msg, level) {
  if (!micStatusEl) return;
  micStatusEl.textContent = msg || "";
  micStatusEl.classList.remove("error", "recording");
  if (level === "error") micStatusEl.classList.add("error");
  else if (level === "recording") micStatusEl.classList.add("recording");
}

function updateVoiceStateIndicator() {
  if (!voiceStateEl) return;
  voiceStateEl.classList.remove("off", "on", "unsupported");
  if (!SpeechRecognitionCtor) {
    voiceStateEl.classList.add("unsupported");
    voiceStateEl.textContent = "音声入力: 未対応（Chrome 推奨）";
    return;
  }
  if (voice.active) {
    voiceStateEl.classList.add("on");
    voiceStateEl.textContent = "音声入力: オン";
  } else {
    voiceStateEl.classList.add("off");
    voiceStateEl.innerHTML =
      "音声入力: オフ（<kbd>V</kbd> で切替）";
  }
}

// カタカナ → ひらがな変換（U+30A1..U+30F6 を -0x60 して U+3041..U+3096 に）
function katakanaToHiragana(s) {
  return s.replace(/[\u30A1-\u30F6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

// 認識結果文字列から「最後に出てくるひらがな1文字」を取り出す。
// 例: "あいう" → "う"、"カキク" → "く"、"今日は" → "ょ"（拗音は弾く）
function pickHiraganaFromSpeech(text) {
  const converted = katakanaToHiragana(text);
  // 小書き仮名（ぁぃぅぇぉっゃゅょゎ）や濁点だけのものは
  // 単独タイヤとして使いにくいので除外し、優先的に通常仮名を拾う。
  const SMALLS = new Set([
    "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ゎ",
  ]);
  let fallback = "";
  let pick = "";
  for (const c of converted) {
    if (isHiragana(c)) {
      if (SMALLS.has(c)) {
        fallback = c;
      } else {
        pick = c;
      }
    }
  }
  return pick || fallback || "";
}

function applyVoiceCharacter(ch) {
  if (!ch || ch === voice.lastApplied) return;
  if (!isHiragana(ch)) return;
  voice.lastApplied = ch;

  // 入力欄に反映 → 既存の入力ハンドラを通してタイヤを差し替える
  charInputEl.value = ch;
  handleCharInput();
}

function initSpeechRecognition() {
  if (!SpeechRecognitionCtor) {
    setMicStatus("このブラウザは音声認識に未対応です（Chrome 推奨）", "error");
    updateVoiceStateIndicator();
    return;
  }

  const rec = new SpeechRecognitionCtor();
  rec.lang = "ja-JP";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.addEventListener("result", (e) => {
    // 直近の認識結果からひらがなを拾う
    let combined = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      combined += e.results[i][0].transcript;
    }
    const ch = pickHiraganaFromSpeech(combined);
    if (ch) {
      setMicStatus(`「${ch}」を認識`, "recording");
      applyVoiceCharacter(ch);
    }
  });

  rec.addEventListener("error", (e) => {
    if (e.error === "no-speech") {
      setMicStatus("声が拾えませんでした", "error");
    } else if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setMicStatus("マイクの使用が許可されていません", "error");
      stopVoice();
    } else if (e.error === "aborted") {
      // 自分で止めた場合: 表示はそのまま
    } else {
      setMicStatus(`音声認識エラー: ${e.error}`, "error");
    }
  });

  rec.addEventListener("end", () => {
    // continuous でも一定時間でブラウザ側が切ることがあるので、ユーザーが
    // 止めていなければ自動再開する。
    if (voice.active) {
      try {
        rec.start();
      } catch {
        // 連続呼び出しで失敗することがあるので少し待ってからリトライ
        setTimeout(() => {
          if (voice.active) {
            try { rec.start(); } catch { /* noop */ }
          }
        }, 200);
      }
    }
  });

  voice.recognition = rec;
  updateVoiceStateIndicator();
}

function startVoice() {
  if (!voice.recognition) return;
  if (voice.active) return;
  try {
    voice.recognition.start();
  } catch {
    // 既に動いていた場合などは無視
  }
  voice.active = true;
  voice.lastApplied = "";
  setMicStatus("聞いています… ひらがなを話してください", "recording");
  updateVoiceStateIndicator();
}

function stopVoice() {
  if (!voice.recognition) return;
  voice.active = false;
  try {
    voice.recognition.stop();
  } catch {
    // noop
  }
  setMicStatus("音声入力を停止しました");
  updateVoiceStateIndicator();
}

function toggleVoice() {
  if (!voice.recognition) {
    initSpeechRecognition();
    if (!voice.recognition) return;
  }
  if (voice.active) stopVoice();
  else startVoice();
}

initSpeechRecognition();
updateVoiceStateIndicator();

// V キーで音声入力 ON/OFF
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyV") {
    e.preventDefault();
    toggleVoice();
  }
});
bannerRestart.addEventListener("click", () => {
  window.MojiMP?.hideGoalRanking?.();
  goalBanner.classList.add("hidden");
  startGame();
});

/* --------------------------------------------------------------------------
 * ゲーム制御
 * -------------------------------------------------------------------------- */

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function clearWorld() {
  clearRemotePlayers();
  World.clear(world, false);
  Engine.clear(engine);
  state.vehicle = null;
}

function startGame() {
  const ch = charInputEl.value.trim();
  if (!isHiragana(ch)) {
    setStatus("音声でひらがなを1文字話してください（V でオン）");
    return;
  }

  const shape = getCharacterShape(ch);
  if (!shape) {
    setStatus("文字の形状を抽出できませんでした");
    return;
  }

  setStatus("");
  goalBanner.classList.add("hidden");
  clearWorld();

  state.charText = ch;
  state.charShape = shape;

  // 地形
  const terrain = createTerrain();
  World.add(world, terrain);

  // 車両（= ひらがな剛体 1 個）
  const vehicle = createVehicle(START_X, START_Y, shape);
  if (!vehicle) {
    setStatus("車両を作成できませんでした");
    return;
  }
  state.vehicle = vehicle;
  World.add(world, vehicle.body);

  // カメラ位置
  camera.x = START_X;
  camera.y = START_Y;

  state.startTime = performance.now();
  state.finished = false;
  state.lastJump = 0;

  window.MojiMP?.onGameStart?.();
}

function restart() {
  if (state.charText) {
    startGame();
  } else {
    setStatus("音声でひらがなを話してください（V でオン）");
  }
}

function checkGoal() {
  if (!state.vehicle || state.finished) return;
  if (state.vehicle.body.position.x >= GOAL_X) {
    state.finished = true;
    const elapsed = (performance.now() - state.startTime) / 1000;
    window.MojiMP?.onGoal?.(elapsed);
  }
  // 落下リカバリー: y がワールド外まで落ちたら自動リセット
  if (state.vehicle.body.position.y > 2000) {
    setStatus("落下: R でリトライ");
  }
}

/**
 * 形状特徴量と地形タイプから「相性スコア（0..1）」を返す。
 * HUD に星 1〜3 として出すだけのものなので、感覚的に近い計算でよい。
 */
function affinityFor(terrainType, stats) {
  if (!stats) return 0.5;
  switch (terrainType) {
    case "plain":
      // 丸い形が少し有利、極端に偏ったものは少し下がる程度
      return Math.max(0, Math.min(1, 0.55 + stats.roundness * 0.4 - stats.spikiness * 0.15));
    case "bumpy":
      // ギザギザ・凹凸が多いほど高評価
      return Math.max(0, Math.min(1, 0.35 + stats.spikiness * 0.7 + (stats.paddleScore - 0.3) * 0.25 - stats.roundness * 0.3));
    case "slope":
      // 丸さがそのまま転がりやすさに直結
      return Math.max(0, Math.min(1, 0.4 + stats.roundness * 0.65 - stats.spikiness * 0.2));
    case "water":
      // 振れ幅 × 縦長度。アスペクト比が大きく半径ばらけてる形が一番速い。
      return Math.max(0, Math.min(1,
        0.2 + stats.paddleScore * 0.55 +
        Math.min(stats.aspect, 2.5) * 0.18 - stats.roundness * 0.35
      ));
    default:
      return 0.5;
  }
}

function affinityToStars(score) {
  if (score >= 0.72) return "★★★";
  if (score >= 0.5) return "★★☆";
  if (score >= 0.32) return "★☆☆";
  return "☆☆☆";
}

function affinityHint(terrainType, score) {
  const lvl = score >= 0.72 ? "ばっちり" : score >= 0.5 ? "ふつう" : score >= 0.32 ? "微妙" : "苦手";
  switch (terrainType) {
    case "plain": return `平野: ${lvl}（丸い形が少し有利）`;
    case "bumpy": return `ゴツゴツ: ${lvl}（凹凸の多い形でグリップ）`;
    case "slope": return `坂: ${lvl}（丸い形が転がる）`;
    case "water": return `水上: ${lvl}（縦長＆突起のある形が水を蹴る）`;
    default: return "";
  }
}

const terrainChipEl = document.getElementById("terrainChip");
const terrainNameEl = document.getElementById("terrainName");
const terrainAffinityEl = document.getElementById("terrainAffinity");
const terrainHintEl = document.getElementById("terrainHint");

function updateTerrainHUD() {
  const v = state.vehicle;
  if (!v || !state.charShape) return;
  const sector = getSectorAt(v.body.position.x);
  const info = SECTOR_INFO[sector.type];
  const stats = state.charShape.stats;
  const score = affinityFor(sector.type, stats);

  if (terrainChipEl) {
    terrainChipEl.textContent = info.short;
    terrainChipEl.className = `terrain-chip t-${sector.type}`;
  }
  if (terrainNameEl) terrainNameEl.textContent = info.label;
  if (terrainAffinityEl) terrainAffinityEl.textContent = `相性: ${affinityToStars(score)}`;
  if (terrainHintEl) terrainHintEl.textContent = affinityHint(sector.type, score);
}

function updateHUD() {
  const v = state.vehicle;
  if (!v) return;
  const sp = Math.hypot(v.body.velocity.x, v.body.velocity.y) / PIXELS_PER_METER;
  if (speedEl) speedEl.textContent = sp.toFixed(1);
  updateTerrainHUD();
}

/* --------------------------------------------------------------------------
 * メインループ（固定ステップ物理 + フレーム描画）
 * -------------------------------------------------------------------------- */

const FIXED_DT = 1000 / 60;
let lastTime = performance.now();
let acc = 0;

function loop(now) {
  let dt = now - lastTime;
  lastTime = now;
  if (dt > 100) dt = 100; // タブ復帰時の暴走防止
  acc += dt;
  while (acc >= FIXED_DT) {
    syncRemotePlayersBeforePhysics(FIXED_DT);
    applyControls();
    applyTerrainEffects();
    Engine.update(engine, FIXED_DT);
    // ひらがなが「車体そのもの」なので、角度ロックや傾き合わせは一切しない。
    // 形状の物理（重心の偏り・凹凸）が、そのまま転がりの個性として現れる。
    acc -= FIXED_DT;
  }
  checkGoal();
  updateHUD();
  if (window.MojiMP?.tick) window.MojiMP.tick();
  render();
  requestAnimationFrame(loop);
}

/* --------------------------------------------------------------------------
 * マルチプレイ / ロビー用の公開 API
 * -------------------------------------------------------------------------- */

window.MojiGame = {
  START_X,
  GOAL_X,
  PIXELS_PER_METER,
  WORLD_WIDTH,
  getCharacterShape,
  drawCharacterRoller,
  drawShapePreview,
  isHiragana,
  startGame,
  restart,
  setPlayerColor,
  getPlayerColor: () => state.playerColor,
  getState: () => state,
  ensureRemotePlayer,
  removeRemotePlayer,
  clearRemotePlayers,
  getMinimapPlayers,
  updateLobbyPreview,
};

// 初期表示（ゲーム開始はロビーまたは「ひとりでプレイ」から）
updatePreview();
updateLobbyPreview();
requestAnimationFrame(loop);
