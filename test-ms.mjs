// Marching Squares のロジックを単体で検証する簡易テスト
// node test-ms.mjs で実行

const MS_TABLE = [
  [], [[2, 3]], [[1, 2]], [[1, 3]],
  [[0, 1]], [[2, 3], [0, 1]], [[0, 2]], [[0, 3]],
  [[3, 0]], [[2, 0]], [[3, 0], [1, 2]], [[1, 0]],
  [[3, 1]], [[2, 1]], [[3, 2]], [],
];

function marchingSquares(grid, w, h) {
  const nextMap = new Map();
  const v = (x, y) => (x < 0 || x >= w || y < 0 || y >= h ? 0 : grid[y * w + x]);
  const ep = (cx, cy, e) => {
    switch (e) {
      case 0: return [cx + 0.5, cy];
      case 1: return [cx + 1, cy + 0.5];
      case 2: return [cx + 0.5, cy + 1];
      case 3: return [cx, cy + 0.5];
    }
  };
  const key = (p) => `${p[0]},${p[1]}`;
  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const tl = v(cx, cy);
      const tr = v(cx + 1, cy);
      const br = v(cx + 1, cy + 1);
      const bl = v(cx, cy + 1);
      const idx = tl * 8 + tr * 4 + br * 2 + bl;
      for (const [eF, eT] of MS_TABLE[idx]) {
        nextMap.set(key(ep(cx, cy, eF)), ep(cx, cy, eT));
      }
    }
  }
  const contours = [];
  while (nextMap.size > 0) {
    const sk = nextMap.keys().next().value;
    const poly = [];
    let cur = sk, n = 0;
    while (nextMap.has(cur) && n++ < 100000) {
      const nx = nextMap.get(cur);
      poly.push(cur.split(",").map(Number));
      nextMap.delete(cur);
      cur = key(nx);
      if (cur === sk) break;
    }
    if (poly.length >= 3) contours.push(poly);
  }
  return contours;
}

function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function test(name, grid, w, h, expectN) {
  const contours = marchingSquares(grid, w, h);
  const ok = contours.length === expectN;
  console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}: contours=${contours.length} (expected ${expectN})`);
  contours.forEach((c, i) => {
    console.log(`        contour ${i}: ${c.length} pts, area=${area(c).toFixed(2)}`);
  });
  return ok;
}

// テスト1: 5x5 グリッドの中央に 3x3 の塗り
{
  const w = 5, h = 5;
  const g = new Uint8Array(w * h);
  for (let y = 1; y <= 3; y++)
    for (let x = 1; x <= 3; x++) g[y * w + x] = 1;
  test("3x3 square in 5x5", g, w, h, 1);
}

// テスト2: ドーナツ型 (5x5 outer with center hole)
{
  const w = 7, h = 7;
  const g = new Uint8Array(w * h);
  for (let y = 1; y <= 5; y++)
    for (let x = 1; x <= 5; x++) g[y * w + x] = 1;
  g[3 * w + 3] = 0; // center hole
  test("donut", g, w, h, 2);
}

// テスト3: 2 つの分離した正方形
{
  const w = 9, h = 5;
  const g = new Uint8Array(w * h);
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 2; x++) g[y * w + x] = 1;
    for (let x = 5; x <= 7; x++) g[y * w + x] = 1;
  }
  test("two squares", g, w, h, 2);
}

// テスト4: L 字型（凹形）
{
  const w = 6, h = 6;
  const g = new Uint8Array(w * h);
  for (let y = 1; y <= 4; y++) g[y * w + 1] = 1;
  for (let x = 1; x <= 4; x++) g[4 * w + x] = 1;
  test("L shape (concave)", g, w, h, 1);
}
