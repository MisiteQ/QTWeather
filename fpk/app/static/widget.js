/**
 * QWeather 桌面小组件 v2.1.0
 * 直接注入飞牛桌面页面运行，无窗口标题栏
 * 支持：拖动、调整大小、透明度调节、地点切换、自动刷新、隐藏/恢复
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
    var DIRECT_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
    // 设置持久化：存 NAS 服务端，跨浏览器/跨设备共享。
    // widget.js 注入在桌面页（origin: https://<nas-host>），桌面页的
    // session 不覆盖 /app/<name>/api/ 网关路径（网关 404）。改为走应用
    // 子域 https://com~qweather-widget.<nas-host>/api/settings——子域
    // 请求携带 session cookie（fnOS 主域 cookie 对子域生效），网关认证
    // 通过；跨域凭据需 CORS 回显具体 Origin + Allow-Credentials:true。
    // localStorage 仅作即时回退与离线缓存。
    var SETTINGS_API = location.protocol + "//com~qweather-widget." +
        location.hostname + "/api/settings";
    // 城市搜索数据源：
    //   1) 内置中国行政区划坐标库（/qweather-cities.json，省/市/县三级 3200+，
    //      来源阿里 DataV GeoAtlas，脚本 _gen_cities.py 可再生成）——
    //      Open-Meteo 地理编码基于 GeoNames，中国中小城市中文覆盖差
    //      （搜不到/错配国外同名地点），国内城市一律本地检索，秒出且准确；
    //   2) 国际城市走 Open-Meteo（language=zh），与本地结果合并去重。
    var CN_CITIES_CACHE_KEY = "qweather_widget_cities_v1";

    // ===== 配置常量 =====
    var STORAGE_KEY = "qweather_widget_settings";
    var WEATHER_CACHE_KEY = "qweather_widget_weather_cache";
    var SCHEMA_VERSION = 2;
    var DEFAULT_SETTINGS = {
        schemaV: SCHEMA_VERSION,
        location: { name: "北京", latitude: 39.9042, longitude: 116.4074, country: "中国" },
        opacity: 85,
        refreshInterval: 30,
        position: null,   // 相对桌面宿主容器的坐标 {x, y}
        visible: true,
        width: 340,
        height: null
    };

    // ===== WMO 天气代码映射 =====
    var WEATHER_CODES = {
        0: { desc: "晴", icon: "☀️" },
        1: { desc: "大部晴朗", icon: "🌤️" },
        2: { desc: "局部多云", icon: "⛅" },
        3: { desc: "阴", icon: "☁️" },
        45: { desc: "雾", icon: "🌫️" },
        48: { desc: "雾凇", icon: "🌫️" },
        51: { desc: "小毛毛雨", icon: "🌦️" },
        53: { desc: "毛毛雨", icon: "🌦️" },
        55: { desc: "大毛毛雨", icon: "🌧️" },
        56: { desc: "冻毛毛雨", icon: "🌧️" },
        57: { desc: "强冻毛毛雨", icon: "🌧️" },
        61: { desc: "小雨", icon: "🌦️" },
        63: { desc: "中雨", icon: "🌧️" },
        65: { desc: "大雨", icon: "🌧️" },
        66: { desc: "冻雨", icon: "🌧️" },
        67: { desc: "强冻雨", icon: "🌧️" },
        71: { desc: "小雪", icon: "🌨️" },
        73: { desc: "中雪", icon: "🌨️" },
        75: { desc: "大雪", icon: "❄️" },
        77: { desc: "雪粒", icon: "❄️" },
        80: { desc: "小阵雨", icon: "🌦️" },
        81: { desc: "阵雨", icon: "🌧️" },
        82: { desc: "强阵雨", icon: "⛈️" },
        85: { desc: "小阵雪", icon: "🌨️" },
        86: { desc: "强阵雪", icon: "❄️" },
        95: { desc: "雷暴", icon: "⛈️" },
        96: { desc: "雷暴伴小冰雹", icon: "⛈️" },
        99: { desc: "雷暴伴大冰雹", icon: "⛈️" }
    };

    var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    // ===== 全局状态 =====
    var settings = {};
    var refreshTimer = null;
    var watchdogTimer = null;
    var loginCheckTimer = null;
    var hostEl = null;
    var root = null;
    var card = null;
    var settingsPanel = null;
    var showBtn = null;

    // ===== 作用域样式表 =====
    // 层级策略（根 z-index:10，位于桌面宿主内部）：
    //   壁纸 0 ＜ 桌面图标(auto 非定位) ＜ 小组件 10 ＜ 原生窗口 10010 ＜
    //   右键菜单 10022 ＜ 全屏界面 1000001
    var SCOPED_CSS = [
        "#qweather-root{position:absolute;z-index:10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#1a1a2e;pointer-events:none;user-select:none;}",
        "#qweather-root *{margin:0;padding:0;box-sizing:border-box;}",

        "#qweather-root .qw-card{pointer-events:auto;width:340px;min-width:280px;min-height:320px;border-radius:20px;background:rgba(255,255,255,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:0 8px 32px rgba(0,0,0,0.2);padding:18px 22px 16px;display:flex;flex-direction:column;transition:box-shadow 0.3s ease,transform 0.1s ease;position:relative;overflow:hidden;}",
        "#qweather-root .qw-card:hover{box-shadow:0 12px 40px rgba(0,0,0,0.3);}",
        "#qweather-root .qw-card.qw-compact .qw-details{display:block;}",
        "#qweather-root .qw-card.qw-compact .qw-forecast{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}",
        "#qweather-root .qw-card.qw-tiny .qw-details{display:none;}",
        "#qweather-root .qw-card.qw-tiny .qw-weather-desc,#qweather-root .qw-card.qw-tiny .qw-current .qw-temp-unit,#qweather-root .qw-card.qw-tiny .qw-update-time{display:none;}",
        "#qweather-root .qw-card.qw-tiny .qw-current{margin-bottom:10px;}",
        "#qweather-root .qw-card.qw-tiny .qw-temp-value{font-size:42px;}",

        "#qweather-root .qw-header{display:flex;align-items:center;justify-content:space-between;cursor:grab;gap:8px;}",
        "#qweather-root .qw-header:active{cursor:grabbing;}",
        "#qweather-root .qw-location-info{display:flex;align-items:center;gap:6px;flex:1;min-width:0;}",
        "#qweather-root .qw-location-icon{width:18px;height:18px;flex-shrink:0;color:#e74c3c;}",
        "#qweather-root .qw-location-name{font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#qweather-root .qw-date-block{display:flex;align-items:center;gap:8px;font-size:14px;opacity:0.72;white-space:nowrap;flex-shrink:0;}",
        "#qweather-root .qw-date-block span:last-child{font-weight:700;letter-spacing:0.04em;}",
        "#qweather-root .qw-icon-btn{width:30px;height:30px;border-radius:50%;border:none;background:rgba(0,0,0,0.05);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#1a1a2e;flex-shrink:0;transition:background 0.2s;margin-left:8px;pointer-events:auto;}",
        "#qweather-root .qw-icon-btn svg{width:16px;height:16px;}",
        "#qweather-root .qw-icon-btn:hover{background:rgba(0,0,0,0.1);}",

        "#qweather-root .qw-current{text-align:center;margin-bottom:16px;margin-top:4px;}",
        "#qweather-root .qw-weather-icon{font-size:48px;line-height:1;margin-bottom:6px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.15));}",
        "#qweather-root .qw-temp-main{display:flex;align-items:flex-start;justify-content:center;}",
        "#qweather-root .qw-temp-value{font-size:56px;font-weight:200;line-height:1;letter-spacing:-2px;}",
        "#qweather-root .qw-temp-unit{font-size:22px;font-weight:300;margin-top:4px;margin-left:2px;opacity:0.7;}",
        "#qweather-root .qw-weather-desc{font-size:14px;opacity:0.7;margin-top:2px;}",

        "#qweather-root .qw-details{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;}",
        "#qweather-root .qw-detail-item{background:rgba(0,0,0,0.05);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:1px;}",
        "#qweather-root .qw-detail-label{font-size:10px;opacity:0.5;text-transform:uppercase;letter-spacing:0.5px;}",
        "#qweather-root .qw-detail-value{font-size:14px;font-weight:600;}",

        "#qweather-root .qw-forecast{margin-bottom:8px;flex:1;}",
        "#qweather-root .qw-forecast-title{font-size:11px;opacity:0.5;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;}",
        "#qweather-root .qw-forecast-list{display:flex;justify-content:space-between;gap:2px;}",
        "#qweather-root .qw-forecast-item{flex:1;text-align:center;padding:6px 2px;border-radius:8px;transition:background 0.2s;}",
        "#qweather-root .qw-forecast-item:hover{background:rgba(0,0,0,0.05);}",
        "#qweather-root .qw-forecast-day{font-size:10px;opacity:0.6;margin-bottom:2px;}",
        "#qweather-root .qw-forecast-icon{font-size:18px;margin-bottom:2px;}",
        "#qweather-root .qw-forecast-temp{font-size:11px;font-weight:600;}",
        "#qweather-root .qw-forecast-temp .qw-min{opacity:0.5;font-weight:400;}",

        "#qweather-root .qw-update-time{text-align:center;font-size:11px;opacity:0.4;margin-top:6px;}",

        "#qweather-root .qw-resize-handle{position:absolute;right:4px;bottom:4px;width:18px;height:18px;cursor:nwse-resize;pointer-events:auto;z-index:5;border-radius:6px;background:rgba(91,110,225,0.04);}",
        "#qweather-root .qw-resize-handle::after{content:none;display:none;}",

        "#qweather-root .qw-settings{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.97);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:16px 14px 12px;display:none;font-size:13px;z-index:10;border-radius:16px;pointer-events:auto;flex-direction:column;overflow:hidden;max-width:100%;max-height:100%;width:100%;height:100%;}",
        "#qweather-root .qw-settings-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(0,0,0,0.06);flex-shrink:0;}",
        "#qweather-root .qw-settings-title{font-size:16px;font-weight:600;color:#1a1a2e;}",
        "#qweather-root .qw-settings-close{width:28px;height:28px;border-radius:50%;border:none;background:rgba(0,0,0,0.05);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:#1a1a2e;transition:background 0.2s;pointer-events:auto;}",
        "#qweather-root .qw-settings-close:hover{background:rgba(0,0,0,0.12);}",
        "#qweather-root .qw-settings-body{flex:1;overflow-y:auto;min-height:0;}",
        "#qweather-root .qw-setting-group{margin-bottom:14px;}",
        "#qweather-root .qw-setting-group:last-child{margin-bottom:0;}",
        "#qweather-root .qw-label-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px;font-weight:500;}",
        "#qweather-root .qw-search-box{display:flex;gap:8px;}",
        "#qweather-root .qw-input{flex:1;padding:9px 12px;border:1px solid rgba(0,0,0,0.1);border-radius:10px;font-size:13px;outline:none;background:rgba(255,255,255,0.8);color:#1a1a2e;min-width:0;}",
        "#qweather-root .qw-input::placeholder{color:rgba(0,0,0,0.35);}",
        "#qweather-root .qw-input:focus{border-color:#5b6ee1;box-shadow:0 0 0 3px rgba(91,110,225,0.12);}",
        "#qweather-root .qw-btn{padding:9px 16px;border:none;border-radius:10px;background:#5b6ee1;color:#fff;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background 0.2s;pointer-events:auto;}",
        "#qweather-root .qw-btn:hover{background:#4a5dd0;}",
        "#qweather-root .qw-search-results{margin-top:8px;background:rgba(255,255,255,0.98);border-radius:10px;border:1px solid rgba(0,0,0,0.08);max-height:120px;overflow-y:auto;display:none;}",
        "#qweather-root .qw-result-item{padding:9px 12px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,0.04);font-size:13px;pointer-events:auto;}",
        "#qweather-root .qw-result-item:last-child{border-bottom:none;}",
        "#qweather-root .qw-result-item:hover{background:rgba(91,110,225,0.08);}",
        "#qweather-root .qw-result-sub{font-size:11px;opacity:0.5;margin-left:6px;}",
        "#qweather-root .qw-op-value{font-size:13px;font-weight:600;color:#5b6ee1;}",
        "#qweather-root .qw-slider{width:100%;height:5px;-webkit-appearance:none;appearance:none;background:rgba(0,0,0,0.1);border-radius:3px;outline:none;cursor:pointer;pointer-events:auto;}",
        "#qweather-root .qw-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;border-radius:50%;background:#5b6ee1;box-shadow:0 2px 6px rgba(91,110,225,0.4);border:none;cursor:pointer;transition:transform 0.15s;}",
        "#qweather-root .qw-slider::-webkit-slider-thumb:hover{transform:scale(1.15);}",
        "#qweather-root .qw-slider::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#5b6ee1;box-shadow:0 2px 6px rgba(91,110,225,0.4);border:none;cursor:pointer;}",
        "#qweather-root .qw-select{width:100%;padding:9px 32px 9px 12px;border:1px solid rgba(0,0,0,0.1);border-radius:10px;font-size:13px;outline:none;background:rgba(255,255,255,0.8);color:#1a1a2e;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 12px center;pointer-events:auto;}",
        "#qweather-root .qw-select:focus{border-color:#5b6ee1;}",
        "#qweather-root .qw-save-btn{width:100%;padding:11px;border:none;border-radius:12px;background:linear-gradient(135deg,#5b6ee1 0%,#7c5cbf 100%);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:transform 0.15s,box-shadow 0.2s;pointer-events:auto;margin-top:12px;}",
        "#qweather-root .qw-save-btn:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(91,110,225,0.35);}",
        "#qweather-root .qw-save-btn:active{transform:translateY(0);}",
        "#qweather-root .qw-row{display:flex;gap:8px;margin-top:10px;}",
        "#qweather-root .qw-ghost-btn{flex:1;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;background:transparent;color:#1a1a2e;font-size:12px;cursor:pointer;transition:background 0.2s,border-color 0.2s;pointer-events:auto;}",
        "#qweather-root .qw-ghost-btn:hover{background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.2);}",
        "#qweather-root .qw-dev{margin-top:10px;padding-top:8px;border-top:1px solid #eee;font-size:11px;color:#999;text-align:center;line-height:1.6;flex-shrink:0;}",
        "#qweather-root .qw-dev a{color:#5b6ee1;text-decoration:none;}",

        "#qweather-show{position:absolute;right:18px;bottom:18px;z-index:10;width:42px;height:42px;border-radius:50%;border:none;background:rgba(91,110,225,0.92);color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(91,110,225,0.4);display:flex;align-items:center;justify-content:center;pointer-events:auto;}"
    ].join("\n");

    function injectStylesheet() {
        if (document.getElementById("qweather-styles")) return;
        var style = document.createElement("style");
        style.id = "qweather-styles";
        style.textContent = SCOPED_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ===== 设置读写 =====
    // 主存储为 NAS 服务端 settings.json（跨浏览器/跨设备共享）。
    // localStorage 仅作即时回退（服务端未就绪/离线时使用），确保
    // 页面加载时不会因网络延迟而长时间无设置。
    var _saveTimer = null;
    var _serverSettingsLoaded = false;

    function loadSettings() {
        // 即时回退：从 localStorage 读取（可能为空 → 返回默认值）
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                var parsed = JSON.parse(saved);
                var s = Object.assign({}, DEFAULT_SETTINGS, parsed);
                if (!parsed.schemaV && s.position) {
                    s.position = { x: s.position.x - 66, y: s.position.y };
                }
                s.schemaV = SCHEMA_VERSION;
                return s;
            }
        } catch (e) {}
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    // 从 NAS 服务端加载设置（异步后台调用，不阻塞 widget 挂载）。
    // 成功 → 用服务端数据覆盖 settings 并重新渲染/定位。
    // 失败 → 返回 null，调用方用 localStorage 回退。
    function loadSettingsFromServer() {
        return fetch(SETTINGS_API, { credentials: "include" })
            .then(function (r) {
                if (!r.ok) return null;
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.location) return null;
                _serverSettingsLoaded = true;
                var merged = Object.assign(
                    {}, DEFAULT_SETTINGS, data);
                merged.schemaV = SCHEMA_VERSION;
                if (!data.schemaV && merged.position) {
                    merged.position = {
                        x: merged.position.x - 66, y: merged.position.y
                    };
                }
                settings = merged;
                try {
                    localStorage.setItem(
                        STORAGE_KEY, JSON.stringify(settings));
                } catch (e) {}
                return settings;
            })
            .catch(function () { return null; });
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {}
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            _saveTimer = null;
            try {
                fetch(SETTINGS_API, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(settings)
                }).catch(function () {});
            } catch (e) {}
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
            root = document.createElement("div");
            root.id = "qweather-root";

            card = document.createElement("div");
            card.className = "qw-card";

            if (settings.width) card.style.width = settings.width + "px";
            if (settings.height) card.style.height = settings.height + "px";

            card.innerHTML =
                '<div class="qw-header" id="qw-drag-handle">' +
                '  <div class="qw-location-info">' +
                '    <svg class="qw-location-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
                '      <circle cx="12" cy="10" r="3"/>' +
                '    </svg>' +
                '    <span class="qw-location-name" id="qw-location-name">加载中...</span>' +
                '  </div>' +
                '  <div class="qw-date-block" id="qw-date-block">' +
                '    <span id="qw-date-label">--</span>' +
                '    <span id="qw-time-label">--:--</span>' +
                '  </div>' +
                '  <button class="qw-icon-btn" id="qw-settings-btn" title="设置">' +
                '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '      <circle cx="12" cy="12" r="3"/>' +
                '      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
                '    </svg>' +
                '  </button>' +
                '</div>' +
                '<div class="qw-current">' +
                '  <div class="qw-weather-icon" id="qw-weather-icon">☀️</div>' +
                '  <div class="qw-temp-main">' +
                '    <span class="qw-temp-value" id="qw-temp-value">--</span>' +
                '    <span class="qw-temp-unit">°C</span>' +
                '  </div>' +
                '  <div class="qw-weather-desc" id="qw-weather-desc">加载中...</div>' +
                '</div>' +
                '<div class="qw-forecast">' +
                '  <div class="qw-forecast-title">未来预报</div>' +
                '  <div class="qw-forecast-list" id="qw-forecast-list"></div>' +
                '</div>' +
                '<div class="qw-details">' +
                '  <div class="qw-detail-item"><span class="qw-detail-label">体感</span><span class="qw-detail-value" id="qw-feels-like">--°</span></div>' +
                '  <div class="qw-detail-item"><span class="qw-detail-label">湿度</span><span class="qw-detail-value" id="qw-humidity">--%</span></div>' +
                '  <div class="qw-detail-item"><span class="qw-detail-label">风速</span><span class="qw-detail-value" id="qw-wind-speed">-- km/h</span></div>' +
                '  <div class="qw-detail-item"><span class="qw-detail-label">气压</span><span class="qw-detail-value" id="qw-pressure">-- hPa</span></div>' +
                '</div>' +
                '<div class="qw-update-time" id="qw-update-time">--</div>' +
                '<div class="qw-resize-handle" id="qw-resize-handle" title="拖动调整大小"></div>';

            root.appendChild(card);
            buildSettingsPanel();

            $("#qw-location-name").textContent = settings.location.name;
            applyOpacity();
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

            setupDrag($("#qw-drag-handle"));
            setupResize($("#qw-resize-handle"));
            setupDesktopContextForward();
            $("#qw-settings-btn").addEventListener("click", function (e) {
                e.stopPropagation();
                toggleSettings();
            });

            window.addEventListener("resize", onWindowResize);
        });
    }

    // 服务端设置到达后，重新应用位置/大小/透明度/城市名
    function applyServerSettingsRefresh() {
        safe(function () {
            if (!root || !card) return;
            if (settings.width) card.style.width = settings.width + "px";
            if (settings.height) card.style.height = settings.height + "px";
            var ln = $("#qw-location-name");
            if (ln && settings.location) ln.textContent = settings.location.name;
            applyOpacity();
            if (ensureMounted()) {
                placeWidget();
                updateCompactMode();
            }
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
                if (e.target.closest(".qw-settings")) return;
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

    // ===== 设置面板 =====
    function buildSettingsPanel() {
        safe(function () {
            settingsPanel = document.createElement("div");
            settingsPanel.className = "qw-settings";
            settingsPanel.id = "qw-settings-panel";
            settingsPanel.innerHTML =
                '<div class="qw-settings-header">' +
                '  <span class="qw-settings-title">设置</span>' +
                '  <button class="qw-settings-close" id="qw-settings-close" title="关闭">✕</button>' +
                '</div>' +
                '<div class="qw-settings-body">' +
                '  <div class="qw-setting-group">' +
                '    <label class="qw-label-row">天气地点</label>' +
                '    <div class="qw-search-box">' +
                '      <input type="text" class="qw-input" id="qw-loc-input" placeholder="输入城市名称搜索..." autocomplete="off">' +
                '      <button class="qw-btn" id="qw-search-btn">搜索</button>' +
                '    </div>' +
                '    <div class="qw-search-results" id="qw-search-results"></div>' +
                '  </div>' +
                '  <div class="qw-setting-group">' +
                '    <label class="qw-label-row">卡片透明度<span class="qw-op-value" id="qw-op-value">85%</span></label>' +
                '    <input type="range" class="qw-slider" id="qw-op-slider" min="20" max="100" value="85">' +
                '  </div>' +
                '  <div class="qw-setting-group">' +
                '    <label class="qw-label-row">自动刷新间隔</label>' +
                '    <select class="qw-select" id="qw-rf-select">' +
                '      <option value="10">10 分钟</option>' +
                '      <option value="30">30 分钟</option>' +
                '      <option value="60">1 小时</option>' +
                '      <option value="180">3 小时</option>' +
                '    </select>' +
                '  </div>' +
                '</div>' +
                '<button class="qw-save-btn" id="qw-save-btn">保存设置</button>' +
                '<div class="qw-row">' +
                '  <button class="qw-ghost-btn" id="qw-reset-btn">重置位置</button>' +
                '  <button class="qw-ghost-btn" id="qw-hide-btn">隐藏小组件</button>' +
                '</div>' +
                '<div class="qw-dev">开发者 Misite齊 · <a href="https://github.com/MisiteQ" target="_blank" rel="noopener noreferrer">github.com/MisiteQ</a></div>';

            card.appendChild(settingsPanel);

            $("#qw-settings-close").addEventListener("click", toggleSettings);
            $("#qw-loc-input").addEventListener("keydown", function (e) {
                if (e.key === "Enter") searchLocation($("#qw-loc-input").value);
            });
            $("#qw-search-btn").addEventListener("click", function () {
                searchLocation($("#qw-loc-input").value);
            });

            var opSlider = $("#qw-op-slider");
            var opValue = $("#qw-op-value");
            opSlider.value = settings.opacity;
            opValue.textContent = settings.opacity + "%";
            opSlider.addEventListener("input", function () {
                settings.opacity = parseInt(opSlider.value, 10);
                opValue.textContent = settings.opacity + "%";
                applyOpacity();
            });

            $("#qw-rf-select").value = String(settings.refreshInterval);

            $("#qw-save-btn").addEventListener("click", function () {
                settings.opacity = parseInt(opSlider.value, 10);
                settings.refreshInterval = parseInt($("#qw-rf-select").value, 10);
                saveSettings();
                startAutoRefresh();
                showToast("设置已保存，可点击 ✕ 关闭");
            });
            $("#qw-reset-btn").addEventListener("click", function () {
                settings.position = null;
                var hr = hostEl.getBoundingClientRect();
                applyDefaultPosition(hr, card.offsetWidth, card.offsetHeight);
                showToast("已重置位置");
            });
            $("#qw-hide-btn").addEventListener("click", hideWidget);
        });
    }

    function applyOpacity() {
        if (card) {
            card.style.background = "rgba(255,255,255," + (settings.opacity / 100) + ")";
        }
    }

    function updateClock() {
        safe(function () {
            var now = new Date();
            var dateLabel = document.getElementById("qw-date-label");
            var timeLabel = document.getElementById("qw-time-label");
            if (dateLabel) {
                dateLabel.textContent = now.toLocaleDateString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    weekday: "short"
                }).replace(/\s+/g, "");
            }
            if (timeLabel) {
                timeLabel.textContent = now.toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false
                });
            }
        });
    }

    function updateCompactMode() {
        if (!card) return;
        var w = card.offsetWidth || 340;
        var h = card.offsetHeight || 420;
         var compact = w < 250 || h < 320;
         var tiny = w < 190 || h < 250;
        card.classList.toggle("qw-compact", compact);
        card.classList.toggle("qw-tiny", tiny);
    }

    function toggleSettings() {
        if (!settingsPanel) return;
        settingsPanel.style.display =
            settingsPanel.style.display === "flex" ? "none" : "flex";
    }

    function hideWidget() {
        safe(function () {
            settings.visible = false;
            saveSettings();
            if (root) root.style.display = "none";
            showToast("小组件已隐藏，点右下角按钮可恢复");
            buildShowButton();
        });
    }

    function buildShowButton() {
        safe(function () {
            if (document.getElementById("qweather-show")) return;
            var host = findDesktopHost();
            if (!host) { setTimeout(buildShowButton, 1000); return; }
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
                if (root) {
                    root.style.display = "";
                    ensureMounted();
                    placeWidget();
                }
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
                    return;
                }
                if (settings.visible === false) return;
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
                if (!hasRoot && !hasShowBtn && settings.visible !== false) {
                    // 立即用 localStorage 设置挂载，后台异步拉取服务端设置
                    buildWidget();
                    loadWeatherWithCache();
                    startAutoRefresh();
                    startWatchdog();
                    if (!_serverSettingsLoaded) {
                        loadSettingsFromServer().then(function (srv) {
                            if (srv && root) {
                                applyServerSettingsRefresh();
                            }
                        });
                    }
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
            var MIN_W = 280, MIN_H = 320;

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

    // ===== 地点搜索（内置中国城市库 + Open-Meteo 双源合并） =====
    function normPlaceName(s) {
        return (s || "").toLowerCase().replace(/\s+/g, "");
    }

    // 加载中国行政区划坐标库：内存 → localStorage → 同源 JSON。
    // 任何失败都返回 null（搜索自动退化为仅 Open-Meteo）。
    var CN_CITIES = null;
    var CN_CITIES_LOADING = null;
    function loadCnCities() {
        if (CN_CITIES) return Promise.resolve(CN_CITIES);
        if (CN_CITIES_LOADING) return CN_CITIES_LOADING;
        try {
            var raw = localStorage.getItem(CN_CITIES_CACHE_KEY);
            if (raw) {
                CN_CITIES = JSON.parse(raw);
                if (CN_CITIES && CN_CITIES.length) return Promise.resolve(CN_CITIES);
                CN_CITIES = null;
            }
        } catch (e) {}
        CN_CITIES_LOADING = fetch("/qweather-cities.json", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (list) {
                if (!list || !list.length) throw new Error("empty");
                CN_CITIES = list;
                try { localStorage.setItem(CN_CITIES_CACHE_KEY, JSON.stringify(list)); } catch (e) {}
                CN_CITIES_LOADING = null;
                return CN_CITIES;
            })
            .catch(function () {
                CN_CITIES_LOADING = null;
                return null;
            });
        return CN_CITIES_LOADING;
    }

    // 本地检索：条目格式 [名称, 省份, 纬度, 经度]；
    // 名称精确 > 名称前缀 > 名称包含，避免省份匹配淹没结果
    function searchCnLocal(query) {
        if (!CN_CITIES) return [];
        var q = normPlaceName(query);
        var exact = [], prefix = [], contains = [];
        for (var i = 0; i < CN_CITIES.length; i++) {
            var it = CN_CITIES[i];
            var rec = {
                name: it[0], admin1: it[1], country: "中国",
                latitude: it[2], longitude: it[3], local: true
            };
            if (normPlaceName(it[0]) === q) exact.push(rec);
            else if (it[0].indexOf(query) === 0) prefix.push(rec);
            else if (it[0].indexOf(query) > 0) contains.push(rec);
        }
        return exact.concat(prefix, contains);
    }

    // Open-Meteo 地理编码（国际城市，结果带结构化 admin1/country）
    function searchOpenMeteo(name) {
        var url = DIRECT_GEOCODE + "?name=" + encodeURIComponent(name) +
            "&count=10&language=zh&format=json";
        return fetch(url, { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                return (data.results || []).map(function (item) {
                    return {
                        name: item.name,
                        admin1: item.admin1 || "",
                        country: item.country || "",
                        latitude: item.latitude,
                        longitude: item.longitude,
                        local: false
                    };
                });
            })
            .catch(function () { return []; });
    }

    // 合并去重：同名同国 或 坐标接近（0.1°内）视为同一地点，本地结果优先；
    // 排序：本地精确 > Open-Meteo 精确 > 本地前缀 > Open-Meteo 前缀 > 包含
    function mergeSearchResults(localList, omList, query) {
        var seen = {};
        var out = [];
        function dedupePush(item) {
            var nameKey = item.country + "|" + normPlaceName(item.name);
            var coordKey = Math.round(item.latitude * 10) + "," +
                Math.round(item.longitude * 10);
            if (seen[nameKey] || seen[coordKey]) return;
            seen[nameKey] = seen[coordKey] = true;
            out.push(item);
        }
        localList.forEach(dedupePush);
        omList.forEach(dedupePush);

        var q = normPlaceName(query);
        function rankOf(item) {
            var n = normPlaceName(item.name);
            var base = (n === q) ? 0 : (n.indexOf(q) === 0 ? 2 : 4);
            return base + (item.local ? 0 : 1);
        }
        out.sort(function (a, b) { return rankOf(a) - rankOf(b); });
        return out.slice(0, 10);
    }

    function searchLocation(name) {
        safe(function () {
            name = (name || "").trim();
            if (!name) { showToast("请输入地点名称"); return; }

            var resultsContainer = $("#qw-search-results");
            resultsContainer.innerHTML = '<div class="qw-result-item" style="color:#999">搜索中...</div>';
            resultsContainer.style.display = "block";

            // 双源并行；两个源内部均已兜底（失败返回空数组），不会整体 reject
            Promise.all([loadCnCities(), searchOpenMeteo(name)])
                .then(function (res) {
                    renderSearchResults(
                        mergeSearchResults(searchCnLocal(name), res[1] || [], name));
                })
                .catch(function () {
                    resultsContainer.innerHTML =
                        '<div class="qw-result-item" style="color:#f66">搜索失败</div>';
                });
        });
    }

    function renderSearchResults(results) {
        safe(function () {
            var container = $("#qw-search-results");
            container.innerHTML = "";
            if (results.length === 0) {
                container.innerHTML =
                    '<div class="qw-result-item" style="color:#999">未找到相关地点</div>';
                container.style.display = "block";
                return;
            }
            results.forEach(function (item) {
                var div = document.createElement("div");
                div.className = "qw-result-item";
                var sub = [item.admin1, item.country].filter(
                    function (v, i, a) { return v && a.indexOf(v) === i; }
                ).join(" · ");
                div.innerHTML = item.name +
                    (sub ? '<span class="qw-result-sub">' + sub + "</span>" : "");
                div.addEventListener("click", function () {
                    settings.location = {
                        name: item.name,
                        latitude: item.latitude,
                        longitude: item.longitude,
                        country: item.country || ""
                    };
                    saveSettings();
                    $("#qw-location-name").textContent = item.name;
                    container.style.display = "none";
                    fetchWeather();
                    showToast("已切换到 " + item.name + "，可点击保存设置");
                });
                container.appendChild(div);
            });
            container.style.display = "block";
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

            var codeInfo = WEATHER_CODES[current.weather_code] ||
                { desc: "未知", icon: "❓" };
            $("#qw-weather-icon").textContent = codeInfo.icon;
            $("#qw-temp-value").textContent = Math.round(current.temperature_2m);
            $("#qw-weather-desc").textContent = codeInfo.desc;

            $("#qw-feels-like").textContent = Math.round(current.apparent_temperature) + "°";
            $("#qw-humidity").textContent = current.relative_humidity_2m + "%";
            $("#qw-wind-speed").textContent = Math.round(current.wind_speed_10m) + " km/h";
            $("#qw-pressure").textContent = Math.round(current.pressure_msl) + " hPa";

            renderForecast(daily);
            updateClock();

            var d = updateTime ? new Date(updateTime) : new Date();
            $("#qw-update-time").textContent = "更新于 " +
                String(d.getHours()).padStart(2, "0") + ":" +
                String(d.getMinutes()).padStart(2, "0");
            updateCompactMode();
        });
    }

    function fetchWeather() {
        safe(function () {
            if (!settings.location) return;
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
            if (!settings.location) return;
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
                var info = WEATHER_CODES[daily.weather_code[i]] || { icon: "❓" };

                var item = document.createElement("div");
                item.className = "qw-forecast-item";
                item.innerHTML =
                    '<div class="qw-forecast-day">' + dayName + '</div>' +
                    '<div class="qw-forecast-icon">' + info.icon + '</div>' +
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

    if (typeof window !== "undefined") {
        setInterval(updateClock, 30000);
    }

    // ===== 初始化 =====
    function init() {
        safe(function () {
            settings = loadSettings();
            injectStylesheet();
            startLoginPolling();

            var tryStart = function () {
                if (isLoginScreen()) return;
                if (settings.visible === false) {
                    buildShowButton();
                    return;
                }
                // 立即用 localStorage 设置挂载（不阻塞），
                // 后台异步从 NAS 服务端拉取设置，成功后覆盖刷新。
                buildWidget();
                loadWeatherWithCache();
                startAutoRefresh();
                startWatchdog();
                if (!_serverSettingsLoaded) {
                    loadSettingsFromServer().then(function (srv) {
                        if (srv && root) {
                            applyServerSettingsRefresh();
                        }
                    });
                }
            };

            if (document.readyState === "complete") {
                setTimeout(tryStart, 300);
            } else {
                window.addEventListener("load", function () {
                    setTimeout(tryStart, 300);
                });
            }
        });
    }

    init();
})();
