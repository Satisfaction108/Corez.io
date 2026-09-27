// In-game video recorder (the record key, see canvas.js).
//
// The file is saved from the recorder's own "stop" event: the last chunk only
// arrives after stop(), so saving on a timer gives empty or truncated files.
// The extension follows the real container (Chrome and Safari give H.264 MP4,
// Firefox gives WebM); the bitrate scales with the canvas size.
const TYPES = [
    "video/mp4;codecs=avc1.64002A",   // H.264 High: opens everywhere
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
];

function pickType() {
    for (const t of TYPES) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* */ }
    }
    return "";
}

function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class AdvancedRecorder extends MediaRecorder {
    constructor(canvas, framePerSecond = 60) {
        const mimeType = pickType();
        // ~0.12 bits per pixel per frame, 8-24 Mbps: sharp text and rock edges
        const bps = Math.round(Math.min(24e6, Math.max(8e6, canvas.width * canvas.height * framePerSecond * 0.12)));
        super(canvas.captureStream(framePerSecond), mimeType ? { mimeType, videoBitsPerSecond: bps } : { videoBitsPerSecond: bps });
        this.chunks = [];
        this.addEventListener("dataavailable", ({ data }) => {
            if (data && data.size) this.chunks.push(data);
        });
        this.addEventListener("stop", () => this.save());
    }
    // 1 s chunks keep memory flat on long recordings
    start() { super.start(1000); }
    save() {
        const type = (this.mimeType || "video/webm").split(";")[0];
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        if (!blob.size) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.download = `corez_${stamp()}.${type === "video/mp4" ? "mp4" : "webm"}`;
        a.href = url;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10_000);
    }
}

export { AdvancedRecorder };
