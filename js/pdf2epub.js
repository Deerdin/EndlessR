// ================= PDF → EPUB DÖNÜŞTÜRÜCÜ (js/pdf2epub.js) =================
// PDF dosyasını içeriğini değiştirmeden (metin, kalın/italik stiller, başlıklar, resimler ve içindekiler)
// akışkan (reflowable) bir EPUB 3 dosyasına dönüştürür. Taranmış (scan) veya çizim ağırlıklı sayfalar
// birebir korunması için yüksek çözünürlüklü sayfa görseli olarak eklenir.

const pdfToEpub = {
    isConverting: false,
    cancelRequested: false,
    selectedSource: null, // { type: 'file', file, name } | { type: 'library', bookId, name }

    WORKER_SRC: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js',

    // ---------------------------------------------------------------------
    // 1. Arayüz (Ayarlar sayfasındaki dönüştürücü kartı)
    // ---------------------------------------------------------------------
    init() {
        const pickBtn = document.getElementById('btn-pdf2epub-pick');
        const fileInput = document.getElementById('input-pdf2epub');
        const librarySelect = document.getElementById('pdf2epub-library-select');
        const convertBtn = document.getElementById('btn-pdf2epub-convert');
        const cancelBtn = document.getElementById('btn-pdf2epub-cancel');
        if (!convertBtn || convertBtn.__pdf2epubBound) return;
        convertBtn.__pdf2epubBound = true;

        if (pickBtn && fileInput) {
            pickBtn.addEventListener('click', () => {
                if (this.isConverting) return;
                fileInput.value = '';
                fileInput.click();
            });
            fileInput.addEventListener('change', (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
                    alert('Please choose a .pdf file.');
                    return;
                }
                this.selectedSource = { type: 'file', file: f, name: f.name };
                if (librarySelect) librarySelect.value = '';
                this.updateSelectedLabel();
            });
        }

        if (librarySelect) {
            librarySelect.addEventListener('focus', () => this.refreshLibraryPdfList());
            librarySelect.addEventListener('change', () => {
                const id = librarySelect.value;
                if (!id) {
                    if (this.selectedSource && this.selectedSource.type === 'library') {
                        this.selectedSource = null;
                    }
                } else {
                    const opt = librarySelect.options[librarySelect.selectedIndex];
                    this.selectedSource = { type: 'library', bookId: id, name: opt ? opt.textContent : 'Library PDF' };
                }
                this.updateSelectedLabel();
            });
        }

        convertBtn.addEventListener('click', () => this.startConversion());

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (!this.isConverting) return;
                this.cancelRequested = true;
                this.setStatus('Cancelling...', null);
            });
        }

        this.refreshLibraryPdfList();
        this.updateSelectedLabel();
    },

    async refreshLibraryPdfList() {
        const select = document.getElementById('pdf2epub-library-select');
        if (!select || typeof booksDb === 'undefined') return;
        try {
            const books = await booksDb.getAllBooks();
            const pdfs = books.filter(b => b && b.type === 'pdf');
            const prev = select.value;
            select.innerHTML = '';

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = pdfs.length > 0 ? `From Library (${pdfs.length} PDF)` : 'No PDFs in library';
            select.appendChild(placeholder);

            pdfs.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.title || b.originalFileName || 'Untitled PDF';
                select.appendChild(opt);
            });

            if (prev && pdfs.some(b => b.id === prev)) {
                select.value = prev;
            }
        } catch (e) {
            console.warn('PDF list could not be loaded:', e);
        }
    },

    updateSelectedLabel() {
        const label = document.getElementById('pdf2epub-selected');
        if (!label) return;
        if (!this.selectedSource) {
            label.textContent = 'No PDF selected';
            label.style.color = 'var(--text-muted)';
            return;
        }
        let text = 'Selected: ' + this.selectedSource.name;
        if (this.selectedSource.type === 'file' && this.selectedSource.file && typeof utils !== 'undefined' && utils.formatBytes) {
            text += ` (${utils.formatBytes(this.selectedSource.file.size)})`;
        } else if (this.selectedSource.type === 'library') {
            text += ' (from library)';
        }
        label.textContent = text;
        label.style.color = 'var(--text-primary)';
    },

    setStatus(message, percent, state = 'info') {
        const box = document.getElementById('pdf2epub-status-box');
        const text = document.getElementById('pdf2epub-status-text');
        const bar = document.getElementById('pdf2epub-progress-bar');
        if (box) {
            box.style.display = 'block';
            if (state === 'error') {
                box.style.background = 'rgba(239, 68, 68, 0.12)';
                box.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                box.style.color = '#ef4444';
            } else if (state === 'success') {
                box.style.background = 'rgba(16, 185, 129, 0.12)';
                box.style.borderColor = 'rgba(16, 185, 129, 0.35)';
                box.style.color = '#10b981';
            } else {
                box.style.background = 'rgba(99, 102, 241, 0.12)';
                box.style.borderColor = 'rgba(99, 102, 241, 0.3)';
                box.style.color = 'var(--accent-color)';
            }
        }
        if (text && message) text.textContent = message;
        if (bar && typeof percent === 'number') {
            bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
        }
    },

    setBusyUI(busy) {
        const convertBtn = document.getElementById('btn-pdf2epub-convert');
        const cancelBtn = document.getElementById('btn-pdf2epub-cancel');
        const pickBtn = document.getElementById('btn-pdf2epub-pick');
        const librarySelect = document.getElementById('pdf2epub-library-select');
        const modeSelect = document.getElementById('pdf2epub-mode');
        if (convertBtn) {
            convertBtn.disabled = busy;
            convertBtn.style.opacity = busy ? '0.6' : '1';
        }
        if (cancelBtn) cancelBtn.style.display = busy ? 'flex' : 'none';
        if (pickBtn) pickBtn.disabled = busy;
        if (librarySelect) librarySelect.disabled = busy;
        if (modeSelect) modeSelect.disabled = busy;
    },

    async startConversion() {
        if (this.isConverting) return;
        if (!this.selectedSource) {
            alert('Please choose a PDF file first.');
            return;
        }

        const modeSelect = document.getElementById('pdf2epub-mode');
        const addChk = document.getElementById('pdf2epub-add-library');
        const dlChk = document.getElementById('pdf2epub-download');
        const mode = (modeSelect && modeSelect.value) || 'reflow';
        const addToLibrary = addChk ? addChk.checked : true;
        const download = dlChk ? dlChk.checked : true;

        if (!addToLibrary && !download) {
            alert('Select at least one output option (download or add to library).');
            return;
        }

        this.isConverting = true;
        this.cancelRequested = false;
        this.setBusyUI(true);
        this.setStatus('Reading PDF file...', 1);

        try {
            let buffer = null;
            let baseName = 'converted';

            if (this.selectedSource.type === 'file') {
                const f = this.selectedSource.file;
                buffer = await utils.toArrayBuffer(f);
                baseName = f.name.replace(/\.pdf$/i, '');
            } else {
                const book = await booksDb.getBook(this.selectedSource.bookId);
                if (!book) throw new Error('Book not found in library.');
                buffer = await utils.toArrayBuffer(book.file);
                baseName = book.title || book.originalFileName || 'converted';
            }

            if (!buffer || !buffer.byteLength) {
                throw new Error('PDF file is empty or could not be read.');
            }

            const result = await this.convert(buffer, baseName, {
                mode,
                onProgress: (pct, msg) => this.setStatus(msg, pct)
            });

            const fileName = this.safeFileName(result.title || baseName) + '.epub';

            if (download) {
                this.downloadBlob(result.blob, fileName);
            }
            if (addToLibrary) {
                this.setStatus('Adding EPUB to library...', 99);
                await this.addEpubToLibrary(result, fileName);
            }

            const sizeStr = (typeof utils !== 'undefined' && utils.formatBytes) ? utils.formatBytes(result.blob.size) : (result.blob.size + ' bytes');
            this.setStatus(
                `Done! ${result.pageCount} pages → ${result.chapterCount} chapters, ${result.imageCount} images (${sizeStr}).`,
                100,
                'success'
            );
            const parts = [];
            if (download) parts.push('downloaded');
            if (addToLibrary) parts.push('added to your library');
            alert(`EPUB created successfully and ${parts.join(' and ')}.`);
        } catch (err) {
            if (err && err.message === '__CANCELLED__') {
                this.setStatus('Conversion cancelled.', 0, 'error');
            } else {
                console.error('PDF → EPUB conversion error:', err);
                let msg = (err && err.message) ? err.message : String(err);
                if (err && err.name === 'PasswordException') {
                    msg = 'This PDF is password protected and cannot be converted.';
                } else if (err && err.name === 'InvalidPDFException') {
                    msg = 'The selected file is not a valid PDF.';
                }
                this.setStatus('Error: ' + msg, 0, 'error');
                alert('Could not convert PDF to EPUB: ' + msg);
            }
        } finally {
            this.isConverting = false;
            this.cancelRequested = false;
            this.setBusyUI(false);
        }
    },

    downloadBlob(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 1000);
        // Mobil tarayıcı indirme yöneticisinin dosyayı tamamlaması için URL'yi bir süre açık tut
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    async addEpubToLibrary(result, fileName) {
        const buffer = await result.blob.arrayBuffer();
        const preserved = buffer.slice(0);
        let metadata = {};
        try {
            metadata = await utils.extractEpubMetadata(preserved.slice(0), fileName) || {};
        } catch (e) {
            console.warn('EPUB metadata extraction failed:', e);
        }
        const cleanName = fileName.replace(/\.epub$/i, '');
        const title = result.title || metadata.title || cleanName;
        const author = result.author || metadata.author || 'Unknown Author';

        const newBook = {
            id: utils.generateId(),
            title: title,
            originalFileName: cleanName,
            author: author,
            coverUrl: result.coverDataUrl || metadata.coverUrl || utils.generateGradientPlaceholder(title, author),
            type: 'epub',
            file: preserved,
            totalPages: Number(metadata.totalPages) || Number(metadata.pageCount) || result.pageCount || 1,
            wordCount: Number(metadata.wordCount) || 0,
            pageCount: Number(metadata.pageCount) || Number(metadata.totalPages) || result.pageCount || 1,
            chapterCount: Number(metadata.chapterCount) || result.chapterCount || 1,
            statsCalculated: true,
            progressPercent: 0,
            lastLocation: null,
            addedAt: Date.now(),
            lastReadAt: 0
        };

        await booksDb.saveBook(newBook);
        if (window.app) {
            try { await window.app.loadLibrary(); } catch (e) {}
            try { if (window.app.updateDatabaseStatsUI) await window.app.updateDatabaseStatsUI(); } catch (e) {}
        }
    },

    safeFileName(name) {
        const cleaned = String(name || 'converted')
            .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        return cleaned || 'converted';
    },

    // ---------------------------------------------------------------------
    // 2. Dönüştürme Motoru
    // ---------------------------------------------------------------------
    async convert(buffer, baseName, { mode = 'reflow', onProgress = () => {} } = {}) {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF library is not loaded.');
        if (typeof JSZip === 'undefined') throw new Error('ZIP library is not loaded.');

        pdfjsLib.GlobalWorkerOptions.workerSrc = this.WORKER_SRC;
        onProgress(2, 'Opening PDF...');

        // Orijinal ArrayBuffer'ın PDF.js worker tarafından detach edilmemesi için kopya gönder
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;

        try {
            const numPages = pdf.numPages;
            let title = baseName;
            let author = '';
            let lang = 'en';

            try {
                const meta = await pdf.getMetadata();
                const info = (meta && meta.info) || {};
                const metaTitle = info.Title ? String(info.Title).trim() : '';
                if (metaTitle.length > 1 && !/^untitled$|^microsoft word|\.docx?$|\.pdf$/i.test(metaTitle)) {
                    title = metaTitle;
                }
                if (info.Author) author = String(info.Author).trim();
                if (info.Language && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i.test(String(info.Language).trim())) {
                    lang = String(info.Language).trim();
                }
            } catch (e) {}

            onProgress(4, 'Reading table of contents...');
            const outline = await this.getOutlineEntries(pdf);

            const ctx = { images: [], imageCounter: 0 };
            const pages = [];

            for (let p = 1; p <= numPages; p++) {
                if (this.cancelRequested) throw new Error('__CANCELLED__');
                onProgress(5 + Math.round(((p - 1) / numPages) * 78), `Converting page ${p} / ${numPages}...`);

                const page = await pdf.getPage(p);
                try {
                    if (mode === 'fixed') {
                        pages.push(await this.extractFixedPage(page, p, ctx));
                    } else {
                        pages.push(await this.extractReflowPage(page, p, ctx));
                    }
                } catch (pageErr) {
                    if (pageErr && pageErr.message === '__CANCELLED__') throw pageErr;
                    console.warn(`Page ${p} could not be converted as text, using page image:`, pageErr);
                    try {
                        pages.push(await this.extractFixedPage(page, p, ctx));
                    } catch (e2) {
                        pages.push({ pageNum: p, lines: [], images: [], fullImage: null });
                    }
                } finally {
                    try { page.cleanup(); } catch (e) {}
                }
                // Arayüzün donmaması için her sayfadan sonra ana iş parçacığına nefes aldır
                await new Promise(r => setTimeout(r, 0));
            }

            if (this.cancelRequested) throw new Error('__CANCELLED__');

            onProgress(84, 'Creating cover...');
            let coverBlob = null;
            let coverDataUrl = null;
            try {
                const coverPage = await pdf.getPage(1);
                coverBlob = await this.renderPageToBlob(coverPage, 1000, 0.88);
                const thumbBlob = await this.renderPageToBlob(coverPage, 420, 0.8);
                coverDataUrl = thumbBlob ? await this.blobToDataUrl(thumbBlob) : null;
                try { coverPage.cleanup(); } catch (e) {}
            } catch (e) {
                console.warn('Cover could not be rendered:', e);
            }

            onProgress(86, 'Building chapters...');
            const bodySize = this.computeBodyFontSize(pages);
            const pageBlocks = pages.map(pg => this.buildPageBlocks(pg, bodySize));
            const chapters = this.buildChapters(pageBlocks, outline, numPages);

            onProgress(88, 'Packaging EPUB...');
            const blob = await this.buildEpub(
                { title, author, lang, chapters, images: ctx.images, coverBlob },
                (pct) => onProgress(88 + Math.round((pct || 0) * 0.1), 'Packaging EPUB...')
            );

            return {
                blob,
                title,
                author,
                coverDataUrl,
                chapterCount: chapters.length,
                imageCount: ctx.images.length,
                pageCount: numPages
            };
        } finally {
            try { await pdf.destroy(); } catch (e) {}
        }
    },

    // PDF içindekiler (outline) girişlerini sayfa indeksleriyle birlikte çıkarır
    async getOutlineEntries(pdf) {
        const result = [];
        try {
            const outline = await pdf.getOutline();
            if (!outline || outline.length === 0) return result;

            const walk = async (items, depth) => {
                for (const it of items) {
                    if (this.cancelRequested) return;
                    const pageIndex = await this.resolveDestPage(pdf, it.dest);
                    if (pageIndex !== null && pageIndex !== undefined) {
                        result.push({ title: String(it.title || '').replace(/\s+/g, ' ').trim(), pageIndex, depth });
                    }
                    if (depth < 1 && Array.isArray(it.items) && it.items.length > 0) {
                        await walk(it.items, depth + 1);
                    }
                }
            };
            await walk(outline, 0);
        } catch (e) {
            console.warn('Outline could not be read:', e);
        }

        // Üst seviye başlık sayısı yeterliyse yalnızca onları, değilse bir alt seviyeyi de kullan
        const top = result.filter(r => r.depth === 0);
        return top.length >= 3 ? top : result;
    },

    async resolveDestPage(pdf, dest) {
        try {
            let explicit = dest;
            if (typeof dest === 'string') {
                explicit = await pdf.getDestination(dest);
            }
            if (!Array.isArray(explicit) || explicit.length === 0) return null;
            const ref = explicit[0];
            if (ref && typeof ref === 'object') {
                return await pdf.getPageIndex(ref);
            }
            if (Number.isInteger(ref)) return ref;
        } catch (e) {}
        return null;
    },

    // "Birebir Düzen" modu veya taranmış sayfalar: sayfanın tamamı yüksek kaliteli görsel olarak eklenir
    async extractFixedPage(page, pageNum, ctx) {
        const vp = page.getViewport({ scale: 1 });
        const blob = await this.renderPageToBlob(page, 1400, 0.86);
        const ref = blob ? this.registerImage(ctx, blob, 'image/jpeg') : null;
        return { pageNum, width: vp.width, height: vp.height, lines: [], images: [], fullImage: ref };
    },

    // Akışkan mod: metin satırları + konumlarıyla birlikte gömülü resimler
    async extractReflowPage(page, pageNum, ctx) {
        const viewport = page.getViewport({ scale: 1 });
        const pageW = viewport.width;
        const pageH = viewport.height;
        const pageArea = pageW * pageH;
        const OPS = pdfjsLib.OPS;
        const Util = pdfjsLib.Util;

        // 1. Operatör listesini tarayarak resimlerin konumlarını ve çizim yoğunluğunu bul
        const opList = await page.getOperatorList();
        const placements = [];
        let pathOps = 0;
        let invisibleText = false;
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];

        for (let i = 0; i < opList.fnArray.length; i++) {
            const fn = opList.fnArray[i];
            const args = opList.argsArray[i];
            if (fn === OPS.save) {
                stack.push(ctm.slice());
            } else if (fn === OPS.restore) {
                ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
            } else if (fn === OPS.transform) {
                ctm = Util.transform(ctm, args);
            } else if (fn === OPS.paintFormXObjectBegin) {
                stack.push(ctm.slice());
                if (args && Array.isArray(args[0]) && args[0].length === 6) {
                    ctm = Util.transform(ctm, args[0]);
                }
            } else if (fn === OPS.paintFormXObjectEnd) {
                ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
            } else if (fn === OPS.constructPath) {
                pathOps++;
            } else if (fn === OPS.setTextRenderingMode) {
                if (args && args[0] === 3) invisibleText = true;
            } else if (fn === OPS.paintImageXObject || (OPS.paintJpegXObject !== undefined && fn === OPS.paintJpegXObject)) {
                placements.push({ objId: args[0], inline: null, box: this.unitSquareBox(ctm, viewport) });
            } else if (fn === OPS.paintInlineImageXObject) {
                placements.push({ objId: null, inline: args[0], box: this.unitSquareBox(ctm, viewport) });
            }
        }

        // 2. Metin içeriğini satırlara ayır (yazı tipleri operatör listesiyle yüklendiği için kalın/italik bilgisi alınabilir)
        const textContent = await page.getTextContent();
        const lines = this.groupTextIntoLines(textContent, page, viewport);

        // Sayfa üst/alt kenarlarındaki tek başına sayfa numaralarını kaldır
        const filteredLines = lines.filter(l => {
            const t = l.text.trim();
            if (!t) return false;
            const isPageNum = /^(page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?$/i.test(t) || /^\d{1,4}\s*(\/|of)\s*\d{1,4}$/i.test(t);
            if (isPageNum && (l.top < pageH * 0.09 || l.bottom > pageH * 0.91)) return false;
            return true;
        });

        const textChars = filteredLines.reduce((s, l) => s + l.text.replace(/\s+/g, '').length, 0);

        const bigImage = placements.find(pl => {
            const w = pl.box.right - pl.box.left;
            const h = pl.box.bottom - pl.box.top;
            return (w * h) > pageArea * 0.8;
        });

        // 3. Sayfa tipine göre karar ver
        const needsFullPageImage =
            (textChars < 20 && (placements.length > 0 || pathOps > 0)) || // Taranmış veya yalnızca çizim içeren sayfa
            (bigImage && invisibleText) ||                                  // OCR katmanlı taranmış sayfa
            (pathOps > 400 && textChars < 600);                             // Grafik / diyagram ağırlıklı sayfa

        if (needsFullPageImage) {
            return await this.extractFixedPage(page, pageNum, ctx);
        }

        // 4. Gömülü resimleri çıkar
        const images = [];
        const usedKeys = new Map();
        for (const pl of placements) {
            if (this.cancelRequested) throw new Error('__CANCELLED__');
            const w = pl.box.right - pl.box.left;
            const h = pl.box.bottom - pl.box.top;
            if (w < 12 || h < 12) continue;                 // Çok küçük süs / çizgi resimleri
            if (w * h < pageArea * 0.004) continue;
            if (w * h > pageArea * 0.8) continue;           // Tam sayfa arka plan görseli (metin zaten ayrıca alınıyor)

            const key = pl.objId ? pl.objId : null;
            let ref = key ? usedKeys.get(key) : null;
            if (!ref) {
                let imgObj = pl.inline;
                if (!imgObj && pl.objId) {
                    imgObj = await this.getImageObject(page, pl.objId);
                }
                const converted = await this.imageObjToBlob(imgObj);
                if (!converted) continue;
                ref = this.registerImage(ctx, converted.blob, converted.mediaType);
                if (key) usedKeys.set(key, ref);
            }

            images.push({
                top: pl.box.top,
                bottom: pl.box.bottom,
                left: pl.box.left,
                right: pl.box.right,
                widthPct: Math.max(15, Math.min(100, Math.round((w / pageW) * 100))),
                ref
            });
        }

        return { pageNum, width: pageW, height: pageH, lines: filteredLines, images, fullImage: null };
    },

    unitSquareBox(ctm, viewport) {
        const Util = pdfjsLib.Util;
        const m = Util.transform(viewport.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => Util.applyTransform(p, m));
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        return {
            left: Math.min(...xs),
            right: Math.max(...xs),
            top: Math.min(...ys),
            bottom: Math.max(...ys)
        };
    },

    normalizeText(str) {
        return String(str || '')
            .replace(/\uFB00/g, 'ff')
            .replace(/\uFB01/g, 'fi')
            .replace(/\uFB02/g, 'fl')
            .replace(/\uFB03/g, 'ffi')
            .replace(/\uFB04/g, 'ffl')
            .replace(/[\uFB05\uFB06]/g, 'st')
            .replace(/\u00A0/g, ' ')
            .replace(/\u00AD/g, '-');
    },

    // PDF metin parçalarını (içerik akış sırasını koruyarak) satırlara gruplar
    groupTextIntoLines(textContent, page, viewport) {
        const Util = pdfjsLib.Util;
        const lines = [];
        const fontCache = {};

        const fontStyle = (fontName) => {
            if (fontCache[fontName]) return fontCache[fontName];
            let bold = false;
            let italic = false;
            try {
                if (page.commonObjs && page.commonObjs.has(fontName)) {
                    const f = page.commonObjs.get(fontName);
                    const n = (f && (f.name || f.loadedName)) || '';
                    bold = !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|demibold|extrabold/i.test(n);
                    italic = !!(f && f.italic) || /italic|oblique/i.test(n);
                }
            } catch (e) {}
            const st = textContent.styles ? textContent.styles[fontName] : null;
            if (st && st.fontFamily) {
                if (/bold/i.test(st.fontFamily)) bold = true;
                if (/italic|oblique/i.test(st.fontFamily)) italic = true;
            }
            fontCache[fontName] = { bold, italic };
            return fontCache[fontName];
        };

        let cur = null;
        const finishLine = () => {
            if (!cur) return;
            cur.text = cur.runs.map(r => r.text).join('');
            cur.fontSize = cur.chars > 0 ? cur.sizeSum / cur.chars : cur.maxSize;
            const visibleRuns = cur.runs.filter(r => r.text.trim());
            cur.allBold = visibleRuns.length > 0 && visibleRuns.every(r => r.bold);
            if (cur.text.trim()) lines.push(cur);
            cur = null;
        };

        for (const it of textContent.items) {
            if (typeof it.str !== 'string') continue;
            const str = this.normalizeText(it.str);

            if (!str.trim()) {
                if (cur && str.length > 0) cur.pendingSpace = true;
                if (it.hasEOL && cur) cur.eol = true;
                continue;
            }

            const tx = Util.transform(viewport.transform, it.transform);
            const fh = Math.hypot(tx[2], tx[3]) || it.height || 10;
            const x = tx[4];
            const base = tx[5];
            const w = (it.width || 0) * viewport.scale;
            const right = x + w;
            const style = fontStyle(it.fontName);

            const tolerance = cur ? Math.max(2, Math.min(fh, cur.maxSize) * 0.55) : 0;
            const sameLine = !!cur &&
                !cur.eol &&
                Math.abs(base - cur.base) <= tolerance &&
                x >= cur.right - Math.max(fh, cur.maxSize) * 1.5;

            if (sameLine) {
                const lastRun = cur.runs[cur.runs.length - 1];
                const gap = x - cur.right;
                const needSpace = cur.pendingSpace ||
                    (gap > fh * 0.12 && !/\s$/.test(lastRun.text) && !/^\s/.test(str));
                if (needSpace) {
                    cur.runs.push({ text: ' ', bold: style.bold && lastRun.bold, italic: style.italic && lastRun.italic });
                }
                cur.runs.push({ text: str, bold: style.bold, italic: style.italic });
                cur.right = Math.max(cur.right, right);
                cur.top = Math.min(cur.top, base - fh);
                cur.bottom = Math.max(cur.bottom, base + fh * 0.22);
                cur.maxSize = Math.max(cur.maxSize, fh);
                cur.pendingSpace = false;
            } else {
                finishLine();
                cur = {
                    runs: [{ text: str, bold: style.bold, italic: style.italic }],
                    x,
                    right,
                    base,
                    top: base - fh,
                    bottom: base + fh * 0.22,
                    maxSize: fh,
                    sizeSum: 0,
                    chars: 0,
                    pendingSpace: false,
                    eol: false
                };
            }
            const len = str.replace(/\s+/g, '').length;
            cur.sizeSum += fh * len;
            cur.chars += len;
            if (it.hasEOL) cur.eol = true;
        }
        finishLine();
        return lines;
    },

    getImageObject(page, objId) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => {
                if (settled) return;
                settled = true;
                resolve(v || null);
            };
            try {
                const store = (String(objId).startsWith('g_') && page.commonObjs) ? page.commonObjs : page.objs;
                if (store.has && store.has(objId)) {
                    done(store.get(objId));
                    return;
                }
                store.get(objId, done);
            } catch (e) {
                done(null);
            }
            setTimeout(() => done(null), 8000);
        });
    },

    // PDF.js resim nesnesini (ImageBitmap veya ham piksel verisi) JPEG/PNG Blob'a dönüştürür
    async imageObjToBlob(img) {
        if (!img) return null;
        try {
            let w = img.width || 0;
            let h = img.height || 0;
            let source = null;

            if (img.bitmap) {
                source = img.bitmap;
            } else if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
                source = img;
            } else if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
                source = img;
                w = img.naturalWidth || w;
                h = img.naturalHeight || h;
            } else if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
                source = img;
            }
            if (!w || !h) return null;

            const MAX = 2200;
            const scale = Math.min(1, MAX / Math.max(w, h));
            const outW = Math.max(1, Math.round(w * scale));
            const outH = Math.max(1, Math.round(h * scale));

            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d');
            let hasAlpha = false;

            if (source) {
                ctx.drawImage(source, 0, 0, outW, outH);
                hasAlpha = this.canvasHasAlpha(ctx, outW, outH);
            } else if (img.data) {
                const tmp = scale < 1 ? document.createElement('canvas') : canvas;
                tmp.width = w;
                tmp.height = h;
                const tctx = tmp.getContext('2d');
                const imageData = tctx.createImageData(w, h);
                const dest = imageData.data;
                const src = img.data;
                const KIND = pdfjsLib.ImageKind || { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };
                const total = w * h;

                if (img.kind === KIND.RGBA_32BPP) {
                    const n = Math.min(src.length, total * 4);
                    for (let i = 0; i < n; i++) dest[i] = src[i];
                    for (let i = 3; i < n; i += 4) {
                        if (dest[i] < 250) { hasAlpha = true; break; }
                    }
                } else if (img.kind === KIND.RGB_24BPP) {
                    for (let i = 0, s = 0, d = 0; i < total && s + 2 < src.length; i++, s += 3, d += 4) {
                        dest[d] = src[s];
                        dest[d + 1] = src[s + 1];
                        dest[d + 2] = src[s + 2];
                        dest[d + 3] = 255;
                    }
                } else if (img.kind === KIND.GRAYSCALE_1BPP) {
                    const rowBytes = (w + 7) >> 3;
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const byte = src[y * rowBytes + (x >> 3)];
                            const v = (byte & (128 >> (x & 7))) ? 255 : 0;
                            const d = (y * w + x) * 4;
                            dest[d] = v;
                            dest[d + 1] = v;
                            dest[d + 2] = v;
                            dest[d + 3] = 255;
                        }
                    }
                } else {
                    return null;
                }
                tctx.putImageData(imageData, 0, 0);
                if (tmp !== canvas) {
                    ctx.drawImage(tmp, 0, 0, outW, outH);
                    tmp.width = 0;
                    tmp.height = 0;
                }
            } else {
                return null;
            }

            const mediaType = hasAlpha ? 'image/png' : 'image/jpeg';
            const blob = await this.canvasToBlob(canvas, mediaType, 0.9);
            canvas.width = 0;
            canvas.height = 0;
            return blob ? { blob, mediaType } : null;
        } catch (e) {
            console.warn('Image could not be extracted:', e);
            return null;
        }
    },

    canvasHasAlpha(ctx, w, h) {
        try {
            const data = ctx.getImageData(0, 0, w, h).data;
            const pixelCount = data.length / 4;
            const stride = Math.max(1, Math.floor(pixelCount / 40000)) * 4;
            for (let i = 3; i < data.length; i += stride) {
                if (data[i] < 250) return true;
            }
        } catch (e) {}
        return false;
    },

    canvasToBlob(canvas, type, quality) {
        return new Promise((resolve) => {
            try {
                canvas.toBlob((b) => resolve(b), type, quality);
            } catch (e) {
                resolve(null);
            }
        });
    },

    blobToDataUrl(blob) {
        return new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
        });
    },

    async renderPageToBlob(page, targetWidth = 1200, quality = 0.85) {
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.max(0.3, Math.min(3, targetWidth / vp1.width));
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const blob = await this.canvasToBlob(canvas, 'image/jpeg', quality);
        canvas.width = 0;
        canvas.height = 0;
        return blob;
    },

    registerImage(ctx, blob, mediaType) {
        ctx.imageCounter++;
        const num = String(ctx.imageCounter).padStart(4, '0');
        const ext = mediaType === 'image/png' ? 'png' : 'jpg';
        const ref = { id: 'img' + num, href: `images/img_${num}.${ext}`, mediaType, blob };
        ctx.images.push(ref);
        return ref;
    },

    // ---------------------------------------------------------------------
    // 3. Paragraf / Başlık / Bölüm Oluşturma
    // ---------------------------------------------------------------------
    computeBodyFontSize(pages) {
        const hist = new Map();
        pages.forEach(pg => {
            (pg.lines || []).forEach(l => {
                const key = Math.round(l.fontSize * 2) / 2;
                const chars = l.text.replace(/\s+/g, '').length;
                hist.set(key, (hist.get(key) || 0) + chars);
            });
        });
        let best = 10;
        let bestCount = -1;
        hist.forEach((count, size) => {
            if (count > bestCount) {
                bestCount = count;
                best = size;
            }
        });
        return best || 10;
    },

    runsText(runs) {
        return (runs || []).map(r => r.text).join('');
    },

    appendLineToBlock(block, line) {
        const lastRun = block.runs[block.runs.length - 1];
        const firstText = line.runs.length > 0 ? line.runs[0].text : '';
        if (lastRun && /[A-Za-zÀ-ÖØ-öø-ÿĞğİıŞş]-$/.test(lastRun.text.trimEnd()) && /^[a-zà-öø-ÿçğıöşü]/.test(firstText.trimStart())) {
            // Satır sonu tirelemesini kaldırıp kelimeyi birleştir
            lastRun.text = lastRun.text.trimEnd().slice(0, -1);
        } else {
            block.runs.push({ text: ' ', bold: false, italic: false });
        }
        line.runs.forEach(r => block.runs.push({ text: r.text, bold: r.bold, italic: r.italic }));
    },

    buildPageBlocks(pg, B) {
        if (!pg) return [];
        if (pg.fullImage) {
            return [{ type: 'img', ref: pg.fullImage, widthPct: 100, fullPage: true }];
        }

        const lines = pg.lines || [];
        const imgs = (pg.images || []).slice().sort((a, b) => a.top - b.top);
        const pageW = pg.width || 600;

        // Resimleri metin akışında doğru konuma yerleştir
        const seq = [];
        let imgIdx = 0;
        lines.forEach(line => {
            while (imgIdx < imgs.length && imgs[imgIdx].top <= line.top + 1) {
                seq.push({ kind: 'img', data: imgs[imgIdx++] });
            }
            seq.push({ kind: 'line', data: line });
        });
        while (imgIdx < imgs.length) seq.push({ kind: 'img', data: imgs[imgIdx++] });

        const blocks = [];
        let para = null;
        const flush = () => {
            if (para) blocks.push(para);
            para = null;
        };

        for (const el of seq) {
            if (el.kind === 'img') {
                flush();
                blocks.push({ type: 'img', ref: el.data.ref, widthPct: el.data.widthPct, fullPage: false });
                continue;
            }

            const line = el.data;
            const text = line.text.trim();
            if (!text) continue;
            const fs = line.fontSize;
            const isHeading = fs >= B * 1.28 && text.length <= 160;
            const headingType = fs >= B * 1.6 ? 'h2' : 'h3';

            if (isHeading) {
                if (para && para.type === headingType &&
                    Math.abs(para.fontSize - fs) < fs * 0.12 &&
                    (line.top - para.lastLine.bottom) < fs * 1.3) {
                    this.appendLineToBlock(para, line);
                    para.lastLine = line;
                    continue;
                }
                flush();
                para = {
                    type: headingType,
                    runs: line.runs.map(r => ({ ...r })),
                    fontSize: fs,
                    minX: line.x,
                    maxRight: line.right,
                    lastLine: line,
                    allBold: line.allBold
                };
                continue;
            }

            if (para && para.type === 'p') {
                const prev = para.lastLine;
                const prevText = prev.text.trim();
                const lh = Math.max(fs, prev.fontSize);
                const gap = line.top - prev.bottom;
                const sizeChange = Math.abs(fs - prev.fontSize) > lh * 0.18;
                const bigGap = gap > lh * 0.9;
                const columnJump = line.top < prev.top - lh * 1.5;
                const prevEndsSentence = /[.!?…:;"”’»)\]]$/.test(prevText);
                const indent = line.x - para.minX;
                const indented = indent > lh * 0.9 && indent < pageW * 0.3;
                const prevShort = prev.right < para.maxRight - lh * 2.5;
                const startsBullet = /^([•●▪■◦‣\-–—*]|\d{1,3}[.)]|[a-zA-Z][.)])\s/.test(text);
                const boldChange = line.allBold !== prev.allBold && (line.allBold || prev.allBold);

                let newPara = sizeChange || bigGap || startsBullet || boldChange ||
                    (indented && (prevEndsSentence || prevShort)) ||
                    (prevShort && prevEndsSentence);
                if (columnJump) newPara = prevEndsSentence;

                if (!newPara) {
                    this.appendLineToBlock(para, line);
                    para.lastLine = line;
                    para.minX = Math.min(para.minX, line.x);
                    para.maxRight = Math.max(para.maxRight, line.right);
                    continue;
                }
            }

            flush();
            para = {
                type: 'p',
                runs: line.runs.map(r => ({ ...r })),
                fontSize: fs,
                minX: line.x,
                maxRight: line.right,
                lastLine: line,
                allBold: line.allBold
            };
        }
        flush();
        return blocks;
    },

    shouldMergeAcrossPages(a, b) {
        if (!a || !b || a.type !== 'p' || b.type !== 'p') return false;
        const lastText = this.runsText(a.runs).trim();
        const firstText = this.runsText(b.runs).trim();
        if (!lastText || !firstText) return false;
        if (/[.!?…:"”’»)\]]$/.test(lastText)) return false;
        if (Math.abs((a.fontSize || 0) - (b.fontSize || 0)) > Math.max(a.fontSize || 10, b.fontSize || 10) * 0.18) return false;
        if (/-$/.test(lastText)) return true;
        if (/^[a-zà-öø-ÿçğıöşü(,;]/.test(firstText)) return true;
        return /[,a-zA-ZÀ-ÿ0-9]$/.test(lastText);
    },

    mergePages(pageBlockArrays) {
        const out = [];
        pageBlockArrays.forEach(blocks => {
            (blocks || []).forEach((b, i) => {
                if (i === 0 && b.type === 'p' && out.length > 0) {
                    const last = out[out.length - 1];
                    if (this.shouldMergeAcrossPages(last, b)) {
                        this.appendLineToBlock(last, { runs: b.runs });
                        last.lastLine = b.lastLine;
                        return;
                    }
                }
                out.push(b);
            });
        });
        return out;
    },

    buildChapters(pageBlocks, outline, numPages) {
        let chapters = [];

        // 1. PDF içindekiler (outline) varsa bölümleri ona göre böl
        if (outline && outline.length > 0) {
            const starts = [];
            outline
                .filter(o => o.pageIndex >= 0 && o.pageIndex < numPages)
                .sort((a, b) => a.pageIndex - b.pageIndex)
                .forEach(o => {
                    if (!starts.some(s => s.pageIndex === o.pageIndex)) starts.push(o);
                });

            if (starts.length > 0) {
                if (starts[0].pageIndex > 0) {
                    starts.unshift({ title: 'Front Matter', pageIndex: 0 });
                }
                starts.forEach((s, i) => {
                    const from = s.pageIndex;
                    const to = (i + 1 < starts.length ? starts[i + 1].pageIndex : numPages) - 1;
                    const blocks = this.mergePages(pageBlocks.slice(from, to + 1));
                    chapters.push({ title: s.title, blocks });
                });
            }
        }

        // 2. İçindekiler yoksa büyük başlıklara (h2) göre böl
        if (chapters.length === 0) {
            const merged = this.mergePages(pageBlocks);
            const hChapters = [];
            let cur = null;
            merged.forEach(b => {
                const isMajor = b.type === 'h2';
                if (isMajor && cur && cur.blocks.some(x => x.type === 'p' || x.type === 'img')) {
                    hChapters.push(cur);
                    cur = null;
                }
                if (!cur) cur = { title: null, blocks: [] };
                if (!cur.title && (b.type === 'h2' || b.type === 'h3')) {
                    cur.title = this.runsText(b.runs).replace(/\s+/g, ' ').trim();
                }
                cur.blocks.push(b);
            });
            if (cur) hChapters.push(cur);

            if (hChapters.length >= 2 && hChapters.length <= Math.max(2, numPages)) {
                chapters = hChapters;
            }
        }

        // 3. Hiçbiri yoksa 10'ar sayfalık bölümlere ayır
        if (chapters.length === 0) {
            const chunk = 10;
            for (let from = 0; from < numPages; from += chunk) {
                const to = Math.min(numPages, from + chunk) - 1;
                chapters.push({
                    title: from === to ? `Page ${from + 1}` : `Pages ${from + 1}–${to + 1}`,
                    blocks: this.mergePages(pageBlocks.slice(from, to + 1))
                });
            }
        }

        chapters = chapters.filter(c => c.blocks && c.blocks.length > 0);
        if (chapters.length === 0) {
            chapters.push({ title: 'Content', blocks: [] });
        }
        chapters.forEach((c, i) => {
            let t = (c.title || '').replace(/\s+/g, ' ').trim();
            if (!t) t = `Chapter ${i + 1}`;
            if (t.length > 120) t = t.slice(0, 117) + '...';
            c.title = t;
        });
        return chapters;
    },

    // ---------------------------------------------------------------------
    // 4. EPUB Paketleme (EPUB 3 + NCX geriye uyumluluk)
    // ---------------------------------------------------------------------
    escapeXml(str) {
        return String(str || '')
            .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    runsToHtml(runs) {
        const merged = [];
        let cur = null;
        (runs || []).forEach(r => {
            if (!r.text) return;
            if (cur && cur.bold === r.bold && cur.italic === r.italic) {
                cur.text += r.text;
            } else {
                cur = { text: r.text, bold: !!r.bold, italic: !!r.italic };
                merged.push(cur);
            }
        });
        if (merged.length === 0) return '';
        merged.forEach(r => { r.text = r.text.replace(/\s+/g, ' '); });
        merged[0].text = merged[0].text.replace(/^\s+/, '');
        merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, '');

        let html = '';
        merged.forEach(r => {
            let t = this.escapeXml(r.text);
            if (!t) return;
            if (!t.trim()) {
                html += t;
                return;
            }
            if (r.italic) t = `<i>${t}</i>`;
            if (r.bold) t = `<b>${t}</b>`;
            html += t;
        });
        return html;
    },

    blockToHtml(b) {
        if (!b) return '';
        if (b.type === 'img') {
            const cls = b.fullPage ? 'pdf-page-image' : 'pdf-image';
            return `<div class="${cls}"><img src="../${b.ref.href}" alt="" style="width: ${b.widthPct}%;"/></div>`;
        }
        const inner = this.runsToHtml(b.runs);
        if (!inner.replace(/<[^>]+>/g, '').trim()) return '';
        if (b.type === 'h2' || b.type === 'h3') {
            return `<${b.type}>${inner}</${b.type}>`;
        }
        return `<p>${inner}</p>`;
    },

    xhtmlDoc(title, bodyHtml, lang) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head>
<meta charset="UTF-8"/>
<title>${this.escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/style.css"/>
</head>
<body>
${bodyHtml || '<p>&#160;</p>'}
</body>
</html>`;
    },

    generateUuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    },

    async buildEpub({ title, author, lang, chapters, images, coverBlob }, onPct) {
        const zip = new JSZip();
        const uuid = 'urn:uuid:' + this.generateUuid();
        const safeLang = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i.test(lang || '') ? lang : 'en';
        const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        const esc = (s) => this.escapeXml(s);

        // mimetype mutlaka ilk dosya ve sıkıştırmasız olmalı
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        zip.file('META-INF/container.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`);

        zip.file('OEBPS/styles/style.css',
`body { margin: 0; padding: 0 0.4em; line-height: 1.5; }
p { margin: 0 0 0.85em 0; text-indent: 0; }
h2 { font-size: 1.4em; text-align: center; margin: 1.2em 0 0.8em 0; line-height: 1.3; }
h3 { font-size: 1.15em; margin: 1em 0 0.6em 0; line-height: 1.3; }
.pdf-image { text-align: center; margin: 1em 0; }
.pdf-image img { max-width: 100%; height: auto; }
.pdf-page-image { text-align: center; margin: 0 0 1em 0; }
.pdf-page-image img { width: 100%; max-width: 100%; height: auto; }
.cover { text-align: center; margin: 0; padding: 0; }
.cover img { max-width: 100%; height: auto; }
`);

        const manifest = [
            `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
            `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
            `<item id="css" href="styles/style.css" media-type="text/css"/>`
        ];
        const spine = [];

        if (coverBlob) {
            zip.file('OEBPS/images/cover.jpg', coverBlob, { compression: 'STORE' });
            zip.file('OEBPS/text/cover.xhtml', this.xhtmlDoc('Cover', `<div class="cover"><img src="../images/cover.jpg" alt="Cover"/></div>`, safeLang));
            manifest.push(`<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`);
            manifest.push(`<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`);
            spine.push(`<itemref idref="cover"/>`);
        }

        const navItems = [];
        const ncxPoints = [];
        chapters.forEach((ch, i) => {
            const num = String(i + 1).padStart(3, '0');
            const href = `text/chapter_${num}.xhtml`;
            const body = ch.blocks.map(b => this.blockToHtml(b)).filter(Boolean).join('\n');
            zip.file('OEBPS/' + href, this.xhtmlDoc(ch.title, body, safeLang));
            manifest.push(`<item id="ch${num}" href="${href}" media-type="application/xhtml+xml"/>`);
            spine.push(`<itemref idref="ch${num}"/>`);
            navItems.push(`<li><a href="${href}">${esc(ch.title)}</a></li>`);
            ncxPoints.push(`<navPoint id="np${num}" playOrder="${i + 1}"><navLabel><text>${esc(ch.title)}</text></navLabel><content src="${href}"/></navPoint>`);
        });

        images.forEach(img => {
            zip.file('OEBPS/' + img.href, img.blob, { compression: 'STORE' });
            manifest.push(`<item id="${img.id}" href="${img.href}" media-type="${img.mediaType}"/>`);
        });

        zip.file('OEBPS/nav.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${safeLang}" xml:lang="${safeLang}">
<head><meta charset="UTF-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${navItems.join('\n')}
</ol>
</nav>
</body>
</html>`);

        zip.file('OEBPS/toc.ncx',
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${uuid}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${ncxPoints.join('\n')}
</navMap>
</ncx>`);

        zip.file('OEBPS/content.opf',
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${safeLang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uuid}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(author || 'Unknown Author')}</dc:creator>
<dc:language>${safeLang}</dc:language>
<dc:source>Converted from PDF with EndlessR</dc:source>
<meta property="dcterms:modified">${modified}</meta>
${coverBlob ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>`);

        return await zip.generateAsync(
            {
                type: 'blob',
                mimeType: 'application/epub+zip',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            },
            (meta) => { if (onPct) onPct(meta.percent); }
        );
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => pdfToEpub.init());
} else {
    pdfToEpub.init();
}
