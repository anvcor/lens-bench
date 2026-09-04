/* ===================================================================
   optics.js — 序列光学系统计算内核（纯 JS，无依赖）
   近轴 / 实光线追迹 / 模型玻璃色散 / 光瞳 / 几何 MTF
   =================================================================== */

var OPT = (function () {
  'use strict';

  /* ---------- 小玻璃库：牌号 -> [nd, vd] ---------- */
  /* 比内置目录快照更新的牌号：设计文件已经在用，但打包进来的厂商目录里还没有。
     只有 nd / vd，按 Conrady 模型玻璃代入，标签和提示里都标出来，别和目录玻璃混为一谈。
     每一条都要能独立核对：数值来源见 README，并用设计本身反解验证过
     （代进去后像面正好落在轴上焦点、且轴上 RMS 落到衍射量级，别的取值都不成立）。 */
  var GNEW = {
    nbfd26: [1.83401, 25.97, 'HOYA'],       // Sony FE 50mm F1.2 GM 用；HOYA20251120 目录
    taf48:  [1.79091, 48.09, 'HOYA']        // Sony FE 35mm F1.4 GM 用；HOYA20260601 目录
  };
  var CATALOG = {
    'air': null,
    'nbk7': [1.51680, 64.17], 'bk7': [1.51680, 64.17],
    'nsk16': [1.62041, 60.32], 'sk16': [1.62041, 60.32],
    'f2': [1.62004, 36.37], 'nf2': [1.62005, 36.37],
    'nsf5': [1.67271, 32.25], 'sf5': [1.67270, 32.21],
    'nsf6': [1.80518, 25.36], 'sf6': [1.80518, 25.43],
    'nlak22': [1.65113, 55.89], 'nssk2': [1.62229, 53.27],
    'nfk51a': [1.48656, 84.47], 'caf2': [1.43385, 95.00],
    'silica': [1.45846, 67.82], 'pmma': [1.49180, 57.44],
    'apel': [1.53100, 56.00], 'ok4': [1.63550, 23.90]
  };

  /* ---------- 模型玻璃：Conrady 三参数，锁定 nd / vd 与正常线 P_gF ----------
     n(λ) = n0 + A/λ + B/λ^3.5      （λ 单位 µm）
     约束： nF - nC = (nd-1)/vd
            ng - nF = P_gF · (nF - nC),  P_gF = 0.6438 - 0.001682·vd  (正常线)
     ------------------------------------------------------------------ */
  var LD = 0.5875618, LF = 0.4861327, LC = 0.6562725, LG = 0.4358343;
  function p1(l) { return 1 / l; }
  function p2(l) { return 1 / Math.pow(l, 3.5); }

  function makeGlass(nd, vd) {
    if (!isFinite(nd) || nd <= 1) return function () { return 1; };
    if (!isFinite(vd) || vd <= 0) return function () { return nd; };
    var dnFC = (nd - 1) / vd;
    var PgF = 0.6438 - 0.001682 * vd;
    var a11 = p1(LF) - p1(LC), a12 = p2(LF) - p2(LC), b1 = dnFC;
    var a21 = p1(LG) - p1(LF), a22 = p2(LG) - p2(LF), b2 = PgF * dnFC;
    var det = a11 * a22 - a12 * a21;
    var A = (b1 * a22 - a12 * b2) / det;
    var B = (a11 * b2 - b1 * a21) / det;
    var n0 = nd - A * p1(LD) - B * p2(LD);
    return function (l) { return n0 + A / l + B / Math.pow(l, 3.5); };
  }

  /* ---------- 带真实色散公式的玻璃（来自厂商目录 CDGM.xml / HOYA .agf） ----------
     sellmeier1: n² = 1 + Σ Ki λ² / (λ² − Li)        schott: n² = A0 + A1λ² + A2λ⁻² + A3λ⁻⁴ + A4λ⁻⁶ + A5λ⁻⁸
     ------------------------------------------------------------------ */
  var FORMULA = {
    'hbaf7':    ['sellmeier1', [1.08754258, 117.535981, 1.41618001, 0.0100875311, 0.12698713, 0.0526006682], 'H-BAF7'],
    'hkf6':     ['sellmeier1', [0.0736995941, 0.0478548878, 1.19277164, 0.00781132706, 1.01749455, 104.241959], 'H-KF6'],
    'hlaf10la': ['sellmeier1', [1.93178403, 0.00997340769, 0.189897276, 0.0368891042, 1.09736515, 77.2777489], 'H-LAF10LA'],
    'hzf1a':    ['sellmeier1', [0.157527094, 0.0585466694, 1.4792285, 0.0111805229, 1.18166385, 115.153843], 'H-ZF1A'],
    'hzf72a':   ['sellmeier1', [0.470478653, 0.0736024509, 2.55040233, 149.306621, 2.00593441, 0.0162999226], 'H-ZF72A'],
    'hzlaf75a': ['sellmeier1', [1.50615126, 102.994725, 2.18809221, 0.0127716105, 0.297955776, 0.0569661668], 'H-ZLAF75A'],
    'hzpk1a':   ['sellmeier1', [0.944049498, 109.035762, 1.05017122, 0.0132903754, 0.527568709, 0.000741462968], 'H-ZPK1A'],
    'nbfd25':   ['schott', [3.2879389, -0.015856356, 0.045638807, 0.0033027661, -0.00021690686, 0.000029625863], 'NBFD25'],
    'efl5':     ['schott', [2.4465754, -0.010107041, 0.017759132, 0.00087970259, -0.000057014929, 0.0000060924663], 'EFL5'],
    'tac8':     ['schott', [2.9324178, -0.014603156, 0.021121636, 0.000048240144, 0.000049669475, -0.0000024904491], 'TAC8'],
    'fds90sg':  ['schott', [3.2606321, -0.017780398, 0.040902938, 0.0056076934, -0.00056434039, 0.000054763391], 'FDS90SG'],
    'mtaf101':  ['schott', [3.05615, -0.0138471, 0.02431126, 0.0004980027, -0.000007318676, 0.00000124041], 'MTAF101'],
    'fc5':      ['schott', [2.1894054, -0.0099044908, 0.008640337, 0.00022263067, -0.000012291942, 0.00000059386349], 'FC5'],
    'mpcd51':   ['schott', [2.502026, -0.01108292, 0.0112772, 0.0005715408, -0.00005587455, 0.000002905292], 'MPCD51'],
    'efd15l':   ['schott', [2.7924658, -0.012540598, 0.028359569, 0.0023368977, -0.00020763765, 0.000022481601], 'EFD15L'],
    'sbsl7':    ['sellmeier1', [1.1515019, 0.010598413, 0.11858361, -0.011822519, 1.2630136, 129.61766], 'S-BSL7'],
    'bsc7':     ['schott', [2.2702566, -0.0091988101, 0.011609706, -0.000076123911, 0.000028558727, -0.0000012566486], 'BSC7']
  };
  function formulaGlass(type, c) {
    if (type === 'sellmeier1') return function (l) {
      var l2 = l * l;
      return Math.sqrt(1 + c[0] * l2 / (l2 - c[1]) + c[2] * l2 / (l2 - c[3]) + c[4] * l2 / (l2 - c[5]));
    };
    return function (l) {
      var l2 = l * l;
      return Math.sqrt(c[0] + c[1] * l2 + c[2] / l2 + c[3] / (l2 * l2) + c[4] / (l2 * l2 * l2) + c[5] / (l2 * l2 * l2 * l2));
    };
  }


  /* ---------- 内置玻璃库（19 家厂商目录，Zemax XML 转换） ----------
     行格式：NAME|TYPE|c0,c1,...   TYPE: L=Laurent(幂级数) M=厂商Sellmeier
                                        S=标准Sellmeier H=Herzberger
     Laurent 指数序：λ^[0,2,-2,-4,-6,-8,4,-10,-12]
     ------------------------------------------------------------------ */
  var GDB_EXP = [0, 2, -2, -4, -6, -8, 4, -10, -12];
  function dbFn(t, c) {
    var i;
    if (t === 'L') return function (l) {
      var s = 0;
      for (i = 0; i < c.length; i++) if (c[i]) s += c[i] * Math.pow(l, i < 9 ? GDB_EXP[i] : -14);
      return s > 0 ? Math.sqrt(s) : NaN;
    };
    if (t === 'M') return function (l) {
      var l2 = l * l, s = 1;
      for (i = 0; i + 1 < c.length; i += 2) s += c[i] * l2 / (l2 - c[i + 1]);
      return s > 0 ? Math.sqrt(s) : NaN;
    };
    if (t === 'S') return function (l) {
      var l2 = l * l, s = 1;
      for (i = 0; i + 1 < c.length; i += 2) s += c[i] * l2 / (l2 - c[i + 1] * c[i + 1]);
      return s > 0 ? Math.sqrt(s) : NaN;
    };
    if (t === 'H') return function (l) {
      var l2 = l * l, L = 1 / (l2 - 0.028);
      return c[0] + c[1] * L + c[2] * L * L + c[3] * l2 + c[4] * l2 * l2 + c[5] * l2 * l2 * l2;
    };
    return null;
  }

  var GDB = null, GDB_NAMES = null, GDB_CATS = null;
  function gdbBuild() {
    if (GDB) return GDB;
    GDB = {}; GDB_NAMES = []; GDB_CATS = [];
    var raw = (typeof GLASSDB_RAW === 'string') ? GLASSDB_RAW : '';
    var lines = raw.split('\n'), cat = '', n = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      if (ln.charCodeAt(0) === 64) { cat = ln.slice(1); GDB_CATS.push(cat); continue; }
      var p = ln.indexOf('|'); if (p < 0) continue;
      var q = ln.indexOf('|', p + 1); if (q < 0) continue;
      var name = ln.slice(0, p);
      var rec = { n: name, c: cat, t: ln.slice(p + 1, q), s: ln.slice(q + 1), f: null };
      var key = gdbKey(name);
      if (!GDB[key]) GDB[key] = rec;          // 目录优先级：先出现者胜
      GDB[key + '_' + gdbKey(cat)] = rec;      // 显式 NAME_CATALOG
      GDB_NAMES.push(name + ' [' + cat + ']');
      n++;
    }
    GDB.__count = n;
    return GDB;
  }
  function gdbKey(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  /* 常见别名 -> 库内牌号（红外/特种材料多用俗称） */
  var GALIAS = {
    'fusedsilica': 'silica', 'sio2': 'silica', 'quartz': 'silica', 'fsilica': 'silica',
    'sapphire': 'saphir', 'al2o3': 'saphir', 'pmma': 'acrylic', 'polycarb': 'pcarb',
    'polycarbonate': 'pcarb', 'polystyr': 'pstyr', 'polystyrene': 'pstyr',
    'caf2': 'cafl', 'baf2': 'baf', 'as2s3': 'artri', 'thalbroi': 'krs5', 'salt': 'nacl',
    'irtran1': 'irt1', 'irtran2': 'irt2', 'irtran6': 'irt6', 'silicon': 'silicn',
    'si': 'silicn', 'ge': 'germ', 'germanium': 'germ', 'h20': 'water', 'h2o': 'water',
    'ig2': 'ig2schott', 'ig3': 'ig3schott', 'ig4': 'ig4schott', 'ig5': 'ig5schott',
    'ig6': 'ig6schott', 'irg22': 'irg22schott', 'irg23': 'irg23schott',
    'irg24': 'irg24schott', 'irg25': 'irg25schott', 'irg26': 'irg26schott',
    'irg27': 'irg27schott'
  };
  function gdbGet(key) {
    var db = gdbBuild(), r = db[key];
    if (!r || typeof r !== 'object') return null;
    if (!r.f) {
      var c = r.s.split(','), a = [];
      for (var i = 0; i < c.length; i++) a.push(parseFloat(c[i]));
      r.f = dbFn(r.t, a);
    }
    return r.f ? r : null;
  }
  function glassCount() { return gdbBuild().__count || 0; }
  function glassNames() { gdbBuild(); return GDB_NAMES; }
  function glassCatalogs() { gdbBuild(); return GDB_CATS; }

  var AIR = function () { return 1; };

  /* ---------- 解析处方文本 ---------- */
  function parsePrescription(text) {
    var lines = String(text).split(/\r?\n/);
    var surfaces = [], warnings = [], missMat = {}, missList = [], subList = [], newList = [];
    for (var li = 0; li < lines.length; li++) {
      var raw = lines[li].trim();
      if (!raw || raw[0] === '#' || raw.slice(0, 2) === '//') continue;
      var tk = raw.split(/[\s,;\t]+/).filter(function (t) { return t.length; });
      if (tk.length < 2) { warnings.push('第 ' + (li + 1) + ' 行字段不足，已跳过'); continue; }

      var R = parseRadius(tk[0]);
      var T = parseFloat(tk[1]);
      if (!isFinite(T)) { warnings.push('第 ' + (li + 1) + ' 行厚度无效，已跳过'); continue; }

      var idx = 2, mat = null, matLabel = 'air';
      if (tk.length > 2 && !isPlainNumber(tk[2])) {
        var m = parseMaterial(tk[2]);
        if (m.err) { if (!missMat[tk[2]]) { missMat[tk[2]] = 1; missList.push(tk[2]); } }
        else if (m.model && !missMat['^' + tk[2]]) { missMat['^' + tk[2]] = 1; newList.push(m.label); }
        else if (m.sub && !missMat['~' + tk[2]]) {
          missMat['~' + tk[2]] = 1; subList.push(tk[2].toUpperCase() + ' → ' + m.glass);
        }
        mat = m.fn; matLabel = m.label;
        idx = 3;
      }
      var sd = null;
      if (tk.length > idx && tk[idx] !== '-') { var v = parseFloat(tk[idx]); if (isFinite(v) && v > 0) sd = v; }
      if (tk.length > idx) idx++;
      var k = 0;
      if (tk.length > idx) { var kv = parseFloat(tk[idx]); if (isFinite(kv)) k = kv; idx++; }
      var asph = [];
      for (; idx < tk.length; idx++) { var av = parseFloat(tk[idx]); asph.push(isFinite(av) ? av : 0); }
      while (asph.length && asph[asph.length - 1] === 0) asph.pop();

      surfaces.push({ R: R, T: T, n: mat || AIR, isGlass: !!mat, matLabel: matLabel, sd: sd, k: k, asph: asph });
    }
    if (newList.length) warnings.push('这些是比内置目录快照更新的牌号，库里还没有，已按 nd/vd 代入模型玻璃：' +
      newList.join('、') + '。色散曲线是拟合的，二级光谱会有细微出入；要精确可在「玻璃」列直接写目录公式对应的 nd/vd。');
    if (subList.length) warnings.push('这些牌号库里没有完全同名，已按去掉末位变体后缀的同族玻璃代入：' +
      subList.join('、') + '。折射率取的是同族基础牌号，个位数变体（-L / -M 之类）之间 nd 通常差 1e-4 量级。');
    if (missList.length) warnings.push('内置玻璃库（' + glassCount() + ' 种牌号）里找不到：' +
      missList.join('、') + ' —— 这些面按空气处理。可改写成 nd/vd（如 1.7292/54.7）、6 位 MIL 代码（如 517640），或加目录后缀指定（如 ' + missList[0] + '_HOYA）。');
    return { surfaces: surfaces, warnings: warnings };
  }

  function isPlainNumber(s) { return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s); }

  function parseRadius(s) {
    var t = s.toLowerCase();
    if (t === 'inf' || t === 'infinity' || t === '∞' || t === 'plano' || t === 'flat' || t === '-') return 0;
    var v = parseFloat(s);
    if (!isFinite(v)) return 0;
    return v;                                  // R = 0 表示平面
  }

  /* 查库：精确 → 别名 → 削掉末尾 1~2 个变体字母（HOYA 的 -L / -M 之类）。
     后一种算「近似替代」，标签里会标出来。suf 为 '_目录' 时限定在该目录里找。 */
  function gdbResolve(key, suf) {
    var r = gdbGet(key + suf);
    if (r) return r;
    if (!suf && GALIAS[key]) { r = gdbGet(GALIAS[key]); if (r) return r; }
    for (var i = 1; i <= 2 && key.length - i >= 3; i++) {
      if (!/[a-z]/.test(key.charAt(key.length - i))) break;
      r = gdbGet(key.slice(0, key.length - i) + suf);
      if (r) return { n: r.n, c: r.c, f: r.f, t: r.t, s: r.s, sub: 1 };
    }
    return null;
  }
  function gdbLabel(rec, asked) {
    var ndv = rec.f(LD), vdv = (ndv - 1) / (rec.f(LF) - rec.f(LC));
    var lab = rec.n + ' (' + ndv.toFixed(5) + '/' + vdv.toFixed(2) + ', ' + rec.c + ')';
    if (rec.sub && asked) lab = rec.n + ' ← ' + String(asked).toUpperCase().replace(/_.*$/, '') +
      ' (' + ndv.toFixed(5) + '/' + vdv.toFixed(2) + ', ' + rec.c + ' 近似)';
    return { fn: rec.f, label: lab, glass: rec.n, cat: rec.c, nd: ndv, vd: vdv, sub: !!rec.sub };
  }

  function parseMaterial(s) {
    var t = s.trim();
    if (t === '-' || t === '' || t.toLowerCase() === 'air') return { fn: null, label: 'air' };
    if (t.indexOf('/') >= 0) {
      var pr = t.split('/');
      var nd = parseFloat(pr[0]), vd = parseFloat(pr[1]);
      if (isFinite(nd) && isFinite(vd)) return { fn: makeGlass(nd, vd), label: nd.toFixed(5) + '/' + vd.toFixed(2) };
    }
    // 支持 MIL 代码 517640 / 517.640
    var mil = t.replace(/[.\s]/g, '');
    if (/^\d{6}$/.test(mil)) {
      var mnd = 1 + parseInt(mil.slice(0, 3), 10) / 1000, mvd = parseInt(mil.slice(3), 10) / 10;
      return { fn: makeGlass(mnd, mvd), label: 'MIL ' + mil + ' (' + mnd.toFixed(4) + '/' + mvd.toFixed(1) + ')' };
    }
    var key = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    var CATSUF = /(cdgm|hoya|schott|ohara|sumita|hikari|nikon|corning|nhg|china|chance|cornfr|heraeus|kodak|mitsui|osaka|pilkington|special|zeon)$/;
    // 1) 显式 NAME_CATALOG 形式：H-ZF72A_CDGM → hzf72a_cdgm
    var und = t.lastIndexOf('_');
    if (und > 0 && CATSUF.test(gdbKey(t.slice(und + 1)))) {
      var er = gdbResolve(gdbKey(t.slice(0, und)), '_' + gdbKey(t.slice(und + 1)));
      if (er) return gdbLabel(er, t);
      key = gdbKey(t.slice(0, und));                 // 指定目录里没有，退回全库再找
    }
    // 2) 目录后缀直接粘连：HZF72ACDGM
    var key2 = key.replace(CATSUF, '');
    if (!FORMULA[key] && !CATALOG[key] && !gdbResolve(key, '') && key2 !== key) key = key2;
    var rec = gdbResolve(key, '');
    if (rec) return gdbLabel(rec, t);
    if (FORMULA[key]) {
      var F = FORMULA[key], fn = formulaGlass(F[0], F[1]);
      var ndv = fn(LD), vdv = (ndv - 1) / (fn(LF) - fn(LC));
      return { fn: fn, label: F[2] + ' (' + ndv.toFixed(5) + '/' + vdv.toFixed(2) + ', 目录公式)' };
    }
    if (CATALOG[key]) {
      var g = CATALOG[key];
      return { fn: makeGlass(g[0], g[1]), label: t.toUpperCase() + ' (' + g[0].toFixed(4) + '/' + g[1].toFixed(1) + ')' };
    }
    // 牌号末尾的「-数字」是目录里的级别 / 退火档（CDGM 的 D-ZPK5-25 之类），
    // 光学常数与基础牌号一致，去掉后缀再查一次，按近似替代报出来
    var mg = /^(.+?)-\d+$/.exec(t);
    if (mg) {
      var gr = gdbResolve(gdbKey(mg[1]), '');
      if (gr) return gdbLabel({ n: gr.n, c: gr.c, f: gr.f, t: gr.t, s: gr.s, sub: 1 }, t);
    }
    if (GNEW[key]) {
      var gn = GNEW[key];
      return { fn: makeGlass(gn[0], gn[1]), model: true,
               label: t.toUpperCase() + ' (' + gn[0].toFixed(5) + '/' + gn[1].toFixed(2) + ', ' + gn[2] + ' 新牌号 · 模型玻璃)' };
    }
    return { fn: null, label: 'air', err: true };
  }

  /* ---------- 面型：矢高与斜率 ---------- */
  function sag(s, r2) {
    var c = s.R ? 1 / s.R : 0, z = 0;
    if (c !== 0) {
      var d = 1 - (1 + s.k) * c * c * r2;
      if (d < 0) return NaN;
      z = c * r2 / (1 + Math.sqrt(d));
    }
    if (s.asph.length) {
      var r = Math.sqrt(r2);
      for (var i = 0; i < s.asph.length; i++) if (s.asph[i]) z += s.asph[i] * Math.pow(r, 4 + 2 * i);
    }
    return z;
  }
  function dsagdr(s, r) {
    var c = s.R ? 1 / s.R : 0, d = 0;
    if (c !== 0) {
      var q = 1 - (1 + s.k) * c * c * r * r;
      if (q <= 0) return NaN;
      d = c * r / Math.sqrt(q);
    }
    for (var i = 0; i < s.asph.length; i++) if (s.asph[i]) d += (4 + 2 * i) * s.asph[i] * Math.pow(r, 3 + 2 * i);
    return d;
  }

  /* ---------- 单条光线的实追迹 ----------
     P/D 为全局坐标（z 沿光轴，面 0 顶点在 z=0）
     返回 {ok, pts:[[x,y,z]...], D, blockedAt}
     ------------------------------------------------------------------ */
  function traceRay(sys, P0, D0, lambda, collect, upTo, ignoreAp) {
    var S = sys.surfaces, zv = sys.zVertex;
    var nEnd = (upTo === undefined || upTo === null) ? S.length : Math.min(upTo, S.length);
    var P = [P0[0], P0[1], P0[2]], D = [D0[0], D0[1], D0[2]];
    var pts = collect ? [[P[0], P[1], P[2]]] : null;
    var nPrev = 1, opl = 0;

    for (var i = 0; i < nEnd; i++) {
      var s = S[i];
      var lx = P[0], ly = P[1], lz = P[2] - zv[i];      // 局部坐标
      // 先平移到该面的切平面再解交点。二次方程按 |t| 最小取根，若起点远在面后方
      // （物距有限、或首面曲率半径很大时会出现），最小根会落到球面的另一侧——
      // 70mm macro 的 1.2M 结构就是这么把第 1 面的落点解成 −9.7 而不是 +11.4 的。
      var tPre = 0;
      if (lz !== 0) {
        if (Math.abs(D[2]) < 1e-14) return { ok: false, pts: pts, blockedAt: i };
        tPre = -lz / D[2];
        lx += tPre * D[0]; ly += tPre * D[1]; lz = 0;
      }
      var t = intersect(s, lx, ly, lz, D);
      if (t === null || !isFinite(t)) return { ok: false, pts: pts, blockedAt: i };

      var x = lx + t * D[0], y = ly + t * D[1], z = lz + t * D[2];
      var r2 = x * x + y * y, r = Math.sqrt(r2);
      if (!ignoreAp && s.sd !== null && r > s.sd * 1.0000001) return { ok: false, pts: pts, blockedAt: i, vignetted: true };

      opl += nPrev * (tPre + t);                          // 几何路程 × 折射率
      P[0] = x; P[1] = y; P[2] = z + zv[i];
      if (collect) pts.push([P[0], P[1], P[2]]);

      // 法线（指向 +z）
      var ds = r > 1e-12 ? dsagdr(s, r) : 0;
      if (!isFinite(ds)) return { ok: false, pts: pts, blockedAt: i };
      var nx = r > 1e-12 ? -ds * x / r : 0, ny = r > 1e-12 ? -ds * y / r : 0, nz = 1;
      var nl = Math.sqrt(nx * nx + ny * ny + 1); nx /= nl; ny /= nl; nz /= nl;

      var nNext = s.n(lambda);
      var mu = nPrev / nNext;
      var ci = D[0] * nx + D[1] * ny + D[2] * nz;
      var s2 = 1 - mu * mu * (1 - ci * ci);
      if (s2 < 0) return { ok: false, pts: pts, blockedAt: i, tir: true };   // 全反射
      var ct = Math.sqrt(s2), f = ct - mu * ci;
      D[0] = mu * D[0] + f * nx; D[1] = mu * D[1] + f * ny; D[2] = mu * D[2] + f * nz;
      nPrev = nNext;
    }
    return { ok: true, pts: pts, P: P, D: D, opl: opl };
  }

  function intersect(s, px, py, pz, D) {
    var c = s.R ? 1 / s.R : 0, k = s.k, t;
    if (c === 0) {
      if (Math.abs(D[2]) < 1e-14) return null;
      t = -pz / D[2];
    } else {
      var A = c * (D[0] * D[0] + D[1] * D[1] + (1 + k) * D[2] * D[2]);
      var B = 2 * (c * (px * D[0] + py * D[1] + (1 + k) * pz * D[2]) - D[2]);
      var C = c * (px * px + py * py + (1 + k) * pz * pz) - 2 * pz;
      if (Math.abs(A) < 1e-14) { if (Math.abs(B) < 1e-16) return null; t = -C / B; }
      else {
        var disc = B * B - 4 * A * C;
        if (disc < 0) return null;
        var sq = Math.sqrt(disc);
        var q = -0.5 * (B + (B >= 0 ? sq : -sq));
        var t1 = q / A, t2 = (Math.abs(q) < 1e-300) ? t1 : C / q;
        t = Math.abs(t1) < Math.abs(t2) ? t1 : t2;
      }
    }
    if (s.asph.length) {                                   // 非球面：牛顿迭代精修
      for (var it = 0; it < 40; it++) {
        var x = px + t * D[0], y = py + t * D[1], z = pz + t * D[2];
        var r2 = x * x + y * y, r = Math.sqrt(r2);
        var sg = sag(s, r2);
        if (!isFinite(sg)) return null;
        var f = z - sg;
        if (Math.abs(f) < 1e-11) break;
        var ds = r > 1e-12 ? dsagdr(s, r) : 0;
        if (!isFinite(ds)) return null;
        var drdt = r > 1e-12 ? (x * D[0] + y * D[1]) / r : 0;
        var fp = D[2] - ds * drdt;
        if (Math.abs(fp) < 1e-14) return null;
        t -= f / fp;
      }
    }
    return t;
  }

  /* ---------- 近轴：EFL / BFL / 入瞳 ---------- */
  function firstOrder(surfaces, lambda, stopIdx) {
    var N = surfaces.length;
    var y = 1, u = 0, n = 1;
    for (var i = 0; i < N; i++) {
      var s = surfaces[i], c = s.R ? 1 / s.R : 0, n2 = s.n(lambda);
      u = (n * u - y * c * (n2 - n)) / n2; n = n2;
      if (i < N - 1) y += u * s.T;
    }
    var efl = -1 / u, bfl = -y / u;

    // 物方 -> 光阑面 的 (y, ω=n·u) 传输矩阵
    var M = [1, 0, 0, 1];                                   // [a b; c d]
    var nn = 1;
    for (var j = 0; j <= stopIdx && j < N; j++) {
      var sj = surfaces[j], cj = sj.R ? 1 / sj.R : 0, nj2 = sj.n(lambda);
      if (j === stopIdx) break;                             // 停在光阑面顶点平面（折射前）
      var phi = (nj2 - nn) * cj;
      M = [M[0], M[1], -phi * M[0] + M[2], -phi * M[1] + M[3]];   // 折射
      var d = sj.T / nj2;
      M = [M[0] + d * M[2], M[1] + d * M[3], M[2], M[3]];         // 转移
      nn = nj2;
    }
    var A = M[0], B = M[1];
    var zEP = Math.abs(A) > 1e-12 ? B / A : 0;              // 相对面 0 顶点
    return { efl: efl, bfl: bfl, zEP: zEP, pupilMag: A };
  }

  /* ---------- 从轴上物点出发、初始斜率 u=1 的近轴光线 ----------
     返回像方斜率 uEnd。放大率 m = u/u' = 1/uEnd（拉格朗日不变量，物像空间都在空气中）。
     ------------------------------------------------------------------ */
  function paraxFromObject(surfaces, lambda, objDist) {
    var y = objDist, u = 1, n = 1;                  // 物距 objDist>0，到面 1 顶点时高度 = objDist
    for (var i = 0; i < surfaces.length; i++) {
      var s = surfaces[i], c = s.R ? 1 / s.R : 0, n2 = s.n(lambda);
      u = (n * u - y * c * (n2 - n)) / n2; n = n2;
      if (i < surfaces.length - 1) y += u * s.T;
    }
    return u;
  }

  /* ---------- 构建系统 ---------- */
  function buildSystem(surfaces, opt) {
    var zv = [], z = 0;
    for (var i = 0; i < surfaces.length; i++) { zv.push(z); z += surfaces[i].T; }
    var zImg = z + (opt.defocus || 0);
    var lam0 = opt.lambdas[opt.primary].nm / 1000;
    var fo = firstOrder(surfaces, lam0, opt.stopIdx);

    // 物距：opt.objDist 为正数（mm）表示有限共轭，缺省 / 非有限 / 过大都按无限远
    var objD = opt.objDist;
    // 物距超过 1e7 mm（10 km）一律当无限远：光学文件里的「无限远」常写成 1e10~1e15，
    // 真按有限共轭算会两头出事——近轴光线起始高度爆掉，而且光程累加到 1e10 mm 时
    // 双精度的相对误差就已经是微米量级，波前（要纳米分辨）直接失去意义
    var finite = isFinite(objD) && objD > 0 && objD < 1e7;
    var zObj = finite ? -objD : null;
    var uEnd = finite ? paraxFromObject(surfaces, lam0, objD) : 0;
    var mag = (finite && Math.abs(uEnd) > 1e-12) ? 1 / uEnd : 0;

    var epd;
    if (opt.apertureMode === 'epd') epd = opt.epd;
    else if (opt.apertureMode === 'stop' && surfaces[opt.stopIdx] && surfaces[opt.stopIdx].sd && Math.abs(fo.pupilMag) > 1e-9)
      epd = 2 * surfaces[opt.stopIdx].sd / Math.abs(fo.pupilMag);
    else if (opt.apertureMode === 'fnoinf') epd = Math.abs(fo.efl) / opt.fno;   // Zemax「Image Space F/#」：EFL/EPD，有限共轭也按这个定入瞳
    else if (finite) {
      // opt.fno 是像方「工作 F/#」：F/# = 1/(2·|u'|)，u' 与入瞳直径成正比，一步反解
      var yEP = fo.zEP - zObj;                       // 单位斜率光线在入瞳面的高度
      var uT = 1 / (2 * opt.fno);
      epd = Math.abs(uEnd) > 1e-12 ? 2 * yEP * uT / Math.abs(uEnd) : Math.abs(fo.efl) / opt.fno;
    }
    else epd = Math.abs(fo.efl) / opt.fno;

    var fnoEff;
    if (finite) {
      var k = (epd / 2) / (fo.zEP - zObj);
      fnoEff = Math.abs(uEnd) > 1e-12 ? 1 / (2 * Math.abs(k * uEnd)) : Math.abs(fo.efl) / epd;
    } else fnoEff = Math.abs(fo.efl) / epd;

    var sysObj = {
      surfaces: surfaces, zVertex: zv, zImg: zImg, totalTrack: z, stopIdx: opt.stopIdx,
      aiming: false,
      efl: fo.efl, bfl: fo.bfl, zEP: fo.zEP, epd: epd, fno: fnoEff, pupilMag: fo.pupilMag,
      zObj: zObj, mag: mag, objDist: finite ? objD : Infinity,
      vig: opt.vig || null,
      zStart: Math.min(0, fo.zEP) - Math.max(20, Math.abs(fo.efl) * 0.5)
    };
    // 光阑半径：面上写了 CIR 就用它；没写就用轴上边缘光线在光阑面的实际落点
    // （这才是给定 F/# 下真正起限制作用的半径，近轴值 epd/2·|pupilMag| 只当兜底）
    var sdW = surfaces[opt.stopIdx] && surfaces[opt.stopIdx].sd;
    sysObj.sdStop = sdW || axialStopRadius(sysObj, lam0);
    sysObj.aiming = !!opt.rayAiming && sysObj.sdStop > 0;
    return sysObj;
  }

  /* 轴上满孔径光线打在光阑面上的高度 = 该 F/# 对应的实际光阑半径 */
  function axialStopRadius(sys, lam) {
    var best = 0, si = sys.stopIdx, k;
    for (k = 0; k < 2; k++) {
      var st = startRay(sys, 0, 0, (k ? -1 : 1) * sys.epd / 2 * 0.9995);
      var t = traceRay(sys, st.P, st.D, lam, false, si + 1, true);
      if (t.ok && isFinite(t.P[1])) best = Math.max(best, Math.abs(t.P[1]));
    }
    if (best > 1e-9) return best;
    return sys.epd / 2 * (Math.abs(sys.pupilMag) > 1e-9 ? Math.abs(sys.pupilMag) : 1);
  }

  /* ---------- 从入瞳点发射一条光线并落到像面 ---------- */
  function startRay(sys, thetaDeg, ex, ey) {
    var th = thetaDeg * Math.PI / 180;
    if (sys.zObj !== null && sys.zObj !== undefined) {
      // 有限物距：θ 定义为入瞳处主光线的倾角，物点高度由此确定，光线从物点射向入瞳上的 (ex,ey)
      var dz = sys.zEP - sys.zObj;
      var hO = -Math.tan(th) * dz;
      var dx = ex, dy = ey - hO, L2 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return { P: [0, hO, sys.zObj], D: [dx / L2, dy / L2, dz / L2], pt: true };
    }
    var D = [0, Math.sin(th), Math.cos(th)];
    var L = (sys.zEP - sys.zStart) / D[2];
    return { P: [ex - D[0] * L, ey - D[1] * L, sys.zStart], D: D, pt: false };
  }

  /* ---------- 光线瞄准：求使光线精确落在光阑面 (tx,ty) 的入瞳面起点 ---------- */
  function aim(sys, thetaDeg, tx, ty, lambda) {
    var s = sys.stopIdx, m = Math.abs(sys.pupilMag) > 1e-9 ? sys.pupilMag : 1;
    var ex = tx / m, ey = ty / m;
    var hit = function (x, y) {
      var st = startRay(sys, thetaDeg, x, y);
      var r = traceRay(sys, st.P, st.D, lambda, false, s + 1, true);
      return r.ok ? r.P : null;
    };
    var d = 1e-3 * Math.max(1, sys.epd / 2);
    for (var it = 0; it < 12; it++) {
      var r0 = hit(ex, ey); if (!r0) return null;
      var fx = r0[0] - tx, fy = r0[1] - ty;
      if (fx * fx + fy * fy < 1e-14) break;
      var rx = hit(ex + d, ey), ry = hit(ex, ey + d); if (!rx || !ry) return null;
      var a = (rx[0] - r0[0]) / d, b = (ry[0] - r0[0]) / d, c = (rx[1] - r0[1]) / d, e = (ry[1] - r0[1]) / d;
      var det = a * e - b * c; if (Math.abs(det) < 1e-14) return null;
      var dx = (-fx * e + b * fy) / det, dy = (-a * fy + c * fx) / det;
      ex += dx; ey += dy;
      if (dx * dx + dy * dy < 1e-16) break;
    }
    return { ex: ex, ey: ey };
  }

  function launch(sys, thetaDeg, px, py, lambda, collect) {
    var st = startRay(sys, thetaDeg, px, py), P = st.P, D = st.D;
    var r = traceRay(sys, P, D, lambda, collect);
    if (!r.ok) return r;
    if (Math.abs(r.D[2]) < 1e-12) return { ok: false, pts: r.pts };
    var t = (sys.zImg - r.P[2]) / r.D[2];
    var ix = r.P[0] + t * r.D[0], iy = r.P[1] + t * r.D[1];
    if (collect) r.pts.push([ix, iy, sys.zImg]);
    return {
      ok: true, x: ix, y: iy, pts: r.pts, P: r.P, D: r.D,
      // 无限远物：各光线起点在同一 z 平面上，要折算到垂直入射方向的参考面（去掉倾斜项）；
      // 有限物距：所有光线同出一点，只差一个活塞项，不用修正
      opl: r.opl + (st.pt ? 0 : (D[0] * P[0] + D[1] * P[1]))
    };
  }

  /* ---------- 瞳面采样：正方网格裁圆（等面积） ---------- */
  function pupilGrid(nGrid) {
    var pts = [], step = 2 / nGrid;
    for (var i = 0; i < nGrid; i++) {
      var a = -1 + (i + 0.5) * step;
      for (var j = 0; j < nGrid; j++) {
        var b = -1 + (j + 0.5) * step;
        if (a * a + b * b <= 1) pts.push([a, b, i * nGrid + j]);
      }
    }
    return pts;
  }

  /* ---------- 波前双线性取样（等效椭圆瞳内的归一化坐标 u,v ∈ 单位圆）---------- */
  function wAt(Wd, N, u, v) {
    if (u * u + v * v > 1) return null;
    var step = 2 / N, fi = (u + 1) / step - 0.5, fj = (v + 1) / step - 0.5;
    var i0 = Math.floor(fi), j0 = Math.floor(fj), a = fi - i0, b = fj - j0;
    if (i0 >= 0 && j0 >= 0 && i0 + 1 < N && j0 + 1 < N) {
      var k00 = i0 * N + j0, k10 = (i0 + 1) * N + j0, k01 = k00 + 1, k11 = k10 + 1;
      if (Wd.ok[k00] && Wd.ok[k10] && Wd.ok[k01] && Wd.ok[k11])
        return (1 - a) * (1 - b) * Wd.w[k00] + a * (1 - b) * Wd.w[k10] +
               (1 - a) * b * Wd.w[k01] + a * b * Wd.w[k11];
    }
    // 瞳缘 2×2 模板不完整时，用可用角点做权重归一化的双线性。
    // 原来退回最近邻，会把最多半格的坐标误差当成波前差 —— PV 大的视场上足以造成
    // 几个弧度的相位噪声，正是 MTF-视场曲线抖动的主因。
    var acc = 0, ws = 0, kk, qw;
    if (i0 >= 0 && j0 >= 0) { kk = i0 * N + j0; if (Wd.ok[kk]) { qw = (1 - a) * (1 - b); acc += qw * Wd.w[kk]; ws += qw; } }
    if (i0 + 1 < N && j0 >= 0) { kk = (i0 + 1) * N + j0; if (Wd.ok[kk]) { qw = a * (1 - b); acc += qw * Wd.w[kk]; ws += qw; } }
    if (i0 >= 0 && j0 + 1 < N) { kk = i0 * N + j0 + 1; if (Wd.ok[kk]) { qw = (1 - a) * b; acc += qw * Wd.w[kk]; ws += qw; } }
    if (i0 + 1 < N && j0 + 1 < N) { kk = (i0 + 1) * N + j0 + 1; if (Wd.ok[kk]) { qw = a * b; acc += qw * Wd.w[kk]; ws += qw; } }
    return ws > 0.05 ? acc / ws : null;
  }

  /* ---------- MTF vs 视场 ----------
     几何模式：对像面光斑直接做傅里叶变换取模。
     衍射模式：按 CODE V 的做法，先用渐晕因子把通光瞳建模成缩放+偏心的等效椭圆瞳
       （对应 SETVIG 的 VUY/VLY/VUX/VLX），在该瞳内均匀取样求波前 OPD，
       OTF = 圆孔径解析面积因子（截止频率按各方向的瞳半宽缩放）× 波前相位平均 ⟨exp(iΔφ)⟩。
       无像差时相位平均恒为 1，精确退化为对应孔径的衍射极限。
     ------------------------------------------------------------------ */
  function mtfVsField(sys, opt) {
    var N = opt.nGrid, grid = pupilGrid(N), h = sys.epd / 2;
    var diff = opt.mtfMode === 'diff';
    var fields, nF;
    if (opt.fieldsMTF && opt.fieldsMTF.length) { fields = opt.fieldsMTF.slice(); nF = fields.length; }
    else { fields = []; nF = opt.nField; for (var i = 0; i < nF; i++) fields.push(opt.maxFov * i / (nF - 1)); }
    var freqs = opt.freqs, wl = opt.lambdas;
    var useAim = sys.aiming, hs = useAim ? sys.surfaces[sys.stopIdx].sd : 0;
    var lam0 = wl[opt.primary || 0].nm / 1000;
    var out = [], rayCount = 0;

    for (var fi = 0; fi < nF; fi++) {
      var th = fields[fi];
      // 等效椭圆瞳（衍射模式用；几何模式仍在整圆上取样、被挡的光线直接丢弃）
      var ax = 1, ay = 1, cy = 0, vig = null;
      if (diff) {
        var spY = pupilSpan(sys, th, lam0, 'y'), spX = pupilSpan(sys, th, lam0, 'x');
        if (!spY || !spX) { out.push({ field: th, thru: 0, T: freqs.map(function () { return 0; }), S: freqs.map(function () { return 0; }), imgH: 0, rms: 0 }); continue; }
        ay = (spY.hi - spY.lo) / 2; cy = (spY.hi + spY.lo) / 2; ax = (spX.hi - spX.lo) / 2;
        vig = { ax: ax, ay: ay, cy: cy };
      }

      var xs = [], ys = [], ws = [], sumW = 0, cx = 0, cyc = 0, nTraced = 0, nHit = 0;
      var store = diff ? wl.map(function () {
        return { w: new Float64Array(N * N), ok: new Uint8Array(N * N), R: [], idx: [] };
      }) : null;

      for (var g = 0; g < grid.length; g++) {
        var pu = diff ? ax * grid[g][0] : grid[g][0];
        var pv = diff ? cy + ay * grid[g][1] : grid[g][1];
        var q = pupilXY(sys, th, pu, pv, lam0);
        nTraced += wl.length; rayCount += wl.length;
        if (!q) continue;
        for (var li = 0; li < wl.length; li++) {
          var r = launch(sys, th, q.ex, q.ey, wl[li].nm / 1000, false);
          if (!r.ok) continue;
          var w = wl[li].w;
          nHit++; xs.push(r.x); ys.push(r.y); ws.push(w);
          sumW += w; cx += w * r.x; cyc += w * r.y;
          if (diff) { store[li].R.push(r); store[li].idx.push(grid[g][2]); }
        }
      }
      // 主光线像高（过光阑中心那条）——CODE V 的 YRI / Zemax 的 real image height 就是它。
      // 强渐晕时光斑质心会明显偏离主光线，两个都留着：质心用作 MTF 参考点，主光线用于横轴和读数
      var imgHc = chiefHeight(sys, th, lam0) || 0;
      var row = { field: th, thru: diff ? ax * ay : (nTraced ? nHit / nTraced : 0), T: [], S: [], imgH: 0, imgHc: imgHc, rms: 0, vig: vig };
      if (sumW <= 0) { for (var q0 = 0; q0 < freqs.length; q0++) { row.T.push(0); row.S.push(0); } out.push(row); continue; }
      cx /= sumW; cyc /= sumW;
      row.imgH = Math.abs(cyc);
      var s2 = 0;
      for (var m = 0; m < ys.length; m++) { var dx = xs[m] - cx, dy = ys[m] - cyc; s2 += ws[m] * (dx * dx + dy * dy); }
      row.rms = Math.sqrt(s2 / sumW) * 1000;

      if (!diff) {
        for (var q2 = 0; q2 < freqs.length; q2++) {
          var nu = freqs[q2], k = 2 * Math.PI * nu;
          var reT = 0, imT = 0, reS = 0, imS = 0;
          for (var m2 = 0; m2 < ys.length; m2++) {
            var pT = k * (ys[m2] - cyc), pS = k * (xs[m2] - cx), wm = ws[m2];
            reT += wm * Math.cos(pT); imT -= wm * Math.sin(pT);
            reS += wm * Math.cos(pS); imS -= wm * Math.sin(pS);
          }
          row.T.push(Math.sqrt(reT * reT + imT * imT) / sumW);
          row.S.push(Math.sqrt(reS * reS + imS * imS) / sumW);
        }
      } else {
        // 以多色质心为球心的参考球算 OPD（活塞项不影响 OTF，逐波长各自扣除）
        for (var li2 = 0; li2 < wl.length; li2++) {
          var St = store[li2], base = null;
          for (var t2 = 0; t2 < St.idx.length; t2++) {
            var rr = St.R[t2];
            var ddx = cx - rr.P[0], ddy = cyc - rr.P[1], ddz = sys.zImg - rr.P[2];
            var opd = rr.opl + Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (base === null) base = opd;
            St.w[St.idx[t2]] = opd - base; St.ok[St.idx[t2]] = 1;
          }
        }
        var pvMax = 0;
        for (var lp = 0; lp < wl.length; lp++) {
          var Sp = store[lp], lo = 1e30, hi = -1e30;
          for (var tp = 0; tp < Sp.idx.length; tp++) { var vv2 = Sp.w[Sp.idx[tp]]; if (vv2 < lo) lo = vv2; if (vv2 > hi) hi = vv2; }
          if (hi > lo) pvMax = Math.max(pvMax, (hi - lo) / (wl[lp].nm / 1e6));
        }
        row.wpv = pvMax;
        for (var q3 = 0; q3 < freqs.length; q3++) {
          var nu3 = freqs[q3];
          var RT = 0, IT = 0, RS = 0, IS = 0, nrm = 0;
          for (var li3 = 0; li3 < wl.length; li3++) {
            var lamUm = wl[li3].nm / 1000, lamMM = lamUm / 1000;
            // 截止频率按该方向的瞳半宽缩放 —— 渐晕使瞳变窄，截止频率同比下降
            var fnoT = sys.fno / ay, fnoS = sys.fno / ax;
            var dT = diffractionMTF(nu3, lamUm, fnoT), dS = diffractionMTF(nu3, lamUm, fnoS);
            var shT = nu3 * lamMM * fnoT, shS = nu3 * lamMM * fnoS;   // 单位圆坐标下的半剪切量
            var Wd = store[li3], ww = wl[li3].w;
            var rt = 0, it = 0, ct = 0, rs = 0, is = 0, cs = 0;
            for (var gg = 0; gg < grid.length; gg++) {
              var uu = grid[gg][0], vv = grid[gg][1];
              if (!Wd.ok[grid[gg][2]]) continue;
              var w1 = wAt(Wd, N, uu, vv + shT), w2 = wAt(Wd, N, uu, vv - shT);
              if (w1 !== null && w2 !== null) { var ph = 2 * Math.PI * (w1 - w2) / lamMM; rt += Math.cos(ph); it += Math.sin(ph); ct++; }
              var v1 = wAt(Wd, N, uu + shS, vv), v2 = wAt(Wd, N, uu - shS, vv);
              if (v1 !== null && v2 !== null) { var p2 = 2 * Math.PI * (v1 - v2) / lamMM; rs += Math.cos(p2); is += Math.sin(p2); cs++; }
            }
            if (ct > 0) { RT += ww * dT * rt / ct; IT += ww * dT * it / ct; }
            if (cs > 0) { RS += ww * dS * rs / cs; IS += ww * dS * is / cs; }
            nrm += ww;
          }
          row.T.push(nrm > 0 ? Math.min(1, Math.sqrt(RT * RT + IT * IT) / nrm) : 0);
          row.S.push(nrm > 0 ? Math.min(1, Math.sqrt(RS * RS + IS * IS) / nrm) : 0);
        }
      }
      out.push(row);
    }
    return { rows: out, fields: fields, rays: rayCount, aiming: useAim, mode: diff ? 'diff' : 'geo' };
  }

  /* ---------- 衍射极限 MTF（圆孔径） ---------- */
  function diffractionMTF(nu, lambdaUm, fno) {
    var nuc = 1000 / (lambdaUm * fno);                       // cyc/mm
    if (nu >= nuc) return 0;
    var phi = Math.acos(nu / nuc);
    return (2 / Math.PI) * (phi - Math.cos(phi) * Math.sin(phi));
  }

  /* ---------- 某视场的未渐晕瞳区间（子午方向）----------
     返回归一化坐标 [lo, hi]（−1…+1，相对光阑或入瞳半径），即 Zemax 的渐晕因子所描述的范围
     ------------------------------------------------------------------ */
  function pupilXY(sys, theta, ua, ub, lam) {          // ua/ub = 归一化瞳坐标 (x, y)
    if (sys.aiming) {
      var sd = sys.sdStop * 0.9995;
      var a = aim(sys, theta, ua * sd, ub * sd, lam);
      return a ? { ex: a.ex, ey: a.ey } : null;
    }
    var r = sys.epd / 2 * 0.9995;
    return { ex: ua * r, ey: ub * r };
  }
  function pupilAt(sys, theta, u, lam) { return pupilXY(sys, theta, 0, u, lam); }
  function passesXY(sys, theta, ua, ub, lam) {
    var q = pupilXY(sys, theta, ua, ub, lam);
    if (!q) return false;
    return launch(sys, theta, q.ex, q.ey, lam, false).ok;
  }
  /* 沿指定轴求未渐晕的瞳区间；axis='y' 子午，'x' 弧矢 */
  /* 用 CODE V .seq 里 SETVIG 存下来的渐晕系数直接给出瞳区间（按视场线性插值）。
     很多 .seq 只在像面写 CIR，镜片没有通光孔径，靠追迹根本判不出渐晕，这时这张表就是唯一依据。 */
  function vigSpan(sys, theta, axis) {
    var v = sys.vig; if (!v || !v.th || v.th.length < 1) return null;
    var up = axis === 'x' ? v.vux : v.vuy, lo = axis === 'x' ? v.vlx : v.vly;
    if (!up || !lo) return null;
    var t = Math.abs(theta), n = v.th.length, i;
    var iu = 0, il = 0, f = 0;
    if (t <= v.th[0]) { iu = il = 0; }
    else if (t >= v.th[n - 1]) { iu = il = n - 1; }
    else {
      for (i = 0; i < n - 1; i++) if (t >= v.th[i] && t <= v.th[i + 1]) { il = i; iu = i + 1; break; }
      var d = v.th[iu] - v.th[il];
      f = d > 1e-12 ? (t - v.th[il]) / d : 0;
    }
    var U = up[il] + (up[iu] - up[il]) * f, L = lo[il] + (lo[iu] - lo[il]) * f;
    var hi = 1 - U, low = -1 + L;
    if (!(hi > low)) return null;
    return { lo: low, hi: hi, fromVig: true };
  }

  function pupilSpan(sys, theta, lam, axis) {
    var vs = vigSpan(sys, theta, axis);
    if (vs) return vs;
    var X = axis === 'x';
    var f = function (u) { return X ? passesXY(sys, theta, u, 0, lam) : passesXY(sys, theta, 0, u, lam); };
    var seed = null, probe = [0, 0.2, -0.2, 0.45, -0.45, 0.7, -0.7];
    for (var i = 0; i < probe.length; i++) if (f(probe[i])) { seed = probe[i]; break; }
    if (seed === null) return null;
    var edge = function (dir) {
      var good = seed, bad = dir;
      if (f(bad)) return bad;
      for (var k = 0; k < 18; k++) { var mid = (good + bad) / 2; if (f(mid)) good = mid; else bad = mid; }
      return good;
    };
    return { lo: edge(-1), hi: edge(1) };
  }

  /* ---------- SETVIG：由真实通光反算渐晕系数 ----------
     照 CODE V 的 SET VIGNETTING 做：逐视场把四条边缘参考光线（±Y 子午、±X 弧矢）
     沿归一化瞳坐标二分，推到「刚好通过全部真实通光」的位置。往里推了多少就是渐晕系数：
       上边缘 = 1 − VUY      下边缘 = −1 + VLY      （X 方向同理）
     所以 VUY = 1 − hi、VLY = 1 + lo，和 vigSpan 用的是同一套定义，直接对得上。

     判据只认「写死的」通光：CODE V 的 CIR（面上的 sd）、Zemax 的固定 DIAM / 浮动通光 FLAP
     （由 opt.sdAp 带进来）。Zemax 自动算出来的 DIAM 是按光线包络反推的，拿它判渐晕
     等于自己挡自己，所以不算在内。
     光阑面同样不参与：归一化坐标 ±1 定义的就是它的边缘，它不可能把自己渐晕掉。

     lim[] 记下每个视场子午方向上、把光线挡住的那个面（0 基），用来告诉用户是谁在限制。
     ------------------------------------------------------------------ */
  function setVig(sys, opt) {
    var S = sys.surfaces, lam = opt.lambdas[opt.primary || 0].nm / 1000;
    var sdAp = (opt.sdAp && opt.sdAp.length === S.length) ? opt.sdAp : null;
    var stopI = sys.stopIdx, ap = [], nAp = 0, i;
    for (i = 0; i < S.length; i++) {
      var a = (i === stopI) ? 0 : (S[i].sd || (sdAp && sdAp[i]) || 0);
      ap.push(a || 0); if (a) nAp++;
    }
    if (!nAp) return null;                                   // 一个真实通光都没有，无从判起

    /* 挡住这条光线的面（0 基）；通得过返回 −1；根本追不出来返回 −2 */
    function blockAt(th, ux, uy) {
      var q = pupilXY(sys, th, ux, uy, lam);
      if (!q) return -2;
      var st = startRay(sys, th, q.ex, q.ey);
      var r = traceRay(sys, st.P, st.D, lam, true, undefined, true);   // 收点，绕开内建通光自己判
      if (!r.ok) return (r.blockedAt === undefined || r.blockedAt === null) ? -2 : r.blockedAt;
      for (var k = 1; k < r.pts.length && k - 1 < ap.length; k++) {
        var a2 = ap[k - 1]; if (!a2) continue;
        var x = r.pts[k][0], y = r.pts[k][1];
        if (Math.sqrt(x * x + y * y) > a2 * 1.0000001) return k - 1;
      }
      return -1;
    }

    /* 沿一条轴求「能全程通过」的归一化瞳区间 */
    function span(th, X) {
      var f = function (u) { return blockAt(th, X ? u : 0, X ? 0 : u) === -1; };
      var probe = [0, 0.2, -0.2, 0.45, -0.45, 0.7, -0.7, 0.9, -0.9], seed = null;
      for (var j = 0; j < probe.length; j++) if (f(probe[j])) { seed = probe[j]; break; }
      if (seed === null) return null;                        // 整条轴都过不去 —— 全渐晕
      var lim = -1;
      var edge = function (dir) {
        if (f(dir)) return dir;                              // 一直到满瞳都没挡
        var good = seed, bad = dir;
        for (var k = 0; k < 24; k++) { var m = (good + bad) / 2; if (f(m)) good = m; else bad = m; }
        var b = blockAt(th, X ? bad : 0, X ? 0 : bad);
        if (b >= 0) lim = b;
        return good;
      };
      var hi = edge(1), lo = edge(-1);
      return { lo: lo, hi: hi, lim: lim };
    }

    var ths = opt.vigFields || [], out = { th: [], vuy: [], vly: [], vux: [], vlx: [], lim: [], nAp: nAp, dark: 0 };
    for (i = 0; i < ths.length; i++) {
      var th = ths[i], sy = span(th, false), sx = span(th, true);
      out.th.push(th);
      if (!sy) { out.vuy.push(1); out.vly.push(1); out.dark++; out.lim.push(-1); }
      else { out.vuy.push(clamp01(1 - sy.hi)); out.vly.push(clamp01(1 + sy.lo)); out.lim.push(sy.lim); }
      if (!sx) { out.vux.push(1); out.vlx.push(1); }
      else { out.vux.push(clamp01(1 - sx.hi)); out.vlx.push(clamp01(1 + sx.lo)); }
    }
    return out;
    function clamp01(v) { return Math.max(0, Math.min(1.999, v)); }
  }

  /* 主光线（过光阑中心那条）在像面的高度 —— CODE V 的 YRI / Zemax 的 real image height。
     参考光线按惯例不受通光孔径限制：边缘视场上光阑中心那条常常已经被渐晕掉了，
     但视场定义仍以它为准，所以被挡时放开孔径只取几何落点。 */
  function chiefHeight(sys, theta, lam) {
    var a = aim(sys, theta, 0, 0, lam) || pupilXY(sys, theta, 0, 0, lam);
    if (!a) return null;
    var r = launch(sys, theta, a.ex, a.ey, lam, false);
    if (r.ok) return Math.abs(r.y);
    var st = startRay(sys, theta, a.ex, a.ey);
    var r2 = traceRay(sys, st.P, st.D, lam, false, undefined, true);
    if (!r2.ok || Math.abs(r2.D[2]) < 1e-12) return null;
    var t = (sys.zImg - r2.P[2]) / r2.D[2];
    return Math.abs(r2.P[1] + t * r2.D[1]);
  }

  /* ---------- 由「实像高」反解视场角（CODE V 的 YRI 定义）---------- */
  function angleForHeight(sys, hTarget, lam) {
    if (!(Math.abs(hTarget) > 1e-12)) return 0;
    // 用真正的主光线（牛顿瞄到光阑中心）反解，比在入瞳里取 u=0 稳得多：
    // 大放大率 / 强渐晕的结构下，入瞳中心那条常常已经被挡掉了
    var hAt = function (t) { return chiefHeight(sys, t, lam); };
    // 初值：无限远物按 f 估；有限物距要按共轭估，否则 1:1 微距会差出一倍
    var th0;
    if (sys.zObj !== null && sys.zObj !== undefined && Math.abs(sys.mag) > 1e-6)
      th0 = Math.atan((hTarget / Math.abs(sys.mag)) / (sys.zEP - sys.zObj)) * 180 / Math.PI;
    else th0 = Math.atan(hTarget / (Math.abs(sys.efl) || 50)) * 180 / Math.PI;
    if (!isFinite(th0) || th0 <= 0) th0 = 1;
    th0 = Math.min(th0, 80);

    // 先把目标夹住再二分：h(θ) 单调，二分不会像牛顿那样飞掉。
    // 注意大角度上主光线会追不通（返回 null），往上找的时候得能缩回来，
    // 否则一步跨进 null 区就再也出不来了（A2028 就是这样把 14.2 mm 解成初值的）
    var lo = 0, hi = th0, hhi = hAt(hi), k, step;
    for (k = 0; k < 40 && hhi === null; k++) { hi *= 0.7; hhi = hAt(hi); }   // 初值就追不通：往下收
    if (hhi === null) return th0;
    if (hhi < hTarget) {
      step = Math.max(hi * 0.25, 0.3);
      for (k = 0; k < 80; k++) {
        var nx = Math.min(hi + step, 89.5), hn = hAt(nx);
        if (hn === null) { step *= 0.5; if (step < 1e-4) break; continue; }  // 追不通就把步子减半
        lo = hi; hi = nx; hhi = hn;
        if (hhi >= hTarget || hi >= 89.4) break;
        step *= 1.5;
      }
    }
    if (hhi < hTarget) return hi;                       // 这颗镜头够不到该像高，给能追通的最大角
    for (k = 0; k < 60; k++) {
      var mid = 0.5 * (lo + hi), hm = hAt(mid);
      if (hm === null) { hi = mid; continue; }
      if (Math.abs(hm - hTarget) < 1e-9) return mid;
      if (hm < hTarget) lo = mid; else hi = mid;
      if (hi - lo < 1e-9) break;
    }
    return 0.5 * (lo + hi);
  }

  /* ---------- Layout 几何 ---------- */
  /* ================= 球差 / 场曲·像散 / 畸变 =================
     三条都用实光线算，不走赛得系数：
       球差   轴上光线在归一化瞳高 ρ 处与光轴的交点，减去像面 z（ρ=0 附近即该波长的近轴焦点，
              所以曲线底端不归零——那段偏移就是轴向色差）
       场曲   以主光线为中心、在光阑面上取 ±δ 的一对光线（科丁顿构型的实光线版）：
              子午取两条的交点，弧矢取 x=0 的位置，都换算成到像面的轴向距离
       畸变   主光线实像高与近轴主光线像高之差，除以近轴值
     参考光线（主光线及其 ±δ 邻居）按惯例不受通光孔径限制，否则大视场上会整条消失
     ------------------------------------------------------------------ */
  function paraxChiefHeight(sys, thetaDeg, lam) {
    var S = sys.surfaces, u = Math.tan(thetaDeg * Math.PI / 180);
    var y = -u * sys.zEP, n = 1, i;                 // 主光线过入瞳中心，两种共轭下同一式子
    for (i = 0; i < S.length; i++) {
      var sf = S[i], c = sf.R ? 1 / sf.R : 0, n2 = sf.n(lam);
      u = (n * u - y * c * (n2 - n)) / n2; n = n2;
      y += u * (i < S.length - 1 ? sf.T : (sys.zImg - sys.zVertex[i]));
    }
    return y;
  }
  function rayAt(sys, th, ex, ey, lam) {            // 放开孔径的一条参考光线
    var st = startRay(sys, th, ex, ey);
    var r = traceRay(sys, st.P, st.D, lam, false, undefined, true);
    return (r.ok && Math.abs(r.D[2]) > 1e-12) ? r : null;
  }
  function axisCross(r) {                            // 与光轴 (y=0) 的交点 z
    if (Math.abs(r.D[1]) < 1e-13) return null;
    return r.P[2] - r.P[1] / r.D[1] * r.D[2];
  }

  function aberrations(sys, opt) {
    var wl = opt.lambdas, out = { lsa: [], tsf: [], dist: [], hMax: 0 };
    var nF = Math.max(5, opt.nAberField || 21), nR = 33, i, j, w;
    var thMax = opt.maxFov || 0;
    var epr = sys.epd / 2;

    for (w = 0; w < wl.length; w++) {
      var lam = wl[w].nm / 1000;
      /* ---- 球差 ---- */
      var pts = [];
      for (i = 1; i <= nR; i++) {
        var rho = i / nR;
        var q = pupilXY(sys, 0, 0, rho, lam); if (!q) continue;
        var r = rayAt(sys, 0, q.ex, q.ey, lam); if (!r) continue;
        var zc = axisCross(r); if (zc === null || !isFinite(zc)) continue;
        pts.push([zc - sys.zImg, rho]);
      }
      if (pts.length) pts.unshift([pts[0][0], 0]);   // ρ→0 用最内一条外推，避免 0/0
      out.lsa.push({ nm: wl[w].nm, pts: pts });

      /* ---- 场曲 / 像散 + 畸变 ---- */
      var T = [], S2 = [], D = [];
      for (j = 0; j <= nF; j++) {
        var th = thMax * j / nF;
        var a = aim(sys, th, 0, 0, lam) || pupilXY(sys, th, 0, 0, lam);
        if (!a) continue;
        var rc = rayAt(sys, th, a.ex, a.ey, lam); if (!rc) continue;
        var tc = (sys.zImg - rc.P[2]) / rc.D[2];
        var h = rc.P[1] + tc * rc.D[1];
        out.hMax = Math.max(out.hMax, Math.abs(h));

        var d = 0.02 * epr;
        var ru = rayAt(sys, th, a.ex, a.ey + d, lam), rd = rayAt(sys, th, a.ex, a.ey - d, lam);
        if (ru && rd) {
          // 两条子午光线在 (y,z) 面内的交点
          var det = ru.D[1] * rd.D[2] - ru.D[2] * rd.D[1];
          if (Math.abs(det) > 1e-14) {
            var dy = rd.P[1] - ru.P[1], dz = rd.P[2] - ru.P[2];
            var t1 = (dy * rd.D[2] - dz * rd.D[1]) / det;
            T.push([ru.P[2] + t1 * ru.D[2] - sys.zImg, Math.abs(h)]);
          }
        }
        var rs = rayAt(sys, th, a.ex + d, a.ey, lam);
        if (rs && Math.abs(rs.D[0]) > 1e-14) {
          var zs = rs.P[2] - rs.P[0] / rs.D[0] * rs.D[2];
          S2.push([zs - sys.zImg, Math.abs(h)]);
        }
        var hp = paraxChiefHeight(sys, th, lam);
        if (Math.abs(hp) > 1e-9) D.push([(Math.abs(h) - Math.abs(hp)) / Math.abs(hp) * 100, Math.abs(h)]);
        else D.push([0, 0]);
      }
      out.tsf.push({ nm: wl[w].nm, T: T, S: S2 });
      out.dist.push({ nm: wl[w].nm, pts: D });
    }
    return out;
  }

  /* ================= 光线扇形（ray fan / CODE V 的 RIM） =================
     每个视场两格：子午格是 Δy 随子午瞳坐标变化，弧矢格是 Δx 随弧矢瞳坐标变化。
     横轴一律取整个入瞳的归一化坐标 −1…+1，曲线只画在该视场未渐晕的那一段——
     所以边缘视场的曲线会短一截，和 CODE V 的 RIM 图一样。
     纵向零点取该视场<b>主光线</b>（瞄到光阑中心那条）在主波长下的落点，
     于是各波长之间的上下错开就是倍率色差。
     官方宏 cvquickrim.seq 的做法是先扫一遍所有视场 / 波长的最大像差，
     再用 SSI 给所有格子设同一个对称刻度，这里照搬。
     ------------------------------------------------------------------ */
  function rayFan(sys, opt) {
    var wl = opt.lambdas, lam0 = wl[opt.primary].nm / 1000;
    var nR = opt.nFanRay || 41, epr = sys.epd / 2;
    var fields = opt.fieldsFan || [];
    var rows = [], vmax = 0, i, j, w;

    for (i = 0; i < fields.length; i++) {
      var th = fields[i];
      var spY = pupilSpan(sys, th, lam0, 'y') || { lo: -1, hi: 1 };
      var spX = pupilSpan(sys, th, lam0, 'x') || { lo: -1, hi: 1 };
      // 基准：主光线（瞄到光阑中心）在主波长下的像面落点
      var ac = aim(sys, th, 0, 0, lam0) || pupilXY(sys, th, 0, 0, lam0);
      var rc = ac ? launch(sys, th, ac.ex, ac.ey, lam0, false) : null;
      if (!rc || !rc.ok) { var rr = ac ? rayAt(sys, th, ac.ex, ac.ey, lam0) : null; 
        if (rr) { var tt = (sys.zImg - rr.P[2]) / rr.D[2]; rc = { ok: true, x: rr.P[0] + tt * rr.D[0], y: rr.P[1] + tt * rr.D[1] }; } }
      if (!rc || !rc.ok) { rows.push({ field: th, imgH: 0, T: [], S: [] }); continue; }

      var row = { field: th, imgH: Math.abs(rc.y), T: [], S: [], spanY: spY, spanX: spX };
      for (w = 0; w < wl.length; w++) {
        var lam = wl[w].nm / 1000, T = [], S2 = [];
        for (j = 0; j < nR; j++) {
          var u = -1 + 2 * j / (nR - 1);
          if (u >= spY.lo && u <= spY.hi) {
            var q = pupilXY(sys, th, 0, u, lam);
            if (q) { var r = launch(sys, th, q.ex, q.ey, lam, false); if (r.ok) T.push([u, r.y - rc.y]); }
          }
          if (u >= spX.lo && u <= spX.hi) {
            var q2 = pupilXY(sys, th, u, 0, lam);
            if (q2) { var r2 = launch(sys, th, q2.ex, q2.ey, lam, false); if (r2.ok) S2.push([u, r2.x - rc.x]); }
          }
        }
        T.forEach(function (p) { vmax = Math.max(vmax, Math.abs(p[1])); });
        S2.forEach(function (p) { vmax = Math.max(vmax, Math.abs(p[1])); });
        row.T.push({ nm: wl[w].nm, pts: T });
        row.S.push({ nm: wl[w].nm, pts: S2 });
      }
      rows.push(row);
    }
    return { rows: rows, vmax: vmax, hMax: rows.reduce(function (a, r) { return Math.max(a, r.imgH); }, 0) };
  }

  function layoutGeometry(sys, opt) {
    var S = sys.surfaces, zv = sys.zVertex, h = sys.epd / 2;
    var fieldsToDraw, nF;
    if (opt.fieldsViz && opt.fieldsViz.length) { fieldsToDraw = opt.fieldsViz.slice(); nF = fieldsToDraw.length; }
    else {
      nF = Math.max(1, opt.nFieldViz || 3); fieldsToDraw = [];
      for (var q = 0; q < nF; q++) fieldsToDraw.push(nF === 1 ? 0 : opt.maxFov * q / (nF - 1));
    }
    var nRay = opt.nRayViz || 3;
    var byWvl = opt.colorBy === 'wvl' && opt.lambdas.length > 1;
    var wls = byWvl ? opt.lambdas.map(function (L, i) { return { nm: L.nm, i: i }; })
      : [{ nm: opt.lambdas[opt.primary].nm, i: opt.primary }];
    var bundles = [], maxR = new Array(S.length).fill(0);
    var zEnter = Math.min(0, sys.zEP) - Math.max(sys.totalTrack * 0.10, 2);

    for (var f = 0; f < fieldsToDraw.length; f++) {
      var th = fieldsToDraw[f];
      for (var w = 0; w < wls.length; w++) {
        var lam = wls[w].nm / 1000;
        var span = pupilSpan(sys, th, lam);
        var polys = [];
        if (span) {
          var thruAxis = span.lo < 0 && span.hi > 0;      // 主光线 u=0 未被渐晕
          var mid = (nRay - 1) / 2;
          for (var i = 0; i < nRay; i++) {
            // 在未渐晕瞳区间上整体均分；正中间那一条强制取 u=0，即过光阑中心的主光线
            var u = nRay === 1 ? (span.lo + span.hi) / 2
              : span.lo + (span.hi - span.lo) * i / (nRay - 1);
            var q2;
            if (thruAxis && i === mid) {
              // 主光线：直接牛顿迭代瞄到光阑面 (0,0)。入瞳里取 u=0 只在无瞳像差时才等价，
              // 广角反远距的瞳像差很大，A2028 在 35° 上偏到光阑面下方 0.38 mm
              var a0 = aim(sys, th, 0, 0, lam);
              q2 = a0 ? { ex: a0.ex, ey: a0.ey } : pupilAt(sys, th, 0, lam);
            } else q2 = pupilAt(sys, th, u, lam);
            if (!q2) continue;
            var r = launch(sys, th, q2.ex, q2.ey, lam, true);
            if (!r.pts || r.pts.length < 2) continue;
            var pts = r.pts.slice();
            if (pts[0][2] < zEnter && pts.length > 1) {
              var d0 = pts[1][2] - pts[0][2];
              if (Math.abs(d0) > 1e-9) {
                var t = (zEnter - pts[0][2]) / d0;
                pts[0] = [pts[0][0] + t * (pts[1][0] - pts[0][0]), pts[0][1] + t * (pts[1][1] - pts[0][1]), zEnter];
              }
            }
            polys.push(pts.map(function (p) { return [p[2], p[1]]; }));
            for (var k2 = 1; k2 < pts.length && k2 - 1 < S.length; k2++)
              maxR[k2 - 1] = Math.max(maxR[k2 - 1], Math.abs(pts[k2][1]));
          }
        }
        bundles.push({ field: th, fi: f, wi: wls[w].i, nm: wls[w].nm, rays: polys, span: span });
      }
    }

    /* 每面的画图半径。优先级：
         面上写死的通光 (CODE V CIR) → 文件里的画图半口径 (Zemax DIAM/FLAP) → 光线包络反推。
       最后再过一道「相邻两面不许互相穿透」的钳位：实际设计里镜片间隙最小就是 0，
       靠光线包络反推的半径在近摄结构会被光线推大，强曲率面的矢高就插进邻面里。 */
    var sdD = (opt.sdDraw && opt.sdDraw.length === S.length) ? opt.sdDraw : null;
    var sdA = (opt.sdAp && opt.sdAp.length === S.length) ? opt.sdAp : null;
    var draw = new Array(S.length);
    for (var d0 = 0; d0 < S.length; d0++) {
      var hard = S[d0].sd || (sdA && sdA[d0]) || 0;       // 写死的通光：CIR / 固定 DIAM / FLAP
      var fromFile = hard || (sdD && sdD[d0]) || 0;
      draw[d0] = fromFile || Math.max(maxR[d0] * 1.06, h * 0.3);
      // 自动算出来的半口径不是物理孔径：Zemax 存的是它自己那一份光线包络（光阑面上是近轴光瞳半径），
      // 本页的光线只要走得更远，就得按本页的包络画，否则会画成「光线擦着镜片外面过去」。
      // 写死通光的面不动 —— 那是真挡光的，光线本来就被切在孔径上了。
      if (!hard && fromFile) draw[d0] = Math.max(draw[d0], maxR[d0] * 1.002);
    }
    for (var d1 = 0; d1 + 1 < S.length; d1++) {
      var A = S[d1], B = S[d1 + 1], zA = zv[d1], zB = zv[d1 + 1];
      var want = Math.max(draw[d1], draw[d1 + 1]);
      var gapAt = function (r) { return (zB + safeSag(B, r)) - (zA + safeSag(A, r)); };
      if (gapAt(want) >= 0) continue;                       // 到最外圈都没穿模
      var N2 = 64, lo = 0, hi = want;
      for (var d2 = 1; d2 <= N2; d2++) {                    // 先粗扫出第一次穿模的区间
        var rr = want * d2 / N2;
        if (gapAt(rr) < 0) { hi = rr; lo = want * (d2 - 1) / N2; break; }
      }
      for (var d3 = 0; d3 < 30; d3++) { var mm = (lo + hi) / 2; if (gapAt(mm) >= 0) lo = mm; else hi = mm; }
      draw[d1] = Math.min(draw[d1], lo);
      draw[d1 + 1] = Math.min(draw[d1 + 1], lo);
    }

    var elems = [];
    for (var i2 = 0; i2 < S.length; i2++) {
      if (!S[i2].isGlass || i2 + 1 >= S.length) continue;
      var sdA = draw[i2];
      var sdB = draw[i2 + 1];
      var sd = Math.max(sdA, sdB);
      elems.push({
        front: profile(S[i2], zv[i2], sdA, sd), back: profile(S[i2 + 1], zv[i2 + 1], sdB, sd), sd: sd,
        cemented: i2 > 0 && S[i2 - 1].isGlass
      });
    }
    return { elements: elems, bundles: bundles, maxR: maxR, drawSd: draw, fields: fieldsToDraw, zEnter: zEnter, byWvl: byWvl, sdStop: sys.sdStop };
  }

  function safeSag(s, r) {
    var z = sag(s, r * r);
    if (isFinite(z)) return z;
    for (var f = 0.999; f > 0.5; f -= 0.02) { z = sag(s, r * r * f * f); if (isFinite(z)) return z; }
    return 0;
  }
  /* 面型轮廓：自身通光内按矢高，超出部分按机械边缘平切（同光学制图习惯） */
  function profile(s, z0, ownSd, drawSd) {
    var pts = [], N = 41, lim = Math.min(ownSd, drawSd), flat = drawSd > lim + 1e-9;
    var zEdge = z0 + safeSag(s, lim);
    if (flat) pts.push([zEdge, -drawSd]);
    for (var i = 0; i <= N; i++) {
      var r = -lim + 2 * lim * i / N;
      pts.push([z0 + safeSag(s, r), r]);
    }
    if (flat) pts.push([zEdge, drawSd]);
    return pts;
  }

  return {
    CATALOG: CATALOG, FORMULA: FORMULA, makeGlass: makeGlass, parsePrescription: parsePrescription,
    glassCount: glassCount, glassNames: glassNames, glassCatalogs: glassCatalogs, parseMaterial: parseMaterial,
    paraxFromObject: paraxFromObject, pupilSpan: pupilSpan,
    buildSystem: buildSystem, firstOrder: firstOrder, traceRay: traceRay, launch: launch, aim: aim,
    mtfVsField: mtfVsField, diffractionMTF: diffractionMTF, angleForHeight: angleForHeight, layoutGeometry: layoutGeometry, pupilSpan: pupilSpan,
    setVig: setVig, pupilGrid: pupilGrid, sag: sag, pupilXY: pupilXY, aberrations: aberrations, chiefHeight: chiefHeight, rayFan: rayFan
  };
})();

if (typeof module !== 'undefined') module.exports = OPT;
