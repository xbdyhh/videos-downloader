const MAX_DOWNLOAD_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_TS_REMUX_BYTES = 750 * 1024 * 1024;
const MAX_AUDIO_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_TRANSCODE_BYTES = 500 * 1024 * 1024;
const MAX_DASH_INPUT_BYTES = 500 * 1024 * 1024;
const state = { job:null, outputMode:"video", audioFormat:"auto", videoFormat:"auto", parts:[], totalBytes:0, segmentCount:0, totalSegments:0, paused:false, cancelled:false, finished:false, isLive:false, sourceExtension:"ts", extension:"mp4", startedAt:0, controller:null, saved:false, pendingSave:null, saving:false };
const ui = Object.fromEntries(["videoTitle","videoUrl","stateBadge","progressBar","progressText","segmentText","bytesText","speedText","formatText","streamText","messageBox","pauseButton","finishButton","partialButton","cancelButton"].map((id)=>[id,document.getElementById(id)]));

function formatBytes(bytes) { const units=["B","KB","MB","GB"]; let value=bytes||0,index=0; while(value>=1024&&index<units.length-1){value/=1024;index+=1;} return `${value.toFixed(index>1?1:0)} ${units[index]}`; }
function setStatus(label,message,className="") { ui.stateBadge.textContent=label; ui.stateBadge.className=`state-badge ${className}`.trim(); ui.messageBox.textContent=message; }
function updateProgress() { const elapsed=Math.max((Date.now()-state.startedAt)/1000,1); const percent=state.isLive?0:state.totalSegments?Math.round((state.segmentCount/state.totalSegments)*100):0; const isBilibiliDash=state.job?.item?.kind==="bilibili-dash"; ui.progressBar.classList.toggle("indeterminate",state.isLive&&!state.paused&&!state.finished); if(!state.isLive)ui.progressBar.style.width=`${percent}%`; ui.progressText.textContent=state.isLive?"直播捕获中":`${percent}%`; ui.segmentText.textContent=isBilibiliDash?`${state.segmentCount} / ${state.totalSegments} 条轨道`:state.isLive?`已捕获 ${state.segmentCount} 个分片`:`${state.segmentCount} / ${state.totalSegments} 个分片`; ui.bytesText.textContent=formatBytes(state.totalBytes); ui.speedText.textContent=`${formatBytes(state.totalBytes/elapsed)}/s`; ui.formatText.textContent=state.outputMode==="audio"?(state.extension==="auto"?"MP3 / FLAC 自动":state.extension.toUpperCase()):state.extension.toUpperCase(); ui.streamText.textContent=isBilibiliDash?(state.outputMode==="audio"?"Bilibili DASH 音频":"Bilibili DASH 双轨"):state.outputMode==="audio"?(state.isLive?"直播音频":"仅提取音频"):(state.isLive?"直播视频":"点播视频"); ui.partialButton.disabled=isBilibiliDash||state.parts.length===0||state.saved||Boolean(state.pendingSave); }

function errorMessage(error) {
  if (typeof error === "string" && error.trim()) return error;
  if (error?.message) return error.message;
  try { const serialized = JSON.stringify(error); if (serialized && serialized !== "{}") return serialized; } catch (_) {}
  return "未知错误，请打开扩展页面的开发者工具查看详情";
}

async function fetchResource(url,range) { state.controller=new AbortController(); const headers={}; if(range)headers.Range=`bytes=${range.offset}-${range.offset+range.length-1}`; const options={credentials:"include",headers,signal:state.controller.signal}; const pageUrl=state.job?.item?.pageUrl; if(/^https?:/i.test(pageUrl||"")){options.referrer=pageUrl;options.referrerPolicy="strict-origin-when-cross-origin";} const response=await fetch(url,options); if(!response.ok)throw new Error(`请求失败 ${response.status}: ${new URL(url).hostname}`); let bytes=new Uint8Array(await response.arrayBuffer()); if(range&&response.status===200)bytes=bytes.slice(range.offset,range.offset+range.length); return bytes; }

async function fetchDashStream(stream) {
  const urls = [stream?.url, ...(stream?.backupUrls || [])].filter(Boolean);
  let lastError;
  for (const url of urls) {
    try {
      return await fetchResource(url);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("DASH 轨道没有可用的下载地址");
}
async function fetchManifest(url) { const text=new TextDecoder().decode(await fetchResource(url)); if(!text.trimStart().startsWith("#EXTM3U"))throw new Error("返回内容不是有效的 m3u8 播放清单"); return text; }
function parseAttributes(value) { const attributes={}; const pattern=/([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi; let match; while((match=pattern.exec(value)))attributes[match[1].toUpperCase()]=match[2].replace(/^"|"$/g,""); return attributes; }
function parseByteRange(value,previousEnd=0) { if(!value)return null; const [lengthText,offsetText]=value.split("@"); const length=Number(lengthText),offset=offsetText===undefined?previousEnd:Number(offsetText); return Number.isFinite(length)&&Number.isFinite(offset)?{length,offset}:null; }
function selectHighestVariant(text,baseUrl) { const lines=text.split(/\r?\n/).map((line)=>line.trim()),variants=[]; for(let index=0;index<lines.length;index+=1){if(!lines[index].startsWith("#EXT-X-STREAM-INF:"))continue; const attributes=parseAttributes(lines[index].slice(lines[index].indexOf(":")+1)); const uri=lines.slice(index+1).find((line)=>line&&!line.startsWith("#")); if(uri)variants.push({url:new URL(uri,baseUrl).href,bandwidth:Number(attributes.BANDWIDTH)||0});} return variants.sort((a,b)=>b.bandwidth-a.bandwidth)[0]?.url||null; }
async function resolveMediaPlaylist(initialUrl) { let url=initialUrl; for(let depth=0;depth<5;depth+=1){const text=await fetchManifest(url); const variantUrl=selectHighestVariant(text,url); if(!variantUrl)return{text,url}; url=variantUrl;} throw new Error("m3u8 主播放清单嵌套层级过深"); }

function parseMediaPlaylist(text,baseUrl) { const lines=text.split(/\r?\n/).map((line)=>line.trim()); let nextSequence=0,currentKey=null,currentMap=null,nextByteRange=null,previousRangeEnd=0,targetDuration=6; const segments=[]; for(const line of lines){if(!line)continue; if(line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))nextSequence=Number(line.split(":")[1])||0; else if(line.startsWith("#EXT-X-TARGETDURATION:"))targetDuration=Number(line.split(":")[1])||6; else if(line.startsWith("#EXT-X-KEY:")){const attributes=parseAttributes(line.slice(line.indexOf(":")+1)); if(attributes.METHOD==="NONE")currentKey=null; else if(attributes.METHOD==="AES-128"&&attributes.URI)currentKey={url:new URL(attributes.URI,baseUrl).href,iv:attributes.IV||null}; else throw new Error(`不支持的 HLS 加密方式：${attributes.METHOD||"未知"}`);} else if(line.startsWith("#EXT-X-MAP:")){const attributes=parseAttributes(line.slice(line.indexOf(":")+1)); currentMap={url:new URL(attributes.URI,baseUrl).href,range:parseByteRange(attributes.BYTERANGE),key:currentKey?{...currentKey}:null,sequence:nextSequence};} else if(line.startsWith("#EXT-X-BYTERANGE:"))nextByteRange=parseByteRange(line.slice(line.indexOf(":")+1),previousRangeEnd); else if(!line.startsWith("#")){segments.push({url:new URL(line,baseUrl).href,range:nextByteRange,key:currentKey?{...currentKey}:null,sequence:nextSequence,map:currentMap}); previousRangeEnd=nextByteRange?nextByteRange.offset+nextByteRange.length:0; nextByteRange=null; nextSequence+=1;}} return{segments,isLive:!text.includes("#EXT-X-ENDLIST"),targetDuration}; }
function ivBytes(ivText,sequence) { if(ivText){const hex=ivText.replace(/^0x/i,"").padStart(32,"0"); if(!/^[0-9a-f]{32}$/i.test(hex))throw new Error("HLS AES-128 IV 格式无效"); return Uint8Array.from(hex.match(/.{2}/g),(byte)=>parseInt(byte,16));} const iv=new Uint8Array(16); new DataView(iv.buffer).setUint32(12,sequence>>>0); return iv; }
async function decryptSegment(bytes,keyInfo,keyCache,sequence) { if(!keyInfo)return bytes; let cryptoKey=keyCache.get(keyInfo.url); if(!cryptoKey){const keyBytes=await fetchResource(keyInfo.url); if(keyBytes.byteLength!==16)throw new Error("AES-128 密钥长度不是 16 字节"); cryptoKey=await crypto.subtle.importKey("raw",keyBytes,{name:"AES-CBC"},false,["decrypt"]); keyCache.set(keyInfo.url,cryptoKey);} return new Uint8Array(await crypto.subtle.decrypt({name:"AES-CBC",iv:ivBytes(keyInfo.iv,sequence)},cryptoKey,bytes)); }
const segmentId=(segment)=>`${segment.sequence}|${segment.url}|${JSON.stringify(segment.range)}`; const mapId=(map)=>`${map.url}|${JSON.stringify(map.range)}`;
async function waitIfPaused() { while(state.paused&&!state.cancelled&&!state.finished)await new Promise((resolve)=>setTimeout(resolve,200)); }
async function addPart(bytes) { state.totalBytes+=bytes.byteLength; const needsFfmpegVideo=state.outputMode==="video"&&state.videoFormat!=="auto"&&state.videoFormat!==state.sourceExtension&&!(state.sourceExtension==="ts"&&state.videoFormat==="mp4"); const limit=state.outputMode==="audio"?MAX_AUDIO_INPUT_BYTES:needsFfmpegVideo?MAX_VIDEO_TRANSCODE_BYTES:state.sourceExtension==="ts"?MAX_TS_REMUX_BYTES:MAX_DOWNLOAD_BYTES; if(state.totalBytes>limit)throw new Error(state.outputMode==="audio"?"源媒体超过 500 MB，浏览器内音频编码可能导致内存不足，已停止任务":needsFfmpegVideo?"源视频超过 500 MB，浏览器内格式转换可能导致内存不足，已停止任务":state.sourceExtension==="ts"?"TS 视频超过 750 MB，浏览器内转换 MP4 可能导致内存不足，已停止任务":"视频超过 1.5 GB，已停止以避免浏览器内存不足"); state.parts.push(bytes); }
function detectExtension(segments) { if(segments.some((segment)=>segment.map))return"mp4"; const path=new URL(segments[0]?.url||state.job.item.url).pathname.toLowerCase(); if(path.endsWith(".aac"))return"aac"; if(path.endsWith(".mp4")||path.endsWith(".m4s"))return"mp4"; return"ts"; }

function extensionFromUrl(url,type="") { try{const match=new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);if(match)return match[1].toLowerCase();}catch(_){} if(type.includes("webm"))return"webm";if(type.includes("quicktime"))return"mov";if(type.includes("mpeg"))return"mp3";return"mp4"; }

function parseProbeOutput(lines) { const text=lines.join("\n"); const value=(name)=>text.match(new RegExp(`(?:^|\\n)${name}=([^\\n]+)`))?.[1]?.trim()||""; return{codec:value("codec_name").toLowerCase(),bitRate:Number(value("bit_rate"))||0,sampleRate:Number(value("sample_rate"))||0,bitsPerSample:Number(value("bits_per_raw_sample"))||0}; }

function chooseMp3BitRate(probe, isLossless) {
  if (isLossless) return 320;
  const sourceKbps = Math.round(probe.bitRate / 1000);
  const levels = [64, 80, 96, 128, 160, 192, 224, 256, 320];
  return sourceKbps ? levels.filter((level) => level <= Math.max(sourceKbps, 64)).pop() || 64 : 192;
}

function chooseAudioOutput(probe, requestedFormat = "auto") {
  const losslessCodecs = ["flac", "alac", "ape", "wavpack"];
  const isLossless = losslessCodecs.includes(probe.codec) || probe.codec.startsWith("pcm_");
  const sourceLabel = probe.codec.toUpperCase() || "未知编码";
  if (requestedFormat === "flac") {
    if (probe.codec === "flac") return { extension: "flac", codec: "copy", detail: "源音频已经是 FLAC，将直接提取而不重复编码" };
    return { extension: "flac", codec: "flac", detail: isLossless ? `按你的选择，将无损 ${sourceLabel} 转换为 FLAC` : `按你的选择，将有损 ${sourceLabel} 转换为 FLAC；文件会变大，但不会恢复已损失音质` };
  }
  if (requestedFormat === "mp3") {
    if (probe.codec === "mp3") return { extension: "mp3", codec: "copy", detail: "源音频已经是 MP3，将直接提取而不重复编码" };
    const bitRate = chooseMp3BitRate(probe, isLossless);
    return { extension: "mp3", codec: "libmp3lame", bitRate, detail: `按你的选择，将 ${sourceLabel} 转换为 MP3 ${bitRate} kbps` };
  }
  if (probe.codec === "flac") return { extension: "flac", codec: "copy", detail: "检测到无损 FLAC，将直接提取" };
  if (isLossless) return { extension: "flac", codec: "flac", detail: `检测到无损音频 ${sourceLabel}，自动保存为 FLAC` };
  if (probe.codec === "mp3") return { extension: "mp3", codec: "copy", detail: "源音频已经是 MP3，将直接提取" };
  const bitRate = chooseMp3BitRate(probe, false);
  const sourceKbps = Math.round(probe.bitRate / 1000);
  return { extension: "mp3", codec: "libmp3lame", bitRate, detail: `源音频为 ${sourceLabel}${sourceKbps ? ` · ${sourceKbps} kbps` : ""}，自动输出 MP3 ${bitRate} kbps` };
}

async function extractAudio(inputParts) {
  if (!globalThis.FFmpegWASM?.FFmpeg) throw new Error("本地音频编码器没有正确加载");
  setStatus("加载编码器", "首次音频提取需要载入约 31 MB 的本地 FFmpeg 组件…");
  ui.pauseButton.disabled = true;
  ui.finishButton.disabled = true;
  ui.cancelButton.disabled = true;
  const ffmpeg = new FFmpegWASM.FFmpeg();
  const logs = [];
  ffmpeg.on("log", ({ message }) => logs.push(message));
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress) && progress >= 0) ui.messageBox.textContent = `正在提取音频并编码：${Math.min(100, Math.round(progress * 100))}%`;
  });
  try {
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.wasm")
    });
    const inputName = `input.${state.sourceExtension || "bin"}`;
    await ffmpeg.writeFile(inputName, new Uint8Array(await new Blob(inputParts).arrayBuffer()));
    logs.length = 0;
    await ffmpeg.ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,bit_rate,sample_rate,bits_per_raw_sample", "-of", "default=noprint_wrappers=1", inputName]);
    const probe = parseProbeOutput(logs);
    if (!probe.codec) throw new Error("源媒体中没有检测到可提取的音轨");
    const choice = chooseAudioOutput(probe, state.audioFormat);
    state.extension = choice.extension;
    updateProgress();
    setStatus("正在编码", choice.detail);
    const outputName = `output.${choice.extension}`;
    const args = ["-i", inputName, "-vn", "-map", "0:a:0", "-map_metadata", "-1"];
    if (choice.codec === "copy") args.push("-c:a", "copy");
    else if (choice.codec === "flac") args.push("-c:a", "flac", "-compression_level", "5");
    else args.push("-c:a", "libmp3lame", "-b:a", `${choice.bitRate}k`);
    args.push(outputName);
    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) throw new Error(`音频编码失败（FFmpeg 返回 ${exitCode}）`);
    const output = await ffmpeg.readFile(outputName);
    return { parts: [new Uint8Array(output)], extension: choice.extension, detail: choice.detail };
  } finally {
    ffmpeg.terminate();
  }
}

function transmuxTsParts(inputParts) { if(!globalThis.muxjs?.mp4?.Transmuxer)throw new Error("MP4 转换组件没有正确加载"); const output=[]; let initWritten=false; const transmuxer=new muxjs.mp4.Transmuxer({remux:true,keepOriginalTimestamps:false}); transmuxer.on("data",(segment)=>{if(!initWritten){output.push(new Uint8Array(segment.initSegment));initWritten=true;} output.push(new Uint8Array(segment.data));}); for(const part of inputParts){transmuxer.push(part);transmuxer.flush();} if(!initWritten||!output.length)throw new Error("源 TS 编码不是可转换的 H.264/AAC"); return output; }

async function convertVideo(inputParts, targetExtension) {
  if (!globalThis.FFmpegWASM?.FFmpeg) throw new Error("本地视频转换组件没有正确加载");
  const ffmpeg = new FFmpegWASM.FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress) && progress >= 0) ui.messageBox.textContent = `正在转换视频格式：${Math.min(100, Math.round(progress * 100))}%`;
  });
  try {
    setStatus("准备转换", `正在载入本地 FFmpeg，并尝试无损转换为 ${targetExtension.toUpperCase()}…`);
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.wasm")
    });
    const inputName = `input.${state.sourceExtension || "bin"}`;
    const outputName = `output.${targetExtension}`;
    await ffmpeg.writeFile(inputName, new Uint8Array(await new Blob(inputParts).arrayBuffer()));
    const copyArgs = ["-i", inputName, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy"];
    if (targetExtension === "mp4") copyArgs.push("-movflags", "+faststart");
    else copyArgs.push("-f", "mpegts");
    copyArgs.push(outputName);
    let exitCode = await ffmpeg.exec(copyArgs);
    let transcoded = false;
    if (exitCode !== 0) {
      try { await ffmpeg.deleteFile(outputName); } catch (_) {}
      transcoded = true;
      setStatus("编码转换", `源编码不兼容 ${targetExtension.toUpperCase()}，正在转换为 H.264/AAC…`);
      const transcodeArgs = ["-i", inputName, "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-c:a", "aac", "-b:a", "192k"];
      if (targetExtension === "mp4") transcodeArgs.push("-movflags", "+faststart");
      else transcodeArgs.push("-f", "mpegts");
      transcodeArgs.push(outputName);
      exitCode = await ffmpeg.exec(transcodeArgs);
    }
    if (exitCode !== 0) throw new Error(`视频转换失败（FFmpeg 返回 ${exitCode}）`);
    const output = await ffmpeg.readFile(outputName);
    return { parts: [new Uint8Array(output)], extension: targetExtension, detail: transcoded ? `源编码不兼容，已转码并保存为 ${targetExtension.toUpperCase()}` : `已无损重封装为 ${targetExtension.toUpperCase()}` };
  } finally {
    ffmpeg.terminate();
  }
}

async function mergeDashTracks(videoBytes, audioBytes, targetExtension) {
  if (!globalThis.FFmpegWASM?.FFmpeg) throw new Error("本地音视频合并组件没有正确加载");
  const ffmpeg = new FFmpegWASM.FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress) && progress >= 0) ui.messageBox.textContent = `正在合并音视频：${Math.min(100, Math.round(progress * 100))}%`;
  });
  try {
    setStatus("准备合并", `正在载入本地 FFmpeg，并生成 ${targetExtension.toUpperCase()} 文件…`);
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.wasm")
    });
    await ffmpeg.writeFile("video.m4s", videoBytes);
    if (audioBytes) await ffmpeg.writeFile("audio.m4s", audioBytes);
    const outputName = `output.${targetExtension}`;
    const inputs = ["-i", "video.m4s"];
    if (audioBytes) inputs.push("-i", "audio.m4s");
    const maps = audioBytes ? ["-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0"];
    const containerArgs = targetExtension === "mp4" ? ["-movflags", "+faststart"] : ["-f", "mpegts"];
    let exitCode = await ffmpeg.exec([...inputs, ...maps, "-c", "copy", ...containerArgs, outputName]);
    let transcoded = false;
    if (exitCode !== 0) {
      try { await ffmpeg.deleteFile(outputName); } catch (_) {}
      transcoded = true;
      setStatus("编码转换", `所选编码不能直接写入 ${targetExtension.toUpperCase()}，正在转换为 H.264/AAC…`);
      const codecs = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20"];
      if (audioBytes) codecs.push("-c:a", "aac", "-b:a", "192k");
      exitCode = await ffmpeg.exec([...inputs, ...maps, ...codecs, ...containerArgs, outputName]);
    }
    if (exitCode !== 0) throw new Error(`Bilibili 音视频合并失败（FFmpeg 返回 ${exitCode}）`);
    const output = await ffmpeg.readFile(outputName);
    return {
      parts: [new Uint8Array(output)],
      extension: targetExtension,
      detail: transcoded ? `已将不兼容编码转换并合并为 ${targetExtension.toUpperCase()}` : `视频轨和音频轨已无损合并为 ${targetExtension.toUpperCase()}`
    };
  } finally {
    ffmpeg.terminate();
  }
}

async function saveParts(partial = false) {
  if (!state.parts.length) throw new Error("还没有可保存的分片");
  let outputParts = state.parts.slice();
  let outputExtension = state.sourceExtension;
  let detail = "";
  if (state.outputMode === "audio") {
    const extracted = await extractAudio(outputParts);
    outputParts = extracted.parts;
    outputExtension = extracted.extension;
    detail = extracted.detail;
  } else {
    const targetExtension = state.videoFormat === "auto" ? (state.sourceExtension === "ts" ? "mp4" : state.sourceExtension) : state.videoFormat;
    if (targetExtension === state.sourceExtension) {
      outputExtension = targetExtension;
      detail = `源格式已经是 ${targetExtension.toUpperCase()}，无需转换`;
    } else if (state.sourceExtension === "ts" && targetExtension === "mp4") {
      setStatus("转换中", "正在将 MPEG-TS 无损重新封装为 MP4，请不要关闭页面…");
      await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        outputParts = transmuxTsParts(outputParts);
        outputExtension = "mp4";
        detail = "已无损重封装为 MP4";
      } catch (_) {
        const converted = await convertVideo(outputParts, "mp4");
        outputParts = converted.parts;
        outputExtension = converted.extension;
        detail = converted.detail;
      }
    } else {
      const converted = await convertVideo(outputParts, targetExtension);
      outputParts = converted.parts;
      outputExtension = converted.extension;
      detail = converted.detail;
    }
    state.extension = outputExtension;
  }
  const mime = outputExtension === "mp4" ? "video/mp4" : outputExtension === "mp3" ? "audio/mpeg" : outputExtension === "flac" ? "audio/flac" : outputExtension === "aac" ? "audio/aac" : "video/mp2t";
  const suffix = partial ? "-部分" : "";
  const fullFilename = `${state.job.filename}${suffix}.${outputExtension}`;
  state.pendingSave = {
    blob: new Blob(outputParts, { type: mime }),
    fullFilename,
    suggestedName: fullFilename.split("/").pop(),
    extension: outputExtension,
    mime,
    detail
  };
  ui.finishButton.textContent = "保存文件";
  ui.finishButton.disabled = false;
  ui.partialButton.disabled = true;
  setStatus("等待保存", `${detail || `已生成 ${outputExtension.toUpperCase()} 文件`}。请点击“保存文件”选择保存位置。`);
}

async function savePreparedFile() {
  if (!state.pendingSave || state.saving) return;
  state.saving = true;
  const pending = state.pendingSave;
  ui.finishButton.disabled = true;
  setStatus("正在保存", `正在写入 ${formatBytes(pending.blob.size)} 文件…`);
  try {
    if (typeof window.showSaveFilePicker === "function") {
      const handle = await window.showSaveFilePicker({
        suggestedName: pending.suggestedName,
        types: [{ description: `${pending.extension.toUpperCase()} 媒体文件`, accept: { [pending.mime]: [`.${pending.extension}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(pending.blob);
      await writable.close();
    } else {
      const blobUrl = URL.createObjectURL(pending.blob);
      try {
        await chrome.downloads.download({ url: blobUrl, filename: pending.fullFilename, saveAs: true });
      } catch (downloadError) {
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = pending.suggestedName;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        console.warn("chrome.downloads fallback used", downloadError);
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
      }
    }
    state.saved = true;
    state.pendingSave = null;
    ui.finishButton.textContent = "保存完成";
    ui.finishButton.disabled = true;
    setStatus("保存完成", `${pending.suggestedName} 已成功写入你选择的位置。`);
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("等待保存", "你取消了保存位置选择。文件仍保留在内存中，可再次点击“保存文件”。", "paused");
    } else {
      setStatus("保存失败", errorMessage(error), "error");
      console.error("File save failed", error);
    }
    ui.finishButton.disabled = false;
  } finally {
    state.saving = false;
  }
}

async function runDownload() { state.startedAt=Date.now(); setStatus("解析中","正在解析播放清单和可用清晰度…"); ui.cancelButton.disabled=false; const keyCache=new Map(),downloaded=new Set(),loadedMaps=new Set(); const playlist=await resolveMediaPlaylist(state.job.item.url); let playlistText=playlist.text,playlistUrl=playlist.url; while(!state.cancelled&&!state.finished){const parsed=parseMediaPlaylist(playlistText,playlistUrl); if(!parsed.segments.length)throw new Error("播放清单中没有可下载的媒体分片"); state.isLive=parsed.isLive; state.sourceExtension=detectExtension(parsed.segments); state.extension=state.outputMode==="audio"?(state.audioFormat==="auto"?"auto":state.audioFormat):state.videoFormat==="auto"?(state.sourceExtension==="ts"?"mp4":state.sourceExtension):state.videoFormat; state.totalSegments=state.isLive?0:parsed.segments.length; ui.pauseButton.disabled=false; ui.finishButton.disabled=!state.isLive; const selectedAudioFormat=state.audioFormat==="auto"?"根据源音质自动选择 MP3 或 FLAC":`转换为 ${state.audioFormat.toUpperCase()}`; const audioMessage=state.isLive?`正在捕获直播音频，结束后${selectedAudioFormat}。`:`正在下载媒体分片，完成后${selectedAudioFormat}…`; const selectedVideoFormat=state.videoFormat==="auto"?"自动选择容器":`保存为 ${state.videoFormat.toUpperCase()}`; const videoMessage=state.isLive?`正在捕获直播流，结束后${selectedVideoFormat}。`:`正在下载 HLS 分片，完成后${selectedVideoFormat}…`; setStatus("下载中",state.outputMode==="audio"?audioMessage:videoMessage); updateProgress(); for(const segment of parsed.segments){if(state.cancelled||state.finished)break; if(downloaded.has(segmentId(segment)))continue; await waitIfPaused(); if(state.cancelled||state.finished)break; if(segment.map&&!loadedMaps.has(mapId(segment.map))){let mapBytes=await fetchResource(segment.map.url,segment.map.range); mapBytes=await decryptSegment(mapBytes,segment.map.key,keyCache,segment.map.sequence); await addPart(mapBytes); loadedMaps.add(mapId(segment.map));} let bytes=await fetchResource(segment.url,segment.range); bytes=await decryptSegment(bytes,segment.key,keyCache,segment.sequence); await addPart(bytes); downloaded.add(segmentId(segment)); state.segmentCount+=1; updateProgress();} if(!state.isLive||state.cancelled||state.finished)break; await new Promise((resolve)=>setTimeout(resolve,Math.max(1000,parsed.targetDuration*700))); if(state.cancelled||state.finished)break; playlistText=await fetchManifest(playlistUrl);} if(state.finished)await saveParts(false); else if(!state.cancelled&&!state.isLive){state.finished=true;updateProgress();await saveParts(false);} else if(state.cancelled)setStatus("已取消","下载已停止。你仍可保存已经完成的分片。","error"); ui.pauseButton.disabled=true;ui.finishButton.disabled=!state.pendingSave;ui.cancelButton.disabled=true;updateProgress(); }

ui.pauseButton.addEventListener("click",()=>{state.paused=!state.paused;ui.pauseButton.textContent=state.paused?"继续":"暂停";setStatus(state.paused?"已暂停":"下载中",state.paused?"任务已暂停，当前数据保留在浏览器内存中。":"任务已继续。",state.paused?"paused":"");updateProgress();});
ui.finishButton.addEventListener("click",()=>{if(state.pendingSave){savePreparedFile();return;}state.finished=true;state.paused=false;state.controller?.abort();setStatus("正在结束","正在整理已捕获分片并生成文件…");});
ui.cancelButton.addEventListener("click",()=>{state.cancelled=true;state.paused=false;state.controller?.abort();});
ui.partialButton.addEventListener("click",()=>saveParts(true).catch((error)=>setStatus("生成失败",errorMessage(error),"error")));

async function runBilibiliDash() {
  const item = state.job.item;
  const videoStream = item.selectedVideo || item.videoStreams?.[0];
  const audioStream = item.selectedAudio || item.audioStreams?.[0] || null;
  if (!videoStream) throw new Error("没有找到所选的 Bilibili 视频轨");
  if (state.outputMode === "audio" && !audioStream) throw new Error("没有找到可提取的 Bilibili 音轨");

  state.startedAt = Date.now();
  state.isLive = false;
  state.totalSegments = state.outputMode === "audio" || !audioStream ? 1 : 2;
  state.segmentCount = 0;
  state.extension = state.outputMode === "audio"
    ? (state.audioFormat === "auto" ? "auto" : state.audioFormat)
    : (state.videoFormat === "auto" ? "mp4" : state.videoFormat);
  ui.pauseButton.disabled = false;
  ui.finishButton.disabled = true;
  ui.partialButton.disabled = true;
  ui.cancelButton.disabled = false;
  updateProgress();

  if (state.outputMode === "audio") {
    setStatus("下载音轨", `正在下载 ${item.selectedAudioLabel || audioStream.label || "Bilibili 音轨"}…`);
    const audioBytes = await fetchDashStream(audioStream);
    state.totalBytes = audioBytes.byteLength;
    if (state.totalBytes > MAX_AUDIO_INPUT_BYTES) throw new Error("音轨超过 500 MB，浏览器内转换可能导致内存不足，已停止任务");
    state.parts = [audioBytes];
    state.sourceExtension = extensionFromUrl(audioStream.url, audioStream.mimeType || "audio/mp4");
    state.segmentCount = 1;
    state.finished = true;
    updateProgress();
    await saveParts(false);
  } else {
    setStatus("下载视频轨", `正在下载 ${item.selectedQuality || videoStream.label || "所选清晰度"}…`);
    const videoBytes = await fetchDashStream(videoStream);
    state.totalBytes = videoBytes.byteLength;
    if (state.totalBytes > MAX_DASH_INPUT_BYTES) throw new Error("DASH 音视频超过 500 MB，浏览器内合并可能导致内存不足，已停止任务");
    state.segmentCount = 1;
    updateProgress();
    await waitIfPaused();
    if (state.cancelled) throw new DOMException("任务已取消", "AbortError");

    let audioBytes = null;
    if (audioStream) {
      setStatus("下载音频轨", `视频轨已完成，正在下载 ${item.selectedAudioLabel || audioStream.label || "音频轨"}…`);
      audioBytes = await fetchDashStream(audioStream);
      state.totalBytes += audioBytes.byteLength;
      if (state.totalBytes > MAX_DASH_INPUT_BYTES) throw new Error("DASH 音视频合计超过 500 MB，浏览器内合并可能导致内存不足，已停止任务");
      state.segmentCount = 2;
      updateProgress();
    }
    await waitIfPaused();
    if (state.cancelled) throw new DOMException("任务已取消", "AbortError");

    const targetExtension = state.videoFormat === "ts" ? "ts" : "mp4";
    const merged = await mergeDashTracks(videoBytes, audioBytes, targetExtension);
    state.parts = merged.parts;
    state.sourceExtension = merged.extension;
    state.videoFormat = merged.extension;
    state.finished = true;
    updateProgress();
    await saveParts(false);
  }

  ui.pauseButton.disabled = true;
  ui.cancelButton.disabled = true;
  ui.finishButton.disabled = !state.pendingSave;
}

async function runDirectAudio() {
  state.startedAt = Date.now();
  state.sourceExtension = extensionFromUrl(state.job.item.url, state.job.item.type);
  state.extension = state.audioFormat === "auto" ? "auto" : state.audioFormat;
  state.totalSegments = 1;
  ui.cancelButton.disabled = false;
  setStatus("下载中", "正在读取媒体文件，随后会分析并提取音轨…");
  updateProgress();
  const bytes = await fetchResource(state.job.item.url);
  await addPart(bytes);
  state.segmentCount = 1;
  state.finished = true;
  updateProgress();
  await saveParts(false);
  ui.cancelButton.disabled = true;
}

async function runDirectVideo() {
  state.startedAt = Date.now();
  state.sourceExtension = extensionFromUrl(state.job.item.url, state.job.item.type);
  state.extension = state.videoFormat === "auto" ? state.sourceExtension : state.videoFormat;
  state.totalSegments = 1;
  ui.cancelButton.disabled = false;
  setStatus("下载中", `正在读取媒体文件，随后${state.videoFormat === "auto" ? "按源格式保存" : `处理为 ${state.videoFormat.toUpperCase()}`}…`);
  updateProgress();
  const bytes = await fetchResource(state.job.item.url);
  await addPart(bytes);
  state.segmentCount = 1;
  state.finished = true;
  updateProgress();
  await saveParts(false);
  ui.cancelButton.disabled = true;
}

async function init() {
  const jobId = new URLSearchParams(location.search).get("job");
  if (!jobId) throw new Error("下载任务编号缺失");
  const key = `hls_job_${jobId}`;
  const stored = await chrome.storage.session.get(key);
  state.job = stored[key];
  if (!state.job) throw new Error("下载任务已失效，请从视频页面重新开始");
  state.outputMode = state.job.mode || "video";
  state.audioFormat = ["auto", "mp3", "flac"].includes(state.job.audioFormat) ? state.job.audioFormat : "auto";
  state.videoFormat = ["auto", "mp4", "ts"].includes(state.job.videoFormat) ? state.job.videoFormat : "auto";
  await chrome.storage.session.remove(key);
  const details = [];
  if (state.outputMode === "audio") details.push(state.audioFormat === "auto" ? "自动选择格式" : state.audioFormat.toUpperCase());
  else details.push(state.videoFormat === "auto" ? "自动选择格式" : state.videoFormat.toUpperCase());
  if (state.job.item.selectedQuality) details.push(state.job.item.selectedQuality);
  if (state.job.item.selectedAudioLabel && state.job.item.kind === "bilibili-dash") details.push(state.job.item.selectedAudioLabel);
  details.push(state.job.item.kind === "bilibili-dash" ? state.job.item.pageUrl : state.job.item.url);
  ui.videoTitle.textContent = `${state.job.item.title || "未命名视频"}${state.outputMode === "audio" ? " · 仅音频" : ""}`;
  ui.videoUrl.textContent = details.join(" · ");
  document.title = `${state.job.item.title || "视频"} - ${state.outputMode === "audio" ? "音频提取" : "下载中心"}`;
  if (state.job.item.kind === "bilibili-dash") await runBilibiliDash();
  else if (state.job.item.kind === "direct" && state.outputMode === "audio") await runDirectAudio();
  else if (state.job.item.kind === "direct" && state.outputMode === "video") await runDirectVideo();
  else await runDownload();
}
init().catch(async (error) => {
  if (error?.name === "AbortError" && (state.cancelled || state.finished)) {
    if (state.finished) {
      try { await saveParts(false); } catch (saveError) { setStatus("生成失败", errorMessage(saveError), "error"); }
    } else {
      setStatus("已取消", "下载已停止。你仍可保存已经完成的分片。", "error");
    }
  } else {
    setStatus("下载失败", errorMessage(error), "error");
    console.error("Download task failed", error);
  }
  ui.pauseButton.disabled = true;
  ui.finishButton.disabled = !state.pendingSave;
  ui.cancelButton.disabled = true;
  updateProgress();
});
