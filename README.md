# 时钟天气 QTWeather

<p>
  <img alt="Version" src="https://img.shields.io/badge/version-3.0.2-blue">
  <img alt="fnOS" src="https://img.shields.io/badge/fnOS-x86%20%7C%20arm-success">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-orange">
  <img alt="Data" src="https://img.shields.io/badge/data-Open--Meteo-green">
</p>

飞牛 fnOS 桌面**时钟 + 天气**小部件（FPK 原生应用）：直接注入飞牛桌面显示，**无窗口标题栏**。卡片为大号时钟（时：分 + 秒 + 公历 + 农历干支）与实时天气 / 未来 5 天预报，**两个模块可独立开关**；点击飞牛「已安装」中的应用图标打开**设置中心**（独立窗口），支持全球城市搜索、自动刷新间隔、桌面自由拖动、卡片背景透明度（**0% 可全透明**，文字 / 图标始终不透明）、文字与图标配色、**字号 50%–200%** 与**自定义字体上传**（ttf/otf/woff/woff2）。设置保存到 NAS 后卡片**数秒内热生效，无需刷新桌面**；设置中心内置「关于」页并可向 GitHub Releases **自动检查新版本（仅检查，不自动安装）**。数据来源 [Open-Meteo](https://open-meteo.com/)（免费，**无需 API Key**），小部件前端直连 Open-Meteo，无需经 NAS 网关中转。

- 当前版本：**v3.0.2**
- 作者：**Misite齊**（[github.com/MisiteQ](https://github.com/MisiteQ)）
- 仓库：[github.com/MisiteQ/QTWeather](https://github.com/MisiteQ/QTWeather)
- 适用平台：fnOS **x86 + arm**（最低系统版本 1.0.0）
- 服务端口：**5698**
- 运行身份：**root**（需操作 nginx 配置与系统恢复包）

## ✨ 功能

- **🧩 模块独立开关**：「时间日期」与「天气预报」两个模块可分别显隐——只看时钟、只看天气或两者都显（不允许同时关闭）
- **🕐 时钟 · 农历**：大号时钟（时:分 + 秒，每秒走字）、完整日期与星期，下方农历日期含干支年 / 干日与闰月（算法移植自 fnmonitor）
- **🌤️ 实时天气**：当前温度、体感温度、湿度、风速、气压、天气状况（WMO 代码 → 离线内联 SVG 图标，夜间显示月亮）
- **📅 5 天预报**：今天起未来 5 天，每日天气图标与最高 / 最低温
- **🪟 设置中心独立窗口**：点击飞牛「已安装」中的应用图标即打开设置中心（显示模块 / 天气地点与自动刷新 / 外观 / 关于）；桌面卡片上不再有任何设置入口，只展示信息
- **⚡ 保存即热生效**：卡片每 4 秒轻量轮询 NAS `settings.json`（nginx 直接 alias 文件，不走应用进程），设置中心保存后配色、透明度、字号、字体、模块开关、城市、刷新间隔、显隐、重置位置全部免刷新生效
- **🔍 城市切换**：双源搜索——内置中国行政区划坐标库（省/市/县三级 3200+，来源阿里 DataV）本地秒搜，国际城市直连 Open-Meteo
- **🔄 自动刷新**：10 / 30 / 60 / 180 分钟可选（默认 30 分钟），上次天气更新时间显示在设置中心
- **🎚️ 背景透明度**：滑动调节，**下限 0%（可真正全透明）**；透明只作用于卡片底色，磨砂 / 投影 / 分隔线随透明度同步淡出
- **🎨 文字 · 图标 · 定位配色**：三个取色器——「文字颜色」「图标颜色」与独立的「定位图标」（城市名左侧定位针，默认红色），设置中心右侧实时预览
- **🔠 字号调节**：50%–200%，+/− 步进 5 或直接输入，卡片全部文字等比缩放
- **🔤 自定义字体**：上传标准字体文件 ttf / otf / woff / woff2（≤25MB，文件头魔数校验防伪装），保存在 NAS，跨设备生效，可一键恢复默认
- **🖱️ 整卡拖动 · 自由缩放**：按住卡片任意空白处拖动，右下角手柄调整大小（最小 240×120），位置尺寸自动记忆
- **👁️ 隐藏 / 恢复**：设置中心关闭「在桌面上显示卡片」后，桌面右下角出现恢复按钮
- **ℹ️ 关于与更新检查**：设置中心「关于」展示版本、作者、仓库与数据来源，打开时自动向 GitHub Releases 检查新版本，也可手动检查；发现新版只显示版本号、更新说明与下载链接，**不会自动下载安装**
- **🖥️ 桌面注入**：无窗口标题栏，直接显示在飞牛桌面上，登录界面自动隐藏

## 🏗️ 技术实现

### 注入机制（零 `/usr/trim/www` 写入）

fnOS 的 nginx 内置 `trim_recover` 模块：直接修改 `/usr/trim/www` 会被系统自愈覆盖，持续写入还会触发「恢复风暴」；同时 nginx 每次 reload/restart 都会从加密的 `ng.conf.zip` 恢复 `conf.d/`，自定义配置会被抹掉。

对策：

1. 小组件注入页放在应用数据目录（`/vol1/@appdata/com.qweather.widget/desktop/index.html`），内容为系统 `index.html` + 一行 `<script src="/qweather-widget.js">`
2. `conf.d/qweather.conf` 用 `alias` 把 `GET /` 与 `GET /login` 指向该注入页
3. `ng.conf.zip` 的 ZipCrypto 密钥已通过 bkcrack 已知明文攻击恢复，应用把 `qweather.conf` 以相同密钥加密后写进 `ng.conf.zip`，nginx 每次恢复都会「恢复出」我们的配置，注入天然持久
4. 维护线程低频（30s）巡检，全部只在缺失时补写；`conf.d` 缺失或内容不符时**优先 `systemctl reload trim_nginx`**（SIGHUP 优雅重载，不断开桌面页 WebSocket，且 reload 同样触发 `trim_recover` 从 `ng.conf.zip` 恢复 `conf.d`），仅当 reload 后内容仍不符才退回 `restart` 兜底——避免安装 / 升级 / 自愈时把飞牛桌面「断链」
5. **永远不写 `/usr/trim/www` 下任何文件**

### 层级策略

小组件挂载到飞牛桌面容器（`.desktop` 内的 `.relative.h-full`）内部，使用 `position:absolute + z-index:10`：

```
壁纸(0) ＜ 桌面图标(auto 非定位) ＜ 小组件(10) ＜ 原生窗口(10010+) ＜ 右键菜单(10022) ＜ 全屏界面(1000001)
```

因此所有原生界面天然覆盖小组件，小组件永远不会挡住任何原生控件；卡片之外的区域 `pointer-events:none`，完全点击穿透，不影响桌面操作。

### 设置持久化（NAS 为唯一数据源）

定位城市、卡片位置 / 尺寸 / 透明度、显隐状态等**所有设置只存在 NAS 本机文件** `/vol1/@appdata/com.qweather.widget/settings.json`：

- **读**：`GET /qweather-settings` —— nginx `alias` 直接取该文件（不反代，应用进程挂了也能读），响应带 `cache-control: no-store`
- **写**：`POST /qweather-api/settings` —— nginx `proxy_pass` 到本机 `127.0.0.1:5698/api/settings` 落盘

浏览器 `localStorage` **完全不参与设置的读写**（仅天气数据仍按经纬度做本地缓存）。因此换浏览器、换电脑、清理浏览器缓存后，登录飞牛桌面读到的仍是 NAS 里保存的城市，不会是默认的北京。

之所以不走 fnOS 应用网关 `/app/<name>/api/*`：widget.js 注入在桌面页（非应用 iframe），网关对该页的请求一律返回 13 字节 `invalid token`，设置永远写不进 NAS（v2.3.1 的子域方案同因此失效并静默回退 localStorage）。只有天气数据需要联网，由前端直连 Open-Meteo。

## 📦 安装

### 方式一：FnDepot 应用源（推荐）

在飞牛 fnOS 上安装 [FnDepot](https://github.com/EWEDLCM/FnDepot) 客户端后，添加作者的应用源即可搜索「时钟天气QTWeather」一键安装 / 升级：

```
https://github.com/MisiteQ/FnDepot
```

### 方式二：手动安装 FPK

1. 到 [Releases](https://github.com/MisiteQ/QTWeather/releases) 下载 `com.qweather.widget-3.0.2-x86.fpk`（arm 设备下载 `com.qweather.widget-3.0.2-arm.fpk`）
2. 飞牛 OS → **应用中心** → 左下角 **手动安装** → 选择 fpk 文件
3. 安装完成后，时钟天气卡片即显示在飞牛桌面上（若未显示，强制刷新桌面 `Ctrl+Shift+R`）；点击「已安装」中的应用图标可打开设置中心

> 若「手动安装」入口被关闭，SSH 执行：`appcenter-cli manual-install enable`

## 🛠 从源码打包

需要 Python 3。打包产物架构由 `fpk/manifest` 中的 `platform` 字段决定（`x86` 或 `arm`）。

### 打包指定架构

```bash
# 修改 fpk/manifest 的 platform 字段为目标架构，然后：
python3 build_fp.py
```

### Windows（PowerShell）

```powershell
.\build.ps1
```

### Linux / fnOS

```bash
bash build.sh
```

> 双架构发布：分别将 `platform` 设为 `x86` 和 `arm` 各打包一次，产物为 `com.qweather.widget-3.0.2-x86.fpk` 和 `com.qweather.widget-3.0.2-arm.fpk`。

或直接运行：

```bash
python3 build_fp.py
```

产物：`com.qweather.widget-<version>-x86.fpk`

## 📁 项目结构

```
build_fp.py              FPK 打包脚本（纯 Python，无需 fnpack）
build.ps1 / build.sh     Windows / Linux 打包入口
fpk/
├── manifest             飞牛应用清单（版本、显示名、端口、权限、更新日志）
├── app/
│   ├── app.py           Flask 后端：注入维护 + 天气 / 地理编码 API
│   ├── requirements.txt Python 依赖（Flask、requests、gunicorn）
│   ├── conf/
│   │   └── ng_keys.json ng.conf.zip ZipCrypto 密钥（bkcrack 恢复）
│   ├── static/
│   │   ├── widget.js      桌面小组件前端（注入飞牛桌面运行）
│   │   ├── settings.html  设置中心独立窗口（模块/城市/外观/关于 + 更新检查）
│   │   ├── icon.png       设置中心 Logo / favicon（应用图标另有 ICON.PNG）
│   │   └── cities_cn.json 内置中国城市坐标库
│   └── ui/
│       ├── config       飞牛桌面入口配置（iframe -> fnOS 网关 /app/com-qweather-widget）
│       └── images/      应用图标
├── cmd/                 飞牛生命周期脚本（安装 / 卸载 / 升级 / 启停 / 配置）
├── config/              飞牛权限与资源声明（以 root 运行）
└── wizard/              安装向导
```

## 🔒 隐私与安全

- 天气数据由浏览器前端直连 [Open-Meteo](https://open-meteo.com/) 公开 API 获取，**不经过 NAS 中转、不上传任何个人信息**
- 城市搜索为**双源合并**：中国城市（省/市/县三级 3200+，内置坐标库，来源阿里 DataV GeoAtlas）本地秒搜；国际城市直连 Open-Meteo Geocoding API。Open-Meteo 地理编码对中国中小城市覆盖不足，内置库保证国内地名可搜且坐标准确
- 应用后端仅用于桌面注入维护与备用天气查询，不存储任何用户数据
- `ng_keys.json` 中的密钥为 fnOS 系统 `ng.conf.zip` 的 ZipCrypto 内部密钥（通过已知明文攻击恢复），仅用于在系统恢复包中持久化本应用的 nginx 配置

## 🙏 致谢

- 飞牛 fnOS 与 [FnDepot](https://github.com/EWEDLCM/FnDepot)
- [Open-Meteo](https://open-meteo.com/) 免费天气 API
- [阿里 DataV GeoAtlas](https://datav.aliyun.com/) 中国行政区划坐标数据

## 📋 版本历史

| 版本 | 内容 |
|---|---|
| v3.0.2 | **修复设置界面 Not Found**：修复 build_fp.py 漏打包 `ui/` 目录导致 fpk 中缺少 `ui/config`，应用中心无法构造设置窗口 URL；恢复 `gatewayPrefix` 为 `/app/com-qweather-widget` 匹配 trim_app_center 实际注册前缀；修复启动时旧 gunicorn 进程未清理导致端口冲突、健康检查误判成功的问题 |
| v3.0.1 | **修复设置窗口局域网/域名打不开**：应用窗口改为 fnOS 官方网关 unix socket 同源模式（`https://<host>/app/com.qweather.widget/`），不再直连仅监听 127.0.0.1 的 `http://<host>:5698`（外部设备不可达且 HTTPS 拦截 HTTP 混合内容）；设置中心天气/地理编码/更新检查统一改由 NAS 后端同源代理，规避网关 CSP 限制；nginx `/qweather-api/` 反代合并为统一前缀 |
| v3.0.0 | **设置中心独立窗口 + 模块拆分 + 字号/自定义字体 + 更名换标 + 关于与更新检查**：①点击飞牛「已安装」图标弹出的独立窗口由提示页改为完整**设置中心**（显示模块 / 天气地点与自动刷新 / 外观 / 关于），桌面卡片移除齿轮与全部设置入口；②时间日期与天气**模块拆开独立开关**（至少保留一个）；③外观新增**字号调节**（50%–200%，步进 5 或直接输入，全部文字以 `calc(Npx * var(--qw-fs))` 等比缩放）与**自定义字体上传**（ttf/otf/woff/woff2，≤25MB，4 字节魔数校验，单字体槽存于 NAS `fonts/`，`@font-face` 带版本号破缓存，可恢复默认）；④应用更名「**时钟天气 QTWeather**」并启用全新青绿色时钟·太阳·云图标（64/256、设置中心 Logo 与 favicon）；⑤设置中心新增「**关于**」：版本、作者主页、仓库链接，打开时自动向 GitHub Releases 检查新版本、可手动检查，**仅检查不自动安装**；⑥卡片每 **4 秒轮询** NAS 设置热生效（位置字段只响应「重置为 null」，不与手动拖动打架）；⑦最小尺寸放宽到 240×120，整卡可拖；⑧设置页端点三上下文自适应探测（桌面 vhost 同源 `/qweather-*` / fnOS 网关 iframe 相对路径 / 5698 直连）；⑨窄宽度布局适配修复——此前紧凑模式误把整个预报区块（含「未来预报」标题）变成两列网格，导致标题被挤到左格、预报项溢出卡片右缘，现改为只对预报列表生效并采用自适应列数（窄了自动折行、绝不横向溢出），紧凑阈值由 250px 提到 280px 覆盖大字号；设置中心右侧实时预览底图由紫蓝渐变改为素雅浅冷灰渐变 |
| v2.3.4 | **时钟卡片移植 + 断链修复 + 透明与三色配色 + 更新时间收纳**：①时间 · 天气模块移植自 fnmonitor——卡片主体改为时钟卡片样式，大号时钟（时:分 + 秒，1 秒节拍）+ 完整日期 + 农历（干支年 / 日、闰月），下接天气区块（离线内联 SVG 天气图标 + 温度 + 描述 + 体感 / 湿度 / 风速 / 气压单行汇总），保留 5 天预报、拖动、缩放、透明度与设置面板；天气图标由 emoji 改为按 WMO 代码选择的离线内联 SVG（夜间晴 / 局部多云显示月亮），并修正原实现农历年干支的地支错位（`(yc-4+1000)%12` 因 `1000%12≠0` 使地支整体偏移，2026 年会算成「丙戌」而非「丙午」）；②修复安装 / 升级后桌面反复断链：维护线程原先在 `conf.d` 缺失或不符时 `restart nginx`，会直接杀掉桌面页 WebSocket，改为**优先 `reload`**（优雅重载不断连接，同样触发 `trim_recover` 从 `ng.conf.zip` 恢复 `conf.d`），仍不符才 `restart` 兜底；③透明度滑杆下限由 20% 降到 **0%（可真正全透明）**，透明只作用于卡片底色——磨砂、投影与分隔线随透明度同步淡出，0% 不留磨砂残影，文字 / 图标始终完全不透明，次级文字不透明度整体抬高；④设置面板提供三个取色器——「文字颜色」「图标颜色」与独立的「定位图标」，经 CSS 变量 `--qw-text` / `--qw-icon` / `--qw-pin`（`pinColor` 字段，定位针默认红色 `#e74c3c`）分别控制，定位针与普通图标色互不影响，面板内即时预览、保存写入 NAS `settings.json`，面板自身固定深色避免极端配色下不可读；⑤卡片底部不再显示「更新于 HH:MM」，移入设置面板「自动刷新间隔」下方（文案「天气更新于 HH:MM」，随天气刷新同步），卡片本体更简洁，并清理微小模式对应死规则。定位仍只读 NAS 本机 settings.json，未引入按公网 IP 自动定位 |
| v2.3.3 | **设置唯一数据源改为 NAS settings.json**：彻底移除浏览器 localStorage 参与设置读写——启动时读一次 NAS、改动后写一次 NAS（nginx 同源路由 `/qweather-settings` 读 + `/qweather-api/settings` 写，绕开对桌面页恒返回 invalid token 的应用网关），换浏览器 / 换电脑 / 清缓存后仍恢复 NAS 保存的城市；修复隐藏态（`visible=false`）下恢复按钮在桌面重建后丢失且永不再恢复的缺陷，且本次会话尚未建卡时点恢复按钮也能正确建卡；移除 v2.3.1 子域方案（该子域 DNS 不存在，请求被静默吞掉并回退 localStorage，是「换浏览器定位变回北京」的根因） |
| v2.3.2 | **修复卸载残留**：`uninstall_callback` 增加兜底清理——删除 `conf.d/qweather.conf`、从加密 `ng.conf.zip` 中按原始字节删除该条目（保留其他加密条目不破坏）、删除注入页目录、重启 nginx 恢复桌面路由，解决卸载后孤儿配置永久占用 `location = /` 使桌面路由失效的问题 |
| v2.3.1 | **紧急修复桌面 widget 不显示**：v2.3.0 的 nginx proxy_pass 可能导致 nginx 重启失败使注入页丢失；移除 proxy_pass，settings API 改走应用子域 + CORS 凭据；widget 立即用 localStorage 挂载不等服务端 API（此方案本身有缺陷，已于 v2.3.3 移除） |
| v2.3.0 | **修复设置持久化失效 + 选城市面板关闭**：v2.2.9 的 settings API 走 fnOS 应用网关被 404 拒绝（widget.js 注入在桌面页，非应用 iframe），settings.json 从未写入 NAS；改为 nginx 直接反代 /qweather-api/ → 127.0.0.1:5698/api/ 绕开网关，设置真正落盘。选城市后不再自动关闭设置面板，用户可继续调整后点击保存再自行关闭 |
| v2.2.9 | **设置跨设备同步**：位置、城市、透明度、大小等所有设置存入 NAS 服务端 settings.json，换浏览器/换电脑登录飞牛桌面后自动恢复上次设置 |
| v2.2.8 | **城市搜索修复**：新增内置中国行政区划坐标库（省/市/县三级 3200+，来源阿里 DataV），国内城市本地秒搜且坐标准确，解决 Open-Meteo 对中国中小城市搜不到/搜错的问题；国际城市仍走 Open-Meteo，双源合并去重 |
| v2.2.7 | **跨显示器适配 + 天气缓存**：位置夹取改用卡片实际尺寸，不再伸出屏幕外；卡片尺寸按保存比例缩放，不同显示器自动适配；新增天气数据本地缓存，登录/刷新时秒显上次数据且遵循设置的刷新间隔，不再每次登录都重新拉取 |
| v2.2.6 | **字号优化**：日期时间字号 11px → 14px、底部更新时间 10px → 11px，提升可读性 |
| v2.2.5 | **卡片布局优化**：将「未来预报」区块移至「详情」区块之前，使预报信息更醒目 |
| v2.2.4 | 维护性更新 |
| v2.1.0 | **彻底修复遮挡问题**：小组件挂载到飞牛桌面容器内部（z-index:10），原生窗口 / 右键菜单 / 模态框天然覆盖小组件，永远不挡原生控件；默认位置自动避让桌面图标；卡片右键仍可调出飞牛桌面菜单且定位一致；注入机制重构——nginx 配置经加密 ng.conf.zip 同步以兼容系统自愈，widget.js 由 nginx 直接 alias 提供，维护线程仅「期望内容」核对、不写系统 www 目录，消除 v2.0.0 持续写入触发的系统恢复风暴 |
| v2.0.0 | z-index 降到 9999；pointer-events 隔离；模态设置面板；拖动调整大小；登录检测；www.zip 注入 |

完整日志见 [Releases](https://github.com/MisiteQ/QTWeather/releases)。

## 📄 许可证

[MIT License](LICENSE) © 2026 Misite齊
