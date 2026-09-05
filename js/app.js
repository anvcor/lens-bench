(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var FIELDS = ['R', 'T', 'mat', 'sd', 'k', 'asph'];
  var NFAN = 6;                       // 光线扇形取 6 个等分像高的视场点

  /* ================= 镜头库 =================
     LENSDB.inline 里有就直接用（单文件版把全部镜头内联进来）；
     没有就按 id 去 LENSDB.base 取 <id>.json（部署版几百颗镜头只在选中时才下载一颗）。 */
  var LENSDB = (window.LENSDB && typeof window.LENSDB === 'object')
    ? window.LENSDB : { index: [], inline: {}, base: 'data/lenses/' };
  var LENSCACHE = {};

  /* 镜头菜单分两级：先品牌、再镜头。品牌顺序就按 index 里的先后（build.js 已按
     lenses/meta.json 的 order 排好），没标品牌的归到最后一组。 */
  var OTHERB = '其他 / 未分类';
  function brandOf(e) { return e.brand || OTHERB; }
  function idxEntry(id) {
    for (var i = 0; i < LENSDB.index.length; i++) if (LENSDB.index[i].id === id) return LENSDB.index[i];
    return null;
  }
  /* 数据来源标记（逆向 / 专利）。挂在目录条目上，不在镜头 JSON 里——
     同一颗镜头可能同时有逆向和专利两份数据，靠这个标签在下拉里区分。 */
  var CURORIGIN = null;
  function originBadge(el, e) {
    if (!el) return;
    if (!e || !e.origin) { el.hidden = true; el.textContent = ''; el.className = 'badge'; return; }
    el.hidden = false;
    el.textContent = e.origin;
    el.className = 'badge ' + (e.origin === '专利' ? 'pat' : 'rev');
    el.title = e.originNote || e.origin;
  }
  function brandList() {
    var out = [];
    LENSDB.index.forEach(function (e) { var b = brandOf(e); if (out.indexOf(b) < 0) out.push(b); });
    return out;
  }
  function renderBrandList() {
    var bs = brandList(), n = {};
    LENSDB.index.forEach(function (e) { n[brandOf(e)] = (n[brandOf(e)] || 0) + 1; });
    $('brand').innerHTML = bs.map(function (b) {
      return '<option value="' + esc(b) + '">' + esc(b) + ' (' + n[b] + ')</option>';
    }).join('');
  }
  function renderLensList(brand) {
    var sel = $('ex');
    sel.innerHTML = LENSDB.index.filter(function (e) { return brandOf(e) === brand; }).map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) +
        (e.origin ? '（' + esc(e.origin) + '）' : '') + (e.sub ? ' · ' + esc(e.sub) : '') + '</option>';
    }).join('');
  }
  /* 把两个下拉对到某颗镜头上（不触发载入） */
  function syncLensSelects(id) {
    var e = null;
    for (var i = 0; i < LENSDB.index.length; i++) if (LENSDB.index[i].id === id) { e = LENSDB.index[i]; break; }
    if (!e) { $('ex').selectedIndex = -1; return; }
    $('brand').value = brandOf(e);
    renderLensList(brandOf(e));
    $('ex').value = id;
  }
  /* 只把镜头记录取回来，不碰界面状态——对比页和主页面共用这一层缓存 */
  function getLens(id, cb) {
    var hit = LENSCACHE[id] || LENSDB.inline[id];
    if (hit) { LENSCACHE[id] = hit; cb(null, hit); return; }
    fetch(LENSDB.base + encodeURIComponent(id) + '.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (L) { LENSCACHE[id] = L; cb(null, L); })
      .catch(function (err) { cb(err); });
  }
  function loadLens(id, done) {
    var sel = $('ex'), old = sel.options[sel.selectedIndex];
    var busy = !(LENSCACHE[id] || LENSDB.inline[id]);
    if (busy && old) old.textContent = old.textContent.replace(/ · 载入中…$/, '') + ' · 载入中…';
    getLens(id, function (err, L) {
      if (old) old.textContent = old.textContent.replace(/ · 载入中…$/, '');
      if (err) {
        showMsgs(['载入镜头 ' + id + ' 失败：' + err.message +
          '（本地双击打开 html 时浏览器会拦截 fetch，请用单文件版，或把目录挂到本地服务器上）']);
        if (done) done(err); return;
      }
      CURORIGIN = idxEntry(id);
      applyLens(L);
      if (busy) { histBase(); schedule(0); }
      if (done) done(null, L);
    });
  }

  /* ================= 行模型 ================= */
  /* 谱线颜色：按波长在几条常用谱线之间插值，任何预设都能拿到合理的绘图色 */
  /* 波长 → 谱色：直接用 lensio 里那份（CIE 1931 配色函数 → sRGB），
     网页、镜头库 JSON、命令行转换用的是同一个函数，颜色必然一致 */
  var wlColor = LENSIO.wlColor;

  /* 波长预设：[波长 nm, 权重]，一律按长→短排列，WLPRI 指主波长的行号 */
  var WLSETS = {
    p5:    [['656.3', '10'], ['587.6', '27'], ['546.1', '29'], ['486.1', '23'], ['435.8', '11']],
    p3:    [['656.3', '1'], ['587.6', '1'], ['486.1', '1']],
    p1:    [['587.6', '1']],
    // Zemax「VIS Weighted (C–g, 5500 K Blackbody)」
    vis:   [['656.3', '0.8982'], ['587.6', '0.9728'], ['546.1', '1'], ['486.1', '0.984'], ['435.8', '0.911']],
    // Leica Weighted：短波截到 455，长波用 C' 线 643.8
    leica: [['643.8', '7'], ['587.6', '8'], ['546.1', '9'], ['486.1', '7'], ['455.0', '4']],
    // 日本厂商常用的光谱权重，重心明显压在 e 线
    jp:    [['656.3', '3'], ['587.6', '22'], ['546.1', '30'], ['486.1', '12'], ['435.8', '3']]
  };
  // 主波长一律取 546.1（e 线绿光）；F d C 等权和 d 单色里没有这条线，只能退回 d 线
  var WLPRI = { p5: 2, p3: 1, p1: 0, vis: 2, leica: 2, jp: 2 };
  function wlSet(k) { return WLSETS[k].map(function (x) { return { nm: x[0], w: x[1], c: wlColor(x[0]) }; }); }
  var DASH = ['', '5 2.5', '1.6 2.4', '8 2.5 1.6 2.5', '11 3', '2 2 7 2'];

  var state = { rows: [], stop: 0, sel: 0, wl: wlSet('p5'), pri: 1,
                cfgs: null, cfg: 0, vigH: null, sdDraw: null, sdAp: null, vigAuto: null };
  // cfgs = 多重结构；vigH = 渐晕表对应的像高列表；sdDraw = 画图半口径；
  // sdAp = 真实通光（只含写死的 CIR / 固定 DIAM / FLAP，「一键渐晕」按它判）；
  // vigAuto = 各结构自己算出来的渐晕表 { 结构号: {f, vuy, vly, vux, vlx, note} }，f 是视场占比
  function blankRow() { return { R: '', T: '', mat: '', sd: '', k: '', asph: '' }; }
  var NUMRE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

  function textToRows(t) {
    var out = [];
    String(t).split(/\r?\n/).forEach(function (ln) {
      ln = ln.trim();
      if (!ln || ln[0] === '#' || ln.slice(0, 2) === '//') return;
      var tk = ln.split(/[\s,;\t]+/).filter(function (x) { return x.length; });
      if (tk.length < 2) return;
      var r = blankRow(), i = 2;
      r.R = tk[0]; r.T = tk[1];
      if (tk.length > 2 && !NUMRE.test(tk[2])) { r.mat = tk[2] === '-' ? '' : tk[2]; i = 3; }
      if (tk.length > i) { r.sd = tk[i] === '-' ? '' : tk[i]; i++; }
      if (tk.length > i) { r.k = tk[i] === '-' ? '' : tk[i]; i++; }
      if (tk.length > i) { r.asph = tk.slice(i).join(' '); }
      out.push(r);
    });
    return out;
  }
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
  function isAsph(r) {
    var k = parseFloat(r.k), a = (r.asph || '').trim();
    return (isFinite(k) && k !== 0) || (a && /[1-9]/.test(a));
  }

  /* ================= LDM 表渲染 ================= */
  var GLASSLIST = false;
  function ensureGlassList() {
    if (GLASSLIST) return;
    GLASSLIST = true;
    var gn = document.getElementById('glassN');
    if (gn) gn.textContent = OPT.glassCount();
    var dl = document.createElement('datalist');
    dl.id = 'glassdl';
    var seen = {}, html = [];
    OPT.glassNames().forEach(function (n) {          // "NBK7 [SCHOTT]"
      var p = n.lastIndexOf(' [');
      var nm = p > 0 ? n.slice(0, p) : n, cat = p > 0 ? n.slice(p + 2, -1) : '';
      var k = nm.toLowerCase();
      if (seen[k]) { return; }                        // 同名只留优先目录
      seen[k] = 1;
      html.push('<option value="' + nm + '">' + cat + '</option>');
    });
    Object.keys(OPT.CATALOG).forEach(function (k) {
      if (k !== 'air' && !seen[k]) html.push('<option value="' + k.toUpperCase() + '">模型玻璃</option>');
    });
    dl.innerHTML = html.join('');
    document.body.appendChild(dl);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  /* 非球面项拆列：r.asph 仍以空格分隔的字符串存，渲染时切成 A4 A6 A8 … 独立单元格 */
  function asphArr(r) {
    var t = (r.asph || '').trim();
    return t ? t.split(/[\s,;]+/) : [];
  }
  function setAsphTerm(r, idx, v) {
    var a = asphArr(r);
    while (a.length <= idx) a.push('');
    a[idx] = String(v).trim();
    while (a.length && !a[a.length - 1]) a.pop();
    r.asph = a.join(' ');
  }
  function asphCols() {
    var m = 0;
    state.rows.forEach(function (r) { m = Math.max(m, asphArr(r).length); });
    return Math.max(4, Math.min(m + 1, 12));
  }

  function renderLDE() {
    var NA = asphCols(), i2;
    var hd = '<tr><th style="min-width:52px">表面<br>编号</th>' +
      '<th style="min-width:46px">表面<br>类型</th>' +
      '<th style="min-width:88px">Y 半径</th>' +
      '<th style="min-width:76px">厚度</th>' +
      '<th style="min-width:126px">玻璃</th>' +
      '<th style="min-width:80px">Y 半孔径</th>' +
      '<th style="min-width:74px">圆锥<br>系数</th>';
    for (i2 = 0; i2 < NA; i2++)
      hd += '<th class="ac' + (i2 ? '' : ' ac0') + '" style="min-width:132px">A' + (4 + 2 * i2) + '</th>';
    $('ldeHead').innerHTML = hd + '</tr>';

    var pad = '<td></td><td></td><td></td>' + new Array(NA + 1).join('<td></td>');
    var h = ['<tr class="fixed"><td class="num">物面</td><td class="typ">球面</td>' +
      '<td class="ro">无限</td><td class="ro">无限</td>' + pad + '</tr>'];
    state.rows.forEach(function (r, i) {
      var isStop = i === state.stop, a = asphArr(r), td = '';
      for (i2 = 0; i2 < NA; i2++) td += cellA(i, i2, asphDisp(a[i2] || ''));
      h.push('<tr data-r="' + i + '"' + (i === state.sel ? ' class="sel"' : '') + '>' +
        '<td class="num' + (isStop ? ' stop' : '') + '" data-r="' + i + '" title="点击设为光阑">' + (isStop ? '光阑' : (i + 1)) + '</td>' +
        '<td class="typ" data-typ="' + i + '">' + (isAsph(r) ? '非球面' : '球面') + '</td>' +
        cell(i, 'R', r.R, 'inf', cfgHas(i, 'R')) + cell(i, 'T', r.T, '0', cfgHas(i, 'T')) +
        cellT(i, 'mat', r.mat, '') + cell(i, 'sd', r.sd, '') +
        cell(i, 'k', r.k, '') + td + '</tr>');
    });
    h.push('<tr class="fixed"><td class="num">像面</td><td class="typ">球面</td>' +
      '<td class="ro">无限</td><td class="ro">0.0000</td>' + pad + '</tr>');
    ensureGlassList();
    $('ldeBody').innerHTML = h.join('');
  }
  function cellA(i, j, v) {
    return '<td class="ac' + (j ? '' : ' ac0') + '"><input data-r="' + i + '" data-f="a' + j + '" value="' + esc(v) +
      '" spellcheck="false" autocapitalize="off" autocorrect="off"></td>';
  }
  /* 非球面系数很小，统一按指数记法显示，省列宽又不丢精度 */
  function asphDisp(t) {
    if (!t) return '';
    var v = Number(t);
    if (!isFinite(v) || v === 0) return t;
    if (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e6) return t;
    return v.toExponential();
  }
  function cell(i, f, v, ph, zoo) {
    return '<td' + (zoo ? ' class="zoo" title="该值随多重结构变化"' : '') + '><input data-r="' + i +
      '" data-f="' + f + '" value="' + esc(v) + '" placeholder="' + ph +
      '" spellcheck="false" autocapitalize="off" autocorrect="off"></td>';
  }
  function cellT(i, f, v, ph) {
    return '<td class="txt"><input data-r="' + i + '" data-f="' + f + '" value="' + esc(v) + '" placeholder="' + ph +
      '" spellcheck="false" autocapitalize="off" autocorrect="off"' + (f === 'mat' ? ' list="glassdl"' : '') + '></td>';
  }

  /* ================= 波长表 ================= */
  function wlTotal() {
    return state.wl.reduce(function (a2, r) { var v = parseFloat(r.w); return a2 + (isFinite(v) && v > 0 ? v : 0); }, 0);
  }
  function renderWL() {
    var tot = wlTotal();
    $('wlBody').innerHTML = state.wl.map(function (r, i) {
      var v = parseFloat(r.w), pct = (isFinite(v) && v > 0 && tot > 0) ? (v / tot * 100).toFixed(1) + '%' : '—';
      return '<tr data-w="' + i + '">' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td><input data-w="' + i + '" data-f="nm" value="' + esc(r.nm) + '" spellcheck="false"></td>' +
        '<td><input data-w="' + i + '" data-f="w" value="' + esc(r.w) + '" spellcheck="false"></td>' +
        '<td class="ro" data-pct="' + i + '">' + pct + '</td>' +
        '<td class="clr"><input type="color" data-w="' + i + '" data-f="c" value="' + esc(r.c) + '" aria-label="绘图颜色"></td>' +
        '<td class="pri"><input type="radio" name="pri" data-w="' + i + '"' + (i === state.pri ? ' checked' : '') + ' aria-label="设为主波长"></td>' +
        '</tr>';
    }).join('');
    $('wlBadge').textContent = state.wl.length + ' 条 · Σ权重 ' + (+wlTotal().toFixed(3));
  }
  function refreshPct() {
    var tot = wlTotal();
    state.wl.forEach(function (r, i) {
      var c = $('wlBody').querySelector('[data-pct="' + i + '"]'); if (!c) return;
      var v = parseFloat(r.w);
      c.textContent = (isFinite(v) && v > 0 && tot > 0) ? (v / tot * 100).toFixed(1) + '%' : '—';
    });
    $('wlBadge').textContent = state.wl.length + ' 条 · Σ权重 ' + (+tot.toFixed(3));
  }

  /* ================= 多重结构（CODE V ZOO） =================
     每个结构存一份「相对基础处方的覆盖项」：物距、F/#、若干面的厚度 / 曲率半径，
     以及该结构自己的渐晕系数表。切换结构时把覆盖项写进当前行，被覆盖的格子在表里标色。 */
  function parseObjDist(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t || /^(inf|infinity|无限|∞)$/i.test(t)) return Infinity;
    var x = parseFloat(t);
    return (isFinite(x) && x > 0) ? x : Infinity;
  }
  function fmtObjDist(d) { return (isFinite(d) && d > 0 && d < 1e7) ? String(+d.toFixed(6)) : 'inf'; }

  function renderCfg() {
    var wrap = $('cfgWrap'), sel = $('cfg');
    if (!state.cfgs || state.cfgs.length < 2) { wrap.style.display = 'none'; sel.innerHTML = ''; return; }
    wrap.style.display = '';
    sel.innerHTML = state.cfgs.map(function (c, i) {
      return '<option value="' + i + '"' + (i === state.cfg ? ' selected' : '') + '>Z' + (i + 1) + ' · ' + esc(c.title) + '</option>';
    }).join('');
  }
  function applyCfg(i) {
    var c = state.cfgs && state.cfgs[i]; if (!c) return;
    state.cfg = i;
    Object.keys(c.thi).forEach(function (k) { if (state.rows[k]) state.rows[k].T = String(c.thi[k]); });
    Object.keys(c.rdy).forEach(function (k) { if (state.rows[k]) state.rows[k].R = (c.rdy[k] === 0 ? 'inf' : String(c.rdy[k])); });
    if (c.fno != null) $('fno').value = c.fno;
    $('objd').value = fmtObjDist(c.obj == null ? Infinity : c.obj);   // JSON 里 Infinity 会变成 null
  }
  /* 改到被结构覆盖的格子时，同时更新该结构存的值，否则一切结构就被冲掉 */
  function cfgWriteBack(ri, field, val) {
    var c = state.cfgs && state.cfgs[state.cfg]; if (!c) return;
    var v = parseFloat(val);
    if (field === 'T' && c.thi[ri] !== undefined && isFinite(v)) c.thi[ri] = v;
    if (field === 'R' && c.rdy[ri] !== undefined && isFinite(v)) c.rdy[ri] = v;
  }
  function cfgHas(ri, field) {
    var c = state.cfgs && state.cfgs[state.cfg]; if (!c) return false;
    return field === 'T' ? c.thi[ri] !== undefined : c.rdy[ri] !== undefined;
  }

  /* ================= 状态读取 ================= */
  function readState() {
    return {
      tx: rowsToText(state.rows), stop: state.stop + 1,
      apmode: $('apmode').value, aim: $('aim').checked, fmode: $('fmode').value, mtfmode: $('mtfmode').value,
      fno: num($('fno').value, 5, 0.1, 1e4),
      fov: num($('fov').value, 20, 0, 89),
      defoc: num($('defoc').value, 0, -1e4, 1e4),
      objd: parseObjDist($('objd').value),
      freqs: parseList($('freqs').value, [10, 30, 80]).filter(function (v) { return v > 0; }).slice(0, 4),
      wl: wlActive().list, primary: wlActive().pri, wlRaw: state.wl, pri: state.pri,
      colorby: $('colorby').value,
      ngrid: +$('ngrid').value, nfield: +$('nfield').value,
      nviz: +$('nviz').value || 3, nfviz: +$('nfviz').value || 3
    };
  }
  function wlActive() {
    var list = [], pri = 0;
    state.wl.forEach(function (r, i) {
      var nm = parseFloat(r.nm), w = parseFloat(r.w);
      if (!(nm > 150 && nm < 3000)) return;
      if (i === state.pri) pri = list.length;
      list.push({ nm: nm, w: (isFinite(w) && w > 0) ? w : 0, c: r.c });
    });
    if (!list.length) { list = [{ nm: 587.6, w: 1, c: '#C08E1A' }]; pri = 0; }
    if (!list.some(function (x) { return x.w > 0; })) list.forEach(function (x) { x.w = 1; });
    return { list: list, pri: Math.min(pri, list.length - 1) };
  }
  function num(v, d, lo, hi) { var x = parseFloat(v); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; }
  function parseList(s, d) {
    var a = String(s).split(/[\s,;]+/).map(parseFloat).filter(function (v) { return isFinite(v); });
    return a.length ? a : d;
  }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  /* 轴上最小 RMS 的离焦量：对若干瞳区的光线解 min Σw(y+uΔ)²，闭式 Δ = −Σwyu / Σwu²。
     只用 7 条光线，够快，可以每次重算都跑一遍。 */
  function axialBestFocus(sys, opt) {
    var lam0 = opt.lambdas[opt.primary].nm / 1000;
    var zn = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.99], su = 0, syu = 0;
    for (var i = 0; i < zn.length; i++) {
      var r = OPT.launch(sys, 0, 0, sys.epd / 2 * zn[i], lam0, false);
      if (!r || !r.ok || Math.abs(r.D[2]) < 1e-12) continue;
      var u = r.D[1] / r.D[2];
      su += zn[i] * u * u; syu += zn[i] * r.y * u;
    }
    return su > 1e-20 ? -syu / su : null;
  }
  function paneW(id, min) {
    var el = $(id).parentNode, w = el ? el.clientWidth : 0;
    return Math.max(min, Math.round(w || min));
  }
  function fmt(x, n) { return (isFinite(x) ? x : 0).toFixed(n === undefined ? 3 : n); }
  function hex2rgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return '#' + [0, 1, 2].map(function (i) { return ('0' + Math.round(A[i] + (B[i] - A[i]) * t).toString(16)).slice(-2); }).join('');
  }
  function fieldRamp(n) {
    var c1 = css('--v1'), c2 = css('--v2'), c3 = css('--v3');
    if (n <= 1) return [c3];
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      out.push(t < 0.5 ? mix(c1, c2, t * 2) : mix(c2, c3, (t - 0.5) * 2));
    }
    return out;
  }

  /* ================= 撤销 / 重做 / 恢复初始 =================
     不给每个按钮各挂一次记录，而是在 compute() 开头把「当前状态」和「上次记下的状态」
     做一次比对：有差异就把旧的压进撤销栈。compute 本身是防抖的，所以连续敲键盘只留一条记录，
     而任何改动路径（按钮、粘贴、下拉、导入）都自动被覆盖，不会漏。 */
  var HCTRL = ['apmode', 'fno', 'fmode', 'fov', 'defoc', 'freqs', 'mtfmode',
               'colorby', 'ngrid', 'nfield', 'nfviz', 'nviz', 'objd'];
  var HIST = { undo: [], redo: [], base: null, last: null };

  function snapshot() {
    var c = {};
    HCTRL.forEach(function (k) { c[k] = $(k).value; });
    c.aim = $('aim').checked ? 1 : 0;
    return JSON.stringify({
      rows: state.rows.map(function (r) { return [r.R, r.T, r.mat, r.sd, r.k, r.asph]; }),
      stop: state.stop, sel: state.sel, pri: state.pri,
      wl: state.wl.map(function (w) { return [w.nm, w.w, w.c]; }),
      cfg: state.cfg, cfgs: state.cfgs, vigH: state.vigH, vigAuto: state.vigAuto,
      ctl: c
    });
  }
  function applySnap(js) {
    var o = JSON.parse(js);
    state.rows = o.rows.map(function (a) {
      return { R: a[0], T: a[1], mat: a[2], sd: a[3], k: a[4], asph: a[5] };
    });
    state.stop = o.stop; state.sel = o.sel; state.pri = o.pri;
    state.wl = o.wl.map(function (a) { return { nm: a[0], w: a[1], c: a[2] }; });
    state.cfgs = o.cfgs || null; state.cfg = o.cfg || 0; state.vigH = o.vigH || null;
    state.vigAuto = o.vigAuto || null;
    HCTRL.forEach(function (k) { $(k).value = o.ctl[k]; });
    $('aim').checked = !!o.ctl.aim;
    syncApMode(); syncFMode(); renderCfg(); renderLDE(); renderWL();
  }
  function histSync() {
    var now = snapshot();
    $('undoBtn').disabled = !HIST.undo.length;
    $('redoBtn').disabled = !HIST.redo.length;
    $('resetBtn').disabled = !HIST.base || HIST.base === now;
  }
  function histRecord() {
    var now = snapshot();
    if (HIST.last === null) { HIST.last = now; histSync(); return; }
    if (HIST.last === now) { histSync(); return; }
    HIST.undo.push(HIST.last);
    if (HIST.undo.length > 80) HIST.undo.shift();
    HIST.redo.length = 0;
    HIST.last = now;
    histSync();
  }
  function histBase() {                       // 载入示例 / 导入 .seq 后调用
    HIST.base = snapshot(); HIST.last = HIST.base;
    HIST.undo.length = 0; HIST.redo.length = 0;
    histSync();
  }
  function histApply(js) { applySnap(js); HIST.last = snapshot(); histSync(); schedule(0); }
  function histUndo() { if (!HIST.undo.length) return; HIST.redo.push(HIST.last); histApply(HIST.undo.pop()); }
  function histRedo() { if (!HIST.redo.length) return; HIST.undo.push(HIST.last); histApply(HIST.redo.pop()); }
  function histReset() {
    if (!HIST.base || HIST.base === HIST.last) return;
    HIST.undo.push(HIST.last); HIST.redo.length = 0; histApply(HIST.base);
  }

  /* ================= 主计算 ================= */
  var last = null;
  function compute() {
    histRecord();
    var st = readState();
    var p = OPT.parsePrescription(st.tx);
    var msgs = LENSMSG.concat(p.warnings).concat(PENDMSG); PENDMSG = [];
    if (p.surfaces.length < 2) {
      showMsgs(msgs.concat(['至少需要 2 个面才能构成系统。']));
      $('surfBadge').textContent = p.surfaces.length + ' 面';
      return;
    }
    var stopIdx = Math.min(st.stop - 1, p.surfaces.length - 1);
    var opt = {
      lambdas: st.wl.map(function (x) { return { nm: x.nm, w: x.w }; }), primary: st.primary, stopIdx: stopIdx,
      apertureMode: st.apmode, fno: st.fno, epd: st.fno, rayAiming: st.aim,
      maxFov: st.fov, defocus: st.defoc, nGrid: st.ngrid, nField: st.nfield,
      freqs: st.freqs, nRayViz: st.nviz, nFieldViz: st.nfviz, colorBy: st.colorby, mtfMode: st.mtfmode,
      objDist: st.objd, sdDraw: state.sdDraw, sdAp: state.sdAp
    };
    var sys = OPT.buildSystem(p.surfaces, opt);
    // .seq 里 SETVIG 存下来的渐晕系数：把视场（像高或角度）换算成本页用的视场角后挂到系统上
    var cfgNow = state.cfgs && state.cfgs[state.cfg];
    var vsrc = (cfgNow && cfgNow.vig) || null;
    if (vsrc && vsrc.vuy && state.vigH && state.vigH.length === vsrc.vuy.length) {
      var lamV = opt.lambdas[opt.primary].nm / 1000;
      var thv = state.vigH.map(function (h) {
        return st.fmode === 'height' ? OPT.angleForHeight(sys, h, lamV) : h;
      });
      sys.vig = { th: thv, vuy: vsrc.vuy, vly: vsrc.vly || vsrc.vuy,
                  vux: vsrc.vux || vsrc.vuy, vlx: vsrc.vlx || vsrc.vux || vsrc.vuy };
    }
    // 「一键渐晕」算出来的表压过文件表。存的是视场占比，不是角度 ——
    // 改了最大视场 / 视场定义方式之后照样对得上。
    var vAuto = state.vigAuto && state.vigAuto[state.cfg];
    if (vAuto && vAuto.f && vAuto.f.length === vAuto.vuy.length) {
      var lamA = opt.lambdas[opt.primary].nm / 1000;
      sys.vig = { th: vAuto.f.map(function (fr) {
                    return st.fmode === 'height' ? OPT.angleForHeight(sys, st.fov * fr, lamA) : st.fov * fr;
                  }),
                  vuy: vAuto.vuy, vly: vAuto.vly, vux: vAuto.vux, vlx: vAuto.vlx, auto: 1 };
      if (vAuto.note) msgs.push(vAuto.note);
      // 渐晕表的归一化瞳坐标分「瞄准」和「不瞄准」两套，不能混用
      if (vAuto.aim !== undefined && !!vAuto.aim !== !!st.aim)
        msgs.push('当前的光线瞄准设置（' + (st.aim ? '开' : '关') + '）和这张渐晕表算出来时（'
          + (vAuto.aim ? '开' : '关') + '）不一致。归一化瞳坐标在两种设置下指的不是同一处，'
          + '混用会让边缘视场的 MTF 明显失真——按一下「一键渐晕」按当前设置重算一遍即可。');
    }
    if (st.fmode === 'height') {                      // 视场按实像高定义（CODE V YRI）
      var lamF = opt.lambdas[opt.primary].nm / 1000, mk = function (n) {
        var out2 = [];
        for (var q = 0; q < n; q++) out2.push(n === 1 ? 0 : OPT.angleForHeight(sys, st.fov * q / (n - 1), lamF));
        return out2;
      };
      opt.fieldsMTF = mk(st.nfield);
      opt.fieldsViz = mk(st.nfviz);
      opt.fieldsFan = mk(NFAN);
      opt.maxFov = opt.fieldsMTF[opt.fieldsMTF.length - 1];
    }
    if (!opt.fieldsFan) {
      opt.fieldsFan = [];
      for (var qf = 0; qf < NFAN; qf++) opt.fieldsFan.push(opt.maxFov * qf / (NFAN - 1));
    }
    if (!isFinite(sys.efl) || Math.abs(sys.efl) > 1e7) msgs.push('系统近轴焦距发散（接近无焦），读数可能无意义。');
    if (st.apmode === 'stop' && !(p.surfaces[stopIdx] && p.surfaces[stopIdx].sd))
      msgs.push('光阑面（第 ' + (stopIdx + 1) + ' 面）没有 Y 半孔径，无法按光阑浮动，已退回 F/# 定义。');
    if (st.aim && !sys.aiming) msgs.push('本次未能启用光线瞄准（求不出光阑半径）。');
    // 像面是不是就落在轴上焦点处？（近轴细光线与光轴的交点 vs 当前像面）
    // 只取决于曲率 / 厚度 / 折射率，与孔径、非球面高次项无关，所以能直接判断
    // 「文件里的后焦距对不对」。写死的镜头和正常的 .zmx 都在 1 波以内，超过就提示。
    (function () {
      var lam0 = opt.lambdas[opt.primary].nm / 1000;
      var dz = axialBestFocus(sys, opt);
      if (dz === null) return;
      var w = Math.abs(dz) / (8 * sys.fno * sys.fno * lam0 / 1000);
      if (w > 2) msgs.push('像面不在轴上最佳焦点上：最佳焦点在像面' + (dz > 0 ? '后' : '前') + ' '
        + Math.abs(dz).toFixed(4) + ' mm（相当于 ' + w.toFixed(1) + ' 波离焦，F/' + sys.fno.toFixed(2)
        + ' @ ' + opt.lambdas[opt.primary].nm + ' nm），MTF 会整体塌下来。'
        + '这是曲率 / 厚度 / 折射率直接决定的，跟孔径和非球面无关——多半是文件里最后一段空气间隔被取整了，'
        + '或者原文件在这一面上挂了个「边缘光线高度 = 0」的解而导出时没带出来。按「最佳对焦」即可补上。');
    })();

    var t0 = performance.now();
    var mtf = OPT.mtfVsField(sys, opt);
    var lay = OPT.layoutGeometry(sys, opt);
    var aber = OPT.aberrations(sys, opt);
    var fan = OPT.rayFan(sys, opt);
    var dt = performance.now() - t0;

    var edge = mtf.rows[mtf.rows.length - 1];
    if (mtf.rows.some(function (r) { return r.thru < 0.999; })) {
      msgs.push(mtf.mode === 'diff'
        ? '半孔径引起渐晕：边缘视场等效通光瞳面积仅剩 ' + (edge.thru * 100).toFixed(0) +
          '%（各视场见数据表「通光率」）。衍射 MTF 按该视场的等效椭圆瞳计算，截止频率随瞳半宽同比下降。'
        : (p.surfaces.some(function (s) { return s.sd; })
          ? 'Y 半孔径引起渐晕：边缘视场通光率 ' + (edge.thru * 100).toFixed(0) + '%（各视场见 MTF 数据表）。MTF 按实际通过的光线计算。'
          : '部分视场有光线丢失（面外或全反射），该处 MTF 已按剩余光线计算。'));
    }

    if (mtf.mode === 'diff') {
      var pvm = 0; mtf.rows.forEach(function (r) { pvm = Math.max(pvm, r.wpv || 0); });
      if (st.ngrid < 32)
        msgs.push('衍射模式建议瞳面网格 ≥ 32²：24² 时轴上 MTF@30 会偏高约 0.03（实测 0.746 vs 收敛值 0.711）。');
      if (pvm > st.ngrid / 3)
        msgs.push('波前 PV 达 ' + pvm.toFixed(0) + ' λ，超出 ' + st.ngrid + '² 瞳网格的相位取样能力，衍射 MTF 可能失真——请调大瞳面网格或改用几何模式。');
    }
    last = { sys: sys, mtf: mtf, lay: lay, aber: aber, fan: fan, opt: opt, st: st, dt: dt, surfaces: p.surfaces };
    showMsgs(msgs);
    $('surfBadge').textContent = p.surfaces.length + ' 面 · ' + p.surfaces.filter(function (s) { return s.isGlass; }).length + ' 片';
    renderStatus();
    renderLayout();
    renderMTF();
    renderAber();
    renderFan();
    renderDataTable();
    $('perfBadge').textContent = (mtf.mode === 'diff' ? '衍射 · ' : '几何 · ') + mtf.rays.toLocaleString('en-US') + ' 条' + (mtf.aiming ? '（瞄准）' : '') + ' · ' + dt.toFixed(0) + ' ms';
    $('stPerf').textContent = '追迹 ' + mtf.rays.toLocaleString('en-US') + ' 条 · ' + dt.toFixed(0) + ' ms · JS 单线程';
    syncVigBtn();
    writeHash(st);
  }

  function showMsgs(list) {
    var seenMsg = {};
    list = (list || []).filter(function (t) { if (!t || seenMsg[t]) return false; seenMsg[t] = 1; return true; });
    var el = $('msgs');
    el.innerHTML = !list.length ? '' :
      '<div class="msg">' + (list.length > 1 ? '<ul><li>' + list.join('</li><li>') + '</li></ul>' : list[0]) + '</div>';
  }

  /* ================= 状态栏 ================= */
  function renderStatus() {
    var s = last.sys, rows = last.mtf.rows, N = s.surfaces.length;
    var oal = s.zVertex[N - 1];                       // 第 1 面顶点 → 末面顶点
    $('stFno').textContent = fmt(s.fno, 4);
    $('stEfl').textContent = fmt(s.efl, 4);
    $('stBfl').textContent = fmt(s.bfl, 4);
    $('stEpd').textContent = fmt(s.epd, 4);
    $('stRed').textContent = fmt(s.mag || 0, 4);      // 无限远物时为 0
    var cw = $('stCfgWrap');
    if (state.cfgs && state.cfgs.length > 1) {
      cw.style.display = '';
      $('stCfg').textContent = 'Z' + (state.cfg + 1) + '/' + state.cfgs.length + ' ' + state.cfgs[state.cfg].title;
    } else { cw.style.display = 'none'; $('stCfg').textContent = '—'; }
    $('stOal').textContent = fmt(oal, 4);
    var lastRow = rows.length ? rows[rows.length - 1] : null;
    $('stImg').textContent = fmt(lastRow ? (lastRow.imgHc || lastRow.imgH) : 0, 4);
    $('stRms').textContent = fmt(rows.length ? rows[0].rms : 0, 2) + ' µm';
  }

  /* ================= Layout ================= */
  function drawLayout(C, ids) {
    var L = C.lay, s = C.sys, svg = $(ids.svg);
    var fieldCols = fieldRamp(L.fields.length);
    var inkC = css('--ink'), ink2 = css('--ink-2'), ink3 = css('--ink-3');
    var glass = css('--glass'), glass2 = css('--glass-2'), gstroke = css('--glass-stroke');

    var minZ = 1e9, maxZ = -1e9, maxY = 0;
    L.elements.forEach(function (e) {
      e.front.concat(e.back).forEach(function (p) {
        minZ = Math.min(minZ, p[0]); maxZ = Math.max(maxZ, p[0]); maxY = Math.max(maxY, Math.abs(p[1]));
      });
    });
    L.bundles.forEach(function (b) {
      b.rays.forEach(function (r) {
        r.forEach(function (p) { minZ = Math.min(minZ, p[0]); maxZ = Math.max(maxZ, p[0]); maxY = Math.max(maxY, Math.abs(p[1])); });
      });
    });
    if (!isFinite(minZ) || minZ > maxZ) { svg.innerHTML = ''; return; }
    maxZ = Math.max(maxZ, s.zImg); minZ = Math.min(minZ, L.zEnter);
    maxY = Math.max(maxY, s.epd / 2) * 1.13;
    var padZ = (maxZ - minZ) * 0.035 + 1;

    var W = maxZ - minZ + 2 * padZ, H = 2 * maxY;
    var avail = paneW(ids.svg, 480);
    var scale = Math.min(avail / W, 560 / H);
    var PX = avail, PY = Math.max(110, H * scale);
    var xoff = (PX - W * scale) / 2;
    var X = function (z) { return xoff + (z - minZ + padZ) * scale; };
    var Y = function (y) { return PY / 2 - y * scale; };
    var g = [];

    g.push('<line x1="' + xoff.toFixed(1) + '" y1="' + Y(0) + '" x2="' + (PX - xoff).toFixed(1) + '" y2="' + Y(0) +
      '" stroke="' + ink3 + '" stroke-width="1" stroke-dasharray="7 4" opacity=".5"/>');

    L.elements.forEach(function (e) {
      var d = 'M' + e.front.map(function (p) { return X(p[0]).toFixed(2) + ' ' + Y(p[1]).toFixed(2); }).join(' L') +
        ' L' + e.back.slice().reverse().map(function (p) { return X(p[0]).toFixed(2) + ' ' + Y(p[1]).toFixed(2); }).join(' L') + ' Z';
      g.push('<path d="' + d + '" fill="' + (e.cemented ? glass2 : glass) + '" fill-opacity=".9" stroke="' +
        gstroke + '" stroke-width="1.15" stroke-linejoin="round"/>');
    });

    var byW = L.byWvl, wlCols = C.wlCols || [];
    L.bundles.forEach(function (b) {
      var c = byW ? (wlCols[b.wi] || fieldCols[0]) : (fieldCols[b.fi] || fieldCols[fieldCols.length - 1]);
      var da = byW ? DASH[b.wi % DASH.length] : '';
      b.rays.forEach(function (r) {
        g.push('<path d="' + r.map(function (p, j) { return (j ? 'L' : 'M') + X(p[0]).toFixed(2) + ' ' + Y(p[1]).toFixed(2); }).join(' ') +
          '" fill="none" stroke="' + c + '" stroke-width="1.05" opacity=".92"' + (da ? ' stroke-dasharray="' + da + '"' : '') + '/>');
      });
    });

    var si = C.opt.stopIdx, zs = s.zVertex[si];
    if (zs !== undefined) {
      // 光阑刻线的半径要和镜片外形用同一个数（layoutGeometry 的 drawSd）。
      // 原来用 sys.sdStop —— 那是孔径定义解出来的「近轴光瞳半径」，
      // 实际边缘光线因为光瞳球差会落得更高（85 GM II 的 1.6m 结构：光线到 17.09，sdStop 只有 16.59），
      // 于是光线从刻线中间穿过去，看着像和光阑打架。
      var hs = (L.drawSd && L.drawSd[si]) || s.surfaces[si].sd || L.sdStop || Math.max(L.maxR[si] * 1.06, s.epd / 2);
      g.push('<line x1="' + X(zs) + '" y1="' + Y(hs) + '" x2="' + X(zs) + '" y2="' + Y(hs * 1.4 + 0.5) + '" stroke="' + inkC + '" stroke-width="2"/>');
      g.push('<line x1="' + X(zs) + '" y1="' + Y(-hs) + '" x2="' + X(zs) + '" y2="' + Y(-hs * 1.4 - 0.5) + '" stroke="' + inkC + '" stroke-width="2"/>');
      g.push('<text x="' + X(zs) + '" y="' + (Y(hs * 1.4 + 0.5) - 5) + '" fill="' + ink2 +
        '" font-size="10.5" text-anchor="middle" font-family="IBM Plex Mono, monospace">光阑</text>');
    }

    // 像面线高度 = 最大视场的实像高，和光线落点齐平
    var maxH = 0;
    if (C.mtf.rows.length) C.mtf.rows.forEach(function (r) { maxH = Math.max(maxH, r.imgH || 0); });
    L.bundles.forEach(function (b) {
      b.rays.forEach(function (r) {
        var p = r[r.length - 1];
        if (p && Math.abs(p[0] - s.zImg) < 1e-6) maxH = Math.max(maxH, Math.abs(p[1]));
      });
    });
    var ih = maxH > 1e-6 ? maxH : maxY * 0.2;
    g.push('<line x1="' + X(s.zImg) + '" y1="' + Y(ih) + '" x2="' + X(s.zImg) + '" y2="' + Y(-ih) + '" stroke="' + inkC + '" stroke-width="2"/>');
    g.push('<text x="' + (X(s.zImg) - 5) + '" y="' + (Y(ih) - 5) + '" fill="' + ink2 +
      '" font-size="10.5" text-anchor="end" font-family="IBM Plex Mono, monospace">像面</text>');

    svg.setAttribute('viewBox', '0 0 ' + PX.toFixed(0) + ' ' + PY.toFixed(0));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.innerHTML = g.join('');

    var drawn = L.bundles.reduce(function (a2, b) { return a2 + b.rays.length; }, 0);
    $(ids.badge).textContent = L.elements.length + ' 片 · ' + drawn + ' 条';
    if (byW) {
      var seen = {}, items = [];
      L.bundles.forEach(function (b) {
        if (seen[b.wi]) return; seen[b.wi] = 1;
        items.push('<span class="lg"><span class="sw" style="background:' + (wlCols[b.wi] || fieldCols[0]) +
          (DASH[b.wi % DASH.length] ? ';border-top:2.5px dashed ' + (wlCols[b.wi] || fieldCols[0]) + ';background:none;height:0' : '') +
          '"></span>' + b.nm + ' nm</span>');
      });
      $(ids.legend).innerHTML = items.join('') +
        '<span class="lg conv">视场 ' + L.fields.map(function (f) { return f.toFixed(1) + '°'; }).join(' / ') +
        ' · 颜色与线型同时区分波长 · 1 : 1</span>';
    } else {
      $(ids.legend).innerHTML = L.bundles.map(function (b) {
        var sp = b.span ? '<span style="color:' + ink3 + '"> [' + b.span.lo.toFixed(2) + ', ' + b.span.hi.toFixed(2) + ']</span>'
          : '<span style="color:' + ink3 + '"> 全渐晕</span>';
        return '<span class="lg"><span class="sw" style="background:' + (fieldCols[b.fi] || fieldCols[0]) + '"></span>' +
          b.field.toFixed(1) + '°' + sp + '</span>';
      }).join('') + '<span class="lg conv">方括号 = 该视场未渐晕的子午瞳区间'
        + (C.sys.vig ? (C.sys.vig.auto ? '（按通光重算）' : '（来自文件的渐晕系数）') : '（按通光实时追迹）')
        + ' · 主波长 ' + C.opt.lambdas[C.opt.primary].nm + ' nm · 1 : 1</span>';
    }
  }

  function renderLayout() {
    drawLayout({ lay: last.lay, sys: last.sys, mtf: last.mtf, opt: last.opt,
                 wlCols: last.st.wl.map(function (x) { return x.c; }) },
               { svg: 'layout', badge: 'layoutBadge', legend: 'layoutLegend' });
  }
  /* ================= MTF ================= */
  var PLOT = { w: 780, h: 330, l: 50, r: 82, t: 14, b: 44 };
  function renderMTF() {
    PLOT.w = paneW('mtf', 560);
    PLOT.h = Math.round(Math.max(340, Math.min(560, PLOT.w * 0.47)));   // 比例向 CODE V 靠
    var rows = last.mtf.rows, freqs = last.opt.freqs, svg = $('mtf');
    var cols = [css('--f1'), css('--f2'), css('--f3'), css('--f4')];
    var ink = css('--ink'), ink2 = css('--ink-2'), ink3 = css('--ink-3'), lineC = css('--line-2');
    var iw = PLOT.w - PLOT.l - PLOT.r, ih = PLOT.h - PLOT.t - PLOT.b;
    var useH = last.st.fmode === 'height';
    var xOf = function (r) { return useH ? (r.imgHc || r.imgH) : r.field; };
    var fovMax = Math.max(useH ? rows[rows.length - 1].imgH : last.st.fov, 1e-6);
    var X = function (f) { return PLOT.l + iw * f / fovMax; };
    var Y = function (m) { return PLOT.t + ih * (1 - Math.max(0, Math.min(1, m))); };
    var g = [];

    for (var i = 0; i <= 10; i++) {
      var v = i / 10, y = Y(v);
      g.push('<line x1="' + PLOT.l + '" y1="' + y.toFixed(1) + '" x2="' + (PLOT.l + iw) + '" y2="' + y.toFixed(1) +
        '" stroke="' + lineC + '" stroke-width="1"/>');
      g.push('<text x="' + (PLOT.l - 8) + '" y="' + (y + 4).toFixed(1) + '" fill="' + ink3 +
        '" font-size="10.5" text-anchor="end" font-family="IBM Plex Mono, monospace">' + (i === 0 ? '0' : i === 10 ? '1' : v.toFixed(1)) + '</text>');
    }
    var step = niceStep(fovMax / Math.max(8, Math.min(24, Math.round(iw / 58))));
    for (var f = 0; f <= fovMax + step * 1e-6; f += step) {
      var x = X(Math.min(f, fovMax));
      g.push('<line x1="' + x.toFixed(1) + '" y1="' + PLOT.t + '" x2="' + x.toFixed(1) + '" y2="' + (PLOT.t + ih) +
        '" stroke="' + lineC + '" stroke-width="1"/>');
      g.push('<line x1="' + x.toFixed(1) + '" y1="' + (PLOT.t + ih) + '" x2="' + x.toFixed(1) + '" y2="' + (PLOT.t + ih + 5) + '" stroke="' + ink3 + '" stroke-width="1"/>');
      g.push('<text x="' + x.toFixed(1) + '" y="' + (PLOT.t + ih + 17) + '" fill="' + ink3 +
        '" font-size="10.5" text-anchor="middle" font-family="IBM Plex Mono, monospace">' + (+f.toFixed(2)) + '</text>');
    }
    g.push('<text x="' + (PLOT.l + iw / 2) + '" y="' + (PLOT.h - 7) + '" fill="' + ink2 + '" font-size="11" text-anchor="middle">' +
      (useH ? 'Y 实像高 (mm)' : '半视场角 (°)') + '</text>');
    g.push('<text transform="translate(16,' + (PLOT.t + ih / 2) + ') rotate(-90)" fill="' + ink2 + '" font-size="11" text-anchor="middle">MTF</text>');
    g.push('<rect x="' + PLOT.l + '" y="' + PLOT.t + '" width="' + iw + '" height="' + ih + '" fill="none" stroke="' + css('--line') + '" stroke-width="1"/>');

    var lam0 = last.opt.lambdas[last.opt.primary].nm / 1000;
    freqs.forEach(function (nu) {
      var dl = OPT.diffractionMTF(nu, lam0, last.sys.fno);
      if (dl <= 0.002) return;
      g.push('<line x1="' + PLOT.l + '" y1="' + Y(dl).toFixed(1) + '" x2="' + (PLOT.l + iw) + '" y2="' + Y(dl).toFixed(1) +
        '" stroke="' + ink3 + '" stroke-width="1.2" stroke-dasharray="2 4" opacity=".7"/>');
    });

    var labels = [];
    freqs.forEach(function (nu, k) {
      var c = cols[k % 4];
      ['T', 'S'].forEach(function (kind) {
        var pts = rows.map(function (r) { return [X(xOf(r)), Y(r[kind][k])]; });
        g.push('<path d="' + pchip(pts) + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' +
          (kind === 'S' ? ' stroke-dasharray="5 3.5"' : '') + '/>');
      });
      labels.push({ y: Y(rows[rows.length - 1].T[k]), text: nu + '', c: c });
    });
    labels.sort(function (a, b) { return a.y - b.y; });
    for (var q = 1; q < labels.length; q++) if (labels[q].y - labels[q - 1].y < 14) labels[q].y = labels[q - 1].y + 14;
    labels.forEach(function (L2) {
      g.push('<text x="' + (PLOT.l + iw + 8) + '" y="' + (L2.y + 4).toFixed(1) + '" fill="' + L2.c +
        '" font-size="11.5" font-weight="600" font-family="IBM Plex Mono, monospace">' + L2.text + '</text>');
    });

    g.push('<g id="xh" style="display:none"><line x1="0" y1="' + PLOT.t + '" x2="0" y2="' + (PLOT.t + ih) +
      '" stroke="' + ink + '" stroke-width="1" opacity=".45"/></g>');
    g.push('<rect id="hitzone" x="' + PLOT.l + '" y="' + PLOT.t + '" width="' + iw + '" height="' + ih + '" fill="transparent" style="cursor:crosshair"/>');

    svg.setAttribute('viewBox', '0 0 ' + PLOT.w + ' ' + PLOT.h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = g.join('');
    attachHover(svg, iw);

    var dlTxt = freqs.map(function (nu) { return nu + ':' + OPT.diffractionMTF(nu, lam0, last.sys.fno).toFixed(2); }).join('  ');
    var lam0nm = last.opt.lambdas[last.opt.primary].nm;
    $('mtfLegend').innerHTML =
      freqs.map(function (nu, k) { return '<span class="lg"><span class="sw" style="background:' + cols[k % 4] + '"></span>' + nu + ' cyc/mm</span>'; }).join('') +
      '<span class="lg conv">实线 = 子午 T　虚线 = 弧矢 S</span>' +
      '<span class="lg conv" style="color:' + ink3 + '">点划线 = 衍射极限 @' + lam0nm + ' nm (' + dlTxt + ')</span>';
  }

  /* 单调三次 Hermite（PCHIP）：过每个算出来的点，且不会在点之间拱出多余的波峰。
     MTF-视场曲线用折线画时，视场点之间会出现明显的折角；样条只改画法，不改数值。 */
  function pchip(p) {
    var n = p.length, i;
    if (!n) return '';
    if (n === 1) return 'M' + p[0][0].toFixed(2) + ' ' + p[0][1].toFixed(2);
    var h = [], d = [];
    for (i = 0; i < n - 1; i++) {
      h[i] = p[i + 1][0] - p[i][0];
      if (!(h[i] > 1e-9)) h[i] = 1e-9;
      d[i] = (p[i + 1][1] - p[i][1]) / h[i];
    }
    if (n === 2) return 'M' + p[0][0].toFixed(2) + ' ' + p[0][1].toFixed(2) +
      ' L' + p[1][0].toFixed(2) + ' ' + p[1][1].toFixed(2);
    var m = new Array(n);
    var endSlope = function (h0, h1, d0, d1) {
      var v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (v * d0 <= 0) return 0;
      if (d0 * d1 < 0 && Math.abs(v) > Math.abs(3 * d0)) return 3 * d0;
      return v;
    };
    m[0] = endSlope(h[0], h[1], d[0], d[1]);
    m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    for (i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
      var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    var s2 = 'M' + p[0][0].toFixed(2) + ' ' + p[0][1].toFixed(2);
    for (i = 0; i < n - 1; i++) {
      var t = h[i] / 3;
      s2 += ' C' + (p[i][0] + t).toFixed(2) + ' ' + (p[i][1] + m[i] * t).toFixed(2) +
            ' ' + (p[i + 1][0] - t).toFixed(2) + ' ' + (p[i + 1][1] - m[i + 1] * t).toFixed(2) +
            ' ' + p[i + 1][0].toFixed(2) + ' ' + p[i + 1][1].toFixed(2);
    }
    return s2;
  }

  /* ================= 球差 / 场曲·像散 / 畸变 =================
     三格并排，照光学设计里通行的画法：纵轴是归一化瞳高或像高，横轴是焦点偏移 / 畸变百分比 */
  function renderAber() {
    if (!last || !last.aber) return;
    var A = last.aber, svg = $('aber');
    var W = paneW('aber', 560);
    var H = Math.round(Math.max(300, Math.min(430, W * 0.42)));
    var ink2 = css('--ink-2'), ink3 = css('--ink-3'), lineC = css('--line-2'), lineD = css('--line');
    var cols = last.st.wl.map(function (x) { return x.c; });
    var GL = 8, GR = 8, GT = 36, GB = 48, gap = 20;                   // 每格的边距
    var pw = (W - 2 * 8 - 2 * gap - 3 * (GL + GR)) / 3;
    var ph = H - GT - GB;
    var g = [];

    var maxAbs = function (arr) { var m = 0; arr.forEach(function (v) { m = Math.max(m, Math.abs(v)); }); return m; };
    var span = function (m, min) {
      m = Math.max(m * 1.12, min);
      var p = Math.pow(10, Math.floor(Math.log10(m)));
      return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(function (k) { return k * p; })
        .filter(function (v) { return v >= m; })[0] || 10 * p;
    };
    var lsaVals = [], tsfVals = [], dstVals = [];
    A.lsa.forEach(function (c) { c.pts.forEach(function (q) { lsaVals.push(q[0]); }); });
    A.tsf.forEach(function (c) { c.T.concat(c.S).forEach(function (q) { tsfVals.push(q[0]); }); });
    A.dist.forEach(function (c) { c.pts.forEach(function (q) { dstVals.push(q[0]); }); });
    var xL = span(maxAbs(lsaVals), 0.005), xT = span(maxAbs(tsfVals), 0.01), xD = span(maxAbs(dstVals), 0.5);
    var hMax = Math.max(A.hMax, 1e-6);

    /* 一格的框架：左上角 x0，横轴 ±xr，纵轴 0..ymax */
    function frame(x0, title, xr, ymax, xlab, ylab, yTicks, unit) {
      var X = function (v) { return x0 + pw * (v + xr) / (2 * xr); };
      var Y = function (v) { return GT + ph * (1 - v / ymax); };
      g.push('<text x="' + (x0 + pw / 2).toFixed(1) + '" y="' + (GT - 20) + '" fill="' + ink2 +
        '" font-size="11.5" text-anchor="middle" font-weight="600">' + title + '</text>');
      g.push('<rect x="' + x0 + '" y="' + GT + '" width="' + pw.toFixed(1) + '" height="' + ph +
        '" fill="none" stroke="' + lineD + '" stroke-width="1"/>');
      // 纵轴（零位）
      g.push('<line x1="' + X(0).toFixed(1) + '" y1="' + GT + '" x2="' + X(0).toFixed(1) + '" y2="' + (GT + ph) +
        '" stroke="' + ink3 + '" stroke-width="1"/>');
      yTicks.forEach(function (v) {
        var y = Y(v);
        g.push('<line x1="' + (X(0) - 4).toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + (X(0) + 4).toFixed(1) +
          '" y2="' + y.toFixed(1) + '" stroke="' + ink3 + '" stroke-width="1"/>');
        g.push('<text x="' + (X(0) + 7).toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '" fill="' + ink3 +
          '" font-size="9.5" font-family="IBM Plex Mono, monospace" stroke="' + css('--panel') +
          '" stroke-width="2.6" paint-order="stroke">' + v.toFixed(unit) + '</text>');
      });
      (pw > 190 ? [-xr, -xr / 2, 0, xr / 2, xr] : [-xr, 0, xr]).forEach(function (v) {
        var x = X(v);
        g.push('<line x1="' + x.toFixed(1) + '" y1="' + (GT + ph) + '" x2="' + x.toFixed(1) + '" y2="' + (GT + ph + 4) +
          '" stroke="' + ink3 + '" stroke-width="1"/>');
        g.push('<text x="' + x.toFixed(1) + '" y="' + (GT + ph + 15) + '" fill="' + ink3 +
          '" font-size="9.5" text-anchor="middle" font-family="IBM Plex Mono, monospace">' + (+v.toPrecision(3)) + '</text>');
      });
      g.push('<text x="' + (x0 + pw / 2).toFixed(1) + '" y="' + (GT + ph + 31) + '" fill="' + ink3 +
        '" font-size="10" text-anchor="middle">' + xlab + '</text>');
      if (ylab && pw > 140) g.push('<text x="' + (x0 + pw - 2).toFixed(1) + '" y="' + (GT - 6) + '" fill="' + ink3 +
        '" font-size="9.5" text-anchor="end" font-family="IBM Plex Mono, monospace">' + ylab + '</text>');
      return { X: X, Y: Y };
    }
    function line(pts, F, color, dash) {
      if (!pts || pts.length < 2) return;
      var d = pts.map(function (q, i) { return (i ? 'L' : 'M') + F.X(q[0]).toFixed(2) + ' ' + F.Y(q[1]).toFixed(2); }).join(' ');
      g.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"' +
        (dash ? ' stroke-dasharray="4 2.8"' : '') + '/>');
    }

    var x1 = 8 + GL, x2 = x1 + pw + GR + gap + GL, x3 = x2 + pw + GR + gap + GL;
    var F1 = frame(x1, '纵向球差', xL, 1, '焦点偏移 (mm)', '归一化瞳高', [0.25, 0.5, 0.75, 1], 2);
    A.lsa.forEach(function (c, i) { line(c.pts, F1, cols[i] || ink2, false); });

    var hT = [0.25, 0.5, 0.75, 1].map(function (f) { return +(hMax * f).toFixed(4); });
    var F2 = frame(x2, '像散场曲', xT, hMax, '焦点偏移 (mm)', 'Y 实像高 mm', hT, 2);
    A.tsf.forEach(function (c, i) {
      line(c.S, F2, cols[i] || ink2, true);
      line(c.T, F2, cols[i] || ink2, false);
    });

    var F3 = frame(x3, '畸变', xD, hMax, '% 畸变', 'Y 实像高 mm', hT, 2);
    A.dist.forEach(function (c, i) { line(c.pts, F3, cols[i] || ink2, false); });

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = g.join('');

    var pri = last.opt.primary, dl = A.dist[pri] ? A.dist[pri].pts : [];
    var dmax = 0, dh = 0;
    dl.forEach(function (q) { if (Math.abs(q[0]) > Math.abs(dmax)) { dmax = q[0]; dh = q[1]; } });
    $('aberBadge').textContent = '最大畸变 ' + dmax.toFixed(2) + '% @' + dh.toFixed(1) + ' mm';
    $('aberLegend').innerHTML =
      last.st.wl.map(function (x, i) {
        return '<span class="lg"><span class="sw" style="background:' + (cols[i] || ink2) + '"></span>' + x.nm + ' nm</span>';
      }).join('') +
      '<span class="lg conv">实线 = 子午 T　虚线 = 弧矢 S（与上面 MTF 图同一约定）</span>' +
      '<span class="lg conv" style="color:' + ink3 + '">球差 = 轴上光线与光轴交点到像面的距离，底端不归零即轴向色差；畸变基准是近轴主光线在像面上的高度</span>';
  }

  /* ================= 光线扇形 =================
     布局照 CODE V 的 RIM：每个视场一行，左格子午、右格弧矢，最上面是最大视场。
     全部格子共用一个对称刻度（官方宏 cvquickrim.seq 就是先扫最大像差再 SSI 统一设定）。 */
  function renderFan() {
    if (!last || !last.fan) return;
    var F = last.fan, svg = $('fan'), rows = F.rows;
    if (!rows.length) { svg.innerHTML = ''; return; }
    var W = paneW('fan', 700);
    var ink2 = css('--ink-2'), ink3 = css('--ink-3'), lineD = css('--line'), panel = css('--panel');
    var cols = last.st.wl.map(function (x) { return x.c; });
    var useH = last.st.fmode === 'height';

    var LAB = 96, GAPX = 22, GT = 30, GB = 32, rowGap = 8;
    // 每格控制在 3.5:1 上下，太宽会把像差压成一条直线，认不出形状
    var pw = Math.max(140, Math.min(400, (W - 2 * 12 - LAB - GAPX) / 2));
    var rowH = Math.max(62, Math.min(120, Math.round(pw * 0.30)));
    var ph = rowH;
    var H = GT + rows.length * (rowH + rowGap) + GB;
    var blockW = 2 * pw + LAB + GAPX, ox = Math.max(10, (W - blockW) / 2);
    // 刻度：默认自动取整（同官方宏 cvquickrim.seq 的 SSI 做法——扫最大像差再统一设定），
    // 也可以手动锁定，否则某个视场瞳缘的一小段大像差会把其余格子全压平
    var manual = parseFloat($('fanscale').value) || 0;
    var vs = manual > 0 ? manual : (function (m) {
      m = Math.max(m * 1.05, 1e-4);
      var p = Math.pow(10, Math.floor(Math.log10(m)));
      return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(function (k) { return k * p; })
        .filter(function (v) { return v >= m; })[0] || 10 * p;
    })(F.vmax);

    var g = [], x0T = ox, x0S = ox + pw + LAB + GAPX;
    g.push('<text x="' + (x0T + pw / 2).toFixed(1) + '" y="14" fill="' + ink2 +
      '" font-size="11.5" text-anchor="middle" font-weight="600">子午 TANGENTIAL</text>');
    g.push('<text x="' + (x0S + pw / 2).toFixed(1) + '" y="14" fill="' + ink2 +
      '" font-size="11.5" text-anchor="middle" font-weight="600">弧矢 SAGITTAL</text>');

    rows.slice().reverse().forEach(function (r, ri) {
      var yTop = GT + ri * (rowH + rowGap), yMid = yTop + ph / 2;
      var rel = F.hMax > 1e-9 ? r.imgH / F.hMax : 0;
      // 中间那列文字：相对视场 + 实像高 / 视场角
      var cx = x0T + pw + LAB / 2 + GAPX / 2;
      g.push('<text x="' + cx.toFixed(1) + '" y="' + (yMid - 5).toFixed(1) + '" fill="' + ink2 +
        '" font-size="10.5" text-anchor="middle" font-weight="600" font-family="IBM Plex Mono, monospace">' +
        rel.toFixed(2) + ' 视场</text>');
      g.push('<text x="' + cx.toFixed(1) + '" y="' + (yMid + 8).toFixed(1) + '" fill="' + ink3 +
        '" font-size="9.5" text-anchor="middle" font-family="IBM Plex Mono, monospace">' +
        (useH ? r.imgH.toFixed(2) + ' mm' : r.field.toFixed(2) + '°') + '</text>');
      g.push('<text x="' + cx.toFixed(1) + '" y="' + (yMid + 20).toFixed(1) + '" fill="' + ink3 +
        '" font-size="9" text-anchor="middle" font-family="IBM Plex Mono, monospace">' +
        (useH ? r.field.toFixed(2) + '°' : r.imgH.toFixed(2) + ' mm') + '</text>');

      [[x0T, r.T, r.spanY], [x0S, r.S, r.spanX]].forEach(function (pane) {
        var x0 = pane[0], sets = pane[1];
        var X = function (u) { return x0 + pw * (u + 1) / 2; };
        var Y = function (v) { return yMid - ph / 2 * Math.max(-1, Math.min(1, v / vs)); };
        g.push('<line x1="' + x0 + '" y1="' + yMid.toFixed(1) + '" x2="' + (x0 + pw).toFixed(1) +
          '" y2="' + yMid.toFixed(1) + '" stroke="' + ink3 + '" stroke-width="1"/>');
        g.push('<line x1="' + X(0).toFixed(1) + '" y1="' + yTop + '" x2="' + X(0).toFixed(1) +
          '" y2="' + (yTop + ph) + '" stroke="' + lineD + '" stroke-width="1"/>');
        [-1, 1].forEach(function (u) {                       // 瞳边缘刻度
          g.push('<line x1="' + X(u).toFixed(1) + '" y1="' + (yMid - 3) + '" x2="' + X(u).toFixed(1) +
            '" y2="' + (yMid + 3) + '" stroke="' + ink3 + '" stroke-width="1" opacity=".7"/>');
        });
        sets.forEach(function (c, wi) {
          if (!c.pts || c.pts.length < 2) return;
          // 超出刻度的点断开而不是压在边框上，免得画出一条假的水平线
          var d = '', open = false, n = 0;
          c.pts.forEach(function (q) {
            if (Math.abs(q[1]) > vs) { open = false; return; }
            d += (open ? 'L' : 'M') + X(q[0]).toFixed(2) + ' ' + Y(q[1]).toFixed(2) + ' ';
            open = true; n++;
          });
          if (n > 1) g.push('<path d="' + d.trim() + '" fill="none" stroke="' + (cols[wi] || ink2) +
            '" stroke-width="1.35" stroke-linejoin="round"/>');
        });
      });
    });
    // 纵向刻度值只在最上面一行的零位轴旁标一次（照 CODE V 的 RIM 图）
    var vtxt = '' + (+vs.toPrecision(6));
    [x0T, x0S].forEach(function (x0) {
      var xa = x0 + pw / 2;
      g.push('<text x="' + (xa - 4).toFixed(1) + '" y="' + (GT + 8) + '" fill="' + ink3 +
        '" font-size="9" text-anchor="end" font-family="IBM Plex Mono, monospace" stroke="' + panel +
        '" stroke-width="2.6" paint-order="stroke">' + vtxt + '</text>');
      g.push('<text x="' + (xa - 4).toFixed(1) + '" y="' + (GT + rowH - 1) + '" fill="' + ink3 +
        '" font-size="9" text-anchor="end" font-family="IBM Plex Mono, monospace" stroke="' + panel +
        '" stroke-width="2.6" paint-order="stroke">-' + vtxt + '</text>');
    });
    var yb = GT + rows.length * (rowH + rowGap) + 14;
    [x0T, x0S].forEach(function (x0) {
      g.push('<text x="' + x0 + '" y="' + yb + '" fill="' + ink3 + '" font-size="9.5" font-family="IBM Plex Mono, monospace">-1</text>');
      g.push('<text x="' + (x0 + pw / 2).toFixed(1) + '" y="' + yb + '" fill="' + ink3 +
        '" font-size="9.5" text-anchor="middle">归一化瞳坐标</text>');
      g.push('<text x="' + (x0 + pw).toFixed(1) + '" y="' + yb + '" fill="' + ink3 +
        '" font-size="9.5" text-anchor="end" font-family="IBM Plex Mono, monospace">+1</text>');
    });

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = g.join('');
    $('fanBadge').textContent = rows.length + ' 视场 · 最大像差 ±' + (+F.vmax.toPrecision(3)) + ' mm';
    $('fanLegend').innerHTML =
      last.st.wl.map(function (x, i) {
        return '<span class="lg"><span class="sw" style="background:' + (cols[i] || ink2) + '"></span>' + x.nm + ' nm</span>';
      }).join('') +
      '<span class="lg conv">纵轴 = 横向像差（mm），零点取该视场<b>主光线</b>在主波长下的落点，各波长上下错开即倍率色差</span>' +
      '<span class="lg conv" style="color:' + ink3 + '">横轴是整个入瞳的归一化坐标，曲线只画在该视场未渐晕的那一段——边缘视场短一截就是渐晕</span>';
  }

  function niceStep(x) {
    var p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9))));
    return [1, 2, 2.5, 5, 10].map(function (m) { return m * p; })
      .reduce(function (a, b) { return Math.abs(b - x) < Math.abs(a - x) ? b : a; });
  }

  function attachHover(svg, iw) {
    var zone = svg.querySelector('#hitzone'), xh = svg.querySelector('#xh');
    var line = xh.querySelector('line'), bar = $('hover');
    function move(ev) {
      var rect = svg.getBoundingClientRect();
      var xu = (ev.clientX - rect.left) / rect.width * PLOT.w;
      var frac = Math.max(0, Math.min(1, (xu - PLOT.l) / iw));
      var rows = last.mtf.rows, r = rows[Math.round(frac * (rows.length - 1))];
      var uH = last.st.fmode === 'height';
      var xm = Math.max(uH ? rows[rows.length - 1].imgH : last.st.fov, 1e-6);
      var px = PLOT.l + iw * (uH ? r.imgH : r.field) / xm;
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      xh.style.display = '';
      bar.innerHTML = '<b>' + r.field.toFixed(2) + '°</b> · 像高 <b>' + r.imgH.toFixed(3) + '</b> mm · RMS <b>' +
        r.rms.toFixed(2) + '</b> µm · 通光 <b>' + (r.thru * 100).toFixed(0) + '%</b>　' +
        last.opt.freqs.map(function (nu, k) {
          return nu + ': T <b>' + r.T[k].toFixed(3) + '</b> / S <b>' + r.S[k].toFixed(3) + '</b>';
        }).join('　');
    }
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerdown', move);
    zone.addEventListener('pointerleave', function () {
      xh.style.display = 'none';
      bar.textContent = '把指针移到图上可读取任意视场的 T / S 数值。';
    });
  }

  function renderDataTable() {
    var rows = last.mtf.rows, freqs = last.opt.freqs;
    $('mtfTable').innerHTML =
      '<thead><tr><th>视场 °</th><th>像高 mm</th><th>RMS µm</th>' +
      (last.mtf.mode === 'diff' ? '<th>波前 PV λ</th>' : '') +
      freqs.map(function (n) { return '<th>T@' + n + '</th><th>S@' + n + '</th>'; }).join('') + '<th>通光率</th></tr></thead>' +
      '<tbody>' + rows.map(function (r) {
        return '<tr><td>' + r.field.toFixed(2) + '</td><td>' + r.imgH.toFixed(3) + '</td><td>' + r.rms.toFixed(2) + '</td>' +
          (last.mtf.mode === 'diff' ? '<td>' + (r.wpv || 0).toFixed(2) + '</td>' : '') +
          freqs.map(function (n, k) { return '<td>' + r.T[k].toFixed(3) + '</td><td>' + r.S[k].toFixed(3) + '</td>'; }).join('') +
          '<td>' + (r.thru * 100).toFixed(0) + '%</td></tr>';
      }).join('') + '</tbody>';
  }

  /* ================= 链接 ================= */
  function b64e(s) { return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(s))).replace(/=+$/, ''); }
  function b64d(b) { return new TextDecoder().decode(Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); })); }
  function writeHash(st) { try { history.replaceState(null, '', '#' + b64e(JSON.stringify(st))); } catch (e) { } }
  function readHash() {
    if (!location.hash || location.hash.length < 4) return null;
    try { return JSON.parse(b64d(location.hash.slice(1))); } catch (e) { return null; }
  }

  /* ================= 事件 ================= */
  var timer = null;
  function schedule(d) {
    clearTimeout(timer);
    $('perfBadge').textContent = '计算中…';
    timer = setTimeout(function () { requestAnimationFrame(compute); }, d === undefined ? 220 : d);
  }

  var tb = $('ldeBody');
  tb.addEventListener('input', function (e) {
    var t = e.target;
    if (t.tagName !== 'INPUT') return;
    var r = state.rows[+t.dataset.r]; if (!r) return;
    var fld = t.dataset.f;
    if (fld.charAt(0) === 'a' && /^a\d+$/.test(fld)) setAsphTerm(r, +fld.slice(1), t.value);
    else { r[fld] = t.value; cfgWriteBack(+t.dataset.r, fld, t.value); }
    var tc = tb.querySelector('[data-typ="' + t.dataset.r + '"]');
    if (tc) tc.textContent = isAsph(r) ? '非球面' : '球面';
    schedule(240);
  });
  tb.addEventListener('focusin', function (e) {
    var tr = e.target.closest ? e.target.closest('tr[data-r]') : null;
    if (!tr) return;
    state.sel = +tr.dataset.r;
    Array.prototype.forEach.call(tb.querySelectorAll('tr.sel'), function (x) { x.classList.remove('sel'); });
    tr.classList.add('sel');
  });
  tb.addEventListener('click', function (e) {
    var td = e.target.closest ? e.target.closest('td.num') : null;
    if (!td || td.dataset.r === undefined) return;
    state.stop = +td.dataset.r; state.sel = state.stop;
    renderLDE(); schedule(0);
  });
  tb.addEventListener('paste', function (e) {
    var inp = e.target;
    if (!inp || inp.tagName !== 'INPUT') return;
    var txt = ((e.clipboardData || window.clipboardData).getData('text') || '');
    if (!/[\t\n]/.test(txt.trim())) return;                       // 单格：走默认行为
    e.preventDefault();
    var FL = FIELDS.slice(0, 5);                                   // R T mat sd k
    for (var ai = 0; ai < 12; ai++) FL.push('a' + ai);
    var r0 = +inp.dataset.r, c0 = FL.indexOf(inp.dataset.f);
    if (c0 < 0) c0 = 0;
    txt.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim().length; })
      .forEach(function (ln, i) {
        var cells = ln.indexOf('\t') >= 0 ? ln.split('\t') : ln.trim().split(/[\s,;]+/);
        var ri = r0 + i;
        while (state.rows.length <= ri) state.rows.push(blankRow());
        cells.forEach(function (cv, j) {
          var fl = FL[c0 + j]; if (!fl) return;
          cv = String(cv).trim();
          if (/^(无限|infinity|inf|∞|plano|flat)$/i.test(cv)) cv = fl === 'R' ? 'inf' : '';
          if (cv === '-' && fl !== 'R' && fl !== 'T') cv = '';
          if (fl.charAt(0) === 'a' && /^a\d+$/.test(fl)) setAsphTerm(state.rows[ri], +fl.slice(1), cv);
          else state.rows[ri][fl] = cv;
        });
      });
    renderLDE(); schedule(0);
  });

  $('insBtn').addEventListener('click', function () {
    var i = Math.min(state.sel + 1, state.rows.length);
    state.rows.splice(i, 0, blankRow());
    if (state.stop >= i) state.stop++;
    state.sel = i; renderLDE(); schedule(0);
  });
  $('delBtn').addEventListener('click', function () {
    if (state.rows.length <= 2) return;
    var i = Math.min(state.sel, state.rows.length - 1);
    state.rows.splice(i, 1);
    if (state.stop > i) state.stop--;
    state.stop = Math.min(state.stop, state.rows.length - 1);
    state.sel = Math.max(0, Math.min(i, state.rows.length - 1));
    renderLDE(); schedule(0);
  });
  $('stopBtn').addEventListener('click', function () { state.stop = state.sel; renderLDE(); schedule(0); });

  ['fno', 'fov', 'defoc', 'freqs', 'objd'].forEach(function (id) { $(id).addEventListener('input', function () { schedule(180); }); });
  ['ngrid', 'nfield', 'nviz', 'nfviz', 'aim', 'colorby', 'mtfmode'].forEach(function (id) { $(id).addEventListener('change', function () { schedule(0); }); });
  $('apmode').addEventListener('change', function () { syncApMode(); schedule(0); });

  var wb = $('wlBody');
  wb.addEventListener('input', function (e) {
    var t = e.target; if (t.tagName !== 'INPUT' || t.type === 'radio') return;
    var r = state.wl[+t.dataset.w]; if (!r) return;
    r[t.dataset.f] = t.value;
    if (t.dataset.f === 'w') refreshPct();
    if (t.dataset.f === 'nm') {                       // 改波长就重算谱色，保证颜色和波长严格对应
      r.c = wlColor(r.nm);
      var sw = wb.querySelector('input[type=color][data-w="' + t.dataset.w + '"]');
      if (sw) sw.value = r.c;
    }
    schedule(t.type === 'color' ? 0 : 220);
  });
  wb.addEventListener('change', function (e) {
    var t = e.target;
    if (t.type === 'radio') { state.pri = +t.dataset.w; schedule(0); }
  });
  $('wlAdd').addEventListener('click', function () {
    if (state.wl.length >= 6) return;
    state.wl.push({ nm: '', w: '1', c: '#7A8892' });
    renderWL(); schedule(0);
  });
  $('wlDel').addEventListener('click', function () {
    if (state.wl.length <= 1) return;
    state.wl.pop(); state.pri = Math.min(state.pri, state.wl.length - 1);
    renderWL(); schedule(0);
  });
  $('wlPreset').addEventListener('change', function () {
    var k = this.value;
    this.selectedIndex = 0;                       // 当动作菜单用，选完就弹回
    if (!WLSETS[k]) return;
    state.wl = wlSet(k); state.pri = WLPRI[k]; renderWL(); schedule(0);
  });
  $('ex').addEventListener('change', function () { loadLens(this.value); histBase(); schedule(0); });
  $('brand').addEventListener('change', function () {
    renderLensList(this.value);
    if ($('ex').options.length) { $('ex').selectedIndex = 0; loadLens($('ex').value); histBase(); schedule(0); }
  });

  function syncFMode() {
    $('fovLabel').textContent = $('fmode').value === 'height' ? '最大实像高 mm' : '半视场 °';
  }
  $('fmode').addEventListener('change', function () { syncFMode(); schedule(0); });

  $('impBtn').addEventListener('click', function () { $('impFile').click(); });
  $('impFile').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var L;
      try { L = LENSIO.fileToLens(new Uint8Array(rd.result), f.name); }
      catch (err) { showMsgs(['解析失败：' + err.message]); return; }
      if (!L.tx) { showMsgs(['没有从文件里读到面数据，确认是 CODE V .seq 或 Zemax .zmx 导出？']); return; }
      var nSurf = L.tx.split('\n').length;
      $('ex').selectedIndex = -1;
      CURORIGIN = null;                       // 现场导入的文件不带来源标记
      applyLens(L);
      LENSMSG = ['已导入 ' + f.name + '（' + (L.kind === 'zmx' ? 'Zemax .zmx' : 'CODE V .seq') + '）：' +
        nSurf + ' 面' + (L.title ? '，标题「' + L.title + '」' : '') + '。'].concat(LENSMSG);
      showMsgs(LENSMSG);
      histBase();
      schedule(0);
    };
    rd.readAsArrayBuffer(f);
    e.target.value = '';
  });

  function syncApMode() {
    var m = $('apmode').value;
    $('fno').disabled = (m === 'stop');
    $('fnoLabel').textContent = m === 'fno' ? '工作 F/#' : m === 'fnoinf' ? 'F/# (∞)' : m === 'epd' ? '入瞳直径 mm' : '（由光阑定）';
  }
  /* 把一条镜头记录装进界面。.seq / .zmx 导入和镜头库走的是同一个入口 */
  function applyLens(e) {
    if (!e || !e.tx) return;
    state.rows = textToRows(e.tx);
    state.stop = Math.min(Math.max((e.stop || 1) - 1, 0), state.rows.length - 1); state.sel = state.stop;
    $('fno').value = e.fno; $('fov').value = e.fov;
    $('freqs').value = e.freqs || '10, 30, 80';
    $('defoc').value = 0; $('apmode').value = e.apmode || 'fno'; $('aim').checked = !!e.aim;
    $('fmode').value = e.fmode || 'angle';
    $('objd').value = fmtObjDist(e.objd != null ? e.objd : Infinity);
    if (e.wl && e.wl.length) {
      state.wl = e.wl.map(function (x) { return { nm: String(x[0]), w: String(x[1]), c: wlColor(x[0]) }; });
      state.pri = Math.min(e.pri || 0, state.wl.length - 1);
    }
    if (e.nfield) $('nfield').value = e.nfield;
    state.vigH = e.vigH ? e.vigH.slice() : null;
    state.sdDraw = e.sdDraw ? e.sdDraw.slice() : null;
    state.sdAp = e.sdAp ? e.sdAp.slice() : null;
    // 镜头库里预先跑过「一键渐晕」的那份（tools/setvig.js 写的），载入即生效；
    // 文件自带的系数还在 cfgs[i].vig 里，按一下工具栏那个键就能换回去。
    state.vigAuto = e.vigAuto ? JSON.parse(JSON.stringify(e.vigAuto)) : null;
    state.cfgs = e.cfgs ? JSON.parse(JSON.stringify(e.cfgs)) : null;
    state.cfg = 0;
    if (state.cfgs) applyCfg(0);
    renderCfg();
    syncApMode(); syncFMode(); renderLDE(); renderWL();
    originBadge($('originBadge'), CURORIGIN);
    lensNotes(e);
  }
  function lensNotes(e) {
    var w = (e.warn || []).slice();
    var miss = [], sub = [], seen = {};
    state.rows.forEach(function (r) {
      var t = (r.mat || '').trim();
      if (!t || t === '-' || /^air$/i.test(t) || seen[t]) return;
      seen[t] = 1;
      var m = OPT.parseMaterial(t);
      if (m.err) miss.push(t); else if (m.sub) sub.push(t.toUpperCase() + ' → ' + m.glass);
    });
    if (sub.length) w.push('这些牌号库里没有完全同名，已按去掉末位变体后缀的同族玻璃代入：' + sub.join('、') + '。');
    if (miss.length) w.push('内置玻璃库（' + OPT.glassCount() + ' 种牌号）里找不到：' + miss.join('、') +
      ' —— 这些面按空气处理，可在「玻璃」列改写为 nd/vd 或 6 位 MIL 代码。');
    if (e.cfgs && e.cfgs.length > 1) w.push('这颗镜头有 ' + e.cfgs.length + ' 个结构（' +
      e.cfgs.map(function (c) { return c.title; }).join(' / ') + '），用工具栏「结构」下拉切换；随结构变化的格子在表里标了色。');
    if (CURORIGIN && CURORIGIN.origin)
      w.unshift('数据来源：' + CURORIGIN.origin + (CURORIGIN.originNote ? ' —— ' + CURORIGIN.originNote : '') +
        '读数只代表这份数据本身，不等于厂商实际产品的性能。');
    LENSMSG = w;
  }
  var LENSMSG = [], PENDMSG = [];

  $('focusBtn').addEventListener('click', function () {
    if (!last) return;
    var btn = this, label = btn.textContent;
    btn.textContent = '搜索中…'; btn.disabled = true;
    setTimeout(function () {
      var sur = last.surfaces;
      // 直接沿用当前一次计算的全部设置（视场定义 / 物距 / 渐晕 / 波长），只把采样调粗、频率清空
      var base = Object.assign({}, last.opt, { nGrid: 12, freqs: [], nRayViz: 3, nFieldViz: 1 });
      if (base.fieldsMTF && base.fieldsMTF.length > 3) {
        var fm = base.fieldsMTF;
        base.fieldsMTF = [fm[0], fm[Math.floor((fm.length - 1) / 2)], fm[fm.length - 1]];
      } else if (!base.fieldsMTF) base.nField = 3;
      var cost = function (d) {
        var o = Object.assign({}, base, { defocus: d });
        var s = OPT.buildSystem(sur, o); s.vig = last.sys.vig;
        var r = OPT.mtfVsField(s, o);
        var s2 = 0, n = 0;
        r.rows.forEach(function (row) { if (isFinite(row.rms) && row.rms > 0) { s2 += row.rms * row.rms; n++; } });
        return n ? Math.sqrt(s2 / n) : Infinity;
      };
      var efl = Math.abs(last.sys.efl); if (!isFinite(efl) || efl > 1e5) efl = 50;
      var lo = -0.02 * efl, hi = 0.02 * efl, best = 0, bv = Infinity, step;
      for (var pass = 0; pass < 2; pass++) {
        step = (hi - lo) / 16;
        for (var i = 0; i <= 16; i++) { var d = lo + i * step, c = cost(d); if (c < bv) { bv = c; best = d; } }
        lo = best - step; hi = best + step;
      }
      $('defoc').value = (+best.toFixed(4));
      btn.textContent = label; btn.disabled = false;
      schedule(0);
    }, 30);
  });

  /* ---------- 一键渐晕 —— CODE V 的 SET VIGNETTING ----------
     用真实通光（CIR / 固定 DIAM / FLAP）把四条边缘参考光线推到「刚好通过」，
     反算出本结构的 VUY / VLY / VUX / VLX，覆盖文件自带的那一份。
     取 21 个视场点（0…最大视场，每 5% 一个）：线性插值误差 < 1% 瞳宽，
     而常用的 3 / 6 / 11 / 21 个视场采样点正好落在网格上，根本不用插值。 */
  var VIGN = 21;
  function syncVigBtn() {
    var on = !!(state.vigAuto && state.vigAuto[state.cfg]), b = $('vigBtn');
    if (!b || b.disabled) return;
    b.textContent = on ? '渐晕：按通光' : '一键渐晕';
    b.classList.toggle('on', on);
    b.title = on
      ? '本结构的渐晕系数是按镜片真实通光重算的（CODE V 的 SET VIGNETTING）。点一下换回文件自带的那份。'
      : '按镜片的真实通光重算本结构的渐晕系数（CODE V 的 SET VIGNETTING）';
  }
  $('vigBtn').addEventListener('click', function () {
    if (!last) return;
    if (state.vigAuto && state.vigAuto[state.cfg]) {          // 已经是按通光的 → 换回文件值
      delete state.vigAuto[state.cfg];
      if (!Object.keys(state.vigAuto).length) state.vigAuto = null;
      PENDMSG.push('本结构的渐晕已换回文件自带的系数。文件的系数常常比它自己的通光松，'
        + '光路图上会看到光线穿出镜片——再按一次「一键渐晕」就按通光重算回来。');
      syncVigBtn(); schedule(0); return;
    }
    var btn = this, label = btn.textContent;
    btn.textContent = '计算中…'; btn.disabled = true;
    setTimeout(function () {
      try {
        var st = readState(), lam = last.opt.lambdas[last.opt.primary].nm / 1000;
        var fr = [], ths = [], i;
        for (i = 0; i < VIGN; i++) {
          var f = i / (VIGN - 1); fr.push(f);
          ths.push(st.fmode === 'height' ? OPT.angleForHeight(last.sys, st.fov * f, lam) : st.fov * f);
        }
        var v = OPT.setVig(last.sys, Object.assign({}, last.opt, { vigFields: ths, sdAp: state.sdAp }));
        if (!v) {
          PENDMSG.push('一键渐晕没算：这颗镜头没有任何写死的通光（CODE V 的 CIR、Zemax 的固定 DIAM / 浮动通光 FLAP），'
            + '没有孔径就无从判断谁挡住了谁。可以在「半孔径」列直接填上镜片的通光半径，再按一次。');
          schedule(0); return;
        }
        var sdOf = function (k) {
          var s2 = last.sys.surfaces[k];
          return (s2 && s2.sd) || (state.sdAp && state.sdAp[k]) || 0;
        };
        var cnt = {}, nl = 0;
        for (i = 0; i < v.lim.length; i++) if (v.lim[i] >= 0) { cnt[v.lim[i]] = (cnt[v.lim[i]] || 0) + 1; nl++; }
        var limTxt = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 3)
          .map(function (k) { return 'S' + (+k + 1) + '(半口径 ' + (+sdOf(+k).toFixed(3)) + " mm" + '，' + cnt[k] + ' 个视场)'; }).join('、');
        var wid = function (u, l) { return (2 - u - l) / 2; };          // 子午瞳宽占满瞳的比例
        var note = '渐晕已按真实通光重算（CODE V 的 SET VIGNETTING）：' + v.nAp + ' 个通光面参与判断，'
          + '光阑面 S' + (last.opt.stopIdx + 1) + ' 不参与（归一化瞳坐标 ±1 就是它的边缘，它不会渐晕自己）；'
          + '取 ' + VIGN + ' 个视场点。'
          + (limTxt ? '主要限制面：' + limTxt + '。' : '全视场都没被挡，渐晕系数全为 0。');
        var cv = (state.cfgs && state.cfgs[state.cfg] && state.cfgs[state.cfg].vig) || null;
        if (cv && cv.vuy && cv.vuy.length) {
          var n2 = cv.vuy.length - 1, vlyF = (cv.vly || cv.vuy)[n2];
          note += '最大视场的子午瞳宽 ' + (wid(cv.vuy[n2], vlyF) * 100).toFixed(1) + '% → '
            + (wid(v.vuy[VIGN - 1], v.vly[VIGN - 1]) * 100).toFixed(1) + '%。';
        }
        if (v.dark) note += '有 ' + v.dark + ' 个视场整条子午轴都被挡住（全渐晕）。';
        note += 'Ctrl+Z 可退回文件自带的系数。';
        state.vigAuto = state.vigAuto || {};
        state.vigAuto[state.cfg] = { f: fr, vuy: v.vuy, vly: v.vly, vux: v.vux, vlx: v.vlx, note: note, aim: !!st.aim };
        schedule(0);
      } finally { btn.textContent = label; btn.disabled = false; syncVigBtn(); }
    }, 30);
  });

  $('fanscale').addEventListener('change', function () { if (last) renderFan(); });

  $('cfg').addEventListener('change', function () {
    applyCfg(+this.value); renderLDE(); schedule(0);
  });

  $('undoBtn').addEventListener('click', histUndo);
  $('redoBtn').addEventListener('click', histRedo);
  $('resetBtn').addEventListener('click', histReset);
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    // 焦点在输入框里时让浏览器自己撤销文本，不抢
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); histUndo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); histRedo(); }
  });

  /* ---- 关于：二级页 ---- */
  function aboutOpen(on) {
    var sh = $('aboutSheet');
    sh.hidden = !on;
    document.body.style.overflow = on ? 'hidden' : '';
    if (on) sh.scrollTop = 0;
  }
  $('aboutBtn').addEventListener('click', function () { aboutOpen(true); });
  $('aboutBack').addEventListener('click', function () { aboutOpen(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('aboutSheet').hidden) { e.preventDefault(); aboutOpen(false); }
    else if (!$('cmpSheet').hidden) { e.preventDefault(); cmpOpen(false); }
  });

  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    if (last) { renderLayout(); renderMTF(); renderAber(); renderFan(); }
    if (CMP.on) cmpRun();
  });

  /* ================= 双镜头对比（二级页） =================
     共用：光谱 / 频率 / MTF 算法 / 瞳面网格 / 视场点数 / 横轴。
     各自按文件走：孔径定义与 F/#、视场定义与最大像高、渐晕系数、多重结构。
     —— 这几项是镜头本身的规格，强行统一就不是那颗镜头了。 */
  var CMP = { A: { id: null, cfg: 0, res: null }, B: { id: null, cfg: 0, res: null }, on: false };
  var CMPCA = ['--f2', '--f3', '--f1', '--f4'];      // A：冷色
  var CMPCB = ['--v2', '--v3', '--v1', '--v2'];      // B：暖色

  function cmpShared() {
    return {
      wl: $('cmpWl').value,
      freqs: parseList($('cmpFreqs').value, [10, 30]).filter(function (v) { return v > 0; }).slice(0, 4),
      mode: $('cmpMode').value, ts: $('cmpTS').value, xax: $('cmpX').value,
      ngrid: +$('cmpGrid').value, nfield: +$('cmpN').value, focus: $('cmpFocus').checked,
      vigFile: $('cmpVig').checked
    };
  }
  /* 建系统 + 挂渐晕 + 定视场点（与主页面 compute() 同一套规则） */
  function cmpAttach(sur, opt, L, c, S, ci) {
    var sys = OPT.buildSystem(sur, opt);
    var hgt = (L.fmode || 'height') === 'height';
    var vsrc = (c && c.vig) || null;
    var lam = opt.lambdas[opt.primary].nm / 1000;
    if (vsrc && vsrc.vuy && L.vigH && L.vigH.length === vsrc.vuy.length) {
      sys.vig = { th: L.vigH.map(function (h) { return hgt ? OPT.angleForHeight(sys, h, lam) : h; }),
                  vuy: vsrc.vuy, vly: vsrc.vly || vsrc.vuy,
                  vux: vsrc.vux || vsrc.vuy, vlx: vsrc.vlx || vsrc.vux || vsrc.vuy };
    }
    // 镜头库里预算好的「一键渐晕」表（tools/setvig.js 写的）压过文件表，和主页面保持一致；
    // 勾了「渐晕用文件原值」才退回文件自带的那份。
    var vAuto = (!(S && S.vigFile)) && L.vigAuto && L.vigAuto[ci];
    if (vAuto && vAuto.f && vAuto.f.length === vAuto.vuy.length) {
      sys.vig = { th: vAuto.f.map(function (q) {
                    return hgt ? OPT.angleForHeight(sys, L.fov * q, lam) : L.fov * q;
                  }),
                  vuy: vAuto.vuy, vly: vAuto.vly, vux: vAuto.vux, vlx: vAuto.vlx, auto: 1 };
    }
    if (hgt) {
      var mk = function (n) {
        var o = [];
        for (var q = 0; q < n; q++) o.push(n === 1 ? 0 : OPT.angleForHeight(sys, L.fov * q / (n - 1), lam));
        return o;
      };
      opt.fieldsMTF = mk(opt.nField); opt.fieldsViz = mk(opt.nFieldViz);
      opt.maxFov = opt.fieldsMTF[opt.fieldsMTF.length - 1];
    } else { opt.fieldsMTF = null; opt.fieldsViz = null; opt.maxFov = L.fov; }
    opt.fieldsFan = [];
    for (var qf = 0; qf < NFAN; qf++) opt.fieldsFan.push(opt.maxFov * qf / (NFAN - 1));
    return sys;
  }
  function cmpBuild(L, ci, S) {
    if (!L || !L.tx) return null;
    var sur = OPT.parsePrescription(L.tx).surfaces;
    if (sur.length < 2) return null;
    var c = (L.cfgs && L.cfgs[ci]) || null;
    var fno = L.fno, objd = (L.objd == null ? Infinity : L.objd);
    if (c) {
      Object.keys(c.thi).forEach(function (k) { if (sur[+k]) sur[+k].T = c.thi[k]; });
      Object.keys(c.rdy).forEach(function (k) { if (sur[+k]) sur[+k].R = c.rdy[k]; });
      if (c.fno != null) fno = c.fno;
      objd = (c.obj == null ? Infinity : c.obj);
    }
    var wl, pri;
    // 预设表里的波长 / 权重是字符串（主页面靠 wlActive 转数），这里必须自己转，
    // 否则权重会被当字符串连起来累加，谱段一多 MTF 直接塌成 0
    if (S.wl && WLSETS[S.wl]) {
      wl = wlSet(S.wl).map(function (x) { return { nm: +x.nm, w: +x.w, c: x.c }; });
      pri = WLPRI[S.wl];
    }
    else {
      wl = (L.wl || []).map(function (x) { return { nm: +x[0], w: +x[1], c: x[2] || wlColor(x[0]) }; });
      pri = L.pri || 0;
      if (!wl.length) { wl = wlSet('p5'); pri = 1; }
    }
    pri = Math.min(Math.max(pri | 0, 0), wl.length - 1);
    var opt = {
      lambdas: wl.map(function (x) { return { nm: x.nm, w: x.w }; }), primary: pri,
      stopIdx: Math.min((L.stop || 1) - 1, sur.length - 1),
      // 光线瞄准必须跟着镜头走：渐晕表的归一化瞳坐标是在光阑面上定义的，
      // 这里写死不瞄准的话，表和坐标对不上，边缘视场的 MTF 会明显偏
      apertureMode: L.apmode || 'fno', fno: fno, epd: fno, rayAiming: L.aim !== false,
      maxFov: L.fov, defocus: 0, nGrid: S.ngrid, nField: S.nfield,
      freqs: S.freqs, nRayViz: 3, nFieldViz: 3, colorBy: 'field', mtfMode: S.mode, objDist: objd,
      sdDraw: L.sdDraw || null, sdAp: L.sdAp || null
    };
    var sys = cmpAttach(sur, opt, L, c, S, ci);
    if (S.focus) {
      var dz = axialBestFocus(sys, opt);
      if (dz !== null && isFinite(dz)) { opt.defocus = dz; sys = cmpAttach(sur, opt, L, c, S, ci); }
    }
    return { L: L, opt: opt, sys: sys, wl: wl, hgt: (L.fmode || 'height') === 'height',
             mtf: OPT.mtfVsField(sys, opt), lay: OPT.layoutGeometry(sys, opt) };
  }

  /* ---- 两个下拉 ---- */
  function cmpFillBrand(k) {
    var n = {};
    LENSDB.index.forEach(function (e) { n[brandOf(e)] = (n[brandOf(e)] || 0) + 1; });
    $('cmpBrand' + k).innerHTML = brandList().map(function (b) {
      return '<option value="' + esc(b) + '">' + esc(b) + ' (' + n[b] + ')</option>';
    }).join('');
  }
  function cmpFillLens(k, brand) {
    $('cmpEx' + k).innerHTML = LENSDB.index.filter(function (e) { return brandOf(e) === brand; })
      .map(function (e) {
        return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.origin ? '（' + esc(e.origin) + '）' : '') + '</option>';
      }).join('');
  }
  function cmpFillCfg(k, L) {
    var w = $('cmpCfgWrap' + k), sel = $('cmpCfg' + k);
    if (!L || !L.cfgs || L.cfgs.length < 2) { w.style.display = 'none'; sel.innerHTML = ''; return; }
    w.style.display = '';
    sel.innerHTML = L.cfgs.map(function (c, i) {
      return '<option value="' + i + '">Z' + (i + 1) + ' · ' + esc(c.title) + '</option>';
    }).join('');
    sel.value = String(Math.min(CMP[k].cfg, L.cfgs.length - 1));
  }
  function cmpPick(k, id, cb) {
    CMP[k].id = id;
    getLens(id, function (err, L) {
      if (err) { CMP[k].res = null; if (cb) cb(); return; }
      var e = idxEntry(id);
      CMP[k].name = (e && e.name) || L.name || id;
      CMP[k].brand = e ? brandOf(e) : '';
      CMP[k].entry = e;
      originBadge($('cmpOrigin' + k), e);
      if (!L.cfgs || CMP[k].cfg >= L.cfgs.length) CMP[k].cfg = 0;
      CMP[k].L = L;
      $('cmpBrand' + k).value = CMP[k].brand;
      cmpFillLens(k, CMP[k].brand);
      $('cmpEx' + k).value = id;
      cmpFillCfg(k, L);
      if (cb) cb();
    });
  }

  /* ---- 计算 + 画 ---- */
  function cmpRun() {
    if (!CMP.on) return;
    var S = cmpShared();
    ['A', 'B'].forEach(function (k) {
      CMP[k].res = CMP[k].L ? cmpBuild(CMP[k].L, CMP[k].cfg, S) : null;
      cmpSide(k);
    });
    cmpChart(S);
  }
  function cmpSide(k) {
    var R = CMP[k].res;
    if (!R) { $('cmpLay' + k).innerHTML = ''; $('cmpStat' + k).innerHTML = ''; $('cmpLayBadge' + k).textContent = '—'; return; }
    drawLayout({ lay: R.lay, sys: R.sys, mtf: R.mtf, opt: R.opt, wlCols: R.wl.map(function (x) { return x.c; }) },
               { svg: 'cmpLay' + k, badge: 'cmpLayBadge' + k, legend: 'cmpLayLegend' + k });
    var maxH = 0;
    R.mtf.rows.forEach(function (r) { maxH = Math.max(maxH, r.imgHc || r.imgH || 0); });
    var it = [['EFL', fmt(R.sys.efl, 3)], ['使用的 F/', fmt(R.sys.fno, 3)], ['入瞳 ⌀', fmt(R.sys.epd, 3)],
              ['最大像高', fmt(maxH, 3)], ['轴上 RMS', fmt(R.mtf.rows[0] ? R.mtf.rows[0].rms : 0, 2) + ' µm']];
    if (Math.abs(R.sys.mag || 0) > 1e-9) it.push(['RED', fmt(R.sys.mag, 4)]);
    if (Math.abs(R.opt.defocus) > 1e-9) it.push(['离焦', fmt(R.opt.defocus, 4)]);
    var nm = R.opt.lambdas.map(function (x) { return x.nm; });
    it.push(['波长', nm.length + ' 条 · 主 ' + R.opt.lambdas[R.opt.primary].nm + ' nm']);
    if (CMP[k].entry && CMP[k].entry.origin) it.push(['来源', CMP[k].entry.origin]);
    $('cmpStat' + k).innerHTML = it.map(function (x) {
      return '<span><b>' + esc(x[0]) + '</b><i>' + esc(x[1]) + '</i></span>';
    }).join('');
  }
  function cmpChart(S) {
    var svg = $('cmpMtf');
    var A = CMP.A.res, B = CMP.B.res, sets = [];
    if (A) sets.push({ k: 'A', R: A, cols: CMPCA.map(css) });
    if (B) sets.push({ k: 'B', R: B, cols: CMPCB.map(css) });
    if (!sets.length) { svg.innerHTML = ''; $('cmpLegend').innerHTML = ''; $('cmpBadge').textContent = '—'; return; }

    // 画幅比例跟主页面的 MTF 图一致（高 = 宽 × 0.47，约 2.13 : 1）；
    // 对比页整宽比主页面右栏宽得多，所以上限放到 860，另加一道视口高度的兜底，
    // 免得在笔记本屏上一张图就把整屏占满。
    var W = paneW('cmpMtf', 620);
    var H = Math.round(Math.max(360, Math.min(W * 0.47, 860, (window.innerHeight || 900) * 0.72)));
    var P = { l: 52, r: 96, t: 14, b: 46 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var ink = css('--ink'), ink2 = css('--ink-2'), ink3 = css('--ink-3'), lineC = css('--line-2');
    var byH = S.xax === 'h';
    var xmax = 0;
    sets.forEach(function (t) {
      t.hx = t.R.mtf.rows.map(function (r) { return (t.R.hgt ? (r.imgHc || r.imgH) : r.field) || 0; });
      t.hmax = Math.max(t.hx[t.hx.length - 1] || 1e-6, 1e-6);
      xmax = Math.max(xmax, t.hmax);
    });
    if (!byH) xmax = 1;
    var X = function (v) { return P.l + iw * Math.max(0, Math.min(1, v / xmax)); };
    var Y = function (m) { return P.t + ih * (1 - Math.max(0, Math.min(1, m))); };
    var g = [];

    for (var i = 0; i <= 10; i++) {
      var v = i / 10, y = Y(v);
      g.push('<line x1="' + P.l + '" y1="' + y.toFixed(1) + '" x2="' + (P.l + iw) + '" y2="' + y.toFixed(1) +
        '" stroke="' + lineC + '" stroke-width="1"/>');
      g.push('<text x="' + (P.l - 8) + '" y="' + (y + 4).toFixed(1) + '" fill="' + ink3 +
        '" font-size="10.5" text-anchor="end" font-family="IBM Plex Mono, monospace">' + (i === 0 ? '0' : i === 10 ? '1' : v.toFixed(1)) + '</text>');
    }
    var step = niceStep(xmax / Math.max(8, Math.min(24, Math.round(iw / 58))));
    for (var f = 0; f <= xmax + step * 1e-6; f += step) {
      var x = X(Math.min(f, xmax));
      g.push('<line x1="' + x.toFixed(1) + '" y1="' + P.t + '" x2="' + x.toFixed(1) + '" y2="' + (P.t + ih) +
        '" stroke="' + lineC + '" stroke-width="1"/>');
      g.push('<text x="' + x.toFixed(1) + '" y="' + (P.t + ih + 17) + '" fill="' + ink3 +
        '" font-size="10.5" text-anchor="middle" font-family="IBM Plex Mono, monospace">' + (+f.toFixed(2)) + '</text>');
    }
    g.push('<text x="' + (P.l + iw / 2) + '" y="' + (H - 8) + '" fill="' + ink2 + '" font-size="11" text-anchor="middle">' +
      (byH ? 'Y 实像高 (mm)' : '归一化视场') + '</text>');
    g.push('<text transform="translate(16,' + (P.t + ih / 2) + ') rotate(-90)" fill="' + ink2 + '" font-size="11" text-anchor="middle">MTF</text>');
    g.push('<rect x="' + P.l + '" y="' + P.t + '" width="' + iw + '" height="' + ih + '" fill="none" stroke="' + css('--line') + '" stroke-width="1"/>');

    var labels = [];
    sets.forEach(function (t) {
      var rows = t.R.mtf.rows, lam0 = t.R.opt.lambdas[t.R.opt.primary].nm / 1000;
      S.freqs.forEach(function (nu, q) {
        var c = t.cols[q % t.cols.length];
        var dl = OPT.diffractionMTF(nu, lam0, t.R.sys.fno);
        if (dl > 0.002) g.push('<line x1="' + P.l + '" y1="' + Y(dl).toFixed(1) + '" x2="' + (P.l + iw) + '" y2="' + Y(dl).toFixed(1) +
          '" stroke="' + c + '" stroke-width="1" stroke-dasharray="2 5" opacity=".45"/>');
        var kinds = S.ts === 't' ? [['T', 0]] : S.ts === 's' ? [['S', 1]]
                  : S.ts === 'avg' ? [['A', 0]] : [['T', 0], ['S', 1]];
        kinds.forEach(function (kk) {
          var pts = rows.map(function (r, ri) {
            var val = kk[0] === 'A' ? (r.T[q] + r.S[q]) / 2 : r[kk[0]][q];
            return [X(byH ? t.hx[ri] : t.hx[ri] / t.hmax), Y(val)];
          });
          g.push('<path d="' + pchip(pts) + '" fill="none" stroke="' + c + '" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"' +
            (kk[1] ? ' stroke-dasharray="5 3.5"' : '') + '/>');
        });
        var lastR = rows[rows.length - 1];
        labels.push({ y: Y(S.ts === 's' ? lastR.S[q] : S.ts === 'avg' ? (lastR.T[q] + lastR.S[q]) / 2 : lastR.T[q]),
                      text: t.k + ' ' + nu, c: c });
      });
    });
    labels.sort(function (a, b) { return a.y - b.y; });
    for (var q2 = 1; q2 < labels.length; q2++) if (labels[q2].y - labels[q2 - 1].y < 13) labels[q2].y = labels[q2 - 1].y + 13;
    labels.forEach(function (L2) {
      g.push('<text x="' + (P.l + iw + 8) + '" y="' + (L2.y + 4).toFixed(1) + '" fill="' + L2.c +
        '" font-size="11" font-weight="600" font-family="IBM Plex Mono, monospace">' + esc(L2.text) + '</text>');
    });

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = g.join('');

    var tsTxt = S.ts === 't' ? '只画子午 T' : S.ts === 's' ? '只画弧矢 S'
              : S.ts === 'avg' ? '画 (T+S)/2' : '实线 = 子午 T　虚线 = 弧矢 S';
    $('cmpLegend').innerHTML = sets.map(function (t) {
      return '<span class="lg"><span class="sw" style="background:' + t.cols[0] + '"></span>' +
        t.k + ' · ' + esc(CMP[t.k].name || '') +
        (CMP[t.k].entry && CMP[t.k].entry.origin ? '（' + esc(CMP[t.k].entry.origin) + '）' : '') +
        ' · F/' + fmt(t.R.sys.fno, 2) + '</span>';
    }).join('') + '<span class="lg conv">' + tsTxt + '</span>' +
      '<span class="lg conv" style="color:' + ink3 + '">短虚线 = 各自的衍射极限</span>';
    $('cmpBadge').textContent = sets.map(function (t) { return t.k + ' ' + t.R.mtf.rows.length + ' 点'; }).join(' · ') +
      ' · ' + S.freqs.join('/') + ' cyc/mm';
  }

  /* ---- 开关与事件 ---- */
  function cmpOpen(on) {
    var sh = $('cmpSheet');
    sh.hidden = !on; CMP.on = on;
    document.body.style.overflow = on ? 'hidden' : '';
    if (!on) return;
    sh.scrollTop = 0;
    cmpFillBrand('A'); cmpFillBrand('B');
    if (!CMP.A.id) {
      var ids = LENSDB.index.map(function (e) { return e.id; });
      var a = ids[0], b = ids[1] || ids[0];
      cmpPick('A', a, function () { cmpPick('B', b, cmpRun); });
    } else cmpRun();
  }
  $('cmpBtn').addEventListener('click', function () { cmpOpen(true); });
  $('cmpBack').addEventListener('click', function () { cmpOpen(false); });
  ['A', 'B'].forEach(function (k) {
    $('cmpBrand' + k).addEventListener('change', function () {
      cmpFillLens(k, this.value);
      if ($('cmpEx' + k).options.length) { CMP[k].cfg = 0; cmpPick(k, $('cmpEx' + k).value, cmpRun); }
    });
    $('cmpEx' + k).addEventListener('change', function () { CMP[k].cfg = 0; cmpPick(k, this.value, cmpRun); });
    $('cmpCfg' + k).addEventListener('change', function () { CMP[k].cfg = +this.value; cmpRun(); });
  });
  ['cmpWl', 'cmpFreqs', 'cmpMode', 'cmpTS', 'cmpX', 'cmpGrid', 'cmpN', 'cmpFocus', 'cmpVig'].forEach(function (id) {
    $(id).addEventListener('change', cmpRun);
  });
  addEventListener('resize', function () { if (CMP.on) cmpRun(); });

  /* ================= 启动 ================= */
  renderBrandList();
  renderLensList($('brand').value);
  var saved = readHash();
  if (saved && saved.tx) {
    state.rows = textToRows(saved.tx);
    state.stop = Math.min((saved.stop || 1) - 1, state.rows.length - 1); state.sel = state.stop;
    ['fno', 'fov', 'defoc'].forEach(function (k) { if (saved[k] !== undefined) $(k).value = saved[k]; });
    if (saved.freqs) $('freqs').value = saved.freqs.join(', ');
    if (saved.wlRaw && saved.wlRaw.length) { state.wl = saved.wlRaw; state.pri = Math.min(saved.pri || 0, state.wl.length - 1); }
    if (saved.colorby) $('colorby').value = saved.colorby;
    if (saved.apmode) $('apmode').value = saved.apmode;
    if (saved.fmode) $('fmode').value = saved.fmode;
    if (saved.mtfmode) $('mtfmode').value = saved.mtfmode;
    $('aim').checked = !!saved.aim;
    ['ngrid', 'nfield', 'nviz', 'nfviz'].forEach(function (k) { if (saved[k]) $(k).value = saved[k]; });
    syncApMode(); syncFMode(); renderLDE();
    $('ex').selectedIndex = -1;              // 链接里带的处方不属于库里任何一颗
  } else {
    var first = (LENSDB.index[0] && LENSDB.index[0].id) || '55za';
    syncLensSelects(first);
    loadLens(first);
  }
  syncFMode();
  renderWL();
  histBase();
  compute();

  if (window.ResizeObserver) {
    var roW = 0, roT = null;
    new ResizeObserver(function (en) {
      var w = Math.round(en[0].contentRect.width);
      if (w === roW) return;                     // 只认宽度变化
      roW = w;
      clearTimeout(roT);
      roT = setTimeout(function () { if (last) { renderLayout(); renderMTF(); renderAber(); renderFan(); } }, 130);
    }).observe(document.querySelector('.viewcol'));
  }
})();
