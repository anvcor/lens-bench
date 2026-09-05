/* ===================================================================
   lensio.js — 镜头文件 → 镜头记录
   支持 CODE V .seq 与 Zemax .zmx（含多重结构、渐晕系数、非球面、有限物距）
   浏览器和 Node 共用同一份代码：网页里拖入文件走它，tools/zmx2lens.js 批量也走它
   =================================================================== */
var LENSIO = (function () {
  'use strict';

  var PAL = ['#DE4A4A', '#C08E1A', '#2F9945', '#2596D6', '#8654E0', '#7A8892'];
  function num(s) { var v = parseFloat(s); return isFinite(v) ? v : null; }
  function fmt(v) { return String(Number(v.toPrecision(12))); }

  /* ---------- 字节 → 文本：认 UTF-16LE/BE BOM，其余按 UTF-8 ----------
     Zemax 存的 .zmx 多数是 UTF-16LE 带 BOM，CODE V .seq 一般是 ASCII */
  function decode(buf) {
    var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return dec16(u8, 2, true);
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return dec16(u8, 2, false);
    // 没有 BOM 但偶数位大量为 0 → 也当 UTF-16LE
    var zero = 0, n = Math.min(u8.length, 512);
    for (var i = 1; i < n; i += 2) if (u8[i] === 0) zero++;
    if (n > 16 && zero > n / 4) return dec16(u8, 0, true);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    return Buffer.from(u8).toString('utf8');
  }
  function dec16(u8, off, le) {
    var out = '', chunk = [];
    for (var i = off; i + 1 < u8.length; i += 2) {
      chunk.push(le ? (u8[i] | (u8[i + 1] << 8)) : ((u8[i] << 8) | u8[i + 1]));
      if (chunk.length > 8192) { out += String.fromCharCode.apply(null, chunk); chunk = []; }
    }
    return out + String.fromCharCode.apply(null, chunk);
  }

  function parseSeq(text) {
    var raw = String(text).replace(/\r/g, '').split('\n');
    var lines = [], buf = '';                       // 处理行尾 & 续行
    raw.forEach(function (l) {
      var t = l.replace(/\s+$/, '');
      if (/&$/.test(t)) { buf += t.slice(0, -1) + ' '; return; }
      lines.push(buf + t); buf = '';
    });
    if (buf) lines.push(buf);
  
    var out = { rows: [], stop: 0, warn: [] }, cur = null, inAsp = false, done = false;
  
    function flush() { if (cur) { out.rows.push(cur); cur = null; } }

    /* CODE V 多重结构（ZOO）记录：
         ZOO 5                      结构数
         ZOO TIT                    随后跟 TIT Z1 "…" 各结构名
         ZOO FNO v1 … vn            每结构一个值的系统项
         ZOO THI S12 v1 … vn        某面的厚度逐结构给值（S0 = 物面 = 物距）
         ZOO VUY F3 v1 … vn         某视场的渐晕系数逐结构给值
       另有 ZOO THC / GLC 之类是求解标记，不影响数值，跳过。 */
    function readZoo(tk, o) {
      o.zoo = o.zoo || {};
      var a = (tk[1] || '').toUpperCase();
      if (/^\d+$/.test(a)) { o.zoo.n = parseInt(a, 10); return; }
      if (a === 'TIT') return;                                    // 名字由后面的 TIT Zk 行给
      var b = (tk[2] || '').toUpperCase(), vals, mS, mF;
      if (/^[SF]\d+$/.test(b)) {
        vals = tk.slice(3).map(num);
        mS = /^S(\d+)$/.exec(b); mF = /^F(\d+)$/.exec(b);
        if (mS) {
          if (a === 'THI' || a === 'RDY' || a === 'CIR') {
            o.zoo[a] = o.zoo[a] || {};
            o.zoo[a][parseInt(mS[1], 10)] = vals;                  // 键是 CODE V 面号，S0 = 物面
          }
          return;
        }
        if (mF && (a === 'VUY' || a === 'VLY' || a === 'VUX' || a === 'VLX')) {
          o.zoo[a] = o.zoo[a] || {};
          o.zoo[a][parseInt(mF[1], 10) - 1] = vals;                // 键是视场序号 0 起
        }
        return;
      }
      vals = tk.slice(2).map(num);
      if (a === 'FNO' || a === 'EPD') o.zoo[a] = vals;
    }
  
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln || ln[0] === '!') continue;
      var up = ln.toUpperCase();
      var tk = ln.split(/[\s;]+/).filter(function (x) { return x.length; });
      var key = tk[0].toUpperCase();
  
      if (key === 'TITLE') { out.title = ln.replace(/^TITLE\s*/i, '').replace(/^['"]|['"]$/g, ''); continue; }
      if (key === 'FNO') { out.fno = num(tk[1]); continue; }
      if (key === 'EPD') { out.epd = num(tk[1]); continue; }
      if (key === 'DIM') { out.dim = tk[1]; continue; }
      if (key === 'WL') { out.wl = tk.slice(1).map(num).filter(function (v) { return v; }); continue; }
      if (key === 'WTW') { out.wtw = tk.slice(1).map(num); continue; }
      if (key === 'REF') { out.ref = num(tk[1]); continue; }
      if (key === 'YRI' || key === 'YIM') { out.fieldMode = 'height'; out.fields = tk.slice(1).map(num); continue; }
      if (key === 'YAN') { out.fieldMode = 'angle'; out.fields = tk.slice(1).map(num); continue; }
      if (key === 'YOB') { out.warn.push('视场按物高 (YOB) 定义，本页暂不支持，已忽略'); continue; }
      if (key === 'SO') { var od = num(tk[2]); if (od !== null) out.objDist = od; continue; }
      if (key === 'VUY' || key === 'VLY' || key === 'VUX' || key === 'VLX') {
        out.vig = out.vig || {};
        out.vig[key.toLowerCase()] = tk.slice(1).map(num);
        continue;
      }
      if (key === 'ZOO') { readZoo(tk, out); continue; }
      if (key === 'TIT' && /^Z\d+$/i.test(tk[1] || '')) {
        out.zoo = out.zoo || {};
        (out.zoo.tit = out.zoo.tit || [])[parseInt(tk[1].slice(1), 10) - 1] =
          ln.replace(/^TIT\s+Z\d+\s*/i, '').replace(/^['"]|['"]$/g, '');
        continue;
      }
      if (key === 'SI') { flush(); done = true; continue; }
      if (done) continue;
  
      if (key === 'S' || /^S\d+$/.test(key)) {          // 新面
        flush(); inAsp = false;
        var r = num(tk[1]), t = num(tk[2]);
        cur = { R: (r === null || r === 0) ? 'inf' : fmt(r), T: t === null ? '0' : fmt(t), mat: '', sd: '', k: '', asph: '' };
        if (tk[3] && !/^[-+]?[\d.]/.test(tk[3])) cur.mat = tk[3];
        else if (tk[3] && tk[4]) cur.mat = tk[3] + '/' + tk[4];     // nd vd 写法
        continue;
      }
      if (!cur) continue;
      if (key === 'CIR' || key === 'SD') { var c = num(tk[1]); if (c) cur.sd = fmt(c); continue; }
      if (key === 'STO') { out.stop = out.rows.length; continue; }
      if (key === 'ASP' || key === 'ASPH') { inAsp = true; if (!cur.k) cur.k = '0'; continue; }
      if (key === 'K') { cur.k = fmt(num(tk[1]) || 0); continue; }
      if (key === 'CUF' || key === 'CUY' || key === 'RDY') continue;
      if (inAsp && /^[A-H]$/.test(key)) {                // A B C D E F G H = r^4 … r^18
        var idx = 'ABCDEFGH'.indexOf(key);
        var a = (cur.asph ? cur.asph.split(/\s+/) : []);
        while (a.length <= idx) a.push('0');
        a[idx] = fmt(num(tk[1]) || 0);
        cur.asph = a.join(' ');
        // 同一行可能是 "A v; B v; C v; D v"
        for (var j = 2; j + 1 < tk.length; j += 2) {
          if (!/^[A-H]$/.test(tk[j].toUpperCase())) break;
          var id2 = 'ABCDEFGH'.indexOf(tk[j].toUpperCase());
          while (a.length <= id2) a.push('0');
          a[id2] = fmt(num(tk[j + 1]) || 0);
        }
        cur.asph = a.join(' ');
        continue;
      }
    }
    flush();
    if (out.rows.length && out.rows[out.rows.length - 1].T === '0') out.rows[out.rows.length - 1].T = '0';
    return out;
  }

  /* ---------- Zemax .zmx ----------
     关键记录：
       FTYP a b nF nW …     a: 0=角度 1=物高 2=近轴像高 3=实像高
       FNUM / ENPD          系统孔径（像方 F/# 或入瞳直径）
       XFLN / YFLN          视场值；VDXN/VDYN 偏心、VCXN/VCYN 压缩 → 渐晕椭圆
       WAVM i λµm 权重；PWAV 主波长序号
       SURF n { TYPE, CURV, DISZ, GLAS, CONI, DIAM, PARM i, STOP, FLAP/SQAP }
       多重结构：MNUM n；LTTL 0 c "名"；THIC s c v；APER p c v；FVCY/FVDY/FVCX/FVDX f c v
                CRVT s c v；GLSS s c "名"；PRAM 参数 c v
     Zemax 偶次非球面 PARM1..8 = r² r⁴ r⁶ r⁸ r¹⁰ r¹² r¹⁴ r¹⁶，本页模型没有 r² 项
     ------------------------------------------------------------------ */
  function parseZmx(text) {
    var lines = String(text).replace(/\r/g, '').split('\n');
    var out = { rows: [], stop: 0, warn: [], zoo: {}, _zmx: true };
    var surfs = [], cur = null, i, j;
    var ftyp = null, xfln = [], yfln = [], vdx = [], vdy = [], vcx = [], vcy = [];
    var waves = [], pwav = 1, fnum = null, fnumType = 0, enpd = null, unit = 'MM';
    var mnum = 0, ltt = {}, mce = [];

    for (i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var ln = raw.trim();
      if (!ln) continue;
      var tk = ln.split(/\s+/);
      var k = tk[0].toUpperCase();

      if (raw.charAt(0) !== ' ' && k === 'SURF') { cur = { n: +tk[1], parm: [], type: 'STANDARD' }; surfs.push(cur); continue; }
      if (cur && raw.charAt(0) === ' ') {                       // 面内属性都是缩进的
        if (k === 'TYPE') { cur.type = (tk[1] || '').toUpperCase(); continue; }
        if (k === 'CURV') { cur.curv = num(tk[1]); continue; }
        if (k === 'DISZ') { cur.disz = /INFINITY/i.test(tk[1]) ? Infinity : num(tk[1]); continue; }
        if (k === 'GLAS') { cur.glas = tk[1]; continue; }
        if (k === 'CONI') { cur.coni = num(tk[1]); continue; }
        if (k === 'DIAM') { cur.diam = num(tk[1]); cur.diamFix = +tk[2] === 1; continue; }
        if (k === 'PARM') { cur.parm[+tk[1]] = num(tk[2]); continue; }
        if (k === 'STOP') { cur.isStop = true; continue; }
        if (k === 'FLAP' || k === 'SQAP') { cur.ap = num(tk[2]); continue; }
        // 厚度解（内对焦镜头靠它保持总长不变，文件里只存了当前结构那一份的结果）
        //   TCOM = 互补 / Compensator：本面厚度 = 值 − 参考面厚度
        //   TOLE = 位置 / Position  ：参考面到本面（含）的厚度之和 = 值
        if (k === 'TCOM') { cur.solve = { kind: 'sum2', ref: +tk[1], val: num(tk[2]) }; continue; }
        if (k === 'TOLE') { cur.solve = { kind: 'pos', ref: +tk[1], val: num(tk[2]) }; continue; }
        continue;
      }
      if (k === 'MODE' && (tk[1] || '').toUpperCase() !== 'SEQ') out.warn.push('这是非序列 (' + tk[1] + ') 文件，只按序列面读取。');
      else if (k === 'NAME') out.title = ln.replace(/^NAME\s*/i, '');
      else if (k === 'UNIT') unit = (tk[1] || 'MM').toUpperCase();
      else if (k === 'FTYP') ftyp = tk.slice(1).map(num);
      else if (k === 'FNUM') { fnum = num(tk[1]); fnumType = tk.length > 2 ? (parseInt(tk[2], 10) || 0) : 0; }
      else if (k === 'ENPD') enpd = num(tk[1]);
      else if (k === 'XFLN') xfln = tk.slice(1).map(num);
      else if (k === 'YFLN') yfln = tk.slice(1).map(num);
      else if (k === 'VDXN') vdx = tk.slice(1).map(num);
      else if (k === 'VDYN') vdy = tk.slice(1).map(num);
      else if (k === 'VCXN') vcx = tk.slice(1).map(num);
      else if (k === 'VCYN') vcy = tk.slice(1).map(num);
      else if (k === 'WAVM') waves[+tk[1] - 1] = { nm: num(tk[2]) * 1000, w: num(tk[3]) };
      else if (k === 'PWAV') pwav = +tk[1];
      else if (k === 'MNUM') mnum = +tk[1];
      else if (k === 'LTTL') { var m = /"([^"]*)"/.exec(ln); ltt[+tk[2]] = m ? m[1] : ('Z' + tk[2]); }
      else if (/^(THIC|APER|CRVT|GLSS|FVCY|FVDY|FVCX|FVDX|FVAN|PRAM|SDIA)$/.test(k)) {
        var q = /"([^"]*)"/.exec(ln);
        mce.push({ op: k, p: +tk[1], c: +tk[2], v: num(tk[3]), s: q ? q[1] : '' });
      }
    }
    if (unit !== 'MM') out.warn.push('文件单位是 ' + unit + '，本页只按毫米计算，数值未换算。');

    // ---- 面：SURF 0 是物面，最后一个是像面 ----
    var nF = ftyp ? (ftyp[2] || 1) : 1, nW = ftyp ? (ftyp[3] || 1) : 1;
    var last = surfs.length - 1;
    var hasAp = false;
    for (i = 0; i < surfs.length; i++) {
      var s = surfs[i];
      if (i === 0) { out.objDist = (s.disz === Infinity) ? Infinity : s.disz; continue; }
      if (i === last) { if (s.diamFix && s.diam) out.imgSd = s.diam; continue; }
      var R = (s.curv && Math.abs(s.curv) > 1e-14) ? 1 / s.curv : 0;
      var r = { R: R ? fmt(R) : 'inf', T: fmt(s.disz === Infinity ? 0 : (s.disz || 0)),
                mat: s.glas || '', sd: '', k: '', asph: '' };
      // Zemax 的 FLAP 是「浮动通光」——通光等于该结构下自动算出的半口径，各结构不同。
      // 文件里只存了当前结构那一份，硬套到近摄结构会把光线全挡掉。
      // 所以有渐晕系数时不导入通光（瞳由渐晕系数完整定义，Zemax 算 MTF 也是这么做的），
      // 没有渐晕系数时才拿它当硬光阑用。
      // 硬光阑只认「固定」的通光（FLAP 或 DIAM 打了 fixed 标记）
      var apHard = s.ap || (s.diamFix ? s.diam : 0);
      if (apHard) { hasAp = true; if (!(vcy.length || vcx.length)) r.sd = fmt(apHard); }
      // 画图半口径另存一份：自动算出来的 DIAM 也要，它就是 Zemax 画图时用的镜片外形。
      // 不留这个，光路图只能靠光线包络反推半径，近摄结构会把强曲率面推到插进邻面里。
      (out.sdDraw = out.sdDraw || [])[out.rows.length] = (s.ap || s.diam) || null;
      // 真实通光另存一份：只认写死的（FLAP 或 fixed DIAM）。自动 DIAM 是光线包络反算出来的，
      // 不是物理孔径，拿它判渐晕会自己挡自己。「一键渐晕」只按这一份算。
      (out.sdAp = out.sdAp || [])[out.rows.length] = apHard || null;
      if (s.coni) r.k = fmt(s.coni);
      if (s.type === 'EVENASPH') {
        if (s.parm[1]) out.warn.push('第 ' + i + ' 面偶次非球面有 r² 项 (PARM 1 = ' + s.parm[1] + ')，本页模型没有该项，已忽略。');
        var a = [];
        for (j = 2; j <= 8; j++) a.push(s.parm[j] ? fmt(s.parm[j]) : '0');
        while (a.length && a[a.length - 1] === '0') a.pop();
        r.asph = a.join(' ');
        if (r.asph && !r.k) r.k = '0';
      } else if (s.type !== 'STANDARD') {
        out.warn.push('第 ' + i + ' 面类型 ' + s.type + ' 本页不支持，已按球面处理。');
      }
      if (s.solve) (out.solves = out.solves || []).push({ surf: s.n, kind: s.solve.kind, ref: s.solve.ref, val: s.solve.val });
      if (s.isStop) out.stop = out.rows.length;
      out.rows.push(r);
    }

    if (out.solves && out.solves.length) {
      out.solves.sort(function (a, b) { return a.surf - b.surf; });
      out.warn.push('读到 ' + out.solves.length + ' 个厚度解：'
        + out.solves.map(function (s2) {
            return s2.kind === 'pos'
              ? 'S' + s2.ref + '..S' + s2.surf + ' 厚度和 = ' + s2.val + '（位置解 TOLE）'
              : 'S' + s2.surf + ' = ' + s2.val + ' − S' + s2.ref + '（互补解 TCOM）';
          }).join('、')
        + '。这是内对焦的写法，各结构按解重算厚度（总长保持不变），而不是照抄文件里那一份。');
    }
    if (hasAp && (vcy.length || vcx.length))
      out.warn.push('文件里的固定半口径 / 浮动通光 (FLAP) 没有导入成硬光阑：Zemax 的浮动通光逐结构重算，'
        + '存下来的只是当前结构那一份，套到近摄结构会把边缘光线全挡掉。通光瞳完全由渐晕系数 (VDY/VCY) 决定，'
        + 'Zemax 自己算 MTF 也是这么做的。');

    // ---- 孔径 / 波长 / 视场 ----
    // FNUM 第二个数是孔径类型：0 = Image Space F/#（EFL/EPD，有限共轭也按无限远定义）；1 = Paraxial Working F/#
    if (fnum) { out.fno = fnum; out.fnoInf = (fnumType === 0); } else if (enpd) out.epd = enpd;
    out.wl = []; out.wtw = [];
    for (i = 0; i < nW && i < waves.length; i++) { out.wl.push(+waves[i].nm.toFixed(4)); out.wtw.push(waves[i].w); }
    out.ref = Math.min(Math.max(pwav, 1), out.wl.length || 1);

    var ft = ftyp ? ftyp[0] : 0;
    out.fieldMode = (ft === 2 || ft === 3) ? 'height' : 'angle';
    if (ft === 1) out.warn.push('视场按物高定义 (FTYP 1)，本页按角度处理，最大视场取自 YFLN。');
    // Zemax 视场表通常从大到小，本页要求由小到大
    var idx = [];
    for (i = 0; i < nF; i++) idx.push(i);
    idx.sort(function (a2, b2) { return Math.abs(yfln[a2] || 0) - Math.abs(yfln[b2] || 0); });
    out.fields = idx.map(function (p) { return Math.abs(yfln[p] || 0); });
    out._fidx = idx;
    if (xfln.slice(0, nF).some(function (v) { return v; })) out.warn.push('文件有 X 视场 (XFLN)，本页只算 Y 视场。');

    // ---- 渐晕：Zemax 的 (VDY, VCY) 椭圆 → 本页/CODE V 的 (VUY, VLY) ----
    // 未渐晕区间 = [VDY-(1-VCY), VDY+(1-VCY)]，而 [lo,hi] = [-1+VLY, 1-VUY]
    if (vcy.length || vcx.length) {
      out.vig = { vuy: [], vly: [], vux: [], vlx: [] };
      idx.forEach(function (p) {
        var dy = vdy[p] || 0, cy = vcy[p] || 0, dx = vdx[p] || 0, cx = vcx[p] || 0;
        out.vig.vuy.push(cy - dy); out.vig.vly.push(cy + dy);
        out.vig.vux.push(cx - dx); out.vig.vlx.push(cx + dx);
      });
    }

    // ---- 多重结构 ----
    if (mnum > 1) {
      var z = out.zoo = { n: mnum, tit: [] };
      for (i = 1; i <= mnum; i++) z.tit[i - 1] = ltt[i] || ('Z' + i);
      mce.forEach(function (e) {
        var ci = e.c - 1;
        if (ci < 0 || ci >= mnum) return;
        if (e.op === 'THIC') {                       // p = Zemax 面号，0 = 物面
          (z.THI = z.THI || {});
          (z.THI[e.p] = z.THI[e.p] || [])[ci] = e.v;
        } else if (e.op === 'CRVT') {
          (z.RDY = z.RDY || {});
          (z.RDY[e.p] = z.RDY[e.p] || [])[ci] = (e.v && Math.abs(e.v) > 1e-14) ? 1 / e.v : 0;
        } else if (e.op === 'APER') {
          (z.FNO = z.FNO || [])[ci] = e.v;
        } else if (/^FV(CY|DY|CX|DX)$/.test(e.op)) {
          (z._fv = z._fv || {});
          (z._fv[e.op] = z._fv[e.op] || {});
          (z._fv[e.op][e.p - 1] = z._fv[e.op][e.p - 1] || [])[ci] = e.v;
        } else if (e.op === 'GLSS') {
          out.warn.push('多重结构里有换玻璃 (GLSS 面 ' + e.p + ')，本页只跟随厚度 / 曲率 / F/# / 渐晕，玻璃保持第 1 结构。');
        }
      });
      // FVxx 也换算成 VUY/VLY/VUX/VLX，并按视场重排
      if (z._fv) {
        ['VUY', 'VLY', 'VUX', 'VLX'].forEach(function (key) { z[key] = {}; });
        idx.forEach(function (p, newI) {
          for (var c = 0; c < mnum; c++) {
            var g = function (op, def) {
              var t = z._fv[op] && z._fv[op][p]; 
              return (t && t[c] != null) ? t[c] : def;
            };
            var dy = g('FVDY', vdy[p] || 0), cy = g('FVCY', vcy[p] || 0);
            var dx = g('FVDX', vdx[p] || 0), cx = g('FVCX', vcx[p] || 0);
            (z.VUY[newI] = z.VUY[newI] || [])[c] = cy - dy;
            (z.VLY[newI] = z.VLY[newI] || [])[c] = cy + dy;
            (z.VUX[newI] = z.VUX[newI] || [])[c] = cx - dx;
            (z.VLX[newI] = z.VLX[newI] || [])[c] = cx + dx;
          }
        });
        delete z._fv;
      }
      // Zemax 面号 = 本页行号 + 1（面 0 是物面），与 CODE V 的 S 编号一致，无需换算
    } else out.zoo = null;
    return out;
  }

  /* ---------- 中间结构 → 镜头记录（网页 loadLens 直接吃这个） ---------- */
  function rowsToText(rows) {
    return rows.map(function (r) {
      var a = [(r.R || '').trim() || 'inf', (r.T || '').trim() || '0',
               (r.mat || '').trim() || '-', (r.sd || '').trim() || '-'];
      var k = (r.k || '').trim(), asph = (r.asph || '').trim();
      if (k || asph) a.push(k || '0');
      if (asph) a.push(asph);
      return a.join('  ');
    }).join('\n');
  }
  /* ---------- 波长 → 谱色 ----------
     CIE 1931 配色函数用 Wyman/Sloan/Shirley (2013) 的多高斯拟合，转 sRGB。
     两处工程化处理：
       出色域直接截负（不做去饱和）——谱色截出来才是常见的彩虹，
         去饱和会把 656 nm 的深红推成 #ff004b 那样的粉；
       色相 / 饱和度保持不动，只把亮度归一到统一目标，
         否则黄绿在浅色底上、蓝紫在深色底上都会看不清。
     拟合的尾巴在 680 nm 以上会失真（x̄ 与 ȳ 交叉，750 nm 会算成绿色），
     所以色相取值夹在 385~680 nm；可见区外再往灰里调一点，提示"这不是眼睛看到的颜色"。
     ------------------------------------------------------------------ */
  function cieBar(l) {
    var g = function (x, m, s1, s2) { var t = (x - m) / (x < m ? s1 : s2); return Math.exp(-0.5 * t * t); };
    return [1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
            0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
            1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8)];
  }
  var WL_Y = 0.28;                                  // 统一亮度目标（相对亮度）
  function wlColor(nm) {
    var v = parseFloat(nm);
    if (!isFinite(v) || v <= 0) return '#7A8892';
    var l = Math.max(385, Math.min(680, v));
    var c = cieBar(l);
    var a = [Math.max(0, 3.2406 * c[0] - 1.5372 * c[1] - 0.4986 * c[2]),
             Math.max(0, -0.9689 * c[0] + 1.8758 * c[1] + 0.0415 * c[2]),
             Math.max(0, 0.0557 * c[0] - 0.2040 * c[1] + 1.0570 * c[2])];
    var mx = Math.max(a[0], a[1], a[2]);
    if (!(mx > 0)) return '#7A8892';
    a = [a[0] / mx, a[1] / mx, a[2] / mx];
    if (v < 380 || v > 780) a = a.map(function (x) { return x * 0.65 + 0.35 * 0.5; });   // 可见区外调灰
    var y = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    var k = Math.min(WL_Y / y, 1 / Math.max(a[0], a[1], a[2]));
    var enc = function (x) {
      x = Math.max(0, Math.min(1, x * k));
      x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      return ('0' + Math.round(x * 255).toString(16)).slice(-2);
    };
    return '#' + enc(a[0]) + enc(a[1]) + enc(a[2]);
  }

  function cfgsFrom(sq) {
    var z = sq.zoo, n = z && z.n ? z.n : 1;
    if (!(n > 1)) return null;
    var list = [], i;
    for (i = 0; i < n; i++) {
      var c = { title: (z.tit && z.tit[i]) || ('Z' + (i + 1)), thi: {}, rdy: {}, fno: null, obj: null, vig: null };
      if (z.FNO && z.FNO[i] != null) c.fno = z.FNO[i];
      ['THI', 'RDY'].forEach(function (op) {
        if (!z[op]) return;
        Object.keys(z[op]).forEach(function (kk) {
          var sn = +kk, v = z[op][kk][i];
          if (v == null) return;
          if (sn === 0) { if (op === 'THI') c.obj = v; return; }
          (op === 'THI' ? c.thi : c.rdy)[sn - 1] = v;
        });
      });
      ['VUY', 'VLY', 'VUX', 'VLX'].forEach(function (kk) {
        if (!z[kk]) return;
        c.vig = c.vig || {};
        var arr = [];
        Object.keys(z[kk]).forEach(function (fi) { arr[+fi] = z[kk][fi][i]; });
        c.vig[kk.toLowerCase()] = arr;
      });
      // 厚度补偿器解（Zemax TCOM）：本面厚度 = 和 − 参考面厚度。
      // 文件里存的 DISZ 只是「当前结构」那一份，别的结构必须按解重算，
      // 否则内对焦镜头会被当成整组前伸，总长和后组位置全错。
      if (sq.solves && sq.solves.length) {
        var baseT = (sq.rows || []).map(function (r) { return parseFloat(r.T) || 0; });
        var tAt = function (i) { return (c.thi[i] != null) ? c.thi[i] : (baseT[i] || 0); };
        sq.solves.forEach(function (sv) {                       // 已按面号升序，可以顺序求解
          var ri = sv.surf - 1, rr = sv.ref - 1;
          if (ri < 0 || ri >= baseT.length || rr < 0 || rr >= baseT.length) return;
          if (sv.kind === 'pos') {                              // 位置解：参考面到本面的厚度和固定
            var acc = 0;
            for (var q = rr; q < ri; q++) acc += tAt(q);
            c.thi[ri] = sv.val - acc;
          } else {                                              // 互补解：两面厚度之和固定
            c.thi[ri] = sv.val - tAt(rr);
          }
        });
      }
      if (!c.vig && sq.vig) c.vig = sq.vig;
      if (c.obj === null && sq.objDist != null) c.obj = sq.objDist;
      if (c.obj === null || !(c.obj < 1e7)) c.obj = Infinity;   // 1e10/1e13/1e15 这类写法都是无限远
      list.push(c);
    }
    return list;
  }
  /* 下拉里那行副标题：面数 / F# / 结构数 / 非球面数 */
  function lensSub(L) {
    var rows = (L.tx || '').split('\n').filter(function (x) { return x.trim(); });
    var nAsph = rows.filter(function (l) {
      var t = l.trim().split(/\s+/);
      if (t.length < 5) return false;
      var k = parseFloat(t[4]);
      if (isFinite(k) && k !== 0) return true;
      for (var i = 5; i < t.length; i++) { var v = parseFloat(t[i]); if (isFinite(v) && v !== 0) return true; }
      return false;
    }).length;
    var p = [rows.length + ' 面'];
    if (L.fno) p.push('F/' + String(+(+L.fno).toFixed(2)));
    if (L.cfgs && L.cfgs.length > 1) p.push(L.cfgs.length + ' 结构');
    if (nAsph) p.push(nAsph + ' 非球面');
    return p.join(' · ');
  }
  function slug(s) {
    return String(s).toLowerCase().replace(/\.(zmx|seq|len|txt)$/i, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lens';
  }

  function toLens(s, meta) {
    meta = meta || {};
    var nFld = s.fields ? s.fields.length : 0;
    var L = {
      id: meta.id || slug(meta.file || s.title || 'lens'),
      // Zemax 的 NAME 往往是当前结构名（"INF" 之类），不是镜头名，所以优先用文件名
      name: meta.name || String(meta.file || s.title || '未命名').replace(/\.(zmx|seq|len|txt)$/i, ''),
      title: s.title || '',
      src: meta.file || '',
      tx: rowsToText(s.rows),
      stop: Math.min((s.stop || 0) + 1, s.rows.length),
      fno: s.fno || s.epd || 5,
      apmode: s.fno ? (s.fnoInf ? 'fnoinf' : 'fno') : (s.epd ? 'epd' : 'fno'),
      fmode: s.fieldMode === 'angle' ? 'angle' : 'height',
      fov: (s.fields && s.fields.length) ? s.fields[s.fields.length - 1] : 20,
      // 默认开光线瞄准：归一化瞳坐标必须是「光阑面上的坐标」才有意义。
      // 关掉的话它落在近轴入瞳上，大视场的瞳像差会把这个参数化整个扭掉 ——
      // FE 14mm F1.8 GM 56.7° 视场上，u = −1…+1 只覆盖光阑的 +0.13…+0.84，
      // 主光线（u=0）落在 0.47 处，整束光线全跑到光阑上半边去了。
      freqs: '10, 30, 80', aim: true,
      objd: (s.objDist != null && isFinite(s.objDist) && s.objDist < 1e7) ? s.objDist : null,
      nfield: [6, 9, 11, 15, 21, 31].indexOf(nFld) >= 0 ? nFld : 15,
      sdDraw: (s.sdDraw && s.sdDraw.some(function (v) { return v; })) ? s.sdDraw.slice() : null,
      sdAp: (s.sdAp && s.sdAp.some(function (v) { return v; })) ? s.sdAp.slice() : null,
      warn: (s.warn || []).slice()
    };
    if (!s.fields || !s.fields.length) { L.fmode = 'angle'; L.fov = 20; }
    if (s.wl && s.wl.length) {
      // 统一按波长由长到短排列（Zemax 的 WAVM 顺序是任意的），主波长跟着重定位
      var wi = s.wl.map(function (nm, i) { return i; }).slice(0, 6);
      wi.sort(function (a2, b2) { return s.wl[b2] - s.wl[a2]; });
      var pri0 = Math.min(Math.max((s.ref || 1) - 1, 0), s.wl.length - 1);
      L.wl = wi.map(function (p, i) {
        return [String(s.wl[p]), String((s.wtw && s.wtw[p] != null) ? s.wtw[p] : 1), wlColor(s.wl[p])];
      });
      L.pri = Math.max(0, wi.indexOf(pri0));
    }
    L.vigH = (s.vig && s.vig.vuy && s.fields && s.fields.length === s.vig.vuy.length) ? s.fields.slice() : null;
    L.cfgs = cfgsFrom(s);
    L.sub = lensSub(L);
    return L;
  }

  /* ---------- 按内容分派：.zmx / .seq 都能吃 ---------- */
  function parseAny(input, file) {
    var text = (typeof input === 'string') ? input : decode(input);
    var isZmx = /^﻿?(VERS|MODE|NAME|FTYP|UNIT)\b/m.test(text) && /^SURF\s+\d/m.test(text);
    var s = isZmx ? parseZmx(text) : parseSeq(text);
    s.kind = isZmx ? 'zmx' : 'seq';
    return s;
  }
  function fileToLens(input, file, meta) {
    var s = parseAny(input, file);
    var L = toLens(s, Object.assign({ file: file }, meta || {}));
    L.kind = s.kind;
    return L;
  }

  return { parseSeq: parseSeq, parseZmx: parseZmx, parseAny: parseAny, toLens: toLens,
           fileToLens: fileToLens, decode: decode, rowsToText: rowsToText, slug: slug, wlColor: wlColor,
           lensSub: lensSub };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LENSIO;
