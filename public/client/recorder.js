const TYPES = [
    "video/mp4;codecs=avc1.640033",
    "video/mp4;codecs=avc1.64002A",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/mp4",
    "video/webm",
];

const BPS_1080 = 20e6;
const PX_1080 = 1920 * 1080;

function pickType() {
    for (const t of TYPES) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { }
    }
    return "";
}

function bitrateFor(width, height, fps, maxBps) {
    const hi = maxBps || 60e6, lo = Math.min(8e6, hi);
    const want = BPS_1080 * (width * height) / PX_1080 * Math.max(0.5, fps / 60);
    return Math.round(Math.min(hi, Math.max(lo, want)));
}

function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class AdvancedRecorder extends MediaRecorder {
    constructor(canvas, framePerSecond = 60, opts = {}) {
        const mimeType = pickType();
        const bps = bitrateFor(canvas.width, canvas.height, framePerSecond, opts.maxBps);
        const stream = canvas.captureStream(framePerSecond);
        const o = { videoBitsPerSecond: bps };
        if (mimeType) o.mimeType = mimeType;
        super(stream, o);
        const track = stream.getVideoTracks()[0];
        const set = track && track.getSettings ? track.getSettings() : {};
        this.info = { mimeType: this.mimeType || mimeType, videoBitsPerSecond: this.videoBitsPerSecond || bps, width: canvas.width, height: canvas.height, fps: framePerSecond, trackWidth: set.width || 0, trackHeight: set.height || 0, trackFps: set.frameRate || 0 };
        this.onSaved = opts.onSaved || null;
        this.startedAt = 0;
        this.chunks = [];
        this.addEventListener("dataavailable", ({ data }) => {
            if (data && data.size) this.chunks.push(data);
        });
        this.addEventListener("stop", () => this.save());
    }
    start() { this.startedAt = performance.now(); super.start(1000); }
    save() {
        const type = (this.mimeType || "video/webm").split(";")[0];
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        if (!blob.size) return;
        const name = `corez_${stamp()}.${type === "video/mp4" ? "mp4" : "webm"}`;
        if (this.onSaved) { this.onSaved(blob, name); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.download = name;
        a.href = url;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10_000);
    }
}

export { AdvancedRecorder, pickType, bitrateFor };
