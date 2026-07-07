// ==UserScript==
// @name         通用 m3u8 视频地址嗅探提取器
// @namespace    http://tampermonkey.net/
// @version      5.4
// @description  自动嗅探 m3u8/DASH 视频流，支持 HLS 直播录制与 B站 DASH 下载
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var m3u8Meta = {}, dashData = {}, m3u8PathKeys = {};
    var currentUrl = '', downloaderDir = '';

    try { downloaderDir = localStorage.getItem('xe_down_dir') || ''; } catch(e) {}

    // ========== M3U8 解析 ==========
    function parseM3u8Content(text, baseUrl) {
        var info = { type: 'media' };
        if (/#EXT-X-STREAM-INF/i.test(text)) {
            info.type = 'master';
            info.variants = [];
            var lines = text.split('\n');
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.toUpperCase().indexOf('#EXT-X-STREAM-INF') !== 0) continue;
                var v = { url: '', bandwidth: 0, avgBandwidth: 0, resolution: '', codecs: '', frameRate: '' };
                var bw = line.match(/BANDWIDTH=(\d+)/i); if (bw) v.bandwidth = parseInt(bw[1]);
                var abw = line.match(/AVERAGE-BANDWIDTH=(\d+)/i); if (abw) v.avgBandwidth = parseInt(abw[1]);
                var res = line.match(/RESOLUTION=(\d+x\d+)/i); if (res) v.resolution = res[1];
                var cod = line.match(/CODECS="([^"]+)"/i); if (cod) v.codecs = cod[1];
                var fr = line.match(/FRAME-RATE=([\d.]+)/i); if (fr) v.frameRate = fr[1];
                for (var j = i + 1; j < lines.length; j++) {
                    var next = lines[j].trim();
                    if (next && next.indexOf('#') !== 0) {
                        v.url = /^https?:\/\//i.test(next) ? next : resolveUrl(baseUrl, next);
                        break;
                    }
                }
                v.isAudioOnly = detectAudioOnly(v.resolution, v.codecs, v.bandwidth);
                info.variants.push(v);
            }
        }
        var segs = 0, dur = 0, tdur = 0, hasEnd = false;
        var lines2 = text.split('\n');
        for (var k = 0; k < lines2.length; k++) {
            var ln = lines2[k].trim();
            if (ln.toUpperCase().indexOf('#EXTINF:') === 0) { var dm = ln.match(/#EXTINF:\s*([\d.]+)/i); if (dm) { dur += parseFloat(dm[1]); segs++; } }
            if (ln.toUpperCase().indexOf('#EXT-X-TARGETDURATION:') === 0) { var tm = ln.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/i); if (tm) tdur = parseFloat(tm[1]); }
            if (ln.toUpperCase().indexOf('#EXT-X-ENDLIST') === 0) hasEnd = true;
        }
        info.segments = segs; info.duration = dur; info.targetDuration = tdur; info.isVod = hasEnd;
        return info;
    }

    function detectAudioOnly(res, codecs, bw) {
        if (codecs && /mp4a|aac|opus|vorbis|mp3|ac-3|ec-3/i.test(codecs) && !/avc|hvc|hevc|h\.?26[45]|av1|vp[89]|mpeg/i.test(codecs)) return true;
        if ((!res || res === '0x0') && bw > 0 && bw < 500000) return true;
        return false;
    }

    function resolveUrl(base, relative) {
        if (!relative || /^https?:\/\//i.test(relative)) return relative;
        if (relative.indexOf('/') === 0) { var m = base.match(/^(https?:\/\/[^\/]+)/); return (m ? m[1] : '') + relative; }
        var ls = base.lastIndexOf('/'); return ls >= 0 ? base.substring(0, ls + 1) + relative : base + '/' + relative;
    }

    function fmtBw(bps)   { if (!bps || bps <= 0) return ''; if (bps >= 1e6) return (bps/1e6).toFixed(1)+' Mbps'; return Math.round(bps/1000)+' kbps'; }
    function fmtDur(sec)  { if (!sec || sec <= 0) return ''; var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60); if (h>0) return h+'时'+m+'分'; if (m>0) return m+'分'+s+'秒'; return s+'秒'; }
    function fmtSize(bps,dur){ if (!bps||!dur) return ''; var b=(bps*dur)/8; if (b>=1073741824) return (b/1073741824).toFixed(1)+' GB'; if (b>=1048576) return Math.round(b/1048576)+' MB'; if (b>=1024) return Math.round(b/1024)+' KB'; return b+' B'; }
    function fmtBytes(b)  { if (!b||b<=0) return ''; if (b>=1073741824) return (b/1073741824).toFixed(1)+' GB'; if (b>=1048576) return Math.round(b/1048576)+' MB'; if (b>=1024) return Math.round(b/1024)+' KB'; return b+' B'; }
    function resShort(res){ if (!res) return ''; var p=res.split('x'); return p.length>=2&&p[1]?p[1]+'p':res; }

    function getVideoTitle() {
        var sels = ['meta[property="og:title"]','.video-title__font div','.video-title__font','.video-title','.lesson-title__text','.lesson-title','.chapter-title','.video-info-title','.t-h1','.title-text','.course-title','.video-name','#video-title','.xe-player-title','video[title]','.vjs-title, .vjs-title-bar','.dplayer-title','.art-video-player .art-title','.xgplayer-title','h1','h2','[data-title]'];
        for (var i=0;i<sels.length;i++){ var e=document.querySelector(sels[i]);if(!e)continue;var t=(e.getAttribute&&e.getAttribute('content'))||(e.getAttribute&&e.getAttribute('title'))||e.textContent;if(t&&t.trim())return t.trim(); }
        var dt=(document.title||'').trim();if(!dt)return'';var p=dt.split(/\s[-|]\s/);if(p.length>1)return p[0].trim();return dt.replace(/^ch\d+_\d+[-\s]+/i,'');
    }

    function segSample(text, base, cb) {
        var lines=text.split('\n');for(var i=0;i<lines.length;i++){var l=lines[i].trim();if(l&&l.indexOf('#')!==0&&/\.(ts|m4s)([?#]|$)/i.test(l)){var u=/^https?:\/\//i.test(l)?l:resolveUrl(base,l);fetch(u,{method:'HEAD'}).then(function(r){var cl=r.headers.get('Content-Length');if(cl&&parseInt(cl)>0)cb(parseInt(cl));}).catch(function(){});break;}}
    }
    function tryEstimate(text,url,info){segSample(text,url,function(sz){if(!info.duration)return;var t=sz*info.segments;info.estimatedBandwidth=Math.round((t*8)/info.duration);info.estimatedSize=t;info.sampleSegmentSize=sz;refreshPanel();});}
    function trySample(text,url,info){segSample(text,url,function(sz){info.sampleSegmentSize=sz;refreshPanel();});}

    // ========== M3U8 拉取 ==========
    var fetching={};
    function analyzeM3u8(url,cb){
        if(fetching[url])return;fetching[url]=true;
        var ctrl=new AbortController();setTimeout(function(){ctrl.abort();},8000);
        fetch(url,{signal:ctrl.signal,headers:{'Referer':location.href}})
        .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
        .then(function(t){
            if(t.length<5)throw new Error('empty');
            var info=parseM3u8Content(t,url);info.url=url;
            if(!info.duration&&info.targetDuration&&info.segments)info.duration=info.targetDuration*info.segments;
            var old=m3u8Meta[url];
            if(old){if(!info.bandwidth&&old.bandwidth)info.bandwidth=old.bandwidth;if(!info.resolution&&old.resolution)info.resolution=old.resolution;if(!info.codecs&&old.codecs)info.codecs=old.codecs;if(old.isAudioOnly!==undefined)info.isAudioOnly=old.isAudioOnly;if(old.isVariant)info.isVariant=old.isVariant;if(old.parentMaster)info.parentMaster=old.parentMaster;}
            m3u8Meta[url]=info;
            if(info.type==='media'&&!info.bandwidth&&info.segments>0)tryEstimate(t,url,info);
            else if(info.type==='media'&&info.segments>0)trySample(t,url,info);
            if(info.type==='master'&&info.variants){for(var i=0;i<info.variants.length;i++){var v=info.variants[i];if(!m3u8Meta[v.url]){m3u8Meta[v.url]={type:'media',url:v.url,bandwidth:v.bandwidth||v.avgBandwidth,resolution:v.resolution,codecs:v.codecs,frameRate:v.frameRate,isAudioOnly:v.isAudioOnly,isVariant:true,parentMaster:url};}else{var ex=m3u8Meta[v.url];if(!ex.bandwidth&&(v.bandwidth||v.avgBandwidth))ex.bandwidth=v.bandwidth||v.avgBandwidth;if(!ex.resolution&&v.resolution)ex.resolution=v.resolution;ex.isVariant=true;ex.parentMaster=url;}}}
            if(cb)cb(info);refreshPanel();
        })
        .catch(function(){fetching[url]=false;if(!m3u8Meta[url])m3u8Meta[url]={type:'unknown',url:url,error:'fetch failed'};if(cb)cb(null);refreshPanel();});
    }

    function ensureDetail(url){var m=m3u8Meta[url];if(m&&m.type==='media'&&!m.duration&&!m.segments&&!m.fetched&&!m.error){m.fetched=true;analyzeM3u8(url);}}

    // ========== 面板 ==========
    function refreshPanel(){var p=document.getElementById('xe-m3u8-panel');if(p&&p.style.display!=='none')renderList();}

    function buildUrlLabel(url){
        var m=m3u8Meta[url];if(!m)return'解析中...';
        if(m.type==='dash'){var pa=[];if(m.resolution)pa.push(resShort(m.resolution));if(m.bandwidth)pa.push(fmtBw(m.bandwidth));pa.push(m.audioUrl?'含音频':'无音轨');return'DASH '+pa.join(' · ');}
        if(m.type==='master')return'主播放列表 ('+(m.variants?m.variants.length:0)+' 个清晰度)';
        var p=[];if(m.isAudioOnly)p.push('纯音频');else if(m.resolution)p.push(resShort(m.resolution));else p.push('未知清晰度');
        if(m.bandwidth)p.push(fmtBw(m.bandwidth));else if(m.estimatedBandwidth)p.push('≈'+fmtBw(m.estimatedBandwidth)+'(估)');
        if(m.duration)p.push(fmtDur(m.duration));
        if(m.bandwidth&&m.duration)p.push('≈'+fmtSize(m.bandwidth,m.duration));else if(m.estimatedSize)p.push('≈'+fmtBytes(m.estimatedSize)+'(估)');
        if(m.error)p.push('解析失败');else if(!m.duration&&!m.error)p.push('点击获取详情');
        return p.join(' · ');
    }

    function buildUrlListHtml(){
        var us=Object.keys(m3u8Meta);if(us.length===0)return'';
        var da=[],ma=[],me=[],un=[];
        for(var i=0;i<us.length;i++){var m=m3u8Meta[us[i]];if(m.type==='dash')da.push(us[i]);else if(m.type==='master')ma.push(us[i]);else if(m.type==='media')me.push(us[i]);else un.push(us[i]);}
        da.sort(function(a,b){return(m3u8Meta[b].bandwidth||0)-(m3u8Meta[a].bandwidth||0);});
        me.sort(function(a,b){var x=m3u8Meta[a],y=m3u8Meta[b];if(x.isAudioOnly!==y.isAudioOnly)return x.isAudioOnly?1:-1;return(parseInt((y.resolution||'0').split('x')[1])||0)-(parseInt((x.resolution||'0').split('x')[1])||0);});
        var all=da.concat(ma).concat(me).concat(un),h='';
        for(var j=0;j<all.length;j++){var u=all[j],m=m3u8Meta[u],s='padding:6px 8px;margin:2px 0;border-radius:4px;cursor:pointer;font-size:12px;word-break:break-all;';if(m&&m.type==='dash')s+='background:#e6f7ff;border-left:3px solid #1890ff;';else if(m&&m.type==='master')s+='background:#fff7e6;font-weight:bold;border-left:3px solid #fa8c16;';else if(m&&m.isVariant)s+='padding-left:20px;';h+='<div class="xe-url-item" data-url="'+escA(u)+'" style="'+s+'">'+escH(buildUrlLabel(u))+'</div>';}
        return h;
    }
    function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function escA(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}

    function renderList(){
        var lw=document.getElementById('xe-url-list'),ce=document.getElementById('xe-url-count'),inp=document.getElementById('xe-m3u8-input'),w=document.getElementById('xe-url-list-wrap'),bl=document.getElementById('xe-blank-slate');
        var us=Object.keys(m3u8Meta);
        if(us.length===0){if(w)w.style.display='none';if(bl)bl.style.display='block';if(inp)inp.value='';return;}
        if(w)w.style.display='block';if(bl)bl.style.display='none';if(ce)ce.textContent=us.length;
        if(!currentUrl||!m3u8Meta[currentUrl]){var ds=us.filter(function(u){return m3u8Meta[u].type==='dash';}),ms=us.filter(function(u){return m3u8Meta[u].type==='master';});currentUrl=ds.length>0?ds[0]:(ms.length>0?ms[0]:us[0]);ensureDetail(currentUrl);}
        if(lw)lw.innerHTML=buildUrlListHtml();if(inp)inp.value=currentUrl;updateInfoBar(currentUrl);
    }

    function tag(t,bg,c){return'<span style="background:'+bg+';color:'+c+';padding:2px 8px;border-radius:10px;font-size:11px;margin-right:4px;white-space:nowrap;">'+t+'</span>';}

    function updateInfoBar(url){
        var bar=document.getElementById('xe-info-bar');if(!bar)return;
        var m=m3u8Meta[url];if(!m){bar.innerHTML='<span style="color:#999;font-size:11px;">解析中...</span>';return;}
        var isLive=(m.type==='media'&&!m.isVod)||(/\/live[-_\/]/i.test(url)||/[?&]len=0(&|$)/.test(url));if(m.type==='unknown'&&m.error)isLive=true;
        var sb=document.getElementById('xe-m3u8-send-btn'),cb=document.getElementById('xe-m3u8-copy-btn'),lr=document.getElementById('xe-live-row');
        if(sb){if(isLive&&!liveRec){sb.textContent='开始录制';sb.style.background='#ff4d4f';sb.onclick=startRec;}else if(isLive&&liveRec){sb.textContent='停止录制';sb.style.background='#faad14';sb.onclick=stopRec;}else{sb.textContent='发送到下载';sb.style.background='#1890ff';sb.onclick=defSend;}if(cb)cb.style.display=(isLive&&!liveRec)?'none':'';}
        if(lr)lr.style.display=(isLive&&liveRec)?'block':'none';
        var chips=[];
        if(m.type==='dash'){if(m.resolution)chips.push(tag(resShort(m.resolution),'#f0f5ff','#2f54eb'));if(m.bandwidth)chips.push(tag(fmtBw(m.bandwidth),'#f0f5ff','#2f54eb'));chips.push(tag(m.audioUrl?'含音频':'无音轨',m.audioUrl?'#f6ffed':'#fff1f0',m.audioUrl?'#52c41a':'#ff4d4f'));chips.push(tag('DASH','#e6f7ff','#1890ff'));}
        else if(m.type==='master'){chips.push(tag('主播放列表 - 自动选最高码率','#e6f7ff','#1890ff'));}
        else if(m.type==='media'){if(m.isAudioOnly)chips.push(tag('纯音频','#fff7e6','#fa8c16'));else if(m.resolution)chips.push(tag(resShort(m.resolution),'#f0f5ff','#2f54eb'));if(m.bandwidth)chips.push(tag(fmtBw(m.bandwidth),'#f0f5ff','#2f54eb'));else if(m.estimatedBandwidth)chips.push(tag('≈'+fmtBw(m.estimatedBandwidth)+'(估)','#f0f5ff','#2f54eb'));if(m.duration)chips.push(tag(fmtDur(m.duration),'#f0f5ff','#2f54eb'));if(m.bandwidth&&m.duration)chips.push(tag('≈'+fmtSize(m.bandwidth,m.duration),'#e6f7ff','#1890ff'));else if(m.estimatedSize)chips.push(tag('≈'+fmtBytes(m.estimatedSize)+'(估)','#e6f7ff','#1890ff'));if(m.segments)chips.push(tag(m.segments+'个片段','#f0f5ff','#2f54eb'));if(m.sampleSegmentSize)chips.push(tag('分片≈'+fmtBytes(m.sampleSegmentSize),'#f0f5ff','#2f54eb'));if(!m.duration&&!m.error)chips.push(tag('点击获取时长','#fffbe6','#faad14'));if(m.error)chips.push(tag('解析失败','#fff1f0','#ff4d4f'));}
        else{chips.push(tag('解析中...','#f5f5f5','#999'));}
        bar.innerHTML=chips.join('');
    }

    function showPanel(url){
        currentUrl=url;var p=document.getElementById('xe-m3u8-panel'),title=getVideoTitle();
        if(!p){p=document.createElement('div');p.id='xe-m3u8-panel';p.style.cssText='position:fixed;top:20px;right:20px;z-index:2147483647;background:#fff;padding:15px;border-radius:8px;box-shadow:0 4px 15px rgba(0,0,0,0.2);border:2px solid #1890ff;font-family:sans-serif;width:500px;max-height:85vh;overflow-y:auto;';
        p.innerHTML='<div style="display:flex;justify-content:space-between;margin-bottom:10px;"><div style="font-size:15px;font-weight:bold;color:#333;">m3u8 视频嗅探器</div><span id="xe-conn-status" style="font-size:12px;color:#999;">检测中...</span></div><div style="margin-bottom:8px;padding:5px 8px;background:#f6f6f6;border-radius:4px;"><span style="color:#555;">名称：</span><input id="xe-video-title" placeholder="视频名称" style="width:calc(100% - 50px);font-size:13px;border:1px solid #ddd;border-radius:3px;padding:2px 6px;" /></div><div id="xe-url-list-wrap" style="display:block;margin-bottom:6px;"><span style="color:#555;font-size:12px;">嗅探到 <b id="xe-url-count">0</b> 个地址</span><div style="font-size:10px;color:#999;">主链接=自动最高清 | 子链接=指定清晰度</div><div id="xe-url-list" style="max-height:220px;overflow-y:auto;margin-top:4px;border:1px solid #e8e8e8;border-radius:4px;padding:4px;background:#fafafa;"></div></div><div id="xe-blank-slate" style="display:block;padding:20px;text-align:center;color:#bbb;font-size:13px;">等待视频加载...</div><div id="xe-live-row" style="display:none;margin-bottom:6px;"><div id="xe-live-timer" style="text-align:center;font-size:16px;color:#ff4d4f;font-weight:bold;">00:00 | 0 片段</div></div><div id="xe-info-bar" style="margin-bottom:6px;min-height:22px;line-height:2;"></div><textarea id="xe-m3u8-input" readonly rows="2" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;font-size:11px;resize:none;margin-bottom:10px;word-break:break-all;"></textarea><div style="display:flex;gap:8px;"><button id="xe-m3u8-send-btn" style="background:#1890ff;color:#fff;border:none;padding:8px;border-radius:4px;cursor:pointer;font-size:13px;flex:1;">发送到下载</button><button id="xe-m3u8-copy-btn" style="background:#52c41a;color:#fff;border:none;padding:8px;border-radius:4px;cursor:pointer;font-size:13px;flex:1;">复制命令</button><button id="xe-m3u8-close-btn" style="background:#f5f5f5;color:#666;border:1px solid #ccc;padding:8px;border-radius:4px;cursor:pointer;font-size:13px;">关闭</button></div><div id="xe-status-msg" style="margin-top:8px;font-size:12px;color:#999;min-height:18px;"></div>';
        document.body.appendChild(p);
        document.getElementById('xe-m3u8-close-btn').onclick=function(){p.style.display='none';};
        document.getElementById('xe-video-title').oninput=function(){this.dataset.edited='1';};
        document.getElementById('xe-url-list').onclick=function(e){var it=e.target.closest('.xe-url-item');if(!it)return;var u=it.getAttribute('data-url');if(u&&u!==currentUrl){currentUrl=u;document.getElementById('xe-m3u8-input').value=u;ensureDetail(u);renderList();}};
        chkConn();}else{p.style.display='block';}
        var ti=document.getElementById('xe-video-title');if(ti&&!ti.dataset.edited)ti.value=title;
        document.getElementById('xe-m3u8-copy-btn').onclick=function(){var cmd=buildCmd();if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cmd).catch(function(){});}showStatus(this,downloaderDir?'已复制':'已复制','#52c41a');};
        renderList();
    }

    // ========== 直播录制 ==========
    var liveTimer=null,liveRec=false,liveStart=0;
    function defSend(){var t=document.getElementById('xe-video-title').value.trim();sendDL(t,currentUrl);}
    function startRec(){liveRec=true;liveStart=Date.now();liveTimer=setInterval(pollLive,2000);document.getElementById('xe-live-row').style.display='block';document.getElementById('xe-status-msg').textContent='启动中...';document.getElementById('xe-status-msg').style.color='#1890ff';renderList();var b={name:document.getElementById('xe-video-title').value.trim()||'直播录制',url:currentUrl,referer:location.href,live:true};fetch('http://127.0.0.1:8910/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{};});}).then(function(d){if(d.status!=='recording'){liveRec=false;clearInterval(liveTimer);liveTimer=null;renderList();document.getElementById('xe-status-msg').textContent=d.msg||'启动失败';document.getElementById('xe-status-msg').style.color='#ff4d4f';}else{document.getElementById('xe-status-msg').textContent=d.msg;document.getElementById('xe-status-msg').style.color='#52c41a';}}).catch(function(){liveRec=false;clearInterval(liveTimer);liveTimer=null;renderList();document.getElementById('xe-status-msg').textContent='下载器未启动';document.getElementById('xe-status-msg').style.color='#ff4d4f';});}
    function stopRec(){liveRec=false;if(liveTimer){clearInterval(liveTimer);liveTimer=null;}document.getElementById('xe-live-row').style.display='none';document.getElementById('xe-status-msg').textContent='停止中...';document.getElementById('xe-status-msg').style.color='#faad14';renderList();fetch('http://127.0.0.1:8910/live/stop',{method:'POST'}).then(function(r){return r.json().catch(function(){return{};});}).then(function(d){document.getElementById('xe-status-msg').textContent=d.msg||'正在合并...';document.getElementById('xe-status-msg').style.color='#52c41a';}).catch(function(){document.getElementById('xe-status-msg').textContent='停止失败';document.getElementById('xe-status-msg').style.color='#ff4d4f';});}
    function pollLive(){if(!liveRec)return;fetch('http://127.0.0.1:8910/live/status').then(function(r){return r.json().catch(function(){return{};});}).then(function(d){if(!liveRec)return;var s=Math.floor((Date.now()-liveStart)/1000),m=Math.floor(s/60),sec=s%60;document.getElementById('xe-live-timer').innerHTML=(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec+' | '+(d.count||0)+' 片段';});}

    // ========== 下载器通信 ==========
    function chkConn(){fetch('http://127.0.0.1:8910/').then(function(r){return r.json().catch(function(){return{};});}).then(function(r){var s=document.getElementById('xe-conn-status');if(s){s.innerHTML='已连接';s.style.color='#52c41a';}if(r&&r.dir){downloaderDir=r.dir;try{localStorage.setItem('xe_down_dir',downloaderDir);}catch(ex){}}}).catch(function(){var s=document.getElementById('xe-conn-status');if(s){s.innerHTML='未连接';s.style.color='#ff4d4f';}});}
    function buildCmd(){var d=downloaderDir,ff=d?d+'\\ffmpeg.exe':'ffmpeg.exe',n=(document.getElementById('xe-video-title').value||'video').trim();n=n.replace(/[<>:"/\\|?*]/g,'_');var o=(d?d+'\\':'')+'downloads\\'+n+'.mp4',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';return'"'+ff+'" -y -referer "'+location.href+'" -user_agent "'+ua+'" -i "'+currentUrl+'" -c copy "'+o+'"';}
    function sendDL(title,url){var m=document.getElementById('xe-status-msg'),b=document.getElementById('xe-m3u8-send-btn');if(!m)return;if(!title){m.textContent='请输入名称';m.style.color='#ff4d4f';return;}b.disabled=true;b.textContent='发送中...';b.style.background='#faad14';m.textContent='发送中...';m.style.color='#1890ff';var sbody={name:title,url:url,referer:location.href},meta=m3u8Meta[url];if(meta&&meta.type==='dash'){sbody.audio_url=meta.audioUrl||'';sbody.is_dash=true;}fetch('http://127.0.0.1:8910/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sbody)}).then(function(r){return r.json().catch(function(){return{};});}).then(function(r){b.textContent='发送到下载';b.style.background=r.status==='accepted'?'#52c41a':'#ff4d4f';m.textContent=r.msg||'';m.style.color=r.status==='accepted'?'#52c41a':'#ff4d4f';}).catch(function(){b.textContent='发送到下载';b.style.background='#ff4d4f';m.textContent='下载器未启动';m.style.color='#ff4d4f';}).finally(function(){b.disabled=false;setTimeout(function(){b.style.background='#1890ff';m.textContent='';},5000);});}
    function showStatus(btn,t,c){var m=document.getElementById('xe-status-msg');if(m){m.textContent=t;m.style.color=c;}btn.style.background=c;setTimeout(function(){btn.style.background='#1890ff';if(m)m.textContent='';},3000);}

    // ========== 检测与去重 ==========
    function isM3u8(url){return typeof url==='string'&&/\.m3u8([?#]|$)/i.test(url);}

    function handleDash(vurl,aurl,bw,res,codecs,qid){var k=res||qid||bw;if(dashData[k]){var oldUrl=dashData[k].url;if((bw||0)>=(dashData[k].bandwidth||0)){dashData[k].videoUrl=vurl;dashData[k].url=vurl;dashData[k].bandwidth=bw;dashData[k].codecs=codecs;delete m3u8Meta[oldUrl];m3u8Meta[vurl]=dashData[k];}if(!dashData[k].audioUrl&&aurl)dashData[k].audioUrl=aurl;return;}dashData[k]={videoUrl:vurl,audioUrl:aurl,bandwidth:bw,resolution:res,codecs:codecs,isDash:true,url:vurl,type:'dash'};m3u8Meta[vurl]=dashData[k];(function go(){if(document.body)showPanel(vurl);else setTimeout(go,50);})();}

    function scanResponseText(t){if(typeof t!=='string'||t.length<10)return;var re=/(https?:\/\/[^\s"',<>]+\.m3u8[^\s"',<>]*)/gi,m;while((m=re.exec(t))!==null)handleM3u8Url(m[1].replace(/["',<>]$/,''));if(t.indexOf('"baseUrl"')===-1&&t.indexOf('"base_url"')===-1)return;try{var j=JSON.parse(t),dash=(j.data||j).dash||(j.data||j);if(!dash||!dash.video||!dash.video.length)return;var aur='';if(dash.audio&&dash.audio.length)aur=dash.audio[0].baseUrl||dash.audio[0].base_url||'';for(var vi=0;vi<dash.video.length;vi++){var vv=dash.video[vi],vurl=vv.baseUrl||vv.base_url||'';if(!vurl)continue;var qn=vv.id||0,res=(vv.width&&vv.height)?(vv.width+'x'+vv.height):(qn>=120?'3840x2160':qn>=80?'1920x1080':qn>=64?'1280x720':qn>=32?'852x480':qn>=16?'640x360':'');handleDash(vurl,aur,vv.bandwidth||0,res,vv.codecs||'',qn);}}catch(ex){}}

    function handleM3u8Url(raw){
        if(typeof raw!=='string'||!raw)return;var url=raw;try{url=new URL(raw,location.href).href;}catch(e){url=raw;}if(url.length<15||!isM3u8(url))return;
        var p=url.split('?')[0].replace(/^https?:\/\/[^\/]+/,'').split('/').filter(function(x){return x;}).slice(-2).join('/');
        if(m3u8PathKeys[p]){var old=m3u8PathKeys[p];if(old!==url&&m3u8Meta[old]){m3u8Meta[url]=m3u8Meta[old];delete m3u8Meta[old];m3u8PathKeys[p]=url;if(currentUrl===old)currentUrl=url;refreshPanel();}return;}
        m3u8PathKeys[p]=url;m3u8Meta[url]={type:'unknown',url:url};analyzeM3u8(url);(function go(){if(document.body)showPanel(url);else setTimeout(go,50);})();
    }

    // ========== 页面拦截 ==========
    function hookXHR(){try{var XHR=window.XMLHttpRequest,oo=XHR.prototype.open,os=XHR.prototype.send;XHR.prototype.open=function(m,u){this._xu=u;return oo.apply(this,arguments);};XHR.prototype.send=function(){var s=this;s.addEventListener('load',function(){handleM3u8Url(s._xu);var rt=s.responseType;if(rt===''||rt==='text')scanResponseText(s.responseText);else if(rt==='json'&&s.response){try{scanResponseText(JSON.stringify(s.response));}catch(ex){}}});return os.apply(this,arguments);};}catch(e){}}
    function hookFetch(){try{var uf=window.fetch;window.fetch=function(input,init){var url='';if(typeof input==='string')url=input;else if(input&&input.url)url=input.url;else if(input instanceof Request)url=input.url;handleM3u8Url(url);return uf.call(this,input,init).then(function(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')!==-1||ct.indexOf('text')!==-1||ct.indexOf('javascript')!==-1){if(r&&r.clone){try{var c=r.clone();c.text().then(function(t){scanResponseText(t);}).catch(function(){});}catch(ex){}}}return r;});};}catch(e){}}
    function hookPerf(){if(typeof PerformanceObserver==='undefined')return false;try{new PerformanceObserver(function(l){var e=l.getEntries();for(var i=0;i<e.length;i++)if(e[i].name&&isM3u8(e[i].name))handleM3u8Url(e[i].name);}).observe({type:'resource',buffered:false});return true;}catch(e){return false;}}
    var _seen=new Set();function scanBuf(){try{var e=performance.getEntriesByType('resource');for(var i=0;i<e.length;i++){var n=e[i].name;if(n&&!_seen.has(n)&&isM3u8(n)){_seen.add(n);handleM3u8Url(n);}}}catch(e){}}
    function hookDom(){(function g(){if(document.body){(function s(){var vs=document.querySelectorAll('video[src], video source[src]');for(var i=0;i<vs.length;i++){var u=vs[i].getAttribute('src')||vs[i].src;if(u)handleM3u8Url(u);}})();new MutationObserver(s).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});}else setTimeout(g,100);})();}

    // ========== 调试点 ==========
    var dot=null;function showDot(c,t){if(!dot){if(!document.body){setTimeout(function(){showDot(c,t);},50);return;}dot=document.createElement('div');dot.id='xe-dot';dot.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483647;width:12px;height:12px;border-radius:50%;background:'+c+';cursor:pointer;box-shadow:0 0 6px '+c+';';dot.title=t;dot.onclick=function(){var p=document.getElementById('xe-m3u8-panel');if(p){p.style.display='block';renderList();}else if(Object.keys(m3u8Meta).length>0&&currentUrl){showPanel(currentUrl);}};document.body.appendChild(dot);}else{dot.style.background=c;dot.style.boxShadow='0 0 6px '+c;dot.title=t;}}

    hookXHR();hookFetch();hookPerf();setInterval(scanBuf,2000);hookDom();
    setTimeout(function(){showDot('#faad14','M3U8 Sniffer v5.4');},1000);
})();
