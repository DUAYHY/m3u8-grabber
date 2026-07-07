"""通用 HLS(M3U8) 视频下载器 — 本地服务版"""

# ============================================================
#  自动检测并安装依赖
# ============================================================
import sys, subprocess as _sp, importlib as _im

_required = {
    'requests': 'requests',
    'Crypto': 'pycryptodome',
    'tqdm': 'tqdm',
}
_missing = []
for _mod, _pkg in _required.items():
    try:
        _im.import_module(_mod)
    except ImportError:
        _missing.append(_pkg)

if _missing:
    print(f'[依赖] 正在安装: {" ".join(_missing)} ...')
    _sp.check_call(
        [sys.executable, '-m', 'pip', 'install', *_missing,
         '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
        stdout=_sp.DEVNULL, stderr=_sp.DEVNULL
    )
    print('[依赖] 安装完成，重启程序...\n')
    _sp.run([sys.executable] + sys.argv)
    sys.exit(0)

# ============================================================
import os, time, shutil, subprocess, binascii, re
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlsplit, urlparse, parse_qs
import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from tqdm import tqdm

# 强制 stdout 行缓冲，确保 Windows CMD 中实时输出
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE_DIR, 'downloads')
os.makedirs(OUT, exist_ok=True)
LOG_FILE = os.path.join(BASE_DIR, 'downloader.log')


def _console_encoding():
    """获取 Windows 控制台实际代码页，避免 UTF-8/GBK 猜错"""
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetConsoleOutputCP()
        if cp == 65001:
            return 'utf-8'
        elif cp == 936:
            return 'gbk'
        else:
            return f'cp{cp}'
    except Exception:
        return (sys.stdout.encoding or 'utf-8').lower()


CONSOLE_ENC = _console_encoding()


def log(msg, end='\n'):
    """同时输出到控制台和日志文件。控制台按实际代码页编码，避免乱码"""
    ts = time.strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    # 1. 文件日志（始终可靠）
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line)
            if end:
                f.write(end)
            f.flush()
    except Exception:
        pass
    # 2. 控制台：按真实代码页编码
    try:
        data = (line + end).encode(CONSOLE_ENC, errors='replace')
    except Exception:
        data = (line + end).encode('utf-8', errors='replace')
    try:
        os.write(1, data)
    except Exception:
        try:
            os.write(2, data)
        except Exception:
            pass


FFMPEG = os.path.join(BASE_DIR, 'ffmpeg.exe')


def safe_name(name):
    """去除文件名中的非法字符"""
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()


def find_ffmpeg():
    for p in [FFMPEG, shutil.which('ffmpeg'), shutil.which('ffmpeg.exe')]:
        if p and os.path.isfile(p):
            return p
    return None


def _parse_url_token(url):
    """从 URL 参数中提取 token 过期时间，返回 (expiry_ts, 人类可读时间)"""
    params = parse_qs(urlparse(url).query)
    for key in ('expires', 'expire', 'deadline', 'exp', 't', 'timestamp', 'ts', 'etime', 'end'):
        vals = params.get(key, [])
        if vals:
            try:
                ts = int(vals[0])
                if ts > 1000000000:  # 秒级时间戳
                    dt_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))
                    return ts, dt_str
            except (ValueError, OSError):
                pass
    return None, None


def detect_proxy():
    """扫描常见代理端口，返回代理地址或 None"""
    import socket
    for port in (7897, 7890, 10809, 1080, 8080):
        try:
            s = socket.create_connection(('127.0.0.1', port), timeout=0.5)
            s.close()
            log(f'检测到代理: http://127.0.0.1:{port}')
            return f'http://127.0.0.1:{port}'
        except (socket.timeout, ConnectionRefusedError, OSError):
            continue
    log('未检测到代理，使用直连')
    return None


def derive_referer(url):
    """从地址 origin 推导兜底 Referer"""
    try:
        p = urlsplit(url)
        if p.scheme and p.netloc:
            return f'{p.scheme}://{p.netloc}/'
    except Exception:
        pass
    return None


def smart_get(s, url, **kw):
    """智能 GET：探测代理是否可用，不可用则自动切换直连（整 session 生效）"""
    if not s.trust_env:
        return s.get(url, **kw)
    try:
        return s.get(url, **kw)
    except requests.exceptions.ProxyError as e:
        log(f'  代理不可达（{str(e)[:60]}），关闭代理改用直连')
        s.trust_env = False
        return s.get(url, **kw)


def fetch_playlist(s, m3u8_url, depth=0):
    """获取 m3u8；若是 master playlist 则自动选最高码率子列表，返回 (文本, base_url)"""
    resp = smart_get(s, m3u8_url, timeout=30)
    resp.raise_for_status()
    text = resp.text
    if '#EXT-X-STREAM-INF' in text:
        best_bw, best_url = -1, None
        lines = text.split('\n')
        for i, line in enumerate(lines):
            line = line.strip()
            if line.startswith('#EXT-X-STREAM-INF'):
                m = re.search(r'BANDWIDTH=(\d+)', line)
                bw = int(m.group(1)) if m else 0
                for j in range(i + 1, len(lines)):
                    nxt = lines[j].strip()
                    if nxt and not nxt.startswith('#'):
                        if bw > best_bw:
                            best_bw = bw
                            best_url = nxt if nxt.startswith('http') else urljoin(m3u8_url, nxt)
                        break
        if best_url and depth < 3:
            log(f'  master: 选最高码率 {best_bw}bps -> {best_url[:80]}')
            return fetch_playlist(s, best_url, depth + 1)
    base = '/'.join(m3u8_url.split('/')[:-1]) + '/'
    return text, base


def _download_dash(name, video_url, audio_url, referer=None):
    """DASH 下载：单个视频 m4s + 可选音频 m4s，ffmpeg 合并"""
    s = requests.Session()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
    }
    if referer: headers['Referer'] = referer
    s.headers.update(headers)

    log(f'\n  {name} [DASH]')
    log(f'  {"-" * 50}')
    tmp = os.path.join(OUT, f'dash_{int(time.time())}')
    os.makedirs(tmp, exist_ok=True)

    # 下载视频
    log('  下载视频...', end=' ')
    try:
        vdata = smart_get(s, video_url, timeout=120).content
    except Exception as e:
        log(f'失败: {e}')
        shutil.rmtree(tmp, ignore_errors=True)
        return False
    vfp = os.path.join(tmp, 'video.m4s')
    with open(vfp, 'wb') as f: f.write(vdata)
    log(f'{len(vdata)/1048576:.1f} MB')

    # 下载音频
    if audio_url:
        log('  下载音频...', end=' ')
        try:
            adata = smart_get(s, audio_url, timeout=120).content
        except Exception as e:
            log(f'失败: {e}')
            shutil.rmtree(tmp, ignore_errors=True)
            return False
        afp = os.path.join(tmp, 'audio.m4s')
        with open(afp, 'wb') as f: f.write(adata)
        log(f'{len(adata)/1048576:.1f} MB')

    # 合并
    output = os.path.join(OUT, f'{safe_name(name)}.mp4')
    if audio_url:
        cmd = [find_ffmpeg() or 'ffmpeg', '-i', vfp, '-i', afp, '-c', 'copy', '-movflags', '+faststart', '-y', output]
    else:
        cmd = [find_ffmpeg() or 'ffmpeg', '-i', vfp, '-c', 'copy', '-movflags', '+faststart', '-y', output]
    r = subprocess.run(cmd, capture_output=True, encoding='utf-8', errors='replace', timeout=600)
    if r.returncode != 0:
        log(f'  无损合并失败: {(r.stderr or "")[-150:].strip()}，重编码...')
        if audio_url:
            cmd2 = [find_ffmpeg() or 'ffmpeg', '-i', vfp, '-i', afp, '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart', '-y', output]
        else:
            cmd2 = [find_ffmpeg() or 'ffmpeg', '-i', vfp, '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart', '-y', output]
        subprocess.run(cmd2, capture_output=True, encoding='utf-8', errors='replace', timeout=600)

    shutil.rmtree(tmp, ignore_errors=True)
    if os.path.exists(output):
        mb = os.path.getsize(output) / 1048576
        log(f'  {mb:.1f} MB -> {output}')
        return True
    log('  合并失败')
    return False


def download_one(name, m3u8_url, referer=None, audio_url=None):
    """下载单个视频"""
    # DASH 模式（B站 VOD）：单个 m4s + 可选音频
    if audio_url or '.m4s' in m3u8_url.split('?')[0]:
        return _download_dash(name, m3u8_url, audio_url, referer)

    s = requests.Session()
    ref = referer or derive_referer(m3u8_url)
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
    }
    if ref:
        headers['Referer'] = ref
        try:
            from urllib.parse import urlparse
            p = urlparse(ref)
            headers['Origin'] = f'{p.scheme}://{p.netloc}'
        except:
            pass
    s.headers.update(headers)

    log(f'\n  {name}')
    log(f'  {"─" * 50}')
    if ref:
        log(f'  Referer: {ref[:80]}')

    # --- Token 过期预检 ---
    exp_ts, exp_str = _parse_url_token(m3u8_url)
    if exp_ts:
        now_ts = int(time.time())
        if exp_ts < now_ts:
            log(f'  ⚠ Token 已过期！过期时间: {exp_str} (已过 {now_ts - exp_ts} 秒)')
        else:
            remain = exp_ts - now_ts
            log(f'  Token 有效，过期时间: {exp_str} (剩余 {remain}s ≈ {remain/60:.0f}min)')

    # 1. 下载并解析 M3U8（自动处理 master playlist）
    log('  [1/4] 下载索引...', end=' ')
    try:
        m3u8, base = fetch_playlist(s, m3u8_url)
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if hasattr(e, 'response') and e.response else 0
        body = (e.response.text or '')[:200] if hasattr(e, 'response') and e.response else ''
        log(f'  HTTP {code}')
        if code == 403:
            log(f'  ┌ 403 可能原因:')
            log(f'  │ 1. 链接中的 token 已过期（通常有时效）')
            log(f'  │ 2. Referer 不匹配 CDN 防盗链白名单')
            log(f'  │ 3. 请求 IP 与 token 签发时的 IP 不一致')
            log(f'  └ 建议: 刷新页面后重新嗅探 m3u8 地址再发送')
            if body: log(f'  响应: {body[:200]}')
        elif code == 404:
            log(f'  ┌ 404: M3U8 文件已被 CDN 移除，链接已失效')
            log(f'  └ 建议: 刷新页面重新嗅探')
        elif code == 401:
            log(f'  ┌ 401: 需要认证，token 可能已过期')
            log(f'  └ 建议: 刷新页面重新嗅探')
        elif code >= 500:
            log(f'  CDN 服务器错误，可稍后重试')
        else:
            if body: log(f'  响应: {body[:200]}')
        return False
    except requests.exceptions.ProxyError as e:
        log(f'  代理连接错误: {str(e)[:100]}')
        log(f'  系统代理不可用，尝试运行 启动.bat 或关闭系统代理后重试')
        return False
    except requests.exceptions.ConnectionError as e:
        log(f'  无法连接: DNS 解析失败或网络不通 ({str(e)[:100]})')
        return False
    except requests.exceptions.Timeout:
        log(f'  连接超时 (30s)，CDN 节点不可达，检查网络或稍后重试')
        return False
    except Exception as e:
        log(f'  失败: {e}')
        return False

    # 2. 解析
    segments = []
    init_segment = None  # fMP4 初始化段
    key_url = None
    iv = None
    explicit_iv = False
    for line in m3u8.split('\n'):
        line = line.strip()
        if '#EXT-X-MAP:' in line:
            um = re.search(r'URI="?([^",]+)"?', line)
            if um:
                iurl = um.group(1)
                init_segment = iurl if iurl.startswith('http') else urljoin(base, iurl)
                log(f'  fMP4 初始化段: {init_segment[:100]}')
        elif '#EXT-X-KEY' in line and 'URI=' in line:
            # 兼容 URI="..." 和 URI=... 两种格式
            uri_match = re.search(r'URI="?([^",]+)"?', line)
            if uri_match:
                key_url = uri_match.group(1)
                if not key_url.startswith('http'):
                    key_url = urljoin(base, key_url)
                iv_s = line.find('IV=0x')
                if iv_s != -1:
                    iv = binascii.unhexlify(line[iv_s + 5:iv_s + 37])
                    explicit_iv = True
                else:
                    iv = None
                    explicit_iv = False
            if 'METHOD=NONE' in line.upper():
                key_url = None
            elif 'AES-128' not in line:
                m = re.search(r'METHOD=([A-Z0-9-]+)', line)
                if m:
                    log(f'  ⚠ 不支持的加密方法: {m.group(1)}')
        elif line and not line.startswith('#'):
            u = line if line.startswith('http') else urljoin(base, line)
            segments.append(u)

    log(f'{len(segments)} 片段')
    if key_url:
        log(f'  加密: AES-128 | 密钥: {key_url[:100]}')
    else:
        log(f'  加密: 无（明文 TS）')
    if segments:
        log(f'  首分片: {segments[0][:120]}')

    # --- 2.5 嵌套 M3U8 检测 ---
    if len(segments) <= 2:
        log('  [2.5] 检测嵌套索引...', end=' ')
        if not segments:
            log('M3U8 中无 TS 片段')
        else:
            try:
                probe = smart_get(s, segments[0], timeout=30).content
                if probe.strip()[:20].startswith(b'#EXTM3U'):
                    log('发现嵌套 M3U8，展开中...')
                    inner_text = probe.decode('utf-8', errors='replace')
                    inner_base = '/'.join(segments[0].split('/')[:-1]) + '/'
                    new_segs, new_key = [], None
                    new_iv, new_exp = None, False
                    for iline in inner_text.split('\n'):
                        iline = iline.strip()
                        if '#EXT-X-KEY' in iline and 'URI=' in iline:
                            um = re.search(r'URI="?([^",]+)"?', iline)
                            if um:
                                new_key = um.group(1)
                                if not new_key.startswith('http'):
                                    new_key = urljoin(inner_base, new_key)
                                iv_s2 = iline.find('IV=0x')
                                if iv_s2 != -1:
                                    new_iv = binascii.unhexlify(iline[iv_s2 + 5:iv_s2 + 37])
                                    new_exp = True
                        elif iline and not iline.startswith('#'):
                            u = iline if iline.startswith('http') else urljoin(inner_base, iline)
                            new_segs.append(u)
                    if new_segs:
                        segments, key_url = new_segs, new_key
                        iv, explicit_iv = new_iv, new_exp
                        log(f'{len(segments)} 个真实片段' + (' [加密]' if new_key else ' [明文]'))
                else:
                    log('非嵌套（直接 TS 片段）')
            except Exception as e:
                log(f'检测跳过 ({e})')

    encrypted = key_url is not None

    # 3. 获取密钥（无加密则跳过）
    key = None
    if encrypted:
        log('  [2/4] 获取密钥...', end=' ')
        try:
            key = smart_get(s, key_url, timeout=15).content
            log(f'{len(key)} 字节' + (' [显式IV]' if explicit_iv else ' [序号IV]'))
        except Exception as e:
            log(f'失败: {e}')
            return False
    else:
        log('  [2/4] 无加密，跳过密钥')

    # 4. 并行下载
    tmp = os.path.join(OUT, f'tmp_{int(time.time())}')
    os.makedirs(tmp, exist_ok=True)

    # 下载 fMP4 初始化段（若有）
    if init_segment:
        try:
            idata = smart_get(s, init_segment, timeout=30).content
            ifp = os.path.join(tmp, 'init.mp4')
            with open(ifp, 'wb') as f:
                f.write(idata)
            log(f'  初始化段: {len(idata)} 字节')
        except Exception as e:
            log(f'  初始化段下载失败: {e}')
            init_segment = None

    def dl_one(url, idx):
        for _ in range(3):
            try:
                data = smart_get(s, url, timeout=60).content
                break
            except:
                time.sleep(1)
        else:
            return None
        if encrypted:
            if explicit_iv:
                seg_iv = iv                              # 显式 IV：所有片段共用
            else:
                seg_iv = b'\x00' * 12 + idx.to_bytes(4, 'big')  # 序号 IV
            dec = AES.new(key, AES.MODE_CBC, iv=seg_iv).decrypt(data)
            try:
                dec = unpad(dec, AES.block_size)
            except:
                pass
            data = dec
        fp = os.path.join(tmp, f's_{idx:05d}.ts')
        with open(fp, 'wb') as f:
            f.write(data)
        return fp

    t0 = time.time()
    results = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        fut = {ex.submit(dl_one, u, i): i for i, u in enumerate(segments)}
        with tqdm(total=len(segments), desc='  [3/4] 下载中', unit='片',
                  ncols=60, bar_format='{desc}: {percentage:3.0f}%|{bar}| {n_fmt}/{total_fmt}') as pbar:
            for f in as_completed(fut):
                if f.result():
                    results[fut[f]] = f.result()
                    pbar.update(1)
    elapsed = time.time() - t0

    if not results:
        log('  所有片段下载失败')
        shutil.rmtree(tmp, ignore_errors=True)
        return False

    # 5. 合并
    log(f'  [4/4] 合并 ({elapsed:.1f}s 下载, {len(results)}/{len(segments)} 成功)...', end=' ')
    files = [results[i] for i in sorted(results)]
    output = os.path.join(OUT, f'{safe_name(name)}.mp4')

    # Concat 列表（fMP4 初始化段排最前）
    lst = os.path.join(OUT, '_concat.txt')
    with open(lst, 'w', encoding='utf-8') as f:
        if init_segment and os.path.exists(os.path.join(tmp, 'init.mp4')):
            ffp = os.path.join(tmp, 'init.mp4').replace(os.sep, '/')
            f.write(f"file '{ffp}'\n")
        for fp in files:
            f.write(f"file '{fp.replace(os.sep, '/')}'\n")

    if os.path.exists(output):
        os.remove(output)

    cmd = [find_ffmpeg() or 'ffmpeg', '-f', 'concat', '-safe', '0',
           '-i', lst, '-c', 'copy', '-movflags', '+faststart', '-y', output]
    r = subprocess.run(cmd, capture_output=True, encoding='utf-8',
                       errors='replace', timeout=600)
    if os.path.exists(lst):
        os.remove(lst)

    if r.returncode != 0:
        # 重编码回退
        lst2 = os.path.join(OUT, '_concat2.txt')
        with open(lst2, 'w', encoding='utf-8') as f:
            if init_segment and os.path.exists(os.path.join(tmp, 'init.mp4')):
                ffp = os.path.join(tmp, 'init.mp4').replace(os.sep, '/')
                f.write(f"file '{ffp}'\n")
            for fp in files:
                f.write(f"file '{fp.replace(os.sep, '/')}'\n")
        cmd2 = [find_ffmpeg() or 'ffmpeg', '-f', 'concat', '-safe', '0',
                '-i', lst2, '-c:v', 'libx264', '-c:a', 'aac',
                '-movflags', '+faststart', '-y', output]
        subprocess.run(cmd2, capture_output=True, encoding='utf-8',
                       errors='replace', timeout=600)
        if os.path.exists(lst2):
            os.remove(lst2)

    shutil.rmtree(tmp, ignore_errors=True)

    if os.path.exists(output):
        mb = os.path.getsize(output) / 1048576
        log(f'  {mb:.1f} MB  ->  {output}')
        return True
    else:
        log('  合并失败')
        return False


# ============================================================
#  HTTP 服务 — 接收浏览器发来的下载任务
# ============================================================

import json
import traceback
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8910
total_count = 0
count_lock = threading.Lock()

# 线程池：支持同时下载最多3个
download_pool = ThreadPoolExecutor(max_workers=3)

# 直播录制状态
live_stop_event = threading.Event()
live_recording_active = False
live_recording_count = 0
live_recording_name = ''
live_recording_start = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_OPTIONS(self):
        log(f'HTTP OPTIONS {self.path}')
        self._cors()

    def do_GET(self):
        log(f'HTTP GET {self.path}')
        self._cors()
        self._json({
            'status': 'running', 'port': PORT, 'total': total_count,
            'dir': BASE_DIR, 'ffmpeg': find_ffmpeg(),
        })

    def do_POST(self):
        global total_count, live_recording_active, live_stop_event
        log(f'HTTP POST {self.path} 开始处理')

        # 直播状态查询 / 停止
        if self.path == '/live/status':
            self._cors()
            self._json({
                'recording': live_recording_active,
                'count': live_recording_count,
                'elapsed': int(time.time()) - live_recording_start if live_recording_active else 0,
            })
            return

        if self.path == '/live/stop':
            self._cors()
            if not live_recording_active:
                self._json({'status': 'error', 'msg': 'no recording'})
                return
            log('>>> 停止录制')
            live_stop_event.set()
            self._json({'status': 'stopping', 'msg': '正在停止并合并...'})
            return

        # /send 逻辑（点播+直播共用）
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            data = json.loads(raw)
            name = data.get('name', '').strip()
            url = data.get('url', '').strip()
            referer = (data.get('referer') or data.get('page') or '').strip()

            log(f'HTTP POST {self.path} body_len={length}')
            log(f'JSON: name={name!r} url={url[:60]}... referer={referer[:60]}')

            if not name or not url:
                log('拒绝任务：name 或 url 为空')
                self._cors()
                self._json({'status': 'error', 'msg': 'missing name or url'})
                return

            log(f'>>> 收到任务: [{name}]')
            log(f'    URL: {url[:80]}...')

            # 检查是否直播模式
            is_live = data.get('live', False)
            if is_live:
                if live_recording_active:
                    self._cors()
                    self._json({'status': 'error', 'msg': 'already recording'})
                    return
                live_recording_active = True
                live_stop_event.clear()
                self._cors()
                self._json({'status': 'recording', 'msg': f'recording: {name}'})
                log('已响应 recording，提交后台录制...')
                download_pool.submit(self._record_live, name, url, referer)
            else:
                audio_url = data.get('audio_url', '') or ''
                self._cors()
                self._json({'status': 'accepted', 'msg': f'已接收: {name}'})
                log(f'已响应 accepted，提交后台下载...')
                download_pool.submit(self._do_download, name, url, referer, audio_url)

        except Exception as e:
            tb = traceback.format_exc()
            log(f'HTTP POST 异常: {e}')
            log(f'异常堆栈: {tb}')
            self._cors()
            self._json({'status': 'error', 'msg': str(e)})

    def _do_download(self, name, url, referer, audio_url=''):
        """在单独线程中执行下载"""
        global total_count
        log(f'开始下载: [{name}]')
        ok = download_one(name, url, referer or None, audio_url or None)
        with count_lock:
            if ok:
                total_count += 1
            log(f'--- 任务结束: [{name}] {"成功" if ok else "失败"} (累计: {total_count}) ---')
            log('等待新任务...')

    def _record_live(self, name, url, referer):
        """循环拉取 M3U8，只下载新片段，直到被 stop"""
        global live_recording_active, live_recording_count, live_recording_name, live_recording_start

        s = requests.Session()
        s.trust_env = True
        ref = referer or derive_referer(url)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        }
        if ref:
            headers['Referer'] = ref
            try:
                from urllib.parse import urlparse
                p = urlparse(ref)
                headers['Origin'] = f'{p.scheme}://{p.netloc}'
            except:
                pass
        s.headers.update(headers)

        live_recording_count = 0
        live_recording_name = name
        live_recording_start = int(time.time())
        log(f'\n  [LIVE] {name}')
        log(f'  {"=" * 50}')
        log(f'  URL: {url[:120]}')

        tmp = os.path.join(OUT, f'live_{int(time.time())}')
        os.makedirs(tmp, exist_ok=True)
        seen_urls = set()
        all_files = {}
        key = None
        prev_key_url = None
        iv = b'\x00' * 16

        try:
            while not live_stop_event.is_set():
                # 拉取 M3U8
                try:
                    resp = smart_get(s, url, timeout=30)
                    resp.raise_for_status()
                except Exception:
                    try:
                        resp = s.get(url, timeout=30, proxies={'http': None, 'https': None})
                        resp.raise_for_status()
                        s.trust_env = False
                        log('  已切换直连模式')
                    except Exception as e:
                        log(f'  拉取 M3U8 失败: {str(e)[:60]}，5 秒后重试...')
                        live_stop_event.wait(5)
                        continue

                m3u8_text = resp.text
                base = '/'.join(url.split('/')[:-1]) + '/'

                # 解析片段
                cur_segs = []
                init_seg = None
                for line in m3u8_text.split('\n'):
                    line = line.strip()
                    if '#EXT-X-MAP:' in line:
                        um = re.search(r'URI="?([^",]+)"?', line)
                        if um:
                            iurl = um.group(1)
                            init_seg = iurl if iurl.startswith('http') else urljoin(base, iurl)
                            log(f'  fMP4 初始化段: {init_seg[:100]}')
                    elif 'URI=' in line and '#EXT-X-KEY' in line:
                        um = re.search(r'URI="?([^",]+)"?', line)
                        if um:
                            kurl = um.group(1)
                            if not kurl.startswith('http'):
                                kurl = urljoin(base, kurl)
                            if kurl != prev_key_url:
                                try:
                                    key = smart_get(s, kurl, timeout=15).content
                                    log(f'  新密钥: {len(key)} 字节')
                                    prev_key_url = kurl
                                except:
                                    pass
                        iv_s = line.find('IV=0x')
                        if iv_s != -1:
                            iv = binascii.unhexlify(line[iv_s + 5:iv_s + 37])
                    elif line and not line.startswith('#'):
                        u = line if line.startswith('http') else urljoin(base, line)
                        cur_segs.append(u)

                # 下载 fMP4 初始化段（首次且未下载过）
                if init_seg and 'init' not in seen_urls:
                    seen_urls.add('init')
                    try:
                        idata = smart_get(s, init_seg, timeout=30).content
                        ifp = os.path.join(tmp, 'init.mp4')
                        with open(ifp, 'wb') as f:
                            f.write(idata)
                        all_files[-1] = ifp  # 负数 key 确保排最前面
                        log(f'  初始化段已下载: {len(idata)} 字节')
                    except Exception as e:
                        log(f'  初始化段下载失败: {e}')

                # 下载新片段
                new_count = 0
                for seg_url in cur_segs:
                    if seg_url in seen_urls:
                        continue
                    seen_urls.add(seg_url)

                    data = None
                    for _ in range(3):
                        try:
                            data = smart_get(s, seg_url, timeout=60).content
                            break
                        except:
                            time.sleep(1)
                    # curl_cffi 浏览器伪装兜底
                    if data is None:
                        continue

                    # 诊断：打印首个分片的前几个字节
                    if live_recording_count == 0:
                        preview = data[:80]
                        log(f'  首段预览: {preview[:60].hex()} {"..." if len(preview) > 60 else ""} ({"text" if preview[:1].isdigit() or preview[:4].startswith(b"<") or preview[:4].startswith(b"{") else "binary"})')

                    idx = live_recording_count
                    if key is not None:
                        seg_iv = iv[:12] + idx.to_bytes(4, 'big')
                        try:
                            dec = AES.new(key, AES.MODE_CBC, iv=seg_iv).decrypt(data)
                            dec = unpad(dec, AES.block_size)
                        except:
                            dec = data
                        data = dec

                    fp = os.path.join(tmp, f's_{idx:05d}.ts')
                    with open(fp, 'wb') as f:
                        f.write(data)
                    all_files[idx] = fp
                    live_recording_count += 1
                    new_count += 1

                elapsed = int(time.time()) - live_recording_start
                log(f'  [{elapsed//60:02d}:{elapsed%60:02d}] +{new_count} 片段 (累计 {live_recording_count})')

                if not live_stop_event.is_set():
                    live_stop_event.wait(5)

        finally:
            # 合并
            if all_files:
                output = os.path.join(OUT, f'{safe_name(name)}.mp4')
                # 验证文件
                valid = {}
                for idx in sorted(all_files):
                    fp = all_files[idx]
                    if os.path.exists(fp) and os.path.getsize(fp) > 0:
                        valid[idx] = fp
                all_files = valid
                if not all_files:
                    log(f'  [LIVE] 无有效片段')
                    shutil.rmtree(tmp, ignore_errors=True)
                    live_recording_active = False
                    return

                # Python 二进制拼接（兼容 fMP4/TS 所有格式）
                raw_out = os.path.join(OUT, f'_{safe_name(name)}_raw.mp4')
                total_bytes = 0
                with open(raw_out, 'wb') as out:
                    for idx in sorted(all_files):
                        with open(all_files[idx], 'rb') as fin:
                            data = fin.read()
                            out.write(data)
                            total_bytes += len(data)
                log(f'  [LIVE] 拼接完成: {total_bytes} 字节, {len(all_files)} 个文件')

                # 探测编码格式
                probe = [find_ffmpeg() or 'ffmpeg', '-i', raw_out]
                p = subprocess.run(probe, capture_output=True, encoding='utf-8',
                                   errors='replace', timeout=30)
                has_av1 = 'av1' in (p.stderr or '').lower() or 'av01' in (p.stderr or '').lower()

                if has_av1:
                    log(f'  [LIVE] 检测到 AV1 编码，转 H.264...')
                    cmd = [find_ffmpeg() or 'ffmpeg', '-i', raw_out,
                           '-c:v', 'libx264', '-preset', 'fast',
                           '-c:a', 'aac', '-movflags', '+faststart', '-y', output]
                else:
                    cmd = [find_ffmpeg() or 'ffmpeg', '-i', raw_out,
                           '-c', 'copy', '-movflags', '+faststart', '-y', output]
                r = subprocess.run(cmd, capture_output=True, encoding='utf-8',
                                   errors='replace', timeout=600)
                if r.returncode != 0:
                    log(f'  [LIVE] 合并失败，转 H.264 重编...')
                    cmd2 = [find_ffmpeg() or 'ffmpeg', '-i', raw_out,
                            '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast',
                            '-movflags', '+faststart', '-y', output]
                    r = subprocess.run(cmd2, capture_output=True, encoding='utf-8',
                                   errors='replace', timeout=600)
                if os.path.exists(raw_out):
                    os.remove(raw_out)
                if os.path.exists(output):
                    mb = os.path.getsize(output) / 1048576
                    log(f'  [LIVE] 录制完成: {mb:.1f} MB -> {output}')
                else:
                    log(f'  [LIVE] 合并失败，检查 ffmpeg 是否支持该编码格式')
            else:
                log(f'  [LIVE] 无片段，跳过合并')

            shutil.rmtree(tmp, ignore_errors=True)
            with live_recording_lock:
                live_recording_active = False

    def _cors(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.wfile.write(body)


def main():
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        log('未找到 ffmpeg.exe，请放到本目录下')
        sys.exit(1)

    # 自动检测代理，有则设为环境变量
    proxy = detect_proxy()
    if proxy:
        os.environ['HTTPS_PROXY'] = proxy
        os.environ['HTTP_PROXY'] = proxy

    # SO_REUSEADDR: TIME_WAIT 连接残留也能绑定端口
    import socket as _sk
    HTTPServer.allow_reuse_address = True
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    server.socket.setsockopt(_sk.SOL_SOCKET, _sk.SO_REUSEADDR, 1)

    log('=' * 50)
    log('通用 HLS(M3U8) 视频下载器 启动')
    log(f'ffmpeg: {ffmpeg}')
    log(f'输出:   {OUT}')
    log(f'端口:   localhost:{PORT}')
    log('等待浏览器发送下载任务...')
    log('在视频页面点击 "发送到下载" 即可')
    log('按 Ctrl+C 退出')
    log('=' * 50)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('\n退出。本次共下载 {} 个视频。'.format(total_count))
        server.shutdown()


if __name__ == '__main__':
    main()
