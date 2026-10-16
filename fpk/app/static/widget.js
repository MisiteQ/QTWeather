/**
 * 时钟天气 QTWeather 桌面小组件 v3.0.2
 * 直接注入飞牛桌面页面运行，无窗口标题栏
 * 支持：拖动、调整大小、模块独立开关、透明度、文字/图标/定位配色、
 *       字号调节、自定义字体、地点切换、自动刷新、隐藏/恢复
 *
 * v3.0.2: 修复网关路由前缀校验失败导致 Not Found——appname 含点号被 trim_app_center
 *         判定为非法 prefix，改为 /app/qweather 避开校验；修复启动时旧进程未清理
 *         导致端口冲突、健康检查误判成功的问题。
 * v3.0.1: 修复设置窗口在局域网 / 域名访问下打不开——应用窗口改为 fnOS 网关
 *         unix socket 同源模式（https://<host>/app/com.qweather.widget/），
 *         不再直连仅监听 127.0.0.1 的 http://<host>:5698（外部设备根本不可
 *         达，且 HTTPS 桌面页会拦截 HTTP 混合内容）；设置中心的天气/地理
 *         编码/GitHub 更新检查改由 NAS 后端同源代理，规避网关 CSP。
 *
 * v3.0.0: 设置中心移至点击「已安装」图标弹出的独立窗口，桌面卡片移除全部
 *         设置入口（仅展示时钟与天气）；时间日期 / 天气预报模块可独立开关
 *         （至少保留一个）；外观新增字号 50%–200% 与自定义字体上传
 *         （ttf/otf/woff/woff2，文件头魔数校验）；设置中心含「关于」页与
 *         GitHub 版本更新检查；卡片每 4 秒轮询 NAS settings.json 热生效。
 *
 * v2.1.0 重大修复 —— 彻底解决遮挡飞牛桌面图标与原生控件的问题：
 *   - 小组件不再挂在 <body> 下用高 z-index 浮于一切之上；
 *     而是挂载到飞牛桌面容器（.desktop 内的 .relative.h-full）内部，
 *     使用 position:absolute + z-index:10。
 *   - 飞牛原生窗口由窗口管理器赋予 z-index:10010+，原生右键菜单 10022，
 *     Semi 模态框/下拉/气泡/通知均在 1000+，因此所有原生界面天然覆盖
 *     小组件，小组件永远不会挡住任何原生控件。
 *   - 小组件仍然浮于桌面图标之上（图标为非定位元素），root 保持
 *     pointer-events:none，卡片之外的区域完全点击穿透，不影响桌面操作。
 *   - 默认位置自动选择无图标区域（桌面右侧），避免遮挡图标。
 *   - 在卡片上点右键会把事件转发给桌面，仍可调出飞牛桌面右键菜单。
 *
 * v2.0.0: z-index 降到 9999；pointer-events 隔离；模态设置面板；
 *         右下角调整大小；登录界面检测；尺寸自适应。
 */
(function () {
    "use strict";

    // ===== 防止重复注入 =====
    if (window.__QWEATHER_WIDGET_LOADED__) return;
    window.__QWEATHER_WIDGET_LOADED__ = true;

    // ===== 全局错误隔离 =====
    function safe(fn, fallback) {
        try {
            return fn();
        } catch (e) {
            if (typeof console !== "undefined" && console.warn) {
                console.warn("[QWeather]", e);
            }
            return fallback;
        }
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(v, max));
    }

    // ===== 登录界面检测 =====
    // fnOS 是 SPA，登录和桌面共用同一个 index.html。
    // 默认假设是登录界面，只有明确找到桌面元素才认为是桌面。
    function isLoginScreen() {
        var path = window.location.pathname || "";
        var hash = window.location.hash || "";
        if (path.indexOf("/login") !== -1 || path.indexOf("/sign") !== -1) return true;
        if (hash.indexOf("/login") !== -1 || hash.indexOf("/sign") !== -1) return true;

        var desktopSelectors = [
            "[data-desktop-item-id]",
            "[data-desktop-item-context-hotspot]",
            "[data-group-icon-id]",
            "[data-group-panel-id]"
        ];
        for (var i = 0; i < desktopSelectors.length; i++) {
            try {
                if (document.querySelector(desktopSelectors[i])) return false;
            } catch (e) {}
        }

        var loginSelectors = [".login-form", ".gradient-border", "input[type='password']"];
        for (var j = 0; j < loginSelectors.length; j++) {
            try {
                if (document.querySelector(loginSelectors[j])) return true;
            } catch (e) {}
        }

        return true;
    }

    // ===== 飞牛桌面宿主容器检测 =====
    // 真实结构（1920x1080）：
    //   #root > div.relative.flex
    //     > div.absolute.z-0（壁纸）
    //     > div.fixed.z-[1]（左侧 66px Dock）
    //     > div.desktop.z-0.flex-1
    //       > div.relative.box-border.h-full.pl-[66px]   ← 挂载点（图标网格 + 原生窗口都在这里）
    function findDesktopHost() {
        try {
            var host = document.querySelector(".desktop .relative.h-full");
            if (host && host.querySelector(
                "[data-desktop-item-id],[data-desktop-item-context-hotspot]")) {
                return host;
            }
            var icon = document.querySelector("[data-desktop-item-id]");
            if (icon) {
                var n = icon;
                while (n && !(n.classList && n.classList.contains("desktop"))) {
                    n = n.parentElement;
                }
                if (n) return n.querySelector(".relative.h-full");
            }
        } catch (e) {}
        return null;
    }

    // ===== API（直连 Open-Meteo，CORS 开放，无需 Key / 无需经 NAS 网关） =====
    var DIRECT_WEATHER = "https://api.open-meteo.com/v1/forecast";
    // 地点搜索只存在于独立设置窗口（settings.html），卡片本体不再内建搜索。
    // 设置持久化：唯一数据源是 NAS 本机 settings.json，由 nginx 同源
    // 直接提供（/qweather-settings 读、/qweather-api/settings 写），
    // 纯相对路径——IP 访问与域名访问都可用，也不需要 CORS/凭据。
    // （fnOS 应用网关 /app/<name>/api/* 对桌面页一律回 invalid token，
    //  故不能走网关。）
    // 浏览器 localStorage 完全不参与设置的读写——换浏览器、换电脑、
    // 清缓存后，城市定位等设置一律从 NAS 读取。
    var SETTINGS_GET = "/qweather-settings";
    var SETTINGS_POST = "/qweather-api/settings";
    // 用户自定义字体（上传/删除由独立设置窗口完成，这里只负责读取渲染）
    var FONT_API = "/qweather-api/font";
    // 城市库仅独立设置窗口的搜索功能使用（/qweather-cities.json）。

    // ===== 配置常量 =====
    // 仅天气数据做浏览器侧缓存（按经纬度键控）；设置不进浏览器缓存。
    var WEATHER_CACHE_KEY = "qweather_widget_weather_cache";
    var SCHEMA_VERSION = 2;
    var DEFAULT_SETTINGS = {
        schemaV: SCHEMA_VERSION,
        location: { name: "北京", latitude: 39.9042, longitude: 116.4074, country: "中国" },
        opacity: 85,          // 仅作用于卡片底色（0 = 背景全透明，文字/图标始终不透明）
        textColor: "#1a1a2e", // 文字颜色
        iconColor: "#1a1a2e", // 图标颜色（天气/预报）
        pinColor: "#e74c3c",  // 定位图标颜色（城市名左侧定位针，独立配色）
        fontScale: 100,       // 全局字号百分比（50–200，100 = 设计默认字号）
        fontName: null,       // 自定义字体原始文件名（null = 系统默认字体）
        fontExt: null,        // 自定义字体扩展名（.ttf/.otf/.woff/.woff2）
        fontV: null,          // 自定义字体版本戳（破缓存）
        showClock: true,      // 时间日期模块（时钟 + 公历 + 农历）
        showWeather: true,    // 天气预报模块（城市 + 实时天气 + 5 天预报）
        refreshInterval: 30,
        position: null,   // 相对桌面宿主容器的坐标 {x, y}
        visible: true,
        width: 340,
        height: null
    };

    // ===== WMO 天气代码 → 中文描述 =====
    var WEATHER_CODES = {
        0: "晴", 1: "大部晴朗", 2: "局部多云", 3: "阴",
        45: "雾", 48: "雾凇",
        51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
        56: "冻毛毛雨", 57: "强冻毛毛雨",
        61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
        71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
        80: "小阵雨", 81: "阵雨", 82: "强阵雨",
        85: "小阵雪", 86: "强阵雪",
        95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"
    };
    function weatherDesc(code) {
        return WEATHER_CODES[code] || "未知";
    }

    // ===== 天气图标：按 WMO 代码选离线内联 SVG（移植自 fnmonitor） =====
    // 全离线、无外链；day=0（夜间）时晴/大部晴朗显示月亮。
    function wxIconSvg(code, day) {
        var c = +code;
        var sun = '<circle cx="30" cy="16" r="6"/>' +
            '<path d="M30 5.5v2.2M38.8 9.2l-1.6 1.6M41.5 16h-2.2M21.2 9.2l1.6 1.6"/>';
        function cloud(x) {
            x = x || 0;
            return '<path d="M' + (14 + x) + ' 38h18a7 7 0 0 0 .9-13.94A9.5 9.5 0 0 0 ' +
                (14.6 + x) + ' 26 6 6 0 0 0 ' + (14 + x) + ' 38Z" style="fill:#fff"/>';
        }
        var g;
        if (c <= 1) {
            g = day === 0
                ? '<path d="M33 30A11 11 0 1 1 20 13a8.5 8.5 0 0 0 13 17Z"/>'
                : '<circle cx="24" cy="24" r="8"/>' +
                  '<path d="M24 8v3M24 37v3M8 24h3M37 24h3M12.7 12.7l2.1 2.1M33.2 33.2l2.1 2.1' +
                  'M12.7 35.3l2.1-2.1M33.2 14.8l2.1-2.1"/>';
        } else if (c === 2) g = sun + cloud();
        else if (c === 3) g = cloud(2);
        else if (c === 45 || c === 48) g = '<path d="M9 18h30M6 25h36M9 32h30"/>';
        else if (c >= 95) g = cloud(2) + '<path d="m25 38-3 5h5l-3 5"/>';
        else if ((c >= 71 && c <= 77) || c === 85 || c === 86) {
            g = cloud(2) + '<path d="M18 42v.1M25 44v.1M32 42v.1"/>';
        } else {
            g = cloud(2) + '<path d="m18 41-1.5 3.5M25 41l-1.5 3.5M32 41l-1.5 3.5"/>';
        }
        return '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + g + '</svg>';
    }

    // ===== 农历与干支（移植自 fnmonitor，算法原样保留） =====
    function lunarInfo(y, m, d) {
        var LUNAR_DAYS = [0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
            0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
            0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
            0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
            0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
            0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
            0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
            0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
            0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
            0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
            0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
            0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
            0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
            0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
            0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0];
        var LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
        var LUNAR_DAYS2 = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
            "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
            "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
        var GAN = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
        var ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
        function lYearDays(y) { var s = 348; for (var i = 0x8000; i > 0x8; i >>= 1) s += (LUNAR_DAYS[y - 1900] & i) ? 1 : 0; return s + leapDays(y); }
        function leapMonth(y) { return LUNAR_DAYS[y - 1900] & 0xf; }
        function leapDays(y) { if (leapMonth(y)) return (LUNAR_DAYS[y - 1900] & 0x10000) ? 30 : 29; return 0; }
        function lMonthDays(y, m) { return (LUNAR_DAYS[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
        var base = Date.UTC(1900, 0, 31);
        var offset = Math.floor((Date.UTC(y, m - 1, d) - base) / 86400000);
        var yc = 1900, mc = 0, sub = 0;
        // 注意：循环变量在每次迭代末尾自增，回补时必须用「本次实际扣减的天数」，
        // 不能用自增后年份/月份的天数（相邻年/月天数不同会导致日期错位）
        for (yc = 1900; yc < 2101 && offset > 0; yc++) { sub = lYearDays(yc); offset -= sub; }
        if (offset < 0) { offset += sub; yc--; }
        var leap = leapMonth(yc);
        var isLeap = false;
        for (mc = 1; mc < 13 && offset > 0; mc++) {
            if (leap > 0 && mc === (leap + 1) && !isLeap) { --mc; isLeap = true; sub = leapDays(yc); }
            else { sub = lMonthDays(yc, mc); if (isLeap) isLeap = false; }
            offset -= sub;
        }
        if (offset === 0 && leap > 0 && mc === (leap + 1)) { if (isLeap) { isLeap = false; } else { isLeap = true; --mc; } }
        if (offset < 0) { offset += sub; --mc; }
        // 年干支：以 1900 年（庚子）为锚点。注意不能像 fnmonitor 那样写成
        // (yc - 4 + 1000) % 12 —— 1000 % 12 = 4 ≠ 0，会把地支整体错位
        // （2026 年会算成「丙戌」而非「丙午」）。yc ≥ 1900 时 yc-4 恒为正，
        // 直接取模即可。
        var gzY = GAN[(yc - 4) % 10] + ZHI[(yc - 4) % 12];
        var md = LUNAR_MONTHS[mc - 1] + "月";
        var dd = LUNAR_DAYS2[offset];
        // 日干支：以 1949-10-01 甲子日（Unix 第 -7397 天）为锚点，常数 +17，正模避免负数
        var dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
        var gzD = GAN[((dayNum + 17) % 10 + 10) % 10] + ZHI[((dayNum + 17) % 12 + 12) % 12];
        return { y: yc, m: mc, d: offset + 1, monthName: md, dayName: dd, gzY: gzY, gzD: gzD, isLeap: isLeap };
    }
    function lunarText(now) {
        var li = lunarInfo(now.getFullYear(), now.getMonth() + 1, now.getDate());
        return (li.isLeap ? "闰" : "") + li.monthName + li.dayName + " · " + li.gzY + "年 " + li.gzD;
    }

    var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    var _lunarDay = null;   // 农历按「天」缓存，避免每秒重算

    // ===== 全局状态 =====
    var settings = {};
    var refreshTimer = null;
    var watchdogTimer = null;
    var loginCheckTimer = null;
    var hostEl = null;
    var root = null;
    var card = null;
    var showBtn = null;

    // ===== 作用域样式表 =====
    // 层级策略（根 z-index:10，位于桌面宿主内部）：
    //   壁纸 0 ＜ 桌面图标(auto 非定位) ＜ 小组件 10 ＜ 原生窗口 10010 ＜
    //   右键菜单 10022 ＜ 全屏界面 1000001
    var SCOPED_CSS = [
        "#qweather-root{position:absolute;z-index:10;font-family:'QwUserFont',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:var(--qw-text,#1a1a2e);pointer-events:none;user-select:none;}",
        "#qweather-root *{margin:0;padding:0;box-sizing:border-box;}",

        // 卡片底色 / 模糊 / 投影全部走 CSS 变量，由 applyOpacity() 统一驱动：
        // 三者同步淡出，滑到 0% 时背景彻底透明且不留磨砂残影——而文字、
        // 图标、分隔线之外的内容始终完全不透明（它们不吃这些变量）。
        "#qweather-root .qw-card{pointer-events:auto;width:340px;min-width:240px;min-height:120px;border-radius:20px;background:rgba(255,255,255,var(--qw-bg,0.85));backdrop-filter:blur(var(--qw-blur,20px));-webkit-backdrop-filter:blur(var(--qw-blur,20px));box-shadow:0 8px 32px rgba(0,0,0,var(--qw-shadow,0.2));padding:18px 22px 16px;display:flex;flex-direction:column;transition:box-shadow 0.3s ease,transform 0.1s ease;position:relative;overflow:hidden;cursor:grab;}",
        "#qweather-root .qw-card:hover{box-shadow:0 12px 40px rgba(0,0,0,calc(var(--qw-shadow,0.2) * 1.5));}",
        "#qweather-root .qw-card:active{cursor:grabbing;}",

        // ===== 模块开关：时间日期 / 天气预报可独立显隐（在独立设置窗口中配置） =====
        "#qweather-root .qw-card.qw-no-clock .qw-clock{display:none;}",
        "#qweather-root .qw-card.qw-no-weather .qw-header,#qweather-root .qw-card.qw-no-weather .qw-wx,#qweather-root .qw-card.qw-no-weather .qw-forecast{display:none;}",
        "#qweather-root .qw-card.qw-no-weather .qw-clock{margin-top:0;}",
        "#qweather-root .qw-card.qw-no-clock .qw-wx{margin-top:0;padding-top:0;border-top:none;}",
        "#qweather-root .qw-card.qw-compact .qw-clock-lunar{display:none;}",
        "#qweather-root .qw-card.qw-compact .qw-forecast-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(54px,1fr));gap:6px;}",
        "#qweather-root .qw-card.qw-tiny .qw-clock-lunar,#qweather-root .qw-card.qw-tiny .qw-wx-sub,#qweather-root .qw-card.qw-tiny .qw-wx-text,#qweather-root .qw-card.qw-tiny .qw-forecast{display:none;}",
        "#qweather-root .qw-card.qw-tiny .qw-clock-time{font-size:calc(38px * var(--qw-fs,1));}",
        "#qweather-root .qw-card.qw-tiny .qw-wx-temp{font-size:calc(34px * var(--qw-fs,1));}",

        "#qweather-root .qw-header{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
        "#qweather-root .qw-location-info{display:flex;align-items:center;gap:6px;flex:1;min-width:0;}",
        "#qweather-root .qw-location-icon{width:18px;height:18px;flex-shrink:0;color:var(--qw-pin,#e74c3c);}",
        "#qweather-root .qw-location-name{font-size:calc(16px * var(--qw-fs,1));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",

        // ===== 时钟 + 农历（时钟卡片风格，移植自 fnmonitor） =====
        "#qweather-root .qw-clock{margin-top:14px;}",
        "#qweather-root .qw-clock-time{display:flex;align-items:flex-end;gap:6px;font-size:calc(52px * var(--qw-fs,1));font-weight:200;line-height:1;letter-spacing:-2px;}",
        "#qweather-root .qw-clock-time .qw-sec{font-size:calc(16px * var(--qw-fs,1));font-weight:500;opacity:0.6;letter-spacing:0;margin-bottom:7px;}",
        "#qweather-root .qw-clock-date{margin-top:10px;font-size:calc(14px * var(--qw-fs,1));font-weight:600;}",
        "#qweather-root .qw-clock-lunar{margin-top:2px;font-size:calc(12px * var(--qw-fs,1));opacity:0.72;}",

        // ===== 天气区块（图标 + 温度 + 描述 + 体感/湿度/风速/气压） =====
        "#qweather-root .qw-wx{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,calc(var(--qw-shadow,0.2) * 0.4));}",
        "#qweather-root .qw-wx-ico{grid-row:span 2;width:46px;height:46px;color:var(--qw-icon,#1a1a2e);}",
        "#qweather-root .qw-wx-ico svg{width:46px;height:46px;stroke-width:1.4;}",
        "#qweather-root .qw-wx-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}",
        "#qweather-root .qw-wx-temp{font-size:calc(30px * var(--qw-fs,1));font-weight:300;line-height:1;letter-spacing:-1px;}",
        "#qweather-root .qw-temp-unit{font-size:calc(15px * var(--qw-fs,1));font-weight:300;opacity:0.8;}",
        "#qweather-root .qw-wx-text{font-size:calc(14px * var(--qw-fs,1));opacity:0.85;}",
        "#qweather-root .qw-wx-sub{font-size:calc(12px * var(--qw-fs,1));opacity:0.72;}",

        "#qweather-root .qw-forecast{margin-bottom:8px;flex:1;}",
        "#qweather-root .qw-forecast-title{font-size:calc(11px * var(--qw-fs,1));opacity:0.62;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;}",
        "#qweather-root .qw-forecast-list{display:flex;justify-content:space-between;gap:2px;}",
        "#qweather-root .qw-forecast-item{flex:1;text-align:center;padding:6px 2px;border-radius:8px;transition:background 0.2s;}",
        "#qweather-root .qw-forecast-item:hover{background:rgba(0,0,0,0.05);}",
        "#qweather-root .qw-forecast-day{font-size:calc(10px * var(--qw-fs,1));opacity:0.72;margin-bottom:2px;}",
        "#qweather-root .qw-forecast-icon{height:20px;margin-bottom:2px;color:var(--qw-icon,#1a1a2e);}",
        "#qweather-root .qw-forecast-icon svg{width:20px;height:20px;stroke-width:1.6;}",
        "#qweather-root .qw-forecast-temp{font-size:calc(11px * var(--qw-fs,1));font-weight:600;}",
        "#qweather-root .qw-forecast-temp .qw-min{opacity:0.65;font-weight:400;}",

        "#qweather-root .qw-resize-handle{position:absolute;right:4px;bottom:4px;width:18px;height:18px;cursor:nwse-resize;pointer-events:auto;z-index:5;border-radius:6px;background:rgba(91,110,225,0.04);}",
        "#qweather-root .qw-resize-handle::after{content:none;display:none;}",

        "#qweather-show{position:absolute;right:18px;bottom:18px;z-index:10;width:42px;height:42px;border-radius:50%;border:none;background:rgba(91,110,225,0.92);color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(91,110,225,0.4);display:flex;align-items:center;justify-content:center;pointer-events:auto;}"
    ].join("\n");

    function injectStylesheet() {
        if (document.getElementById("qweather-styles")) return;
        var style = document.createElement("style");
        style.id = "qweather-styles";
        style.textContent = SCOPED_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ===== 设置读写（NAS settings.json 为唯一数据源） =====
    // 只在两个时机访问服务端：启动时读一次、用户改动后写一次。
    // 不做任何 localStorage 读写——换浏览器/换电脑/清缓存后设置不变。
    var _saveTimer = null;

    // 启动时从 NAS 读取设置；NAS 无记录或请求失败返回 null（调用方用默认值）。
    function loadSettings() {
        return fetch(SETTINGS_GET, { credentials: "same-origin", cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.location) return null;
                var s = Object.assign({}, DEFAULT_SETTINGS, data);
                s.schemaV = SCHEMA_VERSION;
                // 字号越界钳制（50–200），非法值回落到 100
                var fs = parseInt(s.fontScale, 10);
                s.fontScale = (isNaN(fs) ? 100 : clamp(fs, 50, 200));
                if (!data.schemaV && s.position) {
                    s.position = { x: s.position.x - 66, y: s.position.y };
                }
                return s;
            })
            .catch(function (e) {
                console.warn("[qweather] 读取 NAS 设置失败:", e);
                return null;
            });
    }

    // 写回 NAS settings.json。失败必须可见（绝不再静默退回浏览器缓存）。
    function saveSettings() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            _saveTimer = null;
            fetch(SETTINGS_POST, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings)
            }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            }).then(function (d) {
                if (!d || d.ok !== true) {
                    throw new Error((d && d.error) || "服务端返回异常");
                }
            }).catch(function (e) {
                console.warn("[qweather] 保存到 NAS 失败:", e);
                showToast("保存到 NAS 失败，设置未生效");
            });
        }, 400);
    }

    function $(sel, ctx) {
        return (ctx || root).querySelector(sel);
    }

    function showToast(msg) {
        safe(function () {
            var toast = document.createElement("div");
            toast.style.cssText =
                "position:fixed;top:24px;left:50%;transform:translateX(-50%);" +
                "background:rgba(0,0,0,0.75);color:#fff;padding:10px 20px;border-radius:10px;" +
                "font-size:14px;z-index:2147483647;" +
                "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
            toast.textContent = msg;
            document.body.appendChild(toast);
            setTimeout(function () {
                toast.style.opacity = "0";
                toast.style.transition = "opacity 0.3s";
                setTimeout(function () {
                    if (toast.parentNode) toast.remove();
                }, 300);
            }, 2000);
        });
    }

    // ===== 创建小组件 DOM =====
    function buildWidget() {
        safe(function () {
            if (root && document.documentElement.contains(root)) {
                // 已在文档中：只做一次重挂/定位，避免重复创建第二份 DOM
                root.style.display = "";
                ensureMounted();
                placeWidget();
                return;
            }
            root = document.createElement("div");
            root.id = "qweather-root";

            card = document.createElement("div");
            card.className = "qw-card";

            if (settings.width) card.style.width = settings.width + "px";
            if (settings.height) card.style.height = settings.height + "px";

            card.innerHTML =
                '<div class="qw-header">' +
                '  <div class="qw-location-info">' +
                '    <svg class="qw-location-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
                '      <circle cx="12" cy="10" r="3"/>' +
                '    </svg>' +
                '    <span class="qw-location-name" id="qw-location-name">加载中...</span>' +
                '  </div>' +
                '</div>' +
                '<div class="qw-clock">' +
                '  <div class="qw-clock-time">' +
                '    <span id="qw-time-label">--:--</span>' +
                '    <span class="qw-sec" id="qw-sec-label">:--</span>' +
                '  </div>' +
                '  <div class="qw-clock-date" id="qw-date-label">--</div>' +
                '  <div class="qw-clock-lunar" id="qw-lunar-label">农历 --</div>' +
                '</div>' +
                '<div class="qw-wx">' +
                '  <div class="qw-wx-ico" id="qw-weather-icon"></div>' +
                '  <div class="qw-wx-main">' +
                '    <span class="qw-wx-temp" id="qw-temp-value">--</span>' +
                '    <span class="qw-temp-unit">°C</span>' +
                '    <span class="qw-wx-text" id="qw-weather-desc">加载中...</span>' +
                '  </div>' +
                '  <div class="qw-wx-sub" id="qw-wx-sub">体感 --° · 湿度 --% · 风速 -- km/h · 气压 -- hPa</div>' +
                '</div>' +
                '<div class="qw-forecast">' +
                '  <div class="qw-forecast-title">未来预报</div>' +
                '  <div class="qw-forecast-list" id="qw-forecast-list"></div>' +
                '</div>' +
                '<div class="qw-resize-handle" id="qw-resize-handle" title="拖动调整大小"></div>';

            root.appendChild(card);

            $("#qw-location-name").textContent = settings.location.name;
            applyTheme();
            applyOpacity();
            applyFontScale();
            applyModules();
            ensureFontFace();
            updateClock();

            if (ensureMounted()) {
                placeWidget();
                updateCompactMode();
                // 首次挂载时若未保存尺寸比例，则按当前宿主尺寸计算并持久化，
                // 以便在不同显示器上按比例缩放适配。
                if (hostEl && (typeof settings.widthRatio !== "number" ||
                               typeof settings.heightRatio !== "number")) {
                    var hr0 = hostEl.getBoundingClientRect();
                    if (hr0.width && hr0.height) {
                        settings.widthRatio = clamp(
                            (settings.width || card.offsetWidth || 340) / hr0.width, 0.15, 0.8);
                        settings.heightRatio = clamp(
                            (settings.height || card.offsetHeight || 498) / hr0.height, 0.15, 0.8);
                        saveSettings();
                    }
                }
            }

            setupDrag(card);
            setupResize($("#qw-resize-handle"));
            setupDesktopContextForward();

            window.addEventListener("resize", onWindowResize);
        });
    }

    // ===== 挂载 / 定位（宿主坐标） =====
    function ensureMounted() {
        return safe(function () {
            hostEl = findDesktopHost();
            if (!hostEl) return false;
            if (!hostEl.contains(root)) {
                hostEl.insertBefore(root, hostEl.firstChild);
            }
            return true;
        }, false);
    }

    // 返回当前卡片的实际宽高（优先读取已渲染尺寸，回退到 settings）
    function getCardSize() {
        var w = (card && card.offsetWidth) || settings.width || 340;
        var h = (card && card.offsetHeight) || settings.height || 498;
        return { w: w, h: h };
    }

    function resolvePositionPx() {
        if (!hostEl) return null;
        var hr = hostEl.getBoundingClientRect();
        var size = getCardSize();
        var pos = settings.position || {};
        // 安全边距：保证卡片完整留在宿主内
        var maxX = Math.max(0, hr.width - size.w);
        var maxY = Math.max(0, hr.height - size.h);
        if (typeof pos.xRatio === "number" && typeof pos.yRatio === "number") {
            return {
                x: clamp(pos.xRatio * hr.width, 0, maxX),
                y: clamp(pos.yRatio * hr.height, 0, maxY)
            };
        }
        if (typeof pos.x === "number" && typeof pos.y === "number") {
            return {
                x: clamp(pos.x, 0, maxX),
                y: clamp(pos.y, 0, maxY)
            };
        }
        return null;
    }

    function savePosition() {
        if (!hostEl || !root) return;
        var hr = hostEl.getBoundingClientRect();
        settings.position = {
            x: root.offsetLeft,
            y: root.offsetTop,
            xRatio: hr.width ? root.offsetLeft / hr.width : 0,
            yRatio: hr.height ? root.offsetTop / hr.height : 0
        };
        saveSettings();
    }

    function getIconRects() {
        var hr = hostEl.getBoundingClientRect();
        var rects = [];
        var icons = hostEl.querySelectorAll("[data-desktop-item-id]");
        for (var i = 0; i < icons.length; i++) {
            var r = icons[i].getBoundingClientRect();
            rects.push({
                x: Math.round(r.x - hr.left), y: Math.round(r.y - hr.top),
                w: Math.round(r.width), h: Math.round(r.height)
            });
        }
        return rects;
    }

    function placeWidget() {
        safe(function () {
            var hr = hostEl.getBoundingClientRect();
            var size = getCardSize();
            var cw = size.w;
            var ch = size.h;
            cw = Math.min(cw, hr.width - 4);
            ch = Math.min(ch, hr.height - 4);

            var pos = resolvePositionPx();
            if (settings.position && pos) {
                var maxX = Math.max(0, hr.width - cw);
                var maxY = Math.max(0, hr.height - ch);
                var x = clamp(pos.x, 0, maxX);
                var y = clamp(pos.y, 0, maxY);
                root.style.left = x + "px";
                root.style.top = y + "px";
                return;
            }
            applyDefaultPosition(hr, cw, ch);
        });
    }

    function applyDefaultPosition(hr, cw, ch) {
        var margin = 24;
        var occupied = getIconRects();
        function overlaps(x, y) {
            for (var i = 0; i < occupied.length; i++) {
                var r = occupied[i];
                if (!(x + cw <= r.x || x >= r.x + r.w ||
                      y + ch <= r.y || y >= r.y + r.h)) return true;
            }
            return false;
        }

        var maxX = Math.max(0, hr.width - cw);
        var maxY = Math.max(0, hr.height - ch);
        var candidates = [
            [maxX - margin, (hr.height - ch) / 2],
            [maxX - margin, margin],
            [maxX - margin, maxY - margin]
        ];
        for (var x = maxX - margin; x >= margin; x -= 120) {
            for (var y = margin; y <= maxY - margin; y += 40) {
                candidates.push([x, y]);
            }
        }
        for (var i = 0; i < candidates.length; i++) {
            var cx = clamp(candidates[i][0], 0, maxX);
            var cy = clamp(candidates[i][1], 0, maxY);
            if (!overlaps(cx, cy)) {
                root.style.left = cx + "px";
                root.style.top = cy + "px";
                savePosition();
                return;
            }
        }
        root.style.left = clamp(maxX - margin, 0, maxX) + "px";
        root.style.top = clamp((hr.height - ch) / 2, 0, maxY) + "px";
        savePosition();
    }

    function onWindowResize() {
        safe(function () {
            if (!root || !hostEl) return;
            var hr = hostEl.getBoundingClientRect();

            // 若保存了尺寸比例，则按比例缩放卡片以适配不同显示器；
            // 否则保持绝对像素尺寸（旧版/未手动调整过大小的情况）。
            if (card) {
                var useRatio = typeof settings.widthRatio === "number" &&
                               typeof settings.heightRatio === "number";
                if (useRatio && hr.width && hr.height) {
                    var rw = clamp(settings.widthRatio, 0.15, 0.8);
                    var rh = clamp(settings.heightRatio, 0.15, 0.8);
                    card.style.width = Math.round(hr.width * rw) + "px";
                    card.style.height = Math.round(hr.height * rh) + "px";
                } else if (settings.width) {
                    // 绝对像素尺寸：直接应用，但不超过宿主
                    card.style.width = Math.min(settings.width, hr.width - 4) + "px";
                    if (settings.height) {
                        card.style.height = Math.min(settings.height, hr.height - 4) + "px";
                    }
                }
            }

            var size = getCardSize();
            var maxX = Math.max(0, hr.width - size.w);
            var maxY = Math.max(0, hr.height - size.h);
            var pos = resolvePositionPx();
            var x = clamp(pos ? pos.x : root.offsetLeft, 0, maxX);
            var y = clamp(pos ? pos.y : root.offsetTop, 0, maxY);
            root.style.left = x + "px";
            root.style.top = y + "px";
            updateCompactMode();
        });
    }

    // ===== 右键转发：在卡片上右键仍可调出飞牛桌面菜单 =====
    // 转发完整序列（mousedown/contextmenu/mouseup，仅右键 button===2）。
    // fnOS 菜单（bU + MUI Popper + popper.js）在真实事件下能正常定位，
    // 但合成事件触发时 Popper 的锚点初始化时序导致 popper.js 不执行，
    // 菜单会停在 fixed 0,0。用 repairContextMenuPosition 自愈：
    // 按锚点盒真实位置补上与 popper.js 等价的 transform。
    function setupDesktopContextForward() {
        safe(function () {
            function forward(e) {
                if (e.button !== 2) return;
                e.preventDefault();
                e.stopPropagation();
                card.style.pointerEvents = "none";
                var under = document.elementFromPoint(e.clientX, e.clientY);
                card.style.pointerEvents = "";
                if (under && !under.closest("#qweather-root")) {
                    var clickX = e.clientX, clickY = e.clientY;
                    var ne = new MouseEvent(e.type, {
                        bubbles: true, cancelable: true, view: window,
                        clientX: clickX, clientY: clickY,
                        screenX: e.screenX, screenY: e.screenY,
                        button: 2, buttons: e.type === "mouseup" ? 0 : 2
                    });
                    // fnOS 菜单定位读取的是 event.x / event.y（而非 clientX/clientY），
                    // 合成事件必须显式补齐这个别名
                    try {
                        Object.defineProperty(ne, "x", {
                            get: function () { return clickX; }
                        });
                        Object.defineProperty(ne, "y", {
                            get: function () { return clickY; }
                        });
                    } catch (defErr) {}
                    under.dispatchEvent(ne);
                    if (e.type === "contextmenu") {
                        repairContextMenuPosition(clickX, clickY);
                    }
                }
            }
            card.addEventListener("mousedown", forward, true);
            card.addEventListener("contextmenu", forward, true);
            card.addEventListener("mouseup", forward, true);
        });
    }

    // 找到本次右键对应的 bU 锚点盒（class 含 mt-[2px] absolute 的 0 尺寸 div）
    function findMenuAnchor(clickX, clickY) {
        var best = null, bestDist = 40;
        var all = document.querySelectorAll("div");
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var cls = el.className || "";
            if (typeof cls !== "string" || cls.indexOf("mt-[2px]") < 0 ||
                cls.indexOf("absolute") < 0) continue;
            var r = el.getBoundingClientRect();
            var d = Math.abs(r.left - clickX) + Math.abs(r.top - clickY);
            if (d < bestDist) { bestDist = d; best = el; }
        }
        return best;
    }

    // 修正卡在 (0,0) 的菜单 Popper
    function repairContextMenuPosition(clickX, clickY) {
        var attempts = 0;
        var timer = setInterval(function () {
            safe(function () {
                attempts++;
                var anchor = findMenuAnchor(clickX, clickY);
                if (!anchor) {
                    if (attempts >= 10) clearInterval(timer);
                    return;
                }
                var ar = anchor.getBoundingClientRect();
                var ax = Math.round(ar.left), ay = Math.round(ar.top);

                // 找该锚点对应的、卡在 fixed 0,0 的菜单 Popper
                var pops = document.querySelectorAll(".base-Popper-root");
                var anyStuck = false;
                for (var i = 0; i < pops.length; i++) {
                    var pop = pops[i];
                    var st = pop.style;
                    if (st.position !== "fixed") continue; // popper.js 已自行处理
                    anyStuck = true;
                    if (pop.getAttribute("data-qw-patched") &&
                        st.transform.indexOf(ax + "px") >= 0) continue;
                    st.position = "absolute";
                    st.top = "0px";
                    st.left = "0px";
                    st.transform = "translate(" + ax + "px," + ay + "px)";
                    pop.setAttribute("data-qw-patched", "1");
                    watchPatchedPopper(pop, ax, ay);
                }

                if (!anyStuck || attempts >= 10) clearInterval(timer);
            });
            if (attempts >= 10) clearInterval(timer);
        }, 60);
    }

    // 若 fnOS 后续渲染把补丁冲掉，自动补回；菜单移除后停止
    function watchPatchedPopper(pop, ax, ay) {
        if (pop.__qwObs) return;
        var obs = new MutationObserver(function () {
            safe(function () {
                if (!document.body.contains(pop)) {
                    obs.disconnect();
                    pop.__qwObs = null;
                    return;
                }
                var st = pop.style;
                if (st.position === "fixed" || !st.transform) {
                    st.position = "absolute";
                    st.top = "0px";
                    st.left = "0px";
                    st.transform = "translate(" + ax + "px," + ay + "px)";
                }
            });
        });
        obs.observe(pop, { attributes: true, attributeFilter: ["style"] });
        pop.__qwObs = obs;
    }

    // ===== 模块开关 / 字号 / 自定义字体（全部由独立设置窗口写入 NAS，这里只负责应用） =====
    function applyModules() {
        if (!card) return;
        // 两个模块至少保留一个：异常配置（都关）时回退为都显示
        var clock = settings.showClock !== false;
        var wx = settings.showWeather !== false;
        if (!clock && !wx) { clock = true; wx = true; }
        card.classList.toggle("qw-no-clock", !clock);
        card.classList.toggle("qw-no-weather", !wx);
    }

    function applyFontScale() {
        if (!root) return;
        var fs = parseInt(settings.fontScale, 10);
        if (isNaN(fs)) fs = 100;
        root.style.setProperty("--qw-fs", (clamp(fs, 50, 200) / 100).toFixed(3));
    }

    // 用户自定义字体：读 NAS 上的单字体槽（/qweather-api/font，经 nginx 同源反代）。
    // fontV 变化（重新上传/删除）时重建 @font-face；未设置字体时移除声明，回退系统字体。
    var _fontFaceStyle = null;
    var _fontKey = "";
    function ensureFontFace() {
        var key = settings.fontName && settings.fontExt
            ? settings.fontExt + ":" + (settings.fontV || 1) : "";
        if (key === _fontKey) return;
        _fontKey = key;
        if (_fontFaceStyle) {
            _fontFaceStyle.parentNode.removeChild(_fontFaceStyle);
            _fontFaceStyle = null;
        }
        if (!key) return;
        var fmtMap = {
            ".ttf": "truetype", ".otf": "opentype",
            ".woff": "woff", ".woff2": "woff2"
        };
        _fontFaceStyle = document.createElement("style");
        _fontFaceStyle.id = "qw-font-face";
        _fontFaceStyle.textContent =
            "@font-face{font-family:'QwUserFont';src:url('" + FONT_API +
            "?v=" + (settings.fontV || 1) + "') format('" +
            (fmtMap[settings.fontExt] || "truetype") +
            "');font-display:swap;}";
        (document.head || document.documentElement).appendChild(_fontFaceStyle);
        // 主动触发一次字体加载，避免首帧 FOIT
        safe(function () {
            if (document.fonts && document.fonts.load) {
                document.fonts.load("16px 'QwUserFont'").catch(function () {});
            }
        });
    }

    // 背景不透明度：只调卡片底色，文字/图标始终完全不透明。
    //   滑到 0%  → 背景彻底透明（纯文字悬浮）
    //   低值     → 磨砂（backdrop-filter）与投影同步淡出，不留生硬残影
    // 三个变量都写在 root 上，卡片样式表统一引用（见 SCOPED_CSS）。
    function applyOpacity() {
        if (!root) return;
        var a = clamp(settings.opacity, 0, 100) / 100;
        root.style.setProperty("--qw-bg", String(a));
        root.style.setProperty("--qw-blur", (a * 20).toFixed(1) + "px");
        root.style.setProperty("--qw-shadow", (a * 0.2).toFixed(3));
    }

    // 文字 / 图标配色：写成 CSS 变量供样式表引用；设置面板自身固定深色不受影响。
    // 定位针单独走 --qw-pin，与普通图标色 --qw-icon 互不影响。
    function applyTheme() {
        if (!root) return;
        root.style.setProperty("--qw-text", settings.textColor || "#1a1a2e");
        root.style.setProperty("--qw-icon", settings.iconColor || "#1a1a2e");
        root.style.setProperty("--qw-pin", settings.pinColor || "#e74c3c");
    }

    // 时钟：时:分 + 秒 + 日期 + 农历（农历按天缓存，1 秒节拍不重复计算）
    function updateClock() {
        safe(function () {
            var now = new Date();
            var timeLabel = document.getElementById("qw-time-label");
            var secLabel = document.getElementById("qw-sec-label");
            var dateLabel = document.getElementById("qw-date-label");
            var lunarLabel = document.getElementById("qw-lunar-label");
            if (timeLabel) {
                timeLabel.textContent =
                    String(now.getHours()).padStart(2, "0") + ":" +
                    String(now.getMinutes()).padStart(2, "0");
            }
            if (secLabel) {
                secLabel.textContent = ":" + String(now.getSeconds()).padStart(2, "0");
            }
            if (dateLabel) {
                dateLabel.textContent = now.getFullYear() + "年" +
                    (now.getMonth() + 1) + "月" + now.getDate() + "日 " +
                    WEEKDAYS[now.getDay()];
            }
            var dk = now.getFullYear() + "-" + now.getMonth() + "-" + now.getDate();
            if (lunarLabel && _lunarDay !== dk) {
                _lunarDay = dk;
                lunarLabel.textContent = "农历 " + lunarText(now);
            }
        });
    }

    function updateCompactMode() {
        if (!card) return;
        var w = card.offsetWidth || 340;
        var h = card.offsetHeight || 420;
         var compact = w < 280 || h < 320;
         var tiny = w < 190 || h < 250;
        card.classList.toggle("qw-compact", compact);
        card.classList.toggle("qw-tiny", tiny);
    }

    // 显隐由独立设置窗口写入 NAS，卡片不提供任何设置入口。
    function hideWidgetLocal() {
        safe(function () {
            if (root) root.style.display = "none";
            buildShowButton();
        });
    }

    function buildShowButton() {
        safe(function () {
            var exist = document.getElementById("qweather-show");
            if (exist) { showBtn = exist; return; }
            var host = findDesktopHost();
            if (!host) { setTimeout(buildShowButton, 1000); return; }
            // 旧按钮若已从文档脱离，先清掉引用，避免重复挂载
            if (showBtn && showBtn.parentNode) {
                showBtn.parentNode.removeChild(showBtn);
            }
            showBtn = document.createElement("button");
            showBtn.id = "qweather-show";
            showBtn.textContent = "🌤";
            showBtn.title = "显示天气小组件";
            showBtn.addEventListener("click", function () {
                settings.visible = true;
                saveSettings();
                if (showBtn && showBtn.parentNode) {
                    showBtn.parentNode.removeChild(showBtn);
                }
                showBtn = null;
                // root 可能从未创建（本次会话一直处于隐藏态），
                // 统一交给 startWidget 决定建卡片还是建按钮
                startWidget();
            });
            host.appendChild(showBtn);
        });
    }

    // ===== 看门狗：被 SPA 移除时自动重新挂载 =====
    function startWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(function () {
            safe(function () {
                if (isLoginScreen()) {
                    if (root && document.documentElement.contains(root)) {
                        root.parentNode.removeChild(root);
                    }
                    if (showBtn && showBtn.parentNode) {
                        showBtn.parentNode.removeChild(showBtn);
                        showBtn = null;
                    }
                    return;
                }
                if (settings.visible === false) {
                    // 隐藏态：fnOS 桌面重建时恢复按钮会被一并清掉，
                    // 这里负责重新挂回（此前漏了，导致隐藏后按钮再也不出现）
                    if (!document.getElementById("qweather-show")) buildShowButton();
                    return;
                }
                if (!root) return;
                hostEl = findDesktopHost();
                if (!hostEl) return;
                if (!hostEl.contains(root)) {
                    hostEl.insertBefore(root, hostEl.firstChild);
                    placeWidget();
                }
            });
        }, 2000);
    }

    // ===== 登录状态轮询 =====
    var _pollStart = Date.now();
    function _loginPollTick() {
        safe(function () {
            var elapsed = Date.now() - _pollStart;

            if (isLoginScreen()) {
                if (root && document.documentElement.contains(root)) {
                    root.parentNode.removeChild(root);
                }
                if (showBtn && showBtn.parentNode) {
                    showBtn.parentNode.removeChild(showBtn);
                    showBtn = null;
                }
            } else {
                var hasRoot = root && document.documentElement.contains(root);
                var hasShowBtn = document.getElementById("qweather-show");
                if (!hasRoot && !hasShowBtn) {
                    startWidget();
                }
            }

            if (elapsed > 15000 && loginCheckTimer) {
                clearInterval(loginCheckTimer);
                loginCheckTimer = setInterval(_loginPollTick, 3000);
            }
        });
    }
    function startLoginPolling() {
        if (loginCheckTimer) clearInterval(loginCheckTimer);
        loginCheckTimer = setInterval(_loginPollTick, 500);
    }

    // ===== 拖动（宿主坐标） =====
    function setupDrag(handle) {
        safe(function () {
            var isDragging = false;
            var startX, startY, initLeft, initTop;

            handle.addEventListener("mousedown", function (e) {
                if (e.target.closest("button") || e.target.closest("input") ||
                    e.target.closest("select")) return;
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                initLeft = root.offsetLeft;
                initTop = root.offsetTop;
                card.style.transition = "none";
                e.preventDefault();
            });

            document.addEventListener("mousemove", function (e) {
                if (!isDragging || !hostEl) return;
                var hr = hostEl.getBoundingClientRect();
                var size = getCardSize();
                var nx = clamp(initLeft + e.clientX - startX, 0,
                               Math.max(0, hr.width - size.w));
                var ny = clamp(initTop + e.clientY - startY, 0,
                               Math.max(0, hr.height - size.h));
                root.style.left = nx + "px";
                root.style.top = ny + "px";
            });

            document.addEventListener("mouseup", function () {
                if (isDragging) {
                    isDragging = false;
                    card.style.transition = "box-shadow 0.3s ease,transform 0.1s ease";
                    savePosition();
                }
            });
        });
    }

    // ===== 调整大小 =====
    function setupResize(handle) {
        safe(function () {
            var isResizing = false;
            var startX, startY, initWidth, initHeight, initLeft, initTop;
            var MIN_W = 240, MIN_H = 120;

            handle.addEventListener("mousedown", function (e) {
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                initWidth = card.offsetWidth;
                initHeight = card.offsetHeight;
                initLeft = root.offsetLeft;
                initTop = root.offsetTop;
                card.style.transition = "none";
                e.stopPropagation();
                e.preventDefault();
            });

            document.addEventListener("mousemove", function (e) {
                if (!isResizing || !hostEl) return;
                var hr = hostEl.getBoundingClientRect();
                var maxW = Math.max(MIN_W, hr.width - initLeft);
                var maxH = Math.max(MIN_H, hr.height - initTop);
                var nw = clamp(initWidth + e.clientX - startX, MIN_W, maxW);
                var nh = clamp(initHeight + e.clientY - startY, MIN_H, maxH);
                card.style.width = nw + "px";
                card.style.height = nh + "px";
                updateCompactMode();
            });

            document.addEventListener("mouseup", function () {
                if (isResizing) {
                    isResizing = false;
                    card.style.transition = "box-shadow 0.3s ease,transform 0.1s ease";
                    settings.width = card.offsetWidth;
                    settings.height = card.offsetHeight;
                    if (hostEl) {
                        var hr = hostEl.getBoundingClientRect();
                        settings.widthRatio = hr.width ? card.offsetWidth / hr.width : 0.26;
                        settings.heightRatio = hr.height ? card.offsetHeight / hr.height : 0.42;
                    }
                    saveSettings();
                    updateCompactMode();
                }
            });
        });
    }

    // ===== 天气数据（带 localStorage 缓存） =====
    // 缓存策略：
    //   - 每次成功获取天气后，将数据连同抓取时间戳写入 localStorage。
    //   - 加载/登录时优先渲染缓存（秒开，不再显示"加载中..."），
    //     仅当缓存超过 refreshInterval 时才发起新的网络请求更新。
    //   - 缓存按地点经纬度区分，切换城市后旧缓存不再复用。
    function saveWeatherCache(data) {
        try {
            var loc = settings.location || {};
            localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                lat: loc.latitude,
                lon: loc.longitude,
                data: data
            }));
        } catch (e) {}
    }

    function loadWeatherCache() {
        try {
            var raw = localStorage.getItem(WEATHER_CACHE_KEY);
            if (!raw) return null;
            var cached = JSON.parse(raw);
            if (!cached || !cached.data) return null;
            return cached;
        } catch (e) {
            return null;
        }
    }

    // 渲染缓存数据；updateTime 传入缓存的抓取时间戳
    function renderWeather(data, updateTime) {
        safe(function () {
            var current = data.current;
            var daily = data.daily;
            if (!current || !daily) return;

            var codeInfo = weatherDesc(current.weather_code);
            $("#qw-weather-icon").innerHTML = wxIconSvg(current.weather_code, current.is_day);
            $("#qw-temp-value").textContent = Math.round(current.temperature_2m);
            $("#qw-weather-desc").textContent = codeInfo;

            $("#qw-wx-sub").textContent =
                "体感 " + Math.round(current.apparent_temperature) + "° · 湿度 " +
                current.relative_humidity_2m + "% · 风速 " +
                Math.round(current.wind_speed_10m) + " km/h · 气压 " +
                Math.round(current.pressure_msl) + " hPa";

            renderForecast(daily);
            updateClock();

            // 天气更新时间只在独立设置窗口中展示，卡片本体不显示
            updateCompactMode();
        });
    }

    function fetchWeather() {
        safe(function () {
            if (!settings.location || settings.showWeather === false) return;
            var loc = settings.location;

            var params = new URLSearchParams({
                latitude: loc.latitude,
                longitude: loc.longitude,
                current: "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,pressure_msl",
                daily: "weather_code,temperature_2m_max,temperature_2m_min",
                timezone: "auto",
                forecast_days: "5"
            });
            fetch(DIRECT_WEATHER + "?" + params.toString(), { credentials: "same-origin" })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.error) {
                        $("#qw-weather-desc").textContent = data.error;
                        return;
                    }
                    var now = Date.now();
                    saveWeatherCache(data);
                    renderWeather(data, now);
                })
                .catch(function () {
                    // 网络失败时保留已显示的缓存数据，仅提示
                    var desc = $("#qw-weather-desc");
                    if (desc && desc.textContent === "加载中...") {
                        desc.textContent = "获取天气失败";
                    }
                });
        });
    }

    // 加载时优先渲染缓存；缓存过期才后台刷新
    function loadWeatherWithCache() {
        safe(function () {
            if (!settings.location || settings.showWeather === false) return;
            var loc = settings.location;
            var cached = loadWeatherCache();

            // 缓存地点必须匹配当前地点
            var cacheMatches = cached &&
                cached.lat === loc.latitude &&
                cached.lon === loc.longitude;

            if (cacheMatches) {
                renderWeather(cached.data, cached.ts);
                var ageMin = (Date.now() - cached.ts) / 60000;
                var interval = settings.refreshInterval || 30;
                if (ageMin >= interval) {
                    // 缓存已过期，后台拉取最新数据
                    fetchWeather();
                }
                return;
            }

            // 无缓存或地点不匹配，必须拉取
            fetchWeather();
        });
    }

    function renderForecast(daily) {
        safe(function () {
            var list = $("#qw-forecast-list");
            list.innerHTML = "";
            for (var i = 0; i < Math.min(5, daily.time.length); i++) {
                var date = new Date(daily.time[i]);
                var dayName = i === 0 ? "今天" : WEEKDAYS[date.getDay()];

                var item = document.createElement("div");
                item.className = "qw-forecast-item";
                item.innerHTML =
                    '<div class="qw-forecast-day">' + dayName + '</div>' +
                    '<div class="qw-forecast-icon">' + wxIconSvg(daily.weather_code[i], 1) + '</div>' +
                    '<div class="qw-forecast-temp">' +
                        Math.round(daily.temperature_2m_max[i]) + '°</div>' +
                    '<div class="qw-forecast-temp"><span class="qw-min">' +
                        Math.round(daily.temperature_2m_min[i]) + '°</span></div>';
                list.appendChild(item);
            }
        });
    }

    // ===== 自动刷新 =====
    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(
            fetchWeather, (settings.refreshInterval || 30) * 60 * 1000
        );
    }

    // ===== 设置轮询：独立设置窗口保存后，卡片热应用（无需刷新桌面） =====
    // 桌面卡片没有任何设置入口，NAS settings.json 是唯一来源；
    // 每 4 秒轻量 GET（nginx 直接 alias 文件，不走应用进程）。
    function normalizeSettings(data) {
        var s = Object.assign({}, DEFAULT_SETTINGS, data || {});
        s.schemaV = SCHEMA_VERSION;
        var fs = parseInt(s.fontScale, 10);
        s.fontScale = isNaN(fs) ? 100 : clamp(fs, 50, 200);
        return s;
    }

    // 本地刚保存（拖动/缩放/恢复按钮）后给服务端一点落盘时间，避免读到旧值
    function settingsSig(s) {
        return JSON.stringify(s);
    }

    function pollSettings() {
        fetch(SETTINGS_GET, { credentials: "same-origin", cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.location) return;
                var next = normalizeSettings(data);
                if (settingsSig(next) === settingsSig(settings)) return;
                applyRemoteSettings(next);
            })
            .catch(function () { /* 静默：下轮再试 */ });
    }

    function applyRemoteSettings(next) {
        var prev = settings || {};
        settings = next;

        // 外观类：直接重放
        applyOpacity();
        applyTheme();
        applyFontScale();
        ensureFontFace();
        applyModules();

        // 显隐
        if (settings.visible === false) {
            if (root && root.style.display !== "none") hideWidgetLocal();
        } else {
            var btn = document.getElementById("qweather-show");
            if (btn && btn.parentNode) {
                btn.parentNode.removeChild(btn);
                showBtn = null;
            }
            if (!root || !document.documentElement.contains(root) ||
                root.style.display === "none") {
                // 本次会话尚未建卡（一直隐藏）→ 完整建卡并拉天气
                startWidget();
                return;
            }
        }

        // 城市
        var nameEl = document.getElementById("qw-location-name");
        if (nameEl && (!prev.location || prev.location.latitude !== settings.location.latitude ||
                       prev.location.longitude !== settings.location.longitude ||
                       prev.location.name !== settings.location.name)) {
            nameEl.textContent = settings.location.name;
            if (settings.showWeather !== false) fetchWeather();
        }

        // 刷新间隔
        if (prev.refreshInterval !== settings.refreshInterval) {
            startAutoRefresh();
        }

        // 位置（设置窗口点了“重置卡片位置”→ position=null；或外部改了坐标）
        if (settingsSig(prev.position || null) !== settingsSig(settings.position || null)) {
            if (!settings.position && hostEl) {
                var hr = hostEl.getBoundingClientRect();
                applyDefaultPosition(hr, card.offsetWidth, card.offsetHeight);
            } else if (hostEl) {
                placeWidget();
            }
        }

        // 模块显隐 / 字号变化后紧凑阈值与位置重算
        updateCompactMode();
        onWindowResize();
    }

    var settingsPollTimer = null;
    function startSettingsPoll() {
        if (settingsPollTimer) clearInterval(settingsPollTimer);
        settingsPollTimer = setInterval(pollSettings, 4000);
    }

    if (typeof window !== "undefined") {
        setInterval(updateClock, 1000);
    }

    // ===== 初始化 =====
    // 挂载入口：settings 已就绪（NAS 读到或回退默认值）后才会被调用，
    // 因此首次渲染即使用 NAS 保存的城市/位置/显隐状态。
    function startWidget() {
        safe(function () {
            if (isLoginScreen()) return;
            if (settings.visible === false) {
                buildShowButton();
            } else {
                buildWidget();
                loadWeatherWithCache();
                startAutoRefresh();
            }
            // 隐藏态也要跑看门狗，否则桌面重建后恢复按钮丢失无法自愈
            startWatchdog();
        });
    }

    function init() {
        safe(function () {
            injectStylesheet();
            // 先从 NAS 读设置（同源本地请求，毫秒级），再挂载。
            loadSettings().then(function (srv) {
                settings = srv || Object.assign({}, DEFAULT_SETTINGS);
                startLoginPolling();
                // 独立设置窗口保存后卡片热应用（显隐态也需要轮询）
                startSettingsPoll();
                if (document.readyState === "complete") {
                    setTimeout(startWidget, 300);
                } else {
                    window.addEventListener("load", function () {
                        setTimeout(startWidget, 300);
                    });
                }
            });
        });
    }

    init();
})();
