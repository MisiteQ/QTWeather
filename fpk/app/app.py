"""
时钟天气 QTWeather（com.qweather.widget）- Flask 后端服务（FPK 版本）v3.0.0
使用 Open-Meteo 免费天气 API（无需 API Key）

注入机制（v2.1.0，零 /usr/trim/www 写入）：

  fnOS 的 nginx 内置 trim_recover 模块：
    - inotify 监控 /usr/trim/www，任何文件被修改 → nginx 退出 →
      systemd 重启时从加密的 www.zip 重新恢复 → 直接改 www 无法持久，
      持续写入还会造成“恢复风暴”；
    - 每次 nginx 成功 reload/restart，都会从加密的 ng.conf.zip
      恢复 /usr/trim/nginx/conf（含 conf.d/）→ 放 conf.d 的自定义配置
      会在 reload/restart 时被抹掉。

  对策：
    1. 小组件注入页放在 APP 数据目录（vol1，受保护目录之外）：
       /vol1/@appdata/com.qweather.widget/desktop/index.html，
       内容 = 系统 index.html + 一行 <script src="/app/.../widget.js">；
    2. conf.d/qweather.conf 用 alias 把 GET / 指向该注入页；
    3. ng.conf.zip 的 ZipCrypto 密钥已通过 bkcrack 离线恢复，
       应用把 qweather.conf 以相同密钥加密后写进 ng.conf.zip →
       nginx 每次恢复都会“恢复出”我们的配置，注入天然持久；
    4. 维护线程低频（30s）巡检，全部只在缺失时补写；
    5. 永远不写 /usr/trim/www 下任何文件。
"""
import os
import re
import sys
import json
import time
import struct
import shutil
import zipfile
import subprocess
import threading

# 将本地依赖目录加入路径（FPK 安装时依赖安装到 libs/）
_LIBS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs")
if os.path.isdir(_LIBS_DIR) and _LIBS_DIR not in sys.path:
    sys.path.insert(0, _LIBS_DIR)

import requests
from flask import Flask, jsonify, request, send_from_directory, Response
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__, static_folder="static", static_url_path="")

# 上传体上限：自定义字体文件最大 25MB（nginx 侧也要同步放开，见 QW_NGINX_CONF_CONTENT）
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

GATEWAY_PREFIX = "/app/com.qweather.widget"


class _GatewayPrefixMiddleware:
    def __init__(self, wsgi_app, prefix):
        self.wsgi_app = wsgi_app
        self.prefix = prefix

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path.startswith(self.prefix):
            rest = path[len(self.prefix):]
            environ["PATH_INFO"] = rest if rest else "/"
        return self.wsgi_app(environ, start_response)


app.wsgi_app = _GatewayPrefixMiddleware(app.wsgi_app, GATEWAY_PREFIX)

# Open-Meteo API 地址
GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search"
WEATHER_API = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 10

# ===== 飞牛路径 =====
FNOS_WWW_INDEX = "/usr/trim/www/index.html"

NGINX_CONF_D = "/usr/trim/nginx/conf/conf.d"
QW_NGINX_CONF = os.path.join(NGINX_CONF_D, "qweather.conf")

NG_CONF_ZIP = "/usr/trim/share/.restore/ng.conf.zip"

APP_DATA_DIR = os.environ.get(
    "TRIM_PKGVAR", "/vol1/@appdata/com.qweather.widget")
DESKTOP_DIR = os.path.join(APP_DATA_DIR, "desktop")
DESKTOP_INDEX = os.path.join(DESKTOP_DIR, "index.html")
PRISTINE_HASH_FILE = os.path.join(DESKTOP_DIR, ".pristine.sha256")

# bkcrack 恢复的 ng.conf.zip ZipCrypto 内部密钥（K0,K1,K2）
_KEYS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "conf", "ng_keys.json")

QW_CONF_ARCNAME = "conf.d/qweather.conf"

APP_DEST_DIR = os.environ.get(
    "TRIM_APPDEST", "/vol1/@appcenter/com.qweather.widget")
WIDGET_JS_DIRECT = os.path.join(APP_DEST_DIR, "static", "widget.js")
CITIES_JSON_DIRECT = os.path.join(APP_DEST_DIR, "static", "cities_cn.json")
SETTINGS_HTML_DIRECT = os.path.join(APP_DEST_DIR, "static", "settings.html")
ICON_DIRECT = os.path.join(APP_DEST_DIR, "static", "icon.png")

# 小组件设置持久化文件（存 NAS，跨浏览器/跨设备共享）
SETTINGS_FILE = os.path.join(APP_DATA_DIR, "settings.json")

# 用户自定义字体目录（标准字体文件：ttf/otf/woff/woff2，单字体槽 qwuser.<ext>）
FONTS_DIR = os.path.join(APP_DATA_DIR, "fonts")
FONT_SLOT_PREFIX = "qwuser"
FONT_TYPES = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
# 各类字体文件头魔数（防止仅改扩展名的伪字体）
FONT_MAGIC = {
    ".ttf": (b"\x00\x01\x00\x00", b"true", b"typ1"),
    ".otf": (b"OTTO",),
    ".woff": (b"wOFF",),
    ".woff2": (b"wOF2",),
}

# 本机应用端口（gunicorn 绑定，nginx 反代 settings 写接口用）
SERVICE_PORT = os.environ.get("TRIM_SERVICE_PORT", "5698")

# widget.js 由 nginx 直接 alias 提供（不经应用网关）：
# 登录前网关 token 无效会拒绝 /app/<name>/widget.js，而脚本必须在
# SPA 登录跳转前就执行——已执行的 IIFE 不随 <script> 标签被 SPA
# 清除而消失，其登录轮询会在进入桌面后自行挂载。
QW_NGINX_CONF_CONTENT = """# QWeather Widget - 注入页与脚本均由 nginx 直接取出，/usr/trim/www 零修改
# 注意：location = / 的 URI 以 / 结尾，nginx 的 index 模块会向 alias
# 路径后再追加 index.html（产生 .../index.htmlindex.html → 500），
# 因此先 rewrite 到一个不以 / 结尾的内部 URI，再 alias 到注入页文件。
# 未认证访问 / 时 SPA 会整页跳转到 /login（干净页），脚本会随旧
# 文档销毁；因此 /login 也必须返回同一注入页——脚本在登录页持续存活，
# 登录成功后（客户端路由到 /）由其登录轮询自行挂载。
location = /login {
    rewrite ^ /qweather-injected last;
}
location = / {
    rewrite ^ /qweather-injected last;
}
location = /qweather-injected {
    alias %s;
    default_type text/html;
    add_header cache-control no-store;
}
location = /qweather-widget.js {
    alias %s;
    default_type application/javascript;
    add_header cache-control no-store;
}
location = /qweather-cities.json {
    alias %s;
    default_type application/json;
}
# 应用独立窗口（点已安装图标）与浏览器同源直达的设置中心页
location = /qweather-settings-page {
    alias %s;
    default_type text/html;
    add_header cache-control no-store;
}
# 设置中心页左上角 Logo / favicon（64px PNG）
location = /qweather-icon.png {
    alias %s;
    default_type image/png;
    add_header cache-control public;
}
# 用户自定义字体：上传（POST multipart，≤25m）/ 读取（GET，供 @font-face）/ 删除（DELETE）。
# ^~ 前缀与上面的精确匹配 location 互不影响。
location ^~ /qweather-api/font {
    client_max_body_size 25m;
    proxy_pass http://127.0.0.1:%s/api/font;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    add_header cache-control no-store;
}
# 小组件设置（城市定位等）持久化：唯一数据源是 NAS 本机
# <数据目录>/settings.json，由 nginx 同源提供，绕开 fnOS 应用网关
# （网关对 /app/<name>/api/* 一律回 invalid token，桌面页无法调用）。
# GET 直接 alias 文件（免反代、应用进程挂了也能读）；POST 反代到本机
# 应用端口写盘。两者都禁用缓存，保证每次读到的都是 NAS 最新数据。
location = /qweather-settings {
    alias %s;
    default_type application/json;
    add_header cache-control no-store;
}
location = /qweather-api/settings {
    proxy_pass http://127.0.0.1:%s/api/settings;
    proxy_set_header Host $host;
    add_header cache-control no-store;
}
""" % (DESKTOP_INDEX, WIDGET_JS_DIRECT, CITIES_JSON_DIRECT,
       SETTINGS_HTML_DIRECT, ICON_DIRECT, SERVICE_PORT,
       SETTINGS_FILE, SERVICE_PORT)

WIDGET_SCRIPT_TAG = '<script src="/qweather-widget.js"></script>'


# ===== CORS =====
# widget.js 注入在桌面页（origin: https://<nas-host>），调用应用子域
# API（https://com~qweather-widget.<nas-host>/api/...）属跨域请求。
# 需要携带 session cookie（凭据）才能通过 fnOS 网关认证，因此 CORS
# 必须回显具体 Origin 并允许凭据——不能用通配 *。
@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def _settings_page_response():
    """设置中心页（点已安装图标弹出的独立窗口内容）。"""
    try:
        resp = send_from_directory(app.static_folder, "settings.html")
        resp.mimetype = "text/html"
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except Exception:
        return Response("settings.html missing", status=500, mimetype="text/plain")


@app.route("/")
def index_page():
    # 应用中心入口：独立窗口即设置中心；桌面卡片由注入脚本直接渲染
    return _settings_page_response()


@app.route("/config")
@app.route("/config.html")
@app.route("/index.html")
@app.route("/app/com.qweather.widget/config")
@app.route("/app/com.qweather.widget/config.html")
@app.route("/app/com.qweather.widget/index.html")
def config_page():
    return _settings_page_response()


@app.errorhandler(404)
def handle_404(_error):
    path = request.path.lower()
    if path.startswith("/api/") or path.startswith("/health") or path.startswith("/widget.js"):
        return jsonify({"error": "not found"}), 404
    return config_page()


# ===== widget.js：强制正确的 JS MIME（否则浏览器拒绝执行） =====
@app.route("/widget.js")
def widget_js():
    resp = send_from_directory(app.static_folder, "widget.js")
    resp.mimetype = "application/javascript"
    return resp


# ===== 基础工具 =====
def _run_cmd(cmd, timeout=30):
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return result.returncode == 0, (result.stdout or "") + (result.stderr or "")
    except Exception as e:
        return False, str(e)


def _read_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _write_file_direct(path, content, mode=0o644):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(path, mode)
        return True
    except Exception:
        return False


# ===== ZipCrypto：用已知内部密钥加密新条目 =====
def _load_zip_keys():
    try:
        data = json.loads(open(_KEYS_FILE, "r", encoding="utf-8").read())
        k0, k1, k2 = int(data["k0"]), int(data["k1"]), int(data["k2"])
        if not (0 <= k0 < 2**32 and 0 <= k1 < 2**32 and 0 <= k2 < 2**32):
            return None
        return [k0, k1, k2]
    except Exception:
        return None


def _zc_crc32(ch, crc):
    return (crc >> 8) ^ _CRC_TABLE[(crc ^ ch) & 0xFF]


def _zc_update_keys(keys, byte):
    keys[0] = _zc_crc32(byte, keys[0])
    keys[1] = (keys[1] + (keys[0] & 0xFF)) & 0xFFFFFFFF
    keys[1] = (keys[1] * 134775813 + 1) & 0xFFFFFFFF
    keys[2] = _zc_crc32((keys[1] >> 24) & 0xFF, keys[2])


def _zc_stream(keys):
    temp = (keys[2] | 2) & 0xFFFF
    return ((temp * (temp ^ 1)) >> 8) & 0xFF


def _zipcrypto_encrypt(plaintext, keys, check_byte):
    import random
    ks = list(keys)
    out = bytearray()
    # 12 字节头，最后一字节为校验字节：
    #   bit3(data descriptor) 模式 → DOS 时间高字节；
    #   无 descriptor 模式 → CRC 高字节。
    header = bytes(random.randrange(256) for _ in range(11)) + \
        bytes([check_byte & 0xFF])
    for b in header:
        c = b ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(c)
    for b in plaintext:
        c = b ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(c)
    return bytes(out)


def _zipcrypto_decrypt(cipher, keys):
    ks = list(keys)
    out = bytearray()
    for c in cipher:
        b = c ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(b)
    return bytes(out)


_CRC_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = ((_c >> 1) ^ 0xEDB88320) if (_c & 1) else (_c >> 1)
    _CRC_TABLE.append(_c & 0xFFFFFFFF)


def _zip_contains(zip_path, arcname):
    try:
        with zipfile.ZipFile(zip_path) as z:
            return arcname in z.namelist()
    except Exception:
        return False


def _crc32_bytes(b):
    import zlib
    return zlib.crc32(b) & 0xFFFFFFFF


def _dos_time(dt):
    y, m, d, hh, mm, ss = dt
    dos_date = ((max(y, 1980) - 1980) << 9) | (m << 5) | d
    dos_time = (hh << 11) | (mm << 5) | (ss // 2)
    return dos_time, dos_date


def _build_new_extra(unix_ts, uid=0, gid=0):
    """构造与原条目一致的 28 字节扩展字段：
    UT(0x5455) size=9: flags(1)+mtime(4)+atime(4)
    ux(0x7875) size=11: ver(1)+uid_len(1)+uid(4)+gid_len(1)+gid(4)"""
    ut = b"UT" + struct.pack("<HBII", 9, 3, unix_ts, unix_ts)
    ux = b"ux" + struct.pack("<HBBIBI", 11, 1, 4, uid, 4, gid)
    return ut + ux


def _read_raw_entries(zip_path):
    """解析 local headers，返回
    [(info, name:bytes, extra:bytes, data:bytes, descriptor:bytes)]
    bit3 条目带 16 字节 data descriptor（PK0708+CRC+cs+us）"""
    entries = []
    with zipfile.ZipFile(zip_path) as src:
        infos = src.infolist()
    with open(zip_path, "rb") as fh:
        for info in infos:
            fh.seek(info.header_offset)
            sig = fh.read(4)
            if sig != b"PK\x03\x04":
                raise ValueError("local header not found")
            hdr_rest = fh.read(26)
            nlen, xlen = struct.unpack("<HH", hdr_rest[22:26])
            name_extra = fh.read(nlen + xlen)
            data_raw = fh.read(info.compress_size)
            desc = b""
            if info.flag_bits & 0x0008:
                d = fh.read(16)
                if d[:4] == b"PK\x07\x08":
                    desc = d
            entries.append((info, name_extra[:nlen], name_extra[nlen:],
                            data_raw, desc))
    return entries


def _local_header(ver, flags, method, dtime, ddate, crc, csize, usize,
                  name, extra):
    return (b"PK\x03\x04" + struct.pack(
        "<HHHHHIIIHH", ver, flags, method, dtime, ddate, crc, csize, usize,
        len(name), len(extra)) + name + extra)


def _central_record(ver, flags, method, dtime, ddate, crc, csize, usize,
                    name, extra, offset, internal=0, external=0):
    return (b"PK\x01\x02" + struct.pack(
        "<HHHHHHIIIHHHHHII",
        0x0314, ver, flags, method, dtime, ddate, crc, csize, usize,
        len(name), len(extra), 0, 0, internal, external, offset) +
        name + extra)


def _write_zip(zip_path, entries, new_entry=None):
    """重写 zip：entries 为原始 (info,name,extra,data)；new_entry 可选
    (name:bytes, plaintext:bytes, keys)"""
    tmp_path = zip_path + ".qwtemp"
    with open(tmp_path, "wb") as out:
        offsets = []
        for info, name, extra, data, desc in entries:
            offsets.append(out.tell())
            dtime, ddate = _dos_time(info.date_time) if info.date_time[0] \
                else (0, 0)
            out.write(_local_header(
                info.extract_version, info.flag_bits, info.compress_type,
                dtime, ddate, info.CRC, info.compress_size, info.file_size,
                name, extra))
            out.write(data)
            if desc:
                out.write(desc)

        n_spec = None
        if new_entry is not None:
            nb, plaintext, keys = new_entry
            crc = _crc32_bytes(plaintext)
            noff = out.tell()
            # 非零 DOS 时间（1980-01-01 12:00:00），校验字节=时间高字节 0x60
            ndt = (1980, 1, 1, 12, 0, 0)
            ndtime, nddate = _dos_time(ndt)
            nextra = _build_new_extra(315576000)
            cipher = _zipcrypto_encrypt(plaintext, keys,
                                        (ndtime >> 8) & 0xFF)
            # 与原条目完全一致：ver10 / flags 0x9 / 本地头 CRC 已填
            out.write(_local_header(
                10, 0x0009, 0, ndtime, nddate, crc, len(cipher),
                len(plaintext), nb, nextra))
            out.write(cipher)
            # 16 字节 data descriptor
            out.write(b"PK\x07\x08" + struct.pack(
                "<III", crc, len(cipher), len(plaintext)))
            n_spec = (nb, crc, len(cipher), len(plaintext), noff,
                      ndtime, nddate, nextra)

        cd = bytearray()
        for (info, name, extra, _, _d), off in zip(entries, offsets):
            dtime, ddate = _dos_time(info.date_time) if info.date_time[0] \
                else (0, 0)
            cd += _central_record(
                info.extract_version, info.flag_bits, info.compress_type,
                dtime, ddate, info.CRC, info.compress_size, info.file_size,
                name, extra, off, internal=info.internal_attr,
                external=info.external_attr)

        if n_spec is not None:
            nb, crc, clen, plen, noff, ndtime, nddate, nextra = n_spec
            cd += _central_record(
                10, 0x0009, 0, ndtime, nddate, crc, clen, plen,
                nb, nextra, noff, external=0x81ED0000)

        cd_start = out.tell()
        out.write(cd)
        cd_size = out.tell() - cd_start
        total = len(entries) + (1 if new_entry is not None else 0)
        out.write(b"PK\x05\x06" + struct.pack(
            "<HHHHIIH", 0, 0, total, total, cd_size, cd_start, 0))

    os.replace(tmp_path, zip_path)


def _add_encrypted_entry(zip_path, arcname, plaintext_bytes, keys):
    """把新条目以 ZipCrypto + STORED 方式追加进 zip"""
    entries = _read_raw_entries(zip_path)
    _write_zip(zip_path, entries,
               new_entry=(arcname.encode("utf-8"), plaintext_bytes, keys))
    return True


def _remove_entry(zip_path, arcname):
    entries = [e for e in _read_raw_entries(zip_path)
               if e[0].filename != arcname]
    _write_zip(zip_path, entries)
    return True


def _read_encrypted_entry(zip_path, arcname, keys):
    """解密指定条目并返回明文（不含 12 字节加密头）；不存在返回 None，
    解密结果 CRC 不符返回 False（视为损坏条目）"""
    try:
        with zipfile.ZipFile(zip_path) as z:
            if arcname not in z.namelist():
                return None
            info = z.getinfo(arcname)
        with open(zip_path, "rb") as fh:
            fh.seek(info.header_offset)
            hdr = fh.read(30)
            if hdr[:4] != b"PK\x03\x04":
                return False
            nlen, xlen = struct.unpack("<HH", hdr[26:30])
            fh.read(nlen + xlen)
            raw = fh.read(info.compress_size)
        dec = _zipcrypto_decrypt(raw, keys)
        body = dec[12:]
        if _crc32_bytes(body) != info.CRC:
            return False
        return body
    except Exception:
        return False


# ===== 注入页构造 =====
def _build_desktop_index():
    pristine = _read_file(FNOS_WWW_INDEX)
    if pristine is None:
        return False, "无法读取系统 index.html"
    if WIDGET_SCRIPT_TAG in pristine:
        # 系统页已被旧方案注入（异常状态），不继续
        return False, "系统 index.html 含注入残留，需要先恢复系统"
    injected = pristine.replace("</body>", WIDGET_SCRIPT_TAG + "</body>", 1)
    os.makedirs(DESKTOP_DIR, exist_ok=True)
    # 显式保证 nginx(www-data) 可穿越目录（不依赖进程 umask）
    for d in (APP_DATA_DIR, DESKTOP_DIR):
        try:
            os.chmod(d, 0o755)
        except Exception:
            pass
    if not _write_file_direct(DESKTOP_INDEX, injected):
        return False, "注入页写入失败"
    import zlib
    _write_file_direct(PRISTINE_HASH_FILE,
                       "%08x" % (zlib.crc32(pristine.encode("utf-8")) & 0xFFFFFFFF))
    return True, "注入页已生成"


def _expected_desktop_index():
    pristine = _read_file(FNOS_WWW_INDEX)
    if pristine is None or WIDGET_SCRIPT_TAG in pristine:
        return None
    return pristine.replace("</body>", WIDGET_SCRIPT_TAG + "</body>", 1)


def _desktop_index_ok():
    expected = _expected_desktop_index()
    if expected is None:
        return False
    return _read_file(DESKTOP_INDEX) == expected


# ===== nginx 操作 =====
def _nginx_reload():
    # 注意：reload 会触发 trim_recover 恢复 conf.d，但我们的配置同时
    # 存在于 ng.conf.zip，所以恢复后配置仍然在。
    return _run_cmd("systemctl reload trim_nginx", timeout=30)


def _nginx_restart():
    return _run_cmd("systemctl restart trim_nginx", timeout=60)


# ===== 完整安装/修复 =====
_last_restart = 0.0


def _ensure_settings_file():
    """首次启动时创建默认 settings.json，让 GET /api/settings 不 404。"""
    try:
        if not os.path.exists(SETTINGS_FILE):
            os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
            default = {"_note": "auto-created default settings"}
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(default, f, ensure_ascii=False)
            os.chmod(SETTINGS_FILE, 0o644)
    except Exception:
        pass


def _ensure_installed(allow_restart=True):
    global _last_restart
    detail = []

    # 0. 默认 settings.json（首次启动）
    _ensure_settings_file()

    # 1. 注入页
    if not _desktop_index_ok():
        ok, msg = _build_desktop_index()
        if not ok:
            return False, msg
        detail.append("desktop-index")

    # 2. ng.conf.zip 中的加密配置（核对内容，不仅是存在性——
    #    防止路径漂移/旧版本/损坏条目）
    keys = _load_zip_keys()
    if keys is None:
        return False, "缺少 ZipCrypto 密钥文件"
    expected_conf = QW_NGINX_CONF_CONTENT.encode("utf-8")
    current = _read_encrypted_entry(NG_CONF_ZIP, QW_CONF_ARCNAME, keys)
    if current != expected_conf:
        if current is not None:
            _remove_entry(NG_CONF_ZIP, QW_CONF_ARCNAME)
        _add_encrypted_entry(NG_CONF_ZIP, QW_CONF_ARCNAME, expected_conf, keys)
        detail.append("ng.conf.zip")

    # 3. 运行中 nginx 的 conf.d：缺失或内容不符时让 nginx 重新加载配置。
    #    这里用 reload 而非 restart —— 实测 restart 会直接杀掉飞牛桌面页的
    #    WebSocket 连接（桌面反复断链、要刷新多次才能恢复），而 reload 是
    #    优雅重载，现有连接不受影响；并且 reload 同样会触发 trim_recover
    #    从 ng.conf.zip 恢复 conf.d（第 2 步已把期望内容写进 zip），
    #    实测单独一次 reload 即可既恢复文件、又让 nginx 载入新配置。
    #    reload 之后内容仍不符，才退回 restart 兜底。
    confd_current = _read_file(QW_NGINX_CONF)
    if confd_current != QW_NGINX_CONF_CONTENT:
        if allow_restart and time.time() - _last_restart > 180:
            _nginx_reload()
            time.sleep(2)
            if _read_file(QW_NGINX_CONF) != QW_NGINX_CONF_CONTENT:
                _nginx_restart()
                time.sleep(3)
                detail.append("nginx-restart")
            else:
                detail.append("nginx-reload")
            _last_restart = time.time()
        else:
            detail.append("restart-rate-limited")

    return True, ",".join(detail) or "already-ok"


def _do_uninstall():
    # 从 ng.conf.zip 删除我们的条目（原始字节复制，不需要解密其它条目）
    try:
        if _zip_contains(NG_CONF_ZIP, QW_CONF_ARCNAME):
            _remove_entry(NG_CONF_ZIP, QW_CONF_ARCNAME)
    except Exception as e:
        return False, f"ng.conf.zip 清理失败: {e}"

    _run_cmd(f"rm -f {QW_NGINX_CONF}")
    _nginx_restart()
    time.sleep(3)
    _run_cmd(f"rm -rf {DESKTOP_DIR}")
    return True, "已卸载注入"


# ===== 维护线程 =====
_maintenance_enabled = False
_maintenance_thread = None
_maintenance_lock = threading.Lock()


def _maintenance_loop():
    while _maintenance_enabled:
        try:
            _ensure_installed()
        except Exception:
            pass
        time.sleep(30)


def _start_maintenance():
    global _maintenance_enabled, _maintenance_thread
    with _maintenance_lock:
        _maintenance_enabled = True
        if _maintenance_thread is None or not _maintenance_thread.is_alive():
            _maintenance_thread = threading.Thread(
                target=_maintenance_loop, daemon=True)
            _maintenance_thread.start()


def _stop_maintenance():
    global _maintenance_enabled
    _maintenance_enabled = False


# ===== API =====
@app.route("/api/inject_status")
def inject_status():
    return jsonify({
        "desktop_index_ok": _desktop_index_ok(),
        "ngconf_has_entry": _zip_contains(NG_CONF_ZIP, QW_CONF_ARCNAME),
        "confd_exists": os.path.exists(QW_NGINX_CONF),
        "keys_loaded": _load_zip_keys() is not None,
        "maintenance_running":
            _maintenance_thread is not None and _maintenance_thread.is_alive(),
        "method": "alias + ng.conf.zip crypto-synced, zero www writes",
    })


@app.route("/api/diagnose")
def diagnose():
    return inject_status()


@app.route("/api/inject", methods=["POST"])
def inject():
    ok, msg = _ensure_installed(allow_restart=True)
    if not ok:
        return jsonify({"status": "error", "message": msg}), 500
    _start_maintenance()
    return jsonify({
        "status": "success",
        "message": "注入完成，请强制刷新飞牛桌面（Ctrl+Shift+R）查看。",
        "detail": msg,
    })


@app.route("/api/uninstall", methods=["POST"])
def uninstall():
    _stop_maintenance()
    time.sleep(1)
    ok, msg = _do_uninstall()
    return jsonify({
        "status": "success" if ok else "error",
        "message": "已从桌面移除小组件，请强制刷新飞牛桌面（Ctrl+Shift+R）",
        "detail": msg,
    })


# ===== 天气 API（设置页/备用；widget 直连 Open-Meteo） =====
@app.route("/api/geocode")
def geocode():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"error": "请输入地点名称"}), 400
    try:
        resp = requests.get(
            GEOCODING_API,
            params={"name": name, "count": 10, "language": "zh",
                    "format": "json"},
            timeout=TIMEOUT)
        resp.raise_for_status()
        return jsonify({"results": resp.json().get("results", [])})
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/weather")
def weather():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"error": "缺少经纬度参数"}), 400
    try:
        resp = requests.get(
            WEATHER_API,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": ["temperature_2m", "relative_humidity_2m",
                            "apparent_temperature", "is_day", "weather_code",
                            "wind_speed_10m", "wind_direction_10m",
                            "pressure_msl"],
                "daily": ["weather_code", "temperature_2m_max",
                          "temperature_2m_min", "sunrise", "sunset",
                          "precipitation_probability_max"],
                "timezone": "auto",
                "forecast_days": 5,
            },
            timeout=TIMEOUT)
        resp.raise_for_status()
        return jsonify(resp.json())
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


# ===== 小组件设置持久化（存 NAS，跨浏览器/跨设备共享） =====
@app.route("/api/settings", methods=["GET"])
def get_settings():
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return jsonify(json.load(f))
    except Exception:
        pass
    return jsonify({})


@app.route("/api/settings", methods=["POST", "OPTIONS"])
def save_settings():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})
    try:
        data = request.get_json(force=True, silent=True)
        if data is None:
            data = {}
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, SETTINGS_FILE)
        try:
            os.chmod(SETTINGS_FILE, 0o644)
        except Exception:
            pass
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ===== 用户自定义字体（单字体槽：<数据目录>/fonts/qwuser.<ext>） =====
def _find_font_slot():
    """返回当前槽位字体的 (绝对路径, 扩展名)；无则 (None, None)。"""
    try:
        for fn in os.listdir(FONTS_DIR):
            ext = os.path.splitext(fn)[1].lower()
            if os.path.splitext(fn)[0] == FONT_SLOT_PREFIX and ext in FONT_TYPES:
                return os.path.join(FONTS_DIR, fn), ext
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return None, None


def _remove_font_slot():
    try:
        for fn in os.listdir(FONTS_DIR):
            if os.path.splitext(fn)[0] == FONT_SLOT_PREFIX and \
                    os.path.splitext(fn)[1].lower() in FONT_TYPES:
                os.remove(os.path.join(FONTS_DIR, fn))
    except FileNotFoundError:
        pass


@app.errorhandler(RequestEntityTooLarge)
def handle_too_large(_e):
    return jsonify({"ok": False, "error": "字体文件不能超过 25MB"}), 413


@app.route("/api/font", methods=["GET", "POST", "DELETE", "OPTIONS"])
def font_api():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})

    try:
        os.makedirs(FONTS_DIR, exist_ok=True)
        try:
            os.chmod(FONTS_DIR, 0o755)
        except Exception:
            pass

        if request.method == "GET":
            path, ext = _find_font_slot()
            if not path:
                return jsonify({"ok": False, "error": "no font"}), 404
            resp = send_from_directory(FONTS_DIR, os.path.basename(path))
            resp.mimetype = FONT_TYPES[ext]
            resp.headers["Cache-Control"] = "no-store"
            return resp

        if request.method == "DELETE":
            _remove_font_slot()
            return jsonify({"ok": True})

        # POST：multipart 上传，字段名 font
        up = request.files.get("font")
        if up is None or not up.filename:
            return jsonify({"ok": False, "error": "未收到字体文件"}), 400
        original = os.path.basename(up.filename)
        ext = os.path.splitext(original)[1].lower()
        if ext not in FONT_TYPES:
            return jsonify({"ok": False,
                            "error": "仅支持 ttf / otf / woff / woff2 字体文件"}), 400

        head = up.stream.read(4)
        up.stream.seek(0)
        if not any(head.startswith(m) for m in FONT_MAGIC[ext]):
            return jsonify({"ok": False,
                            "error": "文件内容不是有效的字体文件"}), 400

        _remove_font_slot()
        dest = os.path.join(FONTS_DIR, FONT_SLOT_PREFIX + ext)
        up.save(dest)
        if os.path.getsize(dest) == 0:
            _remove_font_slot()
            return jsonify({"ok": False, "error": "字体文件为空"}), 400
        try:
            os.chmod(dest, 0o644)
        except Exception:
            pass

        return jsonify({
            "ok": True,
            "fontName": original,
            "fontExt": ext,
            "fontV": int(time.time()),
            "size": os.path.getsize(dest)
        })
    except RequestEntityTooLarge:
        raise
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ===== 启动即安装 + 维护 =====
try:
    _ensure_installed()
except Exception:
    pass

_start_maintenance()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8780))
    app.run(host="0.0.0.0", port=port, debug=False)
