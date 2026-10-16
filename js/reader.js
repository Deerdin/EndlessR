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

    // TTS Kuyruk Durumu
    isSpeakingTTS: false,
    ttsChunks: [],
    ttsCurrentIndex: 0,
    ttsTimeout: null,

    // EPUB İlerleme Hesaplama ve Arayüz Senkronizasyonu (Tek Merkezli)
    async updateEpubProgressUI(saveToDb = true) {
        if (this.currentBookType !== 'epub' || !this.epubRendition || !this.epubBook) return;

        try {
            const location = this.epubRendition.currentLocation();
            if (!location || !location.start) return;

            if (location.start.cfi) {
                this.epubLocation = location.start.cfi;
            }

            const currentSpineIndex = typeof location.start.index === 'number' ? location.start.index : 0;
            const totalSpineItems = (this.epubBook.spine && this.epubBook.spine.length) ? this.epubBook.spine.length : 1;

            const hasToc = this.numberedChapters && this.numberedChapters.length > 0;
            let currentStep = currentSpineIndex + 1;
            let totalSteps = totalSpineItems;
            let chapterTitle = "";

            if (hasToc) {
                const activeIndex = this.findActiveTocIndex(location);
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
                ? `Bölüm ${currentStep}: ${chapterTitle} (${currentStep} / ${totalSteps})`
                : `Bölüm ${currentStep} / ${totalSteps}`;

            this.updateProgressBar(currentStep, progressPercent, labelText);

            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Bölüm ${currentStep} / ${totalSteps} (${progressPercent}%)`;
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

    savePdfScrollLocation() {
        if (this.currentBookType !== 'pdf' || !this.pdfDocument) return;
        
        if (this.pdfScrollTimeout) clearTimeout(this.pdfScrollTimeout);
        this.pdfScrollTimeout = setTimeout(async () => {
            try {
                const pageNum = this.pdfCurrentPage;
                const scrollTop = window.scrollY;
                const lastLocationString = `${pageNum};${scrollTop}`;
                
                const percent = Math.round((pageNum / this.pdfTotalPages) * 100);
                if (this.bookData) {
                    this.bookData.progressPercent = percent;
                    this.bookData.lastLocation = lastLocationString;
                }
                await booksDb.updateProgress(this.currentBookId, percent, lastLocationString);
            } catch (e) {
                console.warn("PDF scroll kaydetme hatası:", e);
            }
        }, 600);
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
        readerType: "single",
        translationService: "web",
        autoUnlock: false
    },

    async openBook(bookId, options = {}) {
        try {
            // Kitabı IndexedDB'den al
            const book = await booksDb.getBook(bookId);
            if (!book) throw new Error("Kitap veritabanında bulunamadı.");

            // Eğer kitap dosyası yoksa
            if (!book.file) {
                alert("Kitap dosyası bulunamadı.");
                return;
            }

            this.currentBookId = bookId;
            this.currentBookTitle = book.title;
            this.currentBookType = book.type;
            this.bookData = book;
            this.detectedLang = book.detectedLang || null;
            this.isRestoringBook = !!(options && options.isRestore);

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
            if (panelBookAuthor) panelBookAuthor.textContent = book.author || "Bilinmeyen Yazar";
            
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

            const targetStartLocation = (options && options.restoreLocation !== undefined && options.restoreLocation !== null)
                ? options.restoreLocation
                : book.lastLocation;

            // Kitap tipine göre okuyucuyu başlat
            if (book.type === 'epub') {
                await this.initEpub(book.file, targetStartLocation);
            } else if (book.type === 'pdf') {
                await this.initPdf(book.file, targetStartLocation);
            }

            // Temayı uygula
            await this.setReaderTheme(this.settings.theme, false);

            // Eğer sayfa yenilemesinden geri yükleniyorsa dikey kaydırma konumunu da geri yükle
            if (this.isRestoringBook) {
                try {
                    const rawScroll = sessionStorage.getItem('endlessr_reader_scroll');
                    if (rawScroll) {
                        const savedScroll = JSON.parse(rawScroll);
                        if (savedScroll && savedScroll.bookId === bookId && savedScroll.scrollY > 0) {
                            setTimeout(() => { window.scrollTo(0, savedScroll.scrollY); }, 80);
                            setTimeout(() => { window.scrollTo(0, savedScroll.scrollY); }, 250);
                        }
                    }
                } catch (e) {}
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
            this.isRestoringBook = false;
            console.error("Kitap açılırken hata:", err);
            alert("Kitap yüklenemedi.");
            this.closeReader();
        }
    },

    // 2. EPUB Okuyucu Başlatıcı
    async initEpub(fileBuffer, startLocation) {
        document.getElementById('epub-viewer').style.display = 'block';
        document.getElementById('btn-prev-page').style.display = 'none';
        document.getElementById('btn-next-page').style.display = 'none';

        // Eski kitap nesnesi varsa yok et
        if (this.epubBook) {
            try { this.epubBook.destroy(); } catch (e) {}
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
            const currentSpineIndex = (location && location.start) ? location.start.index : 0;
            const spineChanged = this.lastSpineIndex !== null && this.lastSpineIndex !== currentSpineIndex;
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

            // Bölüm geçişinde iframe ve pencere scrollunu en üste sıfırla
            const viewer = document.getElementById('epub-viewer');
            if (viewer) viewer.scrollTop = 0;
            if (spineChanged && !this.isRestoringBook) {
                window.scrollTo(0, 0);
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
            if (this.isProcessingSelection) return;
            this.isProcessingSelection = true;

            try {
                const selection = contents.window.getSelection();
                const selectedText = selection.toString().trim();
                
                if (selectedText.length > 0 && selectedText.length < 1000) {
                    const range = selection.getRangeAt(0);
                    this.highlightRange(range, contents.document);
                    
                    const rect = range.getBoundingClientRect();
                    
                    const iframe = document.querySelector("#epub-viewer iframe");
                    const iframeRect = iframe.getBoundingClientRect();

                    const posX = rect.left + iframeRect.left + (rect.width / 2);
                    const posY = rect.top + iframeRect.top;

                    let fullSentence = this.extractSentenceFromSelection(contents.window, selectedText);
                    
                    let finalWord = selectedText;
                    let finalSentence = fullSentence;

                    let parent = range.commonAncestorContainer;
                    if (parent.nodeType === Node.TEXT_NODE) parent = parent.parentNode;
                    const translatedEl = parent.closest('[data-is-translated="true"]');
                    
                    if (translatedEl) {
                        const originalText = translatedEl.getAttribute('data-original-text');
                        if (originalText) {
                            const detectResult = await translateService.translateGoogleWithDetails(originalText.slice(0, 150), 'tr');
                            const origLang = detectResult.lang || 'en';
                            
                            const originalWord = await this.getOriginalWordForSelection(selectedText, range);
                            
                            if (origLang.startsWith('en')) {
                                finalWord = originalWord;
                                finalSentence = originalText;
                            } else {
                                const enResult = await translateService.translateGoogleWithDetails(originalWord, 'en', origLang);
                                finalWord = enResult.text.trim();
                                const enSentenceResult = await translateService.translateGoogleWithDetails(originalText, 'en', origLang);
                                finalSentence = enSentenceResult.text.trim();
                            }
                        }
                    }
                    
                    this.showPopover(finalWord, posX, posY, finalSentence, selectedText);
                }
            } catch (err) {
                console.error("EPUB Selection error:", err);
            } finally {
                setTimeout(() => {
                    this.isProcessingSelection = false;
                }, 300);
            }
        });

        // EPUB Tek Tıklama ile Kelime Çevirisi (Tap to Translate) kancası
        this.epubRendition.hooks.content.register((contents) => {
            try {
                const doc = contents.document;
                
                // Metin değişikliklerini (find-replace) uygula
                this.applyReplacementsToDoc(doc, this.currentBookId);

                const rType = this.settings.readerType || "single";
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
                    prevBtn.textContent = 'Önceki Bölüm';
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
                    nextBtn.textContent = 'Sonraki Bölüm';
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
                    spacer.style.height = '80px';
                    body.appendChild(spacer);
                }
                
            } catch (err) {
                console.error("Hook footer yerleştirme hatası:", err);
            }

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
                        this.isProcessingSelection = true;
                        try {
                            this.highlightRange(range, contents.document);
                            contents.window.getSelection().removeAllRanges();
                            
                            const rect = range.getBoundingClientRect();
                            const iframe = document.querySelector("#epub-viewer iframe");
                            const iframeRect = iframe.getBoundingClientRect();
                            const posX = rect.left + iframeRect.left + (rect.width / 2);
                            const posY = rect.top + iframeRect.top;
                            
                            const sentence = this.extractSentenceFromSelection(contents.window, word);
                            
                            let finalWord = word;
                            let finalSentence = sentence;

                            let parent = range.commonAncestorContainer;
                            if (parent.nodeType === Node.TEXT_NODE) parent = parent.parentNode;
                            const translatedEl = parent.closest('[data-is-translated="true"]');
                            
                            if (translatedEl) {
                                const originalText = translatedEl.getAttribute('data-original-text');
                                if (originalText) {
                                    const detectResult = await translateService.translateGoogleWithDetails(originalText.slice(0, 150), 'tr');
                                    const origLang = detectResult.lang || 'en';
                                    
                                    const originalWord = await this.getOriginalWordForSelection(word, range);
                                    
                                    if (origLang.startsWith('en')) {
                                        finalWord = originalWord;
                                        finalSentence = originalText;
                                    } else {
                                        const enResult = await translateService.translateGoogleWithDetails(originalWord, 'en', origLang);
                                        finalWord = enResult.text.trim();
                                        const enSentenceResult = await translateService.translateGoogleWithDetails(originalText, 'en', origLang);
                                        finalSentence = enSentenceResult.text.trim();
                                    }
                                }
                            }

                            this.showPopover(finalWord, posX, posY, finalSentence, word);
                        } catch (err) {
                            console.error("Tap to translate error:", err);
                        } finally {
                            setTimeout(() => {
                                this.isProcessingSelection = false;
                            }, 300);
                        }
                    }
                }
            });

            // Iframe içi mousedown ile popover kapatma ve seçimi kaldırma
            contents.document.body.addEventListener('mousedown', (e) => {
                setTimeout(() => {
                    if (this.isProcessingSelection) return;
                    const sel = contents.window.getSelection();
                    if (!sel || sel.toString().trim().length === 0) {
                        this.hidePopover();
                    }
                }, 80);
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
            await this.epubRendition.display(startLocation);
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
                tocList.innerHTML = '<p class="empty-text">Bu kitapta içindekiler tablosu bulunamadı.</p>';
                this.updateEpubProgressUI(false);
            }
        } catch (e) {
            console.error("İçindekiler yüklenemedi:", e);
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
        this.updateProgressBar(this.pdfCurrentPage, percent, `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);
        const chIndicator = document.getElementById('panel-chapter-indicator');
        if (chIndicator) {
            chIndicator.textContent = `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages} (${percent}%)`;
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

            // Viewer'ı güncelle
            viewerContainer.innerHTML = '';
            viewerContainer.appendChild(pageContainer);

            // Eğer kaydedilmiş bir dikey kaydırma konumu varsa ve açılış sayfasıysa uygula
            if (this.pdfSavedScrollTop && pageNumber === this.pdfCurrentPage) {
                const scrollTopToApply = this.pdfSavedScrollTop;
                this.pdfSavedScrollTop = 0; // Bir kere uygulandıktan sonra sıfırla
                setTimeout(() => {
                    window.scrollTo(0, scrollTopToApply);
                }, 100);
            }

            // Sayfa numarasını güncelle
            this.pdfCurrentPage = pageNumber;
            document.getElementById('pdf-current-page').textContent = pageNumber;
            
            // İlerlemeyi güncelle
            const percent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
            this.updateProgressBar(this.pdfCurrentPage, percent, `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);
            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages} (${percent}%)`;
            }
            if (this.bookData) {
                this.bookData.progressPercent = percent;
                this.bookData.lastLocation = `${this.pdfCurrentPage};0`;
            }
            
            // DB'ye kaydet (Yeni sayfaya geçildiğinde kaydırma 0'dan başlar)
            booksDb.updateProgress(this.currentBookId, percent, `${this.pdfCurrentPage};0`);
 
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
                    div.textContent = `Sayfa ${i}`;
                    div.onclick = () => {
                        this.renderPdfPage(i);
                        this.closeTOCPanel();
                    };
                    tocList.appendChild(div);
                }
            }
        } catch (e) {
            tocList.innerHTML = '<p class="empty-text">İçindekiler yüklenemedi.</p>';
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

    // 6. Çeviri Popover Kontrolleri
    async showPopover(text, posX, posY, sentence, selectedText = "") {
        const popover = document.getElementById('translate-popover');
        const textPreview = document.getElementById('selected-text-preview');
        const translationText = document.getElementById('translation-text');
        const loader = document.getElementById('translation-loader');

        // Popover içeriğini hazırla
        const displayWord = selectedText ? selectedText.trim() : text;
        textPreview.textContent = displayWord.length > 30 ? displayWord.substring(0, 30) + "..." : displayWord;
        popover.setAttribute('data-selected-word', text);
        popover.setAttribute('data-context-sentence', sentence);
        
        translationText.textContent = "";
        loader.style.display = 'flex';

        // Popover'ı göster ve konumlandır
        popover.style.display = 'flex';
        
        // Ekran sınırlarını aşmamak için konum sınırlandırması
        const popoverWidth = 320;
        const popoverHeight = popover.offsetHeight || 160;
        const appWidth = document.getElementById('app-container').clientWidth;
        
        let left = posX - (popoverWidth / 2);
        if (left < 10) left = 10;
        if (left + popoverWidth > appWidth - 10) left = appWidth - popoverWidth - 10;

        let top = posY - popoverHeight - 12;
        if (top < 70) {
            // Eğer üstte yer yoksa seçimin altına konumlandır
            top = posY + 24;
        }

        popover.style.left = left + 'px';
        popover.style.top = top + 'px';

        translationText.style.display = 'block';
        
        // Google Çeviri tetikle (Hem Türkçe hem de İngilizce)
        try {
            const translationTR = await translateService.translateGoogle(text, 'tr');
            const translationEN = await translateService.translateGoogle(text, 'en');
            loader.style.display = 'none';
            
            let htmlResult = "";
            const cleanSelected = selectedText ? selectedText.trim() : "";
            const cleanOriginal = text ? text.trim() : "";
            
            if (cleanOriginal && cleanSelected && cleanOriginal.toLowerCase() !== cleanSelected.toLowerCase()) {
                htmlResult += `<strong>Orijinal:</strong> ${cleanOriginal}<br>`;
            }
            
            htmlResult += `<strong>Türkçe:</strong> ${translationTR}`;
            if (translationEN && translationEN.toLowerCase() !== translationTR.toLowerCase()) {
                htmlResult += `<br><strong>İngilizce:</strong> ${translationEN}`;
            }
            translationText.innerHTML = htmlResult;
        } catch (e) {
            loader.style.display = 'none';
            translationText.textContent = "Çeviri servisi hatası.";
        }
    },

    hidePopover() {
        document.getElementById('translate-popover').style.display = 'none';
        
        // Seçim işaretlemesini temizle (Highlight kaldır)
        this.clearHighlight();

        // Eğer EPUB ise seçimi kaldır
        if (this.currentBookType === 'epub' && this.epubRendition) {
            try {
                // epubjs üzerinde seçimi kaldır
                const iframe = document.querySelector("#epub-viewer iframe");
                if (iframe && iframe.contentWindow) {
                    iframe.contentWindow.getSelection().removeAllRanges();
                }
            } catch(e) {}
        }
        
        // Normal pencere seçimini de kaldır
        window.getSelection().removeAllRanges();
    },

    // Kelime Çevirisini Sözlüğe Kaydetme
    async saveSelectedWord() {
        const popover = document.getElementById('translate-popover');
        const word = popover.getAttribute('data-selected-word');
        const context = popover.getAttribute('data-context-sentence');
        const meaning = document.getElementById('translation-text').textContent;

        if (!word || !meaning) return;

        const success = await wordsDb.saveWord({
            word: word,
            meaning: meaning,
            context: context,
            bookTitle: this.currentBookTitle,
            bookId: this.currentBookId
        });

        if (success) {
            alert("Kelime eklendi.");
            this.hidePopover();
            // Kelimelerim ekranını yenile
            if (window.app) window.app.loadWords();
        } else {
            alert("Kelime kaydedilemedi.");
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
        // Hiçbir sekme aktif değilse varsayılan olarak Bölüm (tab-pane-read) sekmesini aktif et
        const activeTabBtn = document.querySelector('.panel-tab-btn.active');
        const activeTabPane = document.querySelector('.reader-options-panel .tab-pane.active');
        if (!activeTabBtn || !activeTabPane) {
            document.querySelectorAll('.panel-tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.reader-options-panel .tab-pane').forEach(pane => pane.classList.remove('active'));
            const defaultBtn = document.querySelector('.panel-tab-btn[data-tab="tab-pane-read"]');
            const defaultPane = document.getElementById('tab-pane-read');
            if (defaultBtn) defaultBtn.classList.add('active');
            if (defaultPane) defaultPane.classList.add('active');
        }
        
        document.getElementById('reader-options-panel').classList.add('open');
        const header = document.querySelector('.reader-header');
        if (header) header.classList.add('open');
    },

    closeStylePanel() {
        document.getElementById('reader-options-panel').classList.remove('open');
        const header = document.querySelector('.reader-header');
        if (header) header.classList.remove('open');
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
            // Position off-screen but keep in layout so Chrome translates it
            sandbox.style.cssText = 'position: absolute; left: -9999px; top: -9999px; width: 1px; height: 1px; overflow: hidden;';
            document.body.appendChild(sandbox);
        }
        
        // Clear previous sandbox contents and stop old observer
        if (this.sandboxObserver) {
            this.sandboxObserver.disconnect();
            this.sandboxObserver = null;
        }
        sandbox.innerHTML = '';
        
        const selectors = 'p, h1, h2, h3, h4, h5, h6, li';
        const iframeElements = Array.from(doc.querySelectorAll(selectors));
        const elementMap = new Map();
        
        const lang = this.detectedLang || 'en';
        document.documentElement.setAttribute('lang', lang);
        sandbox.setAttribute('lang', lang);
        
        iframeElements.forEach((el, idx) => {
            const txt = el.innerText || el.textContent;
            if (txt && txt.trim().length > 0) {
                // Link element
                el.setAttribute('data-sync-id', idx);
                
                // Create corresponding element in sandbox
                const sandboxEl = document.createElement(el.tagName.toLowerCase());
                sandboxEl.setAttribute('data-sync-id', idx);
                
                // Store original text if not already stored
                if (!el.hasAttribute('data-original-text')) {
                    el.setAttribute('data-original-text', txt);
                }
                
                sandboxEl.textContent = el.getAttribute('data-original-text');
                sandbox.appendChild(sandboxEl);
                
                elementMap.set(idx.toString(), el);
            }
        });
        
        if (elementMap.size === 0) return;
        
        // 2. Set up MutationObserver to watch for translation changes in sandbox
        this.sandboxObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                // Determine which sandbox element changed
                let targetNode = mutation.target;
                // If the target is a text node, get its parent element
                if (targetNode.nodeType === 3) {
                    targetNode = targetNode.parentElement;
                }
                
                if (targetNode && targetNode.hasAttribute('data-sync-id')) {
                    const syncId = targetNode.getAttribute('data-sync-id');
                    const iframeEl = elementMap.get(syncId);
                    if (iframeEl) {
                        const newText = targetNode.textContent || targetNode.innerText;
                        // Avoid infinite loops by checking if text actually changed
                        if (iframeEl.innerText !== newText) {
                            iframeEl.innerText = newText;
                            iframeEl.setAttribute('data-is-translated', 'true');
                        }
                    }
                }
            });
        });
        
        this.sandboxObserver.observe(sandbox, {
            childList: true,
            characterData: true,
            subtree: true
        });
        
        console.log(`Synced ${elementMap.size} elements to translation sandbox for Chrome page translate.`);
    },

    async translateDocument(doc, targetLang) {
        if (!doc) return;

        const cleanTarget = targetLang ? targetLang.toLowerCase() : 'tr';
        const transService = this.settings.translationService || 'web';

        // If document is already translated to the target language by the same service, do nothing
        if (doc.body && 
            doc.body.getAttribute('data-translated-to') === cleanTarget && 
            doc.body.getAttribute('data-translated-by') === transService) {
            return;
        }

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
            // Detect from first few paragraphs
            const sampleText = validElements.slice(0, 3).map(el => el.innerText || el.textContent).join(' ').trim();
            if (sampleText.length > 0) {
                try {
                    const result = await translateService.translateGoogleWithDetails(sampleText.slice(0, 200), 'tr');
                    if (result && result.lang) {
                        this.detectedLang = result.lang.toLowerCase();
                        console.log("Detected book language:", this.detectedLang);
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

        // If target language matches detected original language, restore original text and skip translation
        const cleanDetected = this.detectedLang ? this.detectedLang.toLowerCase() : 'en';

        const isSameLang = cleanDetected === cleanTarget || 
                           cleanDetected.startsWith(cleanTarget) || 
                           cleanTarget.startsWith(cleanDetected);

        if (isSameLang) {
            this.restoreDocument(doc);
            return;
        }

        const chunkSize = 15;
        const promises = [];
        let successCount = 0;

        for (let i = 0; i < validElements.length; i += chunkSize) {
            const chunk = validElements.slice(i, i + chunkSize);
            const textsToTranslate = chunk.map(el => {
                if (!el.hasAttribute('data-original-text')) {
                    el.setAttribute('data-original-text', el.innerText || el.textContent);
                }
                return el.getAttribute('data-original-text');
            });

            // Push parallel translation promise for each chunk
            promises.push((async (chunkElements, texts) => {
                try {
                    const translatedParts = await this.translateTextsBatch(texts, cleanTarget);
                    for (let j = 0; j < chunkElements.length; j++) {
                        if (translatedParts[j]) {
                            chunkElements[j].innerText = translatedParts[j];
                            chunkElements[j].setAttribute('data-is-translated', 'true');
                            successCount++;
                        }
                    }
                } catch (err) {
                    console.error("Batch translate error in parallel chunk:", err);
                    // Fallback to google translate for each element in the chunk
                    for (const el of chunkElements) {
                        try {
                            const original = el.getAttribute('data-original-text');
                            const trans = await translateService.translateGoogle(original, cleanTarget);
                            el.innerText = trans;
                            el.setAttribute('data-is-translated', 'true');
                            successCount++;
                        } catch (e) {
                            console.error("Fallback translate error:", e);
                        }
                    }
                }
            })(chunk, textsToTranslate));
        }

        // Wait for all parallel chunks to finish
        await Promise.all(promises);

        // Mark as translated
        if (doc.body && successCount > 0) {
            doc.body.setAttribute('data-translated-to', cleanTarget);
            doc.body.setAttribute('data-translated-by', transService);
        }
        this.applySpacingFixToDoc(doc);
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
        const elements = doc.querySelectorAll('[data-original-text]');
        elements.forEach(el => {
            el.innerText = el.getAttribute('data-original-text');
            el.removeAttribute('data-is-translated');
        });
        if (doc.body) {
            doc.body.removeAttribute('data-translated-to');
            doc.body.removeAttribute('data-translated-by');
        }
        this.applySpacingFixToDoc(doc);
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
            css = `
                html, body {
                    margin: 0 !important;
                    padding: calc(env(safe-area-inset-top, 30px) + 15px) ${padVal}px 30px !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    min-height: 100vh !important;
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
                p, div, section, article, span, li, blockquote, a, h1, h2, h3, h4, h5, h6 {
                    max-width: 100% !important;
                    width: auto !important;
                    background-color: transparent !important;
                    color: inherit !important;
                    font-family: ${font} !important;
                    line-height: ${lh} !important;
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
                p, li, blockquote, div:not(.epub-chapter-footer) {
                    text-align: left !important;
                    word-spacing: normal !important;
                    letter-spacing: normal !important;
                }
                h1, h2, h3, h4, h5, h6, [align="center"], .center {
                    text-align: center !important;
                }
            `;
        }
        customStyle.textContent = css;
        this.applySpacingFixToDoc(doc);
    },

    // Boşluk Düzeltme Butonu Arayüzünü Güncelleme
    updateFixSpacingUI() {
        const btn = document.getElementById('btn-fix-spacing');
        const label = document.getElementById('fix-spacing-label');
        if (!btn || !label) return;

        if (this.settings.fixSpacing) {
            label.textContent = 'Açık';
            btn.style.borderColor = 'var(--accent-color)';
            btn.style.backgroundColor = 'rgba(99, 102, 241, 0.12)';
            btn.style.color = 'var(--accent-color)';
        } else {
            label.textContent = 'Kapalı';
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
            alert("Sesli okuma desteklenmiyor.");
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
                        clone.querySelectorAll('.epub-chapter-footer, script, style, noscript').forEach(el => el.remove());
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
                    console.error("PDF metni okunamadı:", e);
                }
            }
        }
        
        textToRead = textToRead.replace(/\s+/g, ' ').trim();
        
        if (!textToRead) {
            alert("Okunacak metin bulunamadı.");
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
            btn.innerHTML = '<i data-lucide="pause"></i> Duraklat';
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
            btn.innerHTML = '<i data-lucide="play"></i> Oku';
            lucide.createIcons();
        }
    },

    getCleanVoiceName(voice) {
        const nameLower = voice.name.toLowerCase();
        const isGoogle = nameLower.includes('-x-') || nameLower.includes('google');
        const langCode = voice.lang;
        const isTurkish = langCode.toLowerCase().startsWith('tr');
        const langLabel = isTurkish ? "Türkçe" : "İngilizce";

        let genderLabel = "";
        if (nameLower.includes('female') || nameLower.includes('zira') || nameLower.includes('seda') || nameLower.includes('hazel') || nameLower.includes('susan') || nameLower.includes('yelda') || nameLower.includes('f-local') || nameLower.includes('f-network')) {
            genderLabel = " (Kadın)";
        } else if (nameLower.includes('male') || nameLower.includes('tolga') || nameLower.includes('david') || nameLower.includes('george') || nameLower.includes('cem') || nameLower.includes('m-local') || nameLower.includes('m-network')) {
            genderLabel = " (Erkek)";
        }

        if (isGoogle) {
            // Parse Google name codes like tr-tr-x-tfa-local
            const parts = nameLower.split('-');
            const codePart = parts.find(p => p.length === 3 && (p.startsWith('tf') || p.startsWith('sf') || p.startsWith('ji') || p.startsWith('ki')));
            if (codePart) {
                const letter = codePart.charAt(2).toUpperCase();
                if (!genderLabel) {
                    if (['A', 'C', 'E', 'F', 'G', 'H'].includes(letter)) {
                        genderLabel = " (Kadın)";
                    } else if (['B', 'D', 'I', 'J'].includes(letter)) {
                        genderLabel = " (Erkek)";
                    }
                }
                return `Google ${langLabel} Ses ${letter}${genderLabel}`;
            }
            
            // Check for single letter voice at the end of Wavenet/Neural2 names, e.g. en-US-Neural2-F
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.length === 1 && /[a-z]/i.test(lastPart)) {
                const letter = lastPart.toUpperCase();
                if (!genderLabel) {
                    if (['A', 'C', 'E', 'F', 'G', 'H'].includes(letter)) {
                        genderLabel = " (Kadın)";
                    } else if (['B', 'D', 'I', 'J'].includes(letter)) {
                        genderLabel = " (Erkek)";
                    }
                }
                return `Google ${langLabel} Ses ${letter}${genderLabel}`;
            }

            // Check if there is a generic Google name, e.g. "Google tr-tr"
            return `Google ${langLabel} Ses${genderLabel}`;
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
        voiceSelect.innerHTML = '<option value="default">Varsayılan Ses (Otomatik)</option>';

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

    async getOriginalWordForSelection(selectedText, range) {
        if (!selectedText) return "";
        selectedText = selectedText.trim();
        
        let parent = null;
        if (range) {
            let node = range.commonAncestorContainer;
            if (node.nodeType === Node.TEXT_NODE) {
                node = node.parentNode;
            }
            parent = node.closest('[data-original-text]');
        }
        
        if (!parent) return selectedText;
        
        const originalText = parent.getAttribute('data-original-text');
        if (!originalText || !originalText.trim()) return selectedText;
        
        try {
            // Original language detection using a snippet of the original text
            const detectResult = await translateService.translateGoogleWithDetails(originalText.slice(0, 150), 'tr');
            const origLang = detectResult.lang || 'en';
            
            // Translate the selected Turkish text back to the original language
            const backResult = await translateService.translateGoogleWithDetails(selectedText, origLang, 'tr');
            const backTranslated = backResult.text.trim();
            
            // Try to map the back-translated text back to the actual original text words
            const isSingleWord = !/\s+/.test(selectedText);
            if (isSingleWord) {
                const clean = (w) => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’“]/g,"").toLowerCase();
                const origWords = originalText.split(/\s+/);
                const cleanBack = clean(backTranslated);
                
                // Try exact match in the original words list
                let match = origWords.find(w => clean(w) === cleanBack);
                
                // Try partial match
                if (!match) {
                    match = origWords.find(w => {
                        const cw = clean(w);
                        return cw.length > 2 && cleanBack.length > 2 && (cw.includes(cleanBack) || cleanBack.includes(cw));
                    });
                }
                
                if (match) {
                    return match.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’“]/g,"");
                }
            } else {
                // If it's a phrase, look for matching substring in original text
                const cleanStr = (s) => s.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’“]/g,"").toLowerCase().trim();
                const cleanOrig = cleanStr(originalText);
                const cleanBack = cleanStr(backTranslated);
                
                if (cleanOrig.includes(cleanBack)) {
                    return backTranslated;
                }
            }
            return backTranslated || selectedText;
        } catch (err) {
            console.error("Original word mapping error:", err);
            return selectedText;
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
        
        document.getElementById('view-reader').style.display = 'none';

        document.documentElement.classList.remove('reader-active');
        document.body.classList.remove('reader-active');
        document.documentElement.style.backgroundColor = '';
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

window.addEventListener('scroll', () => {
    if (!document.body.classList.contains('reader-active')) return;

    const currentScrollY = window.scrollY;
    const header = document.querySelector('.reader-header');
    
    // 1. Header Göster/Gizle mantığı (Aşağı kaydırırken gizle, yukarı kaydırırken göster)
    if (header) {
        if (currentScrollY > lastScrollY && currentScrollY > 80) {
            header.classList.remove('open');
        } else if (currentScrollY < lastScrollY) {
            header.classList.add('open');
        }
    }
    lastScrollY = currentScrollY;

    // Sayfa yenilendiğinde (F5) dikey kaydırma konumunu korumak için sessionStorage'a kaydet
    if (reader.currentBookId && !reader.isRestoringBook) {
        try {
            sessionStorage.setItem('endlessr_reader_scroll', JSON.stringify({
                bookId: reader.currentBookId,
                spineIndex: reader.lastSpineIndex,
                pdfPage: reader.pdfCurrentPage,
                scrollY: currentScrollY
            }));
        } catch (e) {}
    }

    // 2. Okuma Konumunu Kaydetme Entegrasyonu
    if (reader.currentBookType === 'epub') {
        reader.saveEpubScrollLocation();
    } else if (reader.currentBookType === 'pdf') {
        reader.savePdfScrollLocation();
    }
});
