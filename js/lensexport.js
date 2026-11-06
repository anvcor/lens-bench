/* ===================================================================
   lensexport.js — 导出 Zemax .zmx / CODE V .seq
   网页「导出 .zmx / .seq」按钮（app.js 把当前页面的状态交进来）和 tools/fcseq.js 批量导出（按镜头库 JSON 拼同样的输入）共用这一份，
   两边写出来的文件逐字相同。依赖全局 OPT（optics.js）。
   =================================================================== */
var LENSEXPORT = (function () {
  'use strict';
  var NUMRE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;   // 同 app.js：表格里的纯数字
  /* ================= 导出 .zmx / .seq =================
     当前镜头连同全部多重结构，写成 Zemax .zmx（UTF-16 LE + BOM，OpticStudio 自己存的格式）或 CODE V .seq（ASCII）。
     写的就是本页此刻在算的东西：
       面：当前结构直接取表里的数，其它结构 = 当前表 + 该结构自己的覆盖项（厚度 / 半径 / 物距 / F/#）；「离焦」加在最后一个间隔上。
       孔径：.zmx 照本页的定义写（像方 F/# → FNUM v 0、工作 F/# → FNUM v 1、入瞳直径 → ENPD，光阑浮动按本页算出的入瞳写 ENPD），
             多结构时逐结构 APER。.seq 一律写入瞳直径（逐结构 ZOO EPD）：CODE V 的 FNO 在有限共轭下是工作 F 数，
             和本页的像方 F/# 不是一个量，写 EPD 两边的入瞳才一致。
       视场：库里镜头用原文件的视场表（vigH，按当前最大视场等比缩放），否则 0 / .3 / .5 / .7 / .85 / 1。
       渐晕：各结构「按通光」的表（vigAuto）或文件系数，按视场插值。.zmx 写 VDY/VCY（逐结构 FVDY/FVCY），.seq 直接写 VUY/VLY。
       通光：写了 CIR 的面和真实通光 sdAp（光阑面除外）→ .zmx 固定半口径 + 浮动通光（FLAP），.seq 的 CIR。
       面型：偶次非球面到 r¹⁶ 用 EVENASPH，更高用 XASPHERE（.seq 的 ASP 到 J = r²⁰）；奇次 → XOSPHERE / SPS ODD；
             衍射面 → BINARY_2 / DIF DOE（HCO = 相位 × λ₀/2π，λ₀ 取主波长，HOR 1）。写法照 patent-lens-to-excel 的 make_zmx / make_seq。
       玻璃：目录牌号用 Zemax 的写法（glassdb.txt 的牌号已按 Zemax 目录补回标点），CODE V 写「去标点 + _厂家」；
             偏移解 .zmx 用 GLAS 模式 4，CODE V 没有偏移解，写成数字式模型玻璃（色散换成模型的）；
             nd/νd、MIL 代码、新牌号：Zemax ___BLANK 模型玻璃，CODE V 数字式 xxxxxx.yyyy。
     导出的文件能用本页「导入」读回来。 */
  var EX_LD = 0.5875618, EX_LF = 0.4861327, EX_LC = 0.6562725, EX_LG = 0.4358343;
  function exN(v) { return isFinite(v) ? String(+(+v).toPrecision(15)) : '0'; }
  function exAscii(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '')
      .replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  }
  function exNV(fn) {
    var nd = fn(EX_LD), nF = fn(EX_LF), nC = fn(EX_LC), ng = fn(EX_LG), vd = (nd - 1) / (nF - nC);
    return { nd: nd, vd: vd, dp: (ng - nF) / (nF - nC) - (0.6438 - 0.001682 * vd) };
  }
  /* 每个面的玻璃写法（和 parsePrescription 同样的取行规则，下标与 surfaces 对齐） */
  function exGlasses(tx, S) {
    var toks = [];
    String(tx).split(/\r?\n/).forEach(function (ln) {
      var raw = ln.trim();
      if (!raw || raw[0] === '#' || raw.slice(0, 2) === '//') return;
      var tk = raw.split(/[\s,;\t]+/).filter(function (t) { return t.length; });
      if (tk.length < 2 || !isFinite(parseFloat(tk[1]))) return;
      toks.push(tk.length > 2 && !NUMRE.test(tk[2]) ? tk[2] : null);
    });
    return S.map(function (s, i) {
      var tok = toks[i];
      if (!s.isGlass || !tok) return { kind: 'air' };
      var nv = exNV(s.n), ofs = tok.indexOf('~'), base = ofs > 0 ? tok.slice(0, ofs) : tok;
      var model = { kind: 'model', nd: nv.nd, vd: nv.vd, dp: nv.dp, label: s.matLabel };
      if (base.indexOf('/') >= 0 || /^\d{6}$/.test(base.replace(/[.\s]/g, ''))) return model;
      var m = OPT.parseMaterial(base);
      if (!m || m.err || m.model || !m.fn) return model;
      var name = String(m.glass || String(m.label || '').split(' (')[0] || base).trim().toUpperCase();
      if (!name || /[\s"]/.test(name)) return model;
      var b = exNV(m.fn), g = { kind: 'cat', name: name, cat: m.cat || '', nd: b.nd, vd: b.vd, dp: b.dp, ndO: nv.nd, vdO: nv.vd };
      if (ofs > 0) { var op = tok.slice(ofs + 1).split('~'); g.kind = 'ofs'; g.dN = +op[0] || 0; g.dV = +op[1] || 0; }
      return g;
    });
  }
  function exInterp(xs, V, fr) {                     // 渐晕表（视场占比 xs）线性插值到 fr
    var idx = xs.map(function (_, i) { return i; }).sort(function (a, b) { return xs[a] - xs[b]; });
    var at = function (arr, f) {
      var P = idx.map(function (i) { return [xs[i], +arr[i] || 0]; });
      if (f <= P[0][0]) return P[0][1];
      for (var k = 1; k < P.length; k++) if (f <= P[k][0]) { var t = P[k][0] > P[k - 1][0] ? (f - P[k - 1][0]) / (P[k][0] - P[k - 1][0]) : 0; return P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t; }
      return P[P.length - 1][1];
    };
    var o = {};
    ['vuy', 'vly', 'vux', 'vlx'].forEach(function (k) { o[k] = fr.map(function (f) { return at(V[k], f); }); });
    return o;
  }
  function exVig(X, ci, fr) {
    var A = X.vigAuto && X.vigAuto[ci];
    if (A && A.f && A.vuy && A.f.length === A.vuy.length) return exInterp(A.f, A, fr);
    var c = X.cfgs && X.cfgs[ci], v = c && c.vig, H = X.vigH;
    if (v && v.vuy && H && H.length === v.vuy.length) {
      var hm = Math.max.apply(null, H.map(function (h) { return Math.abs(h) || 0; })) || 1;
      return exInterp(H.map(function (h) { return Math.abs(h) / hm; }),
        { vuy: v.vuy, vly: v.vly || v.vuy, vux: v.vux || v.vuy, vlx: v.vlx || v.vux || v.vuy }, fr);
    }
    return null;
  }
  /* 整颗镜头的导出模型：视场、各结构的面值 / 物距 / 孔径 / 入瞳 / 渐晕 */
  /* X = { st, opt, S, cfgs, cfg, rowsN, vigH, vigAuto, sdAp, name }：网页传当前页面的状态，tools/fcseq.js 照这个形状拼 */
  function exModel(X) {
    var st = X.st, opt = X.opt, S = X.S, n = S.length, warn = [];
    var cs = X.cfgs && X.cfgs.length ? X.cfgs : null;
    if (cs && X.rowsN !== n) { warn.push('表格行数和处方面数对不上（有空行？），只导出当前结构。'); cs = null; }
    var H = X.vigH, fr = null;
    if (H && H.length >= 2 && H.length <= 12) {
      var hm = Math.max.apply(null, H.map(function (h) { return Math.abs(h) || 0; }));
      if (hm > 0) fr = H.map(function (h) { return Math.abs(h) / hm; }).filter(function (f, i, a) { return a.indexOf(f) === i; });
    }
    if (!fr || fr.length < 2) fr = [0, 0.3, 0.5, 0.7, 0.85, 1];
    fr.sort(function (a, b) { return a - b; });
    var cur = cs ? X.cfg : 0, name = X.name;
    var cfgs = (cs || [null]).map(function (c, ci) {
      var isCur = !cs || ci === cur, T = S.map(function (s) { return s.T; }), R = S.map(function (s) { return s.R; });
      if (!isCur) {
        Object.keys(c.thi || {}).forEach(function (k) { if (+k < n && isFinite(+c.thi[k])) T[+k] = +c.thi[k]; });
        Object.keys(c.rdy || {}).forEach(function (k) { if (+k < n && isFinite(+c.rdy[k])) R[+k] = +c.rdy[k]; });
      }
      var obj = isCur ? st.objd : (c.obj == null ? Infinity : c.obj), fno = isCur || c.fno == null ? st.fno : c.fno;
      var S2 = S.map(function (s, i) { return (T[i] === s.T && R[i] === s.R) ? s : Object.assign({}, s, { T: T[i], R: R[i] }); });
      var sys = OPT.buildSystem(S2, Object.assign({}, opt, { fno: fno, epd: fno, objDist: obj }));
      return { title: (c && c.title) || name, T: T, R: R, obj: sys.objDist, fno: fno, epd: sys.epd, vig: exVig(X, cs ? ci : X.cfg, fr) };
    });
    return { name: name, S: S, n: n, st: st, opt: opt, fr: fr, fv: fr.map(function (f) { return +(f * st.fov).toPrecision(12); }),
             cfgs: cfgs, gl: exGlasses(st.tx, S), defoc: opt.defocus || 0, warn: warn,
             sdAp: X.sdAp && X.sdAp.length === n ? X.sdAp : null };
  }
  function exVary(M, key) {                          // 各结构值不全相同的那几行
    var out = [];
    for (var i = 0; i < M.n; i++) if (M.cfgs.some(function (c) { return Math.abs(c[key][i] - M.cfgs[0][key][i]) > 1e-12; })) out.push(i);
    return out;
  }
  function exAp(M, i, s) { return s.sd || (i !== M.opt.stopIdx && M.sdAp && M.sdAp[i]) || 0; }
  function exBfl(M, c, i) { return c.T[i] + (i === M.n - 1 ? M.defoc : 0); }

  function exZmx(M) {
    var st = M.st, opt = M.opt, L = [], warn = M.warn.slice(), gcat = [], nF = M.fv.length, nW = opt.lambdas.length, C0 = M.cfgs[0];
    var rep = function (v) { var a = []; for (var i = 0; i < nF; i++) a.push(v); return a.join(' '); };
    var apVal = st.apmode === 'fnoinf' || st.apmode === 'fno' ? function (c) { return c.fno; } : function (c) { return c.epd; };
    // 光阑浮动：照原文件写 FLOA（Float By Stop Size），光阑面写固定半口径、不加 FLAP，也不进 MCE 的 APER
    var floa = st.apmode === 'stop' && !!(M.S[opt.stopIdx] && M.S[opt.stopIdx].sd);
    var vz = function (c, k, f) { var v = c.vig; if (!v) return 0;
      return k === 'VDX' ? (v.vlx[f] - v.vux[f]) / 2 : k === 'VDY' ? (v.vly[f] - v.vuy[f]) / 2 : k === 'VCX' ? (v.vux[f] + v.vlx[f]) / 2 : (v.vuy[f] + v.vly[f]) / 2; };
    L.push('VERS 240529 0 0 0', 'MODE SEQ', 'NAME ' + String(C0.title).replace(/[\r\n]+/g, ' '),
      'NOTE 0 ' + M.name.replace(/[\r\n]+/g, ' ') + ' - exported by lens-bench ' + new Date().toISOString().slice(0, 10),
      'UNIT MM X W X CM MR CPMM',
      st.apmode === 'fnoinf' ? 'FNUM ' + exN(C0.fno) + ' 0' : st.apmode === 'fno' ? 'FNUM ' + exN(C0.fno) + ' 1' : floa ? 'FLOA' : 'ENPD ' + exN(C0.epd),
      'GCAT', 'RAIM 0 ' + (st.aim ? 2 : 0) + ' 1 1 0 0 0 0 0 1',
      'FTYP ' + (st.fmode === 'height' ? 3 : 0) + ' 0 ' + nF + ' ' + nW + ' 0 0 0 ' + nF,
      'XFLN ' + rep(0), 'YFLN ' + M.fv.map(exN).join(' '), 'FWGN ' + rep(1));
    ['VDX', 'VDY', 'VCX', 'VCY'].forEach(function (k) { L.push(k + 'N ' + M.fv.map(function (_, f) { return exN(vz(C0, k, f)); }).join(' ')); });
    L.push('VANN ' + rep(0));
    opt.lambdas.forEach(function (l, i) { L.push('WAVM ' + (i + 1) + ' ' + exN(l.nm / 1000) + ' ' + exN(l.w)); });
    L.push('PWAV ' + (opt.primary + 1));
    L.push('SURF 0', '  TYPE STANDARD', '  CURV 0 0 0 0 0 ""', '  DISZ ' + (isFinite(C0.obj) ? exN(C0.obj) : 'INFINITY'));
    var XD = function (j, v) { return '  XDAT ' + j + ' ' + (+v).toExponential(12).toUpperCase() + ' 0 0 0.000000000000E+00 0.000000000000E+00 0 ""'; };
    M.S.forEach(function (s, i) {
      var A = s.asph || [], ty = s.doe ? 'BINARY_2' : s.aspo ? 'XOSPHERE' : A.length > 7 ? 'XASPHERE' : A.length ? 'EVENASPH' : 'STANDARD', k;
      L.push('SURF ' + (i + 1));
      if (i === opt.stopIdx) L.push('  STOP');
      L.push('  TYPE ' + ty, '  CURV ' + (C0.R[i] ? exN(1 / C0.R[i]) : '0') + ' 0 0 0 0 ""');
      if (ty === 'BINARY_2') {
        if (s.aspo) warn.push('S' + (i + 1) + '：衍射面上的奇次非球面项 Zemax Binary 2 写不下，.zmx 里略去了。');
        if (A.length > 7) warn.push('S' + (i + 1) + '：衍射面上 r¹⁶ 以上的非球面项 Binary 2 写不下，.zmx 里略去了。');
        L.push('  PARM 0 ' + exN(s.doe.m));
      }
      if (ty === 'EVENASPH' || ty === 'BINARY_2') { L.push('  PARM 1 0'); for (k = 0; k < 7; k++) L.push('  PARM ' + (k + 2) + ' ' + exN(A[k] || 0)); }
      if (ty === 'XASPHERE') { L.push(XD(1, A.length + 1), XD(2, 1), XD(3, 0)); A.forEach(function (v, j) { L.push(XD(j + 4, v)); }); }
      if (ty === 'XOSPHERE') { L.push(XD(1, s.aspo.length), XD(2, 1)); s.aspo.forEach(function (v, j) { L.push(XD(j + 3, v)); }); }
      if (ty === 'BINARY_2') { L.push(XD(1, s.doe.b.length), XD(2, 1)); s.doe.b.forEach(function (v, j) { L.push(XD(j + 3, v / s.doe.m)); }); }
      L.push('  DISZ ' + exN(exBfl(M, C0, i)));
      var g = M.gl[i];
      if (g.kind === 'model') L.push('  GLAS ___BLANK 1 0 ' + exN(g.nd) + ' ' + exN(g.vd) + ' ' + exN(g.dp) + ' 0 0 0 0 0');
      else if (g.kind !== 'air') {
        if (g.cat && gcat.indexOf(g.cat) < 0) gcat.push(g.cat);
        L.push('  GLAS ' + g.name + (g.kind === 'ofs' ? ' 4 0 ' : ' 0 0 ') + exN(g.nd) + ' ' + exN(g.vd) + ' 0 0 0 0 ' +
               (g.kind === 'ofs' ? exN(g.dN) + ' ' + exN(g.dV) : '0 0'));
      }
      if (s.k) L.push('  CONI ' + exN(s.k));
      var a = exAp(M, i, s);
      if (a > 0) L.push('  DIAM ' + exN(a) + ' 1 0 0 1 ""');
      if (a > 0 && !(floa && i === opt.stopIdx)) L.push('  FLAP 0 ' + exN(a) + ' 0');
    });
    L.push('SURF ' + (M.n + 1), '  TYPE STANDARD', '  CURV 0 0 0 0 0 ""', '  DISZ 0');
    if (M.cfgs.length > 1) {
      var mce = function (op, p, vals) { vals.forEach(function (v, ci) { L.push(op + ' ' + p + ' ' + (ci + 1) + ' ' + v + ' 0 0 0 1 1 1 0 0'); }); };
      L.push('MNUM ' + M.cfgs.length + ' 1');
      M.cfgs.forEach(function (c, ci) { L.push('LTTL 0 ' + (ci + 1) + ' "' + String(c.title).replace(/["\r\n]+/g, ' ') + '" 0 0 0 1 1 1 0 0'); });
      mce('THIC', 0, M.cfgs.map(function (c) { return isFinite(c.obj) ? exN(c.obj) : '1.00000000E+10'; }));
      exVary(M, 'T').forEach(function (i) { mce('THIC', i + 1, M.cfgs.map(function (c) { return exN(exBfl(M, c, i)); })); });
      exVary(M, 'R').forEach(function (i) { mce('CRVT', i + 1, M.cfgs.map(function (c) { return c.R[i] ? exN(1 / c.R[i]) : '0'; })); });
      if (!floa) mce('APER', 0, M.cfgs.map(function (c) { return exN(apVal(c)); }));
      ['FVDX', 'FVDY', 'FVCX', 'FVCY'].forEach(function (op) {
        M.fv.forEach(function (_, f) {
          var vals = M.cfgs.map(function (c) { return vz(c, op.slice(1), f); });
          if (vals.some(function (v) { return Math.abs(v) > 1e-12; })) mce(op, f + 1, vals.map(exN));
        });
      });
    }
    L[L.indexOf('GCAT')] = 'GCAT ' + (gcat.length ? gcat.join(' ') : 'SCHOTT');
    return { text: L.join('\r\n') + '\r\n', warn: warn };
  }

  /* 内置玻璃库里有、CODE V 2026 自带目录里没有的牌号（2026-11-02 按本机 E:/CODEV2026/glass/*.xml 逐家比对，3190 个里缺这 31 个）。
     .seq 里写了目录里没有的牌号，CODE V 读到那一行就报错停下，后面的面和多重结构全丢（佳能 EF 200 F2L 的 S-LAH66N 实测）——
     这些照样写成数字式模型玻璃。其余 18 家厂商名两边一致。 */
  var EX_CVMISS = 'OHARA:SAPL,SLAH66N,SLAL18N,STIH53WN CDGM:DFK61B,DFK61B25,HK9LAGT,HWS6GT,HWS8 ' +
    'ZEON:330R,480R,K26R0,K26R15,K26R25,K26R40,K26R60,K26R80,ZEONEX330R2016,ZEONEX330R2017,ZEONEX350R2016,ZEONEX350R2017,' +
    'ZEONEX480R2016,ZEONEX480R2017,ZEONEXE48R2016,ZEONEXE48R2017,ZEONEXF52R2016,ZEONEXF52R2017,ZEONEXK22RK26R2016,' +
    'ZEONEXK22RK26R2017,ZEONEXT62R2016,ZEONEXT62R2017';
  function exCvHas(name, cat) {
    var m = new RegExp('(^| )' + cat.toUpperCase() + ':([^ ]*)').exec(EX_CVMISS);
    return !m || m[2].split(',').indexOf(name) < 0;
  }
  /* o.prv（只给批量用，网页导出不传）：一组波长 nm。CODE V 写不出牌号的面（偏移解、只有 nd/νd、CODE V 目录没收录）
     不再换成数字式模型玻璃，改写成私有玻璃（PRV…END）：在这些波长上直接写本站算出的折射率，
     CODE V 在系统波长和 PWL 重合时原样用这些值（LensSystemSetupRM p.539），所以两边折射率逐位相同。
     一模一样的玻璃只写一次，名字 LB01、LB02…（≤ 8 字符），最多 21 条波长。 */
  function exSeq(M, o) {
    var st = M.st, opt = M.opt, L = [], warn = M.warn.slice(), C0 = M.cfgs[0], nF = M.fv.length, lam0 = opt.lambdas[opt.primary].nm;
    var wrap = function (tag, vals) {               // CODE V 续行：行尾 &，续行以空格开头
      var cur = tag;
      vals.forEach(function (v) { if (cur.length + 1 + v.length > 72 && cur !== tag) { L.push(cur + ' &'); cur = ' ' + v; } else cur += ' ' + v; });
      L.push(cur);
    };
    var prv = null;
    if (o && o.prv && o.prv.length) {
      var pw = o.prv.slice().sort(function (a, b) { return b - a; })
        .filter(function (v, k, a) { return k === 0 || Math.abs(v - a[k - 1]) > 1e-9; }).slice(0, 21);
      var seen = {};
      prv = { pw: pw, lab: {}, rows: [] };
      M.gl.forEach(function (g, i) {
        var need = g.kind === 'model' || g.kind === 'ofs' ||
          (g.kind === 'cat' && !(g.cat && exCvHas(g.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), g.cat)));
        if (!need) return;
        var idx = pw.map(function (nm) { return M.S[i].n(nm / 1000).toFixed(10); }), key = idx.join(' ');
        if (!seen[key]) { seen[key] = 'LB' + ('0' + (prv.rows.length + 1)).slice(-2); prv.rows.push({ lab: seen[key], idx: idx }); }
        prv.lab[i] = seen[key];
      });
      if (!prv.rows.length) prv = null;
    }
    var cvModel = function (nd, vd) {
      if (nd >= 1 && nd < 2 && vd > 0 && vd < 100) {
        var y = (vd / 100).toFixed(6).split('.')[1].replace(/0+$/, '') || '0';
        return ('000000' + Math.round((nd - 1) * 1e6)).slice(-6) + '.' + y;
      }
      return exN(nd) + ':' + exN(vd);
    };
    var wo = opt.lambdas.map(function (l, i) { return i; }).sort(function (a, b) { return opt.lambdas[b].nm - opt.lambdas[a].nm; });
    var ang = st.fmode !== 'height', fv = M.fv.map(exN), ones = M.fv.map(function () { return '1'; }), zeros = M.fv.map(function () { return '0'; });
    var gnote = [];
    L.push('RDM;LEN "' + exAscii(M.name) + ' - exported by lens-bench ' + new Date().toISOString().slice(0, 10) + '"');
    L.push("TITLE '" + (exAscii(C0.title) || exAscii(M.name) || 'LENS') + "'");
    L.push('EPD   ' + exN(C0.epd), 'DIM   M');
    L.push('WL    ' + wo.map(function (i) { return exN(opt.lambdas[i].nm); }).join(' '));
    L.push('REF   ' + (wo.indexOf(opt.primary) + 1));
    // CODE V 的 WTW 只认整数（LensSystemSetupRM：「Integer weights for corresponding wavelengths」），小数权重读到这一行整个 .seq 中止
    // （Nikon Z 20/1.8 S 的 Zemax 文件是 0.3637 0.8592 1 …）。全是整数照原样写；有小数就按最大 = 100 取整，大于 0 的至少 1
    var wts = wo.map(function (i) { return +opt.lambdas[i].w; });
    if (wts.some(function (w) { return w !== Math.round(w); })) {
      var wmax = Math.max.apply(null, wts);
      wts = wts.map(function (w) { return w > 0 ? Math.max(1, Math.round(w / wmax * 100)) : 0; });
    }
    L.push('WTW   ' + wts.map(exN).join(' '));
    if (prv) {                                       // 放在 WL 之后、面数据之前（手册建议的位置）
      L.push('PRV');
      wrap('PWL', prv.pw.map(exN));
      prv.rows.forEach(function (r) { wrap("'" + r.lab + "'", r.idx); });
      L.push('END');
    }
    L.push("INI   '   '");
    wrap(ang ? 'XAN  ' : 'XRI  ', zeros); wrap(ang ? 'YAN  ' : 'YRI  ', fv);
    if (ang && Math.max.apply(null, M.fv) > 90) L.push('WID   Y');
    wrap('WTF  ', ones);
    if (C0.vig) ['vux', 'vlx', 'vuy', 'vly'].forEach(function (k) { wrap(k.toUpperCase() + '  ', C0.vig[k].map(exN)); });
    L.push('SO    0 ' + (isFinite(C0.obj) ? exN(C0.obj) : '0.1e11'));
    var CV = 'ABCDEFGHJ';
    M.S.forEach(function (s, i) {
      var g = M.gl[i], gs = '';
      if (prv && prv.lab[i]) {
        gs = " '" + prv.lab[i] + "'";
        gnote.push('S' + (i + 1) + ' ' + (g.kind === 'model' ? exAscii(g.label) : g.name + (g.kind === 'ofs' ? ' offset dNd ' + exN(g.dN) + ' dVd ' + exN(g.dV) : ' (' + (g.cat || 'no catalog') + ', not in CODE V catalog)')) +
          ' -> private ' + gs.trim() + ' (indices at the PWL wavelengths)');
      }
      else if (g.kind === 'model') { gs = ' ' + cvModel(g.nd, g.vd); gnote.push('S' + (i + 1) + ' ' + exAscii(g.label) + ' -> ' + gs.trim()); }
      else if (g.kind === 'ofs') { gs = ' ' + cvModel(g.ndO, g.vdO); gnote.push('S' + (i + 1) + ' ' + g.name + ' offset dNd ' + exN(g.dN) + ' dVd ' + exN(g.dV) + ' (CODE V has no offset glass) -> model ' + gs.trim()); }
      else if (g.kind === 'cat') {
        var cvn = g.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (g.cat && exCvHas(cvn, g.cat)) { gs = ' ' + cvn + '_' + g.cat.toUpperCase(); gnote.push('S' + (i + 1) + ' ' + gs.trim() + '  nd ' + g.nd.toFixed(6) + ' vd ' + g.vd.toFixed(4)); }
        else {
          gs = ' ' + cvModel(g.nd, g.vd);
          gnote.push('S' + (i + 1) + ' ' + g.name + (g.cat ? ' (' + g.cat + ', not in CODE V catalog)' : ' (no catalog)') + ' -> model ' + gs.trim());
          if (g.cat) warn.push('S' + (i + 1) + ' 的 ' + g.name + '（' + g.cat + '）CODE V 自带目录里没有，.seq 里写成模型玻璃 nd ' + g.nd.toFixed(5) + ' / νd ' + g.vd.toFixed(2) + '。');
        }
      }
      L.push('S     ' + exN(C0.R[i] || 0) + ' ' + exN(exBfl(M, C0, i)) + gs);
      var a = exAp(M, i, s);
      if (a > 0) L.push('  CIR ' + exN(a));
      if (i === opt.stopIdx) L.push('  STO');
      var A = s.asph || [];
      if (s.aspo) {
        L.push('  SPS ODD 0', '  SCO K ' + exN(s.k || 0));
        s.aspo.forEach(function (v, j) { if (v) L.push('  SCO AR' + (j + 1) + ' ' + exN(v)); });
      } else if (A.length || s.k) {
        if (A.length > 9) warn.push('S' + (i + 1) + '：r²⁰ 以上的非球面项 CODE V 的 ASP 写不下，.seq 里略去了。');
        L.push('  ASP', '  K   ' + exN(s.k || 0), '  CUF 0');
        for (var q = 0; q < Math.min(A.length, 9); q += 4) {
          var grp = [];
          for (var j = q; j < Math.min(q + 4, A.length, 9); j++) grp.push(CV[j] + ' ' + exN(A[j] || 0));
          L.push('  ' + grp.join('; '));
        }
      }
      if (s.doe) {
        L.push('  DIF DOE', '  HOR 1', '  HWL ' + exN(lam0) + '; HCT R');
        L.push('  ' + s.doe.b.map(function (b, j) { return 'HCO C' + (j + 1) + ' ' + exN(b * lam0 / 1e6 / (2 * Math.PI)); }).join('; '));
      }
    });
    L.push('SI    0 0');
    if (M.cfgs.length > 1) {
      L.push('ZOO   ' + M.cfgs.length, 'ZOO   TIT');
      M.cfgs.forEach(function (c, ci) { L.push('TIT   Z' + (ci + 1) + ' "' + (exAscii(c.title) || 'Z' + (ci + 1)) + '"'); });
      wrap('ZOO   EPD', M.cfgs.map(function (c) { return exN(c.epd); }));
      wrap('ZOO   THI S0', M.cfgs.map(function (c) { return isFinite(c.obj) ? exN(c.obj) : '0.1e11'; }));
      exVary(M, 'T').forEach(function (i) { wrap('ZOO   THI S' + (i + 1), M.cfgs.map(function (c) { return exN(exBfl(M, c, i)); })); });
      exVary(M, 'R').forEach(function (i) { wrap('ZOO   RDY S' + (i + 1), M.cfgs.map(function (c) { return exN(c.R[i] || 0); })); });
      if (M.cfgs.some(function (c) { return c.vig; }))
        ['vuy', 'vly', 'vux', 'vlx'].forEach(function (k) {
          M.fv.forEach(function (_, f) { wrap('ZOO   ' + k.toUpperCase() + ' F' + (f + 1), M.cfgs.map(function (c) { return exN(c.vig ? c.vig[k][f] : 0); })); });
        });
    }
    L.push('GO');
    // 玻璃对照写在文件头的注释里：CODE V 目录里缺哪块，照这里的 nd / νd 换成模型玻璃即可
    var head = ['! Glasses (page catalog nd / vd at d-line):'].concat(gnote.map(function (t) { return '!   ' + t; }));
    return { text: head.concat(L).join('\r\n') + '\r\n', warn: warn };
  }

  return { model: exModel, zmx: exZmx, seq: exSeq, cvHas: exCvHas, glasses: exGlasses, N: exN, ascii: exAscii };
})();
if (typeof module !== 'undefined') module.exports = LENSEXPORT;
