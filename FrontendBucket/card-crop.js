/**
 * Folio card cropper — detect a visiting-card quad, perspective-correct it,
 * and (when needed) let the user drag the four corners before save.
 */
(function (global) {
    const MAX_DETECT = 480;
    const MAX_OUTPUT = 1600;

    function dist(a, b) {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function orderCorners(pts) {
        const sorted = pts.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        const top = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
        const bottom = sorted.slice(2).sort((a, b) => a[0] - b[0]);
        return [top[0], top[1], bottom[1], bottom[0]];
    }

    function quadArea(q) {
        let area = 0;
        for (let i = 0; i < 4; i += 1) {
            const j = (i + 1) % 4;
            area += q[i][0] * q[j][1] - q[j][0] * q[i][1];
        }
        return Math.abs(area) / 2;
    }

    function scaleQuad(q, s) {
        return q.map((p) => [p[0] * s, p[1] * s]);
    }

    function insetRect(w, h, pad) {
        const x = w * pad;
        const y = h * pad;
        return orderCorners([
            [x, y],
            [w - x, y],
            [w - x, h - y],
            [x, h - y],
        ]);
    }

    function centerCardQuad(w, h) {
        const target = 1.65;
        let cropW;
        let cropH;
        if (w / h > target) {
            cropH = h * 0.62;
            cropW = cropH * target;
        } else {
            cropW = w * 0.78;
            cropH = cropW / target;
        }
        if (cropW > w * 0.94) {
            cropW = w * 0.94;
            cropH = cropW / target;
        }
        if (cropH > h * 0.7) {
            cropH = h * 0.7;
            cropW = cropH * target;
        }
        const x = (w - cropW) / 2;
        const y = (h - cropH) / 2;
        return orderCorners([
            [x, y],
            [x + cropW, y],
            [x + cropW, y + cropH],
            [x, y + cropH],
        ]);
    }

    function canvasFromImage(source) {
        if (source && source.tagName === 'CANVAS') {
            const copy = document.createElement('canvas');
            copy.width = source.width;
            copy.height = source.height;
            copy.getContext('2d').drawImage(source, 0, 0);
            return copy;
        }
        const canvas = document.createElement('canvas');
        const w = source.naturalWidth || source.videoWidth || source.width;
        const h = source.naturalHeight || source.videoHeight || source.height;
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    function loadCanvas(src) {
        return new Promise((resolve, reject) => {
            if (!src) {
                reject(new Error('No image'));
                return;
            }
            if (src.tagName === 'CANVAS') {
                resolve(canvasFromImage(src));
                return;
            }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(canvasFromImage(img));
            img.onerror = () => reject(new Error('Could not load image'));
            img.src = typeof src === 'string' ? src : '';
        });
    }

    function downsample(canvas, maxSide) {
        const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
        if (scale >= 0.999) return { canvas, scale: 1 };
        const out = document.createElement('canvas');
        out.width = Math.max(8, Math.round(canvas.width * scale));
        out.height = Math.max(8, Math.round(canvas.height * scale));
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(canvas, 0, 0, out.width, out.height);
        return { canvas: out, scale };
    }

    function readLumaSat(canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const luma = new Uint8Array(width * height);
        const sat = new Uint8Array(width * height);
        for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            luma[p] = (r * 299 + g * 587 + b * 114) / 1000;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            sat[p] = max ? Math.round(((max - min) / max) * 255) : 0;
        }
        return { luma, sat, width, height, data };
    }

    function median(values) {
        const copy = values.slice().sort((a, b) => a - b);
        return copy[copy.length >> 1];
    }

    function borderStats(luma, w, h) {
        const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
        const samples = [];
        for (let x = 0; x < w; x += 2) {
            for (let t = 0; t < band; t += 1) {
                samples.push(luma[t * w + x], luma[(h - 1 - t) * w + x]);
            }
        }
        for (let y = 0; y < h; y += 2) {
            for (let t = 0; t < band; t += 1) {
                samples.push(luma[y * w + t], luma[y * w + (w - 1 - t)]);
            }
        }
        return { bg: median(samples), band };
    }

    function morphClose(mask, w, h, radius) {
        const dil = new Uint8Array(mask.length);
        const out = new Uint8Array(mask.length);
        const r = radius;
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                let on = 0;
                for (let dy = -r; dy <= r && !on; dy += 1) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -r; dx <= r; dx += 1) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        if (mask[yy * w + xx]) {
                            on = 1;
                            break;
                        }
                    }
                }
                dil[y * w + x] = on;
            }
        }
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                let off = 0;
                for (let dy = -r; dy <= r && !off; dy += 1) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -r; dx <= r; dx += 1) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        if (!dil[yy * w + xx]) {
                            off = 1;
                            break;
                        }
                    }
                }
                out[y * w + x] = off ? 0 : 1;
            }
        }
        return out;
    }

    function largestComponent(mask, w, h) {
        const seen = new Uint8Array(mask.length);
        let best = null;
        const stack = [];
        for (let i = 0; i < mask.length; i += 1) {
            if (!mask[i] || seen[i]) continue;
            stack.length = 0;
            stack.push(i);
            seen[i] = 1;
            const pixels = [];
            let minX = w;
            let minY = h;
            let maxX = 0;
            let maxY = 0;
            while (stack.length) {
                const idx = stack.pop();
                const x = idx % w;
                const y = (idx - x) / w;
                pixels.push(idx);
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
                const neighbors = [idx - 1, idx + 1, idx - w, idx + w];
                for (let n = 0; n < 4; n += 1) {
                    const ni = neighbors[n];
                    if (ni < 0 || ni >= mask.length || seen[ni] || !mask[ni]) continue;
                    const nx = ni % w;
                    if (Math.abs(nx - x) + Math.abs(((ni - nx) / w) - y) !== 1) continue;
                    seen[ni] = 1;
                    stack.push(ni);
                }
            }
            if (!best || pixels.length > best.pixels.length) {
                best = { pixels, minX, minY, maxX, maxY };
            }
        }
        return best;
    }

    function minAreaRect(pixels, w) {
        const pts = [];
        const step = Math.max(1, Math.floor(pixels.length / 1800));
        for (let i = 0; i < pixels.length; i += step) {
            const idx = pixels[i];
            pts.push([idx % w, (idx - (idx % w)) / w]);
        }
        if (pts.length < 8) return null;
        let best = null;
        for (let deg = 0; deg < 90; deg += 3) {
            const rad = (deg * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < pts.length; i += 1) {
                const x = pts[i][0];
                const y = pts[i][1];
                const rx = x * c + y * s;
                const ry = -x * s + y * c;
                if (rx < minX) minX = rx;
                if (rx > maxX) maxX = rx;
                if (ry < minY) minY = ry;
                if (ry > maxY) maxY = ry;
            }
            const area = (maxX - minX) * (maxY - minY);
            if (!best || area < best.area) best = { area, minX, maxX, minY, maxY, c, s };
        }
        const corners = [
            [best.minX, best.minY],
            [best.maxX, best.minY],
            [best.maxX, best.maxY],
            [best.minX, best.maxY],
        ].map(([rx, ry]) => [rx * best.c - ry * best.s, rx * best.s + ry * best.c]);
        return orderCorners(corners);
    }

    function scoreQuad(q, w, h, luma) {
        if (!q || q.length !== 4) return 0;
        const area = quadArea(q);
        const coverage = area / (w * h);
        if (coverage < 0.06 || coverage > 0.9) return 0;
        const w1 = dist(q[0], q[1]);
        const w2 = dist(q[3], q[2]);
        const h1 = dist(q[0], q[3]);
        const h2 = dist(q[1], q[2]);
        const width = (w1 + w2) / 2;
        const height = (h1 + h2) / 2;
        if (width < 24 || height < 16) return 0;
        const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
        if (aspect < 1.15 || aspect > 2.6) return 0;
        const widthBalance = Math.min(w1, w2) / Math.max(w1, w2);
        const heightBalance = Math.min(h1, h2) / Math.max(h1, h2);
        const rectangularity = (widthBalance + heightBalance) / 2;
        const cardAspect = Math.min(Math.abs(aspect - 1.75), Math.abs(aspect - 1.585), Math.abs(aspect - 1.5));
        const aspectScore = Math.max(0, 1 - cardAspect / 0.85);
        let contrast = 0.5;
        if (luma) {
            const samples = [];
            for (let t = 0.2; t <= 0.8; t += 0.2) {
                for (let u = 0.2; u <= 0.8; u += 0.2) {
                    const x = Math.round((1 - t) * ((1 - u) * q[0][0] + u * q[1][0]) + t * ((1 - u) * q[3][0] + u * q[2][0]));
                    const y = Math.round((1 - t) * ((1 - u) * q[0][1] + u * q[1][1]) + t * ((1 - u) * q[3][1] + u * q[2][1]));
                    if (x >= 0 && y >= 0 && x < w && y < h) samples.push(luma[y * w + x]);
                }
            }
            if (samples.length) {
                const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
                const { bg } = borderStats(luma, w, h);
                contrast = Math.min(1, Math.abs(avg - bg) / 70);
            }
        }
        const coverageScore = coverage < 0.82
            ? Math.max(0, 1 - Math.abs(coverage - 0.42) / 0.55)
            : Math.max(0, 1 - (coverage - 0.82) / 0.12);
        return (0.35 * coverageScore + 0.3 * rectangularity + 0.2 * aspectScore + 0.15 * contrast);
    }

    function detectFromMask(mask, w, h, luma) {
        const closed = morphClose(mask, w, h, 2);
        const blob = largestComponent(closed, w, h);
        if (!blob || blob.pixels.length < w * h * 0.05) return null;
        const quad = minAreaRect(blob.pixels, w);
        if (!quad) return null;
        const score = scoreQuad(quad, w, h, luma);
        return score > 0.22 ? { quad, score } : null;
    }

    function removeBorderConnected(mask, w, h) {
        const out = new Uint8Array(mask);
        const stack = [];
        const push = (idx) => {
            if (idx < 0 || idx >= out.length || !out[idx]) return;
            out[idx] = 0;
            stack.push(idx);
        };
        for (let x = 0; x < w; x += 1) {
            push(x);
            push((h - 1) * w + x);
        }
        for (let y = 0; y < h; y += 1) {
            push(y * w);
            push(y * w + (w - 1));
        }
        while (stack.length) {
            const idx = stack.pop();
            const x = idx % w;
            const y = (idx - x) / w;
            const neighbors = [idx - 1, idx + 1, idx - w, idx + w];
            for (let n = 0; n < 4; n += 1) {
                const ni = neighbors[n];
                if (ni < 0 || ni >= out.length || !out[ni]) continue;
                const nx = ni % w;
                if (Math.abs(nx - x) + Math.abs(((ni - nx) / w) - y) !== 1) continue;
                out[ni] = 0;
                stack.push(ni);
            }
        }
        return out;
    }

    function insetQuad(q, frac) {
        const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
        const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        return orderCorners(q.map(([x, y]) => [
            x + (cx - x) * frac,
            y + (cy - y) * frac,
        ]));
    }

    function detectPaperIsland(luma, sat, w, h) {
        const paper = new Uint8Array(luma.length);
        for (let i = 0; i < luma.length; i += 1) {
            if ((luma[i] >= 150 && sat[i] <= 58) || (luma[i] >= 175 && sat[i] <= 88)) {
                paper[i] = 1;
            }
        }
        const island = removeBorderConnected(paper, w, h);
        const closed = morphClose(island, w, h, 2);
        const blob = largestComponent(closed, w, h);
        if (!blob || blob.pixels.length < w * h * 0.08 || blob.pixels.length > w * h * 0.82) {
            return null;
        }
        const quad = minAreaRect(blob.pixels, w);
        if (!quad) return null;
        const tightened = insetQuad(quad, 0.028);
        const score = scoreQuad(tightened, w, h, luma) + 0.12;
        return score > 0.28 ? { quad: tightened, score, method: 'paper' } : null;
    }

    function detectQuad(canvas) {
        const { luma, sat, width: w, height: h } = readLumaSat(canvas);
        const { bg } = borderStats(luma, w, h);
        const candidates = [];

        const paper = detectPaperIsland(luma, sat, w, h);
        if (paper) candidates.push(paper);

        const bright = new Uint8Array(luma.length);
        const dark = new Uint8Array(luma.length);
        const contrast = new Uint8Array(luma.length);
        for (let i = 0; i < luma.length; i += 1) {
            const d = Math.abs(luma[i] - bg);
            if (d > 28) contrast[i] = 1;
            if (luma[i] > bg + 22 && sat[i] < 90) bright[i] = 1;
            if (luma[i] < bg - 28) dark[i] = 1;
        }
        [bright, dark, contrast].forEach((mask) => {
            const found = detectFromMask(mask, w, h, luma);
            if (found) candidates.push(found);
        });

        candidates.sort((a, b) => b.score - a.score);
        if (candidates[0]) {
            return {
                quad: candidates[0].quad,
                score: candidates[0].score,
                method: candidates[0].method || 'blob',
            };
        }

        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        let count = 0;
        for (let y = 2; y < h - 2; y += 1) {
            for (let x = 2; x < w - 2; x += 1) {
                if (Math.abs(luma[y * w + x] - bg) > 26) {
                    count += 1;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        const bw = maxX - minX;
        const bh = maxY - minY;
        const coverage = (bw * bh) / (w * h);
        if (count > 40 && coverage > 0.08 && coverage < 0.82 && bw > w * 0.28 && bh > h * 0.16) {
            const padX = bw * 0.03;
            const padY = bh * 0.04;
            const quad = orderCorners([
                [minX - padX, minY - padY],
                [maxX + padX, minY - padY],
                [maxX + padX, maxY + padY],
                [minX - padX, maxY + padY],
            ]);
            const score = scoreQuad(quad, w, h, luma);
            if (score > 0.18) return { quad, score, method: 'aabb' };
        }

        return { quad: centerCardQuad(w, h), score: 0.12, method: 'fallback' };
    }

    function solveLinear(A, b) {
        const n = b.length;
        const M = A.map((row, i) => row.concat([b[i]]));
        for (let i = 0; i < n; i += 1) {
            let max = i;
            for (let r = i + 1; r < n; r += 1) {
                if (Math.abs(M[r][i]) > Math.abs(M[max][i])) max = r;
            }
            const tmp = M[i];
            M[i] = M[max];
            M[max] = tmp;
            const pivot = M[i][i];
            if (Math.abs(pivot) < 1e-12) return null;
            for (let c = i; c <= n; c += 1) M[i][c] /= pivot;
            for (let r = 0; r < n; r += 1) {
                if (r === i) continue;
                const f = M[r][i];
                for (let c = i; c <= n; c += 1) M[r][c] -= f * M[i][c];
            }
        }
        return M.map((row) => row[n]);
    }

    function homography(src, dst) {
        const A = [];
        const b = [];
        for (let i = 0; i < 4; i += 1) {
            const [x, y] = src[i];
            const [u, v] = dst[i];
            A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
            b.push(u);
            A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
            b.push(v);
        }
        const h = solveLinear(A, b);
        if (!h) return null;
        return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    }

    function applyH(H, x, y) {
        const z = H[6] * x + H[7] * y + H[8];
        return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
    }

    function warpQuad(srcCanvas, quad, maxSide) {
        const q = orderCorners(quad);
        const width = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
        const height = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
        const scale = Math.min(1, (maxSide || MAX_OUTPUT) / Math.max(width, height));
        const outW = Math.max(32, Math.round(width * scale));
        const outH = Math.max(20, Math.round(height * scale));
        const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
        const H = homography(dst, q);
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext('2d');
        if (!H) {
            const x = Math.max(0, Math.min(q[0][0], q[1][0], q[2][0], q[3][0]));
            const y = Math.max(0, Math.min(q[0][1], q[1][1], q[2][1], q[3][1]));
            const rw = Math.min(srcCanvas.width - x, Math.max(q[0][0], q[1][0], q[2][0], q[3][0]) - x);
            const rh = Math.min(srcCanvas.height - y, Math.max(q[0][1], q[1][1], q[2][1], q[3][1]) - y);
            ctx.drawImage(srcCanvas, x, y, rw, rh, 0, 0, outW, outH);
            return out;
        }
        const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
        const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        const dest = ctx.createImageData(outW, outH);
        const sw = srcCanvas.width;
        const sh = srcCanvas.height;
        const sData = srcData.data;
        const dData = dest.data;
        for (let y = 0; y < outH; y += 1) {
            for (let x = 0; x < outW; x += 1) {
                const [sx, sy] = applyH(H, x + 0.5, y + 0.5);
                const x0 = Math.floor(sx);
                const y0 = Math.floor(sy);
                const x1 = x0 + 1;
                const y1 = y0 + 1;
                const di = (y * outW + x) * 4;
                if (x0 < 0 || y0 < 0 || x1 >= sw || y1 >= sh) {
                    dData[di + 3] = 255;
                    continue;
                }
                const fx = sx - x0;
                const fy = sy - y0;
                const i00 = (y0 * sw + x0) * 4;
                const i10 = (y0 * sw + x1) * 4;
                const i01 = (y1 * sw + x0) * 4;
                const i11 = (y1 * sw + x1) * 4;
                for (let c = 0; c < 3; c += 1) {
                    const v =
                        sData[i00 + c] * (1 - fx) * (1 - fy) +
                        sData[i10 + c] * fx * (1 - fy) +
                        sData[i01 + c] * (1 - fx) * fy +
                        sData[i11 + c] * fx * fy;
                    dData[di + c] = v;
                }
                dData[di + 3] = 255;
            }
        }
        ctx.putImageData(dest, 0, 0);
        return out;
    }

    function toJpeg(canvas, quality) {
        return canvas.toDataURL('image/jpeg', quality == null ? 0.92 : quality);
    }

    function toFile(canvas, name, quality) {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                resolve(new File([blob], name || `folio-card-${Date.now()}.jpg`, { type: 'image/jpeg' }));
            }, 'image/jpeg', quality == null ? 0.92 : quality);
        });
    }

    function autoCrop(source) {
        const src = canvasFromImage(source);
        const { canvas: small, scale } = downsample(src, MAX_DETECT);
        const detected = detectQuad(small);
        const quad = scaleQuad(detected.quad, 1 / scale);
        const coverage = quadArea(detected.quad) / (small.width * small.height);
        const alreadyTight = detected.method === 'fallback' || coverage > 0.9;
        if (alreadyTight) {
            return {
                source: src,
                canvas: src,
                quad: insetRect(src.width, src.height, 0),
                confidence: detected.score,
                method: detected.method,
                dataUrl: toJpeg(src),
                needsAdjust: false,
                changed: false,
            };
        }
        const cropped = warpQuad(src, quad, MAX_OUTPUT);
        return {
            source: src,
            canvas: cropped,
            quad,
            confidence: detected.score,
            method: detected.method,
            dataUrl: toJpeg(cropped),
            needsAdjust: detected.score < 0.34,
            changed: true,
        };
    }

    function ensureOverlay() {
        let el = document.getElementById('folioCropper');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'folioCropper';
        el.className = 'folio-cropper hidden';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `
            <div class="folio-cropper__sheet">
                <header class="folio-cropper__top">
                    <p class="folio-cropper__kicker" id="folioCropKicker">Scan</p>
                    <h2 id="folioCropTitle">Confirm the card</h2>
                    <p class="folio-cropper__hint">Drag the corners so the box hugs only the visiting card.</p>
                </header>
                <div class="folio-cropper__stage" id="folioCropStage">
                    <canvas id="folioCropCanvas"></canvas>
                    <svg id="folioCropSvg" class="folio-cropper__svg"></svg>
                </div>
                <div class="folio-cropper__preview-wrap">
                    <p>Cropped preview</p>
                    <canvas id="folioCropPreview" class="folio-cropper__preview"></canvas>
                </div>
                <div class="folio-cropper__actions">
                    <button type="button" class="chip-btn" id="folioCropRetake">Retake</button>
                    <button type="button" class="chip-btn" id="folioCropAuto">Auto</button>
                    <button type="button" class="btn-luxury" id="folioCropConfirm"><span>Confirm</span></button>
                </div>
            </div>
        `;
        document.body.appendChild(el);
        return el;
    }

    function confirmCrop(source, options) {
        const opts = options || {};
        const overlay = ensureOverlay();
        const src = canvasFromImage(source);
        let result = autoCrop(src);
        let quad = (opts.quad || result.quad).map((p) => p.slice());

        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('cropper-open');
        document.getElementById('folioCropTitle').textContent = opts.title || 'Confirm the card';
        document.getElementById('folioCropKicker').textContent = opts.kicker || 'Front side';

        const view = document.getElementById('folioCropCanvas');
        const svg = document.getElementById('folioCropSvg');
        const preview = document.getElementById('folioCropPreview');
        const stage = document.getElementById('folioCropStage');

        const maxView = Math.min(520, Math.max(280, stage.clientWidth || 360));
        const vScale = Math.min(maxView / src.width, 420 / src.height, 1);
        view.width = Math.round(src.width * vScale);
        view.height = Math.round(src.height * vScale);
        view.getContext('2d').drawImage(src, 0, 0, view.width, view.height);
        svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
        svg.style.width = `${view.width}px`;
        svg.style.height = `${view.height}px`;

        const toView = (p) => [p[0] * vScale, p[1] * vScale];
        const fromView = (p) => [p[0] / vScale, p[1] / vScale];

        function renderPreview() {
            const cropped = warpQuad(src, quad, 900);
            preview.width = cropped.width;
            preview.height = cropped.height;
            preview.getContext('2d').drawImage(cropped, 0, 0);
        }

        function renderQuad() {
            const pts = quad.map(toView);
            svg.innerHTML = `
                <polygon points="${pts.map((p) => p.join(',')).join(' ')}" class="folio-cropper__poly"></polygon>
                ${pts.map((p, i) => `<circle data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="14" class="folio-cropper__handle"></circle>`).join('')}
            `;
            renderPreview();
        }

        let drag = null;
        const onMove = (event) => {
            if (drag == null) return;
            const rect = svg.getBoundingClientRect();
            const x = clamp((event.touches ? event.touches[0].clientX : event.clientX) - rect.left, 0, rect.width);
            const y = clamp((event.touches ? event.touches[0].clientY : event.clientY) - rect.top, 0, rect.height);
            quad[drag] = fromView([x, y]);
            renderQuad();
        };
        const onUp = () => { drag = null; };
        svg.onpointerdown = (event) => {
            const handle = event.target.closest('.folio-cropper__handle');
            if (!handle) return;
            drag = Number(handle.dataset.i);
            svg.setPointerCapture(event.pointerId);
            event.preventDefault();
        };
        svg.onpointermove = onMove;
        svg.onpointerup = onUp;
        svg.onpointercancel = onUp;

        renderQuad();

        return new Promise((resolve) => {
            const finish = (value) => {
                overlay.classList.add('hidden');
                overlay.setAttribute('aria-hidden', 'true');
                document.body.classList.remove('cropper-open');
                resolve(value);
            };
            document.getElementById('folioCropRetake').onclick = () => finish(null);
            document.getElementById('folioCropAuto').onclick = () => {
                result = autoCrop(src);
                quad = result.quad.map((p) => p.slice());
                renderQuad();
            };
            document.getElementById('folioCropConfirm').onclick = async () => {
                const cropped = warpQuad(src, orderCorners(quad), MAX_OUTPUT);
                const dataUrl = toJpeg(cropped);
                const file = await toFile(cropped, opts.fileName || `folio-card-${Date.now()}.jpg`);
                finish({ canvas: cropped, dataUrl, file, quad: orderCorners(quad) });
            };
        });
    }

    function needsRecrop(canvas) {
        if (!canvas) return false;
        const small = downsample(canvas, 240).canvas;
        const found = detectQuad(small);
        if (found.method === 'paper') return true;
        const coverage = quadArea(found.quad) / (small.width * small.height);
        if (found.method === 'fallback') return coverage < 0.9;
        return coverage < 0.88 || found.score < 0.28;
    }

    global.FolioCrop = {
        loadCanvas,
        canvasFromImage,
        autoCrop,
        confirmCrop,
        warpQuad,
        detectQuad,
        toJpeg,
        toFile,
        needsRecrop,
        orderCorners,
    };
})(window);
