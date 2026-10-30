// ================= EPUB VE PDF OKUYUCU BİLEŞENİ (js/reader.js) =================

const reader = {
    // Aktif kitap durumları
    currentBookId: null,
    currentBookTitle: "",
    currentBookType: null, // 'epub' veya 'pdf'
    bookData: null, // Veritabanından gelen tam kitap nesnesi
    isProcessingSelection: false,
    detectedLang: null,
    sandboxObserver: null,
    
    // EPUB Nesneleri
    epubBook: null,
    epubRendition: null,
    epubLocation: null,

    // PDF Nesneleri
    pdfDocument: null,
    pdfCurrentPage: 1,
    pdfTotalPages: 0,
    pdfRendering: false,
    pdfSavedScrollTop: 0,
    pdfScrollTimeout: null,
    
    epubScrollTimeout: null,
    lastValidScrollY: 0,
    lastValidScrollRatio: 0,
    isUserScrolling: false,
    userScrollTimer: null,
    expandDebounceTimer: null,

    // TTS Kuyruk Durumu
    isSpeakingTTS: false,
    ttsChunks: [],
    ttsCurrentIndex: 0,
    ttsTimeout: null,

    // Mevcut dikey kaydırma konumunu tüm olası kapsayıcılardan güvenli şekilde okur
    getScrollTop() {
        return Math.max(
            window.scrollY || 0,
            window.pageYOffset || 0,
            document.documentElement ? (document.documentElement.scrollTop || 0) : 0,
            document.body ? (document.body.scrollTop || 0) : 0
        );
    },

    // Dikey kaydırma konumunu ayarlar
    setScrollTop(y) {
        const targetY = Math.max(0, Math.round(y || 0));
        window.scrollTo(0, targetY);
        if (document.documentElement && document.documentElement.scrollTop !== targetY) {
            document.documentElement.scrollTop = targetY;
        }
        if (document.body && document.body.scrollTop !== targetY) {
            document.body.scrollTop = targetY;
        }
    },

    // Maksimum dikey kaydırılabilir yüksekliği hesaplar
    getMaxScroll() {
        const docH = Math.max(
            document.documentElement ? (document.documentElement.scrollHeight || 0) : 0,
            document.body ? (document.body.scrollHeight || 0) : 0
        );
        return Math.max(0, docH - window.innerHeight);
    },

    // Aktif EPUB bölüm (spine) indeksini güvenli şekilde döndürür
    getActiveSpineIndex() {
        if (typeof this.lastSpineIndex === 'number') return this.lastSpineIndex;
        try {
            if (this.epubRendition && this.epubRendition.manager && this.epubRendition.manager.views) {
                const views = this.epubRendition.manager.views._views;
                if (Array.isArray(views) && views.length > 0 && views[0].section && typeof views[0].section.index === 'number') {
                    return views[0].section.index;
                }
            }
        } catch (e) {}
        return null;
    },

    // EPUB iframe genişlik ve yüksekliğini kaydırma konumunu (scrollY) bozmadan günceller
    expandEpubIframePreservingScroll() {
        if (this.currentBookType !== 'epub' || !this.epubRendition || this.settings.readerType === 'old') return;
        const savedScrollY = this.getScrollTop();
        try {
            const viewerEl = document.getElementById('epub-viewer');
            const fallbackWidth = (viewerEl && viewerEl.clientWidth > 0) ? viewerEl.clientWidth : window.innerWidth;
            const mgr = this.epubRendition.manager;
            if (mgr && mgr.views && Array.isArray(mgr.views._views)) {
                const stageWidth = (mgr.stage && mgr.stage.container && mgr.stage.container.clientWidth > 0)
                    ? mgr.stage.container.clientWidth
                    : fallbackWidth;
                mgr.views._views.forEach(view => {
                    if (view && view.iframe) {
                        const widthCss = stageWidth > 0 ? (stageWidth + 'px') : '100%';
                        if (view.element) {
                            view.element.style.width = widthCss;
                        }
                        view.iframe.style.width = widthCss;
                        view._width = stageWidth;

                        if (view.document && view.document.body) {
                            const body = view.document.body;
                            const docEl = view.document.documentElement;
                            let newHeight = Math.max(
                                window.innerHeight || 0,
                                body.scrollHeight || 0,
                                body.offsetHeight || 0,
                                docEl ? (docEl.offsetHeight || 0) : 0
                            );
                            if (view.contents && typeof view.contents.textHeight === 'function') {
                                try {
                                    const th = view.contents.textHeight();
                                    if (th > newHeight) newHeight = th;
                                } catch (e) {}
                            }
                            if (newHeight > 0 && Math.abs((view._height || 0) - newHeight) > 4) {
                                view._height = newHeight;
                                if (view.element) view.element.style.height = newHeight + 'px';
                                view.iframe.style.height = newHeight + 'px';
                            }
                        }
                    }
                });
            }
        } catch (e) {
            console.warn("Iframe boyutu güncellenirken hata:", e);
        }
        if (savedScrollY > 0 && Math.abs(this.getScrollTop() - savedScrollY) > 2) {
            this.setScrollTop(savedScrollY);
        }
    },

    scheduleExpandEpubIframe(delay = 100) {
        if (this.expandDebounceTimer) clearTimeout(this.expandDebounceTimer);
        this.expandDebounceTimer = setTimeout(() => {
            this.expandDebounceTimer = null;
            this.expandEpubIframePreservingScroll();
        }, delay);
    },

    // EPUB İlerleme Hesaplama ve Arayüz Senkronizasyonu (Tek Merkezli)
    async updateEpubProgressUI(saveToDb = true) {
        if (this.currentBookType !== 'epub' || !this.epubRendition || !this.epubBook) return;

        try {
            // Scrolled modda currentLocation() çağrısı epub.js içinde updateLayout() -> setLayout() tetikleyip
            // iframe boyutunu ve çeviri DOM'unu sıfırladığı için mevcut location nesnesini doğrudan kullan
            let location = this.epubRendition.location;
            if ((!location || !location.start) && this.settings.readerType === 'old') {
                location = this.epubRendition.currentLocation();
            }
            if (!location || !location.start) {
                const fallbackIdx = this.getActiveSpineIndex();
                if (fallbackIdx === null) return;
                const spineItem = this.epubBook.spine ? this.epubBook.spine.get(fallbackIdx) : null;
                location = {
                    start: {
                        index: fallbackIdx,
                        href: spineItem ? spineItem.href : '',
                        cfi: this.epubLocation || ''
                    }
                };
            }

            if (location.start.cfi) {
                this.epubLocation = location.start.cfi;
            }

            const activeIdx = this.getActiveSpineIndex();
            const currentSpineIndex = typeof location.start.index === 'number'
                ? location.start.index
                : (typeof activeIdx === 'number' ? activeIdx : 0);
            const totalSpineItems = (this.epubBook.spine && this.epubBook.spine.length) ? this.epubBook.spine.length : 1;

            const hasToc = this.numberedChapters && this.numberedChapters.length > 0;
            let currentStep = currentSpineIndex + 1;
            let totalSteps = totalSpineItems;
            let chapterTitle = "";

            if (hasToc) {
                const activeIndex = this.findActiveTocIndex({
                    start: {
                        index: currentSpineIndex,
                        href: location.start.href || ''
                    }
                });
                totalSteps = this.numberedChapters.length;
                if (activeIndex !== -1) {
                    currentStep = activeIndex + 1;
                    chapterTitle = this.numberedChapters[activeIndex].label || "";
                } else {
                    // Fallback: Spine oranına göre yaklaşık bölüm
                    currentStep = Math.min(totalSteps, Math.max(1, Math.round(((currentSpineIndex + 1) / totalSpineItems) * totalSteps)));
                    chapterTitle = this.numberedChapters[currentStep - 1] ? this.numberedChapters[currentStep - 1].label : "";
                }
            }

            const progressPercent = Math.min(100, Math.max(0, Math.round((currentStep / totalSteps) * 100)));

            const progressSlider = document.getElementById('reader-progress-slider');
            if (progressSlider) {
                progressSlider.min = 1;
                progressSlider.max = totalSteps;
                progressSlider.step = 1;
                progressSlider.value = currentStep;
            }

            const labelText = chapterTitle
                ? `Chapter ${currentStep}: ${chapterTitle} (${currentStep} / ${totalSteps})`
                : `Chapter ${currentStep} / ${totalSteps}`;

            this.updateProgressBar(currentStep, progressPercent, labelText);

            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Chapter ${currentStep} / ${totalSteps} (${progressPercent}%)`;
            }

            if (this.bookData) {
                this.bookData.progressPercent = progressPercent;
                this.bookData.lastLocation = this.epubLocation;
            }

            if (saveToDb && this.currentBookId && this.epubLocation) {
                await booksDb.updateProgress(this.currentBookId, progressPercent, this.epubLocation);
            }
        } catch (e) {
            console.warn("EPUB ilerleme güncelleme hatası:", e);
        }
    },

    // EPUB Dikey Kaydırma Konumunu Kaydetme Yardımcısı
    saveEpubScrollLocation() {
        if (this.currentBookType !== 'epub' || !this.epubRendition) return;
        
        if (this.epubScrollTimeout) clearTimeout(this.epubScrollTimeout);
        this.epubScrollTimeout = setTimeout(async () => {
            await this.updateEpubProgressUI(true);
        }, 600);
    },

    // Bölüm içindeki dikey okuma konumunu kitap bazında kalıcı olarak kaydeder (ana sayfaya çıkıp dönünce kaldığı yerden devam için)
    saveReadingPosition(allowZero = false) {
        if (!this.currentBookId || this.isRestoringPosition) return;
        if (this.currentBookType !== 'epub') return;
        const spineIndex = this.getActiveSpineIndex();
        if (spineIndex === null || spineIndex === undefined) return;

        const liveScrollY = this.getScrollTop();
        const maxScroll = this.getMaxScroll();

        let scrollY = liveScrollY;
        let ratio = maxScroll > 0 ? (liveScrollY / maxScroll) : 0;

        if (liveScrollY > 0) {
            this.lastValidScrollY = liveScrollY;
            if (maxScroll > 0) this.lastValidScrollRatio = ratio;
        } else if (!allowZero) {
            // Sayfadan çıkarken veya tarayıcı geri tuşunda (popstate) scrollY anlık 0'a düşerse
            // kullanıcının bölüm ortasındaki son geçerli konumunu koru, 0 ile ezme
            if (this.lastValidScrollY > 0) {
                scrollY = this.lastValidScrollY;
                ratio = this.lastValidScrollRatio > 0 ? this.lastValidScrollRatio : (maxScroll > 0 ? scrollY / maxScroll : 0);
            } else {
                const existing = this.getSavedReadingPosition(this.currentBookId);
                if (existing && existing.spineIndex === spineIndex && (existing.scrollY > 0 || existing.ratio > 0)) {
                    return;
                }
            }
        }

        const data = {
            spineIndex: spineIndex,
            scrollY: Math.round(scrollY),
            ratio: ratio,
            cfi: this.epubLocation || null,
            ts: Date.now()
        };
        try { localStorage.setItem('endlessr_pos_' + this.currentBookId, JSON.stringify(data)); } catch (e) {}
    },

    getSavedReadingPosition(bookId) {
        try {
            const raw = localStorage.getItem('endlessr_pos_' + bookId);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    },

    // Kitap açıldığında kayıtlı bölüm içi konuma anında (tek seferde, üst kısmı göstermeden) geri kaydırır
    async restoreEpubReadingPosition(bookId) {
        const epubViewerEl = document.getElementById('epub-viewer');
        const revealAndFinish = () => {
            if (epubViewerEl) epubViewerEl.style.opacity = '1';
            if (this.currentBookId === bookId) this.isRestoringPosition = false;
        };

        let saved = this.getSavedReadingPosition(bookId);
        if (!saved) {
            try {
                const raw = sessionStorage.getItem('endlessr_reader_scroll');
                const s = raw ? JSON.parse(raw) : null;
                if (s && s.bookId === bookId && s.scrollY > 0) {
                    saved = { spineIndex: s.spineIndex, scrollY: s.scrollY, ratio: 0 };
                }
            } catch (e) {}
        }
        if (!saved || (!(saved.ratio > 0) && !(saved.scrollY > 0))) {
            revealAndFinish();
            return;
        }

        const activeSpine = this.getActiveSpineIndex();
        if (saved.spineIndex !== undefined && saved.spineIndex !== null && activeSpine !== null && saved.spineIndex !== activeSpine) {
            revealAndFinish();
            return;
        }

        // Son geçerli konumu kayıtlı değerle hazırla
        this.lastValidScrollY = saved.scrollY || 0;
        this.lastValidScrollRatio = saved.ratio || 0;

        // Iframe yüksekliğini tek seferde tam aç ve hedef piksel konumuna anında (0 gecikmeyle) git
        this.expandEpubIframePreservingScroll();

        const applyScrollOnce = () => {
            const maxScroll = this.getMaxScroll();
            const target = (saved.scrollY > 0)
                ? saved.scrollY
                : ((saved.ratio > 0 && maxScroll > 0) ? Math.round(saved.ratio * maxScroll) : 0);
            const clampedTarget = maxScroll > 0 ? Math.min(target, maxScroll) : target;

            if (clampedTarget > 0) {
                this.setScrollTop(clampedTarget);
                this.lastValidScrollY = clampedTarget;
                if (maxScroll > 0) this.lastValidScrollRatio = clampedTarget / maxScroll;
            }
        };

        applyScrollOnce();

        // Tek bir frame sonra boyutu ve konumu kesinleştirip görünür yap (2 saniyelik kademeli kaydırma yok)
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (this.currentBookId === bookId) {
            this.expandEpubIframePreservingScroll();
            applyScrollOnce();
        }
        revealAndFinish();
    },

    // epub.js, pencere yüksekliği/genişliği değiştiğinde (mobil adres çubuğu, Google Çeviri çubuğu, scrollbar)
    // bölümü silip (clear) yeniden çiziyordu (display). Bu da çeviri sırasında sayfanın sürekli yenilenip
    // en üste atılmasına ve takılmasına yol açıyordu. Kaydırmalı modda bu yıkıcı yeniden çizimi tamamen devre dışı bırak.
    patchEpubResizeHandling() {
        const rendition = this.epubRendition;
        if (!rendition) return;

        const apply = () => {
            if (this.settings.readerType === 'old') return;

            // Rendition.onResized'ın bölümü baştan yüklemesini (this.display) engelle
            rendition.onResized = () => {
                this.scheduleExpandEpubIframe(80);
            };

            const mgr = rendition.manager;
            if (!mgr || mgr.__endlessrResizePatched) return;

            // Stage'in window resize/orientationchange dinleyicilerini kaldır
            if (mgr.stage) {
                if (mgr.stage.resizeFunc) {
                    window.removeEventListener('resize', mgr.stage.resizeFunc, false);
                    window.removeEventListener('resize', mgr.stage.resizeFunc);
                }
                if (mgr.stage.orientationChangeFunc) {
                    window.removeEventListener('orientationchange', mgr.stage.orientationChangeFunc, false);
                    window.removeEventListener('orientationchange', mgr.stage.orientationChangeFunc);
                }
            }

            // Manager resize / onResized metodlarının clear() çağırmasını engelle
            mgr.onResized = () => {
                this.scheduleExpandEpubIframe(80);
            };
            mgr.onOrientationChange = () => {
                this.scheduleExpandEpubIframe(150);
            };
            mgr.resize = () => {
                this.scheduleExpandEpubIframe(80);
            };

            mgr.__endlessrResizePatched = true;
        };

        apply();
        if (rendition.started && typeof rendition.started.then === 'function') {
            rendition.started.then(apply).catch(() => {});
        }
    },

    savePdfScrollLocation() {
        if (this.currentBookType !== 'pdf' || !this.pdfDocument || !this.currentBookId) return;
        const pageNum = this.pdfCurrentPage;
        const scrollTop = Math.round(this.getScrollTop());
        const lastLocationString = `${pageNum};${scrollTop}`;
        const percent = Math.round((pageNum / this.pdfTotalPages) * 100);

        if (this.bookData) {
            this.bookData.progressPercent = percent;
            this.bookData.lastLocation = lastLocationString;
        }
        try {
            localStorage.setItem('endlessr_pdf_pos_' + this.currentBookId, lastLocationString);
        } catch (e) {}

        if (this.pdfScrollTimeout) clearTimeout(this.pdfScrollTimeout);
        this.pdfScrollTimeout = setTimeout(async () => {
            try {
                await booksDb.updateProgress(this.currentBookId, percent, lastLocationString);
            } catch (e) {
                console.warn("PDF scroll kaydetme hatası:", e);
            }
        }, 400);
    },

    // Okuyucu Stil Ayarları (IndexedDB'den veya varsayılan)
    settings: {
        fontSize: 100, // yüzdelik
        fontFamily: "system-ui",
        lineHeight: 1.6,
        theme: "dark",
        colorMode: "dark",
        tapToTranslate: false,
        padding: 8,
        fixSpacing: false,
        smartReformat: false,
        readerType: "single",
        translationService: "web",
        autoUnlock: false
    },

    async openBook(bookId, options = {}) {
        try {
            // Kitabı IndexedDB'den al
            const book = await booksDb.getBook(bookId);
            if (!book) throw new Error("Book not found in database.");

            // Eğer kitap dosyası yoksa
            if (!book.file) {
                alert("Book file not found.");
                return;
            }

            this.currentBookId = bookId;
            this.currentBookTitle = book.title;
            this.currentBookType = book.type;
            this.bookData = book;
            this.detectedLang = book.detectedLang || null;
            this.isRestoringBook = !!(options && options.isRestore);
            // Kitap yüklenirken (bölüm başı görünürken) kayıtlı konumun üzerine yazılmasını engelle
            this.isRestoringPosition = true;

            // Arayüzü hazırla
            document.getElementById('reader-book-title').textContent = book.title;
            document.getElementById('view-reader').style.display = 'flex';

            document.documentElement.classList.add('reader-active');
            document.body.classList.add('reader-active');
            
            // Başlangıçta üst bar ve alt ayar panelini kapalı yap
            const readerHeader = document.querySelector('.reader-header');
            if (readerHeader) readerHeader.classList.remove('open');
            const optionsPanel = document.getElementById('reader-options-panel');
            if (optionsPanel) optionsPanel.classList.remove('open');

            // Options panelindeki kitap kapak ve başlık bilgilerini doldur
            const panelBookTitle = document.getElementById('panel-book-title');
            const panelBookAuthor = document.getElementById('panel-book-author');
            const panelBookCoverContainer = document.getElementById('panel-book-cover-container');
            
            if (panelBookTitle) panelBookTitle.textContent = book.title;
            if (panelBookAuthor) panelBookAuthor.textContent = book.author || "Unknown Author";
            
            if (panelBookCoverContainer) {
                if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                    panelBookCoverContainer.innerHTML = `<img src="${book.coverUrl}" alt="${book.title}" style="width:100%; height:100%; object-fit:cover;">`;
                } else {
                    const placeholder = utils.generateGradientPlaceholder(book.title, book.author);
                    panelBookCoverContainer.innerHTML = `<img src="${placeholder}" alt="${book.title}" style="width:100%; height:100%; object-fit:cover;">`;
                }
            }
            
            // Okuyucu navigasyon geçmişi takibi için durum sıfırlama
            this.lastSpineIndex = null;
            this.lastEpubCfi = null;
            this.lastPdfPage = null;
            this.lastValidScrollY = 0;
            this.lastValidScrollRatio = 0;

            // Ayarları yükle (Ana sayfa temasıyla senkronize kitap içi tema ayarları)
            this.settings.fontSize = await settingsDb.get('readerFontSize', 100);
            this.settings.fontFamily = await settingsDb.get('readerFontFamily', 'system-ui');
            this.settings.lineHeight = await settingsDb.get('readerLineHeight', 1.6);

            // Ana sayfanın mevcut aktif temasını doğrudan DOM ve localStorage üzerinden al
            const isBodyLight = document.body.classList.contains('theme-light');
            const targetMode = isBodyLight ? 'light' : 'dark';
            this.settings.colorMode = targetMode;
            try { localStorage.setItem('endlessr_reader_color_mode', targetMode); } catch (e) {}
            await settingsDb.set('readerColorMode', targetMode);

            let savedTheme = null;
            try { savedTheme = localStorage.getItem('endlessr_reader_theme'); } catch (e) {}
            if (!savedTheme) {
                savedTheme = await settingsDb.get('readerTheme', targetMode);
            }
            if (this.isLightTheme(savedTheme) !== (targetMode === 'light')) {
                const lastLocalKey = targetMode === 'light' ? 'endlessr_last_light_theme' : 'endlessr_last_dark_theme';
                const lastDbKey = targetMode === 'light' ? 'readerLastLightTheme' : 'readerLastDarkTheme';
                let remembered = null;
                try { remembered = localStorage.getItem(lastLocalKey); } catch (e) {}
                if (!remembered) {
                    remembered = await settingsDb.get(lastDbKey, targetMode);
                }
                savedTheme = (this.isLightTheme(remembered) === (targetMode === 'light')) ? remembered : targetMode;
                try { localStorage.setItem('endlessr_reader_theme', savedTheme); } catch (e) {}
                await settingsDb.set('readerTheme', savedTheme);
            }
            this.settings.theme = savedTheme;
            
            this.settings.tapToTranslate = await settingsDb.get('readerTapToTranslate', false);
            this.settings.padding = await settingsDb.get('readerPadding', 8);
            this.settings.fixSpacing = await settingsDb.get('readerFixSpacing', false);
            this.settings.smartReformat = await settingsDb.get('readerSmartReformat', false);
            this.settings.readerType = await settingsDb.get('readerType', 'single');
            this.settings.translationService = await settingsDb.get('readerTranslationService', 'none');
            this.settings.autoUnlock = await settingsDb.get('readerAutoUnlock', false);
            this.settings.webService = await settingsDb.get('readerWebService', 'google');
            this.settings.targetLang = await settingsDb.get('readerTargetLang', 'tr');

            // Dropdown değerlerini seç
            const webServiceSelect = document.getElementById('wtr-select-service');
            if (webServiceSelect) webServiceSelect.value = this.settings.webService;

            const targetLangSelect = document.getElementById('wtr-select-target-lang');
            if (targetLangSelect) targetLangSelect.value = this.settings.targetLang;
            
            // Stil ekranındaki alanları güncelle
            document.getElementById('font-size-val').textContent = this.settings.fontSize + '%';
            document.getElementById('lineheight-val').textContent = this.settings.lineHeight;
            document.getElementById('padding-val').textContent = this.settings.padding + 'px';
            this.updateFixSpacingUI();
            this.updateSmartReformatUI();

            // Yazı tipi butonlarının aktiflik durumunu senkronize et
            document.querySelectorAll('.font-family-btn').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-font') === this.settings.fontFamily);
            });
            
            // WTR Settings Tabındaki Butonları ve Elemanları Güncelle
            document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-readertype-"]').forEach(btn => btn.classList.remove('active'));
            const typeBtn = document.getElementById(`btn-readertype-${this.settings.readerType}`);
            if (typeBtn) typeBtn.classList.add('active');

            document.getElementById('btn-webtheme-light').classList.toggle('active', this.settings.colorMode === 'light');
            document.getElementById('btn-webtheme-dark').classList.toggle('active', this.settings.colorMode === 'dark');

            document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-trans-"]').forEach(btn => btn.classList.remove('active'));
            const transBtn = document.getElementById(`btn-trans-${this.settings.translationService}`);
            if (transBtn) transBtn.classList.add('active');
            await this.updateTranslationSettingsUI();

            const autoUnlockToggle = document.getElementById('toggle-auto-unlock');
            if (autoUnlockToggle) {
                autoUnlockToggle.checked = this.settings.autoUnlock;
            }

            // WTR Reader Theme butonlarını kitap içi renk moduna göre dinamik olarak güncelle
            this.updateReaderThemeUI(this.settings.colorMode);
            
            // Okuyucu alanlarını sıfırla
            document.getElementById('epub-viewer').style.display = 'none';
            document.getElementById('pdf-viewer').style.display = 'none';
            document.getElementById('pdf-page-indicator').style.display = 'none';
            document.getElementById('btn-prev-page').style.display = 'none';
            document.getElementById('btn-next-page').style.display = 'none';

            // Kitap yüklenmeden önce okuyucu temasını hazırla
            await this.setReaderTheme(this.settings.theme, false);

            const savedPos = (book.type === 'epub') ? this.getSavedReadingPosition(bookId) : null;
            let targetStartLocation = (options && options.restoreLocation !== undefined && options.restoreLocation !== null)
                ? options.restoreLocation
                : ((savedPos && savedPos.cfi) ? savedPos.cfi : book.lastLocation);

            if (book.type === 'pdf' && (!options || options.restoreLocation === undefined || options.restoreLocation === null)) {
                try {
                    const savedPdfLoc = localStorage.getItem('endlessr_pdf_pos_' + bookId);
                    if (savedPdfLoc) targetStartLocation = savedPdfLoc;
                } catch (e) {}
            }

            const epubViewerEl = document.getElementById('epub-viewer');
            const hasSavedEpubScroll = !!(book.type === 'epub' && this.settings.readerType !== 'old' && savedPos && (savedPos.scrollY > 0 || savedPos.ratio > 0));
            if (epubViewerEl) {
                epubViewerEl.style.opacity = hasSavedEpubScroll ? '0' : '1';
            }

            // Kitap tipine göre okuyucuyu başlat
            if (book.type === 'epub') {
                await this.initEpub(book.file, targetStartLocation);
            } else if (book.type === 'pdf') {
                await this.initPdf(book.file, targetStartLocation);
            }

            // Temayı uygula
            await this.setReaderTheme(this.settings.theme, false);

            // Bölüm içi kaldığı yere anında geri dön (üst kısmı hiç göstermeden)
            if (book.type === 'epub' && this.settings.readerType !== 'old') {
                await this.restoreEpubReadingPosition(bookId);
            } else {
                if (epubViewerEl) epubViewerEl.style.opacity = '1';
                this.isRestoringPosition = false;
                if (this.isRestoringBook) {
                    try {
                        const rawScroll = sessionStorage.getItem('endlessr_reader_scroll');
                        if (rawScroll) {
                            const savedScroll = JSON.parse(rawScroll);
                            if (savedScroll && savedScroll.bookId === bookId && savedScroll.scrollY > 0) {
                                this.setScrollTop(savedScroll.scrollY);
                            }
                        }
                    } catch (e) {}
                }
            }
            this.isRestoringBook = false;

            // Son okuma zamanını güncelle
            book.lastReadAt = Date.now();
            await booksDb.saveBook(book);
            
            // Kütüphaneyi arka planda yenile
            if (window.app) window.app.loadLibrary();

            // Bind voice synthesis voices loaded event
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = () => {
                    this.populateVoices();
                };
                this.populateVoices();
            }

        } catch (err) {
            const epubViewerEl = document.getElementById('epub-viewer');
            if (epubViewerEl) epubViewerEl.style.opacity = '1';
            this.isRestoringBook = false;
            this.isRestoringPosition = false;
            console.error("Error opening book:", err);
            alert("Could not load book.");
            this.closeReader();
        }
    },

    // 2. EPUB Okuyucu Başlatıcı
    async initEpub(fileBuffer, startLocation) {
        const epubViewerEl = document.getElementById('epub-viewer');
        epubViewerEl.style.display = 'block';
        document.getElementById('btn-prev-page').style.display = 'none';
        document.getElementById('btn-next-page').style.display = 'none';

        // Eski kitap nesnesi varsa yok et ve kapsayıcıyı temizle
        if (this.epubBook) {
            try { this.epubBook.destroy(); } catch (e) {}
        }
        epubViewerEl.innerHTML = '';

        // Iframe dışı (boş alan) tıklamalarında da alt menü panelinin açılıp kapanmasını sağla
        if (!epubViewerEl.__endlessrClickBound) {
            epubViewerEl.addEventListener('click', (e) => {
                if (e.target && e.target.tagName === 'IFRAME') return;
                const popover = document.getElementById('translate-popover');
                if (popover && popover.style.display === 'flex') {
                    this.hidePopover();
                    return;
                }
                const tocPanel = document.getElementById('toc-panel');
                if (tocPanel && tocPanel.classList.contains('open')) {
                    this.closeTOCPanel();
                    return;
                }
                const panel = document.getElementById('reader-options-panel');
                if (panel) {
                    if (panel.classList.contains('open')) {
                        this.closeStylePanel();
                    } else {
                        this.openStylePanel();
                    }
                }
            });
            epubViewerEl.__endlessrClickBound = true;
        }

        // EpubJS yükleme
        this.epubBook = ePub(fileBuffer);
        
        const rType = this.settings.readerType || "single";
        let epubFlow = "scrolled";
        let epubManager = "default";
        
        if (rType === "infinite") {
            epubFlow = "scrolled";
            epubManager = "continuous";
        } else if (rType === "old") {
            epubFlow = "paginated";
            epubManager = "default";
        }
        
        // Show/hide side navigation arrows based on reader type
        const prevArrow = document.getElementById('btn-prev-page');
        const nextArrow = document.getElementById('btn-next-page');
        
        if (rType === "old") {
            if (prevArrow) prevArrow.style.display = 'flex';
            if (nextArrow) nextArrow.style.display = 'flex';
        } else {
            if (prevArrow) prevArrow.style.display = 'none';
            if (nextArrow) nextArrow.style.display = 'none';
        }

        this.epubRendition = this.epubBook.renderTo("epub-viewer", {
            width: "100%",
            height: rType === "old" ? window.innerHeight : "100%",
            flow: epubFlow,
            manager: epubManager,
            allowScriptedContent: true
        });

        // Yükseklik değişimlerinde (adres çubuğu / çeviri) bölümün silinip yeniden çizilmesini engelle
        this.patchEpubResizeHandling();

        // İçindekiler listesini yükle
        await this.loadEpubToc();

        // Stil ayarlarını uygula
        this.applyEpubStyles();

        // Dinamik kapak onarımı (Eğer blob veya eksik ise Base64'e dönüştürüp kalıcı kaydet)
        this.epubBook.ready.then(async () => {
            if (!this.bookData.coverUrl || this.bookData.coverUrl.startsWith('blob:')) {
                try {
                    const coverPath = await this.epubBook.coverUrl();
                    if (coverPath) {
                        const response = await fetch(coverPath);
                        const blob = await response.blob();
                        const base64Url = await new Promise((res, rej) => {
                            const fileReader = new FileReader();
                            fileReader.onloadend = () => res(fileReader.result);
                            fileReader.onerror = rej;
                            fileReader.readAsDataURL(blob);
                        });
                        this.bookData.coverUrl = base64Url;
                        await booksDb.saveBook(this.bookData);
                        
                        const panelBookCoverContainer = document.getElementById('panel-book-cover-container');
                        if (panelBookCoverContainer) {
                            panelBookCoverContainer.innerHTML = `<img src="${base64Url}" alt="${this.bookData.title}" style="width:100%; height:100%; object-fit:cover;">`;
                        }
                        if (window.app) window.app.loadLibrary();
                    }
                } catch (coverErr) {
                    console.warn("Dinamik kapak onarımı başarısız:", coverErr);
                }
            }
        });

        // Sayfa geçiş dinleyicisi (Progress Kaydetme)
        this.epubRendition.on("relocated", (location) => {
            if (location && location.start && location.start.cfi) {
                this.epubLocation = location.start.cfi;
            }
            const hasNumericIndex = !!(location && location.start && typeof location.start.index === 'number');
            const fallbackIndex = this.getActiveSpineIndex();
            const currentSpineIndex = hasNumericIndex
                ? location.start.index
                : (typeof fallbackIndex === 'number' ? fallbackIndex : 0);

            const spineChanged = this.lastSpineIndex !== null &&
                                 typeof this.lastSpineIndex === 'number' &&
                                 hasNumericIndex &&
                                 this.lastSpineIndex !== currentSpineIndex;
            const cfi = (location && location.start && location.start.cfi) ? location.start.cfi : this.epubLocation;

            this.updateEpubProgressUI(true);
            
            // Bölüm veya sayfa geçişinde geçmişe kaydet (NavHistory)
            if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
                if (this.isRestoringBook) {
                    navHistory.updateTopReaderLocation(cfi, currentSpineIndex);
                } else if (this.settings.readerType === 'old') {
                    if (this.lastEpubCfi !== cfi && cfi) {
                        navHistory.push({
                            type: 'reader',
                            bookId: this.currentBookId,
                            bookType: 'epub',
                            location: cfi,
                            spineIndex: currentSpineIndex
                        });
                    }
                } else {
                    if (this.lastSpineIndex !== currentSpineIndex) {
                        navHistory.push({
                            type: 'reader',
                            bookId: this.currentBookId,
                            bookType: 'epub',
                            location: cfi,
                            spineIndex: currentSpineIndex
                        });
                    } else {
                        navHistory.updateTopReaderLocation(cfi, currentSpineIndex);
                    }
                }
            }
            this.lastSpineIndex = currentSpineIndex;
            this.lastEpubCfi = cfi;

            // Yalnızca gerçek bölüm değişiminde (ve geri yükleme yapılmıyorken) en üste kaydır ve yeni bölümü 0 olarak kaydet
            const viewer = document.getElementById('epub-viewer');
            if (viewer) viewer.scrollTop = 0;
            if (spineChanged && !this.isRestoringBook && !this.isRestoringPosition && this.settings.readerType !== 'infinite') {
                this.lastValidScrollY = 0;
                this.lastValidScrollRatio = 0;
                this.setScrollTop(0);
                this.saveReadingPosition(true);
                try { sessionStorage.removeItem('endlessr_reader_scroll'); } catch (e) {}
            }
        });

        // EPUB Lokasyonları Hazır Olduğunda
        this.epubBook.ready.then(() => {
            this.updateEpubProgressUI(false);
        });

        // EPUB İçi Metin Seçim Dinleyicisi (Çeviri Popover Tetikleyici)
        this.epubRendition.on("selected", async (cfiRange, contents) => {
            if (this.settings.tapToTranslate) return;
            if (contents && contents.window && contents.document) {
                this.scheduleProcessSelection(contents.window, contents.document, 120);
            }
        });

        // EPUB Tek Tıklama ile Kelime Çevirisi (Tap to Translate) kancası
        this.epubRendition.hooks.content.register((contents) => {
            try {
                const doc = contents.document;
                const rType = this.settings.readerType || "single";

                // Bölüm indeksini anında yakala (relocated olayını beklemeden)
                if (typeof contents.sectionIndex === 'number' && this.lastSpineIndex === null) {
                    this.lastSpineIndex = contents.sectionIndex;
                }

                // Pencere boyut değişiminde yıkıcı clear/display döngüsünü engelle
                this.patchEpubResizeHandling();
                if (rType !== "old") {
                    if (this.epubRendition && this.epubRendition.manager && this.epubRendition.manager.views) {
                        const views = this.epubRendition.manager.views._views;
                        if (Array.isArray(views)) {
                            views.forEach(v => {
                                if (v && !v.__endlessrExpandWrapped && typeof v.expand === 'function') {
                                    const origExpand = v.expand.bind(v);
                                    v.expand = (floating) => {
                                        const savedScrollY = this.getScrollTop();
                                        try {
                                            origExpand(floating);
                                        } catch (e) {}
                                        this.expandEpubIframePreservingScroll();
                                        if (savedScrollY > 0 && Math.abs(this.getScrollTop() - savedScrollY) > 2) {
                                            this.setScrollTop(savedScrollY);
                                        }
                                    };
                                    v.__endlessrExpandWrapped = true;
                                }
                            });
                        }
                    }

                    // İlk render tamamlandıktan sonra epub.js'in dahili ResizeObserver tetiklemelerini
                    // kaydırma konumunu koruyan expand fonksiyonumuza yönlendir
                    setTimeout(() => {
                        if (contents.observer && typeof contents.observer.disconnect === 'function') {
                            contents.observer.disconnect();
                        }
                        if (contents.expanding) {
                            clearTimeout(contents.expanding);
                        }
                        contents.resizeCheck = () => {
                            this.scheduleExpandEpubIframe(100);
                        };
                        this.expandEpubIframePreservingScroll();
                    }, 300);
                }
                
                // Metin değişikliklerini (find-replace) uygula
                this.applyReplacementsToDoc(doc, this.currentBookId);

                this.applyCustomStylesToDoc(doc);
                
                // Sync to Chrome translation sandbox
                this.syncToTranslationSandbox(doc);
                
                // Eğer tam sayfa çevirisi aktifse, dökümanı çevir
                if (this.settings.translationService === 'web' && this.settings.webService === 'google') {
                    setTimeout(() => {
                        this.translateDocument(doc, this.settings.targetLang);
                    }, 50);
                }

                // Iframe içi dikey kaydırmayı dinle
                contents.window.addEventListener('scroll', () => {
                    this.saveEpubScrollLocation();
                });

                const body = doc.body;
                
                // Sadece 'single' modunda dikey kaydırma sayfa sonuna Önceki / Sonraki Bölüm butonları ekle
                if (rType === "single") {
                    const footerDiv = doc.createElement('div');
                    footerDiv.className = 'epub-chapter-footer';
                    footerDiv.style.cssText = `
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-top: calc(env(safe-area-inset-bottom, 0px) + 40px);
                        padding-top: 20px;
                        border-top: 1px solid rgba(128,128,128,0.2);
                        gap: 16px;
                        margin-bottom: 0px;
                    `;
                    
                    // Önceki Butonu
                    const prevBtn = doc.createElement('button');
                    prevBtn.textContent = 'Previous Chapter';
                    prevBtn.style.cssText = `
                        flex: 1;
                        padding: 12px;
                        border: 1px solid rgba(128,128,128,0.3);
                        background: transparent;
                        color: inherit;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        transition: opacity 0.2s;
                    `;
                    prevBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.prevPage();
                    });
                    
                    // Sonraki Butonu
                    const nextBtn = doc.createElement('button');
                    nextBtn.textContent = 'Next Chapter';
                    nextBtn.style.cssText = `
                        flex: 1;
                        padding: 12px;
                        border: 1px solid rgba(128,128,128,0.3);
                        background: transparent;
                        color: inherit;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        transition: opacity 0.2s;
                    `;
                    nextBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.nextPage();
                    });
                    
                    footerDiv.appendChild(prevBtn);
                    footerDiv.appendChild(nextBtn);
                    body.appendChild(footerDiv);

                    // Add an explicit spacer block to guarantee bottom separation and avoid parent padding collapsing
                    const spacer = doc.createElement('div');
                    spacer.className = 'epub-chapter-spacer';
                    spacer.style.height = '80px';
                    body.appendChild(spacer);
                }

                if (rType !== "old") {
                    this.expandEpubIframePreservingScroll();
                }
                
            } catch (err) {
                console.error("Hook footer yerleştirme hatası:", err);
            }

            // Kelimeye basılı tutulduğunda tarayıcının (Google Chrome) kendi "Kopyala / Tümünü Seç / Web Arama"
            // menüsünün çıkmasını engelle; yalnızca uygulamanın kendi çeviri penceresi ve 2 seçim noktası kalsın
            const suppressNativeContextMenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                return false;
            };
            contents.document.addEventListener('contextmenu', suppressNativeContextMenu, { capture: true, passive: false });
            contents.window.addEventListener('contextmenu', suppressNativeContextMenu, { capture: true, passive: false });
            contents.document.oncontextmenu = () => false;
            if (contents.document.body) {
                contents.document.body.oncontextmenu = () => false;
            }

            // Seçim noktalarını (2 kenardaki tutamaçları) kaybetmeden seçimi ve genişletmeyi dinle
            contents.document.addEventListener('selectionchange', () => {
                const sel = contents.window.getSelection();
                const txt = sel ? sel.toString().trim() : '';
                if (!txt) {
                    if (this.selectionDebounceTimer) {
                        clearTimeout(this.selectionDebounceTimer);
                        this.selectionDebounceTimer = null;
                    }
                    return;
                }
                this.scheduleProcessSelection(contents.window, contents.document, 320);
            });

            contents.document.addEventListener('touchend', () => {
                const sel = contents.window.getSelection();
                if (sel && sel.toString().trim().length > 0) {
                    this.scheduleProcessSelection(contents.window, contents.document, 140);
                }
            }, { passive: true });

            contents.document.addEventListener('mouseup', () => {
                const sel = contents.window.getSelection();
                if (sel && sel.toString().trim().length > 0) {
                    this.scheduleProcessSelection(contents.window, contents.document, 120);
                }
            });

            contents.document.body.addEventListener('click', async (e) => {
                if (!this.settings.tapToTranslate) return;
                if (this.isProcessingSelection) return;
                
                let range;
                if (contents.document.caretRangeFromPoint) {
                    range = contents.document.caretRangeFromPoint(e.clientX, e.clientY);
                }
                
                if (range) {
                    this.expandRangeToWord(range);
                    const word = range.toString().trim();
                    
                    if (word && word.length > 0 && word.length < 50 && /^[a-zA-Z0-9À-ÿçşğüıöÖÇŞĞÜİ'-]+$/i.test(word)) {
                        // DOM'u bozmadan doğal seçim oluştur (2 kenar noktasının kalması için)
                        const sel = contents.window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                        this.scheduleProcessSelection(contents.window, contents.document, 60);
                    }
                }
            });

            // Tek Tıklama ile Seçenekler Panelini Açma/Kapatma
            contents.document.body.addEventListener('click', (e) => {
                // Tıklanan eleman buton veya link ise menüyü tetikleme
                if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
                    return;
                }

                // Seçili metin varsa menüyü tetikleme
                const sel = contents.window.getSelection();
                if (sel && sel.toString().trim().length > 0) {
                    return;
                }

                // Çeviri popover'ı veya İçindekiler (TOC) paneli açıksa önce onları kapat
                const popover = document.getElementById('translate-popover');
                if (popover && popover.style.display === 'flex') {
                    this.hidePopover();
                    return;
                }
                const tocPanel = document.getElementById('toc-panel');
                if (tocPanel && tocPanel.classList.contains('open')) {
                    this.closeTOCPanel();
                    return;
                }

                // Dokunarak Çeviri (tapToTranslate) aktifse ve geçerli bir kelimeye tıklanmışsa menüyü tetikleme
                if (this.settings.tapToTranslate) {
                    let range;
                    if (contents.document.caretRangeFromPoint) {
                        range = contents.document.caretRangeFromPoint(e.clientX, e.clientY);
                    }
                    if (range) {
                        this.expandRangeToWord(range);
                        const word = range.toString().trim();
                        if (word && word.length > 0 && word.length < 50 && /^[a-zA-Z0-9ç-üÖöÇçŞşĞğÜüİı'-]+$/i.test(word)) {
                            return;
                        }
                    }
                }

                const panel = document.getElementById('reader-options-panel');
                if (panel.classList.contains('open')) {
                    this.closeStylePanel();
                } else {
                    this.openStylePanel();
                }
            });
        });

        // Kitabı render et (Tüm olay dinleyicileri ve kancalar kaydedildikten sonra)
        if (startLocation) {
            try {
                await this.epubRendition.display(startLocation);
            } catch (displayErr) {
                console.warn("Kayıtlı başlangıç konumu açılamadı, baştan açılıyor:", displayErr);
                await this.epubRendition.display();
            }
        } else {
            await this.epubRendition.display();
        }
    },

    // EPUB İçindekiler Menüsü Çekme
    async loadEpubToc() {
        try {
            const navigation = await this.epubBook.loaded.navigation;
            const tocList = document.getElementById('toc-list');
            tocList.innerHTML = '';

            this.numberedChapters = [];

            if (navigation && navigation.toc && navigation.toc.length > 0) {
                const flatToc = [];
                const flatten = (items) => {
                    items.forEach(item => {
                        flatToc.push(item);
                        if (item.subitems && item.subitems.length > 0) {
                            flatten(item.subitems);
                        }
                    });
                };
                flatten(navigation.toc);

                // Use all table of contents items in sequence (no filtering, to prevent missing special chapters)
                this.numberedChapters = flatToc;

                flatToc.forEach((chapter, index) => {
                    const item = document.createElement('div');
                    item.className = 'toc-item';
                    // Show our sequence number next to the author's title
                    item.textContent = `${index + 1}. ${chapter.label}`;
                    item.onclick = () => {
                        this.epubRendition.display(chapter.href);
                        this.closeTOCPanel();
                    };
                    tocList.appendChild(item);
                });

                const progressSlider = document.getElementById('reader-progress-slider');
                if (progressSlider && this.numberedChapters.length > 0) {
                    progressSlider.min = 1;
                    progressSlider.max = this.numberedChapters.length;
                    progressSlider.step = 1;
                }
                this.updateEpubProgressUI(false);
            } else {
                tocList.innerHTML = '<p class="empty-text">No table of contents found in this book.</p>';
                this.updateEpubProgressUI(false);
            }
        } catch (e) {
            console.error("Could not load table of contents:", e);
        }
    },

    // EPUB Okuyucu Stillerini Güncelleme
    applyEpubStyles() {
        if (!this.epubRendition) return;

        // Font stili ve satır aralığı
        this.epubRendition.themes.fontSize(this.settings.fontSize + "%");
        
        const lh = this.settings.lineHeight || 1.6;
        const font = this.settings.fontFamily;
        const padding = "0 " + (this.settings.padding !== undefined ? this.settings.padding : 8) + "px";

        // 12 Temayı Kaydet
        this.epubRendition.themes.register("light", {
            body: { background: "#ffffff", color: "#1f2937", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("sepia", {
            body: { background: "#f8efe0", color: "#3c2f1e", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("warm", {
            body: { background: "#faf2e4", color: "#433422", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("ocean", {
            body: { background: "#eef4f8", color: "#1b2b34", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("forest", {
            body: { background: "#eef5eb", color: "#2c3e29", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("rose", {
            body: { background: "#faf0f2", color: "#4a2c3a", "font-family": font, "line-height": lh, "padding": padding }
        });
        
        // Dark Themes
        this.epubRendition.themes.register("dark", {
            body: { background: "#1e222b", color: "#a0aab8", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("night", {
            body: { background: "#0f1115", color: "#ffffff", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("dark-navy", {
            body: { background: "#122435", color: "#8cb3db", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("dark-sepia", {
            body: { background: "#2c2824", color: "#d5c7b9", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("dark-slate", {
            body: { background: "#1b2631", color: "#aabecf", "font-family": font, "line-height": lh, "padding": padding }
        });
        this.epubRendition.themes.register("dark-green", {
            body: { background: "#1b2b20", color: "#a8c3ad", "font-family": font, "line-height": lh, "padding": padding }
        });

        this.epubRendition.themes.select(this.settings.theme);

        // Iframe'lerdeki custom style elementlerini güncelle (Kenar boşlukları, yazı tipleri ve renkleri ezmek için)
        try {
            const iframes = document.querySelectorAll("#epub-viewer iframe");
            iframes.forEach(iframe => {
                if (iframe && iframe.contentDocument) {
                    this.applyCustomStylesToDoc(iframe.contentDocument);
                }
            });
        } catch (e) {
            console.warn("Iframe custom styles update failed:", e);
        }
    },

    // 3. PDF Okuyucu Başlatıcı
    async initPdf(fileBuffer, startPage) {
        document.getElementById('pdf-viewer').style.display = 'flex';
        document.getElementById('pdf-page-indicator').style.display = 'block';

        // PDF.js worker ayarı
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

        const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
        this.pdfDocument = await loadingTask.promise;
        this.pdfTotalPages = this.pdfDocument.numPages;

        document.getElementById('pdf-total-pages').textContent = this.pdfTotalPages;

        // Kaldığı sayfayı ve dikey scroll konumunu belirle
        let savedScrollTop = 0;
        if (startPage && typeof startPage === 'string' && startPage.includes(';')) {
            const parts = startPage.split(';');
            this.pdfCurrentPage = parseInt(parts[0]) || 1;
            savedScrollTop = parseInt(parts[1]) || 0;
        } else {
            this.pdfCurrentPage = startPage ? parseInt(startPage) : 1;
        }
        this.pdfSavedScrollTop = savedScrollTop;

        // PDF Slider ayarla
        const progressSlider = document.getElementById('reader-progress-slider');
        if (progressSlider) {
            progressSlider.min = 1;
            progressSlider.max = this.pdfTotalPages;
            progressSlider.step = 1;
            progressSlider.value = this.pdfCurrentPage;
        }

        await this.renderPdfPage(this.pdfCurrentPage);

        // İlerlemeyi güncelle
        const percent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
        this.updateProgressBar(this.pdfCurrentPage, percent, `Page ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);
        const chIndicator = document.getElementById('panel-chapter-indicator');
        if (chIndicator) {
            chIndicator.textContent = `Page ${this.pdfCurrentPage} / ${this.pdfTotalPages} (${percent}%)`;
        }

        // PDF İçindekiler Yükleme
        this.loadPdfToc();

        // Dinamik kapak onarımı (Eğer blob veya eksik ise PDF'in ilk sayfasından Base64 üret ve kaydet)
        if (!this.bookData.coverUrl || this.bookData.coverUrl.startsWith('blob:')) {
            try {
                const page = await this.pdfDocument.getPage(1);
                const viewport = page.getViewport({ scale: 0.5 });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d');
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;
                const base64Url = canvas.toDataURL('image/jpeg', 0.8);
                
                this.bookData.coverUrl = base64Url;
                await booksDb.saveBook(this.bookData);
                
                const panelBookCoverContainer = document.getElementById('panel-book-cover-container');
                if (panelBookCoverContainer) {
                    panelBookCoverContainer.innerHTML = `<img src="${base64Url}" alt="${this.bookData.title}" style="width:100%; height:100%; object-fit:cover;">`;
                }
                if (window.app) window.app.loadLibrary();
            } catch (e) {
                console.warn("PDF dynamic cover repair failed:", e);
            }
        }
    },

    // PDF Sayfası Render Etme (Canvas + TextLayer)
    async renderPdfPage(pageNumber) {
        if (this.pdfRendering) return;
        this.pdfRendering = true;

        try {
            const page = await this.pdfDocument.getPage(pageNumber);
            const viewerContainer = document.getElementById('pdf-viewer');
            
            // Telefon ekran genişliğini al
            const containerWidth = viewerContainer.clientWidth - 20; // 10px padding payı
            const unscaledViewport = page.getViewport({ scale: 1.0 });
            const scale = containerWidth / unscaledViewport.width;
            const viewport = page.getViewport({ scale: scale });

            // Sayfa kutusunu oluştur
            const pageContainer = document.createElement('div');
            pageContainer.className = 'pdf-page-container glass';
            pageContainer.style.width = Math.floor(viewport.width) + 'px';
            pageContainer.style.height = Math.floor(viewport.height) + 'px';

            // Canvas oluştur
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            pageContainer.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            
            // Sayfayı Canvas'a çiz
            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;

            // Metin Seçebilmek İçin TextLayer Oluştur
            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'textLayer';
            pageContainer.appendChild(textLayerDiv);

            const textContent = await page.getTextContent();
            
            // pdf.js text layer render
            await pdfjsLib.renderTextLayer({
                textContent: textContent,
                container: textLayerDiv,
                viewport: viewport,
                textDivs: []
            }).promise;

            // Metin değişikliklerini (find-replace) uygula
            this.applyReplacementsToPdfElement(textLayerDiv, this.currentBookId);

            // Sayfadaki kelime sayısını hesapla ve sayfa başına ekle
            const pdfPageText = (textContent && Array.isArray(textContent.items))
                ? textContent.items.map(it => it.str || '').join(' ')
                : '';
            const pdfWordCount = (typeof utils !== 'undefined' && utils.countWordsInText)
                ? utils.countWordsInText(pdfPageText)
                : (pdfPageText.trim() ? pdfPageText.trim().split(/\s+/).length : 0);

            const pdfWordBanner = document.createElement('div');
            pdfWordBanner.className = 'endlessr-pdf-word-count notranslate';
            pdfWordBanner.setAttribute('translate', 'no');
            pdfWordBanner.style.cssText = 'width: 100%; max-width: ' + Math.floor(viewport.width) + 'px; text-align: center; font-size: 12px; font-weight: 600; opacity: 0.72; padding: 6px 10px; margin-bottom: 6px; border-bottom: 1px solid rgba(128,128,128,0.2); letter-spacing: 0.2px;';
            const formattedPdfWords = (typeof utils !== 'undefined' && utils.formatNumber)
                ? utils.formatNumber(pdfWordCount)
                : pdfWordCount;
            this.setUntranslatableContent(pdfWordBanner, `📖 ${formattedPdfWords} words on this page`, false);

            // Viewer'ı güncelle
            viewerContainer.innerHTML = '';
            viewerContainer.appendChild(pdfWordBanner);
            viewerContainer.appendChild(pageContainer);

            // Eğer kaydedilmiş bir dikey kaydırma konumu varsa ve açılış sayfasıysa anında uygula
            let appliedScrollTop = 0;
            if (this.pdfSavedScrollTop && pageNumber === this.pdfCurrentPage) {
                appliedScrollTop = this.pdfSavedScrollTop;
                this.pdfSavedScrollTop = 0; // Bir kere uygulandıktan sonra sıfırla
                this.setScrollTop(appliedScrollTop);
                requestAnimationFrame(() => {
                    this.setScrollTop(appliedScrollTop);
                });
            } else {
                this.setScrollTop(0);
            }

            // Sayfa numarasını güncelle
            this.pdfCurrentPage = pageNumber;
            document.getElementById('pdf-current-page').textContent = pageNumber;
            
            // İlerlemeyi güncelle
            const percent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
            this.updateProgressBar(this.pdfCurrentPage, percent, `Page ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);
            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Page ${this.pdfCurrentPage} / ${this.pdfTotalPages} (${percent}%)`;
            }
            const pdfLocStr = `${this.pdfCurrentPage};${appliedScrollTop}`;
            if (this.bookData) {
                this.bookData.progressPercent = percent;
                this.bookData.lastLocation = pdfLocStr;
            }
            try {
                localStorage.setItem('endlessr_pdf_pos_' + this.currentBookId, pdfLocStr);
            } catch (e) {}
            
            // DB'ye kaydet
            booksDb.updateProgress(this.currentBookId, percent, pdfLocStr);
 
            // PDF sayfa geçişini geçmişe kaydet (NavHistory)
            if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
                if (this.isRestoringBook) {
                    navHistory.updateTopReaderLocation(pageNumber, pageNumber);
                } else if (this.lastPdfPage !== pageNumber) {
                    navHistory.push({
                        type: 'reader',
                        bookId: this.currentBookId,
                        bookType: 'pdf',
                        location: pageNumber,
                        spineIndex: pageNumber
                    });
                }
            }
            this.lastPdfPage = pageNumber;

            // Eğer tam sayfa çevirisi aktifse, PDF metin katmanını çevir
            if (this.settings.translationService === 'web' && this.settings.webService === 'google') {
                setTimeout(() => {
                    this.translateDocument(viewerContainer, this.settings.targetLang);
                }, 50);
            }

        } catch (e) {
            console.error("PDF sayfa render hatası:", e);
        } finally {
            this.pdfRendering = false;
        }
    },

    // PDF İçindekiler (Outline) Listesi Yükleme
    async loadPdfToc() {
        const tocList = document.getElementById('toc-list');
        tocList.innerHTML = '';
        
        try {
            const outline = await this.pdfDocument.getOutline();
            if (outline && outline.length > 0) {
                // Basitçe ilk seviye başlıkları ekle
                outline.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'toc-item';
                    div.textContent = item.title;
                    div.onclick = async () => {
                        // PDF sayfa hedefini bulma işlemi (Destinations)
                        if (item.dest) {
                            try {
                                const destRef = typeof item.dest === 'string' ? item.dest : item.dest[0];
                                const pageIndex = await this.pdfDocument.getPageIndex(destRef);
                                this.renderPdfPage(pageIndex + 1);
                                this.closeTOCPanel();
                            } catch(e) {
                                console.warn("Hedef sayfa bulunamadı:", e);
                            }
                        }
                    };
                    tocList.appendChild(div);
                });
            } else {
                // İçindekiler yoksa sayfaları listeleyelim (Hızlı Gezinme)
                for (let i = 1; i <= Math.min(this.pdfTotalPages, 100); i += 5) {
                    const div = document.createElement('div');
                    div.className = 'toc-item';
                    div.textContent = `Page ${i}`;
                    div.onclick = () => {
                        this.renderPdfPage(i);
                        this.closeTOCPanel();
                    };
                    tocList.appendChild(div);
                }
            }
        } catch (e) {
            tocList.innerHTML = '<p class="empty-text">Could not load table of contents.</p>';
        }
    },

    // 4. Genel Sayfa Navigasyonları (EPUB & PDF)
    nextPage() {
        if (this.currentBookType === 'epub' && this.epubRendition) {
            this.epubRendition.next();
        } else if (this.currentBookType === 'pdf' && this.pdfDocument) {
            if (this.pdfCurrentPage < this.pdfTotalPages) {
                this.renderPdfPage(this.pdfCurrentPage + 1);
            }
        }
    },

    prevPage() {
        if (this.currentBookType === 'epub' && this.epubRendition) {
            this.epubRendition.prev();
        } else if (this.currentBookType === 'pdf' && this.pdfDocument) {
            if (this.pdfCurrentPage > 1) {
                this.renderPdfPage(this.pdfCurrentPage - 1);
            }
        }
    },

    // Mevcut Konuma Göre Aktif TOC Bölüm İndeksini Bulma
    findActiveTocIndex(currentLocation) {
        if (!this.numberedChapters || this.numberedChapters.length === 0 || !currentLocation || !currentLocation.start) {
            return -1;
        }

        const currentSpineIndex = currentLocation.start.index;
        let activeIndex = -1;
        let candidateIdx = -1;
        let highestSpine = -1;
        
        for (let i = 0; i < this.numberedChapters.length; i++) {
            const chHref = this.numberedChapters[i].href;
            const item = this.epubBook.spine.get(chHref);
            if (item) {
                if (item.index <= currentSpineIndex && item.index > highestSpine) {
                    highestSpine = item.index;
                    candidateIdx = i;
                }
            }
        }
        
        if (candidateIdx !== -1) {
            activeIndex = candidateIdx;
            const candidateSpine = highestSpine;
            let sameSpineChapters = [];
            for (let i = 0; i < this.numberedChapters.length; i++) {
                const item = this.epubBook.spine.get(this.numberedChapters[i].href);
                if (item && item.index === candidateSpine) {
                    sameSpineChapters.push({ index: i, chapter: this.numberedChapters[i] });
                }
            }
            
            if (sameSpineChapters.length > 1) {
                const currentHref = currentLocation.start.href || '';
                const currentHash = currentHref.includes('#') ? currentHref.split('#')[1] : null;
                
                if (currentHash) {
                    const match = sameSpineChapters.find(c => {
                        const h = c.chapter.href || '';
                        const hash = h.includes('#') ? h.split('#')[1] : null;
                        return hash === currentHash;
                    });
                    if (match) {
                        activeIndex = match.index;
                    }
                }
            }
        }

        // Fallback: Href adına göre eşleme
        if (activeIndex === -1) {
            const normalize = (h) => {
                if (!h) return '';
                const parts = h.split('#')[0].split('/');
                return parts[parts.length - 1].toLowerCase();
            };
            const currentHref = currentLocation.start.href;
            const normalizedCurrent = normalize(currentHref);
            
            for (let i = 0; i < this.numberedChapters.length; i++) {
                if (normalize(this.numberedChapters[i].href) === normalizedCurrent) {
                    activeIndex = i;
                    break;
                }
            }
        }

        return activeIndex;
    },

    // Slider Konumunu Güncelleme
    syncSliderToCurrentLocation() {
        this.updateEpubProgressUI(false);
    },

    // Slayt İlerleme Çubuğunu Güncelleme
    updateProgressBar(sliderValue, percent, text) {
        const slider = document.getElementById('reader-progress-slider');
        if (slider && sliderValue !== undefined) {
            slider.value = sliderValue;
        }
        const percentEl = document.getElementById('reader-progress-percent');
        if (percentEl) percentEl.textContent = (percent !== undefined ? percent : 0) + '%';
        const labelEl = document.getElementById('reader-progress-label');
        if (labelEl && text !== undefined) labelEl.textContent = text;
    },

    // 5. Metin Seçiminden Cümleyi Ayıklama (Bağlamsal Çeviri İçin)
    extractSentenceFromSelection(win, selectedText) {
        try {
            const selection = win.getSelection();
            if (!selection.rangeCount) return selectedText;

            const range = selection.getRangeAt(0);
            const containerNode = range.commonAncestorContainer;
            
            // Eğer node metin düğümü ise ebeveynine çık
            const textContent = containerNode.textContent || "";
            
            // Tüm metinde seçilen kelimenin indeksini bul
            const selectedIndex = textContent.indexOf(selectedText);
            if (selectedIndex === -1) return selectedText;

            // Noktalama işaretlerine göre kelimeyi saran cümleyi bul
            const startStr = textContent.substring(0, selectedIndex);
            const endStr = textContent.substring(selectedIndex + selectedText.length);

            // Geriye doğru ilk cümle bitimini ara
            const lastStartPunc = Math.max(
                startStr.lastIndexOf('.'),
                startStr.lastIndexOf('?'),
                startStr.lastIndexOf('!'),
                startStr.lastIndexOf('\n')
            );
            
            // İleriye doğru ilk cümle bitimini ara
            const firstEndPunc = [
                endStr.indexOf('.'),
                endStr.indexOf('?'),
                endStr.indexOf('!'),
                endStr.indexOf('\n')
            ].filter(idx => idx !== -1);
            
            const nextEndPunc = firstEndPunc.length > 0 ? Math.min(...firstEndPunc) : endStr.length;

            const sentenceStart = lastStartPunc === -1 ? 0 : lastStartPunc + 1;
            const sentenceEnd = selectedIndex + selectedText.length + (nextEndPunc === -1 ? endStr.length : nextEndPunc);

            const sentence = textContent.substring(sentenceStart, sentenceEnd).trim();
            return sentence.length > selectedText.length ? sentence : selectedText;
        } catch(e) {
            return selectedText;
        }
    },

    // Seçim değişimlerini (2 kenardaki noktalarla genişletme dahil) gecikmeli olarak işler
    scheduleProcessSelection(win, doc, delayMs = 260) {
        if (this.selectionDebounceTimer) {
            clearTimeout(this.selectionDebounceTimer);
        }
        this.selectionDebounceTimer = setTimeout(() => {
            this.selectionDebounceTimer = null;
            this.processActiveSelection(win, doc);
        }, delayMs);
    },

    async processActiveSelection(win, doc) {
        if (!win || !doc) return;
        const selection = win.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const selectedText = selection.toString().trim();
        if (!selectedText || selectedText.length === 0 || selectedText.length > 2500) {
            return;
        }

        const range = selection.getRangeAt(0);
        this.lastSelectionWin = win;
        this.lastSelectionDoc = doc;
        this.lastSelectionRange = range.cloneRange();

        // Aynı metin zaten işlendiyse ve popover açıksa tekrar çeviri isteği atma
        const popover = document.getElementById('translate-popover');
        if (popover && popover.style.display === 'flex' && this.lastProcessedSelectionText === selectedText) {
            return;
        }
        this.lastProcessedSelectionText = selectedText;

        this.isProcessingSelection = true;
        try {
            const rect = range.getBoundingClientRect();
            let posX = rect.left + (rect.width / 2);
            let posY = rect.top;
            let bottomY = rect.bottom;

            if (this.currentBookType === 'epub') {
                const iframe = document.querySelector("#epub-viewer iframe");
                if (iframe) {
                    const iframeRect = iframe.getBoundingClientRect();
                    posX = rect.left + iframeRect.left + (rect.width / 2);
                    posY = rect.top + iframeRect.top;
                    bottomY = rect.bottom + iframeRect.top;
                }
            }

            const fullSentence = this.extractSentenceFromSelection(win, selectedText);
            const resolved = await this.resolveSelectionTranslationContext(selectedText, range, fullSentence);

            await this.showPopover(
                resolved.originalText,
                posX,
                posY,
                resolved.contextSentence,
                selectedText,
                resolved.origLang,
                bottomY,
                resolved.isBlockTranslated
            );
        } catch (err) {
            console.error("Seçim işleme hatası:", err);
        } finally {
            setTimeout(() => {
                this.isProcessingSelection = false;
            }, 180);
        }
    },

    // 6. Çeviri Popover Kontrolleri
    // Google Chrome'un 3 nokta sayfa çevirisinin popover içindeki orijinal metni çevirmesini
    // tamamen engellemek için hem translate="no" / .notranslate hem de izole Shadow DOM kullanır
    setUntranslatableContent(el, content, isHtml = false) {
        if (!el) return;
        el.setAttribute('translate', 'no');
        el.classList.add('notranslate');
        try {
            const shadow = el.shadowRoot || el.attachShadow({ mode: 'open' });
            el.textContent = '';
            if (isHtml) {
                shadow.innerHTML = `<div translate="no" class="notranslate" style="color: inherit; font: inherit; line-height: inherit; word-break: break-word;">${content}</div>`;
            } else {
                shadow.innerHTML = '';
                const span = document.createElement('span');
                span.setAttribute('translate', 'no');
                span.className = 'notranslate';
                span.textContent = content;
                shadow.appendChild(span);
            }
        } catch (e) {
            if (isHtml) {
                el.innerHTML = content;
            } else {
                el.textContent = content;
            }
        }
    },

    async showPopover(text, posX, posY, sentence, selectedText = "", origLangHint = null, bottomY = null, isBlockTranslated = false) {
        const popover = document.getElementById('translate-popover');
        const textPreview = document.getElementById('selected-text-preview');
        const translationText = document.getElementById('translation-text');
        const loader = document.getElementById('translation-loader');

        popover.setAttribute('translate', 'no');
        popover.classList.add('notranslate');

        const cleanSelected = (selectedText || text || "").trim();
        const cleanOriginal = (text || selectedText || "").trim();

        // Popover başlığını ve özniteliklerini hazırla (Shadow DOM ile Chrome çevirisinden koru)
        const previewStr = cleanOriginal.length > 34 ? cleanOriginal.substring(0, 34) + "..." : cleanOriginal;
        this.setUntranslatableContent(textPreview, previewStr, false);
        popover.setAttribute('data-selected-word', cleanOriginal);
        popover.setAttribute('data-displayed-selection', cleanSelected);
        popover.setAttribute('data-context-sentence', sentence || cleanOriginal);
        
        this.setUntranslatableContent(translationText, "", false);
        loader.style.display = 'flex';

        // Popover'ı göster ve konumlandır (Seçimin 2 yanındaki noktaları kapatmayacak şekilde)
        popover.style.display = 'flex';
        
        const popoverWidth = Math.min(340, (document.getElementById('app-container').clientWidth || window.innerWidth) - 20);
        const popoverHeight = popover.offsetHeight || 165;
        const appWidth = document.getElementById('app-container').clientWidth || window.innerWidth;
        
        let left = posX - (popoverWidth / 2);
        if (left < 10) left = 10;
        if (left + popoverWidth > appWidth - 10) left = appWidth - popoverWidth - 10;

        let top = posY - popoverHeight - 18;
        let placedAbove = true;
        if (top < 64) {
            // Eğer üstte yer yoksa seçimin ve seçim noktalarının (damla tutamaçların) altına konumlandır
            placedAbove = false;
            const anchorBottom = bottomY !== null ? bottomY : (posY + 26);
            top = anchorBottom + 34;
        }

        popover.style.left = left + 'px';
        popover.style.top = top + 'px';

        translationText.style.display = 'block';
        
        // Çeviri Kuralları:
        // - Sadece 1 kelime seçildiğinde:
        //   1. Orijinal (Kitaptaki çevrilmemiş ham kelime)
        //   2. Olası Türkçe Kelimeler (Kelimenin sözlükteki olası Türkçe karşılıkları)
        //   3. Cümledeki Anlamı (Kelimenin o cümlede geçen spesifik anlamı ve açıklaması)
        // - Birden fazla kelime (cümle/paragraf) seçildiğinde:
        //   1. Orijinal
        //   2. Türkçe
        try {
            const preferredTr = isBlockTranslated ? cleanSelected : "";
            const srcLang = origLangHint || this.detectedLang || 'auto';

            const origWordCount = cleanOriginal.split(/\s+/).filter(Boolean).length;
            const selWordCount = cleanSelected.split(/\s+/).filter(Boolean).length;
            const isSingleWord = origWordCount === 1 || (selWordCount === 1 && origWordCount <= 2);

            const escapeHtml = (str) => (str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            let rowsHtml = "";
            let finalTrForAttr = "";

            if (isSingleWord) {
                const wordAnalysis = await translateService.analyzeSingleWordInContext(
                    cleanOriginal,
                    sentence || "",
                    srcLang,
                    preferredTr
                );

                loader.style.display = 'none';

                const possibleListStr = (wordAnalysis.possibleMeanings && wordAnalysis.possibleMeanings.length > 0)
                    ? wordAnalysis.possibleMeanings.join(', ')
                    : (wordAnalysis.primaryTr || cleanOriginal);

                const posBadge = wordAnalysis.posLabel
                    ? ` <span style="opacity: 0.75; font-size: 11px;">(${escapeHtml(wordAnalysis.posLabel)})</span>`
                    : '';

                rowsHtml =
                    `<div translate="no" class="notranslate" style="margin-bottom: 5px;"><strong>Original:</strong> ${escapeHtml(cleanOriginal)}</div>` +
                    `<div translate="no" class="notranslate" style="margin-bottom: 5px;"><strong>Possible Turkish Meanings:</strong> ${escapeHtml(possibleListStr)}</div>` +
                    `<div translate="no" class="notranslate" style="border-top: 1px solid rgba(128,128,128,0.22); padding-top: 5px; margin-top: 2px;">` +
                        `<strong>Meaning in Context:</strong> <strong>${escapeHtml(wordAnalysis.contextualWord)}</strong>${posBadge} — ` +
                        `<span style="font-weight: 400;">${escapeHtml(wordAnalysis.contextualExplanation)}</span>` +
                    `</div>`;

                finalTrForAttr = wordAnalysis.primaryTr || cleanOriginal;
            } else {
                const translationTR = await translateService.translateSmartToTurkish(
                    cleanOriginal,
                    sentence || "",
                    srcLang,
                    preferredTr
                );

                loader.style.display = 'none';

                rowsHtml =
                    `<div translate="no" class="notranslate" style="margin-bottom: 4px;"><strong>Original:</strong> ${escapeHtml(cleanOriginal)}</div>` +
                    `<div translate="no" class="notranslate"><strong>Turkish:</strong> ${escapeHtml(translationTR)}</div>`;

                finalTrForAttr = translationTR;
            }

            this.setUntranslatableContent(translationText, rowsHtml, true);
            popover.setAttribute('data-translated-tr', finalTrForAttr);

            // İçerik yüklendikten sonra pencere yüksekliği arttıysa seçimi ve tutamaç noktalarını kapatmaması için konumu güncelle
            if (placedAbove) {
                const newHeight = popover.offsetHeight || popoverHeight;
                let adjustedTop = posY - newHeight - 18;
                if (adjustedTop < 64) {
                    const anchorBottom = bottomY !== null ? bottomY : (posY + 26);
                    adjustedTop = anchorBottom + 34;
                }
                popover.style.top = adjustedTop + 'px';
            }
        } catch (e) {
            loader.style.display = 'none';
            this.setUntranslatableContent(translationText, "Translation service error.", false);
        }
    },

    hidePopover(clearNativeSelection = true) {
        const popover = document.getElementById('translate-popover');
        if (popover) popover.style.display = 'none';
        this.lastProcessedSelectionText = null;
        
        // Seçim işaretlemesini temizle (Highlight kaldır)
        this.clearHighlight();

        if (!clearNativeSelection) return;

        // Eğer EPUB ise seçimi kaldır
        if (this.currentBookType === 'epub' && this.epubRendition) {
            try {
                const iframe = document.querySelector("#epub-viewer iframe");
                if (iframe && iframe.contentWindow) {
                    iframe.contentWindow.getSelection().removeAllRanges();
                }
            } catch(e) {}
        }
        
        // Normal pencere seçimini de kaldır
        try {
            window.getSelection().removeAllRanges();
        } catch (e) {}
    },

    // Seçili Metni Web'de (Google) Arama
    searchSelectedOnWeb() {
        const popover = document.getElementById('translate-popover');
        if (!popover) return;
        const query = (popover.getAttribute('data-displayed-selection') || popover.getAttribute('data-selected-word') || '').trim();
        if (!query) return;
        const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
        window.open(url, '_blank', 'noopener,noreferrer');
    },

    // Popover Üzerinden "Tümünü Seç" (Önce bulunduğu cümleyi/paragrafı, tekrar basılırsa tüm sayfayı seçer ve çevirir)
    selectAllFromPopover() {
        try {
            let win = this.lastSelectionWin;
            let doc = this.lastSelectionDoc;

            if (this.currentBookType === 'epub') {
                const iframe = document.querySelector("#epub-viewer iframe");
                if (iframe && iframe.contentWindow && iframe.contentDocument) {
                    win = iframe.contentWindow;
                    doc = iframe.contentDocument;
                }
            } else if (this.currentBookType === 'pdf') {
                win = window;
                doc = document;
            }

            if (!win || !doc) return;
            const sel = win.getSelection();
            const currentRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : this.lastSelectionRange;

            let targetContainer = null;
            if (currentRange) {
                let node = currentRange.commonAncestorContainer;
                if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
                if (node && typeof node.closest === 'function') {
                    const blockEl = node.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote');
                    if (blockEl) {
                        const blockText = (blockEl.innerText || blockEl.textContent || '').trim();
                        const currentSelected = sel ? sel.toString().trim() : '';
                        if (currentSelected.length < blockText.length * 0.9) {
                            targetContainer = blockEl;
                        }
                    }
                }
            }

            if (!targetContainer) {
                targetContainer = (this.currentBookType === 'pdf')
                    ? (document.querySelector('#pdf-viewer .textLayer') || document.getElementById('pdf-viewer'))
                    : doc.body;
            }

            if (targetContainer && sel) {
                const newRange = doc.createRange();
                newRange.selectNodeContents(targetContainer);
                sel.removeAllRanges();
                sel.addRange(newRange);
                this.lastSelectionRange = newRange.cloneRange();
                this.lastProcessedSelectionText = null;
                this.scheduleProcessSelection(win, doc, 80);
            }
        } catch (err) {
            console.error("Tümünü seç hatası:", err);
        }
    },

    // Kelime Çevirisini Sözlüğe Kaydetme
    async saveSelectedWord() {
        const popover = document.getElementById('translate-popover');
        const word = popover.getAttribute('data-selected-word');
        const context = popover.getAttribute('data-context-sentence');
        const meaning = popover.getAttribute('data-translated-tr') || document.getElementById('translation-text').textContent;

        if (!word || !meaning) return;

        const success = await wordsDb.saveWord({
            word: word,
            meaning: meaning,
            context: context,
            bookTitle: this.currentBookTitle,
            bookId: this.currentBookId
        });

        if (success) {
            alert("Word saved to dictionary.");
            this.hidePopover();
            // Kelimelerim ekranını yenile
            if (window.app) window.app.loadWords();
        } else {
            alert("Could not save word.");
        }
    },

    // 7. Okuyucu Panel Kontrolleri
    openTOCPanel() {
        document.getElementById('toc-panel').classList.add('open');
    },

    closeTOCPanel() {
        document.getElementById('toc-panel').classList.remove('open');
    },

    openStylePanel() {
        // Panel ilk açılışta yalnızca alttaki 4 sekme butonuyla (Bölüm, Görünüm, Ses, Ayarlar) kompakt açılır
        this.collapsePanelTabs();
        document.getElementById('reader-options-panel').classList.add('open');
        const header = document.querySelector('.reader-header');
        if (header) header.classList.add('open');
    },

    closeStylePanel() {
        const panel = document.getElementById('reader-options-panel');
        panel.classList.remove('open');
        const header = document.querySelector('.reader-header');
        if (header) header.classList.remove('open');
        // Kapanış animasyonu bittikten sonra içerikleri sıfırla
        setTimeout(() => {
            if (!panel.classList.contains('open')) this.collapsePanelTabs();
        }, 350);
    },

    // Seçilen sekmenin içeriğini yukarı doğru genişleterek gösterir (aynı sekmeye tekrar basılırsa daraltır)
    togglePanelTab(tabPaneId) {
        const panel = document.getElementById('reader-options-panel');
        const targetPane = document.getElementById(tabPaneId);
        if (!panel || !targetPane) return;

        if (panel.classList.contains('expanded') && targetPane.classList.contains('active')) {
            this.collapsePanelTabs();
            return;
        }

        document.querySelectorAll('.panel-tab-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tab') === tabPaneId);
        });
        document.querySelectorAll('.reader-options-panel .tab-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === tabPaneId);
        });
        panel.classList.add('expanded');
    },

    // Sekme içeriklerini gizleyip paneli yalnızca sekme butonlarına daraltır
    collapsePanelTabs() {
        const panel = document.getElementById('reader-options-panel');
        if (panel) panel.classList.remove('expanded');
        document.querySelectorAll('.panel-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.reader-options-panel .tab-pane').forEach(pane => pane.classList.remove('active'));
    },

    // Yazı Boyutu Artırma / Azaltma
    async adjustFontSize(increment) {
        this.settings.fontSize = Math.min(Math.max(this.settings.fontSize + increment, 60), 250);
        document.getElementById('font-size-val').textContent = this.settings.fontSize + '%';
        
        await settingsDb.set('readerFontSize', this.settings.fontSize);

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        } else if (this.currentBookType === 'pdf') {
            this.renderPdfPage(this.pdfCurrentPage);
        }
    },

    // Satır Aralığı Artırma / Azaltma
    async adjustLineHeight(increment) {
        this.settings.lineHeight = Math.min(Math.max(parseFloat((this.settings.lineHeight + increment).toFixed(1)), 1.0), 3.0);
        document.getElementById('lineheight-val').textContent = this.settings.lineHeight;

        await settingsDb.set('readerLineHeight', this.settings.lineHeight);

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        }
    },

    // Kenar Boşluğu Artırma / Azaltma
    async adjustPadding(increment) {
        this.settings.padding = Math.min(Math.max(this.settings.padding + increment, 0), 32);
        document.getElementById('padding-val').textContent = this.settings.padding + 'px';

        await settingsDb.set('readerPadding', this.settings.padding);

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        }
    },

    // Okuyucu Modu Değiştirme (Single Page / Infinite / Old Reader)
    async changeReaderType(type) {
        this.settings.readerType = type;
        await settingsDb.set('readerType', type);

        // Buton aktifliklerini güncelle
        document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-readertype-"]').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.getElementById(`btn-readertype-${type}`);
        if (activeBtn) activeBtn.classList.add('active');

        // Kitabı mevcut konumundan yeniden başlat
        if (this.currentBookId) {
            if (this.currentBookType === 'epub') {
                await this.initEpub(this.bookData.file, this.epubLocation || null);
            }
        }
    },

    // Çeviri Servisi Ayarlama (None / Web)
    async changeTranslationService(service) {
        this.settings.translationService = service;
        await settingsDb.set('readerTranslationService', service);

        // Buton aktifliklerini güncelle
        document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-trans-"]').forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.getElementById(`btn-trans-${service}`);
        if (activeBtn) activeBtn.classList.add('active');

        await this.updateTranslationSettingsUI();
        await this.handleEntirePageTranslation();
    },

    async updateTranslationSettingsUI() {
        const langSection = document.querySelector('#tab-pane-settings .settings-section:nth-of-type(2)');
        const serviceRow = document.querySelector('.wtr-select-row');
        const sectionLabel = document.querySelector('#tab-pane-settings .settings-section:nth-of-type(2) .settings-section-label');

        const currentService = this.settings.translationService || 'none';

        if (currentService === 'none') {
            if (langSection) langSection.style.display = 'none';
        } else {
            if (langSection) langSection.style.display = 'flex';
            if (sectionLabel) sectionLabel.innerHTML = 'READER LANGUAGE <span style="font-size: 10px; text-transform: none; font-weight: 500;">(Web Translation)</span>';
            if (serviceRow) serviceRow.style.display = 'flex';
        }
    },

    // Otomatik Bölüm Kilidi Açma Ayarı
    async toggleAutoUnlock(enabled) {
        this.settings.autoUnlock = enabled;
        await settingsDb.set('readerAutoUnlock', enabled);
    },

    // Dokunarak Çeviri Ayarını Değiştirme
    async toggleTapToTranslate(enabled) {
        this.settings.tapToTranslate = enabled;
        await settingsDb.set('readerTapToTranslate', enabled);
        this.hidePopover();
    },

    async changeWebService(service) {
        this.settings.webService = service;
        await settingsDb.set('readerWebService', service);
        await this.handleEntirePageTranslation();
    },

    async changeTargetLang(lang) {
        this.settings.targetLang = lang;
        await settingsDb.set('readerTargetLang', lang);
        await this.handleEntirePageTranslation();
    },

    async handleEntirePageTranslation() {
        const transService = this.settings.translationService || 'none';
        if (transService === 'web' && this.settings.webService === 'google') {
            await this.translateEntireBookPage(this.settings.targetLang);
        } else {
            this.restoreOriginalBookPage();
        }
    },

    async translateEntireBookPage(lang) {
        if (this.currentBookId) {
            if (this.currentBookType === 'epub') {
                const iframes = document.querySelectorAll("#epub-viewer iframe");
                for (const iframe of iframes) {
                    if (iframe && iframe.contentDocument) {
                        await this.translateDocument(iframe.contentDocument, lang);
                    }
                }
            } else if (this.currentBookType === 'pdf') {
                const pdfViewer = document.getElementById('pdf-viewer');
                if (pdfViewer) {
                    await this.translateDocument(pdfViewer, lang);
                }
            }
        }
    },

    restoreOriginalBookPage() {
        if (this.currentBookType === 'epub') {
            const iframes = document.querySelectorAll("#epub-viewer iframe");
            iframes.forEach(iframe => {
                if (iframe && iframe.contentDocument) {
                    this.restoreDocument(iframe.contentDocument);
                }
            });
        } else if (this.currentBookType === 'pdf') {
            const pdfViewer = document.getElementById('pdf-viewer');
            if (pdfViewer) {
                this.restoreDocument(pdfViewer);
            }
        }
    },

    syncToTranslationSandbox(doc) {
        if (!doc) return;

        // 1. Get or create sandbox element in main document
        let sandbox = document.getElementById('translation-sandbox');
        if (!sandbox) {
            sandbox = document.createElement('div');
            sandbox.id = 'translation-sandbox';
            document.body.appendChild(sandbox);
        } else if (sandbox.parentElement !== document.body) {
            document.body.appendChild(sandbox);
        }
        // Position off-screen but keep in normal Blink layout (no contain:strict / aria-hidden / opacity:0)
        // so Chrome's 3-dots page translator extracts and translates all paragraphs in the chapter.
        sandbox.removeAttribute('aria-hidden');
        sandbox.style.cssText = 'position: absolute; left: -9999px; top: -9999px; width: 1px; height: 1px; overflow: hidden;';

        // Clear previous sandbox contents and stop old observer
        if (this.sandboxObserver) {
            this.sandboxObserver.disconnect();
            this.sandboxObserver = null;
        }
        if (this.sandboxRafId) {
            cancelAnimationFrame(this.sandboxRafId);
            this.sandboxRafId = null;
        }
        sandbox.innerHTML = '';

        const selectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
        const rawCandidates = Array.from(doc.querySelectorAll(selectors + ', div'));
        const iframeElements = rawCandidates.filter(el => {
            if (el.classList && (
                el.classList.contains('epub-chapter-footer') ||
                el.classList.contains('epub-chapter-spacer') ||
                el.classList.contains('endlessr-page-word-count')
            )) {
                return false;
            }
            if (el.closest && el.closest('.endlessr-page-word-count, .epub-chapter-footer, .epub-chapter-spacer')) {
                return false;
            }
            if (el.tagName.toLowerCase() === 'div') {
                // Yalnızca alt blok elemanı olmayan yaprak div'leri dahil et
                return !el.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote, div');
            }
            return true;
        });
        const elementMap = new Map();
        const sandboxElementMap = new Map();

        const lang = this.detectedLang || 'en';
        document.documentElement.setAttribute('lang', lang);
        sandbox.setAttribute('lang', lang);
        sandbox.setAttribute('translate', 'yes');

        const fragment = document.createDocumentFragment();

        iframeElements.forEach((el, idx) => {
            const txt = el.innerText || el.textContent;
            if (txt && txt.trim().length > 0) {
                const syncId = idx.toString();
                el.setAttribute('data-sync-id', syncId);

                const sandboxEl = document.createElement(el.tagName.toLowerCase());
                sandboxEl.setAttribute('data-sync-id', syncId);

                if (!el.hasAttribute('data-original-text')) {
                    el.setAttribute('data-original-text', txt);
                }

                sandboxEl.textContent = el.getAttribute('data-original-text');
                fragment.appendChild(sandboxEl);

                elementMap.set(syncId, el);
                sandboxElementMap.set(syncId, sandboxEl);
            }
        });

        if (elementMap.size === 0) return;
        sandbox.appendChild(fragment);

        // 2. Set up MutationObserver to watch for Chrome translation changes in sandbox
        this.sandboxObserver = new MutationObserver(() => {
            if (this.sandboxRafId) return;

            this.sandboxRafId = requestAnimationFrame(() => {
                this.sandboxRafId = null;
                const savedScrollY = this.getScrollTop();
                let anyUpdated = false;

                sandboxElementMap.forEach((sandboxEl, syncId) => {
                    const iframeEl = elementMap.get(syncId);
                    if (!sandboxEl || !iframeEl) return;

                    const newText = sandboxEl.textContent || sandboxEl.innerText;
                    if (!newText || !newText.trim()) return;

                    if (iframeEl.innerText !== newText) {
                        iframeEl.innerText = newText;
                        iframeEl.setAttribute('data-is-translated', 'true');
                        anyUpdated = true;
                    }
                });

                if (anyUpdated) {
                    this.scheduleExpandEpubIframe(60);
                    if (savedScrollY > 0 && Math.abs(this.getScrollTop() - savedScrollY) > 2) {
                        this.setScrollTop(savedScrollY);
                    }
                }
            });
        });

        this.sandboxObserver.observe(sandbox, {
            childList: true,
            characterData: true,
            subtree: true
        });
    },

    async translateDocument(doc, targetLang) {
        if (!doc) return;

        const cleanTarget = targetLang ? targetLang.toLowerCase() : 'tr';
        const transService = this.settings.translationService || 'web';

        // If document is already translated or currently translating to the target language by the same service, do nothing
        if (doc.body) {
            if (doc.body.getAttribute('data-translated-to') === cleanTarget &&
                doc.body.getAttribute('data-translated-by') === transService) {
                return;
            }
            if (doc.body.getAttribute('data-is-translating') === 'true') {
                return;
            }
            doc.body.setAttribute('data-is-translating', 'true');
        }

        try {
            const selectors = 'p, h1, h2, h3, h4, h5, h6, li, .textLayer span';
            const elements = Array.from(doc.querySelectorAll(selectors));

            const validElements = elements.filter(el => {
                const txt = el.innerText || el.textContent;
                return txt && txt.trim().length > 0;
            });

            if (validElements.length === 0) return;

            // Load cached language or detect it
            if (!this.detectedLang && this.bookData && this.bookData.detectedLang) {
                this.detectedLang = this.bookData.detectedLang;
            }

            if (!this.detectedLang) {
                const sampleText = validElements.slice(0, 3).map(el => el.innerText || el.textContent).join(' ').trim();
                if (sampleText.length > 0) {
                    try {
                        const result = await translateService.translateGoogleWithDetails(sampleText.slice(0, 200), 'tr');
                        if (result && result.lang) {
                            this.detectedLang = result.lang.toLowerCase();
                            if (this.bookData) {
                                this.bookData.detectedLang = this.detectedLang;
                                await booksDb.saveBook(this.bookData);
                            }
                        }
                    } catch (e) {
                        console.error("Language detection failed:", e);
                    }
                }
            }

            const cleanDetected = this.detectedLang ? this.detectedLang.toLowerCase() : 'en';
            const isSameLang = cleanDetected === cleanTarget ||
                               cleanDetected.startsWith(cleanTarget) ||
                               cleanTarget.startsWith(cleanDetected);

            if (isSameLang) {
                this.restoreDocument(doc);
                return;
            }

            const chunkSize = 15;
            let successCount = 0;
            const chunks = [];

            for (let i = 0; i < validElements.length; i += chunkSize) {
                const chunk = validElements.slice(i, i + chunkSize);
                const textsToTranslate = chunk.map(el => {
                    if (!el.hasAttribute('data-original-text')) {
                        el.setAttribute('data-original-text', el.innerText || el.textContent);
                    }
                    return el.getAttribute('data-original-text');
                });
                chunks.push({ chunkElements: chunk, texts: textsToTranslate });
            }

            // Translate in controlled batches of 2 chunks at a time to prevent UI freeze and scroll jumps
            const concurrency = 2;
            for (let c = 0; c < chunks.length; c += concurrency) {
                const batch = chunks.slice(c, c + concurrency);
                await Promise.all(batch.map(async ({ chunkElements, texts }) => {
                    try {
                        const translatedParts = await this.translateTextsBatch(texts, cleanTarget);
                        const savedScrollY = this.getScrollTop();
                        for (let j = 0; j < chunkElements.length; j++) {
                            if (translatedParts[j]) {
                                chunkElements[j].textContent = translatedParts[j];
                                chunkElements[j].setAttribute('data-is-translated', 'true');
                                successCount++;
                            }
                        }
                        if (this.currentBookType === 'epub') {
                            this.scheduleExpandEpubIframe(60);
                            if (Math.abs(this.getScrollTop() - savedScrollY) > 2) {
                                this.setScrollTop(savedScrollY);
                            }
                        }
                    } catch (err) {
                        console.error("Batch translate error in chunk:", err);
                        for (const el of chunkElements) {
                            try {
                                const original = el.getAttribute('data-original-text');
                                const trans = await translateService.translateGoogle(original, cleanTarget);
                                const savedScrollY = this.getScrollTop();
                                el.textContent = trans;
                                el.setAttribute('data-is-translated', 'true');
                                successCount++;
                                if (Math.abs(this.getScrollTop() - savedScrollY) > 2) {
                                    this.setScrollTop(savedScrollY);
                                }
                            } catch (e) {
                                console.error("Fallback translate error:", e);
                            }
                        }
                    }
                }));
            }

            if (doc.body && successCount > 0) {
                doc.body.setAttribute('data-translated-to', cleanTarget);
                doc.body.setAttribute('data-translated-by', transService);
            }
            const savedScrollAfter = this.getScrollTop();
            this.applySpacingFixToDoc(doc);
            if (this.currentBookType === 'epub') {
                this.scheduleExpandEpubIframe(60);
                if (Math.abs(this.getScrollTop() - savedScrollAfter) > 2) {
                    this.setScrollTop(savedScrollAfter);
                }
            }
        } finally {
            if (doc.body) {
                doc.body.removeAttribute('data-is-translating');
            }
        }
    },

    async translateTextsBatch(texts, targetLang) {
        // Standard Google Translate (Web) - translate in parallel to avoid separator issues and ensure maximum purity
        try {
            const promises = texts.map(text => translateService.translateGoogle(text, targetLang));
            const parts = await Promise.all(promises);
            return parts;
        } catch (err) {
            console.error("Google Translate parallel batch failed, falling back to sequential:", err);
            const parts = [];
            for (const text of texts) {
                const trans = await translateService.translateGoogle(text, targetLang);
                parts.push(trans);
            }
            return parts;
        }
    },

    restoreDocument(doc) {
        if (!doc) return;
        const savedScrollY = this.getScrollTop();
        const elements = doc.querySelectorAll('[data-original-text]');
        elements.forEach(el => {
            el.textContent = el.getAttribute('data-original-text');
            el.removeAttribute('data-is-translated');
        });
        if (doc.body) {
            doc.body.removeAttribute('data-translated-to');
            doc.body.removeAttribute('data-translated-by');
            doc.body.removeAttribute('data-is-translating');
        }
        this.applySpacingFixToDoc(doc);
        if (this.currentBookType === 'epub') {
            this.scheduleExpandEpubIframe(60);
            if (Math.abs(this.getScrollTop() - savedScrollY) > 2) {
                this.setScrollTop(savedScrollY);
            }
        }
    },

    // Yazı Tipi Değiştirme
    async changeFontFamily(font) {
        this.settings.fontFamily = font;
        await settingsDb.set('readerFontFamily', font);

        // Aktif butonu güncelle
        const buttons = document.querySelectorAll('.font-family-btn');
        buttons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-font') === font) {
                btn.classList.add('active');
            }
        });

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        }
    },

    // Tema renklerini almak için yardımcı metod
    getThemeColors(themeName) {
        const themes = {
            "light": { bg: "#ffffff", fg: "#1f2937" },
            "sepia": { bg: "#f8efe0", fg: "#3c2f1e" },
            "warm": { bg: "#faf2e4", fg: "#433422" },
            "ocean": { bg: "#eef4f8", fg: "#1b2b34" },
            "rose": { bg: "#faf0f2", fg: "#4a2c3a" },
            "forest": { bg: "#eef5eb", fg: "#2c3e29" },
            "dark": { bg: "#1e222b", fg: "#a0aab8" },
            "night": { bg: "#0f1115", fg: "#ffffff" },
            "dark-navy": { bg: "#122435", fg: "#8cb3db" },
            "dark-sepia": { bg: "#2c2824", fg: "#d5c7b9" },
            "dark-slate": { bg: "#1b2631", fg: "#aabecf" },
            "dark-green": { bg: "#1b2b20", fg: "#a8c3ad" }
        };
        return themes[themeName] || themes["dark"];
    },

    // Özel stilleri dökümana (iframe içine) uygulama ve EPUB renklerini/yazı tiplerini zorla ezme metodu
    applyCustomStylesToDoc(doc) {
        if (!doc || !doc.head) return;
        const rType = this.settings.readerType || "single";
        const padVal = this.settings.padding !== undefined ? this.settings.padding : 8;
        const colors = this.getThemeColors(this.settings.theme);
        const font = this.settings.fontFamily || "system-ui";
        const fontSize = this.settings.fontSize || 100;
        const lh = this.settings.lineHeight || 1.6;

        // Google Fonts (Inter, Lora, Outfit) bağlantısını EPUB iframe'ine enjekte et
        if (!doc.getElementById('antigravity-google-fonts')) {
            const fontLink = doc.createElement('link');
            fontLink.id = 'antigravity-google-fonts';
            fontLink.rel = 'stylesheet';
            fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Outfit:wght@400;500;600;700;800&display=swap';
            doc.head.appendChild(fontLink);
        }
        
        let customStyle = doc.getElementById('antigravity-custom-styles');
        if (!customStyle) {
            customStyle = doc.createElement('style');
            customStyle.id = 'antigravity-custom-styles';
            doc.head.appendChild(customStyle);
        }
        
        let css = '';
        if (rType !== "old") {
            const minBodyHeight = Math.max(300, window.innerHeight || 600);
            css = `
                html {
                    margin: 0 !important;
                    padding: 0 !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    min-height: 0 !important;
                    height: auto !important;
                    box-sizing: border-box !important;
                    background-color: ${colors.bg} !important;
                    color: ${colors.fg} !important;
                    overflow-x: hidden !important;
                }
                body {
                    margin: 0 !important;
                    padding: calc(env(safe-area-inset-top, 30px) + 15px) ${padVal}px 30px !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    min-height: ${minBodyHeight}px !important;
                    height: auto !important;
                    box-sizing: border-box !important;
                    background-color: ${colors.bg} !important;
                    color: ${colors.fg} !important;
                    font-family: ${font} !important;
                    font-size: ${fontSize}% !important;
                    line-height: ${lh} !important;
                    overflow-x: hidden !important;
                }
                /* Custom elegant scrollbar inside book iframe */
                ::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                ::-webkit-scrollbar-track {
                    background: transparent;
                }
                ::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0.25) !important;
                    border-radius: 9999px !important;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: rgba(128, 128, 128, 0.45) !important;
                }
                /* Genişlik, yazı tipi ve kitap içi renk kısıtlamalarını ezelim */
                ::selection {
                    background-color: rgba(50, 146, 255, 0.38) !important;
                }
                p, div, section, article, span, li, blockquote, a, h1, h2, h3, h4, h5, h6, i, em, b, strong, u {
                    max-width: 100% !important;
                    width: auto !important;
                    background-color: transparent !important;
                    color: inherit !important;
                    font-family: ${font} !important;
                    line-height: ${lh} !important;
                    -webkit-user-select: text !important;
                    user-select: text !important;
                    -webkit-touch-callout: none !important;
                }
            `;
        } else {
            css = `
                html, body {
                    padding: calc(env(safe-area-inset-top, 30px) + 15px) ${padVal}px 30px !important;
                    box-sizing: border-box !important;
                    background-color: ${colors.bg} !important;
                    color: ${colors.fg} !important;
                    font-family: ${font} !important;
                    font-size: ${fontSize}% !important;
                    line-height: ${lh} !important;
                    overflow-x: hidden !important;
                }
                /* Custom elegant scrollbar inside book iframe */
                ::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                ::-webkit-scrollbar-track {
                    background: transparent;
                }
                ::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0.25) !important;
                    border-radius: 9999px !important;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: rgba(128, 128, 128, 0.45) !important;
                }
                p, div, section, article, span, li, blockquote, a, h1, h2, h3, h4, h5, h6 {
                    background-color: transparent !important;
                    color: inherit !important;
                    font-family: ${font} !important;
                    line-height: ${lh} !important;
                }
            `;
        }
        if (this.settings.fixSpacing) {
            css += `
                /* Manuel Boşluk Düzeltme: İki yana yaslama kaynaklı kelime arası boşlukları kaldır */
                p, li, blockquote, div:not(.epub-chapter-footer):not(.epub-chapter-spacer):not(.endlessr-page-word-count) {
                    text-align: left !important;
                    word-spacing: normal !important;
                    letter-spacing: normal !important;
                }
                h1, h2, h3, h4, h5, h6, [align="center"], .center, .endlessr-page-word-count {
                    text-align: center !important;
                }
            `;
        }
        if (this.settings.smartReformat) {
            css += `
                /* Akıllı Sayfa Biçimlendirme (Prototip Sayfa Düzeni) */
                body.endlessr-reformatted-body p,
                body.endlessr-reformatted-body li,
                body.endlessr-reformatted-body blockquote,
                body.endlessr-reformatted-body div:not(.epub-chapter-footer):not(.epub-chapter-spacer):not(.endlessr-page-word-count) {
                    text-align: left !important;
                    word-spacing: normal !important;
                    letter-spacing: normal !important;
                }
                body.endlessr-reformatted-body .endlessr-main-title {
                    text-align: center !important;
                    font-weight: 700 !important;
                    font-size: 1.35em !important;
                    line-height: 1.35 !important;
                    margin: 0.6em auto 1.15em auto !important;
                    text-indent: 0 !important;
                    display: block !important;
                }
                body.endlessr-reformatted-body .endlessr-sub-title {
                    text-align: left !important;
                    font-weight: 600 !important;
                    font-size: 1.12em !important;
                    line-height: 1.4 !important;
                    margin: 0.2em 0 1.1em 0 !important;
                    text-indent: 0 !important;
                    display: block !important;
                }
                body.endlessr-reformatted-body .endlessr-epigraph {
                    text-align: left !important;
                    text-indent: 1.5em !important;
                    margin: 0 0 1.25em 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    display: block !important;
                }
                body.endlessr-reformatted-body .endlessr-narrative-p {
                    text-align: left !important;
                    text-indent: 1.5em !important;
                    margin: 0 0 1.05em 0 !important;
                    padding: 0 !important;
                    display: block !important;
                }
                body.endlessr-reformatted-body .endlessr-narrative-p i,
                body.endlessr-reformatted-body .endlessr-narrative-p em,
                body.endlessr-reformatted-body .endlessr-narrative-p b,
                body.endlessr-reformatted-body .endlessr-narrative-p strong,
                body.endlessr-reformatted-body .endlessr-narrative-p span,
                body.endlessr-reformatted-body .endlessr-epigraph i,
                body.endlessr-reformatted-body .endlessr-epigraph em,
                body.endlessr-reformatted-body .endlessr-epigraph b,
                body.endlessr-reformatted-body .endlessr-epigraph strong,
                body.endlessr-reformatted-body .endlessr-epigraph span {
                    display: inline !important;
                    float: none !important;
                    font-size: inherit !important;
                    line-height: inherit !important;
                    font-family: inherit !important;
                    vertical-align: baseline !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    position: static !important;
                }
                body.endlessr-reformatted-body *::first-letter,
                body.endlessr-reformatted-body p::first-letter,
                body.endlessr-reformatted-body p:first-of-type::first-letter,
                body.endlessr-reformatted-body div::first-letter,
                body.endlessr-reformatted-body blockquote::first-letter {
                    float: none !important;
                    font-size: inherit !important;
                    line-height: inherit !important;
                    font-family: inherit !important;
                    font-weight: inherit !important;
                    color: inherit !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    initial-letter: normal !important;
                    -webkit-initial-letter: normal !important;
                }
                body.endlessr-reformatted-body .endlessr-stat-block {
                    text-align: left !important;
                    text-indent: 0 !important;
                    margin: 1.2em 0 !important;
                    padding: 0 !important;
                    display: block !important;
                }
                body.endlessr-reformatted-body .endlessr-stat-line {
                    text-align: left !important;
                    text-indent: 0 !important;
                    margin: 0.16em 0 !important;
                    padding: 0 !important;
                    display: block !important;
                }
            `;
        }
        customStyle.textContent = css;
        this.applySmartReformatToDoc(doc);
        this.applySpacingFixToDoc(doc);
        this.updatePageWordCountBanner(doc);
    },

    // Her sayfanın / bölümün en başına o sayfada kaç kelime olduğunu gösteren bilgi barı ekler
    updatePageWordCountBanner(doc) {
        if (!doc || !doc.body) return;
        const body = doc.body;

        // Varsa eski kelime sayacı barını kaldır
        body.querySelectorAll('.endlessr-page-word-count').forEach(el => el.remove());

        // Kelime sayısını hesapla (footer, spacer, script, style hariç)
        const clone = body.cloneNode(true);
        clone.querySelectorAll('.epub-chapter-footer, .epub-chapter-spacer, .endlessr-page-word-count, script, style, noscript').forEach(el => el.remove());
        const rawText = clone.innerText || clone.textContent || '';
        const wordCount = (typeof utils !== 'undefined' && utils.countWordsInText)
            ? utils.countWordsInText(rawText)
            : (rawText.trim() ? rawText.trim().split(/\s+/).filter(Boolean).length : 0);

        if (wordCount <= 0) return;

        const formattedCount = (typeof utils !== 'undefined' && utils.formatNumber)
            ? utils.formatNumber(wordCount)
            : String(wordCount);

        const banner = doc.createElement('div');
        banner.className = 'endlessr-page-word-count notranslate';
        banner.setAttribute('translate', 'no');
        banner.style.cssText = `
            display: block !important;
            width: 100% !important;
            box-sizing: border-box !important;
            text-align: center !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            opacity: 0.68 !important;
            padding: 8px 10px 8px 10px !important;
            margin: 0 0 14px 0 !important;
            border-bottom: 1px solid rgba(128, 128, 128, 0.22) !important;
            text-indent: 0 !important;
            letter-spacing: 0.2px !important;
            user-select: none !important;
        `;

        // Chrome sayfa çevirisinin bu satırı çevirmemesi için Shadow DOM içine yaz
        try {
            const shadow = banner.attachShadow({ mode: 'open' });
            const span = doc.createElement('span');
            span.setAttribute('translate', 'no');
            span.className = 'notranslate';
            span.textContent = `📖 ${formattedCount} words on this page`;
            shadow.appendChild(span);
        } catch (e) {
            banner.textContent = `📖 ${formattedCount} words on this page`;
        }

        body.insertBefore(banner, body.firstChild);
    },

    // Sayfa Biçimlendirme Butonu Arayüzünü Güncelleme
    updateSmartReformatUI() {
        const btn = document.getElementById('btn-smart-reformat');
        const label = document.getElementById('smart-reformat-label');
        if (!btn || !label) return;

        if (this.settings.smartReformat) {
            label.textContent = 'On';
            btn.style.borderColor = 'var(--accent-color)';
            btn.style.backgroundColor = 'rgba(99, 102, 241, 0.12)';
            btn.style.color = 'var(--accent-color)';
        } else {
            label.textContent = 'Off';
            btn.style.borderColor = '';
            btn.style.backgroundColor = '';
            btn.style.color = '';
        }
    },

    // Sayfa Biçimlendirme Ayarını Açma / Kapatma
    async toggleSmartReformat() {
        this.settings.smartReformat = !this.settings.smartReformat;
        await settingsDb.set('readerSmartReformat', this.settings.smartReformat);
        this.updateSmartReformatUI();

        if (this.currentBookType === 'epub') {
            const savedScrollY = this.getScrollTop();
            this.applyEpubStyles();
            const iframes = document.querySelectorAll("#epub-viewer iframe");
            iframes.forEach(iframe => {
                if (iframe && iframe.contentDocument) {
                    this.syncToTranslationSandbox(iframe.contentDocument);
                }
            });
            this.scheduleExpandEpubIframe(60);
            if (savedScrollY > 0) {
                setTimeout(() => this.setScrollTop(savedScrollY), 40);
            }
        }
    },

    // Paragraf başındaki Drop-Cap (büyük ayrık ilk harf) etiketlerini düz metne çevirip ilk kelimeyle birleştirir
    // (İtalik, kalın vb. diğer tüm yazı stillerini olduğu gibi korur)
    normalizeDropCapsInBlock(block, doc) {
        if (!block || !block.childNodes || block.childNodes.length === 0) return;

        // 1. Yalnızca gerçek Drop-Cap (float:left veya dropcap sınıfı olan kısa başlangıç harfi) elemanlarını düz metne aç
        const unwrapDropCapElements = (parent) => {
            Array.from(parent.childNodes).forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const tag = node.tagName.toLowerCase();
                if (tag === 'img' || tag === 'svg' || tag === 'br') return;

                unwrapDropCapElements(node);

                const cls = ((node.className || '') + ' ' + (node.id || '')).toLowerCase();
                const inlineStyle = (node.getAttribute('style') || '').toLowerCase();
                const txt = (node.textContent || '').trim();
                const isExplicitDropCap = node.getAttribute('data-epub-dropcap') === '1' ||
                                          /drop[-_]?cap|init[-_]?cap|first[-_]?letter|dcb|dcp/i.test(cls) ||
                                          inlineStyle.includes('float: left') || inlineStyle.includes('float:left');

                if (isExplicitDropCap && txt.length <= 4) {
                    while (node.firstChild) {
                        parent.insertBefore(node.firstChild, node);
                    }
                    parent.removeChild(node);
                }
            });
        };

        unwrapDropCapElements(block);

        // 2. Baştaki boş metin düğümlerini temizle
        while (block.firstChild && block.firstChild.nodeType === Node.TEXT_NODE && !(block.firstChild.nodeValue || '').trim()) {
            block.removeChild(block.firstChild);
        }

        // 3. Eğer ilk düğüm tek büyük harften oluşan bir sarmalayıcıysa ve hemen arkasından kelimenin küçük harfli devamı geliyorsa ("<span>T</span>he"), ilk harfi düz metne çevir
        const firstNode = block.firstChild;
        if (firstNode && firstNode.nodeType === Node.ELEMENT_NODE) {
            const firstTag = firstNode.tagName.toLowerCase();
            const firstText = (firstNode.textContent || '').trim();
            const isSingleInitial = /^["“'‘«]?[A-ZÇĞİÖŞÜ]["”'’»]?$/.test(firstText);
            const nextSibling = firstNode.nextSibling;
            const nextText = nextSibling ? (nextSibling.textContent || '') : '';
            const continuesSameWord = /^[a-zçğıöşü]/.test(nextText.trimStart());
            const isDropCapStyled = firstNode.getAttribute('data-epub-dropcap') === '1' ||
                                    /drop|cap|init|first[-_]?letter|let\b/i.test((firstNode.className || '') + ' ' + (firstNode.id || ''));

            if (isSingleInitial && (continuesSameWord || isDropCapStyled || firstTag === 'span') && firstTag !== 'img' && firstTag !== 'svg') {
                const textReplacement = doc.createTextNode(firstText);
                block.replaceChild(textReplacement, firstNode);
            }
        }

        block.normalize();

        // 4. İlk metin düğümünün başında tek büyük harf ile kelimenin devamı arasında yapay boşluk kalmışsa birleştir
        if (block.firstChild && block.firstChild.nodeType === Node.TEXT_NODE) {
            let val = block.firstChild.nodeValue || '';
            // "A" ve "I" İngilizce tek harfli kelimeler olabilir ("A thing", "I was"), diğer tek büyük harfler + küçük harf devamı ("T he", "W hen") kesinlikle aynı kelimedir
            val = val.replace(/^(\s*["“'‘«]?[B-HJ-ZÇĞİÖŞÜ])\s+([a-zçğıöşü])/, '$1$2');
            block.firstChild.nodeValue = val;
        }
    },

    // HTML içerisindeki tüm italik, kalın, altı çizili ve özel stilleri (<i>, <em>, <b>, <strong>, <u>, <span class="...">)
    // iç içe geçmiş olsalar veya birden fazla cümleye yayılsalar bile birebir koruyarak cümlelere ayırır
    extractSentencesWithHtml(containerNode) {
        const sentences = [[]];
        const abbrRegex = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|vb|orn|bkz|No|Vol|Ch|Pt|Fig|Inc|Ltd)\.\s*$/i;

        const pushHtmlToCurrent = (htmlStr) => {
            if (!htmlStr) return;
            sentences[sentences.length - 1].push(htmlStr);
        };
        const finishSentence = () => {
            if (sentences[sentences.length - 1].length > 0) {
                sentences.push([]);
            }
        };
        const escapeHtml = (str) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const buildWrapperStrings = (wrappers) => {
            if (!wrappers || wrappers.length === 0) return { start: '', end: '' };
            const start = wrappers.map(w => w.open).join('');
            const end = wrappers.slice().reverse().map(w => w.close).join('');
            return { start, end };
        };

        const processText = (text, wrappers) => {
            const { start, end } = buildWrapperStrings(wrappers);
            const regex = /[^.!?…]+(?:[.!?…]+["”'’)\]]*\s*|$)/g;
            const matches = text.match(regex) || [text];
            for (let i = 0; i < matches.length; i++) {
                const piece = matches[i];
                if (!piece) continue;
                pushHtmlToCurrent(start + escapeHtml(piece) + end);
                const trimmed = piece.trim();
                const endsWithPunct = /[.!?…]["”'’)\]]*$/.test(trimmed);
                const isAbbr = abbrRegex.test(trimmed) || /\b[A-ZÇĞİÖŞÜ]\.$/.test(trimmed);
                if (endsWithPunct && !isAbbr) {
                    finishSentence();
                }
            }
        };

        const getWrappersForElement = (el, currentWrappers) => {
            const next = currentWrappers.slice();
            const tag = el.tagName.toLowerCase();
            const inlineStyle = (el.getAttribute('style') || '').toLowerCase();
            const cls = (el.className || '').trim();
            const clsLower = cls.toLowerCase();

            const isItalic = tag === 'i' || tag === 'em' ||
                             el.getAttribute('data-epub-italic') === '1' ||
                             /\b(?:italic|italics|em|oblique)\b/.test(clsLower) ||
                             inlineStyle.includes('font-style: italic') || inlineStyle.includes('font-style:italic') ||
                             inlineStyle.includes('font-style: oblique') || inlineStyle.includes('font-style:oblique');

            const isBold = tag === 'b' || tag === 'strong' ||
                           el.getAttribute('data-epub-bold') === '1' ||
                           /\b(?:bold|strong|semibold)\b/.test(clsLower) ||
                           inlineStyle.includes('font-weight: bold') || inlineStyle.includes('font-weight:bold') ||
                           inlineStyle.includes('font-weight: 700') || inlineStyle.includes('font-weight:700') ||
                           inlineStyle.includes('font-weight: 600') || inlineStyle.includes('font-weight:600');

            const isUnderline = tag === 'u' ||
                                el.getAttribute('data-epub-underline') === '1' ||
                                inlineStyle.includes('text-decoration: underline') || inlineStyle.includes('text-decoration:underline');

            // EPUB sınıfını koru (dropcap olmayan span/i/b sınıfları)
            if (cls && !/drop[-_]?cap|init[-_]?cap|first[-_]?letter|dcb|dcp|endlessr-/i.test(cls)) {
                const safeTag = (tag === 'span' || tag === 'i' || tag === 'em' || tag === 'b' || tag === 'strong' || tag === 'u' || tag === 'sub' || tag === 'sup' || tag === 'small') ? tag : 'span';
                next.push({ open: `<${safeTag} class="${escapeHtml(cls)}">`, close: `</${safeTag}>` });
            }

            if (isBold && !next.some(w => w.open === '<b>' || w.open.startsWith('<b ') || w.open.startsWith('<strong'))) {
                next.push({ open: '<b>', close: '</b>' });
            }
            if (isItalic && !next.some(w => w.open === '<i>' || w.open.startsWith('<i ') || w.open.startsWith('<em'))) {
                next.push({ open: '<i>', close: '</i>' });
            }
            if (isUnderline && !next.some(w => w.open === '<u>' || w.open.startsWith('<u '))) {
                next.push({ open: '<u>', close: '</u>' });
            }
            if ((tag === 's' || tag === 'strike' || tag === 'del' || tag === 'sub' || tag === 'sup' || tag === 'small' || tag === 'code') &&
                !next.some(w => w.open.startsWith(`<${tag}`))) {
                next.push({ open: `<${tag}>`, close: `</${tag}>` });
            }
            if (tag === 'a') {
                const href = (el.getAttribute('href') || '').trim();
                if (href) {
                    next.push({ open: `<a href="${escapeHtml(href)}">`, close: '</a>' });
                }
            }

            return next;
        };

        // Eğer paragrafın (containerNode) kendisi EPUB stilinde italik veya kalınsa başlangıç sarmalayıcısına ekle
        const rootWrappers = getWrappersForElement(containerNode, []);

        const walk = (node, wrappers) => {
            if (node.nodeType === Node.TEXT_NODE) {
                processText(node.nodeValue || '', wrappers);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (tag === 'br') {
                    finishSentence();
                    return;
                }
                const nextWrappers = getWrappersForElement(node, wrappers);
                Array.from(node.childNodes).forEach(child => walk(child, nextWrappers));
            }
        };

        Array.from(containerNode.childNodes).forEach(child => walk(child, rootWrappers));
        return sentences
            .map(tokens => tokens.join('').replace(/\s+/g, ' ').trim())
            .filter(s => s.length > 0);
    },

    // Prototip Sayfa Düzenine Göre Kitap Sayfasını Akıllı Yeniden Biçimlendirme
    applySmartReformatToDoc(doc) {
        if (!doc || !doc.body) return;
        const body = doc.body;

        // 1. Ayar kapalıysa ve daha önce biçimlendirilmişse orijinal DOM'u geri yükle
        if (!this.settings.smartReformat) {
            if (body.getAttribute('data-smart-reformatted') === 'true' && body.__endlessrOrigHtml !== undefined) {
                const footer = body.querySelector('.epub-chapter-footer');
                const spacer = body.querySelector('.epub-chapter-spacer');
                body.querySelectorAll('.endlessr-page-word-count').forEach(el => el.remove());
                if (footer) footer.remove();
                if (spacer) spacer.remove();

                body.innerHTML = body.__endlessrOrigHtml;
                body.classList.remove('endlessr-reformatted-body');
                body.removeAttribute('data-smart-reformatted');

                if (footer) body.appendChild(footer);
                if (spacer) body.appendChild(spacer);
            }
            return;
        }

        // Zaten biçimlendirilmişse tekrar işleme
        if (body.getAttribute('data-smart-reformatted') === 'true') {
            body.classList.add('endlessr-reformatted-body');
            return;
        }

        // Bölüm başı kelime sayacı, bölüm sonu butonları ve boşluk elemanını geçici olarak ayır
        body.querySelectorAll('.endlessr-page-word-count').forEach(el => el.remove());
        const footer = body.querySelector('.epub-chapter-footer');
        const spacer = body.querySelector('.epub-chapter-spacer');
        if (footer) footer.remove();
        if (spacer) spacer.remove();

        // Orijinal HTML'i kaydet
        if (body.__endlessrOrigHtml === undefined) {
            body.__endlessrOrigHtml = body.innerHTML;
        }

        // İçindekiler (TOC) sayfası olup olmadığını kontrol et (TOC sayfalarını bozma)
        const tocNav = body.querySelector('nav[epub\\:type="toc"], nav#toc, .toc');
        const allLinks = Array.from(body.querySelectorAll('a[href]'));
        const internalLinks = allLinks.filter(a => {
            const href = (a.getAttribute('href') || '').trim();
            return href && !/^(https?:\/\/|www\.|mailto:|tel:|discord\.gg)/i.test(href);
        });
        const bodyPlainText = (body.innerText || body.textContent || '').trim();
        const internalLinkTextLen = internalLinks.reduce((acc, a) => acc + ((a.innerText || a.textContent || '').trim().length), 0);
        if (tocNav || (internalLinks.length >= 8 && bodyPlainText.length > 0 && internalLinkTextLen / bodyPlainText.length > 0.55)) {
            if (footer) body.appendChild(footer);
            if (spacer) body.appendChild(spacer);
            return;
        }

        // Canlı DOM üzerinde EPUB CSS sınıflarından gelen italik, kalın, altı çizili ve drop-cap stillerini işaretle
        // (Böylece .calibre5 gibi sınıf tabanlı italik/kalın yazılar yeniden biçimlendirme sonrasında da stillerini kaybetmez)
        const win = doc.defaultView;
        if (win && typeof win.getComputedStyle === 'function') {
            try {
                const liveElements = body.querySelectorAll('p, span, div, i, em, b, strong, u, font, blockquote, li');
                liveElements.forEach(el => {
                    const cs = win.getComputedStyle(el);
                    if (!cs) return;
                    if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') {
                        el.setAttribute('data-epub-italic', '1');
                    }
                    const fw = cs.fontWeight;
                    if (fw === 'bold' || fw === 'bolder' || (parseInt(fw, 10) >= 600)) {
                        el.setAttribute('data-epub-bold', '1');
                    }
                    const td = cs.textDecorationLine || cs.textDecoration || '';
                    if (td.includes('underline') && el.tagName.toLowerCase() !== 'a') {
                        el.setAttribute('data-epub-underline', '1');
                    }
                    if (cs.float === 'left' || cs.float === 'right') {
                        el.setAttribute('data-epub-dropcap', '1');
                    }
                });
            } catch (e) {}
        }

        // Çalışma kopyası oluştur
        const workRoot = doc.createElement('div');
        workRoot.innerHTML = body.innerHTML;

        // A. Reklam / Kaynak Site / Harici Linkleri Temizle (İçindekiler / Bölüm İçi Linkler Hariç)
        const externalUrlRegex = /(?:https?:\/\/\S+|www\.\S+|\b(?:discord\.gg|patreon\.com|ko-fi\.com|bit\.ly|t\.me)\/\S+|\b[a-z0-9-]+\.(?:com|net|org|xyz|io|me|co|site|online|info|club)\b(?:\/\S*)?)/gi;
        const promoTextRegex = /(?:read\s+(?:first|latest|more|free)\s+(?:chapters?\s+)?(?:at|on)|visit\s+our\s+(?:website|site)|translated\s+by|join\s+our\s+discord|support\s+us\s+on\s+patreon|bu\s+bölüm\s+.*?\s+tarafından\s+çevrilmiştir|daha\s+fazla\s+bölüm\s+için)/i;

        Array.from(workRoot.querySelectorAll('a')).forEach(a => {
            const href = (a.getAttribute('href') || '').trim();
            const txt = (a.innerText || a.textContent || '').trim();
            const isExternalHref = /^(https?:\/\/|www\.|mailto:)/i.test(href) || externalUrlRegex.test(href);
            externalUrlRegex.lastIndex = 0;
            const isExternalText = externalUrlRegex.test(txt);
            externalUrlRegex.lastIndex = 0;

            if (isExternalHref || isExternalText) {
                // Eğer linkin metni sadece bir URL veya reklam metni ise tamamen kaldır
                const stripped = txt.replace(externalUrlRegex, '').trim();
                externalUrlRegex.lastIndex = 0;
                if (!stripped || promoTextRegex.test(txt)) {
                    a.remove();
                } else {
                    // Normal bir kelimenin üzerine reklam linki konmuşsa linki kaldırıp metni koru
                    const textNode = doc.createTextNode(stripped);
                    a.replaceWith(textNode);
                }
            }
        });

        // B. Yaprak Blokları Sırasıyla Çıkar
        const leafBlocks = [];
        const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'li', 'hr', 'table', 'figure', 'svg', 'img']);
        const containerTags = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'ul', 'ol']);

        const collectBlocks = (parent) => {
            Array.from(parent.childNodes).forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const txt = (node.nodeValue || '').trim();
                    if (txt) {
                        const p = doc.createElement('p');
                        p.textContent = txt;
                        leafBlocks.push(p);
                    }
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const tag = node.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

                if (tag === 'img' || tag === 'svg' || tag === 'hr' || tag === 'table' || tag === 'figure') {
                    leafBlocks.push(node.cloneNode(true));
                    return;
                }

                if (tag === 'blockquote') {
                    leafBlocks.push(node.cloneNode(true));
                    return;
                }

                const hasChildBlocks = Array.from(node.children).some(ch => {
                    const chTag = ch.tagName.toLowerCase();
                    return blockTags.has(chTag) || containerTags.has(chTag);
                });

                if (!hasChildBlocks || /^h[1-6]$/.test(tag) || tag === 'p' || tag === 'li' || tag === 'pre') {
                    leafBlocks.push(node.cloneNode(true));
                } else {
                    collectBlocks(node);
                }
            });
        };

        collectBlocks(workRoot);
        if (leafBlocks.length === 0) {
            if (footer) body.appendChild(footer);
            if (spacer) body.appendChild(spacer);
            return;
        }

        // Yardımcı Sınıflandırıcılar
        const isPureMediaBlock = (el) => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'img' || tag === 'svg' || tag === 'hr' || tag === 'table' || tag === 'figure') return true;
            if (el.querySelector('img, svg') && (el.innerText || el.textContent || '').trim().length === 0) return true;
            return false;
        };

        const getInlineStyledRatio = (el) => {
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt) return 0;
            if (el.getAttribute('data-epub-italic') === '1' || el.getAttribute('data-epub-bold') === '1') {
                return 1;
            }
            const selector = 'i, em, b, strong, [data-epub-italic="1"], [data-epub-bold="1"]';
            const styledNodes = el.querySelectorAll(selector);
            let styledLen = 0;
            styledNodes.forEach(sn => {
                // İç içe geçmiş i/b etiketlerini çift saymamak için yalnızca en üst eşleşmeyi topla
                if (!sn.parentElement || !sn.parentElement.closest(selector)) {
                    styledLen += ((sn.innerText || sn.textContent || '').trim().length);
                }
            });
            return styledLen / txt.length;
        };

        const wrapWithBlockInlineStyle = (el, innerHtmlStr) => {
            let res = innerHtmlStr;
            if (el.getAttribute('data-epub-bold') === '1' && !/^<(?:b|strong)\b/i.test(res)) {
                res = `<b>${res}</b>`;
            }
            if (el.getAttribute('data-epub-italic') === '1' && !/^<(?:i|em)\b/i.test(res)) {
                res = `<i>${res}</i>`;
            }
            return res;
        };

        const isMostlyStyledInline = (el) => {
            return getInlineStyledRatio(el) >= 0.72;
        };

        const isStatOrSystemLineText = (text) => {
            const t = (text || '').trim();
            if (!t || t.length > 160) return false;
            // "GÜÇ: 14 falan filan", "CAN: 23", "Class: Reaper", "Sınıf: ...", "Seviye: 5" gibi KEY: Value satırları
            if (/^[A-ZÇĞİÖŞÜa-zçğıöşü0-9\s/()\-_'’+]{1,36}:\s*.+$/.test(t) && !/^(?:not|dipnot|örnek|açıklama|uyarı|ipucu|hatırlatma|note|warning)\s*:/i.test(t)) {
                return true;
            }
            // [Sistem Bildirimi], <Yetkinlik ...>, 【...】
            if (/^(?:\[[^[\]]+\]|<[^<>]+>|【[^【】]+】|\{[^}]+\})$/.test(t)) {
                return true;
            }
            // Kısa durum/stat/sınıf anahtar kelimeli satırlar (ör. "Level Up!", "+2 Strength", "Class Acquired: ...")
            if (t.length <= 95 && /(?:\b(?:lv\.?|lvl|level|tier|rank|grade|class|skill|stat|status|title|passive|active|sınıf|seviye|durum|yetenek|unvan|güç|can|hız|zeka)\b|[+\-]\d+\s+[a-zA-ZçğıöşüÇĞİÖŞÜ])/i.test(t) && !/[.!?]{1}\s+[A-ZÇĞİÖŞÜ]/.test(t)) {
                if (!/[.!?]$/.test(t) || /[:\[\]<>+%]/.test(t)) {
                    return true;
                }
            }
            return false;
        };

        const isShortSpecialOrStatBlock = (el, prevWasStat = false) => {
            if (!el || isPureMediaBlock(el)) return false;
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt) return false;

            // <br> ile ayrılmış çoklu kısa satırlar (ör. statü ekranı veya şiir/sistem bloğu)
            if (el.querySelector('br')) {
                const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                if (lines.length >= 2 && lines.every(l => l.length <= 135)) {
                    return true;
                }
            }

            if (isStatOrSystemLineText(txt)) return true;

            const styledRatio = getInlineStyledRatio(el);

            // Tamamı veya yarısı italik/kalın yazılan durum, stat, sınıf veya bildirim satırları
            if (styledRatio >= 0.72) {
                if (txt.length <= 105) return true;
                if (prevWasStat && txt.length <= 180) return true;
            } else if (styledRatio >= 0.35 && txt.length <= 125) {
                if (prevWasStat) return true;
                if (!/[.!?]$/.test(txt) || /[:\[\]<>+%0-9/()]|\b(?:stat|status|class|skill|title|level|rank|tier|grade|attribute|passive|active|durum|sınıf|seviye|yetenek|unvan|güç|can|hız|zeka|mana|hp|mp)\b/i.test(txt)) {
                    return true;
                }
            }

            return false;
        };

        const isHeadingCandidate = (el, idx) => {
            if (!el || isPureMediaBlock(el)) return false;
            const tag = el.tagName.toLowerCase();
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt || txt.length > 130) return false;
            // Tek harfli drop-cap bloklarını başlık sanma
            if (/^["“'‘«]?[A-ZÇĞİÖŞÜ]["”'’»]?$/.test(txt)) return false;
            if (/^h[1-6]$/.test(tag)) return true;
            if (idx <= 2) {
                if (/^(?:chapter|bölüm|kısım|cilt|part|volume|vol\.?|prologue|epilogue|prolog|epilog|giriş|önsöz)\b/i.test(txt)) {
                    return true;
                }
                if (txt.length <= 85 && !/[.!?]$/.test(txt) && !isStatOrSystemLineText(txt)) {
                    return true;
                }
            }
            return false;
        };

        const isEpigraphCandidate = (el) => {
            if (!el || isPureMediaBlock(el)) return false;
            const tag = el.tagName.toLowerCase();
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt || txt.length > 650) return false;
            if (isStatOrSystemLineText(txt)) return false;
            if (tag === 'blockquote') return true;
            if (isMostlyStyledInline(el) && txt.length >= 20) return true;
            if (/^["“'‘«].*["”'’»](?:\s*[-–—~]\s*.+)?$/.test(txt)) return true;
            return false;
        };

        // C. Blokları Filtrele (Reklam/Watermark Satırlarını Ayıkla ve Karma <br> Bloklarını Çöz)
        const cleanBlocks = [];
        for (let i = 0; i < leafBlocks.length; i++) {
            const el = leafBlocks[i];
            if (isPureMediaBlock(el)) {
                cleanBlocks.push(el);
                continue;
            }
            let txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt) continue;

            // Tamamen URL veya site reklamından oluşan satırları atla
            if (txt.length < 180 && (externalUrlRegex.test(txt) || promoTextRegex.test(txt))) {
                externalUrlRegex.lastIndex = 0;
                const stripped = txt.replace(externalUrlRegex, '').trim();
                externalUrlRegex.lastIndex = 0;
                if (!stripped || promoTextRegex.test(txt)) {
                    continue;
                }
            }
            externalUrlRegex.lastIndex = 0;

            // Eğer bir <p> içinde <br> ile normal anlatım cümlesi + ardından stat/italik satırlar bir arada yazılmışsa ayır
            if (el.querySelector('br') && !isShortSpecialOrStatBlock(el, false)) {
                const rawParts = el.innerHTML.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
                if (rawParts.length >= 2) {
                    const tempFirst = doc.createElement('p');
                    tempFirst.innerHTML = rawParts[0];
                    const tempSecond = doc.createElement('p');
                    tempSecond.innerHTML = rawParts[1];
                    if (!isShortSpecialOrStatBlock(tempFirst, false) && isShortSpecialOrStatBlock(tempSecond, false)) {
                        cleanBlocks.push(tempFirst);
                        const restP = doc.createElement('p');
                        restP.innerHTML = rawParts.slice(1).join('<br>');
                        cleanBlocks.push(restP);
                        continue;
                    }
                }
            }

            cleanBlocks.push(el);
        }

        // Eğer ayrı bir blok olarak tek harfli Drop-Cap ("A", "T" vb.) varsa sonraki metin bloğunun ilk kelimesiyle birleştir
        for (let i = 0; i < cleanBlocks.length - 1; i++) {
            const cur = cleanBlocks[i];
            const nxt = cleanBlocks[i + 1];
            if (isPureMediaBlock(cur) || isPureMediaBlock(nxt)) continue;
            const curTxt = (cur.innerText || cur.textContent || '').trim();
            if (/^["“'‘«]?[A-ZÇĞİÖŞÜ]["”'’»]?$/.test(curTxt)) {
                this.normalizeDropCapsInBlock(nxt, doc);
                const nxtTxt = (nxt.innerText || nxt.textContent || '').trim();
                const joinWithSpace = (/^["“'‘«]?[AI]$/.test(curTxt) && /^[A-ZÇĞİÖŞÜ]/.test(nxtTxt));
                nxt.innerHTML = curTxt + (joinWithSpace ? ' ' : '') + nxt.innerHTML.trimStart();
                this.normalizeDropCapsInBlock(nxt, doc);
                cleanBlocks.splice(i, 1);
                i--;
            }
        }

        if (cleanBlocks.length === 0) {
            if (footer) body.appendChild(footer);
            if (spacer) body.appendChild(spacer);
            return;
        }

        // D. Yeni Biçimlendirilmiş DOM'u İnşa Et
        const newFragment = doc.createDocumentFragment();
        let cursor = 0;

        // Başlangıçtaki kapak/bölüm görsellerini koru
        while (cursor < cleanBlocks.length && isPureMediaBlock(cleanBlocks[cursor])) {
            newFragment.appendChild(cleanBlocks[cursor]);
            cursor++;
        }

        // 1. ANA BAŞLIK (Varsa ilk başlık ortada ve kalın)
        if (cursor < cleanBlocks.length && isHeadingCandidate(cleanBlocks[cursor], 0)) {
            const mainTitleEl = doc.createElement('h2');
            mainTitleEl.className = 'endlessr-main-title';
            mainTitleEl.textContent = (cleanBlocks[cursor].innerText || cleanBlocks[cursor].textContent || '').replace(/\s+/g, ' ').trim();
            newFragment.appendChild(mainTitleEl);
            cursor++;

            // 2. ALT BAŞLIK (VARSA) - Ana başlığın hemen altındaki ikinci başlık sola yatık
            if (cursor < cleanBlocks.length && isHeadingCandidate(cleanBlocks[cursor], 1) && !isEpigraphCandidate(cleanBlocks[cursor])) {
                const subTitleEl = doc.createElement('h3');
                subTitleEl.className = 'endlessr-sub-title';
                subTitleEl.textContent = (cleanBlocks[cursor].innerText || cleanBlocks[cursor].textContent || '').replace(/\s+/g, ' ').trim();
                newFragment.appendChild(subTitleEl);
                cursor++;
            }
        }

        // 3. HİKAYE ÖNCESİ İTALİK / KALIN / ALINTI GİRİŞ PARAGRAFI (EPİGRAF)
        // Prototipe göre: Ana/alt başlıktan sonra hikaye başlamadan önce italik/kalın/alıntı bir kısım varsa
        // sola yatık, ilk cümlesi paragraf girintili, tek bir paragraf halinde ve kendi stilini koruyarak yazılır.
        const epigraphParts = [];
        while (cursor < cleanBlocks.length && isEpigraphCandidate(cleanBlocks[cursor])) {
            const epEl = cleanBlocks[cursor];
            this.normalizeDropCapsInBlock(epEl, doc);
            // İçindeki <br> veya alt <p> etiketlerini tek paragraf akışında birleştir
            const innerPList = epEl.querySelectorAll('p');
            if (innerPList.length > 0) {
                innerPList.forEach(ip => {
                    this.normalizeDropCapsInBlock(ip, doc);
                    const h = wrapWithBlockInlineStyle(ip, ip.innerHTML.replace(/<br\s*\/?>/gi, ' ').trim());
                    if (h) epigraphParts.push(h);
                });
            } else {
                const h = wrapWithBlockInlineStyle(epEl, epEl.innerHTML.replace(/<br\s*\/?>/gi, ' ').trim());
                if (h) epigraphParts.push(h);
            }
            cursor++;
            if (epigraphParts.length >= 4) break;
        }
        if (epigraphParts.length > 0) {
            const epigraphP = doc.createElement('p');
            epigraphP.className = 'endlessr-epigraph';
            epigraphP.innerHTML = epigraphParts.join(' ');
            newFragment.appendChild(epigraphP);
        }

        // 4. ANA HİKAYE AKIŞI VE STATÜ / BAŞARIM / KISA İTALİK-KALIN BLOKLAR
        let currentStatGroup = null;
        const flushStatGroup = () => {
            if (currentStatGroup && currentStatGroup.childNodes.length > 0) {
                newFragment.appendChild(currentStatGroup);
            }
            currentStatGroup = null;
        };

        // Durum / stat / sınıf / yarı-italik bloklardan hemen önce gelen anlatım cümleleri
        // 3 cümleden azsa (1 veya 2 cümle ise) bir önceki anlatım paragrafıyla birleştirir
        const mergeShortNarrativeBeforeStat = () => {
            while (newFragment.lastElementChild &&
                   newFragment.lastElementChild.classList &&
                   newFragment.lastElementChild.classList.contains('endlessr-narrative-p')) {
                const lastP = newFragment.lastElementChild;
                const sCount = lastP._sentenceCount || 1;
                const prevP = lastP.previousElementSibling;
                if (sCount < 3 && prevP && prevP.classList && prevP.classList.contains('endlessr-narrative-p')) {
                    prevP.innerHTML = prevP.innerHTML.trim() + ' ' + lastP.innerHTML.trim();
                    prevP._sentenceCount = (prevP._sentenceCount || 1) + sCount;
                    lastP.remove();
                } else {
                    break;
                }
            }
        };

        for (; cursor < cleanBlocks.length; cursor++) {
            const block = cleanBlocks[cursor];

            if (isPureMediaBlock(block)) {
                flushStatGroup();
                newFragment.appendChild(block);
                continue;
            }

            const prevWasStat = currentStatGroup !== null;
            if (isShortSpecialOrStatBlock(block, prevWasStat)) {
                if (!currentStatGroup) {
                    // Stat / durum / sınıf bloğu başlamadan hemen önceki paragraf < 3 cümle ise önceki paragrafla birleştir
                    mergeShortNarrativeBeforeStat();
                    currentStatGroup = doc.createElement('div');
                    currentStatGroup.className = 'endlessr-stat-block';
                }

                // Eğer blok içinde <br> varsa her satırı ayrı bir .endlessr-stat-line yap
                if (block.querySelector('br')) {
                    const rawLines = block.innerHTML.split(/<br\s*\/?>/i);
                    rawLines.forEach(lineHtml => {
                        const cleanLine = lineHtml.trim();
                        if (cleanLine) {
                            const lineP = doc.createElement('p');
                            lineP.className = 'endlessr-stat-line';
                            lineP.innerHTML = wrapWithBlockInlineStyle(block, cleanLine);
                            currentStatGroup.appendChild(lineP);
                        }
                    });
                } else {
                    const lineP = doc.createElement('p');
                    lineP.className = 'endlessr-stat-line';
                    lineP.innerHTML = wrapWithBlockInlineStyle(block, block.innerHTML.trim());
                    currentStatGroup.appendChild(lineP);
                }
                continue;
            }

            // Normal hikaye paragrafına geçmeden önce açık statü grubunu kapat
            flushStatGroup();

            // Bölüm ortası alt başlık (h1-h6) veya sahne ayırıcı (*** / ---) kontrolü
            const tag = block.tagName.toLowerCase();
            const plainTxt = (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim();
            if (!plainTxt) continue;

            if (/^(?:\*\s*\*\s*\*+|-\s*-\s*-+|~\s*~\s*~+|•\s*•\s*•+|\*\*\*|---)$/.test(plainTxt)) {
                const sepP = doc.createElement('p');
                sepP.className = 'endlessr-main-title';
                sepP.style.fontSize = '1.1em';
                sepP.textContent = '* * *';
                newFragment.appendChild(sepP);
                continue;
            }

            if (/^h[1-6]$/.test(tag) && plainTxt.length <= 120) {
                const subH = doc.createElement('h3');
                subH.className = 'endlessr-sub-title';
                subH.textContent = plainTxt;
                newFragment.appendChild(subH);
                continue;
            }

            // 5. NORMAL HİKAYE PARAGRAFI: Drop-Cap Birleştirme + 3-4 Cümlelik Paragraflara Bölme
            this.normalizeDropCapsInBlock(block, doc);
            const sentences = this.extractSentencesWithHtml(block);
            if (sentences.length <= 4) {
                const p = doc.createElement('p');
                p.className = 'endlessr-narrative-p';
                p._sentenceCount = Math.max(1, sentences.length);
                p.innerHTML = sentences.length > 0 ? sentences.join(' ') : block.innerHTML.trim();
                newFragment.appendChild(p);
            } else {
                let sIdx = 0;
                const totalS = sentences.length;
                while (sIdx < totalS) {
                    const rem = totalS - sIdx;
                    let take = 4;
                    if (rem <= 4) {
                        take = rem;
                    } else if (rem === 5 || rem === 6) {
                        take = 3;
                    } else if (rem === 7) {
                        take = 4;
                    } else {
                        // İlk 3 cümlenin toplam uzunluğu uzunsa 3 cümle, kısaysa 4 cümle al
                        const threeLen = (sentences[sIdx].length + sentences[sIdx + 1].length + sentences[sIdx + 2].length);
                        take = threeLen > 340 ? 3 : 4;
                    }
                    const chunkHtml = sentences.slice(sIdx, sIdx + take).join(' ');
                    const p = doc.createElement('p');
                    p.className = 'endlessr-narrative-p';
                    p._sentenceCount = take;
                    p.innerHTML = chunkHtml;
                    newFragment.appendChild(p);
                    sIdx += take;
                }
            }
        }

        flushStatGroup();

        body.innerHTML = '';
        body.appendChild(newFragment);
        body.classList.add('endlessr-reformatted-body');
        body.setAttribute('data-smart-reformatted', 'true');

        if (footer) body.appendChild(footer);
        if (spacer) body.appendChild(spacer);
    },

    // Boşluk Düzeltme Butonu Arayüzünü Güncelleme
    updateFixSpacingUI() {
        const btn = document.getElementById('btn-fix-spacing');
        const label = document.getElementById('fix-spacing-label');
        if (!btn || !label) return;

        if (this.settings.fixSpacing) {
            label.textContent = 'On';
            btn.style.borderColor = 'var(--accent-color)';
            btn.style.backgroundColor = 'rgba(99, 102, 241, 0.12)';
            btn.style.color = 'var(--accent-color)';
        } else {
            label.textContent = 'Off';
            btn.style.borderColor = '';
            btn.style.backgroundColor = '';
            btn.style.color = '';
        }
    },

    // Manuel Boşluk Düzeltme Ayarını Açma / Kapatma
    async toggleFixSpacing() {
        this.settings.fixSpacing = !this.settings.fixSpacing;
        await settingsDb.set('readerFixSpacing', this.settings.fixSpacing);
        this.updateFixSpacingUI();

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        }
    },

    // Paragraf ve Özel Blok (LitRPG Statü Ekranı vb.) Boşluklarını Akıllı Düzenleme
    applySpacingFixToDoc(doc) {
        if (!doc || !doc.body) return;
        const paragraphs = Array.from(doc.body.querySelectorAll('p'));

        if (!this.settings.fixSpacing) {
            paragraphs.forEach(p => {
                if (p.getAttribute('data-spacing-adjusted') === 'true') {
                    p.style.marginTop = p.getAttribute('data-orig-mt') || '';
                    p.style.marginBottom = p.getAttribute('data-orig-mb') || '';
                    p.removeAttribute('data-spacing-adjusted');
                }
            });
            return;
        }

        const isStatusOrSpecialLine = (p) => {
            if (!p) return false;
            const text = (p.innerText || p.textContent || '').trim();
            if (!text) return true;
            if (p.querySelector('br')) return true;
            if (text.length < 85) {
                // "Adı: Asher", "Yetenek: (Kilitli)" gibi iki nokta üst üste içeren kısa statü satırları
                if (/^[^.!?]{1,35}:\s*.+$/.test(text)) return true;
                // Köşeli parantez veya sistem bildirimi satırları
                if (/^[\[<【].*[\]>】]$/.test(text)) return true;
                // Tamamı kalın (bold) olan kısa satırlar
                const boldChild = p.querySelector('b, strong');
                if (boldChild && (boldChild.innerText || boldChild.textContent || '').trim().length >= text.length * 0.8) {
                    return true;
                }
                // Cümle bitiş noktalama işareti olmayan kısa satırlar
                if (!/[.!?…"”'’]$/.test(text)) return true;
            }
            return false;
        };

        paragraphs.forEach(p => {
            if (!p.hasAttribute('data-orig-mt')) {
                p.setAttribute('data-orig-mt', p.style.marginTop || '');
                p.setAttribute('data-orig-mb', p.style.marginBottom || '');
            }

            if (isStatusOrSpecialLine(p)) {
                // Statü ekranı satırlarının kendi grup yapısını, girintisini ve bitişikliğini koru
                if (p.getAttribute('data-spacing-adjusted') === 'true') {
                    p.style.marginTop = p.getAttribute('data-orig-mt') || '';
                    p.style.marginBottom = p.getAttribute('data-orig-mb') || '';
                    p.removeAttribute('data-spacing-adjusted');
                }
            } else {
                // Normal anlatım/diyalog paragraflarına okunaklı paragraf arası boşluk uygula
                p.style.setProperty('margin-bottom', '0.75em', 'important');
                p.setAttribute('data-spacing-adjusted', 'true');
            }
        });
    },

    // Bir okuyucu temasının açık (light) palete ait olup olmadığını kontrol eder
    isLightTheme(themeName) {
        const lightThemes = ['light', 'sepia', 'warm', 'ocean', 'rose', 'forest'];
        return lightThemes.includes(themeName);
    },

    // Kitap İçi Renk Paleti Modu Seçme (Light / Dark - Ana sayfa temasıyla senkronize)
    async setReaderColorMode(mode) {
        const normalizedMode = mode === 'light' ? 'light' : 'dark';
        this.settings.colorMode = normalizedMode;
        try { localStorage.setItem('endlessr_reader_color_mode', normalizedMode); } catch (e) {}

        const btnLight = document.getElementById('btn-webtheme-light');
        const btnDark = document.getElementById('btn-webtheme-dark');
        if (btnLight && btnDark) {
            btnLight.classList.toggle('active', normalizedMode === 'light');
            btnDark.classList.toggle('active', normalizedMode === 'dark');
        }

        // Ana sayfa temasını da bu modla senkronize et
        if (window.app && typeof window.app.setAppTheme === 'function') {
            await window.app.setAppTheme(normalizedMode, false);
        }

        // Seçilen modun en son kullanılan alt temasını (yoksa varsayılanını) yükle
        const lastLocalKey = normalizedMode === 'light' ? 'endlessr_last_light_theme' : 'endlessr_last_dark_theme';
        const lastDbKey = normalizedMode === 'light' ? 'readerLastLightTheme' : 'readerLastDarkTheme';
        let remembered = null;
        try { remembered = localStorage.getItem(lastLocalKey); } catch (e) {}
        if (!remembered) {
            remembered = await settingsDb.get(lastDbKey, normalizedMode);
        }
        const targetReaderTheme = (this.isLightTheme(remembered) === (normalizedMode === 'light'))
            ? remembered
            : normalizedMode;

        this.updateReaderThemeUI(normalizedMode);
        await this.setReaderTheme(targetReaderTheme, false);
        await settingsDb.set('readerColorMode', normalizedMode);
    },

    // Okuyucu Teması Seçme (Ana sayfa temasıyla senkronize)
    async setReaderTheme(themeName, syncApp = true) {
        this.settings.theme = themeName;
        const targetColorMode = this.isLightTheme(themeName) ? 'light' : 'dark';

        try {
            localStorage.setItem('endlessr_reader_theme', themeName);
            localStorage.setItem('endlessr_reader_color_mode', targetColorMode);
            localStorage.setItem(
                targetColorMode === 'light' ? 'endlessr_last_light_theme' : 'endlessr_last_dark_theme',
                themeName
            );
        } catch (e) {}

        const modeChanged = this.settings.colorMode !== targetColorMode;
        this.settings.colorMode = targetColorMode;

        const btnLight = document.getElementById('btn-webtheme-light');
        const btnDark = document.getElementById('btn-webtheme-dark');
        if (btnLight && btnDark) {
            btnLight.classList.toggle('active', targetColorMode === 'light');
            btnDark.classList.toggle('active', targetColorMode === 'dark');
        }

        if (modeChanged) {
            this.updateReaderThemeUI(targetColorMode);
        }

        if (syncApp && window.app && typeof window.app.setAppTheme === 'function') {
            await window.app.setAppTheme(targetColorMode, false);
        }

        const colors = this.getThemeColors(themeName);
        try { sessionStorage.setItem('endlessr_reader_bg', colors.bg); } catch (e) {}
        document.documentElement.style.backgroundColor = colors.bg;

        // Reader element sınıfını ve arka plan rengini güncelle
        const readerEl = document.getElementById('view-reader');
        readerEl.className = 'reader-view';
        readerEl.classList.add(`theme-${themeName}`);
        readerEl.style.backgroundColor = colors.bg;
        readerEl.style.color = colors.fg;

        if (this.currentBookType === 'epub') {
            this.applyEpubStyles();
        }
        
        // Tema gridinde aktif butonu seç
        const themeButtons = document.querySelectorAll('.theme-grid-btn');
        themeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-theme') === themeName) {
                btn.classList.add('active');
            }
        });

        // WTR Tema gridinde aktif butonu seç
        const wtrThemeButtons = document.querySelectorAll('.wtr-theme-btn');
        wtrThemeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-theme') === themeName) {
                btn.classList.add('active');
            }
        });

        await settingsDb.set('readerTheme', themeName);
        await settingsDb.set('readerColorMode', targetColorMode);
        await settingsDb.set(
            targetColorMode === 'light' ? 'readerLastLightTheme' : 'readerLastDarkTheme',
            themeName
        );
    },

    // WTR Reader Theme butonlarını kitap içi renk moduna göre dinamik güncelle
    updateReaderThemeUI(colorMode) {
        const grid = document.querySelector('.wtr-theme-grid');
        if (!grid) return;
        
        let html = '';
        if (colorMode === 'dark') {
            html = `
                <button class="wtr-theme-btn" data-theme="dark" style="background-color: #1e222b; color: #a0aab8; border-color: rgba(255,255,255,0.15);">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="night" style="background-color: #0f1115; color: #ffffff; border-color: rgba(255,255,255,0.15);">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="dark-navy" style="background-color: #122435; color: #8cb3db; border-color: rgba(255,255,255,0.15);">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="dark-sepia" style="background-color: #2c2824; color: #d5c7b9; border-color: rgba(255,255,255,0.15);">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="dark-slate" style="background-color: #1b2631; color: #aabecf; border-color: rgba(255,255,255,0.15);">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="dark-green" style="background-color: #1b2b20; color: #a8c3ad; border-color: rgba(255,255,255,0.15);">"Aa"</button>
            `;
        } else {
            html = `
                <button class="wtr-theme-btn" data-theme="light" style="background-color: #ffffff; color: #1f2937;">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="sepia" style="background-color: #f8efe0; color: #3c2f1e;">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="warm" style="background-color: #faf2e4; color: #433422;">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="ocean" style="background-color: #eef4f8; color: #1b2b34;">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="rose" style="background-color: #faf0f2; color: #4a2c3a;">"Aa"</button>
                <button class="wtr-theme-btn" data-theme="forest" style="background-color: #eef5eb; color: #2c3e29;">"Aa"</button>
            `;
        }
        grid.innerHTML = html;
        
        // Yeniden olay dinleyicisi bağla
        document.querySelectorAll('.wtr-theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const theme = e.currentTarget.getAttribute('data-theme');
                this.setReaderTheme(theme);
                document.querySelectorAll('.wtr-theme-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
            if (btn.getAttribute('data-theme') === this.settings.theme) {
                btn.classList.add('active');
            }
        });
    },

    // Tıklanan Koordinattaki Kelime Sınırlarını Bulma (Dokunarak Çeviri için)
    expandRangeToWord(range) {
        if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return;
        
        const text = range.startContainer.textContent;
        let start = range.startOffset;
        let end = range.startOffset;
        
        // Türkçe karakterleri ve kelime içi işaretleri kapsayacak şekilde harf kontrolü
        const isLetter = (char) => char && /[a-zA-Z0-9À-ÿ'-]/.test(char);
        
        while (start > 0 && isLetter(text[start - 1])) {
            start--;
        }
        while (end < text.length && isLetter(text[end])) {
            end++;
        }
        
        range.setStart(range.startContainer, start);
        range.setEnd(range.startContainer, end);
    },

    // Metni TTS için uygun uzunlukta cümle parçalarına bölme yardımcısı
    splitTextIntoTTSChunks(text, maxLen = 220) {
        if (!text) return [];
        const rawSentences = text.match(/[^.!?;\n]+[.!?;\n]*/g) || [text];
        const chunks = [];
        let current = "";

        for (let s of rawSentences) {
            s = s.trim();
            if (!s) continue;
            if ((current + " " + s).trim().length <= maxLen) {
                current = (current + " " + s).trim();
            } else {
                if (current) chunks.push(current);
                if (s.length <= maxLen) {
                    current = s;
                } else {
                    const words = s.split(/\s+/);
                    current = "";
                    for (const w of words) {
                        if ((current + " " + w).trim().length <= maxLen) {
                            current = (current + " " + w).trim();
                        } else {
                            if (current) chunks.push(current);
                            current = w;
                        }
                    }
                }
            }
        }
        if (current) chunks.push(current);
        return chunks;
    },

    // Sıradaki TTS cümle parçasını seslendir
    speakCurrentChunk() {
        if (!this.isSpeakingTTS) return;
        if (!this.ttsChunks || this.ttsCurrentIndex >= this.ttsChunks.length) {
            this.stopTTS();
            return;
        }

        const chunkText = this.ttsChunks[this.ttsCurrentIndex];
        if (!chunkText || !chunkText.trim()) {
            this.ttsCurrentIndex++;
            this.speakCurrentChunk();
            return;
        }

        try {
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }

            const speedSelect = document.getElementById('tts-speed-select');
            const speed = speedSelect ? parseFloat(speedSelect.value) : 1.0;

            const utterance = new SpeechSynthesisUtterance(chunkText);
            utterance.rate = speed || 1.0;

            const voiceSelect = document.getElementById('tts-voice-select');
            let voiceSet = false;
            const voices = window.speechSynthesis.getVoices();

            if (voiceSelect && voiceSelect.value !== 'default') {
                const selectedVoiceName = voiceSelect.value;
                const matchedVoice = voices.find(v => v.name === selectedVoiceName);
                if (matchedVoice) {
                    utterance.voice = matchedVoice;
                    utterance.lang = matchedVoice.lang;
                    voiceSet = true;
                }
            }

            if (!voiceSet) {
                const hasTurkishChars = /[çğıöşüÇĞİÖŞÜ]/.test(chunkText);
                const targetLang = hasTurkishChars ? 'tr' : 'en';
                utterance.lang = hasTurkishChars ? 'tr-TR' : 'en-US';

                const matchingVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(targetLang));
                if (matchingVoice) {
                    utterance.voice = matchingVoice;
                }
            }

            utterance.onend = () => {
                if (!this.isSpeakingTTS) return;
                this.ttsCurrentIndex++;
                if (this.ttsCurrentIndex < this.ttsChunks.length) {
                    this.speakCurrentChunk();
                } else {
                    this.stopTTS();
                }
            };

            utterance.onerror = (err) => {
                if (err && (err.error === 'interrupted' || err.error === 'canceled')) {
                    return;
                }
                console.warn("TTS parça okuma hatası:", err);
                if (!this.isSpeakingTTS) return;
                this.ttsCurrentIndex++;
                if (this.ttsCurrentIndex < this.ttsChunks.length) {
                    this.speakCurrentChunk();
                } else {
                    this.stopTTS();
                }
            };

            window.speechSynthesis.speak(utterance);
        } catch (err) {
            console.error("TTS speakCurrentChunk hatası:", err);
            this.stopTTS();
        }
    },

    restartTTSFromCurrentChunk() {
        if (!this.isSpeakingTTS || !this.ttsChunks || this.ttsChunks.length === 0) return;
        if (this.ttsTimeout) clearTimeout(this.ttsTimeout);
        try {
            window.speechSynthesis.cancel();
        } catch (e) {}
        this.ttsTimeout = setTimeout(() => {
            if (this.isSpeakingTTS) {
                this.speakCurrentChunk();
            }
        }, 60);
    },

    // Sesli Kitap Okuma Başlat (TTS)
    async startTTS() {
        if (!('speechSynthesis' in window)) {
            alert("Text-to-speech is not supported on this browser.");
            return;
        }

        let textToRead = "";
        
        if (this.currentBookType === 'epub' && this.epubRendition) {
            const iframes = document.querySelectorAll("#epub-viewer iframe");
            let frameTexts = [];
            iframes.forEach(iframe => {
                try {
                    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                        const clone = iframe.contentDocument.body.cloneNode(true);
                        clone.querySelectorAll('.epub-chapter-footer, .endlessr-page-word-count, script, style, noscript').forEach(el => el.remove());
                        frameTexts.push(clone.innerText || clone.textContent || "");
                    }
                } catch (err) {}
            });
            
            if (frameTexts.length > 0) {
                textToRead = frameTexts.join('\n');
            }
            
            if (!textToRead) {
                try {
                    const contents = this.epubRendition.getContents();
                    if (contents && contents.length > 0) {
                        textToRead = contents.map(c => {
                            if (!c.document || !c.document.body) return "";
                            const clone = c.document.body.cloneNode(true);
                            clone.querySelectorAll('.epub-chapter-footer, script, style, noscript').forEach(el => el.remove());
                            return clone.innerText || clone.textContent || "";
                        }).join('\n');
                    }
                } catch (e) {
                    console.warn("EpubJS getContents failed:", e);
                }
            }
        } else if (this.currentBookType === 'pdf' && this.pdfDocument) {
            const textSpans = document.querySelectorAll("#pdf-viewer .textLayer span");
            if (textSpans && textSpans.length > 0) {
                textToRead = Array.from(textSpans).map(span => span.innerText || span.textContent).join(' ');
            }
            
            if (!textToRead) {
                try {
                    const page = await this.pdfDocument.getPage(this.pdfCurrentPage);
                    const textContent = await page.getTextContent();
                    textToRead = textContent.items.map(item => item.str).join(' ');
                } catch (e) {
                    console.error("Could not read PDF text:", e);
                }
            }
        }
        
        textToRead = textToRead.replace(/\s+/g, ' ').trim();
        
        if (!textToRead) {
            alert("No text found to read.");
            return;
        }

        this.ttsChunks = this.splitTextIntoTTSChunks(textToRead, 220);
        this.ttsCurrentIndex = 0;
        this.isSpeakingTTS = true;

        if (this.ttsTimeout) clearTimeout(this.ttsTimeout);
        try {
            window.speechSynthesis.cancel();
        } catch (e) {
            console.warn("SpeechSynthesis cancel failed:", e);
        }

        const btn = document.getElementById('btn-tts-toggle');
        if (btn) {
            btn.innerHTML = '<i data-lucide="pause"></i> Pause';
            lucide.createIcons();
        }

        this.ttsTimeout = setTimeout(() => {
            if (this.isSpeakingTTS) {
                this.speakCurrentChunk();
            }
        }, 60);
    },
    
    stopTTS() {
        this.isSpeakingTTS = false;
        this.ttsChunks = [];
        this.ttsCurrentIndex = 0;
        if (this.ttsTimeout) {
            clearTimeout(this.ttsTimeout);
            this.ttsTimeout = null;
        }
        if ('speechSynthesis' in window) {
            try {
                window.speechSynthesis.cancel();
            } catch (e) {}
        }
        const btn = document.getElementById('btn-tts-toggle');
        if (btn) {
            btn.innerHTML = '<i data-lucide="play"></i> Read';
            lucide.createIcons();
        }
    },

    getCleanVoiceName(voice) {
        const nameLower = voice.name.toLowerCase();
        const isGoogle = nameLower.includes('-x-') || nameLower.includes('google');
        const langCode = voice.lang;
        const isTurkish = langCode.toLowerCase().startsWith('tr');
        const langLabel = isTurkish ? "Turkish" : "English";

        let genderLabel = "";
        if (nameLower.includes('female') || nameLower.includes('zira') || nameLower.includes('seda') || nameLower.includes('hazel') || nameLower.includes('susan') || nameLower.includes('yelda') || nameLower.includes('f-local') || nameLower.includes('f-network')) {
            genderLabel = " (Female)";
        } else if (nameLower.includes('male') || nameLower.includes('tolga') || nameLower.includes('david') || nameLower.includes('george') || nameLower.includes('cem') || nameLower.includes('m-local') || nameLower.includes('m-network')) {
            genderLabel = " (Male)";
        }

        if (isGoogle) {
            // Parse Google name codes like tr-tr-x-tfa-local
            const parts = nameLower.split('-');
            const codePart = parts.find(p => p.length === 3 && (p.startsWith('tf') || p.startsWith('sf') || p.startsWith('ji') || p.startsWith('ki')));
            if (codePart) {
                const letter = codePart.charAt(2).toUpperCase();
                if (!genderLabel) {
                    if (['A', 'C', 'E', 'F', 'G', 'H'].includes(letter)) {
                        genderLabel = " (Female)";
                    } else if (['B', 'D', 'I', 'J'].includes(letter)) {
                        genderLabel = " (Male)";
                    }
                }
                return `Google ${langLabel} Voice ${letter}${genderLabel}`;
            }
            
            // Check for single letter voice at the end of Wavenet/Neural2 names, e.g. en-US-Neural2-F
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.length === 1 && /[a-z]/i.test(lastPart)) {
                const letter = lastPart.toUpperCase();
                if (!genderLabel) {
                    if (['A', 'C', 'E', 'F', 'G', 'H'].includes(letter)) {
                        genderLabel = " (Female)";
                    } else if (['B', 'D', 'I', 'J'].includes(letter)) {
                        genderLabel = " (Male)";
                    }
                }
                return `Google ${langLabel} Voice ${letter}${genderLabel}`;
            }

            // Check if there is a generic Google name, e.g. "Google tr-tr"
            return `Google ${langLabel} Voice${genderLabel}`;
        }

        // Microsoft Zira, David, Hazel etc.
        if (nameLower.includes('microsoft')) {
            let nameOnly = voice.name.replace(/microsoft/i, '').replace(/desktop/i, '').replace(/mobile/i, '').trim();
            // Remove lang code from name, e.g. "Zira - English" -> "Zira"
            nameOnly = nameOnly.split('-')[0].trim();
            return `Microsoft ${nameOnly}${genderLabel}`;
        }

        // Default formatting
        return `${voice.name}${genderLabel}`;
    },

    populateVoices() {
        if (!('speechSynthesis' in window)) return;
        const voiceSelect = document.getElementById('tts-voice-select');
        if (!voiceSelect) return;

        const voices = window.speechSynthesis.getVoices();
        
        // Clear all except default option
        voiceSelect.innerHTML = '<option value="default">Default Voice (Auto)</option>';

        // Filter voices for Turkish (tr) and English (en)
        const relevantVoices = voices.filter(voice => {
            const l = voice.lang.toLowerCase();
            return l.startsWith('tr') || l.startsWith('en');
        });

        const displayVoices = relevantVoices.length > 0 ? relevantVoices : voices;

        displayVoices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.name;
            
            const cleanName = this.getCleanVoiceName(voice);
            option.textContent = `${cleanName} [${voice.lang}]`;
            voiceSelect.appendChild(option);
        });
    },

    // Seçilen aralık (range) tek bir paragrafın dışına taşsa veya birden fazla paragrafı kapsasa bile
    // ilgili [data-original-text] elemanlarını bularak birleştirir
    extractOriginalAndCurrentBlocksFromRange(range, cleanSel = "") {
        if (!range) return { origBlock: "", currBlock: "" };

        let node = range.commonAncestorContainer;
        if (node && node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }

        // 1. Doğrudan [data-original-text] içeren bir üst eleman varsa
        if (node && typeof node.closest === 'function') {
            const directParent = node.closest('[data-original-text]');
            if (directParent) {
                return {
                    origBlock: (directParent.getAttribute('data-original-text') || '').replace(/\s+/g, ' ').trim(),
                    currBlock: (directParent.innerText || directParent.textContent || '').replace(/\s+/g, ' ').trim()
                };
            }
        }

        // 2. Seçim tüm paragrafı / birden fazla paragrafı kapsadığında commonAncestorContainer (body veya kapsayıcı div)
        // altında kalan ve seçimle kesişen [data-original-text] elemanlarını topla
        const searchRoot = (node && node.querySelectorAll) ? node : (range.startContainer && range.startContainer.ownerDocument ? range.startContainer.ownerDocument.body : null);
        if (searchRoot && typeof searchRoot.querySelectorAll === 'function') {
            const candidates = Array.from(searchRoot.querySelectorAll('[data-original-text]'));
            const lowerSel = (cleanSel || '').toLowerCase();
            const intersecting = candidates.filter(el => {
                try {
                    if (typeof range.intersectsNode === 'function' && !range.intersectsNode(el)) {
                        return false;
                    }
                    const elCurr = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!elCurr) return false;
                    if (!lowerSel) return true;
                    const elLower = elCurr.toLowerCase();
                    // Seçimin bitiş tutamacı bir sonraki paragrafın 0. indeksine değdiyse onu dahil etme
                    return lowerSel.includes(elLower) || elLower.includes(lowerSel) ||
                           elLower.split(/\s+/).some(w => w.length >= 3 && lowerSel.includes(w));
                } catch (e) {
                    return false;
                }
            });

            if (intersecting.length > 0) {
                return {
                    origBlock: intersecting.map(el => (el.getAttribute('data-original-text') || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '),
                    currBlock: intersecting.map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
                };
            }
        }

        // 3. Fallback: startContainer'ın kendi paragrafına bak
        let startNode = range.startContainer;
        if (startNode && startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentNode;
        if (startNode && typeof startNode.closest === 'function') {
            const startParent = startNode.closest('[data-original-text]') || startNode.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, div');
            if (startParent) {
                return {
                    origBlock: (startParent.getAttribute('data-original-text') || '').replace(/\s+/g, ' ').trim(),
                    currBlock: (startParent.innerText || startParent.textContent || '').replace(/\s+/g, ' ').trim()
                };
            }
        }

        return { origBlock: "", currBlock: "" };
    },

    // Seçilen metnin (çevrilmiş sayfada veya orijinal sayfada) kitaptaki gerçek orijinal karşılığını ve bağlam cümlesini bulur
    async resolveSelectionTranslationContext(selectedText, range, fallbackSentence = "") {
        const cleanSel = (selectedText || "").replace(/\s+/g, " ").trim();
        if (!cleanSel) {
            return { originalText: "", contextSentence: "", origLang: this.detectedLang || "en", isBlockTranslated: false };
        }

        const { origBlock, currBlock } = this.extractOriginalAndCurrentBlocksFromRange(range, cleanSel);

        // 1. Orijinal dili tespit et (önbellekte yoksa metinden algıla)
        let origLang = this.detectedLang || (this.bookData && this.bookData.detectedLang) || null;
        const sampleForLang = origBlock || cleanSel;
        if (!origLang && sampleForLang) {
            try {
                const det = await translateService.translateGoogleWithDetails(sampleForLang.slice(0, 160), 'tr', 'auto');
                if (det && det.lang) {
                    origLang = det.lang.toLowerCase();
                    this.detectedLang = origLang;
                }
            } catch (e) {}
        }
        if (!origLang) origLang = 'en';

        // 2. Sayfa/paragraf çevrilmemişse (veya seçilen metin doğrudan orijinal blok içinde geçiyorsa):
        // Seçilen metin zaten doğrudan orijinal metindir
        const isBlockTranslated = !!(origBlock && currBlock && origBlock.toLowerCase() !== currBlock.toLowerCase());
        if (!isBlockTranslated || origBlock.toLowerCase().includes(cleanSel.toLowerCase())) {
            // Orijinal metindeki gerçek büyük/küçük harf halini koru
            let exactSlice = cleanSel;
            if (origBlock) {
                const idx = origBlock.toLowerCase().indexOf(cleanSel.toLowerCase());
                if (idx !== -1) {
                    exactSlice = origBlock.substr(idx, cleanSel.length);
                }
            }
            return {
                originalText: exactSlice,
                contextSentence: origBlock || fallbackSentence || exactSlice,
                origLang,
                isBlockTranslated: false
            };
        }

        // 3. Sayfa/paragraf ÇEVRİLMİŞ ise:
        // Seçilen çevrilmiş metnin (cleanSel), origBlock içindeki gerçek orijinal karşılığını bul
        // (Kesinlikle dışarıdan "Rowdy" gibi farklı bir kelime uydurmaz; yalnızca ham metindeki gerçek kelimeyi döndürür)
        const mappedOriginal = await this.getOriginalWordForSelection(cleanSel, range, origBlock, currBlock, origLang);
        return {
            originalText: mappedOriginal || cleanSel,
            contextSentence: origBlock || fallbackSentence || mappedOriginal || cleanSel,
            origLang,
            isBlockTranslated: true
        };
    },

    async getOriginalWordForSelection(selectedText, range, origBlockOverride = null, currBlockOverride = null, origLangOverride = null) {
        if (!selectedText) return "";
        const cleanSel = selectedText.replace(/\s+/g, " ").trim();
        if (!cleanSel) return "";

        let parent = null;
        if (range) {
            let node = range.commonAncestorContainer;
            if (node && node.nodeType === Node.TEXT_NODE) {
                node = node.parentNode;
            }
            if (node && typeof node.closest === 'function') {
                parent = node.closest('[data-original-text]') || node.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, div');
            }
        }

        const originalText = (origBlockOverride || (parent ? parent.getAttribute('data-original-text') : '') || '').replace(/\s+/g, ' ').trim();
        const currentText = (currBlockOverride || (parent ? (parent.innerText || parent.textContent) : '') || '').replace(/\s+/g, ' ').trim();

        if (!originalText) return cleanSel;
        if (originalText.toLowerCase() === currentText.toLowerCase()) return cleanSel;

        const stripPunct = (w) => (w || "").replace(/^[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+|[^a-zA-Z0-9À-ÿçğıöşüÇĞİÖŞÜ]+$/g, "");
        const normWord = (w) => stripPunct(w).toLowerCase();

        // Eğer orijinal blok tek kelimeden oluşuyorsa doğrudan onu döndür
        const allOrigWords = originalText.split(/\s+/).filter(Boolean);
        if (allOrigWords.length === 1) {
            return stripPunct(allOrigWords[0]) || originalText;
        }

        // Eğer tüm paragraf (veya paragrafın büyük çoğunluğu) seçildiyse doğrudan orijinal paragrafı döndür
        if (currentText && cleanSel.length >= currentText.length * 0.8) {
            return originalText;
        }

        try {
            let origLang = origLangOverride || this.detectedLang || 'en';
            if (!origLangOverride && !this.detectedLang) {
                const detectResult = await translateService.translateGoogleWithDetails(originalText.slice(0, 150), 'tr', 'auto');
                origLang = (detectResult && detectResult.lang) ? detectResult.lang.toLowerCase() : 'en';
            }

            // 1. Cümle bazlı hizalama: hem çevrilmiş bloğu hem orijinal bloğu cümlelere ayır
            const splitIntoSentences = (txt) => (txt.match(/[^.!?…]+(?:[.!?…]+["”'’)\]]*|$)/g) || [txt]).map(s => s.trim()).filter(Boolean);
            const currSents = splitIntoSentences(currentText || cleanSel);
            const origSents = splitIntoSentences(originalText);

            let matchedSentIndices = [];
            const lowerSel = cleanSel.toLowerCase();
            currSents.forEach((cs, idx) => {
                const lcs = cs.toLowerCase();
                if (lcs.includes(lowerSel) || lowerSel.includes(lcs)) {
                    matchedSentIndices.push(idx);
                }
            });

            let targetOrigSent = originalText;
            let targetCurrSent = currentText || cleanSel;

            if (matchedSentIndices.length > 1 && origSents.length > 1) {
                const startOrigIdx = Math.min(origSents.length - 1, Math.round((matchedSentIndices[0] / Math.max(1, currSents.length - 1)) * (origSents.length - 1)));
                const endOrigIdx = Math.min(origSents.length - 1, Math.round((matchedSentIndices[matchedSentIndices.length - 1] / Math.max(1, currSents.length - 1)) * (origSents.length - 1)));
                const combinedOrig = origSents.slice(startOrigIdx, Math.max(startOrigIdx + 1, endOrigIdx + 1)).join(' ');
                const combinedCurr = matchedSentIndices.map(i => currSents[i]).join(' ');
                if (cleanSel.length >= combinedCurr.length * 0.65) {
                    return combinedOrig;
                }
                targetOrigSent = combinedOrig;
                targetCurrSent = combinedCurr;
            } else if (matchedSentIndices.length === 1 && origSents.length > 0) {
                const cIdx = matchedSentIndices[0];
                const oIdx = Math.min(origSents.length - 1, Math.round((cIdx / Math.max(1, currSents.length - 1)) * (origSents.length - 1)));
                targetCurrSent = currSents[cIdx];
                targetOrigSent = origSents[oIdx];

                if (cleanSel.length >= targetCurrSent.length * 0.75) {
                    return targetOrigSent;
                }
            }

            // 2. Noktalama / Yan Cümlecik (Clause) Daraltması:
            // Örn. "Class: Brusier" <-> "Sınıf: Kabadayı" veya virgül/iki nokta ile ayrılmış parçalar
            const clauseSplitRegex = /[:;—–()\[\]/]+/;
            if (clauseSplitRegex.test(targetCurrSent) && clauseSplitRegex.test(targetOrigSent)) {
                const currClauses = targetCurrSent.split(clauseSplitRegex).map(s => s.trim()).filter(Boolean);
                const origClauses = targetOrigSent.split(clauseSplitRegex).map(s => s.trim()).filter(Boolean);
                if (currClauses.length === origClauses.length && currClauses.length > 1) {
                    const cClauseIdx = currClauses.findIndex(cl => cl.toLowerCase().includes(lowerSel));
                    if (cClauseIdx !== -1 && origClauses[cClauseIdx]) {
                        targetCurrSent = currClauses[cClauseIdx];
                        targetOrigSent = origClauses[cClauseIdx];
                        const clauseTokens = targetOrigSent.split(/\s+/).filter(Boolean);
                        if (clauseTokens.length === 1) {
                            return stripPunct(clauseTokens[0]) || targetOrigSent;
                        }
                        if (cleanSel.length >= targetCurrSent.length * 0.75) {
                            return targetOrigSent;
                        }
                    }
                }
            }

            const origTokens = targetOrigSent.split(/\s+/).filter(Boolean);
            if (origTokens.length === 0) return originalText;
            if (origTokens.length === 1) return stripPunct(origTokens[0]) || targetOrigSent;

            const selWordCount = cleanSel.split(/\s+/).filter(Boolean).length;
            const posInCurr = Math.max(0, targetCurrSent.toLowerCase().indexOf(lowerSel));
            const relRatio = (posInCurr + cleanSel.length / 2) / Math.max(1, targetCurrSent.length);

            // İngilizce edat/yardımcı fiil/zamir listesi (içerik kelimesi seçildiğinde bunları elemek için)
            const enStopwords = new Set([
                'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as',
                'is', 'was', 'were', 'are', 'am', 'be', 'been', 'being', 'have', 'has', 'had',
                'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
                'he', 'she', 'it', 'they', 'we', 'you', 'i', 'his', 'her', 'its', 'their', 'our', 'your', 'my',
                'him', 'them', 'us', 'me', 'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose',
                'and', 'or', 'but', 'if', 'than', 'then', 'so', 'not', 'no', 'nor'
            ]);

            // İki kelimenin kök / yazım hatası (Damerau-Levenshtein <= 1, örn. Brusier <-> bruiser) eşleşmesini kontrol eder
            const wordsMatchFuzzyOrStem = (origW, candW) => {
                if (!origW || !candW) return 0;
                if (origW === candW) return 100;
                const minL = Math.min(origW.length, candW.length);
                const maxL = Math.max(origW.length, candW.length);

                // Yan yana harf yer değiştirmesi veya 1 harf yazım hatası (örn. "brusier" <-> "bruiser", mesafe = 1)
                if (minL >= 4 && Math.abs(origW.length - candW.length) <= 1) {
                    const dist = translateService.damerauLevenshtein(origW, candW);
                    if (dist === 1) return 95;
                    if (dist === 2 && minL >= 7 && origW[0] === candW[0]) return 82;
                }

                // Kök (stem) eşleşmesi
                if (minL >= 4 && (origW.startsWith(candW.slice(0, 4)) || candW.startsWith(origW.slice(0, 4)))) {
                    if (maxL - minL <= 4) return 85;
                }
                if (minL >= 4 && (origW.includes(candW) || candW.includes(origW))) {
                    return 78;
                }
                return 0;
            };

            // 3. Zengin Geri Çeviri + Sözlük Eş Anlamlıları (dt=bd & dt=at) ile Ham Metindeki Kelimeyi Bulma
            // Örn. "Kabadayı" -> dictTerms içinde "bruiser", "rowdy", "bully", "brawler" gelir;
            // "bruiser" ile ham metindeki "Brusier" Damerau-Levenshtein (mesafe=1) ile %95 eşleşir ve doğrudan "Brusier" döner!
            const backResult = await translateService.translateGoogleWithDetails(cleanSel, origLang, 'auto');
            const allBackCandidates = new Set();

            const collectBackTerms = (resObj) => {
                if (!resObj) return;
                if (resObj.text) {
                    resObj.text.split(/\s+/).map(normWord).filter(w => w.length >= 2).forEach(w => allBackCandidates.add(w));
                }
                if (Array.isArray(resObj.dictTerms)) {
                    resObj.dictTerms.forEach(term => {
                        term.split(/\s+/).map(normWord).filter(w => w.length >= 2).forEach(w => allBackCandidates.add(w));
                    });
                }
                if (Array.isArray(resObj.altTerms)) {
                    resObj.altTerms.forEach(term => {
                        term.split(/\s+/).map(normWord).filter(w => w.length >= 2).forEach(w => allBackCandidates.add(w));
                    });
                }
            };
            collectBackTerms(backResult);

            // Eğer seçilen Türkçe kelimede çekim eki varsa (örn. "Kabadayıydı", "Kabadayının"), olası kökünü de sorgula
            if (selWordCount === 1) {
                const trNorm = normWord(cleanSel);
                const strippedTrStem = trNorm.replace(/(?:yd[ıiuü]|d[ıiuü]|t[ıiuü]|n[ıiuü]n|[ıiuü]n|y?[ae]|d[ae]n|t[ae]n|d[ae]|t[ae]|l[ae]r|l[ıiuü]k|c[ıiuü]|s[ıiuü]z)$/i, '');
                if (strippedTrStem && strippedTrStem.length >= 3 && strippedTrStem !== trNorm) {
                    const stemBackRes = await translateService.translateGoogleWithDetails(strippedTrStem, origLang, 'tr');
                    collectBackTerms(stemBackRes);
                }
            }

            if (allBackCandidates.size > 0) {
                const backList = Array.from(allBackCandidates);

                if (selWordCount === 1) {
                    let bestTok = null;
                    let bestTotalScore = -1;

                    origTokens.forEach((tok, idx) => {
                        const nw = normWord(tok);
                        if (!nw || nw.length < 2) return;
                        let maxMatch = 0;
                        for (const bw of backList) {
                            const m = wordsMatchFuzzyOrStem(nw, bw);
                            if (m > maxMatch) maxMatch = m;
                        }
                        if (maxMatch > 0) {
                            const tokRatio = (idx + 0.5) / origTokens.length;
                            const distPenalty = Math.abs(tokRatio - relRatio) * 25;
                            const stopPenalty = enStopwords.has(nw) ? 30 : 0;
                            const total = maxMatch - distPenalty - stopPenalty;
                            if (total > bestTotalScore) {
                                bestTotalScore = total;
                                bestTok = stripPunct(tok);
                            }
                        }
                    });

                    if (bestTok && bestTotalScore >= 55) {
                        return bestTok;
                    }
                } else {
                    // Çok kelimeli seçim: orijinal cümlede eşleşen ilk ve son kelime arasındaki gerçek dilimi al
                    let matchIndices = [];
                    origTokens.forEach((tok, idx) => {
                        const nw = normWord(tok);
                        if (nw.length >= 3 && !enStopwords.has(nw) && backList.some(bw => bw.length >= 3 && wordsMatchFuzzyOrStem(nw, bw) >= 75)) {
                            matchIndices.push(idx);
                        }
                    });
                    if (matchIndices.length >= 1) {
                        const firstI = matchIndices[0];
                        const lastI = matchIndices[matchIndices.length - 1];
                        if (lastI - firstI <= Math.max(selWordCount * 2 + 2, 5)) {
                            return origTokens.slice(firstI, lastI + 1).join(' ').replace(/^[.,;!?]+|[.,;!?]+$/g, '');
                        }
                    }
                }
            }

            // 4. İleri Yönlü (Forward) Kelime Eşleştirme + Diğer Kelimeleri Eleme (Cross-Off Elimination):
            // Orijinal cümledeki kelimeleri Türkçeye çevir; seçilen kelimeyle eşleşeni bul veya cümledeki diğer Türkçe kelimelerle eşleşenleri eleyip kalan gerçek kelimeyi döndür
            if (origTokens.length > 0 && selWordCount <= 3) {
                const centerIdx = Math.min(origTokens.length - 1, Math.max(0, Math.round(relRatio * (origTokens.length - 1))));
                const winRadius = Math.min(origTokens.length, 8);
                const startI = Math.max(0, centerIdx - winRadius);
                const endI = Math.min(origTokens.length - 1, centerIdx + winRadius);

                const candidates = [];
                for (let i = startI; i <= endI; i++) {
                    const singleClean = stripPunct(origTokens[i]);
                    if (singleClean.length >= 2) {
                        candidates.push({ orig: singleClean, idx: i, isSingle: true });
                    }
                    if (selWordCount >= 2 && i + 1 <= endI) {
                        const pairClean = stripPunct(origTokens[i] + ' ' + origTokens[i + 1]);
                        if (pairClean.length >= 4) {
                            candidates.push({ orig: pairClean, idx: i + 0.5, isSingle: false });
                        }
                    }
                }

                if (candidates.length > 0) {
                    // Küçük harfle gönder ki Google büyük harfli kelimeleri özel isim sanıp çevirmeden bırakmasın
                    const batchInput = candidates.map(c => c.orig.toLowerCase()).join('\n');
                    const batchTr = await translateService.translateGoogle(batchInput, 'tr', origLang);
                    const trLines = (batchTr || '').split('\n').map(l => normWord(l));
                    const targetNorm = normWord(cleanSel);
                    const targetRoot = targetNorm.slice(0, Math.min(targetNorm.length, 4));

                    let bestCand = null;
                    let bestScore = -1;

                    candidates.forEach((cand, cIdx) => {
                        const trWord = trLines[cIdx] || '';
                        if (!trWord) return;
                        let score = 0;
                        if (trWord === targetNorm) {
                            score = 100;
                        } else if (trWord.length >= 3 && targetNorm.length >= 3 && (trWord.includes(targetNorm) || targetNorm.includes(trWord))) {
                            score = 82;
                        } else if (targetRoot.length >= 4 && trWord.startsWith(targetRoot)) {
                            score = 68;
                        }
                        if (score > 0) {
                            const distPenalty = Math.abs((cand.idx / Math.max(1, origTokens.length - 1)) - relRatio) * 20;
                            const totalScore = score - distPenalty;
                            if (totalScore > bestScore) {
                                bestScore = totalScore;
                                bestCand = cand.orig;
                            }
                        }
                    });

                    if (bestCand) {
                        return bestCand;
                    }

                    // Eğer doğrudan eşleşmediyse (örn. "Brusier" yazım hatası olduğu için toplu çeviride aynı kaldıysa):
                    // Cümledeki DİĞER Türkçe kelimelerle eşleşen İngilizce kelimeleri ve edatları (stopwords) ele!
                    if (selWordCount === 1) {
                        const otherCurrWords = targetCurrSent
                            .split(/\s+/)
                            .map(normWord)
                            .filter(w => w.length >= 2 && w !== targetNorm && !targetNorm.includes(w));

                        let bestUnmatchedOrig = null;
                        let bestUnmatchedScore = -999;

                        candidates.filter(c => c.isSingle).forEach((cand, cIdx) => {
                            const nw = normWord(cand.orig);
                            const trWord = trLines[cIdx] || '';
                            if (enStopwords.has(nw)) return;

                            // Bu İngilizce kelimenin çevirisi cümledeki başka bir Türkçe kelimeyle eşleşiyor mu?
                            const matchesOtherWord = trWord && trWord !== nw && otherCurrWords.some(ow => {
                                return ow === trWord || (ow.length >= 4 && trWord.length >= 4 && (ow.startsWith(trWord.slice(0, 4)) || trWord.startsWith(ow.slice(0, 4))));
                            });
                            if (matchesOtherWord) return;

                            // Kalan adayları konum yakınlığına ve çevrilmemiş (özel/hatalı yazım) olma durumuna göre puanla
                            const posDist = Math.abs((cand.idx / Math.max(1, origTokens.length - 1)) - relRatio);
                            const untranslatedBonus = (trWord === nw) ? 25 : 0;
                            const score = 100 - (posDist * 100) + untranslatedBonus;
                            if (score > bestUnmatchedScore) {
                                bestUnmatchedScore = score;
                                bestUnmatchedOrig = cand.orig;
                            }
                        });

                        if (bestUnmatchedOrig) {
                            return bestUnmatchedOrig;
                        }
                    }
                }
            }

            // 5. Son Güvence: Kesinlikle dışarıdan "Rowdy" gibi çeviri uydurma!
            // Ham metindeki (origTokens) ilgili konumdaki gerçek kelimeyi/ifadeyi döndür
            const fallbackCenter = Math.min(origTokens.length - 1, Math.max(0, Math.round(relRatio * (origTokens.length - 1))));
            if (selWordCount === 1) {
                // Eğer tam o konumdaki kelime "the/a" gibi bir stopword ise hemen yanındaki içerik kelimesine bak
                let chosenIdx = fallbackCenter;
                if (enStopwords.has(normWord(origTokens[chosenIdx]))) {
                    if (chosenIdx + 1 < origTokens.length && !enStopwords.has(normWord(origTokens[chosenIdx + 1]))) {
                        chosenIdx = chosenIdx + 1;
                    } else if (chosenIdx - 1 >= 0 && !enStopwords.has(normWord(origTokens[chosenIdx - 1]))) {
                        chosenIdx = chosenIdx - 1;
                    }
                }
                return stripPunct(origTokens[chosenIdx]) || origTokens[chosenIdx];
            } else {
                const half = Math.floor(selWordCount / 2);
                const sI = Math.max(0, fallbackCenter - half);
                const eI = Math.min(origTokens.length, sI + selWordCount);
                return origTokens.slice(sI, eI).join(' ').replace(/^[.,;!?]+|[.,;!?]+$/g, '');
            }
        } catch (err) {
            console.error("Original word mapping error:", err);
            return cleanSel;
        }
    },

    highlightRange(range, doc) {
        this.clearHighlight();
        try {
            const span = doc.createElement('span');
            span.className = 'highlight-temp';
            span.style.backgroundColor = 'rgba(50, 146, 255, 0.4)';
            span.style.color = 'inherit';
            range.surroundContents(span);
            this.currentHighlightSpan = span;
        } catch (e) {
            console.warn("Geçici seçim işaretleme başarısız:", e);
        }
    },

    clearHighlight() {
        if (this.currentHighlightSpan) {
            try {
                const span = this.currentHighlightSpan;
                if (span.parentNode) {
                    const parent = span.parentNode;
                    while (span.firstChild) {
                        parent.insertBefore(span.firstChild, span);
                    }
                    parent.removeChild(span);
                }
            } catch (e) {
                console.warn("İşaretleme temizleme başarısız:", e);
            }
            this.currentHighlightSpan = null;
        }
    },

    applyReplacementsToDoc(doc, bookId) {
        if (typeof replacementsDb === 'undefined') return;
        replacementsDb.getAllReplacements().then(list => {
            const bookReplacements = list.filter(r => !r.bookId || r.bookId === bookId);
            if (bookReplacements.length === 0) return;
            
            const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            const nodesToReplace = [];
            while (node = walk.nextNode()) {
                const parentTagName = node.parentNode ? node.parentNode.tagName.toUpperCase() : "";
                if (parentTagName === 'SCRIPT' || parentTagName === 'STYLE' || parentTagName === 'NOSCRIPT') {
                    continue;
                }
                nodesToReplace.push(node);
            }
            
            nodesToReplace.forEach(node => {
                let text = node.nodeValue;
                let modified = false;
                bookReplacements.forEach(r => {
                    const escaped = r.originalText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const regex = new RegExp(escaped, 'g');
                    if (regex.test(text)) {
                        text = text.replace(regex, r.replacedText);
                        modified = true;
                    }
                });
                if (modified) {
                    node.nodeValue = text;
                }
            });
        });
    },

    applyReplacementsToPdfElement(element, bookId) {
        if (typeof replacementsDb === 'undefined') return;
        replacementsDb.getAllReplacements().then(list => {
            const bookReplacements = list.filter(r => !r.bookId || r.bookId === bookId);
            if (bookReplacements.length === 0) return;
            
            const spans = element.querySelectorAll('.textLayer span');
            spans.forEach(span => {
                let text = span.textContent;
                let modified = false;
                bookReplacements.forEach(r => {
                    const escaped = r.originalText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const regex = new RegExp(escaped, 'g');
                    if (regex.test(text)) {
                        text = text.replace(regex, r.replacedText);
                        modified = true;
                    }
                });
                if (modified) {
                    span.textContent = text;
                }
            });
        });
    },

    // Okuyucuyu Kapat ve Kütüphaneye Dön
    closeReader(skipHistoryCleanup = false) {
        this.stopTTS();

        // Okuyucu gizlenmeden önce kaldığı konumu kalıcı olarak kaydet (popstate kaynaklı 0 sıfırlamasını koru)
        this.saveReadingPosition(false);
        if (this.epubScrollTimeout) clearTimeout(this.epubScrollTimeout);
        if (this.expandIframeTimeout) {
            clearTimeout(this.expandIframeTimeout);
            this.expandIframeTimeout = null;
        }
        if (this.sandboxObserver) {
            this.sandboxObserver.disconnect();
            this.sandboxObserver = null;
        }
        if (this.sandboxRafId) {
            cancelAnimationFrame(this.sandboxRafId);
            this.sandboxRafId = null;
        }
        if (this.currentBookType === 'epub' && this.currentBookId && this.epubLocation) {
            const epubPercent = (this.bookData && this.bookData.progressPercent) || 0;
            booksDb.updateProgress(this.currentBookId, epubPercent, this.epubLocation);
        }
        if (this.currentBookType === 'pdf' && this.currentBookId && this.pdfDocument) {
            if (this.pdfScrollTimeout) clearTimeout(this.pdfScrollTimeout);
            const rawScrollY = this.getScrollTop();
            const finalPdfScrollY = (rawScrollY === 0 && (this.lastValidScrollY || 0) > 40)
                ? Math.round(this.lastValidScrollY)
                : Math.round(rawScrollY);
            const pdfLocation = `${this.pdfCurrentPage};${finalPdfScrollY}`;
            const pdfPercent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
            if (this.bookData) {
                this.bookData.lastLocation = pdfLocation;
                this.bookData.progressPercent = pdfPercent;
            }
            booksDb.updateProgress(this.currentBookId, pdfPercent, pdfLocation);
        }
        
        document.getElementById('view-reader').style.display = 'none';

        document.documentElement.classList.remove('reader-active');
        document.body.classList.remove('reader-active');
        document.documentElement.style.backgroundColor = '';
        this.isRestoringBook = false;
        window.scrollTo(0, 0);
        try { sessionStorage.removeItem('endlessr_reader_scroll'); } catch (e) {}
        
        // Belleği boşalt
        if (this.epubBook) {
            try { this.epubBook.destroy(); } catch (e) {}
            this.epubBook = null;
            this.epubRendition = null;
        }
        
        this.pdfDocument = null;
        this.currentBookId = null;
        this.currentBookTitle = null;
        this.currentBookType = null;
        this.bookData = null;
        
        this.closeStylePanel();
        this.closeTOCPanel();
        this.hidePopover();

        // Kütüphanedeki kitap kartlarının ilerleme yüzdesini güncelle
        if (window.app) {
            window.app.loadLibrary();
        }

        // Doğrudan "Kapat" butonuna basarak kapatıldıysa tarayıcı geçmişini temizle ve eşitle
        if (!skipHistoryCleanup && typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
            let popCount = 0;
            while (navHistory.stack.length > 1) {
                const top = navHistory.stack[navHistory.stack.length - 1];
                if (top.type === 'view') {
                    break;
                }
                navHistory.stack.pop();
                popCount++;
            }
            navHistory.saveToSession();
            if (popCount > 0) {
                navHistory.isNavigatingBack = true;
                navHistory.ignorePopStateCount++;
                window.history.go(-popCount);
                setTimeout(() => {
                    navHistory.isNavigatingBack = false;
                    if (navHistory.ignorePopStateCount > 0) {
                        navHistory.ignorePopStateCount = 0;
                    }
                }, 250);
            }
        }
    }
};

// Global Window Scroll Listener (Chrome Adres Çubuğu & Reader Header Gizleme/Gösterme Entegrasyonu)
let lastScrollY = window.scrollY;
let upScrollAnchorY = window.scrollY;

window.addEventListener('scroll', () => {
    if (!document.body.classList.contains('reader-active')) return;
    if (reader.isRestoringBook) return;
    if (typeof navHistory !== 'undefined' && navHistory.isNavigatingBack) return;

    const currentScrollY = reader.getScrollTop();
    const header = document.querySelector('.reader-header');
    const optionsPanel = document.getElementById('reader-options-panel');
    const isPanelOpen = optionsPanel && optionsPanel.classList.contains('open');
    
    // 1. Header Göster/Gizle mantığı:
    // Aşağı kaydırırken gizle ve yukarı kaydırma başlangıç noktasını (upScrollAnchorY) güncelle.
    // Yukarı kaydırırken ufak dokunuşlarda hemen açma; yalnızca ekran yüksekliğinin en az 3'te 1'i (1/3)
    // kadar yukarı kaydırıldığında üst barı (.reader-header) aç.
    if (header && !isPanelOpen) {
        if (currentScrollY > lastScrollY) {
            upScrollAnchorY = currentScrollY;
            if (currentScrollY > 80) {
                header.classList.remove('open');
            }
        } else if (currentScrollY < lastScrollY) {
            if (currentScrollY > upScrollAnchorY) {
                upScrollAnchorY = currentScrollY;
            }
            const oneThirdScreen = Math.max(120, Math.round((window.innerHeight || 600) / 3));
            const upScrolledDistance = upScrollAnchorY - currentScrollY;
            if (upScrolledDistance >= oneThirdScreen) {
                header.classList.add('open');
            }
        }
    } else if (currentScrollY > lastScrollY) {
        upScrollAnchorY = currentScrollY;
    }
    lastScrollY = currentScrollY;

    // Sayfa yenilendiğinde (F5) dikey kaydırma konumunu korumak için sessionStorage'a kaydet
    if (reader.currentBookId && !reader.isRestoringBook) {
        try {
            sessionStorage.setItem('endlessr_reader_scroll', JSON.stringify({
                bookId: reader.currentBookId,
                spineIndex: reader.getActiveSpineIndex(),
                pdfPage: reader.pdfCurrentPage,
                scrollY: currentScrollY
            }));
        } catch (e) {}
    }

    // 2. Okuma Konumunu Kaydetme Entegrasyonu
    if (reader.currentBookType === 'epub') {
        reader.saveReadingPosition(currentScrollY === 0 && lastScrollY <= 50);
        reader.saveEpubScrollLocation();
    } else if (reader.currentBookType === 'pdf') {
        if (currentScrollY > 0 || lastScrollY <= 50) {
            reader.lastValidScrollY = currentScrollY;
        }
        reader.savePdfScrollLocation();
    }
});

// Uygulama arka plana alınırken / sekme kapanırken son konumu kaydet
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && document.body.classList.contains('reader-active')) {
        reader.saveReadingPosition(false);
    }
});
window.addEventListener('pagehide', () => {
    if (document.body.classList.contains('reader-active')) {
        reader.saveReadingPosition();
    }
});
