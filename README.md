# 镜头 MTF 仿真台 — 工程说明

浏览器里跑的序列光学仿真：LDM 表格直接编辑，实时出 2D Layout、MTF vs 视场、
以及球差 / 像散场曲 / 畸变三联图。全部计算在本机 JS 完成，没有后端。

绘图颜色不是挑的，是**按波长算出来的真实谱色**（CIE 1931 配色函数 → sRGB，出色域截负、亮度归一），
网页、镜头库 JSON、命令行转换共用 `LENSIO.wlColor` 一个函数。

算法细节、验证记录、玻璃库精度、修过的坑等，都在页面右上角「关于」里（一个二级页，Esc 或「返回」退出）。

三条像差曲线都用实光线算，不走赛得系数：

- **纵向球差**　轴上光线在归一化瞳高 ρ 处与光轴的交点减去像面 z。曲线底端不归零，那段偏移就是轴向色差。
- **像散场曲**　以主光线为中心、在光阑面取 ±2% 瞳半径的一对光线（科丁顿构型的实光线版）：
  子午取两条的交点、弧矢取 x=0 的位置，都换算成到像面的轴向距离。
  **实线 = 子午 T、虚线 = 弧矢 S**，和 MTF 图同一约定（Zemax 的场曲图默认相反，是实线 S、虚线 T）。
- **畸变**　主光线实像高与**近轴主光线在像面上的高度**之比。注意基准不是 f·tanθ——
  像面不在近轴焦点上时两者会差几个千分之一，Cooke 三片能差到 0.47%。

主光线及其 ±δ 邻居属于参考光线，按惯例不受通光孔径限制，否则大视场上整条曲线会消失。

页面最下面还有一张 **光线扇形（ray fan）**，布局照 CODE V 的 `RIM`：每个等分像高视场一行，
左格子午、右格弧矢，最上面是最大视场，默认 6 个视场点。横轴取整个入瞳的归一化坐标 −1…+1，
曲线只画在该视场未渐晕的那一段；纵向零点是该视场主光线在主波长下的落点。
所有格子共用一个对称刻度——官方宏 `macro/cvquickrim.seq` 就是先扫一遍全部视场 × 波长的最大像差、
再用 `SSI` 统一设定，这里照搬。轴上那一行的子午扇严格奇对称，是这条链路的硬校验。

```
src/          源码（改这里）
  head.html   <head> 里的样式
  body.html   页面结构
  lensio.js   镜头文件解析：.zmx / .seq → 镜头记录（网页和命令行共用）
  optics.js   计算内核：追迹 / 近轴 / 光瞳 / 衍射 MTF / Layout 几何
  app.js      界面
  glassdb.txt 玻璃库：19 家厂商 3074 种牌号的色散公式
lenses/       镜头库：<id>.json + index.json（由转换脚本生成）
tools/
  zmx2lens.js 批量转换 .zmx/.seq → lenses/
  build.js    产出 dist/
  serve.js    本地预览静态站
dist/
  lens-mtf-bench.html   单文件版，双击就开，可直接发人
  web/                  静态站，可直接扔到任何静态托管
```

---

## 加一颗镜头：三步

```bash
# 1. 转换（文件或整个目录都行，递归找 .zmx/.seq/.len）
node tools/zmx2lens.js "E:/Download" -o lenses

# 2. 重新打包
node tools/build.js

# 3. 本地看一眼
node tools/serve.js          # → http://localhost:8080
```

第 1 步会给每个文件写一个 `lenses/<id>.json`，并重写 `lenses/index.json`（网页下拉读它）。
几百个文件就是一条命令的事，重名会自动加后缀，转换失败的文件会单独列出来不影响其余。

单颗镜头临时看一下，不用走这套：网页上点 **导入 .seq / .zmx** 直接拖文件进去，
走的是同一份 `lensio.js`，结果和批量转换完全一致。

---

## 转换器认什么

**Zemax `.zmx`**（UTF-16LE / UTF-16BE / UTF-8 自动识别）

| 记录 | 用途 |
|---|---|
| `SURF n` / `CURV` / `DISZ` / `GLAS` / `CONI` | 面号、曲率、厚度、玻璃、圆锥系数 |
| `TYPE STANDARD` / `EVENASPH` + `PARM 2..8` | 偶次非球面 r⁴…r¹⁶ |
| `STOP` | 光阑面 |
| `FNUM` / `ENPD` | 像方 F/# 或入瞳直径 |
| `FTYP` / `YFLN` | 视场类型（0 角度 / 2 近轴像高 / 3 实像高）与视场值 |
| `WAVM` / `PWAV` | 波长、权重、主波长 |
| `VDYN` `VCYN` `VDXN` `VCXN` | 渐晕系数 → 各视场未渐晕瞳区间 |
| `MNUM` `LTTL` `THIC` `CRVT` `APER` `FVCY` `FVDY` `FVCX` `FVDX` | 多重结构：结构数、名称、逐结构的厚度 / 曲率 / F# / 渐晕 |

**CODE V `.seq`**

`S`/`CIR`/`ASP`/`K`/`A B C D`/`STO`/`SO`/`FNO`/`WL`/`WTW`/`REF`/`YRI`/`YAN`/
`VUY VLY VUX VLX`/`ZOO`（含 `ZOO THI S0` 物距、`ZOO FNO`、`ZOO VUY Fn`）/`TIT Zk`。

### 两个格式的口径约定不一样，转换时统一了

- CODE V：`VUY/VLY` 是上下各被切掉多少，未渐晕区间 = `[-1+VLY, 1-VUY]`
- Zemax：`(VDY, VCY)` 是偏心 + 压缩，未渐晕区间 = `[VDY-(1-VCY), VDY+(1-VCY)]`

统一成 CODE V 那套存进 `vig`，换算是 `VUY = VCY-VDY`，`VLY = VCY+VDY`。
Zemax 的视场表通常从大到小，转换时会重排成由小到大，渐晕数组跟着一起重排。

### 有意不导入的东西

- **Zemax 的 `FLAP`（浮动通光）和固定半口径**：浮动通光是逐结构重算的，文件里只存了当前结构那一份。
  硬套到近摄结构会把边缘光线全挡掉（实测 SIGMA 35 的 0.27M 结构边缘视场会整个消失）。
  文件带渐晕系数时通光瞳已由渐晕系数完整定义，Zemax 自己算 MTF 也是这么做的，所以跳过并给一条提示；
  文件不带渐晕系数时才拿它当硬光阑用。
- **多重结构里换玻璃（`GLSS`）**：只跟随厚度 / 曲率 / F# / 渐晕，玻璃固定用第 1 结构，会给提示。
- **偶次非球面的 r² 项（`PARM 1`）**：本页面型模型没有该项，非零会给提示。
- **X 视场、非序列面、非毫米单位**：都只给提示，不做换算。

### 玻璃

牌号先精确匹配，再试目录后缀（`NBFD25_HOYA`）、别名（`FUSED SILICA`）、
最后削掉末尾 1~2 个变体字母（HOYA 的 `MCNBFD130L` → `MCNBFD130`）。
最后一种算近似替代，会在提示里写清楚换成了谁。查不到的可以在表里手写 `nd/vd` 或 6 位 MIL 代码。

---

## 镜头记录（`lenses/<id>.json`）

```jsonc
{
  "id": "sigma-35mm-f1-4-dg-art-ii-e2",
  "name": "SIGMA 35mm F1.4 DG Art II E2",   // 下拉显示名，默认取文件名
  "sub":  "30 面 · F/1.47 · 5 结构 · 8 非球面",
  "src":  "SIGMA 35mm F1.4 DG Art II E2.zmx",
  "kind": "zmx",
  "tx":   "82.38  2.45  S-NPH4  -\n…",       // 每行：R 厚度 玻璃 半通光 [圆锥 A4 A6 …]
  "stop": 12,                                 // 1 起
  "fno": 1.47, "apmode": "fno",
  "fmode": "height", "fov": 21.6, "nfield": 6,
  "freqs": "10, 30, 80", "aim": false,
  "objd": null,                               // 有限物距（mm），无限远写 null
  "wl": [["656.2725","3","#de4a4a"], …], "pri": 2,
  "vigH": [0, 4.32, …, 21.6],                 // 渐晕表对应的视场（像高或角度）
  "cfgs": [ { "title":"INF", "fno":1.47, "obj":1e13,
              "thi": {"1":8, "5":2.36, …},    // 键 = 行号（0 起）
              "rdy": {},
              "vig": {"vuy":[…],"vly":[…],"vux":[…],"vlx":[…]} }, … ],
  "warn": ["…"]                               // 载入时显示的提示
}
```

手写一颗镜头也行：最少给 `id / name / tx / stop / fno / fov / fmode`，其余可省。

---

## 打包与部署

`node tools/build.js` 一次产出两份：

| | 原始 | gzip 后 |
|---|---|---|
| `dist/lens-mtf-bench.html`（单文件，含全部镜头） | 382 KB | 147 KB |
| `dist/web/` 首屏合计 | 366 KB | **141 KB** |
| └ `js/glassdb.js` | 220 KB | 89 KB |
| └ `js/app.js` + `js/optics.js` + `js/lensio.js` | 117 KB | 42 KB |
| └ `index.html` + `data/index.js` | 29 KB | 11 KB |
| 镜头库（选中才下载，不占首屏） | 单颗约 2 KB | — |

静态站放任何托管都行（GitHub Pages / nginx / OSS）。两件事记得做：

1. **开 gzip / brotli**——141 KB 是 gzip 后的数，不开就是 366 KB。
2. **给 `js/glassdb.js` 配长缓存**（`Cache-Control: max-age=31536000, immutable`）。
   它占了首屏的六成，但基本不会变，第二次访问起就是零传输。

镜头库涨到几百颗也不影响首屏：`data/index.js` 每颗只占一行（约 100 字节），
选中哪颗才去 `data/lenses/<id>.json` 取那一颗。加镜头只需重跑转换脚本，`index.html` 不用动。

单文件版把所有镜头内联进来，双击就能开，适合发给别人或离线用；
静态站版本 `fetch` 不认 `file://`，必须挂 http 服务（本地用 `node tools/serve.js`）。
