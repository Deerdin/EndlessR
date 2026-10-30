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
        try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            let pdf = existingPdfDoc;
            if (!pdf) {
                const arrayBuffer = await this.toArrayBuffer(fileData);
                if (!arrayBuffer) return { wordCount: 0, pageCount: 0, chapterCount: 0 };
                pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
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

            return {
                wordCount: totalWords,
                pageCount: totalPages,
                chapterCount
            };
        } catch (err) {
            console.warn("PDF stats calculation error:", err);
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
        try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            
            const cleanBuffer = await this.toArrayBuffer(arrayBuffer);
            const loadingTask = pdfjsLib.getDocument({ data: cleanBuffer });
            const pdf = await loadingTask.promise;
            
            let title = fileName.replace(/\.[^/.]+$/, "");
            let author = "Unknown Author";

            try {
                const meta = await pdf.getMetadata();
                if (meta && meta.info) {
                    if (meta.info.Title && meta.info.Title.trim()) title = meta.info.Title;
                    if (meta.info.Author && meta.info.Author.trim()) author = meta.info.Author;
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

            const stats = await this.computePdfStatsFromBuffer(cleanBuffer, pdf);

            return {
                title,
                author,
                coverUrl,
                totalPages: pdf.numPages,
                wordCount: stats.wordCount,
                pageCount: stats.pageCount || pdf.numPages,
                chapterCount: stats.chapterCount
            };
        } catch (err) {
            console.error("Critical error loading PDF:", err);
            throw new Error("Could not parse PDF file.");
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
    }
};
