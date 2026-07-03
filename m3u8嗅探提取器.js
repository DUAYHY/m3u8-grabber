// ==UserScript==
// @name         通用 m3u8 视频地址嗅探提取器
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  自动拦截并解析 m3u8 播放列表，显示分辨率/码率/时长/大小，区分主链接和子链接
// @author       v5.1 — 自动解析子链接时长、识别纯音频流、更好说明
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var m3u8Meta = {};

    function storageGet(key, def) {
        try { return localStorage.getItem('xe_m3u8_' + key) || def; } catch(e) { return def; }
    }
    function storageSet(key, val) {
        try { localStorage.setItem('xe_m3u8_' + key, val); } catch(e) {}
    }
    var downloaderDir = storageGet('downloaderDir', '');

    // ============================================================
    //  M3U8 解析
    // ============================================================
    function parseM3u8Content(text, baseUrl) {
        var info = { type: 'media' };

        // 检测主播放列表
        if (/#EXT-X-STREAM-INF/i.test(text)) {
            info.type = 'master';
            info.variants = [];
            var lines = text.split('\n');
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.toUpperCase().indexOf('#EXT-X-STREAM-INF') === 0) {
                    var variant = { url: '', bandwidth: 0, avgBandwidth: 0, resolution: '', codecs: '', frameRate: '' };

                    var bw = line.match(/BANDWIDTH=(\d+)/i);
                    if (bw) variant.bandwidth = parseInt(bw[1]);

                    var abw = line.match(/AVERAGE-BANDWIDTH=(\d+)/i);
                    if (abw) variant.avgBandwidth = parseInt(abw[1]);

                    var res = line.match(/RESOLUTION=(\d+x\d+)/i);
                    if (res) variant.resolution = res[1];

                    var codec = line.match(/CODECS="([^"]+)"/i);
                    if (codec) variant.codecs = codec[1];

                    var fr = line.match(/FRAME-RATE=([\d.]+)/i);
                    if (fr) variant.frameRate = fr[1];

                    // 找到 URL 行
                    for (var j = i + 1; j < lines.length; j++) {
                        var next = lines[j].trim();
                        if (next && next.indexOf('#') !== 0) {
                            variant.url = /^https?:\/\//i.test(next) ? next : resolveUrl(baseUrl, next);
                            break;
                        }
                    }
                    // 检测音频流
                    variant.isAudioOnly = detectAudioOnly(variant.resolution, variant.codecs, variant.bandwidth);
                    info.variants.push(variant);
                }
            }
        }

        // 解析媒体播放列表的片段信息
        var segmentCount = 0;
        var totalDuration = 0;
        var targetDuration = 0;
        var hasEndList = false;
        var lines = text.split('\n');
        for (var k = 0; k < lines.length; k++) {
            var ln = lines[k].trim();
            if (ln.toUpperCase().indexOf('#EXTINF:') === 0) {
                var dur = ln.match(/#EXTINF:\s*([\d.]+)/i);
                if (dur) { totalDuration += parseFloat(dur[1]); segmentCount++; }
            }
            if (ln.toUpperCase().indexOf('#EXT-X-TARGETDURATION:') === 0) {
                var td = ln.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/i);
                if (td) targetDuration = parseFloat(td[1]);
            }
            if (ln.toUpperCase().indexOf('#EXT-X-ENDLIST') === 0) {
                hasEndList = true;
            }
        }

        info.segments = segmentCount;
        info.duration = totalDuration;
        info.targetDuration = targetDuration;
        info.isVod = hasEndList;

        return info;
    }

    // 检测是否纯音频流
    function detectAudioOnly(resolution, codecs, bandwidth) {
        // 1) 有编码信息，只含音频编码
        if (codecs) {
            var hasVideo = /avc|hvc|hevc|h\.?264|h\.?265|av1|vp[89]|mpeg/i.test(codecs);
            var hasAudio = /mp4a|aac|opus|vorbis|mp3|ac-3|ec-3/i.test(codecs);
            if (hasAudio && !hasVideo) return true;
        }
        // 2) 没分辨率 + 低码率（视频码率一般 > 500kbps）
        if ((!resolution || resolution === '0x0') && bandwidth > 0 && bandwidth < 500000) {
            return true;
        }
        return false;
    }

    function resolveUrl(base, relative) {
        if (!relative) return base;
        if (/^https?:\/\//i.test(relative)) return relative;
        if (relative.indexOf('/') === 0) {
            var m = base.match(/^(https?:\/\/[^\/]+)/);
            return (m ? m[1] : '') + relative;
        }
        var lastSlash = base.lastIndexOf('/');
        return lastSlash >= 0 ? base.substring(0, lastSlash + 1) + relative : base + '/' + relative;
    }

    function formatBitrate(bps) {
        if (!bps || bps <= 0) return '';
        if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
        // kbps 取整，不显示小数
        return Math.round(bps / 1000) + ' kbps';
    }

    function formatDuration(sec) {
        if (!sec || sec <= 0) return '';
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = Math.floor(sec % 60);
        if (h > 0) return h + '时' + m + '分';
        if (m > 0) return m + '分' + s + '秒';
        return s + '秒';
    }

    function estimateSize(bps, duration) {
        if (!bps || !duration) return '';
        var bytes = (bps * duration) / 8;
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
        if (bytes >= 1048576) return Math.round(bytes / 1048576) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '';
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
        if (bytes >= 1048576) return Math.round(bytes / 1048576) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
    }

    function resToShort(res) {
        if (!res) return '';
        var parts = res.split('x');
        if (parts.length >= 2 && parts[1]) return parts[1] + 'p';
        return res;
    }

    // ============================================================
    //  获取视频标题
    // ============================================================
    function getVideoTitle() {
        var selectors = [
            'meta[property="og:title"]',
            '.video-title__font div', '.video-title__font', '.video-title',
            '.lesson-title__text', '.lesson-title', '.chapter-title',
            '.video-info-title', '.t-h1', '.title-text', '.course-title',
            '.video-name', '#video-title', '.xe-player-title',
            'video[title]', '.vjs-title, .vjs-title-bar',
            '.dplayer-title', '.art-video-player .art-title', '.xgplayer-title',
            'h1', 'h2', '[data-title]',
        ];
        for (var i = 0; i < selectors.length; i++) {
            var elem = document.querySelector(selectors[i]);
            if (!elem) continue;
            var text = (elem.getAttribute && elem.getAttribute('content'))
                || (elem.getAttribute && elem.getAttribute('title'))
                || elem.textContent;
            if (text && text.trim()) return text.trim();
        }
        var docTitle = (document.title || '').trim();
        if (!docTitle) return '';
        var clean = docTitle.replace(/^ch\d+_\d+[-\s]+/i, '');
        var parts = docTitle.split(/\s[-|·]\s/);
        if (parts.length > 1) clean = parts[0].trim();
        return clean || docTitle;
    }

    // 从媒体播放列表里找第一个 TS 分片，HEAD 请求拿大小
    function sampleSegmentSize(playlistText, baseUrl, callback) {
        var lines = playlistText.split('\n');
        var firstTs = null;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line && line.indexOf('#') !== 0 && /\.ts([?#]|$)/i.test(line)) {
                firstTs = /^https?:\/\//i.test(line) ? line : resolveUrl(baseUrl, line);
                break;
            }
        }
        if (!firstTs) return;

        fetch(firstTs, { method: 'HEAD' })
            .then(function(resp) {
                var cl = resp.headers.get('Content-Length');
                if (cl && parseInt(cl) > 0) callback(parseInt(cl));
            })
            .catch(function() {});  // CORS 限制静默跳过
    }

    // 无码率时：从分片大小反推码率和总大小
    function tryEstimateSizeFromSegments(playlistText, baseUrl, info) {
        sampleSegmentSize(playlistText, baseUrl, function(segBytes) {
            if (!info.duration) return;
            var totalBytes = segBytes * info.segments;
            info.estimatedBandwidth = Math.round((totalBytes * 8) / info.duration);
            info.estimatedSize = totalBytes;
            info.sampleSegmentSize = segBytes;
            refreshPanelIfOpen();
        });
    }

    // 有码率时：只采样分片大小展示用
    function trySampleSegmentSize(playlistText, baseUrl, info) {
        sampleSegmentSize(playlistText, baseUrl, function(segBytes) {
            info.sampleSegmentSize = segBytes;
            refreshPanelIfOpen();
        });
    }

    // ============================================================
    //  拉取并解析 M3U8
    // ============================================================
    var fetchingUrls = {};

    function analyzeM3u8(url, callback) {
        if (fetchingUrls[url]) return;
        fetchingUrls[url] = true;

        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 8000);

        fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': '*/*', 'Referer': location.href }
        })
        .then(function(resp) { clearTimeout(timeout); if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.text(); })
        .then(function(text) {
            if (text.length < 5) throw new Error('空内容');
            var info = parseM3u8Content(text, url);
            info.url = url;
            if (!info.duration && info.targetDuration && info.segments) {
                info.duration = info.targetDuration * info.segments;
            }
            // 与已有数据合并：保留主播放列表里解析出的码率/分辨率等字段
            var oldMeta = m3u8Meta[url];
            if (oldMeta) {
                if (!info.bandwidth && oldMeta.bandwidth) info.bandwidth = oldMeta.bandwidth;
                if (!info.resolution && oldMeta.resolution) info.resolution = oldMeta.resolution;
                if (!info.codecs && oldMeta.codecs) info.codecs = oldMeta.codecs;
                if (!info.frameRate && oldMeta.frameRate) info.frameRate = oldMeta.frameRate;
                if (oldMeta.isAudioOnly !== undefined) info.isAudioOnly = oldMeta.isAudioOnly;
                if (oldMeta.isVariant) info.isVariant = oldMeta.isVariant;
                if (oldMeta.parentMaster) info.parentMaster = oldMeta.parentMaster;
            }
            m3u8Meta[url] = info;

            // 独立媒体列表（无主链接）：没有码率，尝试从 TS 分片大小反推
            if (info.type === 'media' && !info.bandwidth && info.segments > 0) {
                tryEstimateSizeFromSegments(text, url, info);
            } else if (info.type === 'media' && info.segments > 0) {
                // 有码率的也采样分片大小，供面板展示
                trySampleSegmentSize(text, url, info);
            }

            // 主播放列表：注册所有变体
            if (info.type === 'master' && info.variants) {
                for (var i = 0; i < info.variants.length; i++) {
                    var v = info.variants[i];
                    if (!m3u8Meta[v.url]) {
                        m3u8Meta[v.url] = {
                            type: 'media', url: v.url,
                            bandwidth: v.bandwidth || v.avgBandwidth,
                            resolution: v.resolution,
                            codecs: v.codecs, frameRate: v.frameRate,
                            isAudioOnly: v.isAudioOnly,
                            isVariant: true, parentMaster: url
                        };
                    } else {
                        // 条目已存在（浏览器先加载了子链接）→ 补上主链接里才有的码率/分辨率
                        var ex = m3u8Meta[v.url];
                        if (!ex.bandwidth && (v.bandwidth || v.avgBandwidth)) ex.bandwidth = v.bandwidth || v.avgBandwidth;
                        if (!ex.resolution && v.resolution) ex.resolution = v.resolution;
                        if (!ex.codecs && v.codecs) ex.codecs = v.codecs;
                        if (!ex.frameRate && v.frameRate) ex.frameRate = v.frameRate;
                        ex.isVariant = true;
                        ex.parentMaster = url;
                    }
                }
            }

            if (callback) callback(info);
            refreshPanelIfOpen();
        })
        .catch(function(err) {
            clearTimeout(timeout);
            if (m3u8Meta[url] && m3u8Meta[url].type === 'unknown') {
                m3u8Meta[url].error = err.message;
            } else if (!m3u8Meta[url]) {
                m3u8Meta[url] = { type: 'unknown', url: url, error: err.message };
            }
            if (callback) callback(null);
            refreshPanelIfOpen();
        });
    }

    // 当用户选中某个还没解析出时长的子链接时，自动拉取内容
    function ensureMediaDetail(url) {
        var meta = m3u8Meta[url];
        if (!meta) return;
        // 只对还没拿到时长的媒体播放列表拉取
        if (meta.type === 'media' && !meta.duration && !meta.segments && !meta.fetchedDetail && !meta.error) {
            meta.fetchedDetail = true;
            analyzeM3u8(url);
        }
    }

    // ============================================================
    //  面板 UI
    // ============================================================
    var currentUrl = '';
    var panelVisible = true;

    function refreshPanelIfOpen() {
        var panel = document.getElementById('xe-m3u8-panel');
        if (panel && panel.style.display !== 'none') renderUrlList();
    }

    function buildUrlLabel(url) {
        var meta = m3u8Meta[url];
        if (!meta) return '⏳ 解析中... ' + url.replace(/^https?:\/\//, '').substring(0, 40);

        if (meta.type === 'master') {
            var count = meta.variants ? meta.variants.length : 0;
            return '📋 主播放列表 — 包含 ' + count + ' 个清晰度（下载器自动选最高码率）';
        }

        // 媒体播放列表
        var parts = [];

        // 音频 or 视频
        if (meta.isAudioOnly) {
            parts.push('🔊 纯音频流');
        } else if (meta.resolution) {
            parts.push('🎬 ' + resToShort(meta.resolution));
        } else {
            parts.push('🎬 未知清晰度');
        }

        var bw = meta.bandwidth || meta.estimatedBandwidth || 0;
        if (meta.bandwidth) parts.push(formatBitrate(meta.bandwidth));
        else if (meta.estimatedBandwidth) parts.push('≈' + formatBitrate(meta.estimatedBandwidth) + '（估）');

        if (meta.duration) parts.push(formatDuration(meta.duration));

        if (meta.bandwidth && meta.duration) parts.push('≈' + estimateSize(meta.bandwidth, meta.duration));
        else if (meta.estimatedSize) parts.push('≈' + formatBytes(meta.estimatedSize) + '（估）');

        if (meta.error) parts.push('⚠ 跨域限制无法解析');
        else if (!meta.duration && !meta.error) parts.push('⏳ 点击获取时长');

        return parts.join(' · ');
    }

    function buildUrlListHtml() {
        var urls = Object.keys(m3u8Meta);
        if (urls.length === 0) return '';

        var masters = [], media = [], unknowns = [];
        for (var i = 0; i < urls.length; i++) {
            var meta = m3u8Meta[urls[i]];
            if (meta.type === 'master') masters.push(urls[i]);
            else if (meta.type === 'media') media.push(urls[i]);
            else unknowns.push(urls[i]);
        }

        // 子链接排序：视频优先→清晰度高→低→音频最后
        media.sort(function(a, b) {
            var ma = m3u8Meta[a], mb = m3u8Meta[b];
            if (ma.isAudioOnly !== mb.isAudioOnly) return ma.isAudioOnly ? 1 : -1;
            var ra = parseInt((ma.resolution || '0').split('x')[1]) || 0;
            var rb = parseInt((mb.resolution || '0').split('x')[1]) || 0;
            return rb - ra;
        });

        var allUrls = masters.concat(media).concat(unknowns);
        var html = '';
        for (var j = 0; j < allUrls.length; j++) {
            var url = allUrls[j];
            var label = buildUrlLabel(url);
            var meta = m3u8Meta[url];

            var itemStyle = 'padding:8px 10px;margin:2px 0;border-radius:4px;cursor:pointer;font-size:12px;transition:background .15s;word-break:break-all;';
            if (meta && meta.type === 'master') {
                itemStyle += 'background:#fff7e6;font-weight:bold;border-left:3px solid #fa8c16;';
            } else if (meta && meta.isVariant) {
                itemStyle += 'padding-left:20px;';
            }

            html += '<div class="xe-url-item" data-url="' + escAttr(url) + '" style="' + itemStyle + '">' + escHtml(label) + '</div>';
        }
        return html;
    }

    function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function renderUrlList() {
        var listWrap = document.getElementById('xe-url-list');
        var countEl = document.getElementById('xe-url-count');
        var inputEl = document.getElementById('xe-m3u8-input');
        var listWrapContainer = document.getElementById('xe-url-list-wrap');
        var blankSlate = document.getElementById('xe-blank-slate');

        var urls = Object.keys(m3u8Meta);

        if (urls.length === 0) {
            if (listWrapContainer) listWrapContainer.style.display = 'none';
            if (blankSlate) blankSlate.style.display = 'block';
            if (inputEl) inputEl.value = '';
            return;
        }

        if (listWrapContainer) listWrapContainer.style.display = 'block';
        if (blankSlate) blankSlate.style.display = 'none';
        if (countEl) countEl.textContent = urls.length;

        // 选主播放列表或第一个
        if (!currentUrl || !m3u8Meta[currentUrl]) {
            var masters = urls.filter(function(u) { return m3u8Meta[u].type === 'master'; });
            if (masters.length > 0) currentUrl = masters[0];
            else currentUrl = urls[0];
            // 自动拉取选中项的内容
            ensureMediaDetail(currentUrl);
        }

        if (listWrap) listWrap.innerHTML = buildUrlListHtml();
        if (inputEl) inputEl.value = currentUrl;

        // 高亮当前选中
        var items = listWrap ? listWrap.querySelectorAll('.xe-url-item') : [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].getAttribute('data-url') === currentUrl) {
                items[i].style.background = '#e6f7ff';
                items[i].style.borderLeft = '3px solid #1890ff';
            }
        }

        updateInfoBar(currentUrl);
    }

    function updateInfoBar(url) {
        var bar = document.getElementById('xe-info-bar');
        if (!bar) return;
        var meta = m3u8Meta[url];
        if (!meta) {
            bar.innerHTML = '<span style="color:#999;font-size:11px;">⏳ 解析中...</span>';
            return;
        }

        var chips = [];
        if (meta.type === 'master') {
            chips.push(tag('📋 主播放列表 — 下载器自动选最高码率', '#e6f7ff', '#1890ff'));
        } else if (meta.type === 'media') {
            if (meta.isAudioOnly) chips.push(tag('🔊 纯音频', '#fff7e6', '#fa8c16'));
            else if (meta.resolution) chips.push(tag(resToShort(meta.resolution), '#f0f5ff', '#2f54eb'));
            if (meta.bandwidth) chips.push(tag(formatBitrate(meta.bandwidth), '#f0f5ff', '#2f54eb'));
            else if (meta.estimatedBandwidth) chips.push(tag('≈' + formatBitrate(meta.estimatedBandwidth) + '（估）', '#f0f5ff', '#2f54eb'));
            if (meta.duration) chips.push(tag(formatDuration(meta.duration), '#f0f5ff', '#2f54eb'));
            if (meta.bandwidth && meta.duration) chips.push(tag('≈' + estimateSize(meta.bandwidth, meta.duration), '#e6f7ff', '#1890ff'));
            else if (meta.estimatedSize) chips.push(tag('≈' + formatBytes(meta.estimatedSize) + '（估）', '#e6f7ff', '#1890ff'));
            if (meta.segments) chips.push(tag(meta.segments + '个片段', '#f0f5ff', '#2f54eb'));
            if (meta.sampleSegmentSize) chips.push(tag('分片≈' + formatBytes(meta.sampleSegmentSize), '#f0f5ff', '#2f54eb'));
            if (!meta.duration && !meta.error) chips.push(tag('👆 点击此链接获取时长', '#fffbe6', '#faad14'));
            if (meta.error) chips.push(tag('⚠ 跨域限制', '#fff1f0', '#ff4d4f'));
        } else {
            chips.push(tag('⏳ 正在解析...', '#f5f5f5', '#999'));
        }

        bar.innerHTML = chips.join('');
    }

    function tag(text, bg, color) {
        return '<span style="background:' + bg + ';color:' + color + ';padding:2px 8px;border-radius:10px;font-size:11px;margin-right:4px;white-space:nowrap;">' + text + '</span>';
    }

    function showPanel(url) {
        currentUrl = url;
        var panel = document.getElementById('xe-m3u8-panel');
        var title = getVideoTitle();

        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'xe-m3u8-panel';
            panel.style.cssText =
                'position:fixed;top:20px;right:20px;z-index:2147483647;' +
                'background:#fff;padding:15px 20px;border-radius:8px;' +
                'box-shadow:0 4px 15px rgba(0,0,0,0.2);border:2px solid #1890ff;' +
                'font-family:sans-serif;width:500px;max-height:85vh;overflow-y:auto;';

            panel.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
                    '<div style="font-size:15px;font-weight:bold;color:#333;">🎬 嗅探到 m3u8 视频流</div>' +
                    '<span id="xe-conn-status" style="font-size:12px;color:#999;">🔗 检测中...</span>' +
                '</div>' +
                '<div style="font-size:14px;margin-bottom:8px;padding:5px 8px;background:#f6f6f6;border-radius:4px;">' +
                    '<span style="color:#555;">📹 视频名称：</span>' +
                    '<input id="xe-video-title" type="text" placeholder="请输入视频名称" style="' +
                        'width:calc(100% - 90px);font-size:13px;font-weight:500;color:#000;' +
                        'border:1px solid #ddd;border-radius:3px;padding:2px 6px;box-sizing:border-box;" />' +
                '</div>' +
                '<div id="xe-url-list-wrap" style="display:block;margin-bottom:6px;">' +
                    '<span style="color:#555;font-size:12px;">📑 已嗅探 <b id="xe-url-count">0</b> 个地址：</span>' +
                    '<div style="font-size:10px;color:#999;margin-top:2px;">' +
                        '📋主链接=自动最高清 ｜ 🎬子链接=指定清晰度下载</div>' +
                    '<div id="xe-url-list" style="' +
                        'max-height:260px;overflow-y:auto;margin-top:4px;' +
                        'border:1px solid #e8e8e8;border-radius:4px;padding:4px;' +
                        'background:#fafafa;"></div>' +
                '</div>' +
                '<div id="xe-blank-slate" style="display:block;padding:20px;text-align:center;color:#bbb;font-size:13px;">' +
                    '🔍 等待视频加载... 播放视频后会自动嗅探 m3u8 地址' +
                '</div>' +
                '<div id="xe-info-bar" style="margin-bottom:6px;min-height:22px;line-height:2;"></div>' +
                '<textarea id="xe-m3u8-input" readonly rows="2" style="' +
                    'width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;' +
                    'font-size:11px;resize:none;margin-bottom:10px;word-break:break-all;' +
                '"></textarea>' +
                '<div style="display:flex;justify-content:space-between;gap:8px;">' +
                    '<button id="xe-m3u8-send-btn" style="' +
                        'background:#1890ff;color:#fff;border:none;padding:8px 12px;' +
                        'border-radius:4px;cursor:pointer;font-size:13px;flex:1;' +
                    '">📤 发送到下载</button>' +
                    '<button id="xe-m3u8-copy-btn" style="' +
                        'background:#52c41a;color:#fff;border:none;padding:8px 12px;' +
                        'border-radius:4px;cursor:pointer;font-size:13px;flex:1;' +
                    '">📋 复制命令</button>' +
                    '<button id="xe-m3u8-close-btn" style="' +
                        'background:#f5f5f5;color:#666;border:1px solid #ccc;padding:6px 10px;' +
                        'border-radius:4px;cursor:pointer;font-size:13px;' +
                    '">关闭</button>' +
                '</div>' +
                '<div id="xe-status-msg" style="margin-top:8px;font-size:12px;color:#999;min-height:18px;"></div>';

            document.body.appendChild(panel);

            document.getElementById('xe-m3u8-close-btn').onclick = function() {
                panel.style.display = 'none'; panelVisible = false;
            };
            document.getElementById('xe-video-title').oninput = function() {
                this.dataset.userEdited = '1';
            };

            // 列表点击：切换选中项 + 自动拉取子链接内容
            document.getElementById('xe-url-list').onclick = function(e) {
                var item = e.target.closest('.xe-url-item');
                if (!item) return;
                var url = item.getAttribute('data-url');
                if (url && url !== currentUrl) {
                    currentUrl = url;
                    document.getElementById('xe-m3u8-input').value = url;
                    ensureMediaDetail(url);  // ← 点击子链接自动拉取时长
                    renderUrlList();
                }
            };

            checkConnStatus();
        } else {
            panel.style.display = 'block';
            panelVisible = true;
        }

        var titleInput = document.getElementById('xe-video-title');
        if (titleInput && !titleInput.dataset.userEdited) titleInput.value = title;

        document.getElementById('xe-m3u8-send-btn').onclick = function() {
            var t = document.getElementById('xe-video-title').value.trim();
            sendToDownloader(t, currentUrl, this);
        };
        document.getElementById('xe-m3u8-copy-btn').onclick = function() {
            var cmd = buildFfmpegCmd();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(cmd).catch(function() {});
            }
            showStatus(this, downloaderDir ? '✅ 已复制 ffmpeg 命令' : '✅ 已复制', '#52c41a');
        };

        renderUrlList();
    }

    // ============================================================
    //  发送下载 / 连接检测
    // ============================================================
    function buildFfmpegCmd() {
        var dir = downloaderDir;
        var ff = dir ? dir + '\\ffmpeg.exe' : 'ffmpeg.exe';
        var name = (document.getElementById('xe-video-title').value || 'video').trim();
        name = name.replace(/[<>:"/\\|?*]/g, '_');
        var out = (dir ? dir + '\\' : '') + 'downloads\\' + name + '.mp4';
        var ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
        return '"' + ff + '" -y -referer "' + location.href + '" -user_agent "' + ua + '" -i "' + currentUrl + '" -c copy "' + out + '"';
    }

    function sendToDownloader(title, url, btn) {
        var msgEl = document.getElementById('xe-status-msg');
        if (!msgEl) return;
        if (!title) { msgEl.textContent = '请先输入视频名称'; msgEl.style.color = '#ff4d4f'; return; }
        if (!url) { msgEl.textContent = '未获取到 m3u8 地址'; msgEl.style.color = '#ff4d4f'; return; }

        btn.disabled = true; btn.textContent = '发送中...'; btn.style.background = '#faad14';
        msgEl.textContent = '正在发送到下载器...'; msgEl.style.color = '#1890ff';

        fetch('http://127.0.0.1:8910/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: title, url: url, referer: location.href }),
        })
        .then(function(resp) { return resp.json().catch(function() { return {}; }); })
        .then(function(r) {
            if (r.status === 'accepted') {
                btn.textContent = '发送到下载'; btn.style.background = '#52c41a';
                msgEl.textContent = r.msg + ' - 后台下载中...'; msgEl.style.color = '#52c41a';
            } else {
                btn.textContent = '发送到下载'; btn.style.background = '#ff4d4f';
                msgEl.textContent = (r.msg || '服务器返回失败'); msgEl.style.color = '#ff4d4f';
            }
        })
        .catch(function() {
            btn.textContent = '发送到下载'; btn.style.background = '#ff4d4f';
            msgEl.textContent = '下载器未启动，请先运行 启动.bat'; msgEl.style.color = '#ff4d4f';
        })
        .finally(function() {
            btn.disabled = false;
            setTimeout(function() { btn.style.background = '#1890ff'; msgEl.textContent = ''; }, 5000);
        });
    }

    function checkConnStatus() {
        var st = document.getElementById('xe-conn-status');
        if (!st) return;
        fetch('http://127.0.0.1:8910/', { signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : null })
        .then(function(resp) { return resp.json().catch(function() { return {}; }); })
        .then(function(r) {
            st.innerHTML = '🟢 已连接'; st.style.color = '#52c41a';
            if (r && r.dir) { downloaderDir = r.dir; storageSet('downloaderDir', downloaderDir); }
        })
        .catch(function() { st.innerHTML = '🔴 未启动'; st.style.color = '#ff4d4f'; });
    }

    function showStatus(btn, text, color) {
        var msgEl = document.getElementById('xe-status-msg');
        if (msgEl) { msgEl.textContent = text; msgEl.style.color = color; }
        btn.style.background = color;
        setTimeout(function() { btn.style.background = '#1890ff'; if (msgEl) msgEl.textContent = ''; }, 3000);
    }

    // ============================================================
    //  检测
    // ============================================================
    function isM3u8(url) {
        return typeof url === 'string' && /\.m3u8([?#]|$)/i.test(url);
    }

    function handleM3u8Url(rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl) return;
        var url = rawUrl;
        try { url = new URL(rawUrl, location.href).href; } catch(e) { url = rawUrl; }
        if (url.length < 15) return;

        if (isM3u8(url) && !m3u8Meta[url]) {
            m3u8Meta[url] = { type: 'unknown', url: url };
            analyzeM3u8(url);

            function tryShow() {
                if (document.body) showPanel(url);
                else setTimeout(tryShow, 50);
            }
            tryShow();
        }
    }

    // ============================================================
    //  拦截 XHR / fetch / PerformanceObserver / DOM 扫描
    // ============================================================
    function hookXHR() {
        try {
            var OrigXHR = window.XMLHttpRequest;
            var origOpen = OrigXHR.prototype.open;
            OrigXHR.prototype.open = function(method, url) {
                handleM3u8Url(url);
                return origOpen.apply(this, arguments);
            };
        } catch(e) {}
    }

    function hookFetch() {
        try {
            var origFetch = window.fetch;
            window.fetch = function(input, init) {
                var url = '';
                if (typeof input === 'string') url = input;
                else if (input && input.url) url = input.url;
                else if (input instanceof Request) url = input.url;
                handleM3u8Url(url);
                return origFetch.call(this, input, init);
            };
        } catch(e) {}
    }

    function hookPerformanceObserver() {
        if (typeof PerformanceObserver === 'undefined') return false;
        try {
            var observer = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].name && isM3u8(entries[i].name)) handleM3u8Url(entries[i].name);
                }
            });
            observer.observe({ type: 'resource', buffered: false });
            return true;
        } catch(e) { return false; }
    }

    var seenEntries = new Set();
    function scanPerformanceBuffer() {
        try {
            var entries = performance.getEntriesByType('resource');
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i].name;
                if (name && !seenEntries.has(name) && isM3u8(name)) {
                    seenEntries.add(name);
                    handleM3u8Url(name);
                }
            }
        } catch(e) {}
    }

    function hookVideoDomScanner() {
        function scan() {
            var videos = document.querySelectorAll('video[src], video source[src]');
            for (var i = 0; i < videos.length; i++) {
                var src = videos[i].getAttribute('src') || videos[i].src;
                if (src) handleM3u8Url(src);
            }
        }
        var waitBody = setInterval(function() {
            if (document.body) {
                clearInterval(waitBody);
                scan();
                var mo = new MutationObserver(scan);
                mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
            }
        }, 100);
    }

    // ============================================================
    //  调试指示器
    // ============================================================
    var debugDot = null;
    function showDebugDot(color, text) {
        if (!debugDot) {
            if (!document.body) { setTimeout(function() { showDebugDot(color, text); }, 50); return; }
            debugDot = document.createElement('div');
            debugDot.id = 'xe-debug-dot';
            debugDot.style.cssText =
                'position:fixed;bottom:20px;right:20px;z-index:2147483647;' +
                'width:12px;height:12px;border-radius:50%;' +
                'background:' + color + ';cursor:pointer;box-shadow:0 0 6px ' + color + ';';
            debugDot.title = text;
            debugDot.onclick = function() {
                var urls = Object.keys(m3u8Meta);
                var info = '嗅探器 v5.1\n已拦截 ' + urls.length + ' 个 m3u8\n\n';
                for (var i = 0; i < urls.length; i++) {
                    info += buildUrlLabel(urls[i]) + '\n\n';
                }
                alert(info);
            };
            document.body.appendChild(debugDot);
        } else {
            debugDot.style.background = color;
            debugDot.style.boxShadow = '0 0 6px ' + color;
            debugDot.title = text;
        }
    }

    // ============================================================
    //  启动
    // ============================================================
    function init() {
        hookXHR();
        hookFetch();
        hookPerformanceObserver();
        setInterval(scanPerformanceBuffer, 2000);
        hookVideoDomScanner();
        setTimeout(function() { showDebugDot('#faad14', '嗅探器已就绪'); }, 1000);
    }

    init();
})();
