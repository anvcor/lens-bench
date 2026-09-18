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
  var lensPending = false;                     // 静态站：镜头 JSON 还在下载
  function loadLens(id, done) {
    var sel = $('ex'), old = sel.options[sel.selectedIndex];
    var busy = !(LENSCACHE[id] || LENSDB.inline[id]);
    if (busy && old) old.textContent = old.textContent.replace(/ · 载入中…$/, '') + ' · 载入中…';
    lensPending = busy;
    getLens(id, function (err, L) {
      lensPending = false;
      if (old) old.textContent = old.textContent.replace(/ · 载入中…$/, '');
      if (err) {
        showMsgs(['载入镜头 ' + id + ' 失败：' + err.message +
          '（本地双击打开 html 时浏览器会拦截 fetch，请用单文件版，或把目录挂到本地服务器上）']);
        if (done) done(err); return;
      }
      CURORIGIN = idxEntry(id);
      state.libId = id; state.imp = false; IMPREC = null;
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
                cfgs: null, cfg: 0, vigH: null, sdDraw: null, sdAp: null, vigAuto: null, cfgs0: null, T0: null, libId: null, imp: false };
  // libId = 当前处方来自镜头库的哪颗（导入的文件 / 旧链接认不出时为 null）；imp = 当前是导入的文件（记录在 sessionStorage）
  // cfgs0 / T0 = 载入时文件原样的多重结构和各面厚度，只给「最佳对焦」认对焦凸轮用（界面改动会写回 cfgs）
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
      '<th style="min-width:88px">Radius</th>' +
      '<th style="min-width:76px">厚度</th>' +
      '<th style="min-width:126px">玻璃</th>' +
      '<th style="min-width:80px">半孔径</th>' +
      '<th style="min-width:74px">圆锥<br>系数</th>';
    for (i2 = 0; i2 < NA; i2++)
      hd += '<th class="ac' + (i2 ? '' : ' ac0') + '" style="min-width:132px">A' + (4 + 2 * i2) + '</th>';
    $('ldeHead').innerHTML = hd + '</tr>';

    var pad = '<td></td><td></td><td></td>' + new Array(NA + 1).join('<td></td>');
    // 物面：Radius 固定无限（平面物）；厚度就是物距，和顶栏「物距」是同一个量，改哪边都行
    var h = ['<tr class="fixed"><td class="num">物面</td><td class="typ">球面</td>' +
      '<td class="ro">无限</td><td><input id="ldeObjd" data-obj="1" value="' + esc($('objd').value) +
      '" placeholder="inf" title="物距：物面到第 1 面顶点的距离 mm，写 inf 为无限远。改完按「最佳对焦」，镜头会沿自己的对焦群重新对焦"' +
      ' spellcheck="false" autocapitalize="off" autocorrect="off"></td>' + pad + '</tr>'];
    state.rows.forEach(function (r, i) {
      var isStop = i === state.stop, a = asphArr(r), td = '';
      for (i2 = 0; i2 < NA; i2++) td += cellA(i, i2, asphDisp(a[i2] || ''));
      h.push('<tr data-r="' + i + '"' + (i === state.sel ? ' class="sel"' : '') + '>' +
        '<td class="num' + (isStop ? ' stop' : '') + '" data-r="' + i + '" title="点击设为光阑">' + (isStop ? '光阑' : (i + 1)) + '</td>' +
        '<td class="typ" data-typ="' + i + '">' + (isAsph(r) ? '非球面' : '球面') + '</td>' +
        cell(i, 'R', r.R, 'inf', cfgHas(i, 'R')) + cell(i, 'T', r.T, '0', cfgHas(i, 'T')) +
        cellT(i, 'mat', r.mat, '') + cellSd(i, r) +
        cell(i, 'k', r.k, '') + td + '</tr>');
    });
    h.push('<tr class="fixed"><td class="num">像面</td><td class="typ">球面</td>' +
      '<td class="ro">无限</td><td class="ro">0.0000</td>' + pad + '</tr>');
    ensureGlassList();
    $('ldeBody').innerHTML = h.join('');
  }
  /* 半孔径列。格子里有数（CODE V 的 CIR / 手填）= 硬光阑：照常显示，追迹时光线超出即被挡。
     没数的面用灰字显示参考值，不挡光——在格子里填数就变成硬光阑。灰字来源的优先级同 Layout：
     文件写死的通光（Zemax 固定 DIAM / FLAP）→ 文件的半口径（Zemax 自动 DIAM）→ 本页按光线包络算的画图半径。
     最后一种要算完一次才有，所以计算完成后 syncSdHints() 再补一遍，不重绘整张表（不打断正在输入的格子）。 */
  var SD_HARD = '硬光阑：追迹时光线超出即被挡。清空则退回参考值';
  function sdHint(i) {
    var a = state.sdAp && state.sdAp[i], d = state.sdDraw && state.sdDraw[i];
    if (a) return { v: a, why: '文件里写死的通光（Zemax 固定 DIAM / FLAP）：「一键渐晕」和 Spot 逐面裁剪按它算，MTF 追迹不裁光线。填数则作为硬光阑' };
    if (d) return { v: d, why: '文件里的半口径（Zemax 自动算的 DIAM），只用于画图，不挡光。填数则作为硬光阑' };
    var L = last && last.lay && last.lay.drawSd;
    // 空白面贴着邻面时会被 Layout 的防穿透钳位压到 ~0，那不是半口径，不显示
    if (L && last.surfaces && last.surfaces.length === state.rows.length && L[i] > 1e-3)
      return { v: L[i], why: '文件没写半口径，这是本页按光线包络算的画图半径，不挡光。填数则作为硬光阑' };
    return null;
  }
  function fmtSd(v) { return String(+(+v).toFixed(4)); }
  function cellSd(i, r) {
    var h = r.sd ? null : sdHint(i);
    return '<td><input data-r="' + i + '" data-f="sd" value="' + esc(r.sd) + '" placeholder="' + (h ? fmtSd(h.v) : '') +
      '" title="' + esc(r.sd ? SD_HARD : (h ? h.why : '')) + '" spellcheck="false" autocapitalize="off" autocorrect="off"></td>';
  }
  function syncSdHints() {
    Array.prototype.forEach.call($('ldeBody').querySelectorAll('input[data-f="sd"]'), function (el) {
      var i = +el.dataset.r, r = state.rows[i]; if (!r) return;
      var h = r.sd ? null : sdHint(i);
      el.placeholder = h ? fmtSd(h.v) : '';
      el.title = r.sd ? SD_HARD : (h ? h.why : '');
    });
  }
  /* 物距两处可改：顶栏「物距」和 LDM 物面行的厚度。改哪边都同步另一边，并写回当前结构——
     和改厚度格子写回当前结构是一个道理，否则切走再切回来，物距回到文件值、厚度却是改过的，对不上。 */
  function setObjd(text, from) {
    if (from !== $('objd')) $('objd').value = text;
    var o = $('ldeObjd'); if (o && from !== o) o.value = text;
    var c = state.cfgs && state.cfgs[state.cfg];
    if (c) c.obj = parseObjDist(text);
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
      '" spellcheck="false" autocapitalize="off" autocorrect="off"' + (f === 'mat' && v ? ' list="glassdl"' : '') + '></td>';
  }
  /* 玻璃格的补全列表只在格子里有字时挂上。空格子 = 空气（和 Zemax 一样），点进去不该
     弹出三千多个牌号让人选；开始敲字母才出候选。keydown 在字符落进去之前就把 list
     挂上，第一个字母就有候选；退格清空后再摘掉。 */
  function glassListSync(t, willType) {
    if (t.dataset.f !== 'mat') return;
    if (willType || t.value.trim()) { if (!t.hasAttribute('list')) t.setAttribute('list', 'glassdl'); }
    else if (t.hasAttribute('list')) t.removeAttribute('list');
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
    var oc = $('ldeObjd'); if (oc) oc.value = $('objd').value;
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
      sdDraw: state.sdDraw, sdAp: state.sdAp,
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
    if ('sdDraw' in o) { state.sdDraw = o.sdDraw || null; state.sdAp = o.sdAp || null; }
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
    // 半口径数组按行下标对齐。插删面在 insBtn / delBtn 里同步；粘贴会在末尾补行，这里补 null。
    // 长度对不上时光学内核会整份忽略它们（画图、一键渐晕、Spot 就全退回光线包络）。
    [state.sdDraw, state.sdAp].forEach(function (a) {
      if (!a) return;
      while (a.length < state.rows.length) a.push(null);
      if (a.length > state.rows.length) a.length = state.rows.length;
    });
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
      msgs.push('光阑面（第 ' + (stopIdx + 1) + ' 面）没有半孔径，无法按光阑浮动，已退回 F/# 定义。');
    if (st.aim && !sys.aiming) msgs.push('本次未能启用光线瞄准（求不出光阑半径）。');
    // 像面是不是就落在轴上焦点处？（近轴细光线与光轴的交点 vs 当前像面）
    // 只取决于曲率 / 厚度 / 折射率，与孔径、非球面高次项无关，所以能直接判断
    // 「文件里的后焦距对不对」。写死的镜头和正常的 .zmx 都在 1 波以内，超过就提示。

    var t0 = performance.now();
    var mtf = OPT.mtfVsField(sys, opt);
    var lay = OPT.layoutGeometry(sys, opt);
    var aber = OPT.aberrations(sys, opt);
    var fan = OPT.rayFan(sys, opt);
    var dt = performance.now() - t0;

    // 渐晕本身不是问题，边缘通光率在信息卡和数据表里都有，不再刷提示
    if (mtf.mode === 'diff') {
      var pvm = 0; mtf.rows.forEach(function (r) { pvm = Math.max(pvm, r.wpv || 0); });
      if (st.ngrid < 32)
        msgs.push('衍射模式建议瞳面网格 ≥ 32²：24² 时轴上 MTF@30 会偏高约 0.03（实测 0.746 vs 收敛值 0.711）。');
      if (pvm > st.ngrid / 3)
        msgs.push('波前 PV 达 ' + pvm.toFixed(0) + ' λ，超出 ' + st.ngrid + '² 瞳网格的相位取样能力，衍射 MTF 可能失真——请调大瞳面网格或改用几何模式。');
    }
    last = { sys: sys, mtf: mtf, lay: lay, aber: aber, fan: fan, opt: opt, st: st, dt: dt, surfaces: p.surfaces };
    syncSdHints();
    spotStale();
    showMsgs(msgs);
    $('surfBadge').textContent = p.surfaces.length + ' 面 · ' + p.surfaces.filter(function (s) { return s.isGlass; }).length + ' 片';
    renderStatus();
    renderSpec();
    renderLayout();
    renderMTF();
    renderAber();
    renderFan();
    renderDataTable();
    $('perfBadge').textContent = (mtf.mode === 'diff' ? '衍射 · ' : '几何 · ') + mtf.rays.toLocaleString('en-US') + ' 条' + (mtf.aiming ? '（瞄准）' : '') + ' · ' + dt.toFixed(0) + ' ms';
    $('stPerf').textContent = '追迹 ' + mtf.rays.toLocaleString('en-US') + ' 条 · ' + dt.toFixed(0) + ' ms · JS 单线程';
    syncVigBtn();
    writeHash(hashState(st));
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

  /* ================= 镜头信息卡 =================
     上半「标称」来自进度表（index 条目的 spec，tools/specs_import.py 写的），载入镜头时定下来不变；
     下半「本页」每次重算都刷：一阶量 + 几个粗略的性能数，够一眼看出这颗镜头大概什么水平。
     两半故意并排放：标称焦距 85 / 算出来 84.2、标称 F1.4 / 算出来 F1.46，这种差别就是数据和产品的差别。 */
  function patentUrl(pn) {
    var q = String(pn).replace(/[\s\/\-]/g, '');
    return 'https://patents.google.com/?q=' + encodeURIComponent('(' + q + ')') + '&oq=' + encodeURIComponent(q);
  }
  function specTile(k, v, title) {
    return '<span class="it"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="k">' + k + '</span><span class="v">' + v + '</span></span>';
  }
  function renderSpec() {
    var box = $('lensSpec');
    if (!last) { box.hidden = true; return; }
    var sp = CURORIGIN && CURORIGIN.spec, h = [];
    if (sp) {
      h.push('<span class="hd">标称 · 进度表</span>');
      if (sp.patent) h.push(specTile('专利号', '<a href="' + patentUrl(sp.patent) + '" target="_blank" rel="noopener">' + esc(sp.patent) + '</a>', '在 Google Patents 检索这个号'));
      else h.push(specTile('专利号', '<i>表里没填</i>'));
      if (sp.model) h.push(specTile('型号代码', esc(sp.model)));
      var mt = [sp.mount, sp.format, sp.type].filter(Boolean).join(' · ');
      if (mt) h.push(specTile('卡口 · 画幅 · 类型', esc(mt)));
      if (sp.focal || sp.aperture) h.push(specTile('标称焦距 · 光圈', esc([sp.focal ? sp.focal + ' mm' : '', sp.aperture || ''].filter(Boolean).join(' · '))));
      if (sp.year || sp.status) h.push(specTile('发售', esc([sp.year, sp.status].filter(Boolean).join(' · '))));
    }
    var s2 = last.sys, rows = last.mtf.rows, N = s2.surfaces.length, freqs = last.opt.freqs || [];
    var oal = s2.zVertex[N - 1], nGlass = s2.surfaces.filter(function (q) { return q.isGlass; }).length;
    var r0 = rows[0], rN = rows[rows.length - 1];
    h.push('<span class="hd">本页 · 按当前状态算</span>');
    h.push(specTile('焦距 · F/#', fmt(s2.efl, 2) + ' mm · F/' + fmt(s2.fno, 2), '主波长近轴焦距；F/# 按顶栏「孔径定义」'));
    h.push(specTile('总长 · 后截距', fmt(oal, 2) + ' <i>+</i> ' + fmt(s2.bfl, 2) + ' <i>= ' + fmt(oal + s2.bfl, 2) + '</i>', '第 1 面顶点到末面顶点 + 末面到像面 = 首面到像面'));
    h.push(specTile('入瞳 · 最大像高', 'φ' + fmt(s2.epd, 2) + ' · ' + fmt(rN ? (rN.imgHc || rN.imgH) : 0, 2), '入瞳直径 / 最大视场的主光线像高'));
    h.push(specTile('片数 · 面数 · 结构', nGlass + ' · ' + N + ' · ' + (state.cfgs ? state.cfgs.length : 1)));
    if (r0 && rN) {
      h.push(specTile('轴上 · 边缘 RMS', fmt(r0.rms, 1) + ' <i>/</i> ' + fmt(rN.rms, 1) + ' µm', '主波长几何弥散斑 RMS 半径'));
      var mt2 = [];
      for (var qi = 0; qi < Math.min(2, freqs.length); qi++)
        mt2.push(freqs[qi] + ': ' + fmt(r0.T[qi], 2) + ' <i>/</i> ' + fmt(rN.T[qi], 2) + '<i>T</i> ' + fmt(rN.S[qi], 2) + '<i>S</i>');
      if (mt2.length) h.push(specTile('MTF 中心 / 边缘', mt2.join(' &nbsp; '), '按频率 cyc/mm：中心 T / 边缘 T · S（' + (last.mtf.mode === 'diff' ? '衍射' : '几何') + '）'));
      if (rN.thru != null) h.push(specTile('边缘通光率', fmt(rN.thru * 100, 0) + '%', '最大视场的等效通光瞳面积占比（渐晕）'));
    }
    var A = last.aber, pri = last.opt.primary;
    if (A && A.dist && A.dist[pri]) {
      var dmax = 0, dh = 0;
      A.dist[pri].pts.forEach(function (q) { if (Math.abs(q[0]) > Math.abs(dmax)) { dmax = q[0]; dh = q[1]; } });
      h.push(specTile('最大畸变', fmt(dmax, 2) + '% <i>@' + fmt(dh, 1) + ' mm</i>'));
    }
    box.innerHTML = h.join('');
    box.hidden = false;
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
    var P = function (z, y) { return X(z).toFixed(3) + ' ' + Y(y).toFixed(3); };
    /* 线宽、虚线、标注都按「屏幕上的像素」定：data-sw / data-da / data-tx 记下倍率 1 时的值，
       Layout 放大时 layApply 按倍率反除（见 layMarks），放大只让几何变大，线条和字不跟着变粗变大。 */
    var sw = function (w) { return ' stroke-width="' + w + '" data-sw="' + w + '"'; };
    var dash = function (da) { return da ? ' stroke-dasharray="' + da + '" data-da="' + da + '"' : ''; };
    var label = function (ax, ay, dx, dy, anchor, text) {
      return '<g data-tx="' + ax.toFixed(3) + '" data-ty="' + ay.toFixed(3) + '" transform="translate(' + ax.toFixed(3) + ' ' + ay.toFixed(3) + ')">' +
        '<text x="' + dx + '" y="' + dy + '" fill="' + ink2 + '" font-size="10.5" text-anchor="' + anchor +
        '" font-family="IBM Plex Mono, monospace">' + text + '</text></g>';
    };
    var g = [];

    g.push('<line x1="' + xoff.toFixed(3) + '" y1="' + Y(0) + '" x2="' + (PX - xoff).toFixed(3) + '" y2="' + Y(0) +
      '" stroke="' + ink3 + '"' + sw(1) + dash('7 4') + ' opacity=".5"/>');

    g.push('<g stroke="' + gstroke + '"' + sw(1.15) + ' stroke-linejoin="round">');
    L.elements.forEach(function (e) {
      var d = 'M' + e.front.map(function (p) { return P(p[0], p[1]); }).join(' L') +
        ' L' + e.back.slice().reverse().map(function (p) { return P(p[0], p[1]); }).join(' L') + ' Z';
      g.push('<path d="' + d + '" fill="' + (e.cemented ? glass2 : glass) + '" fill-opacity=".9"/>');
    });
    g.push('</g>');

    var byW = L.byWvl, wlCols = C.wlCols || [];
    L.bundles.forEach(function (b) {
      var c = byW ? (wlCols[b.wi] || fieldCols[0]) : (fieldCols[b.fi] || fieldCols[fieldCols.length - 1]);
      var da = byW ? DASH[b.wi % DASH.length] : '';
      // stroke-opacity 放在组上逐条继承，和原来每条 opacity 的叠加效果一样（组级 opacity 会把整束当一张图层合成）
      g.push('<g fill="none" stroke="' + c + '"' + sw(1.05) + ' stroke-opacity=".92"' + dash(da) + '>');
      b.rays.forEach(function (r) {
        g.push('<path d="' + r.map(function (p, j) { return (j ? 'L' : 'M') + P(p[0], p[1]); }).join(' ') + '"/>');
      });
      g.push('</g>');
    });

    var si = C.opt.stopIdx, zs = s.zVertex[si];
    if (zs !== undefined) {
      // 光阑刻线的半径要和镜片外形用同一个数（layoutGeometry 的 drawSd）。
      // 原来用 sys.sdStop —— 那是孔径定义解出来的「近轴光瞳半径」，
      // 实际边缘光线因为光瞳球差会落得更高（85 GM II 的 1.6m 结构：光线到 17.09，sdStop 只有 16.59），
      // 于是光线从刻线中间穿过去，看着像和光阑打架。
      var hs = (L.drawSd && L.drawSd[si]) || s.surfaces[si].sd || L.sdStop || Math.max(L.maxR[si] * 1.06, s.epd / 2);
      g.push('<line x1="' + X(zs) + '" y1="' + Y(hs) + '" x2="' + X(zs) + '" y2="' + Y(hs * 1.4 + 0.5) + '" stroke="' + inkC + '"' + sw(2) + '/>');
      g.push('<line x1="' + X(zs) + '" y1="' + Y(-hs) + '" x2="' + X(zs) + '" y2="' + Y(-hs * 1.4 - 0.5) + '" stroke="' + inkC + '"' + sw(2) + '/>');
      g.push(label(X(zs), Y(hs * 1.4 + 0.5), 0, -5, 'middle', '光阑'));
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
    g.push('<line x1="' + X(s.zImg) + '" y1="' + Y(ih) + '" x2="' + X(s.zImg) + '" y2="' + Y(-ih) + '" stroke="' + inkC + '"' + sw(2) + '/>');
    g.push(label(X(s.zImg), Y(ih), -5, -5, 'end', '像面'));

    svg.setAttribute('viewBox', '0 0 ' + PX.toFixed(0) + ' ' + PY.toFixed(0));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.innerHTML = g.join('');
    if (ids.svg === 'layout') layBase(+PX.toFixed(0), +PY.toFixed(0));   // 重绘后保留用户的缩放视窗

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

  /* ================= Layout 缩放 / 平移 / 复制图片 =================
     缩放改的是 viewBox：几何按矢量重新栅格化，镜片轮廓按 40× 下 < 0.3 px 的精度采样（optics.js 的 profile），
     放大后仍是光滑曲线。线宽、虚线节距、「光阑 / 像面」标注按倍率反除（layMarks），始终是屏幕上的
     原始粗细和字号——只改 viewBox 的话 3× 时光线就有 3 px 粗、标注 30 px 高，看着糊。
     状态存成「视窗中心在整图里的比例 + 倍率」，每次重算重绘（换镜头、改参数、窗口变宽）之后
     按比例还原，所以放大着改一个曲率半径，视窗不会跳回整图。倍率 1 就是整图，此时不能平移。 */
  var LAYZ = { W: 0, H: 0, cx: 0.5, cy: 0.5, zoom: 1, drag: null };
  function layBase(W, H) {
    if (W !== LAYZ.W || H !== LAYZ.H) { LAYZ.W = W; LAYZ.H = H; }
    layApply();
  }
  function layApply() {
    var svg = $('layout'); if (!LAYZ.W) return;
    var w = LAYZ.W / LAYZ.zoom, h = LAYZ.H / LAYZ.zoom;
    if (LAYZ.zoom <= 1.0001) { LAYZ.zoom = 1; LAYZ.cx = 0.5; LAYZ.cy = 0.5; w = LAYZ.W; h = LAYZ.H; }
    // 视窗中心夹在整图范围内，放大后不能把图整个拖出视野
    var cx = Math.min(Math.max(LAYZ.cx * LAYZ.W, w / 2), LAYZ.W - w / 2), cy = Math.min(Math.max(LAYZ.cy * LAYZ.H, h / 2), LAYZ.H - h / 2);
    LAYZ.cx = cx / LAYZ.W; LAYZ.cy = cy / LAYZ.H;
    svg.setAttribute('viewBox', (cx - w / 2).toFixed(4) + ' ' + (cy - h / 2).toFixed(4) + ' ' + w.toFixed(4) + ' ' + h.toFixed(4));
    svg.classList.toggle('zoomed', LAYZ.zoom > 1);
    $('layZoomLbl').textContent = LAYZ.zoom.toFixed(1) + '×';
    layMarks(svg, LAYZ.zoom);
  }
  /* 线宽 / 虚线 / 标注换算回屏幕像素：drawLayout 把倍率 1 时的值记在 data-sw / data-da / data-tx·ty 上。
     元素不多（线宽和虚线挂在组上，光线逐条继承），滚轮每一格都重设一遍也只是几十个属性 */
  function layMarks(svg, z) {
    var k = 1 / z, i, el, list;
    list = svg.querySelectorAll('[data-sw]');
    for (i = 0; i < list.length; i++) { el = list[i]; el.setAttribute('stroke-width', +(el.getAttribute('data-sw') * k).toPrecision(6)); }
    list = svg.querySelectorAll('[data-da]');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      el.setAttribute('stroke-dasharray', el.getAttribute('data-da').split(/[\s,]+/).map(function (v) { return +(v * k).toPrecision(6); }).join(' '));
    }
    list = svg.querySelectorAll('[data-tx]');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      el.setAttribute('transform', 'translate(' + el.getAttribute('data-tx') + ' ' + el.getAttribute('data-ty') + ')' + (z === 1 ? '' : ' scale(' + +k.toPrecision(6) + ')'));
    }
  }
  /* 屏幕坐标 → viewBox 坐标（CTM 里已含 meet 的留白偏移，直接用它最准） */
  function layPt(svg, ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var m = svg.getScreenCTM(); if (!m) return null;
    return pt.matrixTransform(m.inverse());
  }
  /* 以 (px,py)（viewBox 坐标）为不动点缩放 f 倍 */
  function layZoomAt(f, px, py) {
    var z0 = LAYZ.zoom, z1 = Math.min(40, Math.max(1, z0 * f));
    if (z1 === z0) return;
    if (px == null) { px = LAYZ.cx * LAYZ.W; py = LAYZ.cy * LAYZ.H; }
    // 不动点：p 在新旧视窗里的相对位置不变 → 新中心 = p − (p − 旧中心)·z0/z1
    var cx = LAYZ.cx * LAYZ.W, cy = LAYZ.cy * LAYZ.H;
    LAYZ.cx = (px - (px - cx) * z0 / z1) / LAYZ.W; LAYZ.cy = (py - (py - cy) * z0 / z1) / LAYZ.H;
    LAYZ.zoom = z1; layApply();
  }
  (function () {
    var svg = $('layout');
    svg.addEventListener('wheel', function (ev) {
      if (!LAYZ.W) return;
      ev.preventDefault();
      var p = layPt(svg, ev); if (!p) return;
      layZoomAt(Math.pow(1.0015, -ev.deltaY), p.x, p.y);   // 每 100 单位约 ×1.16，触控板的细刻度也顺滑
    }, { passive: false });
    svg.addEventListener('pointerdown', function (ev) {
      if (LAYZ.zoom <= 1 || ev.button !== 0) return;
      var p = layPt(svg, ev); if (!p) return;
      LAYZ.drag = { x: p.x, y: p.y, cx: LAYZ.cx, cy: LAYZ.cy };
      svg.setPointerCapture(ev.pointerId); svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', function (ev) {
      var d = LAYZ.drag; if (!d) return;
      var p = layPt(svg, ev); if (!p) return;
      // 拖动时 viewBox 在变，CTM 跟着变；用拖动起点时的中心 + 当前指针差算，避免累积漂移
      LAYZ.cx = d.cx - (p.x - d.x) / LAYZ.W; LAYZ.cy = d.cy - (p.y - d.y) / LAYZ.H;
      layApply();
      var q = layPt(svg, ev); if (q) { d.x = q.x; d.y = q.y; d.cx = LAYZ.cx; d.cy = LAYZ.cy; }
    });
    var end = function (ev) { if (!LAYZ.drag) return; LAYZ.drag = null; svg.classList.remove('dragging'); try { svg.releasePointerCapture(ev.pointerId); } catch (e) {} };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', function () { LAYZ.zoom = 1; layApply(); });
    $('layZoomIn').addEventListener('click', function () { layZoomAt(1.5); });
    $('layZoomOut').addEventListener('click', function () { layZoomAt(1 / 1.5); });
    $('layZoomReset').addEventListener('click', function () { LAYZ.zoom = 1; layApply(); });
  })();

  /* ================= 复制图片（各图卡通用） =================
     按屏幕上的实际排版，把一张卡里的图连同图例、标注逐个元素画进一张 PNG（屏幕尺寸 × scale）：
       · svg → 序列化成图片贴上，按 scale 倍的像素栅格化；Layout 放大时线宽 / 标注已由 layMarks 换算过，
         出图里的粗细字号和屏幕上一样，视窗也就是当前缩放的那一块；
       · canvas（Spot 的光斑格）→ 直接贴；
       · 文字 → canvas fillText，字体取元素算出来的样式（网页已载入的字体 canvas 也能用，图例和屏幕上一模一样）；
       · 有底色 / 边框的元素（图例色块、波长虚线色块、Spot 格子的黑底、对比页状态栏的分隔线）→ 画矩形 / 线。
     根节点只挑图、图例、状态栏，表单控件和按钮不在里面；万一碰到也跳过。
     svg 里的字（坐标刻度、「光阑」标注）不跟着 svg 转位图——<img> 里的 svg 拿不到网页字体，会退回系统字体；
     改为从图上摘掉，再按每个 <text> 在屏幕上的变换矩阵（getScreenCTM，含 viewBox 缩放、旋转、Layout 标注的反缩放）
     用 canvas 原样写回去，字体、字号、描边衬底都和屏幕一致。
     底色用面板色，否则透明底贴到深色软件里看不见。 */
  function snapPng(roots, caption, scale) {
    scale = scale || 2;
    roots = roots.filter(function (el) { return el && el.getClientRects().length; });
    if (!roots.length) return Promise.reject(new Error('卡片里还没有图'));
    var L = 1e9, T = 1e9, R = -1e9, B = -1e9;
    roots.forEach(function (el) {
      var r = el.getBoundingClientRect();
      L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom);
    });
    var pad = 12, capH = caption ? 24 : 0;
    var W = Math.ceil(R - L + 2 * pad), H = Math.ceil(B - T + 2 * pad + capH);
    var ox = L - pad, oy = T - pad - capH;                 // 画布原点对应的页面坐标
    var ops = [], range = document.createRange();
    var alpha = function (c) { var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return c && c !== 'transparent' ? 1 : 0; var p = m[1].split(','); return p.length > 3 ? parseFloat(p[3]) : 1; };
    var norm = function (s) { return s.replace(/\s+/g, ' '); };
    function textOps(node, cs) {
      var s = node.nodeValue, i0 = s.search(/\S/);
      if (i0 < 0) return;
      var i1 = s.length; while (i1 > i0 && /\s/.test(s.charAt(i1 - 1))) i1--;
      var st = { font: cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily,
                 col: cs.color, ls: cs.letterSpacing, up: cs.textTransform === 'uppercase' };
      range.setStart(node, i0); range.setEnd(node, i1);
      var rs = range.getClientRects();
      if (rs.length <= 1) {
        var r0 = rs[0] || range.getBoundingClientRect();
        ops.push({ text: norm(s.slice(i0, i1)), x: r0.left, top: r0.top, h: r0.height, st: st });
        return;
      }
      // 折行的文字：逐字取位置，按行分段各画各的
      var cur = null;
      for (var i = i0; i < i1; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        var cr = range.getClientRects()[0], ch = s.charAt(i);
        if (!cr || !cr.width) continue;
        if (!cur || Math.abs(cr.top - cur.top) > 1) {
          if (/\s/.test(ch)) continue;                   // 行首空白不画，免得整行右移一格
          cur = { text: '', x: cr.left, top: cr.top, h: cr.height, st: st }; ops.push(cur);
        }
        cur.text += ch;
      }
      ops.forEach(function (o) { if (o.st === st) o.text = norm(o.text).replace(/\s+$/, ''); });
    }
    function walk(el) {
      if (el.nodeType !== 1 || !el.getClientRects().length) return;
      var tag = el.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = el.getBoundingClientRect();
      if (tag === 'SVG') {
        var texts = [];
        Array.prototype.forEach.call(el.querySelectorAll('text'), function (t) {
          var tc = getComputedStyle(t), s2 = (t.textContent || '').trim(), m = t.getScreenCTM();
          if (!s2 || !m || !t.getClientRects().length || tc.visibility === 'hidden' || tc.display === 'none') return;
          var xs = t.x && t.x.baseVal, ys = t.y && t.y.baseVal;
          texts.push({ s: s2, m: m, x: xs && xs.numberOfItems ? xs.getItem(0).value : 0, y: ys && ys.numberOfItems ? ys.getItem(0).value : 0,
                       font: tc.fontStyle + ' ' + tc.fontWeight + ' ' + tc.fontSize + ' ' + tc.fontFamily,
                       fill: tc.fill, stroke: tc.stroke, sw: parseFloat(tc.strokeWidth) || 0, halo: /^stroke/.test(tc.paintOrder || ''),
                       a: (parseFloat(tc.opacity) || 1) * (tc.fillOpacity === '' ? 1 : parseFloat(tc.fillOpacity)),
                       anchor: tc.textAnchor === 'middle' ? 'center' : tc.textAnchor === 'end' ? 'right' : 'left' });
        });
        ops.push({ svg: el, r: r, texts: texts });
        return;
      }
      if (tag === 'CANVAS') { ops.push({ canvas: el, r: r }); return; }
      if (alpha(cs.backgroundColor) > 0) ops.push({ fill: cs.backgroundColor, r: r, rad: parseFloat(cs.borderTopLeftRadius) || 0 });
      ['Top', 'Right', 'Bottom', 'Left'].forEach(function (sd) {
        var w = parseFloat(cs['border' + sd + 'Width']), bs = cs['border' + sd + 'Style'], bc = cs['border' + sd + 'Color'];
        if (w > 0 && bs !== 'none' && bs !== 'hidden' && alpha(bc) > 0)
          ops.push({ border: sd, r: r, w: w, col: bc, dash: bs === 'dashed' ? [w * 2, w * 1.4] : bs === 'dotted' ? [w, w] : null });
      });
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) textOps(n, cs); else walk(n);
      }
    }
    roots.forEach(walk);
    // svg 先各自转成图片（异步），再按文档顺序一次画完，前后遮挡关系和屏幕上一致
    var loads = ops.filter(function (o) { return o.svg; }).map(function (o) {
      return new Promise(function (res, rej) {
        var clone = o.svg.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll('text'), function (t) { t.parentNode.removeChild(t); });   // 字由 canvas 写
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', Math.max(1, Math.round(o.r.width * scale)));
        clone.setAttribute('height', Math.max(1, Math.round(o.r.height * scale)));
        var url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); o.img = img; res(); };
        img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('SVG 转位图失败')); };
        img.src = url;
      });
    });
    return Promise.all(loads).then(function () {
      var c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      var ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, W, H);
      var text = function (s, x, top, h, st) {
        ctx.font = st.font; ctx.fillStyle = st.col; ctx.textBaseline = 'alphabetic';
        if ('letterSpacing' in ctx) ctx.letterSpacing = (st.ls && st.ls !== 'normal') ? st.ls : '0px';
        if (st.up) s = s.toUpperCase();
        var m = ctx.measureText(s), a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
        // 行框里文字的基线：内容区（上 + 下伸）在行框里垂直居中，基线在内容区顶 + 上伸处
        var y = (a != null && d != null) ? top + (h - (a + d)) / 2 + a : top + h * 0.78;
        ctx.fillText(s, x, y);
      };
      if (caption) text(caption, pad, pad, 16, { font: '600 12.5px ' + getComputedStyle(document.body).fontFamily, col: css('--ink-2') });
      ops.forEach(function (o) {
        var r = o.r, x = r ? r.left - ox : o.x - ox, y = r ? r.top - oy : o.top - oy;
        if (o.img) {
          ctx.drawImage(o.img, x, y, r.width, r.height);
          o.texts.forEach(function (t) {
            ctx.save();
            ctx.setTransform(scale * t.m.a, scale * t.m.b, scale * t.m.c, scale * t.m.d, scale * (t.m.e - ox), scale * (t.m.f - oy));
            ctx.font = t.font; ctx.textAlign = t.anchor; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = t.a;
            if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
            if (t.halo && t.stroke && t.stroke !== 'none' && t.sw > 0) {
              ctx.lineWidth = t.sw; ctx.strokeStyle = t.stroke; ctx.lineJoin = 'round'; ctx.strokeText(t.s, t.x, t.y);
            }
            if (t.fill && t.fill !== 'none') { ctx.fillStyle = t.fill; ctx.fillText(t.s, t.x, t.y); }
            ctx.restore();
          });
        }
        else if (o.canvas) { try { ctx.drawImage(o.canvas, x, y, r.width, r.height); } catch (e) { } }
        else if (o.fill) {
          ctx.fillStyle = o.fill; ctx.beginPath();
          if (o.rad > 0 && ctx.roundRect) ctx.roundRect(x, y, r.width, r.height, Math.min(o.rad, r.width / 2, r.height / 2)); else ctx.rect(x, y, r.width, r.height);
          ctx.fill();
        } else if (o.border) {
          ctx.strokeStyle = o.col; ctx.lineWidth = o.w; ctx.setLineDash(o.dash || []); ctx.beginPath();
          var h2 = o.w / 2;
          if (o.border === 'Top') { ctx.moveTo(x, y + h2); ctx.lineTo(x + r.width, y + h2); }
          else if (o.border === 'Bottom') { ctx.moveTo(x, y + r.height - h2); ctx.lineTo(x + r.width, y + r.height - h2); }
          else if (o.border === 'Left') { ctx.moveTo(x + h2, y); ctx.lineTo(x + h2, y + r.height); }
          else { ctx.moveTo(x + r.width - h2, y); ctx.lineTo(x + r.width - h2, y + r.height); }
          ctx.stroke(); ctx.setLineDash([]);
        } else if (o.text) text(o.text, x, y, o.h, o.st);
      });
      return new Promise(function (res, rej) {
        c.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob 失败')); }, 'image/png');
      });
    });
  }
  function flashBtn(btn, text, ok) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text; btn.classList.toggle('ok', !!ok);
    clearTimeout(btn._ft);
    btn._ft = setTimeout(function () { btn.textContent = old; btn.classList.remove('ok'); }, 1800);
  }
  /* 当前镜头的一行说明，写在图的左上角：换着镜头连续复制几张，贴出去也分得清哪张是哪颗 */
  function lensCaption() {
    var e = state.libId ? idxEntry(state.libId) : null;
    var nm = e ? (e.brand ? e.brand + ' ' : '') + e.name + (e.origin ? '（' + e.origin + '）' : '')
      : (state.imp && IMPREC ? (IMPREC.name || IMPREC.title || '导入的镜头') : '自定义处方');
    var c = state.cfgs && state.cfgs[state.cfg];
    return nm + (c ? ' · Z' + (state.cfg + 1) + ' ' + c.title : '');
  }
  function cmpCaption(k) {
    var C = CMP[k], L = C.L, c = L && L.cfgs && L.cfgs[C.cfg];
    return k + ' · ' + (C.brand ? C.brand + ' ' : '') + (C.name || '') + (C.entry && C.entry.origin ? '（' + C.entry.origin + '）' : '')
      + (c ? ' · Z' + (C.cfg + 1) + ' ' + c.title : '');
  }
  /* 各卡片出图用哪几块、左上角写什么；ready() 为假时按钮只提示「还没有图」 */
  var COPYSPEC = {
    layout: { ids: ['layout', 'layoutLegend'], title: '2D Layout', main: true, ready: function () { return !!$('layout').innerHTML; } },
    mtf: { ids: ['mtf', 'mtfLegend'], title: 'MTF vs 视场', main: true, ready: function () { return !!$('mtf').innerHTML; } },
    aber: { ids: ['aber', 'aberLegend'], title: '球差 · 场曲/像散 · 畸变', main: true, ready: function () { return !!$('aber').innerHTML; } },
    fan: { ids: ['fan', 'fanLegend'], title: '光线扇形', main: true, ready: function () { return !!$('fan').innerHTML; } },
    spot: { ids: ['spotGrid', 'spotLegend'], title: 'Spot', main: true, ready: function () { return SPOT.hasImg; } },
    cmpA: { ids: ['cmpLayA', 'cmpLayLegendA', 'cmpStatA'], cap: function () { return cmpCaption('A'); }, ready: function () { return !!CMP.A.res; } },
    cmpB: { ids: ['cmpLayB', 'cmpLayLegendB', 'cmpStatB'], cap: function () { return cmpCaption('B'); }, ready: function () { return !!CMP.B.res; } },
    cmpMtf: { ids: ['cmpMtf', 'cmpLegend'], cap: function () { return '双镜头对比 · MTF vs 视场'; }, ready: function () { return !!(CMP.A.res || CMP.B.res); } }
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.getAttribute('data-copy'), sp = COPYSPEC[k];
      if (!sp) return;
      if (!sp.ready()) { flashBtn(btn, '还没有图'); return; }
      var cap = sp.cap ? sp.cap() : sp.title + ' · ' + lensCaption();
      var blobP = snapPng(sp.ids.map(function (id) { return $(id); }), cap, 2);
      var note = function (m) { if (sp.main && !CMP.on) { PENDMSG.push(m); schedule(0); } };   // 提示要靠一次重算才刷出来；对比页上没有提示框
      // ClipboardItem 接受 Promise<Blob>：write 必须在用户手势里同步调用，位图可以晚点到
      var done = function () { flashBtn(btn, '已复制 ✓', true); };
      var fallback = function (why) {
        blobP.then(function (b) {
          var a = document.createElement('a'); a.href = URL.createObjectURL(b);
          a.download = k + '-' + ((sp.main ? state.libId : (CMP[k.slice(-1)] || CMP.A).id) || 'lens') + '.png'; a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
          flashBtn(btn, '已下载 PNG', true);
          note('复制图片：剪贴板不可用（' + why + '），已改为下载 PNG。');
        }, function (e) { flashBtn(btn, '失败'); note('复制图片失败：' + e.message); });
      };
      if (navigator.clipboard && window.ClipboardItem) {
        var item;
        try { item = new ClipboardItem({ 'image/png': blobP }); }
        catch (e) { fallback(e.message); return; }
        navigator.clipboard.write([item]).then(done, function (e) { fallback(e && e.message ? e.message : '写入被拒绝'); });
      } else fallback('浏览器不支持 ClipboardItem，或页面不在安全上下文');
    });
  });

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
  /* 每次重算都把状态写进地址栏的 #…，刷新或把链接发给别人都能还原。
     以前（v1）只存处方文本和几个控件，刷新后镜头库那一层全丢——是哪颗镜头、多重结构、渐晕系数
     （文件自带的和按通光预算的）、各面通光、物距——瞳按「不渐晕」算，边缘光线穿出镜片、MTF 虚高，
     镜头下拉也是空的。v2 存「哪颗镜头 + 哪个结构 + 相对库里原样的改动」，恢复时先按 id 整颗载入再盖改动：
       · tx 只在和库里原样（套上当前结构）不同时才存，没改过的镜头链接很短；
       · sig 是库里这颗镜头面数据的指纹：镜头库更新过（比如重新录入）就不再拿旧处方盖新数据；
       · sdDraw / sdAp 只在和库里不同（插删过面）时存；cd = 其它结构的厚度 / 曲率 / 物距改动，
         vgz = 各结构的渐晕选择（0 = 换回了文件系数，对象 = 自己按「一键渐晕」算的），都只存和原样不同的；
       · 导入的文件不在库里：整条记录放 sessionStorage（同一标签页刷新能完整还原），链接带 imp + 导入记录的指纹 isig，
         差量逻辑和库里的镜头一样；指纹对不上（标签页后来又导入了别的文件）就不嫁接；
       · 旧版链接（没有 v）：单文件版按「逐面曲率 + 玻璃一致」在库里认回是哪颗、哪个结构，认不出只还原处方。 */
  var IMPKEY = 'lensbench.import';
  // 改过名的镜头：旧链接里的旧 id → 现在的 id（数据相同，只是当初起错了名）
  var IDALIAS = { 'sigma-500mm-f5-6-dg-dn-os-sports': 'sigma-500mm-f4-dg-os-hsm-sports' };
  var IMPREC = null;                            // 当前导入文件的原样记录（和 sessionStorage 里那份一致）
  /* 链接里的控件分两类：
     LENSCTL 随镜头走（applyLens / applyCfg 会设），只在和「这颗镜头 + 当前结构」的默认值不同时才存——
       库里数据更新了，没动过的控件自然跟着新数据走，旧值不会压上来；
     VIEWCTL 是页面设置，和镜头无关，照存。 */
  var LENSCTL = ['apmode', 'aim', 'fmode', 'fno', 'fov', 'freqs', 'objd', 'stop', 'defoc', 'wlRaw', 'pri'];
  var VIEWCTL = ['mtfmode', 'colorby', 'ngrid', 'nfield', 'nviz', 'nfviz'];
  function fnv(t) { var h = 0x811c9dc5; for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function libSig(L) {
    return fnv(L.tx + '|' + JSON.stringify((L.cfgs || []).map(function (c) { return [c.thi, c.rdy, c.obj]; })));
  }
  function libRec(id) { return id ? (LENSCACHE[id] || LENSDB.inline[id] || null) : null; }
  function curRec() { return state.libId ? libRec(state.libId) : (state.imp ? IMPREC : null); }
  function cfgRows(L, ci) {                     // 原样处方套上第 ci 个结构（和 applyLens + applyCfg 一致）
    var rows = textToRows(L.tx), c = L.cfgs && L.cfgs[ci];
    if (c) {
      Object.keys(c.thi || {}).forEach(function (k) { if (rows[k]) rows[k].T = String(c.thi[k]); });
      Object.keys(c.rdy || {}).forEach(function (k) { if (rows[k]) rows[k].R = (c.rdy[k] === 0 ? 'inf' : String(c.rdy[k])); });
    }
    return rows;
  }
  function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  /* 这颗镜头套上第 ci 个结构时，applyLens + applyCfg 会给出的控件值（和 readState 的口径一致） */
  function lensDefaults(L, ci) {
    var c = L.cfgs && L.cfgs[ci], nr = textToRows(L.tx).length, D = {};
    D.apmode = L.apmode || 'fno'; D.aim = !!L.aim; D.fmode = L.fmode || 'angle';
    D.fno = (c && c.fno != null) ? +c.fno : +L.fno;
    D.fov = +L.fov;
    D.freqs = parseList(L.freqs || '10, 30, 80', [10, 30, 80]).filter(function (v) { return v > 0; }).slice(0, 4);
    D.objd = c ? (c.obj == null ? Infinity : c.obj) : (L.objd != null ? L.objd : Infinity);
    D.stop = Math.min(Math.max((L.stop || 1) - 1, 0), nr - 1) + 1;
    D.defoc = 0;
    if (L.wl && L.wl.length) {
      D.wlRaw = L.wl.map(function (x) { return { nm: String(x[0]), w: String(x[1]), c: wlColor(x[0]) }; });
      D.pri = Math.min(L.pri || 0, D.wlRaw.length - 1);
    }
    return D;
  }
  function ctlSame(k, a, b) {
    if (b === undefined) return false;                          // 镜头没给这项默认值：照存
    if (k === 'objd') return (!isFinite(a) && !isFinite(b)) || Math.abs(a - b) < 1e-9;
    if (typeof b === 'number') return Math.abs(+a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    return same(a, b);
  }
  function hashState(st) {
    var o = { v: 2 };
    VIEWCTL.forEach(function (k) { o[k] = st[k]; });
    var L = curRec();
    if (!L) { LENSCTL.forEach(function (k) { o[k] = st[k]; }); o.tx = st.tx; return o; }
    if (state.libId) { o.id = state.libId; o.sig = libSig(L); }
    else { o.imp = 1; o.isig = libSig(L); }
    o.cfg = state.cfg;
    if (state.cfgs && state.cfgs[state.cfg]) o.ct = state.cfgs[state.cfg].title;   // 库更新后核对结构用
    // 导入的文件：链接发到别处（或这个标签页又导入了别的文件）时拿不到原始记录，只能靠链接自己——
    // 所以处方和镜头控件照全量存；库里的镜头随时能按 id 取回原样，只存差量。
    var D = state.libId ? lensDefaults(L, state.cfg) : {};
    LENSCTL.forEach(function (k) { if (!ctlSame(k, st[k], D[k])) o[k] = st[k]; });
    if (!state.libId || st.tx !== rowsToText(cfgRows(L, state.cfg))) o.tx = st.tx;
    if (!same(state.sdDraw, L.sdDraw)) o.sdDraw = state.sdDraw;
    if (!same(state.sdAp, L.sdAp)) o.sdAp = state.sdAp;
    // 其它结构的改动（厚度 / 曲率格子、物距、最佳对焦都会写回各自的结构）：只存和原样不同的项
    var cd = {}, nd = 0;
    (state.cfgs || []).forEach(function (c, ci) {
      var c0 = L.cfgs && L.cfgs[ci]; if (!c0) return;
      var moved = ['thi', 'rdy'].some(function (f) {
        return Object.keys(c[f] || {}).sort().join() !== Object.keys(c0[f] || {}).sort().join();
      });
      if (moved) {                                               // 插删过面：面号整体挪了，按差量存对不上，整份存
        cd[ci] = { full: 1, thi: c.thi || {}, rdy: c.rdy || {}, obj: c.obj }; nd++; return;
      }
      if (ci === state.cfg) return;                              // 当前结构的值由 tx + 物距表示
      var d = {};
      ['thi', 'rdy'].forEach(function (f) {
        Object.keys(c[f] || {}).forEach(function (k) {
          if (!ctlSame('x', +c[f][k], c0[f] && c0[f][k] != null ? +c0[f][k] : undefined)) (d[f] = d[f] || {})[k] = c[f][k];
        });
      });
      if (!ctlSame('objd', c.obj == null ? Infinity : c.obj, c0.obj == null ? Infinity : c0.obj)) d.obj = c.obj;
      if (Object.keys(d).length) { cd[ci] = d; nd++; }
    });
    if (nd) o.cd = cd;
    // 各结构的渐晕：0 = 换回了文件系数，对象 = 自己按「一键渐晕」算的，不存 = 用原样的
    var vz = {}, nv = 0, n = Math.max((state.cfgs || []).length, 1);
    for (var ci = 0; ci < n; ci++) {
      var va = state.vigAuto && state.vigAuto[ci], vl = L.vigAuto && L.vigAuto[ci];
      if (!same(va, vl)) { vz[ci] = va || 0; nv++; }
    }
    if (nv) o.vgz = vz;
    return o;
  }
  function applyCtl(o, keys) {
    keys.forEach(function (k) {
      if (!(k in o) || o[k] === undefined) return;
      var v = o[k];
      if (k === 'aim') $('aim').checked = !!v;
      else if (k === 'objd') $('objd').value = fmtObjDist(v == null ? Infinity : v);   // JSON 里 Infinity 是 null
      else if (k === 'freqs') { if (v && v.length) $('freqs').value = v.join(', '); }
      else if (k === 'wlRaw') { if (v && v.length) { state.wl = v; state.pri = Math.min(state.pri, v.length - 1); } }
      else if (k === 'pri') state.pri = Math.min(+v || 0, state.wl.length - 1);
      else if (k === 'stop') { if (v) { state.stop = Math.min(Math.max(v - 1, 0), state.rows.length - 1); state.sel = state.stop; } }
      else if (v !== null) $(k).value = v;
    });
  }
  /* 已经整颗载入（库里的，或 sessionStorage 里的导入记录）之后，把链接里的改动盖上去。
     fresh = 链接生成时的数据和现在这份一致；不一致（镜头库更新过）时只套用和几何无关的东西。 */
  function overlayHash(o, L) {
    var fresh = !o.sig || o.sig === libSig(L);
    if (!fresh) PENDMSG.push('镜头库里这颗镜头的数据更新过，已按新数据载入；链接里对处方、光阑面、各结构和渐晕的改动是在旧数据上做的，没有带过来（F/#、视场、物距、波长等设置保留）。');
    if (fresh && o.cd && state.cfgs) Object.keys(o.cd).forEach(function (ci) {
      var c = state.cfgs[ci], d = o.cd[ci]; if (!c) return;
      if (d.full) { c.thi = {}; c.rdy = {}; }
      ['thi', 'rdy'].forEach(function (f) { Object.keys(d[f] || {}).forEach(function (k) { (c[f] = c[f] || {})[k] = d[f][k]; }); });
      if ('obj' in d) c.obj = d.obj == null ? Infinity : d.obj;
    });
    if (fresh && o.vgz) Object.keys(o.vgz).forEach(function (ci) {
      var v = o.vgz[ci];
      if (v === 0) { if (state.vigAuto) delete state.vigAuto[ci]; }
      else if (v && typeof v === 'object') (state.vigAuto = state.vigAuto || {})[ci] = v;
    });
    if (fresh && o.vga !== undefined) {                      // 今天早些时候的 v2 链接只存当前结构的 vga
      var ci0 = o.cfg || 0;
      if (o.vga === 0) { if (state.vigAuto) delete state.vigAuto[ci0]; }
      else if (o.vga && typeof o.vga === 'object') (state.vigAuto = state.vigAuto || {})[ci0] = o.vga;
    }
    var n = state.cfgs ? state.cfgs.length : 0;
    var cfgOk = o.cfg > 0 && o.cfg < n && (fresh || (o.ct != null && state.cfgs[o.cfg].title === o.ct));
    if (cfgOk) { state.cfg = o.cfg; applyCfg(o.cfg); }
    if (fresh && o.tx) { var rows = textToRows(o.tx); if (rows.length >= 2) state.rows = rows; }
    if (fresh && o.sdDraw !== undefined) state.sdDraw = o.sdDraw;
    if (fresh && o.sdAp !== undefined) state.sdAp = o.sdAp;
    applyCtl(o, VIEWCTL.concat(LENSCTL.filter(function (k) { return fresh || k !== 'stop'; })));
    // 当前结构的覆盖项跟着处方和物距同步（改过物距 / 对焦群 / 结构色格子的都在 tx 里），切走再切回不会丢
    var c = state.cfgs && state.cfgs[state.cfg];
    if (c) {
      Object.keys(c.thi || {}).forEach(function (k) { var v = parseFloat(state.rows[k] && state.rows[k].T); if (isFinite(v)) c.thi[k] = v; });
      Object.keys(c.rdy || {}).forEach(function (k) { var v = parseFloat(state.rows[k] && state.rows[k].R); if (isFinite(v)) c.rdy[k] = v; });
      c.obj = parseObjDist($('objd').value);
    }
    syncApMode(); syncFMode(); renderCfg(); renderLDE(); renderWL();
  }
  /* 只有处方文本可用（旧链接认不出 / 导入的链接换了浏览器）：照旧只还原处方和控件 */
  function restoreTxOnly(o) {
    if (!o.tx) return false;
    state.libId = null; state.imp = false; IMPREC = null; CURORIGIN = null; LENSMSG = [];
    state.rows = textToRows(o.tx);
    state.cfgs = null; state.cfgs0 = null; state.T0 = null; state.cfg = 0; state.vigAuto = null; state.vigH = null;
    state.sdDraw = o.sdDraw || null; state.sdAp = o.sdAp || null;
    state.stop = 0; state.sel = 0;
    applyCtl(o, VIEWCTL.concat(LENSCTL));
    $('ex').selectedIndex = -1;
    syncApMode(); syncFMode(); renderCfg(); renderLDE(); renderWL();
    histBase();
    return true;
  }
  /* 玻璃按「解析出来是哪一种」比，不按字面：重新录入后 J-LASF016 可能写成 JLASF016_HIKARI */
  function matKey(m) {
    var t = String(m || '').trim(), u = t.toUpperCase();
    if (!t || u === '-' || u === 'AIR') return '';
    var g = OPT.parseMaterial(t);
    return g && g.glass ? g.glass + '@' + (g.cat || '') : u;
  }
  function sameNum(a, b) {
    var x = parseFloat(a), y = parseFloat(b);
    if (!isFinite(x) || !isFinite(y)) return !isFinite(x) && !isFinite(y);    // inf / 空 都算平面
    return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
  }
  /* 旧链接认镜头：曲率和玻璃逐面一致（对焦只动厚度，曲率 + 玻璃足以唯一确定是哪颗），
     结构取厚度总偏差最小的那个；exact = 厚度也逐面一致（链接里没有改动，或数据没变过）。
     只在单文件版做——静态站的镜头要一颗颗下载，不值得。 */
  function matchLegacy(tx) {
    var want = textToRows(tx), best = null;
    if (want.length < 2) return null;
    var wk = want.map(function (r) { return matKey(r.mat); });
    LENSDB.index.forEach(function (e) {
      var L = LENSDB.inline[e.id];
      if (!L || !L.tx || textToRows(L.tx).length !== want.length) return;
      var nc = (L.cfgs && L.cfgs.length) || 1;
      for (var ci = 0; ci < nc; ci++) {
        var rows = cfgRows(L, ci), ok = true, dT = 0;
        for (var i = 0; i < rows.length && ok; i++) {
          if (!sameNum(rows[i].R, want[i].R) || matKey(rows[i].mat) !== wk[i]) ok = false;
          else dT += Math.abs((parseFloat(rows[i].T) || 0) - (parseFloat(want[i].T) || 0));
        }
        if (ok && (!best || dT < best.dT)) best = { id: e.id, cfg: ci, dT: dT };
      }
    });
    if (best) best.exact = best.dT < 1e-6;
    return best;
  }
  /* 启动时从链接恢复。返回 true = 已接手（包括异步载入中），false = 链接里没东西，走默认镜头 */
  function restoreHash(o) {
    if (!o) return false;
    if (!o.v && o.tx) {                                       // 旧版链接：认回是哪颗
      var m = matchLegacy(o.tx);
      if (!m) return restoreTxOnly(o);
      if (!m.exact) PENDMSG.push('旧版链接：已按镜头库重新载入这颗镜头（结构 Z' + (m.cfg + 1) + '）。链接里的处方和现在的库不完全一致（改过的厚度，或库里的数据后来更新过），这些差别没有套用。');
      // 旧链接的控件照旧套用；处方不盖（exact 时本来就一样）
      var o2 = { v: 2, id: m.id, cfg: m.cfg, sig: libSig(LENSDB.inline[m.id]) };
      VIEWCTL.concat(LENSCTL).forEach(function (k) { if (k in o) o2[k] = o[k]; });
      o = o2;
    }
    if (o.v === 2 && o.id) {
      if (!idxEntry(o.id) && IDALIAS[o.id]) o = Object.assign({}, o, { id: IDALIAS[o.id] });
      if (!idxEntry(o.id)) {
        if (o.tx) { PENDMSG.push('链接里的镜头「' + o.id + '」镜头库里已经没有了，只还原了处方。'); return restoreTxOnly(o); }
        PENDMSG.push('链接里的镜头「' + o.id + '」镜头库里已经没有了，链接里也没有处方可还原，已改为显示默认镜头。');
        return false;
      }
      syncLensSelects(o.id);
      loadLens(o.id, function (err, L) {
        if (err) return;
        histBase();                          // 撤销 / 恢复初始的起点 = 库里原样；盖上的改动是第一步
        overlayHash(o, L);
        schedule(0);
      });
      return true;
    }
    if (o.v === 2 && o.imp) {
      var rec = null;
      try { rec = JSON.parse(sessionStorage.getItem(IMPKEY)); } catch (e) { rec = null; }
      if (rec && rec.tx && o.isig && libSig(rec) === o.isig) {
        CURORIGIN = null; $('ex').selectedIndex = -1;
        state.libId = null; state.imp = true; IMPREC = rec;
        applyLens(rec);
        histBase();
        overlayHash(Object.assign({}, o, { sig: o.isig }), rec);
        schedule(0);
        return true;
      }
      PENDMSG.push(rec && rec.tx
        ? '这是另一个导入文件的链接（这个标签页后来又导入过别的文件），多重结构、渐晕、通光没法还原，只还原了处方。要完整数据请重新导入那个文件。'
        : '这是导入文件的链接：多重结构、渐晕系数、通光孔径没法随链接带过来，只还原了处方。要完整数据请重新导入那个文件。');
      return restoreTxOnly(o);
    }
    return o.tx ? restoreTxOnly(o) : false;
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
    if (t.dataset.obj) { setObjd(t.value, t); schedule(180); return; }
    var r = state.rows[+t.dataset.r]; if (!r) return;
    var fld = t.dataset.f;
    glassListSync(t, false);
    if (fld.charAt(0) === 'a' && /^a\d+$/.test(fld)) setAsphTerm(r, +fld.slice(1), t.value);
    else { r[fld] = t.value; cfgWriteBack(+t.dataset.r, fld, t.value); }
    var tc = tb.querySelector('[data-typ="' + t.dataset.r + '"]');
    if (tc) tc.textContent = isAsph(r) ? '非球面' : '球面';
    schedule(240);
  });
  tb.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.tagName !== 'INPUT' || t.dataset.f !== 'mat') return;
    // 单个可打印字符（不带 Ctrl/Alt）：字符落进去之前先把候选列表挂上
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) glassListSync(t, true);
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
    if (!inp || inp.tagName !== 'INPUT' || inp.dataset.obj) return;
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

  /* 插删面后，多重结构里按面号存的厚度 / 曲率跟着挪，否则切结构会把值写进错的行。
     cfgs0 / T0 故意不动：它们是文件原样，插删过面以后「最佳对焦」本来就不再认对焦凸轮。 */
  function shiftCfgKeys(i, delta) {
    (state.cfgs || []).forEach(function (c) {
      ['thi', 'rdy'].forEach(function (f) {
        if (!c[f]) return;
        var o = {};
        Object.keys(c[f]).forEach(function (k) {
          var n = +k, m = delta > 0 ? (n >= i ? n + 1 : n) : (n === i ? -1 : (n > i ? n - 1 : n));
          if (m >= 0) o[m] = c[f][k];
        });
        c[f] = o;
      });
    });
  }
  $('insBtn').addEventListener('click', function () {
    var i = Math.min(state.sel + 1, state.rows.length);
    state.rows.splice(i, 0, blankRow());
    shiftCfgKeys(i, +1);
    [state.sdDraw, state.sdAp].forEach(function (a) { if (a) a.splice(i, 0, null); });
    if (state.stop >= i) state.stop++;
    state.sel = i; renderLDE(); schedule(0);
  });
  $('delBtn').addEventListener('click', function () {
    if (state.rows.length <= 2) return;
    var i = Math.min(state.sel, state.rows.length - 1);
    state.rows.splice(i, 1);
    shiftCfgKeys(i, -1);
    [state.sdDraw, state.sdAp].forEach(function (a) { if (a) a.splice(i, 1); });
    if (state.stop > i) state.stop--;
    state.stop = Math.min(state.stop, state.rows.length - 1);
    state.sel = Math.max(0, Math.min(i, state.rows.length - 1));
    renderLDE(); schedule(0);
  });
  $('stopBtn').addEventListener('click', function () { state.stop = state.sel; renderLDE(); schedule(0); });

  ['fno', 'fov', 'defoc', 'freqs', 'objd'].forEach(function (id) { $(id).addEventListener('input', function () { schedule(180); }); });
  $('objd').addEventListener('input', function () { setObjd(this.value, this); });
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
      state.libId = null; state.imp = true; IMPREC = JSON.parse(JSON.stringify(L));   // 原样快照，applyLens 之后的改动不影响它
      try { sessionStorage.setItem(IMPKEY, JSON.stringify(L)); } catch (err) { }   // 同一标签页刷新时整条还原
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
    state.cfgs0 = state.cfgs ? JSON.parse(JSON.stringify(state.cfgs)) : null;
    state.T0 = state.rows.map(function (r) { return parseFloat(r.T) || 0; });
    state.cfg = 0;
    if (state.cfgs) applyCfg(0);
    renderCfg();
    syncApMode(); syncFMode(); renderLDE(); renderWL();
    originBadge($('originBadge'), CURORIGIN);
    lensNotes(e);
  }
  /* 提示框只放「需要处理的事」。镜头记录自带的说明（数据来源、厚度解、渐晕预算…）不再倒进来——
     那是每颗镜头常驻的一大段，用户要看的是表和信息卡；来源说明留在表头「专利 / 逆向」徽标的悬停提示里。
     现场导入的文件例外：解析警告（CIR 覆盖率、数字式玻璃、单位…）就是导入时该看的。 */
  function lensNotes(e) {
    var w = CURORIGIN ? [] : (e.warn || []).slice();
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
    LENSMSG = w;
  }
  var LENSMSG = [], PENDMSG = [];

  /* ================= 最佳对焦 =================
     多重结构里带着镜头自己的对焦方式：同一个焦段、不同物距的几个结构，差别只在对焦群两侧的间隔上。
     把这几个结构按 u = 1/物距 排好，各间隔对 u 分段线性插值，就是一条「对焦凸轮」——
     浮动对焦（几组各走各的）自动包含在内，每个结构总长守恒、插值出来的也守恒。
     「最佳对焦」沿这条凸轮搜 u，使当前物距下轴上 RMS 最小，像面不动（传感器是固定的）。
     判据用轴上而不是多视场平均：相机对焦就是对中心；多视场平均在场曲大的广角上会被拉走
     （FE 12-24 GM 广角端 0.06x：三视场判据离厂商结构差 673 µm，轴上判据 78 µm）。
     校验：从 INF 结构出发、物距改成别的结构的物距，搜出的厚度和那个结构的差
     适马 105 Macro 2.6 µm（0.06x）/ 1.4 µm（1:1）、索尼 12-24 长焦端 12 µm。

     认对焦群：取离当前结构最近（差的面最少）的「物距不同」的结构，它们相差的那几个间隔就是对焦群；
     凡是只在这些间隔上和当前结构不同的结构都进凸轮。这样变焦镜头的其他焦段不会混进来
     （变焦间隔也在变）。同一物距出现两组不同厚度、或对焦时曲率也在变，就认不出，退回移动像面。 */
  function focusCam(cfgs, T0, cur) {
    if (!cfgs || cfgs.length < 2 || !cfgs[cur]) return null;
    var tOf = function (c, k) { return (c.thi && c.thi[k] != null) ? +c.thi[k] : +T0[k]; };
    var uOf = function (c) { var D = c.obj; return (D == null || !isFinite(D) || D <= 0 || D >= 1e7) ? 0 : 1 / D; };
    var keysT = {}, keysR = {};
    cfgs.forEach(function (c) {
      Object.keys(c.thi || {}).forEach(function (k) { keysT[k] = 1; });
      Object.keys(c.rdy || {}).forEach(function (k) { keysR[k] = 1; });
    });
    var diff = function (a, b) {
      var d = [];
      Object.keys(keysT).forEach(function (k) { if (Math.abs(tOf(a, k) - tOf(b, k)) > 1e-9) d.push('T' + k); });
      Object.keys(keysR).forEach(function (k) {
        var ra = (a.rdy || {})[k], rb = (b.rdy || {})[k];
        if ((ra == null) !== (rb == null) || Math.abs((ra || 0) - (rb || 0)) > 1e-9) d.push('R' + k);
      });
      return d;
    };
    var c0 = cfgs[cur], u0 = uOf(c0), near = null;
    cfgs.forEach(function (c, i) {
      if (i === cur || Math.abs(uOf(c) - u0) < 1e-12) return;
      var d = diff(c0, c);
      if (!near || d.length < near.d.length) near = { d: d };
    });
    if (!near || !near.d.length) return { why: '没有物距不同、间隔也不同的结构' };
    if (near.d.some(function (x) { return x[0] === 'R'; })) return { why: '对焦时曲率也在变，不是纯移动镜组' };
    var F = {}; near.d.forEach(function (x) { F[x] = 1; });
    var nodes = [];
    cfgs.forEach(function (c, i) { if (diff(c0, c).every(function (x) { return F[x]; })) nodes.push({ i: i, u: uOf(c) }); });
    nodes.sort(function (a, b) { return a.u - b.u; });
    var ks = near.d.map(function (x) { return +x.slice(1); }).sort(function (a, b) { return a - b; });
    for (var n = 1; n < nodes.length; n++) {
      if (Math.abs(nodes[n].u - nodes[n - 1].u) < 1e-12) {
        var same = ks.every(function (k) { return Math.abs(tOf(cfgs[nodes[n].i], k) - tOf(cfgs[nodes[n - 1].i], k)) < 1e-9; });
        if (!same) return { why: '同一物距下有几组不同的间隔（混进了变焦），认不出单一的对焦凸轮' };
        nodes.splice(n, 1); n--;
      }
    }
    if (nodes.length < 2) return { why: '对焦结构不足 2 个' };
    return { surf: ks, u: nodes.map(function (q) { return q.u; }), idx: nodes.map(function (q) { return q.i; }),
             t: nodes.map(function (q) { return ks.map(function (k) { return tOf(cfgs[q.i], k); }); }) };
  }
  function camAt(cam, u) {
    var U = cam.u, n = U.length, j = 0;
    if (u >= U[n - 1]) j = n - 2; else if (u > U[0]) { while (j < n - 2 && u > U[j + 1]) j++; }
    var f = (u - U[j]) / (U[j + 1] - U[j]);
    return cam.surf.map(function (_, q) { return cam.t[j][q] + f * (cam.t[j + 1][q] - cam.t[j][q]); });
  }
  function fmtT(v) { return String(+v.toFixed(6)); }
  function camFocus(cam) {
    var sur0 = last.surfaces;
    var base = Object.assign({}, last.opt, { nGrid: 12, freqs: [], nRayViz: 3, nFieldViz: 1, fieldsMTF: [0], nField: 1, mtfMode: 'geo' });
    var rmsAt = function (sur) {
      var s = OPT.buildSystem(sur, base); s.vig = last.sys.vig;
      var row = OPT.mtfVsField(s, base).rows[0];
      return (row && isFinite(row.rms) && row.rms > 0) ? row.rms : Infinity;
    };
    var cost = function (u) {
      var tv = camAt(cam, u);
      return rmsAt(sur0.map(function (sf, k) { var q = cam.surf.indexOf(k); return q < 0 ? sf : Object.assign({}, sf, { T: tv[q] }); }));
    };
    var r0 = rmsAt(sur0);
    var U = cam.u, span = U[U.length - 1] - U[0];
    var D = last.opt.objDist, uT = (isFinite(D) && D > 0) ? 1 / D : 0;
    var lo = Math.min(U[0], uT) - 0.1 * span, hi = Math.max(U[U.length - 1], uT) + 0.1 * span;
    var best = uT, bv = Infinity, i, c;
    for (i = 0; i <= 16; i++) { var u = lo + (hi - lo) * i / 16; c = cost(u); if (c < bv) { bv = c; best = u; } }
    // 黄金分割精修，括号收到对焦群厚度变化 < 0.2 µm
    var a = best - (hi - lo) / 16, b = best + (hi - lo) / 16, g = (Math.sqrt(5) - 1) / 2;
    var dTdu = 0;
    cam.surf.forEach(function (_, q) { dTdu = Math.max(dTdu, Math.abs(cam.t[cam.t.length - 1][q] - cam.t[0][q]) / span); });
    var x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = cost(x1), f2 = cost(x2), it = 0;
    while ((b - a) * dTdu > 2e-4 && it++ < 60) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = cost(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = cost(x2); }
    }
    var uB = f1 <= f2 ? x1 : x2, rB = Math.min(f1, f2);
    if (bv < rB) { uB = best; rB = bv; }
    if (!isFinite(rB)) return false;
    var tv = camAt(cam, uB), cfg = state.cfgs[state.cfg];
    cam.surf.forEach(function (k, q) {
      state.rows[k].T = fmtT(tv[q]);
      if (cfg && cfg.thi) cfg.thi[k] = +tv[q].toFixed(6);
    });
    var out = uB < U[0] - 0.05 * span || uB > U[U.length - 1] + 0.05 * span;
    PENDMSG.push('最佳对焦：沿镜头自带的对焦群（结构 ' + cam.idx.map(function (q) { return 'Z' + (q + 1); }).join(' / ') +
      ' 的间隔插值，移动 ' + cam.surf.map(function (k) { return 'S' + (k + 1); }).join(' / ') + '）对到 ' +
      (isFinite(D) && D > 0 ? D.toLocaleString('en-US') + ' mm' : '无限远') + '，轴上 RMS ' +
      (isFinite(r0) ? r0.toFixed(2) : '—') + ' → ' + rB.toFixed(2) + ' µm，像面不动。' +
      (out ? '⚠ 这个物距已经超出文件给出的对焦行程，间隔是外推出来的，实际镜头可能对不到。' : ''));
    renderLDE();
    return true;
  }
  function planeFocus(why) {
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
    PENDMSG.push('最佳对焦：' + (why ? '认不出对焦群（' + why + '）' : '这颗镜头没有多重结构，不知道哪组是对焦群') +
      '，改为移动像面（三视场平均 RMS 最小），离焦 = ' + (+best.toFixed(4)) + ' mm。');
  }
  $('focusBtn').addEventListener('click', function () {
    if (!last) return;
    var btn = this, label = btn.textContent;
    btn.textContent = '搜索中…'; btn.disabled = true;
    setTimeout(function () {
      try {
        // 插删过面，下标对不上文件原样的结构，凸轮不可用
        var cam = (state.T0 && state.T0.length === state.rows.length && last.surfaces.length === state.rows.length)
          ? focusCam(state.cfgs0, state.T0, state.cfg) : null;
        var done = cam && !cam.why && camFocus(cam);
        if (!done) planeFocus(cam && cam.why ? cam.why : (state.cfgs0 && state.cfgs0.length > 1 ? '插删过面，和文件的结构对不上' : null));
      } finally {
        btn.textContent = label; btn.disabled = false;
        schedule(0);
      }
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
        var lsrc = (v.lims && v.lims.length) ? v.lims : v.lim;
        for (i = 0; i < lsrc.length; i++) if (lsrc[i] >= 0) { cnt[lsrc[i]] = (cnt[lsrc[i]] || 0) + 1; nl++; }
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

  /* ================= Spot · 虚化光斑 =================
     只在按下「生成」时算——一次上百万条光线，不能跟着每次编辑自动跑。
     计算放在 Web Worker：把 glassdb + optics 的源码原样取出来塞进一个 Blob worker
     （单文件版从内联 <script> 取文本，静态站用 fetch 读文件），主线程只管色调映射和写字。
     Worker 逐格追迹、逐格铺成辐照度图发回来，进度条按步数走，格子算完一格画一格。 */
  var SPOT = { worker: null, prep: null, meta: null, t0: 0, seq: 0, hasImg: false };
  function spotWorkerMain() {
    self.onmessage = function (e) {
      var m = e.data;
      if (m.cmd !== 'run') return;
      var p = OPT.parsePrescription(m.tx);
      var sys = OPT.buildSystem(p.surfaces, m.opt);
      if (m.vig) sys.vig = m.vig;
      var dd = OPT.defocusDepths(sys, m.opt, m.targetUm);
      var depths = [{ D: dd.focus, role: 'focus' }];
      if (dd.back !== undefined) depths.push({ D: dd.back, role: 'back' });
      depths.push({ D: dd.front, role: 'front' });
      var o = Object.assign({}, m.opt, { spotDepths: depths, spotFields: m.fields, spotLambdas: m.lamIdx, spotRays: m.R });
      var ctx = OPT.spotPrepare(sys, o);
      var nD = depths.length, nF = m.fields.length, nL = ctx.lam.length;
      var total = nD * nF * nL + nD * nF, step = 0;
      self.postMessage({ type: 'prep', dd: dd, depths: depths, vigMode: ctx.vigMode, nAp: ctx.nAp, nSur: ctx.nSur,
                         lambdas: ctx.lambdas, R: ctx.R, total: total });
      for (var di = 0; di < nD; di++) {
        var stats = [];
        for (var fi = 0; fi < nF; fi++) {
          for (var li = 0; li < nL; li++) {
            OPT.spotTrace(ctx, di, fi, li);
            self.postMessage({ type: 'progress', step: ++step, total: total, rays: ctx.nRays });
          }
          stats.push(OPT.spotStats(ctx, di, fi));
        }
        // 比例尺：离焦行整行共用（按该行最大光斑，格子之间大小可比）；
        // 对焦行每格自己的——像差光斑大小差好几倍，共用的话轴上那格就是一个点
        var rowHalf = 0;
        for (fi = 0; fi < nF; fi++) rowHalf = Math.max(rowHalf, stats[fi].diam / 2000);
        for (fi = 0; fi < nF; fi++) {
          var half = Math.max((depths[di].role === 'focus' ? stats[fi].diam / 2000 : rowHalf) * 1.12, 0.004);
          var buf = OPT.spotRaster(ctx, di, fi, half, m.px, m.colors, m.weights);
          self.postMessage({ type: 'panel', di: di, fi: fi, half: half, stats: stats[fi], buf: buf,
                             step: ++step, total: total, rays: ctx.nRays }, [buf.buffer]);
          ctx.depths[di].fields[fi].grids = [];              // 铺完就释放
        }
      }
      self.postMessage({ type: 'done', rays: ctx.nRays });
    };
  }
  /* Worker 的源码：单文件版直接取内联 <script> 的文本；静态站用 fetch 把 js/ 里的文件读成文本。
     不用 importScripts —— 它对 MIME 类型是严格的，Python 的 http.server 在 Windows 上把 .js
     当 text/plain 发，Worker 就起不来（主页面的 <script src> 宽松，所以页面本身没事）。
     读成文本再塞进 Blob，两种产物走同一条路，跟服务器怎么标 MIME 无关。取过一次就缓存。 */
  var SPOTSRC = null;
  function spotSource() {
    if (SPOTSRC) return SPOTSRC;
    SPOTSRC = Promise.all(['glassdb', 'optics'].map(function (k) {
      var el = document.getElementById('src-' + k);
      if (!el) return Promise.reject(new Error('页面里没有 src-' + k + ' 脚本（构建产物太旧）'));
      var src = el.getAttribute('src');
      if (!src) return Promise.resolve(el.textContent);
      return fetch(new URL(src, location.href).href).then(function (r) {
        if (!r.ok) throw new Error(src + ' ' + r.status);
        return r.text();
      });
    })).then(function (parts) {
      parts.push('(' + spotWorkerMain.toString() + ')();');
      return parts.join('\n');
    });
    SPOTSRC.catch(function () { SPOTSRC = null; });     // 失败了下次重取
    return SPOTSRC;
  }
  function spotFields(n) {
    var st = last.st, lam = last.opt.lambdas[last.opt.primary].nm / 1000, out = [];
    for (var i = 0; i < n; i++) {
      var f = i / (n - 1);
      out.push(st.fmode === 'height' ? OPT.angleForHeight(last.sys, st.fov * f, lam) : st.fov * f);
    }
    return out;
  }
  function spotStop(keepBadge) {
    if (SPOT.worker) { SPOT.worker.terminate(); SPOT.worker = null; }
    $('spotBtn').disabled = false; $('spotStop').disabled = true; $('spotProg').hidden = true;
    if (!keepBadge) $('spotBadge').textContent = SPOT.hasImg ? '已停止 · 有格子没算完' : '已停止';
  }
  function spotStale() {
    if (SPOT.hasImg && !SPOT.worker) $('spotBadge').textContent = '已过期 · 镜头参数已改';
  }
  function spotProgress(step, total, rays) {
    var dt = (performance.now() - SPOT.t0) / 1000, pct = total ? 100 * step / total : 0;
    $('spotProg').hidden = false;
    $('spotProgBar').style.width = pct.toFixed(1) + '%';
    $('spotProgTxt').textContent = Math.round(pct) + '% · 已追迹 ' + rays.toLocaleString('en-US') + ' 条 · ' + dt.toFixed(1) + ' s';
  }
  function spotRun() {
    if (!last) return;
    spotStop(true);
    var st = last.st, nF = +$('spotNF').value, R = +$('spotN').value, px = +$('spotPx').value;
    var um = parseFloat($('spotUm').value); if (!(um > 0)) um = 400;
    var lamIdx = $('spotWl').value === 'pri' ? [last.opt.primary]
      : last.opt.lambdas.map(function (_, i) { return i; });
    SPOT.meta = { fields: spotFields(nF), lamIdx: lamIdx, px: px, um: um, R: R,
                  colors: lamIdx.map(function (i) { return hex2rgb(st.wl[i].c || '#ffffff').map(function (v) { return v / 255; }); }),
                  weights: lamIdx.map(function (i) { return last.opt.lambdas[i].w > 0 ? last.opt.lambdas[i].w : 1; }) };
    SPOT.prep = null; SPOT.hasImg = false; SPOT.t0 = performance.now();
    $('spotBadge').textContent = '搜索焦前 / 焦后物距…'; $('spotBtn').disabled = true; $('spotStop').disabled = false;
    $('spotLegend').innerHTML = '';
    $('spotProg').hidden = false; $('spotProgBar').style.width = '0%'; $('spotProgTxt').textContent = '搜索焦前 / 焦后物距…';
    var run = ++SPOT.seq;
    var msg = { cmd: 'run', tx: st.tx, opt: last.opt, vig: last.sys.vig || null, targetUm: um, fields: SPOT.meta.fields,
                lamIdx: lamIdx, R: R, px: px, colors: SPOT.meta.colors, weights: SPOT.meta.weights };
    spotSource().then(function (src) {
      if (run !== SPOT.seq) return;                    // 等源码期间又按了一次
      var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onerror = function (ev) { $('spotBadge').textContent = '计算出错：' + (ev.message || ev); spotStop(true); };
      w.onmessage = spotOnMsg;
      SPOT.worker = w;
      w.postMessage(msg);
    }, function (err) { $('spotBadge').textContent = '无法启动 Worker：' + err.message; spotStop(true); });
  }
  function spotOnMsg(e) {
    var m = e.data;
    if (m.type === 'prep') { SPOT.prep = m; spotBuildGrid(); spotProgress(0, m.total, 0); $('spotBadge').textContent = '追迹中…'; return; }
    if (m.type === 'progress') { spotProgress(m.step, m.total, m.rays); return; }
    if (m.type === 'panel') {
      var nF = SPOT.meta.fields.length;
      spotPanel($('spotC' + m.di + '_' + m.fi), m.buf, m.stats, m.half, m.fi / (nF - 1));
      SPOT.hasImg = true;
      spotProgress(m.step, m.total, m.rays);
      return;
    }
    if (m.type === 'done') {
      var dt = (performance.now() - SPOT.t0) / 1000;
      $('spotBadge').textContent = m.rays.toLocaleString('en-US') + ' 条 · ' + dt.toFixed(1) + ' s';
      spotStop(true);
    }
  }
  function spotRoleName(r) { return r === 'focus' ? '对焦' : r === 'back' ? '焦后' : '焦前'; }
  function spotBuildGrid() {
    var P = SPOT.prep, M = SPOT.meta, g = $('spotGrid'), nF = M.fields.length;
    $('spotEmpty').hidden = true;
    // 列宽等分卡片宽度（画布 CSS 缩放），不再按渲染像素排版，免掉横向滚动条
    g.style.gridTemplateColumns = 'max-content repeat(' + nF + ', minmax(0, 1fr))';
    var html = '';
    P.depths.forEach(function (d, di) {
      var um = d.role === 'focus' ? P.dd.focusUm : d.role === 'back' ? P.dd.backUm : P.dd.frontUm;
      html += '<div class="spotlbl"><b>' + spotRoleName(d.role) + '</b><i>' + (isFinite(d.D) ? Math.round(d.D).toLocaleString('en-US') + ' mm' : '∞') + '</i><span>轴上 ' + Math.round(um) + ' µm</span></div>';
      for (var fi = 0; fi < nF; fi++)
        html += '<div class="spotcell"><canvas id="spotC' + di + '_' + fi + '" width="' + M.px + '" height="' + M.px + '"></canvas></div>';
    });
    g.innerHTML = html;
    var vig = P.vigMode === 'aperture'
      ? '瞳：' + P.nAp + '/' + P.nSur + ' 个面按真实通光逐面裁剪（猫眼为真）'
      : '瞳：没有足够的写死通光，按渐晕系数取等效椭圆瞳（光斑只能是椭圆）';
    var lam = P.lambdas.map(function (nm, i) {
      var c = M.colors[i].map(function (v) { return Math.round(v * 255); });
      return '<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:rgb(' + c.join(',') + ');vertical-align:-1px;margin-right:4px"></i>' + nm + ' nm</span>';
    }).join('');
    var reach = [];
    if (P.dd.backReached === false) reach.push('焦后到无限远也只有 ' + Math.round(P.dd.backUm) + ' µm');
    if (P.dd.frontReached === false) reach.push('焦前到最近可算物距也只有 ' + Math.round(P.dd.frontUm) + ' µm');
    $('spotLegend').innerHTML = '<span>' + vig + '</span><span>每格每波长 ' + P.R.toLocaleString('en-US') + ' 条 · 目标光斑 ' + M.um + ' µm（轴上外径）</span>' + lam
      + '<span>离焦行整行同一比例尺，对焦行每格自己的（右下角 ±）</span>'
      + (reach.length ? '<span style="color:var(--warn)">' + reach.join('；') + '</span>' : '');
  }
  /* 一格：辐照度图 → 能量分位色调映射 → 写字 */
  function spotPanel(cv, acc, st, half, frac) {
    var W = cv.width, ctx = cv.getContext('2d'), n = W * W;
    // 点列图的亮度：按非零像素亮度的 99 分位归一，再开 0.6 次方——单个落点也看得见，密处到白。
    var lum = [], i;
    for (i = 0; i < n; i++) { var v = (acc[i * 3] + acc[i * 3 + 1] + acc[i * 3 + 2]) / 3; if (v > 0) lum.push(v); }
    lum.sort(function (p, q) { return p - q; });
    var iq = lum.length ? Math.max(lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.99))], 1e-30) : 1;
    var img = ctx.createImageData(W, W), D = img.data;
    for (i = 0; i < n; i++) {
      for (var ch = 0; ch < 3; ch++) {
        var q = acc[i * 3 + ch] / iq;
        D[i * 4 + ch] = Math.round(255 * Math.min(1, Math.pow(Math.max(0, q), 0.6)));
      }
      D[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    var fs = Math.round(W / 24);
    ctx.font = fs + 'px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.textBaseline = 'top';
    ctx.fillText('F=' + frac.toFixed(1) + ' (' + st.th.toFixed(2) + '°)', fs * 0.6, fs * 0.5);
    ctx.textBaseline = 'bottom';
    ctx.fillText('D' + st.diam.toFixed(0) + 'µm  rms ' + st.rms.toFixed(0) + '  T ' + st.T.toFixed(2), fs * 0.6, W - fs * 0.5);
    ctx.textAlign = 'right';
    ctx.fillText('±' + (half * 1000).toFixed(0) + 'µm', W - fs * 0.6, W - fs * 0.5);
    ctx.textAlign = 'left';
  }
  $('spotBtn').addEventListener('click', spotRun);
  $('spotStop').addEventListener('click', function () { spotStop(false); });

  /* ================= 卡片说明（表头的 ?，默认收起） =================
     长说明不该常年占着版面，但也不该藏到「关于」里去——放在本卡片表头一个
     16px 的 ? 后面，展开与否按卡片记在 localStorage，下次打开还是上次的样子。 */
  var HELPKEY = 'lensbench.help';
  var helpState = {};
  try { helpState = JSON.parse(localStorage.getItem(HELPKEY)) || {}; } catch (e) { helpState = {}; }
  function helpSet(btn, on) {
    var box = $(btn.getAttribute('data-help'));
    if (!box) return;
    box.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    btn.title = on ? '收起说明' : '使用说明';
  }
  [].forEach.call(document.querySelectorAll('.helpbtn'), function (btn) {
    var key = btn.getAttribute('data-help');
    helpSet(btn, !!helpState[key]);
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-expanded') !== 'true';
      helpSet(btn, on);
      helpState[key] = on;
      try { localStorage.setItem(HELPKEY, JSON.stringify(helpState)); } catch (e) {}
    });
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
     —— 这几项是镜头本身的规格，强行统一就不是那颗镜头了。
     例外是光圈：可以选择把大光圈的那只收到另一只的 F/#（或两只都收到指定 F/#），渐晕随光阑一起重算，见 cmpFinish。 */
  var CMP = { A: { id: null, cfg: 0, res: null }, B: { id: null, cfg: 0, res: null }, on: false };
  var CMPCA = ['--f2', '--f3', '--f1', '--f4'];      // A：冷色
  var CMPCB = ['--v2', '--v3', '--v1', '--v2'];      // B：暖色

  function cmpShared() {
    return {
      wl: $('cmpWl').value,
      freqs: parseList($('cmpFreqs').value, [10, 30]).filter(function (v) { return v > 0; }).slice(0, 4),
      mode: $('cmpMode').value, ts: $('cmpTS').value, xax: $('cmpX').value,
      ngrid: +$('cmpGrid').value, nfield: +$('cmpN').value, focus: $('cmpFocus').checked,
      vigFile: $('cmpVig').checked,
      ap: $('cmpAp').value, apF: parseFloat($('cmpApF').value)
    };
  }
  /* 收光圈后的渐晕系数。别的镜片挡掉哪些光线和光阑多大无关（瞄准时光线按光阑面上的落点参数化，
     同一个落点就是同一条光线）；光阑缩小只是再和一个更小的圆取交集。所以原渐晕区域 [lo, hi]（旧光阑归一化）
     换到新光阑归一化是除以 k = 新半径 / 旧半径，再裁到 ±1 以内。弧矢方向在新的子午中心线上量，
     宽度按原渐晕椭圆在那一行的弦长算——和 setVig「弧矢在子午瞳中心那一行量」同一个口径。
     全库实测（有 setVig 表的镜头 × 全部结构 × 收缩比 1.1/1.4/2/2.8/4，共 1565 例）：和收完光圈重跑 setVig 相比，
     1561 例差 < 0.002，3 例弧矢差 0.003~0.006；剩下 1 例（RF 85 Macro Z4 收 4 倍，最大视场）是 setVig 的起点探针只到 ±0.9、
     漏掉了只剩 [−1, −0.93] 一条细缝的瞳，判成全黑——这里的换算才是对的。所以直接换算，不重跑。
     整条子午轴都落到新光阑外面（主光线本来就被挡的视场才会这样）按 setVig 的约定记成全渐晕 vuy = vly = 1。 */
  function vigShrink(v, k) {
    if (!v || !v.vuy || !(k > 0 && k < 1)) return v;
    var o = { th: v.th, vuy: [], vly: [], vux: [], vlx: [] };
    if (v.auto) o.auto = v.auto;
    for (var i = 0; i < v.vuy.length; i++) {
      var hi = 1 - v.vuy[i], lo = -1 + v.vly[i], xh = 1 - v.vux[i], xl = -1 + v.vlx[i];
      var cy = (hi + lo) / 2, ay = (hi - lo) / 2, cx = (xh + xl) / 2, ax = (xh - xl) / 2;
      var hi2 = Math.min(1, hi / k), lo2 = Math.max(-1, lo / k);
      if (!(hi2 > lo2)) { o.vuy.push(1); o.vly.push(1); o.vux.push(1); o.vlx.push(1); continue; }
      var t = ay > 1e-12 ? ((hi2 + lo2) / 2 * k - cy) / ay : 0;
      var wE = ax * Math.sqrt(Math.max(0, 1 - t * t));
      o.vuy.push(1 - hi2); o.vly.push(1 + lo2);
      o.vux.push(1 - Math.min(1, (cx + wE) / k)); o.vlx.push(1 + Math.max(-1, (cx - wE) / k));
    }
    return o;
  }
  /* 建系统 + 挂渐晕 + 定视场点（与主页面 compute() 同一套规则） */
  function cmpAttach(sur, opt, L, c, S, ci, shrink) {
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
    if (shrink) sys.vig = vigShrink(sys.vig, shrink);      // 收了光圈：渐晕表跟着光阑换算
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
  /* 第一步只建系统（便宜）：两边的 F/# 都知道了才能定收到多少，再各自做第二步（追迹 MTF，贵） */
  function cmpPrep(L, ci, S) {
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
    return { L: L, c: c, ci: ci, sur: sur, opt: opt, wl: wl, sys: cmpAttach(sur, opt, L, c, S, ci) };
  }
  /* 第二步：需要的话收光圈（fnoTo 比这颗现在的工作 F/# 暗才收，开不到比设计更大的光圈），再对焦、追迹。
     收光圈 = 按工作 F/# 反解入瞳（孔径定义改成「像方工作 F/#」，无限远时就是 EFL/入瞳），
     并去掉光阑面上写死的通光：瞄准时归一化瞳坐标以光阑半径为 1，那个半径得跟着新的 F/# 走，
     否则光线照样铺满原来的光阑，等于没收。旧新两个光阑半径之比就是渐晕表的换算比（vigShrink）。 */
  function cmpFinish(P, S, fnoTo) {
    var L = P.L, c = P.c, ci = P.ci, sur = P.sur, opt = P.opt, sys = P.sys, ap = null, shrink = 0;
    if (fnoTo > 0 && fnoTo > sys.fno * (1 + 1e-4)) {
      var f0 = sys.fno, r0 = sys.aiming ? sys.sdStop : sys.epd / 2, vig0 = sys.vig;
      sur[opt.stopIdx].sd = null;                     // null = 不设通光（traceRay 把 0 当成半径 0 的孔，会把光线全挡掉）
      opt.apertureMode = 'fno'; opt.fno = fnoTo;
      if (opt.sdAp) { opt.sdAp = opt.sdAp.slice(); opt.sdAp[opt.stopIdx] = null; }
      sys = cmpAttach(sur, opt, L, c, S, ci);
      var r1 = sys.aiming ? sys.sdStop : sys.epd / 2;
      shrink = (r0 > 0 && r1 > 0 && r1 < r0) ? r1 / r0 : 0;
      if (shrink) sys = cmpAttach(sur, opt, L, c, S, ci, shrink);
      // 光路图上的光阑刻线画在新的光阑半径上
      opt.sdDraw = (opt.sdDraw ? opt.sdDraw.slice() : new Array(sur.length).fill(null));
      opt.sdDraw[opt.stopIdx] = sys.aiming ? sys.sdStop : null;
      ap = { f0: f0, f1: sys.fno, k: shrink, vig: vig0 ? (vig0.auto ? 'auto' : 'file') : 'trace' };
    } else if (fnoTo > 0) ap = { f0: sys.fno, f1: sys.fno, k: 0, open: fnoTo < sys.fno * (1 - 1e-4), want: fnoTo };
    if (S.focus) {
      var dz = axialBestFocus(sys, opt);
      if (dz !== null && isFinite(dz)) { opt.defocus = dz; sys = cmpAttach(sur, opt, L, c, S, ci, shrink); }
    }
    return { L: L, opt: opt, sys: sys, wl: P.wl, hgt: (L.fmode || 'height') === 'height', ap: ap,
             mtf: OPT.mtfVsField(sys, opt), lay: OPT.layoutGeometry(sys, opt) };
  }
  /* 收到多少：「收到和另一只一样」取两只里较暗的工作 F/#；「指定 F/#」取填的值 */
  function cmpApTarget(S, PA, PB) {
    if (S.ap === 'slow') return (PA && PB) ? Math.max(PA.sys.fno, PB.sys.fno) : 0;
    if (S.ap === 'fix') return (S.apF > 0 && isFinite(S.apF)) ? S.apF : 0;
    return 0;
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
    var S = cmpShared(), P = {};
    ['A', 'B'].forEach(function (k) { P[k] = CMP[k].L ? cmpPrep(CMP[k].L, CMP[k].cfg, S) : null; });
    var tgt = cmpApTarget(S, P.A, P.B);
    ['A', 'B'].forEach(function (k) {
      CMP[k].res = P[k] ? cmpFinish(P[k], S, tgt) : null;
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
    if (R.ap && R.ap.f1 > R.ap.f0 * (1 + 1e-4)) {
      it.push(['光圈', '收缩 F/' + fmt(R.ap.f0, 2) + ' → ' + fmt(R.ap.f1, 2)]);
      it.push(['渐晕', R.ap.vig === 'trace' ? '按通光实时追迹' : R.ap.vig === 'auto' ? '按通光表随光阑重算' : '文件系数随光阑重算']);
    } else if (R.ap && R.ap.open) it.push(['光圈', '全开 F/' + fmt(R.ap.f0, 2) + '（开不到 F/' + fmt(R.ap.want, 2) + '）']);
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
  ['cmpWl', 'cmpFreqs', 'cmpMode', 'cmpTS', 'cmpX', 'cmpGrid', 'cmpN', 'cmpFocus', 'cmpVig', 'cmpApF'].forEach(function (id) {
    $(id).addEventListener('change', cmpRun);
  });
  /* 选「指定 F/#」时才露出输入框；头一次露出时预填一个常用光圈档：两只里较暗那只之后的第一档 */
  var CMPSTOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
  $('cmpAp').addEventListener('change', function () {
    var fix = this.value === 'fix', w = $('cmpApFWrap');
    if (fix && w.hidden && !w.dataset.touched) {
      var fs = ['A', 'B'].map(function (k) { return CMP[k].res ? CMP[k].res.ap && CMP[k].res.ap.f0 || CMP[k].res.sys.fno : 0; });
      var slow = Math.max(fs[0] || 0, fs[1] || 0);
      var pick = CMPSTOPS.filter(function (v) { return v >= slow * 0.999; })[0];
      if (pick) $('cmpApF').value = pick;
    }
    w.hidden = !fix;
    cmpRun();
  });
  $('cmpApF').addEventListener('input', function () { $('cmpApFWrap').dataset.touched = '1'; });
  addEventListener('resize', function () { if (CMP.on) cmpRun(); });

  /* ================= 启动 ================= */
  renderBrandList();
  renderLensList($('brand').value);
  var saved = readHash();
  if (!restoreHash(saved)) {
    var first = (LENSDB.index[0] && LENSDB.index[0].id) || '55za';
    syncLensSelects(first);
    loadLens(first);
    histBase();
  }
  syncFMode();
  renderWL();
  // 同步载入（单文件版）时 restore 已排过一次重算；这里只算一次，提示（如「库更新过」）才不会马上被下一次清掉。
  // 镜头还在下载（静态站）就先不算：空处方算一遍只会把排队的提示吃掉，下载完的回调自己会算
  if (!lensPending) { clearTimeout(timer); compute(); }

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
