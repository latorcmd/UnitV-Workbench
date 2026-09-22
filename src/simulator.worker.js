import { mapPreparedError, parsePythonRuntimeError, prepareUnitVCode } from './python-runtime-errors.js';
import { KmodelManager } from './kmodel-runtime.js';

const FRAME_SIZES = {
  QQVGA: [160, 120], QVGA: [320, 240], VGA: [640, 480],
  QQQVGA: [80, 60], B64X64: [64, 64], B128X128: [128, 128], LCD: [320, 240]
};

let sourceFrame = null;
let latestFrame = null;
let targetSize = FRAME_SIZES.QVGA;
let windowing = null;
let hmirror = false;
let vflip = false;
let brightness = 0;
let saturation = 0;
let contrast = 0;
let registers = {};
let uartQueue = [];
let gpio = {};
let ledState = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
let kmodelManager = null;
let pyodide = null;
let liveCameraMode = false;
let cameraRequestSequence = 0;
const cameraFrameRequests = new Map();
let pythonOutputBuffer = [];

const clamp = (n, min = 0, max = 255) => Math.max(min, Math.min(max, Number(n) || 0));
const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const stamp = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });

function emitLiveFrame() {
  if (!liveCameraMode || !latestFrame) return;
  const data = new Uint8ClampedArray(latestFrame.data);
  self.postMessage({ type:'frame', width:latestFrame.width, height:latestFrame.height, data:data.buffer }, [data.buffer]);
}

function requestCameraFrame() {
  emitLiveFrame();
  const requestId = ++cameraRequestSequence;
  post('camera-frame-request', { requestId });
  return new Promise((resolve, reject) => cameraFrameRequests.set(requestId, { resolve, reject }));
}

function toJs(value) {
  if (value == null) return value;
  if (typeof value.toJs === 'function') return value.toJs({ dict_converter: Object.fromEntries });
  if (ArrayBuffer.isView(value)) return Array.from(value);
  return value;
}

function colorTuple(value, fallback = [255, 255, 255]) {
  const raw = toJs(value);
  if (typeof raw === 'number') return [raw, raw, raw, 255].map((v, i) => i === 3 ? 255 : clamp(v));
  const c = Array.isArray(raw) ? raw : fallback;
  return [clamp(c[0]), clamp(c[1]), clamp(c[2]), 255];
}

function cloneFrame(frame) {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
}

function resizeFrame(frame, width, height) {
  width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.height - 1, Math.floor(y * frame.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, Math.floor(x * frame.width / width));
      const si = (sy * frame.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = frame.data[si]; out[di + 1] = frame.data[si + 1]; out[di + 2] = frame.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function cropFrame(frame, roi) {
  const [rx, ry, rw, rh] = roi.map(Number);
  const x0 = Math.max(0, Math.floor(rx)); const y0 = Math.max(0, Math.floor(ry));
  const width = Math.max(1, Math.min(frame.width - x0, Math.floor(rw)));
  const height = Math.max(1, Math.min(frame.height - y0, Math.floor(rh)));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y0 + y) * frame.width + x0) * 4;
    out.set(frame.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, data: out };
}

function flipFrame(frame) {
  if (!hmirror && !vflip) return frame;
  const out = new Uint8ClampedArray(frame.data.length);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const sx = hmirror ? frame.width - 1 - x : x;
    const sy = vflip ? frame.height - 1 - y : y;
    out.set(frame.data.subarray((sy * frame.width + sx) * 4, (sy * frame.width + sx) * 4 + 4), (y * frame.width + x) * 4);
  }
  return { width: frame.width, height: frame.height, data: out };
}

function adjustFrame(frame) {
  if (!brightness && !saturation && !contrast) return frame;
  const light = Number(brightness) * 12;
  const contrastScale = 1 + Number(contrast) * .12;
  const saturationScale = 1 + Number(saturation) * .16;
  for (let i = 0; i < frame.data.length; i += 4) {
    let r = (frame.data[i] - 128) * contrastScale + 128 + light;
    let g = (frame.data[i + 1] - 128) * contrastScale + 128 + light;
    let b = (frame.data[i + 2] - 128) * contrastScale + 128 + light;
    const gray = .299 * r + .587 * g + .114 * b;
    frame.data[i] = clamp(gray + (r - gray) * saturationScale);
    frame.data[i + 1] = clamp(gray + (g - gray) * saturationScale);
    frame.data[i + 2] = clamp(gray + (b - gray) * saturationScale);
  }
  return frame;
}

function rgbToLab(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  r = r > .04045 ? ((r + .055) / 1.055) ** 2.4 : r / 12.92;
  g = g > .04045 ? ((g + .055) / 1.055) ** 2.4 : g / 12.92;
  b = b > .04045 ? ((b + .055) / 1.055) ** 2.4 : b / 12.92;
  let x = (r * .4124 + g * .3576 + b * .1805) / .95047;
  let y = (r * .2126 + g * .7152 + b * .0722);
  let z = (r * .0193 + g * .1192 + b * .9505) / 1.08883;
  const f = n => n > .008856 ? Math.cbrt(n) : 7.787 * n + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function matchesThreshold(r, g, b, thresholds) {
  for (const t of thresholds) {
    if (t.length >= 6) {
      const [l, a, bb] = rgbToLab(r, g, b);
      if (l >= t[0] && l <= t[1] && a >= t[2] && a <= t[3] && bb >= t[4] && bb <= t[5]) return true;
    } else if (t.length >= 2) {
      const gray = .299 * r + .587 * g + .114 * b;
      if (gray >= t[0] && gray <= t[1]) return true;
    }
  }
  return false;
}

function thresholdCode(r, g, b, thresholds) {
  let code = 0;
  thresholds.forEach((threshold, index) => { if (matchesThreshold(r, g, b, [threshold])) code |= (1 << index); });
  return code;
}

function setPixel(frame, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  const i = (y * frame.width + x) * 4;
  frame.data[i] = c[0]; frame.data[i + 1] = c[1]; frame.data[i + 2] = c[2]; frame.data[i + 3] = 255;
}

function drawLine(frame, x0, y0, x1, y1, color, thickness = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    const rad = Math.max(0, Math.floor(thickness / 2));
    for (let yy = -rad; yy <= rad; yy++) for (let xx = -rad; xx <= rad; xx++) setPixel(frame, x0 + xx, y0 + yy, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawRect(frame, rect, color, thickness = 1, fill = false) {
  const [x, y, w, h] = rect.map(Number);
  if (fill) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(frame, xx, yy, color);
    return;
  }
  drawLine(frame, x, y, x + w, y, color, thickness); drawLine(frame, x, y + h, x + w, y + h, color, thickness);
  drawLine(frame, x, y, x, y + h, color, thickness); drawLine(frame, x + w, y, x + w, y + h, color, thickness);
}

function drawCircle(frame, cx, cy, radius, color, thickness = 1, fill = false) {
  const outer = Number(radius); const inner = fill ? 0 : Math.max(0, outer - thickness);
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= outer && d >= inner) setPixel(frame, x, y, color);
  }
}

function canvasDrawText(frame, x, y, text, color, scale = 1) {
  if (typeof OffscreenCanvas === 'undefined') return;
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.font = `${Math.max(10, 12 * Number(scale))}px monospace`;
  ctx.textBaseline = 'top'; ctx.fillText(String(text), Number(x), Number(y));
  frame.data = ctx.getImageData(0, 0, frame.width, frame.height).data;
}

function thresholdArray(value) {
  const raw = toJs(value) || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(t => Array.from(t, Number));
}

class RawImage {
  constructor(frame) { this.frame = frame; latestFrame = frame; }
  width() { return this.frame.width; }
  height() { return this.frame.height; }
  size() { return this.frame.data.length; }
  resize(w, h) { this.frame = resizeFrame(this.frame, w, h); latestFrame = this.frame; return this; }
  crop(roi) { this.frame = cropFrame(this.frame, Array.from(toJs(roi))); latestFrame = this.frame; return this; }
  copy(roi) { return roi == null ? new RawImage(cloneFrame(this.frame)) : new RawImage(cropFrame(this.frame, Array.from(toJs(roi)))); }
  binary(thresholds, invert = false) {
    const ts = thresholdArray(thresholds);
    for (let i = 0; i < this.frame.data.length; i += 4) {
      let ok = matchesThreshold(this.frame.data[i], this.frame.data[i + 1], this.frame.data[i + 2], ts);
      if (invert) ok = !ok;
      const v = ok ? 255 : 0; this.frame.data[i] = v; this.frame.data[i + 1] = v; this.frame.data[i + 2] = v;
    }
    latestFrame = this.frame; return this;
  }
  findBlobs(thresholds, roi, xStride = 2, yStride = 1, invert = false, areaThreshold = 10, pixelsThreshold = 10, merge = false, margin = 0) {
    const ts = thresholdArray(thresholds);
    const r = roi == null ? [0, 0, this.frame.width, this.frame.height] : Array.from(toJs(roi), Number);
    const x0 = Math.max(0, r[0] | 0), y0 = Math.max(0, r[1] | 0);
    const x1 = Math.min(this.frame.width, x0 + (r[2] | 0)), y1 = Math.min(this.frame.height, y0 + (r[3] | 0));
    const width = x1 - x0, height = y1 - y0;
    const mask = new Uint32Array(width * height), seen = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const pi = ((y + y0) * this.frame.width + x + x0) * 4;
      let code = thresholdCode(this.frame.data[pi], this.frame.data[pi + 1], this.frame.data[pi + 2], ts);
      if (invert) code = code ? 0 : 1; mask[y * width + x] = code;
    }
    const blobs = [];
    for (let sy = 0; sy < height; sy += Math.max(1, Number(yStride))) for (let sx = 0; sx < width; sx += Math.max(1, Number(xStride))) {
      const seed = sy * width + sx; if (!mask[seed] || seen[seed]) continue;
      const qx = [sx], qy = [sy]; seen[seed] = 1;
      const componentCode = mask[seed];
      let head = 0, count = 0, minX = sx, maxX = sx, minY = sy, maxY = sy, sumX = 0, sumY = 0;
      while (head < qx.length) {
        const x = qx[head], y = qy[head++]; count++; sumX += x; sumY += y;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx; if (mask[ni] === componentCode && !seen[ni]) { seen[ni] = 1; qx.push(nx); qy.push(ny); }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (count >= Number(pixelsThreshold) && bw * bh >= Number(areaThreshold)) blobs.push({
        x: minX + x0, y: minY + y0, w: bw, h: bh, pixels: count,
        cx: Math.round(sumX / count) + x0, cy: Math.round(sumY / count) + y0,
        density: count / (bw * bh), rotation: 0, code:componentCode
      });
    }
    if (merge && blobs.length > 1) {
      const merged = [];
      for (const b of blobs.sort((a,b)=>b.pixels-a.pixels)) {
        const hit = merged.find(m => b.x <= m.x+m.w+margin && b.x+b.w+margin >= m.x && b.y <= m.y+m.h+margin && b.y+b.h+margin >= m.y);
        if (!hit) merged.push({...b}); else {
          const nx = Math.min(hit.x,b.x), ny=Math.min(hit.y,b.y), nx2=Math.max(hit.x+hit.w,b.x+b.w), ny2=Math.max(hit.y+hit.h,b.y+b.h);
          hit.pixels += b.pixels; hit.code |= b.code; hit.x=nx; hit.y=ny; hit.w=nx2-nx; hit.h=ny2-ny; hit.cx=Math.round(nx+hit.w/2); hit.cy=Math.round(ny+hit.h/2); hit.density=hit.pixels/(hit.w*hit.h);
        }
      }
      return merged;
    }
    return blobs.sort((a, b) => b.pixels - a.pixels);
  }
  drawRectangle(rect, color, thickness = 1, fill = false) { drawRect(this.frame, Array.from(toJs(rect)), colorTuple(color), Number(thickness), Boolean(fill)); return this; }
  drawLine(line, color, thickness = 1) { const p = Array.from(toJs(line)); drawLine(this.frame, p[0],p[1],p[2],p[3],colorTuple(color),Number(thickness)); return this; }
  drawCircle(x, y, r, color, thickness = 1, fill = false) { drawCircle(this.frame, Number(x),Number(y),Number(r),colorTuple(color),Number(thickness),Boolean(fill)); return this; }
  drawCross(x, y, color, size = 5, thickness = 1) { const c=colorTuple(color); drawLine(this.frame,x-size,y,x+size,y,c,thickness); drawLine(this.frame,x,y-size,x,y+size,c,thickness); return this; }
  drawString(x, y, text, color, scale = 1) { canvasDrawText(this.frame,x,y,text,colorTuple(color),scale); return this; }
}

function frameToPlanar(taskId, imageHandle) {
  const task = kmodelManager.task(taskId);
  const frame = resizeFrame(imageHandle.frame, task.shape.inputWidth, task.shape.inputHeight);
  const { inputWidth:width, inputHeight:height, inputChannels:channels } = task.shape;
  const planar = new Uint8Array(width * height * channels);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const source = (y * width + x) * 4, pixel = y * width + x;
    if (channels === 1) planar[pixel] = Math.round(.299*frame.data[source] + .587*frame.data[source+1] + .114*frame.data[source+2]);
    else {
      planar[pixel] = frame.data[source];
      planar[width*height + pixel] = frame.data[source+1];
      planar[width*height*2 + pixel] = frame.data[source+2];
      for (let c=3; c<channels; c++) planar[width*height*c + pixel] = 0;
    }
  }
  return planar;
}

function buildBridge() {
  return {
    requestCameraFrame,
    loopCondition: async () => { if (liveCameraMode) await requestCameraFrame(); else await new Promise(resolve => setTimeout(resolve, 0)); return true; },
    sensorReset: () => { targetSize=FRAME_SIZES.QVGA; windowing=null; hmirror=false; vflip=false; brightness=0; saturation=0; contrast=0; registers={}; return true; },
    setFrameSize: value => { const v=toJs(value); targetSize = Array.isArray(v) ? v.map(Number) : (FRAME_SIZES[String(v)] || FRAME_SIZES.QVGA); },
    setWindowing: value => { windowing=Array.from(toJs(value),Number); },
    setHMirror: value => { hmirror=Boolean(value); }, setVFlip: value => { vflip=Boolean(value); },
    setBrightness: value => { brightness=Number(value)||0; }, setSaturation: value => { saturation=Number(value)||0; }, setContrast: value => { contrast=Number(value)||0; },
    readRegister: address => Number(registers[Number(address)] || 0), writeRegister: (address,value) => { registers[Number(address)]=Number(value)&255; },
    snapshot: () => {
      let frame=flipFrame(cloneFrame(sourceFrame)); if(targetSize) frame=resizeFrame(frame,targetSize[0],targetSize[1]);
      if(windowing?.length===2){const [w,h]=windowing;frame=cropFrame(frame,[(frame.width-w)/2,(frame.height-h)/2,w,h]);}
      else if(windowing?.length>=4) frame=cropFrame(frame,windowing);
      frame=adjustFrame(frame); return new RawImage(frame);
    },
    imageWidth: img => img.width(), imageHeight: img => img.height(), imageSize: img => img.size(),
    imageResize: (img,w,h) => img.resize(w,h), imageCrop: (img,roi) => img.crop(roi), imageCopy: (img,roi) => img.copy(roi),
    imageBinary: (img,t,i) => img.binary(t,i),
    imageFindBlobs: (img,t,roi,xs,ys,inv,area,pixels,merge,margin) => img.findBlobs(t,roi,xs,ys,inv,area,pixels,merge,margin),
    drawRectangle: (img,r,c,t,f) => img.drawRectangle(r,c,t,f), drawLine: (img,l,c,t) => img.drawLine(l,c,t),
    drawCircle: (img,x,y,r,c,t,f) => img.drawCircle(x,y,r,c,t,f), drawCross: (img,x,y,c,s,t) => img.drawCross(x,y,c,s,t),
    drawString: (img,x,y,s,c,scale) => img.drawString(x,y,s,c,scale),
    log: (...args) => {
      const text = args.map(String).join(' ');
      pythonOutputBuffer.push(text); if (pythonOutputBuffer.length > 120) pythonOutputBuffer.shift();
      post('log', { level:'stdout', text, time:stamp() });
    },
    uartWrite: value => { const raw=toJs(value); const bytes=typeof raw==='string' ? new TextEncoder().encode(raw) : Uint8Array.from(raw); post('log',{level:'uart',text:new TextDecoder().decode(bytes),bytes:Array.from(bytes),time:stamp()}); return bytes.length; },
    uartAny: () => uartQueue.length,
    uartRead: n => { const count=n==null||Number(n)<0?uartQueue.length:Math.min(Number(n),uartQueue.length); return Uint8Array.from(uartQueue.splice(0,count)); },
    uartReadline: () => { const idx=uartQueue.indexOf(10); const count=idx<0?uartQueue.length:idx+1; return count?Uint8Array.from(uartQueue.splice(0,count)):null; },
    gpioInit: (pin,mode,pull,value=0) => { const key=String(pin); if (!(key in gpio)) gpio[key]=Number(mode)===0 && Number(pull)===1 ? 1 : Number(Boolean(value)); post('gpio',{pin:key,value:gpio[key],mode:Number(mode)===0?'IN':'OUT'}); return gpio[key]; },
    gpioGet: pin => Number(gpio[String(pin)] || 0),
    gpioSet: (pin,value,mode='OUT') => { gpio[String(pin)]=Number(Boolean(value)); post('gpio',{pin:String(pin),value:gpio[String(pin)],mode:String(mode)}); return gpio[String(pin)]; },
    ledSet: (index,color) => { const i=Math.max(0,Number(index)|0); while(ledState.length<=i)ledState.push([0,0,0]); ledState[i]=colorTuple(color).slice(0,3); },
    ledDisplay: () => post('led',{colors:ledState}),
    kpuAvailable: () => Boolean(kmodelManager?.available()),
    kpuLoad: path => kmodelManager.load(String(path)),
    kpuDeinit: id => kmodelManager.deinit(Number(id)),
    kpuInitYolo: (id,threshold,nmsThreshold,anchorCount,anchors) => kmodelManager.initYolo(Number(id),threshold,nmsThreshold,anchorCount,toJs(anchors)),
    kpuForward: (id,img) => Array.from(kmodelManager.forward(Number(id),frameToPlanar(Number(id),img))),
    kpuRunYolo: (id,img) => kmodelManager.runYolo(Number(id),frameToPlanar(Number(id),img)),
    unsupported: name => { throw new Error(`未対応のAPIです: ${name}`); }
  };
}

const PYTHON_BOOTSTRAP = String.raw`
import sys, types, builtins
from js import bridge

class Blob:
    def __init__(self, d): self._d=d
    def x(self): return int(self._d.x)
    def y(self): return int(self._d.y)
    def w(self): return int(self._d.w)
    def h(self): return int(self._d.h)
    def cx(self): return int(self._d.cx)
    def cy(self): return int(self._d.cy)
    def pixels(self): return int(self._d.pixels)
    def area(self): return self.w()*self.h()
    def rotation(self): return float(self._d.rotation)
    def code(self): return int(self._d.code)
    def density(self): return float(self._d.density)
    def rect(self): return (self.x(),self.y(),self.w(),self.h())
    def __getitem__(self,i): return (self.x(),self.y(),self.w(),self.h(),self.pixels(),self.cx(),self.cy())[i]
    def __repr__(self): return "Blob(x={}, y={}, w={}, h={}, pixels={})".format(self.x(),self.y(),self.w(),self.h(),self.pixels())

class SimImage:
    def __init__(self, handle=None):
        if handle is None: raise RuntimeError('image.Image(path) は未対応です。sensor.snapshot() を使用してください。')
        self._h=handle
    def width(self): return int(bridge.imageWidth(self._h))
    def height(self): return int(bridge.imageHeight(self._h))
    def size(self): return int(bridge.imageSize(self._h))
    def resize(self,w,h): bridge.imageResize(self._h,w,h); return self
    def crop(self,roi): bridge.imageCrop(self._h,roi); return self
    def copy(self,roi=None): return SimImage(bridge.imageCopy(self._h,roi))
    def binary(self,thresholds,invert=False,**kwargs): bridge.imageBinary(self._h,thresholds,invert); return self
    def find_blobs(self,thresholds,roi=None,x_stride=2,y_stride=1,invert=False,area_threshold=10,pixels_threshold=10,merge=False,margin=0,**kwargs):
        result=bridge.imageFindBlobs(self._h,thresholds,roi,x_stride,y_stride,invert,area_threshold,pixels_threshold,merge,margin)
        return [Blob(x) for x in result]
    def draw_rectangle(self,rect,color=(255,255,255),thickness=1,fill=False,**kwargs): bridge.drawRectangle(self._h,rect,color,thickness,fill); return self
    def draw_line(self,line,color=(255,255,255),thickness=1,**kwargs): bridge.drawLine(self._h,line,color,thickness); return self
    def draw_circle(self,x,y,radius,color=(255,255,255),thickness=1,fill=False,**kwargs): bridge.drawCircle(self._h,x,y,radius,color,thickness,fill); return self
    def draw_cross(self,x,y,color=(255,255,255),size=5,thickness=1,**kwargs): bridge.drawCross(self._h,x,y,color,size,thickness); return self
    def draw_string(self,x,y,text,color=(255,255,255),scale=1,**kwargs): bridge.drawString(self._h,x,y,str(text),color,scale); return self

image=types.ModuleType('image'); image.Image=SimImage; sys.modules['image']=image
sensor=types.ModuleType('sensor')
sensor.RGB565='RGB565'; sensor.GRAYSCALE='GRAYSCALE'; sensor.YUV422='YUV422'
for _name in ['QQVGA','QVGA','VGA','QQQVGA','B64X64','B128X128','LCD']: setattr(sensor,_name,_name)
sensor.reset=lambda *a,**k: bridge.sensorReset()
sensor.set_pixformat=lambda *a,**k: None
sensor.set_framesize=lambda value,*a,**k: bridge.setFrameSize(value)
sensor.set_windowing=lambda value,*a,**k: bridge.setWindowing(value)
sensor.set_hmirror=lambda value=True,*a,**k: bridge.setHMirror(value)
sensor.set_vflip=lambda value=True,*a,**k: bridge.setVFlip(value)
sensor.skip_frames=lambda *a,**k: None
sensor.run=lambda *a,**k: None
sensor.set_auto_gain=lambda *a,**k: None
sensor.set_auto_exposure=lambda *a,**k: None
sensor.set_auto_whitebal=lambda *a,**k: None
sensor.set_brightness=lambda value,*a,**k: bridge.setBrightness(value)
sensor.set_saturation=lambda value,*a,**k: bridge.setSaturation(value)
sensor.set_contrast=lambda value,*a,**k: bridge.setContrast(value)
sensor.__read_reg=lambda address: int(bridge.readRegister(address))
sensor.__write_reg=lambda address,value: bridge.writeRegister(address,value)
sensor.snapshot=lambda: SimImage(bridge.snapshot())
async def _snapshot_async():
    await bridge.requestCameraFrame()
    return sensor.snapshot()
sensor.snapshot_async=_snapshot_async
sys.modules['sensor']=sensor

class Clock:
    def __init__(self):
        self._last=_time.time(); self._fps=0
    def tick(self):
        now=_time.time(); delta=now-self._last; self._last=now; self._fps=(1/delta if delta else 0); return delta
    def fps(self): return self._fps
import time as _time
time_mod=types.ModuleType('time')
time_mod.sleep=_time.sleep; time_mod.sleep_ms=lambda ms:_time.sleep(ms/1000); time_mod.ticks_ms=lambda:int(_time.time()*1000); time_mod.clock=Clock
sys.modules['time']=time_mod

class UART:
    UART1=1; UART2=2; UART3=3
    def __init__(self,uart=1,baudrate=115200,*args,**kwargs): self.uart=uart; self.baudrate=baudrate
    def init(self,*args,**kwargs): return None
    def any(self): return int(bridge.uartAny())
    def read(self,n=-1):
        result=bridge.uartRead(n)
        return bytes(result) if result is not None else None
    def readchar(self):
        data=self.read(1); return data[0] if data else -1
    def readline(self):
        result=bridge.uartReadline(); return bytes(result) if result is not None else None
    def write(self,data):
        if isinstance(data,str): data=data.encode('utf-8')
        return int(bridge.uartWrite(list(data)))
    def deinit(self): return None
machine=types.ModuleType('machine'); machine.UART=UART; sys.modules['machine']=machine

class DynamicConstants:
    def __getattr__(self,name): return name
class FM:
    def __init__(self): self.fpioa=DynamicConstants()
    def register(self,*args,**kwargs): return None
    def unregister(self,*args,**kwargs): return None
fm=FM(); fpioa_manager=types.ModuleType('fpioa_manager'); fpioa_manager.fm=fm; sys.modules['fpioa_manager']=fpioa_manager
board=types.ModuleType('board'); board.board_info=DynamicConstants(); sys.modules['board']=board

class GPIO:
    IN=0; OUT=1; PULL_NONE=0; PULL_UP=1; PULL_DOWN=2
    GPIO0='GPIO0'; GPIO1='GPIO1'; GPIO2='GPIO2'; GPIOHS0='GPIOHS0'; GPIOHS1='GPIOHS1'; GPIOHS2='GPIOHS2'
    def __init__(self,pin,mode=OUT,pull=PULL_NONE,value=0,*args,**kwargs):
        self.pin=pin; self.mode=mode
        bridge.gpioInit(str(pin),mode,pull,value)
    def value(self,value=None):
        if value is None: return int(bridge.gpioGet(str(self.pin)))
        return int(bridge.gpioSet(str(self.pin),value,'IN' if self.mode==self.IN else 'OUT'))
Maix=types.ModuleType('Maix'); Maix.GPIO=GPIO; sys.modules['Maix']=Maix

class ws2812:
    def __init__(self,pin,led_num=1,*args,**kwargs): self.pin=pin; self.led_num=led_num
    def set_led(self,index,color): bridge.ledSet(index,color)
    def display(self): bridge.ledDisplay()
modules=types.ModuleType('modules'); modules.ws2812=ws2812; sys.modules['modules']=modules

class KPUResult:
    def __init__(self,values): self.values=list(values)
    def __len__(self): return len(self.values)
    def __getitem__(self,i): return self.values[i]
    def tolist(self): return list(self.values)
class Detection:
    def __init__(self,d): self._d=d
    def x(self): return int(self._d.x)
    def y(self): return int(self._d.y)
    def w(self): return int(self._d.w)
    def h(self): return int(self._d.h)
    def value(self): return float(self._d.value)
    def classid(self): return int(self._d.classId)
    def rect(self): return (self.x(),self.y(),self.w(),self.h())
    def __getitem__(self,i): return (self.x(),self.y(),self.w(),self.h(),self.value(),self.classid())[i]
    def __repr__(self): return "Detection(x={}, y={}, w={}, h={}, value={:.3f}, classid={})".format(self.x(),self.y(),self.w(),self.h(),self.value(),self.classid())
class KPUTask:
    def __init__(self,path): self.path=path; self._id=int(bridge.kpuLoad(path))
def _require_kpu():
    if not bridge.kpuAvailable(): raise RuntimeError('プロジェクトに.kmodelファイルがありません。FILESへ追加してください。')
kpu=types.ModuleType('KPU')
kpu.load=lambda path,*a,**k: KPUTask(path)
kpu.deinit=lambda task,*a,**k: bridge.kpuDeinit(task._id)
def _init_yolo(task,threshold,nms_value,anchor_num,anchors,*args,**kwargs):
    _require_kpu(); return bridge.kpuInitYolo(task._id,threshold,nms_value,anchor_num,anchors)
kpu.init_yolo2=_init_yolo
def _forward(task,img,*args,**kwargs): _require_kpu(); return KPUResult(bridge.kpuForward(task._id,img._h))
def _run_yolo(task,img,*args,**kwargs):
    _require_kpu(); result=[Detection(d) for d in bridge.kpuRunYolo(task._id,img._h)]; return result if result else None
kpu.forward=_forward; kpu.run_yolo2=_run_yolo; kpu.softmax=lambda values: KPUResult(values)
sys.modules['KPU']=kpu

_real_print=builtins.print
def sim_print(*args,sep=' ',end='\n',**kwargs): bridge.log(sep.join(str(x) for x in args)+end.rstrip('\n'))
builtins.print=sim_print
`;

async function ensurePython() {
  if (pyodide) return pyodide;
  post('status', { phase: 'loading-python', text: 'Python環境を読み込んでいます' });
  const { loadPyodide } = await import(/* @vite-ignore */ new URL('/pyodide/pyodide.mjs', self.location.href).href);
  pyodide = await loadPyodide({ indexURL: new URL('/pyodide/', self.location.href).href });
  return pyodide;
}

self.onmessage = async event => {
  const payload = event.data;
  if (payload?.type === 'uart-append') {
    uartQueue.push(...new Uint8Array(payload.data || new ArrayBuffer(0)));
    return;
  }
  if (payload?.type === 'gpio-update') {
    gpio[String(payload.pin)] = Number(Boolean(payload.value));
    return;
  }
  if (payload?.type === 'camera-frame') {
    const pending = cameraFrameRequests.get(payload.requestId); if (!pending) return;
    cameraFrameRequests.delete(payload.requestId);
    sourceFrame = { width:payload.image.width, height:payload.image.height, data:new Uint8ClampedArray(payload.image.data) };
    pending.resolve(true); return;
  }
  if (payload?.type === 'camera-frame-error') {
    const pending = cameraFrameRequests.get(payload.requestId); if (!pending) return;
    cameraFrameRequests.delete(payload.requestId); pending.reject(new Error(payload.message || 'カメラフレームを取得できませんでした。')); return;
  }
  if (payload?.type !== 'run') return;
  let sourceMappings = [];
  try {
    pythonOutputBuffer = [];
    liveCameraMode = Boolean(payload.cameraMode);
    sourceFrame = { width: payload.image.width, height: payload.image.height, data: new Uint8ClampedArray(payload.image.data) };
    latestFrame = cloneFrame(sourceFrame); targetSize = FRAME_SIZES.QVGA; windowing=null; hmirror=false; vflip=false; brightness=0; saturation=0; contrast=0; registers={};
    uartQueue = Array.from(new Uint8Array(payload.uart || new ArrayBuffer(0)));
    gpio = { ...(payload.gpio || {}) }; ledState=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
    if (payload.models?.length) post('status', { phase:'loading-kmodel', text:'K210 kmodelランタイムを読み込んでいます' });
    kmodelManager = await KmodelManager.create(payload.models || []);
    const runtime = await ensurePython();
    self.bridge = buildBridge(); runtime.globals.set('bridge', self.bridge);
    await runtime.runPythonAsync(PYTHON_BOOTSTRAP);
    const workspace = `/unitv-project-${crypto.randomUUID()}`;
    runtime.FS.mkdirTree(workspace);
    for (const file of payload.files || []) {
      const path = String(file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!path.endsWith('.py') || path.split('/').some(part => !part || part === '.' || part === '..')) continue;
      const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (directory) runtime.FS.mkdirTree(`${workspace}/${directory}`);
      runtime.FS.writeFile(`${workspace}/${path}`, String(file.code || ''), { encoding: 'utf8' });
      const moduleName = path.replace(/\.py$/, '').replace(/\//g, '.').replace(/\.__init__$/, '');
      await runtime.runPythonAsync(`import sys\nsys.modules.pop(${JSON.stringify(moduleName)}, None)`);
    }
    const entryDirectory = String(payload.filename || '').replace(/\\/g, '/').includes('/') ? String(payload.filename).replace(/\\/g, '/').slice(0, String(payload.filename).replace(/\\/g, '/').lastIndexOf('/')) : '';
    await runtime.runPythonAsync(`import os, sys, importlib\nos.chdir(${JSON.stringify(workspace)})\nsys.path.insert(0, ${JSON.stringify(workspace)})\nsys.path.insert(0, ${JSON.stringify(`${workspace}/${entryDirectory}`)})\nimportlib.invalidate_caches()`);
    post('status', { phase: 'executing', text: liveCameraMode ? 'カメラフレームを連続処理しています' : 'コードを実行しています', liveCamera:liveCameraMode, kmodel:Boolean(payload.models?.length) });
    const { prepared, limited, mappings } = prepareUnitVCode(payload.code, liveCameraMode);
    sourceMappings = mappings;
    if (limited) post('log',{level:'system',text:'固定画像モードのためトップレベルの無限ループを1フレームだけ実行します。',time:stamp()});
    if (liveCameraMode) post('log',{level:'system',text:'カメラモード: トップレベルの無限ループを維持し、ループごとに新しいフレームを取得します。停止ボタンで終了できます。',time:stamp()});
    await runtime.runPythonAsync(prepared, { filename: payload.filename || 'main.py' });
    const frame = latestFrame || sourceFrame;
    liveCameraMode = false;
    post('result', { width:frame.width,height:frame.height,data:frame.data.buffer,gpio,leds:ledState }, [frame.data.buffer]);
  } catch (error) {
    liveCameraMode = false;
    const message = String(error?.message || error);
    const stack = String(error?.stack || '');
    const capturedOutput = pythonOutputBuffer.join('\n');
    const diagnosticSource = capturedOutput.includes('Traceback') ? capturedOutput : (message === 'PythonError' && stack ? stack : message);
    let details = parsePythonRuntimeError(diagnosticSource, stack);
    if (details.filename === String(payload.filename || '').replace(/\\/g, '/')) details = mapPreparedError(details, sourceMappings);
    post('error', { message:`${details.type}: ${details.reason}`, stack, error:details });
  }
};
