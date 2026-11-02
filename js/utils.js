// ================= YARDIMCI ARAÇLAR MODÜLÜ (js/utils.js) =================

const utils = {
    // Benzersiz ID oluştur
    generateId() {
        return 'book_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    },

    // Dosya boyutunu okunabilir formata dönüştür
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },

    // Rastgele şık bir gradyan arka planı oluştur (Kapak resmi olmayan kitaplar için)
    generateGradientPlaceholder(title, author) {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 450;
        const ctx = canvas.getContext('2d');

        // Şık gradyan renk çiftleri (Premium tonlar)
        const gradients = [
            ['#4f46e5', '#7c3aed'], // Indigo - Purple
            ['#3b82f6', '#1d4ed8'], // Blue - Deep Blue
            ['#ec4899', '#f43f5e'], // Pink - Rose
            ['#10b981', '#059669'], // Emerald - Green
            ['#f59e0b', '#d97706'], // Amber - Orange
            ['#84cc16', '#65a30d'], // Lime - Green
            ['#14b8a6', '#0f766e'], // Teal - Teal Dark
            ['#06b6d4', '#0891b2']  // Cyan - Cyan Dark
        ];

        // Kitap adına göre tutarlı bir gradyan seç
        const index = Math.abs(this.hashCode(title)) % gradients.length;
        const colorPair = gradients[index];

        const grad = ctx.createLinearGradient(0, 0, 0, 450);
        grad.addColorStop(0, colorPair[0]);
        grad.addColorStop(1, colorPair[1]);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 300, 450);

        // Geometrik süslemeler ekle
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.arc(300, 0, 180, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 450, 130, 0, Math.PI * 2);
        ctx.fill();

        // Kitap Başlığı Yazımı
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Uzun başlıkları bölerek yazdır
        ctx.font = 'bold 22px "Outfit", sans-serif';
        const words = (title || 'Book').split(' ');
        let lines = [];
        let currentLine = words[0] || '';

        for (let i = 1; i < words.length; i++) {
            const width = ctx.measureText(currentLine + " " + words[i]).width;
            if (width < 250) {
                currentLine += " " + words[i];
            } else {
                lines.push(currentLine);
                currentLine = words[i];
            }
        }
        lines.push(currentLine);
        
        // Maksimum 5 satır yazdır
        lines = lines.slice(0, 5);
        let startY = 200 - (lines.length - 1) * 15;
        lines.forEach((line, idx) => {
            ctx.fillText(line, 150, startY + idx * 32);
        });

        // Yazar Adı Yazımı
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = 'medium 14px "Inter", sans-serif';
        const cleanAuthor = author && author !== 'Bilinmeyen Yazar' && author !== 'Unknown Author' ? author : 'EndlessR Reader';
        ctx.fillText(cleanAuthor.toUpperCase(), 150, 380);

        // Logo Süsü
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = 'bold 12px "Outfit", sans-serif';
        ctx.fillText('ENDLESS R', 150, 420);

        return canvas.toDataURL('image/jpeg');
    },

    // String için hash kodu üret (tutarlı gradyan seçimi için)
    hashCode(str) {
        let hash = 0;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            const char = s.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    },

    // Düz metin içindeki gerçek kelime sayısını hesaplar
    countWordsInText(text) {
        if (!text || typeof text !== 'string') return 0;
        const cleaned = text
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return 0;
        const tokens = cleaned.split(' ');
        let count = 0;
        for (let i = 0; i < tokens.length; i++) {
            if (/[a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]/.test(tokens[i])) {
                count++;
            }
        }
        return count;
    },

    // Sayıları binlik ayraçla okunaklı biçimlendirir (örn. 124,580)
    formatNumber(num) {
        const n = Number(num) || 0;
        return n.toLocaleString('en-US');
    },

    // Farklı tiplerdeki (ArrayBuffer, Uint8Array, Blob, Base64) dosya verisini güvenli ArrayBuffer'a çevirir
    async toArrayBuffer(fileData) {
        if (!fileData) return null;
        if (fileData instanceof ArrayBuffer) {
            return fileData.slice(0);
        }
        if (ArrayBuffer.isView(fileData)) {
            return fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
        }
        if (typeof Blob !== 'undefined' && fileData instanceof Blob) {
            if (typeof fileData.arrayBuffer === 'function') {
                return await fileData.arrayBuffer();
            }
            return await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => reject(fr.error);
                fr.readAsArrayBuffer(fileData);
            });
        }
        if (typeof fileData === 'string' && typeof backupDb !== 'undefined' && backupDb.base64ToArrayBuffer) {
            return await backupDb.base64ToArrayBuffer(fileData);
        }
        if (fileData.buffer instanceof ArrayBuffer) {
            return fileData.buffer.slice(0);
        }
        return fileData;
    },

    // Kullanıcının yüklediği kapak fotoğrafını (klasör veya kitap/cilt için) optimize edilmiş Base64 JPEG'e dönüştürür
    async processUploadedCoverImage(file) {
        return new Promise((resolve, reject) => {
            if (!file || !file.type || !file.type.startsWith('image/')) {
                reject(new Error('Please select a valid image file.'));
                return;
            }
            const fileReader = new FileReader();
            fileReader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const targetW = 420;
                        const targetH = 630;
                        const canvas = document.createElement('canvas');
                        canvas.width = targetW;
                        canvas.height = targetH;
                        const ctx = canvas.getContext('2d');

                        ctx.fillStyle = '#121214';
                        ctx.fillRect(0, 0, targetW, targetH);

                        const imgRatio = img.width / Math.max(1, img.height);
                        const canvasRatio = targetW / targetH;
                        let drawW = targetW;
                        let drawH = targetH;
                        let offsetX = 0;
                        let offsetY = 0;

                        if (imgRatio > canvasRatio) {
                            drawH = targetH;
                            drawW = img.width * (targetH / Math.max(1, img.height));
                            offsetX = (targetW - drawW) / 2;
                        } else {
                            drawW = targetW;
                            drawH = img.height * (targetW / Math.max(1, img.width));
                            offsetY = (targetH - drawH) / 2;
                        }

                        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                        resolve(dataUrl);
                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = () => reject(new Error('Failed to load image.'));
                img.src = e.target.result;
            };
            fileReader.onerror = () => reject(new Error('Failed to read file.'));
            fileReader.readAsDataURL(file);
        });
    },

    // EPUB ArrayBuffer içinden hızlıca toplam kelime, sayfa ve bölüm sayısını hesaplar (JSZip ile)
    async computeEpubStatsFromBuffer(fileData) {
        try {
            const arrayBuffer = await this.toArrayBuffer(fileData);
            if (!arrayBuffer || typeof JSZip === 'undefined') {
                return { wordCount: 0, pageCount: 0, chapterCount: 0 };
            }
            const zip = await JSZip.loadAsync(arrayBuffer);
            const fileNames = Object.keys(zip.files);

            // 1. İçindekiler (TOC / NCX / NAV / OPF Spine) dosyasından bölüm sayısını bulmayı dene
            let tocChapterCount = 0;
            const ncxFile = fileNames.find(f => /\.ncx$/i.test(f));
            if (ncxFile && zip.files[ncxFile]) {
                const ncxText = await zip.files[ncxFile].async('string');
                const navPoints = ncxText.match(/<navPoint\b/gi);
                if (navPoints && navPoints.length > 0) {
                    tocChapterCount = navPoints.length;
                }
            }
            if (tocChapterCount === 0) {
                const navFile = fileNames.find(f => /(?:^|\/)(?:nav|toc)\.(?:xhtml|html|htm)$/i.test(f));
                if (navFile && zip.files[navFile]) {
                    const navText = await zip.files[navFile].async('string');
                    const liMatches = navText.match(/<a\b[^>]*href=/gi);
                    if (liMatches && liMatches.length > 0) {
                        tocChapterCount = liMatches.length;
                    }
                }
            }
            let opfSpineCount = 0;
            const opfFile = fileNames.find(f => /\.opf$/i.test(f));
            if (opfFile && zip.files[opfFile]) {
                try {
                    const opfText = await zip.files[opfFile].async('string');
                    const itemrefs = opfText.match(/<itemref\b/gi);
                    if (itemrefs && itemrefs.length > 0) {
                        opfSpineCount = itemrefs.length;
                    }
                } catch (e) {}
            }

            // 2. Tüm içerik (XHTML / HTML / HTM) dosyalarından kelime sayısını topla
            const htmlFiles = fileNames.filter(f => {
                if (zip.files[f].dir) return false;
                if (!/\.(?:xhtml|html|htm|xml)$/i.test(f)) return false;
                if (/META-INF\/container\.xml$/i.test(f)) return false;
                if (/(?:^|\/)(?:nav|toc|cover|titlepage|copyright)\.(?:xhtml|html|htm|xml)$/i.test(f)) return false;
                return true;
            });

            let totalWords = 0;
            let contentChapterCount = 0;

            for (const fName of htmlFiles) {
                try {
                    const rawHtml = await zip.files[fName].async('string');
                    // Eğer bir XML dosyasıysa ve içinde html/body/p/div yoksa atla
                    if (/\.xml$/i.test(fName) && !/<(?:html|body|p|div|section|article)\b/i.test(rawHtml)) {
                        continue;
                    }
                    const bodyMatch = rawHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
                    const contentHtml = bodyMatch ? bodyMatch[1] : rawHtml;
                    const plain = contentHtml
                        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
                        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&(?:nbsp|#160);/gi, ' ')
                        .replace(/&[a-zA-Z0-9#]+;/g, "'");
                    const wCount = this.countWordsInText(plain);
                    totalWords += wCount;
                    if (wCount >= 80) {
                        contentChapterCount++;
                    }
                } catch (e) {}
            }

            const finalChapterCount = tocChapterCount > 0
                ? tocChapterCount
                : (contentChapterCount > 0 ? contentChapterCount : Math.max(1, opfSpineCount || htmlFiles.length));
            // Standart e-kitap sayfası = 250 kelime
            const finalPageCount = totalWords > 0
                ? Math.max(1, Math.ceil(totalWords / 250))
                : Math.max(1, finalChapterCount);

            return {
                wordCount: totalWords,
                pageCount: finalPageCount,
                chapterCount: finalChapterCount
            };
        } catch (err) {
            console.warn("EPUB stats calculation error:", err);
            return { wordCount: 0, pageCount: 0, chapterCount: 0 };
        }
    },

    // PDF ArrayBuffer içinden toplam kelime, sayfa ve bölüm sayısını hesaplar
    async computePdfStatsFromBuffer(fileData, existingPdfDoc = null) {
        let createdLocalPdf = false;
        let pdf = existingPdfDoc;
        try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            if (!pdf) {
                const arrayBuffer = await this.toArrayBuffer(fileData);
                if (!arrayBuffer || arrayBuffer.byteLength === 0) return { wordCount: 0, pageCount: 0, chapterCount: 0 };
                // Orijinal ArrayBuffer'ın PDF.js worker tarafından detach (boşaltılmasını) önlemek için kopya Uint8Array gönder
                const dataCopy = new Uint8Array(arrayBuffer.slice(0));
                pdf = await pdfjsLib.getDocument({ data: dataCopy }).promise;
                createdLocalPdf = true;
            }
            const totalPages = pdf.numPages || 1;

            let chapterCount = 0;
            try {
                const outline = await pdf.getOutline();
                if (Array.isArray(outline) && outline.length > 0) {
                    chapterCount = outline.length;
                }
            } catch (e) {}
            if (chapterCount === 0) {
                chapterCount = Math.max(1, Math.ceil(totalPages / 15));
            }

            const sampleLimit = Math.min(totalPages, 60);
            let sampleWords = 0;
            for (let p = 1; p <= sampleLimit; p++) {
                try {
                    const page = await pdf.getPage(p);
                    const tc = await page.getTextContent();
                    const pageStr = (tc && Array.isArray(tc.items)) ? tc.items.map(item => item.str || '').join(' ') : '';
                    sampleWords += this.countWordsInText(pageStr);
                } catch (e) {}
            }

            const totalWords = sampleLimit < totalPages
                ? Math.round((sampleWords / Math.max(1, sampleLimit)) * totalPages)
                : sampleWords;

            if (createdLocalPdf && pdf && typeof pdf.destroy === 'function') {
                try { await pdf.destroy(); } catch (e) {}
            }

            return {
                wordCount: totalWords,
                pageCount: totalPages,
                chapterCount
            };
        } catch (err) {
            console.warn("PDF stats calculation error:", err);
            if (createdLocalPdf && pdf && typeof pdf.destroy === 'function') {
                try { await pdf.destroy(); } catch (e) {}
            }
            return { wordCount: 0, pageCount: 0, chapterCount: 0 };
        }
    },

    async computeBookStats(fileData, type) {
        if (!fileData) return { wordCount: 0, pageCount: 0, chapterCount: 0 };
        if (type === 'pdf') {
            return await this.computePdfStatsFromBuffer(fileData);
        }
        return await this.computeEpubStatsFromBuffer(fileData);
    },

    // PDF dosyasından metadata ve kapak resmi (İlk Sayfa) çıkarma
    async extractPdfMetadata(arrayBuffer, fileName) {
        let pdf = null;
        const fallbackTitle = (fileName || 'Book').replace(/\.[^/.]+$/, "");
        try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            
            const cleanBuffer = await this.toArrayBuffer(arrayBuffer);
            if (!cleanBuffer || cleanBuffer.byteLength === 0) {
                throw new Error("PDF file is empty.");
            }
            // Orijinal ArrayBuffer'ın PDF.js worker tarafından detach (boşaltılmasını) önlemek için kopya Uint8Array gönder
            const pdfDataCopy = new Uint8Array(cleanBuffer.slice(0));
            const loadingTask = pdfjsLib.getDocument({ data: pdfDataCopy });
            pdf = await loadingTask.promise;
            
            let title = fallbackTitle;
            let author = "Unknown Author";

            try {
                const meta = await pdf.getMetadata();
                if (meta && meta.info) {
                    if (meta.info.Title && meta.info.Title.trim()) title = meta.info.Title.trim();
                    if (meta.info.Author && meta.info.Author.trim()) author = meta.info.Author.trim();
                }
            } catch (e) {
                console.warn("PDF metadata could not be read:", e);
            }

            let coverUrl = null;
            try {
                const page = await pdf.getPage(1);
                const viewport = page.getViewport({ scale: 0.5 });
                
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d');
                
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;

                coverUrl = canvas.toDataURL('image/jpeg', 0.8);
            } catch (e) {
                console.error("PDF cover render error:", e);
                coverUrl = this.generateGradientPlaceholder(title, author);
            }

            const totalPages = pdf.numPages || 1;
            const stats = await this.computePdfStatsFromBuffer(cleanBuffer, pdf);

            if (pdf && typeof pdf.destroy === 'function') {
                try { await pdf.destroy(); } catch (d) {}
            }

            return {
                title,
                author,
                coverUrl,
                totalPages,
                wordCount: stats.wordCount,
                pageCount: stats.pageCount || totalPages,
                chapterCount: stats.chapterCount || Math.max(1, Math.ceil(totalPages / 15))
            };
        } catch (err) {
            console.error("PDF metadata extraction error, using fallback:", err);
            if (pdf && typeof pdf.destroy === 'function') {
                try { await pdf.destroy(); } catch (d) {}
            }
            return {
                title: fallbackTitle,
                author: "Unknown Author",
                coverUrl: this.generateGradientPlaceholder(fallbackTitle, "Unknown Author"),
                totalPages: 1,
                wordCount: 0,
                pageCount: 1,
                chapterCount: 1
            };
        }
    },

    // EPUB dosyasından metadata ve kapak resmi çıkarma
    async extractEpubMetadata(arrayBuffer, fileName) {
        return new Promise(async (resolve, reject) => {
            let book = null;
            try {
                const cleanBuffer = await this.toArrayBuffer(arrayBuffer);
                const stats = await this.computeEpubStatsFromBuffer(cleanBuffer);

                book = ePub(cleanBuffer.slice ? cleanBuffer.slice(0) : cleanBuffer);
                
                await book.opened;
                const metadata = await book.loaded.metadata;
                
                let title = metadata.title || fileName.replace(/\.[^/.]+$/, "");
                let author = metadata.creator || "Unknown Author";
                
                let coverUrl = null;
                try {
                    const coverPath = await book.coverUrl();
                    if (coverPath) {
                        try {
                            const response = await fetch(coverPath);
                            const blob = await response.blob();
                            coverUrl = await new Promise((res, rej) => {
                                const reader = new FileReader();
                                reader.onloadend = () => res(reader.result);
                                reader.onerror = rej;
                                reader.readAsDataURL(blob);
                            });
                        } catch (fetchErr) {
                            console.error("Cover image fetch error, using fallback placeholder:", fetchErr);
                            coverUrl = this.generateGradientPlaceholder(title, author);
                        }
                    } else {
                        coverUrl = this.generateGradientPlaceholder(title, author);
                    }
                } catch (e) {
                    console.warn("EPUB cover could not be extracted:", e);
                    coverUrl = this.generateGradientPlaceholder(title, author);
                }

                if (book) {
                    try { book.destroy(); } catch(d) {}
                }

                resolve({
                    title,
                    author,
                    coverUrl,
                    wordCount: stats.wordCount,
                    pageCount: stats.pageCount,
                    chapterCount: stats.chapterCount
                });

            } catch (err) {
                console.error("EPUB metadata extraction error:", err);
                if (book) {
                    try { book.destroy(); } catch(d) {}
                }
                resolve({
                    title: fileName.replace(/\.[^/.]+$/, ""),
                    author: "Unknown Author",
                    coverUrl: this.generateGradientPlaceholder(fileName, "Unknown Author"),
                    wordCount: 0,
                    pageCount: 0,
                    chapterCount: 0
                });
            }
        });
    },

    // Tarayıcının "deerdin.github.io web sitesinin mesajı" başlığını göstermeyen uygulama içi bildirim / uyarı penceresi
    showAppAlert(message) {
        return new Promise((resolve) => {
            try {
                let overlay = document.getElementById('endlessr-custom-alert-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'endlessr-custom-alert-overlay';
                    overlay.className = 'modal-overlay notranslate';
                    overlay.setAttribute('translate', 'no');
                    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 10000; padding: 20px;';
                    overlay.innerHTML = `
                        <div class="modal-content glass" style="width: 100%; max-width: 340px; padding: 22px 20px 18px; border-radius: var(--radius-lg, 18px); border: 1px solid var(--border-color, rgba(255,255,255,0.12)); background: var(--bg-surface-solid, #18181b); box-shadow: 0 18px 40px rgba(0,0,0,0.45); display: flex; flex-direction: column; gap: 16px; text-align: center;">
                            <p id="endlessr-custom-alert-text" style="font-size: 14px; font-weight: 500; line-height: 1.5; color: var(--text-primary, #f4f4f5); margin: 0; white-space: pre-line; word-break: break-word;"></p>
                            <button type="button" id="endlessr-custom-alert-ok" class="action-btn" style="padding: 10px 16px; font-size: 14px; font-weight: 600; border-radius: var(--radius-md, 10px); width: 100%; border: none; cursor: pointer;">OK</button>
                        </div>
                    `;
                    document.body.appendChild(overlay);
                }

                const textEl = overlay.querySelector('#endlessr-custom-alert-text');
                if (textEl) {
                    textEl.textContent = String(message !== undefined && message !== null ? message : '');
                }

                const okBtn = overlay.querySelector('#endlessr-custom-alert-ok');
                const cleanup = () => {
                    overlay.style.display = 'none';
                    if (okBtn) okBtn.onclick = null;
                    overlay.onclick = null;
                    resolve();
                };

                if (okBtn) {
                    okBtn.onclick = (e) => {
                        e.stopPropagation();
                        cleanup();
                    };
                }
                overlay.onclick = (e) => {
                    if (e.target === overlay) cleanup();
                };

                overlay.style.display = 'flex';
                if (okBtn) {
                    setTimeout(() => {
                        try { okBtn.focus(); } catch (e) {}
                    }, 20);
                }
            } catch (e) {
                console.warn("Custom alert fallback:", message, e);
                resolve();
            }
        });
    },

    // Tarayıcının "deerdin.github.io web sitesinin mesajı" başlığını göstermeyen şık onay penceresi
    showAppConfirm(message, options = {}) {
        return new Promise((resolve) => {
            try {
                let overlay = document.getElementById('endlessr-custom-confirm-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'endlessr-custom-confirm-overlay';
                    overlay.className = 'modal-overlay notranslate';
                    overlay.setAttribute('translate', 'no');
                    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 10000; padding: 20px;';
                    overlay.innerHTML = `
                        <div class="modal-content glass" style="width: 100%; max-width: 340px; padding: 22px 20px 18px; border-radius: var(--radius-lg, 18px); border: 1px solid var(--border-color, rgba(255,255,255,0.12)); background: var(--bg-surface-solid, #18181b); box-shadow: 0 18px 40px rgba(0,0,0,0.45); display: flex; flex-direction: column; gap: 18px; text-align: center;">
                            <p id="endlessr-custom-confirm-text" style="font-size: 14px; font-weight: 500; line-height: 1.5; color: var(--text-primary, #f4f4f5); margin: 0; white-space: pre-line; word-break: break-word;"></p>
                            <div style="display: flex; gap: 10px; width: 100%;">
                                <button type="button" id="endlessr-custom-confirm-cancel" class="action-outline-btn" style="flex: 1; padding: 10px 14px; font-size: 13px; font-weight: 600; border-radius: var(--radius-md, 10px); cursor: pointer;">Cancel</button>
                                <button type="button" id="endlessr-custom-confirm-ok" class="action-btn" style="flex: 1; padding: 10px 14px; font-size: 13px; font-weight: 600; border-radius: var(--radius-md, 10px); border: none; cursor: pointer;">Confirm</button>
                            </div>
                        </div>
                    `;
                    document.body.appendChild(overlay);
                }

                const textEl = overlay.querySelector('#endlessr-custom-confirm-text');
                if (textEl) {
                    textEl.textContent = String(message !== undefined && message !== null ? message : '');
                }

                const okBtn = overlay.querySelector('#endlessr-custom-confirm-ok');
                const cancelBtn = overlay.querySelector('#endlessr-custom-confirm-cancel');

                const isDanger = !!options.danger;
                if (okBtn) {
                    okBtn.textContent = options.confirmText || (isDanger ? 'Delete' : 'Confirm');
                    if (isDanger) {
                        okBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                        okBtn.style.color = '#ffffff';
                    } else {
                        okBtn.style.background = 'var(--accent-gradient)';
                        okBtn.style.color = '#ffffff';
                    }
                }
                if (cancelBtn) {
                    cancelBtn.textContent = options.cancelText || 'Cancel';
                }

                const cleanup = (result) => {
                    overlay.style.display = 'none';
                    if (okBtn) okBtn.onclick = null;
                    if (cancelBtn) cancelBtn.onclick = null;
                    overlay.onclick = null;
                    resolve(result);
                };

                if (okBtn) {
                    okBtn.onclick = (e) => {
                        e.stopPropagation();
                        cleanup(true);
                    };
                }
                if (cancelBtn) {
                    cancelBtn.onclick = (e) => {
                        e.stopPropagation();
                        cleanup(false);
                    };
                }
                overlay.onclick = (e) => {
                    if (e.target === overlay) cleanup(false);
                };

                overlay.style.display = 'flex';
                if (cancelBtn) {
                    setTimeout(() => {
                        try { cancelBtn.focus(); } catch (e) {}
                    }, 20);
                }
            } catch (e) {
                console.warn("Custom confirm fallback:", message, e);
                resolve(false);
            }
        });
    }
};

// Tüm alert(...) çağrılarını uygulama içi başlık içermeyen temiz pencereye yönlendir
window.alert = function(message) {
    utils.showAppAlert(message);
};
