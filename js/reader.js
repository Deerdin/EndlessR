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

    // Okuyucu Stil Ayarları (IndexedDB'den veya varsayılan)
    settings: {
        fontSize: 100, // yüzdelik
        fontFamily: "system-ui",
        lineHeight: 1.6,
        theme: "dark",
        tapToTranslate: false,
        padding: 8,
        readerType: "single",
        translationService: "web",
        autoUnlock: false
    },

    async openBook(bookId) {
        try {
            // Kitabı IndexedDB'den al
            const book = await booksDb.getBook(bookId);
            if (!book) throw new Error("Kitap veritabanında bulunamadı.");

            // Eğer kitap dosyası yoksa (favori olmayan, buluttan eksik geri yüklenen kitap)
            if (!book.file) {
                alert("Bu kitap dosyası cihazınızda bulunamadı. Bulut yedeğinde yalnızca en fazla 5 adet olan favori kitaplar saklanır. Okumak için lütfen bu kitabı (.epub/.pdf) kütüphanenize tekrar yükleyin.");
                return;
            }

            this.currentBookId = bookId;
            this.currentBookTitle = book.title;
            this.currentBookType = book.type;
            this.bookData = book;
            this.detectedLang = book.detectedLang || null;

            // Arayüzü hazırla
            document.getElementById('reader-book-title').textContent = book.title;
            document.getElementById('view-reader').style.display = 'flex';
            
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
            this.lastPdfPage = null;

            // Ayarları yükle
            this.settings.fontSize = await settingsDb.get('readerFontSize', 100);
            this.settings.fontFamily = await settingsDb.get('readerFontFamily', 'system-ui');
            this.settings.lineHeight = await settingsDb.get('readerLineHeight', 1.6);
            
            const currentAppTheme = await settingsDb.get('appTheme', 'dark');
            const defaultTheme = currentAppTheme === 'dark' ? 'dark' : 'light';
            this.settings.theme = defaultTheme;
            await settingsDb.set('readerTheme', defaultTheme);
            
            this.settings.tapToTranslate = await settingsDb.get('readerTapToTranslate', false);
            this.settings.padding = await settingsDb.get('readerPadding', 8);
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
            
            // WTR Settings Tabındaki Butonları ve Elemanları Güncelle
            document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-readertype-"]').forEach(btn => btn.classList.remove('active'));
            const typeBtn = document.getElementById(`btn-readertype-${this.settings.readerType}`);
            if (typeBtn) typeBtn.classList.add('active');

            document.getElementById('btn-webtheme-light').classList.toggle('active', currentAppTheme === 'light');
            document.getElementById('btn-webtheme-dark').classList.toggle('active', currentAppTheme === 'dark');

            document.querySelectorAll('#tab-pane-settings .wtr-tab-btn[id^="btn-trans-"]').forEach(btn => btn.classList.remove('active'));
            const transBtn = document.getElementById(`btn-trans-${this.settings.translationService}`);
            if (transBtn) transBtn.classList.add('active');
            await this.updateTranslationSettingsUI();

            const autoUnlockToggle = document.getElementById('toggle-auto-unlock');
            if (autoUnlockToggle) {
                autoUnlockToggle.checked = this.settings.autoUnlock;
            }

            // WTR Reader Theme butonlarını dinamik olarak güncelle
            this.updateReaderThemeUI(currentAppTheme);
            
            // Okuyucu alanlarını sıfırla
            document.getElementById('epub-viewer').style.display = 'none';
            document.getElementById('pdf-viewer').style.display = 'none';
            document.getElementById('pdf-page-indicator').style.display = 'none';
            document.getElementById('btn-prev-page').style.display = 'none';
            document.getElementById('btn-next-page').style.display = 'none';

            // Kitap tipine göre okuyucuyu başlat
            if (book.type === 'epub') {
                await this.initEpub(book.file, book.lastLocation);
            } else if (book.type === 'pdf') {
                await this.initPdf(book.file, book.lastLocation);
            }

            // Temayı uygula
            this.setReaderTheme(this.settings.theme);

            // Son okuma zamanını güncelle
            book.lastReadAt = Date.now();
            await booksDb.saveBook(book);
            
            // Kütüphaneyi arka planda yenile
            if (window.app) window.app.loadLibrary();

            // Kitap açılışını geçmişe kaydet
            if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
                navHistory.push({ type: 'book', value: bookId });
            }

            // Bind voice synthesis voices loaded event
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = () => {
                    this.populateVoices();
                };
                this.populateVoices();
            }

        } catch (err) {
            console.error("Kitap açılırken hata:", err);
            alert("Kitap yüklenemedi: " + err.message);
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
            height: "100%",
            flow: epubFlow,
            manager: epubManager,
            allowScriptedContent: true
        });

        // Kitabı en sonda render edeceğiz (Kancalar ve olay dinleyicileri kaydolduktan sonra)

        // İçindekiler listesini yükle
        this.loadEpubToc();

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
                            const reader = new FileReader();
                            reader.onloadend = () => res(reader.result);
                            reader.onerror = rej;
                            reader.readAsDataURL(blob);
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
            this.epubLocation = location.start.cfi;
            
            const currentSpineIndex = location.start.index;
            const totalSpineItems = this.epubBook.spine.length;
            const progressPercent = Math.round(((currentSpineIndex + 1) / totalSpineItems) * 100);
            
            this.syncSliderToCurrentLocation();
            
            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Ch. ${currentSpineIndex + 1} / ${totalSpineItems} (${progressPercent}%)`;
            }
            
            // İlerlemeyi DB'ye yaz
            booksDb.updateProgress(this.currentBookId, progressPercent, this.epubLocation);
            
            // Bölüm geçişinde geçmişe kaydet (NavHistory)
            if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
                if (this.lastSpineIndex !== currentSpineIndex) {
                    navHistory.push({ type: 'chapter', value: location.start.cfi });
                }
            }
            this.lastSpineIndex = currentSpineIndex;

            // Bölüm geçişinde iframe scrollunu en üste sıfırla
            const viewer = document.getElementById('epub-viewer');
            if (viewer) viewer.scrollTop = 0;
        });

        // EPUB Lokasyonları Hazır Olduğunda
        this.epubBook.ready.then(() => {
            const currentSpineIndex = this.epubRendition.currentLocation() ? this.epubRendition.currentLocation().start.index : 0;
            const totalSpineItems = this.epubBook.spine.length;
            const progressPercent = Math.round(((currentSpineIndex + 1) / totalSpineItems) * 100);
            
            this.syncSliderToCurrentLocation();
            
            const chIndicator = document.getElementById('panel-chapter-indicator');
            if (chIndicator) {
                chIndicator.textContent = `Ch. ${currentSpineIndex + 1} / ${totalSpineItems} (${progressPercent}%)`;
            }
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
                if (this.settings.translationService === 'ai' || (this.settings.translationService === 'web' && this.settings.webService === 'google')) {
                    setTimeout(() => {
                        this.translateDocument(doc, this.settings.targetLang);
                    }, 50);
                }
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
                    const sel = contents.window.getSelection();
                    if (!sel || sel.toString().trim().length === 0) {
                        this.hidePopover();
                    }
                }, 50);
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
                    this.syncSliderToCurrentLocation();
                }
            } else {
                tocList.innerHTML = '<p class="empty-text">Bu kitapta içindekiler tablosu bulunamadı.</p>';
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

        // Iframe'lerdeki custom style elementlerini güncelle (Kenar boşlukları ve renkleri ezmek için)
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

        // Kaldığı sayfayı belirle
        this.pdfCurrentPage = startPage ? parseInt(startPage) : 1;

        // PDF Slider ayarla
        const progressSlider = document.getElementById('reader-progress-slider');
        if (progressSlider) {
            progressSlider.min = 1;
            progressSlider.max = this.pdfTotalPages;
            progressSlider.value = this.pdfCurrentPage;
        }

        await this.renderPdfPage(this.pdfCurrentPage);

        // İlerlemeyi güncelle
        const percent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
        this.updateProgressBar(percent, `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);

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

            // Sayfa numarasını güncelle
            this.pdfCurrentPage = pageNumber;
            document.getElementById('pdf-current-page').textContent = pageNumber;
            
            // İlerlemeyi güncelle
            const percent = Math.round((this.pdfCurrentPage / this.pdfTotalPages) * 100);
            this.updateProgressBar(this.pdfCurrentPage, percent, `Sayfa ${this.pdfCurrentPage} / ${this.pdfTotalPages}`);
            
            // DB'ye kaydet
            booksDb.updateProgress(this.currentBookId, percent, this.pdfCurrentPage);
 
            // PDF sayfa geçişini geçmişe kaydet (NavHistory)
            if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
                if (this.lastPdfPage !== pageNumber) {
                    navHistory.push({ type: 'page', value: pageNumber });
                }
            }
            this.lastPdfPage = pageNumber;

            // Eğer tam sayfa çevirisi aktifse, PDF metin katmanını çevir
            if (this.settings.translationService === 'ai' || (this.settings.translationService === 'web' && this.settings.webService === 'google')) {
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

    // Slider Konumunu Güncelleme
    syncSliderToCurrentLocation() {
        if (!this.numberedChapters || this.numberedChapters.length === 0 || !this.epubRendition) return;

        const currentLocation = this.epubRendition.currentLocation();
        if (!currentLocation || !currentLocation.start) return;

        const currentCfi = currentLocation.start.cfi;
        const currentSpineIndex = currentLocation.start.index;

        let activeIndex = -1;

        // Spine index araması
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
                const currentHref = currentLocation.start.href;
                const currentHash = currentHref.includes('#') ? currentHref.split('#')[1] : null;
                
                if (currentHash) {
                    const match = sameSpineChapters.find(c => {
                        const h = c.chapter.href;
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

        if (activeIndex !== -1) {
            const sliderValue = activeIndex + 1;
            const percent = Math.round((sliderValue / this.numberedChapters.length) * 100);
            const chapterLabel = this.numberedChapters[activeIndex].label;
            const progressText = `Bölüm ${sliderValue}: ${chapterLabel} (${sliderValue} / ${this.numberedChapters.length})`;
            
            this.updateProgressBar(sliderValue, percent, progressText);
        }
    },

    // Slayt İlerleme Çubuğunu Güncelleme
    updateProgressBar(sliderValue, percent, text) {
        const slider = document.getElementById('reader-progress-slider');
        if (slider) {
            slider.value = sliderValue;
        }
        document.getElementById('reader-progress-percent').textContent = percent + '%';
        document.getElementById('reader-progress-label').textContent = text;
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
        const aiResult = document.getElementById('ai-translation-result');
        const aiText = document.getElementById('ai-translation-text');

        // Popover içeriğini hazırla
        const displayWord = selectedText ? selectedText.trim() : text;
        textPreview.textContent = displayWord.length > 30 ? displayWord.substring(0, 30) + "..." : displayWord;
        popover.setAttribute('data-selected-word', text);
        popover.setAttribute('data-context-sentence', sentence);
        
        translationText.textContent = "";
        aiText.textContent = "";
        loader.style.display = 'flex';
        aiResult.style.display = 'none';

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

        const service = this.settings.translationService || 'none';

        if (service === 'ai') {
            translationText.style.display = 'none';
            aiResult.style.display = 'block';
            aiText.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> AI Düşünüyor...';
            if (typeof lucide !== 'undefined') lucide.createIcons();
            loader.style.display = 'none';
            
            try {
                const apiKeys = await settingsDb.getApiKeys();
                let explanation = "";
                if (apiKeys.gemini) {
                    explanation = await translateService.explainWithGemini(text, sentence, apiKeys.gemini);
                } else if (apiKeys.openai) {
                    explanation = await translateService.explainWithOpenAI(text, sentence, apiKeys.openai);
                } else {
                    explanation = "Lütfen Ayarlar kısmından Gemini veya OpenAI API anahtarı ekleyin.";
                }
                aiText.textContent = explanation;
            } catch (err) {
                aiText.textContent = "AI Hatası: " + err.message;
            }
        } else {
            translationText.style.display = 'block';
            aiResult.style.display = 'none';
            
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
            alert(`"${word}" kelimesi sözlüğünüze eklendi!`);
            this.hidePopover();
            // Kelimelerim ekranını yenile
            if (window.app) window.app.loadWords();
        } else {
            alert("Kelime kaydedilirken bir hata oluştu.");
        }
    },

    // AI ile Kelimeyi Açıklatma (Gemini veya OpenAI API)
    async explainWithAI() {
        const popover = document.getElementById('translate-popover');
        const word = popover.getAttribute('data-selected-word');
        const context = popover.getAttribute('data-context-sentence');
        const aiResult = document.getElementById('ai-translation-result');
        const aiText = document.getElementById('ai-translation-text');

        aiText.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> AI Düşünüyor...';
        lucide.createIcons(); // loader ikonunu oluştur
        aiResult.style.display = 'block';

        try {
            // API anahtarlarını çek
            const apiKeys = await settingsDb.getApiKeys();
            let aiExplanation = "";

            if (apiKeys.gemini) {
                aiExplanation = await translateService.explainWithGemini(word, context, apiKeys.gemini);
            } else if (apiKeys.openai) {
                aiExplanation = await translateService.explainWithOpenAI(word, context, apiKeys.openai);
            } else {
                throw new Error("Ayarlar kısmından Gemini veya OpenAI API anahtarı eklemelisiniz.");
            }

            aiText.textContent = aiExplanation;

        } catch (e) {
            aiText.textContent = e.message;
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
        // Her ilk açılışta sekmeleri pasifleştirerek sadece alt barın görünmesini sağla
        document.querySelectorAll('.panel-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.reader-options-panel .tab-pane').forEach(pane => pane.classList.remove('active'));
        
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

    // Çeviri Servisi Ayarlama (Web / Web+ / AI)
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
        
        let aiInfoRow = document.getElementById('wtr-ai-info-row');
        if (!aiInfoRow && serviceRow) {
            aiInfoRow = document.createElement('div');
            aiInfoRow.id = 'wtr-ai-info-row';
            aiInfoRow.style.cssText = `
                display: none;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 12px;
                background: rgba(255,255,255,0.05);
                border: 1px solid var(--border-color);
                border-radius: var(--radius-sm);
                font-size: 13px;
                font-weight: 500;
                color: var(--text-primary);
                box-sizing: border-box;
            `;
            serviceRow.parentNode.appendChild(aiInfoRow);
        }

        const currentService = this.settings.translationService || 'none';

        if (currentService === 'none') {
            if (langSection) langSection.style.display = 'none';
        } else {
            if (langSection) langSection.style.display = 'flex';
            
            if (currentService === 'ai') {
                if (sectionLabel) sectionLabel.innerHTML = 'ACTIVE AI ENGINE <span style="font-size: 10px; text-transform: none; font-weight: 500;">(AI Translation)</span>';
                if (serviceRow) serviceRow.style.display = 'none';
                if (aiInfoRow) {
                    aiInfoRow.style.display = 'flex';
                    // Find which AI engine is active
                    try {
                        const keys = await settingsDb.getApiKeys();
                        if (keys.gemini) {
                            aiInfoRow.innerHTML = `<i data-lucide="sparkles" style="width: 16px; height: 16px; color: #a855f7;"></i> <span>Gemini 2.5 Flash</span>`;
                        } else if (keys.openai) {
                            aiInfoRow.innerHTML = `<i data-lucide="brain" style="width: 16px; height: 16px; color: #10b981;"></i> <span>GPT-4o-Mini</span>`;
                        } else {
                            aiInfoRow.innerHTML = `<i data-lucide="alert-triangle" style="width: 16px; height: 16px; color: #f59e0b;"></i> <span style="color: #f59e0b;">AI Engine (API Key Missing!)</span>`;
                        }
                        if (typeof lucide !== 'undefined') lucide.createIcons();
                    } catch (e) {
                        aiInfoRow.innerHTML = `<span>AI Engine</span>`;
                    }
                }
            } else {
                if (sectionLabel) sectionLabel.innerHTML = 'READER LANGUAGE <span style="font-size: 10px; text-transform: none; font-weight: 500;">(Web Translation)</span>';
                if (serviceRow) serviceRow.style.display = 'flex';
                if (aiInfoRow) aiInfoRow.style.display = 'none';
            }
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
        if (transService === 'ai' || (transService === 'web' && this.settings.webService === 'google')) {
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

        const chunkSize = transService === 'ai' ? 30 : 15;
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
    },

    async translateTextsBatch(texts, targetLang) {
        const transService = this.settings.translationService || 'web';
        
        if (transService === 'ai') {
            try {
                const apiKeys = await settingsDb.getApiKeys();
                if (apiKeys.gemini || apiKeys.openai) {
                    const results = new Array(texts.length);
                    const missingIndexes = [];
                    const missingTexts = [];
                    
                    // 1. Check persistent database cache
                    for (let i = 0; i < texts.length; i++) {
                        const cached = await translationsDb.getTranslation(texts[i]);
                        if (cached) {
                            results[i] = cached;
                        } else {
                            missingIndexes.push(i);
                            missingTexts.push(texts[i]);
                        }
                    }
                    
                    // 2. If there are any missing paragraphs, translate them via API in a single batch request
                    if (missingTexts.length > 0) {
                        console.log(`AI Cache Miss: translating ${missingTexts.length} paragraphs`);
                        let translatedParts = [];
                        if (apiKeys.gemini) {
                            translatedParts = await translateService.translateBatchWithGemini(missingTexts, targetLang, apiKeys.gemini);
                        } else if (apiKeys.openai) {
                            translatedParts = await translateService.translateBatchWithOpenAI(missingTexts, targetLang, apiKeys.openai);
                        }
                        
                        if (translatedParts && translatedParts.length === missingTexts.length) {
                            for (let k = 0; k < missingTexts.length; k++) {
                                const origIdx = missingIndexes[k];
                                results[origIdx] = translatedParts[k];
                                // Save to persistent database cache
                                await translationsDb.saveTranslation(missingTexts[k], translatedParts[k]);
                            }
                        } else {
                            throw new Error(`AI Çeviri boyutu eşleşmedi: ${translatedParts ? translatedParts.length : 0} adet döndü, ${missingTexts.length} adet bekleniyordu.`);
                        }
                    } else {
                        console.log("AI Cache Hit: all paragraphs loaded from local database.");
                    }
                    
                    return results;
                } else {
                    throw new Error("Yapay zeka (AI) API anahtarı bulunamadı. Ayarlar kısmından Gemini veya OpenAI anahtarı ekleyin.");
                }
            } catch (err) {
                console.error("AI batch translation failed, falling back to Google:", err);
                if (!window.geminiAlertShown) {
                    window.geminiAlertShown = true;
                    alert("AI Çevirisi başarısız oldu:\n" + err.message + "\n\nNot: Sistem otomatik olarak standart Google Çevirisine geçiş yapacaktır.");
                    setTimeout(() => { window.geminiAlertShown = false; }, 10000);
                }
            }
        }

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

    // Özel stilleri dökümana (iframe içine) uygulama ve EPUB renklerini zorla ezme metodu
    applyCustomStylesToDoc(doc) {
        if (!doc) return;
        const rType = this.settings.readerType || "single";
        const padVal = this.settings.padding !== undefined ? this.settings.padding : 8;
        const colors = this.getThemeColors(this.settings.theme);
        
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
                    box-sizing: border-box !important;
                    background-color: ${colors.bg} !important;
                    color: ${colors.fg} !important;
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
                /* Genişlik ve kitap içi renk kısıtlamalarını ezelim */
                p, div, section, article, span, h1, h2, h3, h4, h5, h6 {
                    max-width: 100% !important;
                    width: auto !important;
                    background-color: transparent !important;
                    color: inherit !important;
                }
            `;
        } else {
            css = `
                html, body {
                    padding: calc(env(safe-area-inset-top, 30px) + 15px) ${padVal}px 30px !important;
                    box-sizing: border-box !important;
                    background-color: ${colors.bg} !important;
                    color: ${colors.fg} !important;
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
                p, div, section, article, span, h1, h2, h3, h4, h5, h6 {
                    background-color: transparent !important;
                    color: inherit !important;
                }
            `;
        }
        customStyle.textContent = css;
    },

    // Okuyucu Teması Seçme
    async setReaderTheme(themeName) {
        this.settings.theme = themeName;
        await settingsDb.set('readerTheme', themeName);

        // Reader element sınıfını güncelle
        const readerEl = document.getElementById('view-reader');
        readerEl.className = 'reader-view';
        readerEl.classList.add(`theme-${themeName}`);

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
    },

    // WTR Reader Theme butonlarını uygulama temasına göre dinamik güncelle
    updateReaderThemeUI(webTheme) {
        const grid = document.querySelector('.wtr-theme-grid');
        if (!grid) return;
        
        let html = '';
        if (webTheme === 'dark') {
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

    // Sesli Kitap Okuma Başlat (TTS)
    async startTTS() {
        if (!('speechSynthesis' in window)) {
            alert("Cihazınız Sesli Okuma (TTS) özelliğini desteklemiyor.");
            return;
        }

        let textToRead = "";
        
        if (this.currentBookType === 'epub' && this.epubRendition) {
            // Priority: Read directly from active iframes inside #epub-viewer to guarantee we read what the user sees on screen
            const iframes = document.querySelectorAll("#epub-viewer iframe");
            let frameTexts = [];
            iframes.forEach(iframe => {
                try {
                    if (iframe && iframe.contentDocument) {
                        frameTexts.push(iframe.contentDocument.body.innerText);
                    }
                } catch (err) {}
            });
            
            if (frameTexts.length > 0) {
                textToRead = frameTexts.join('\n');
            }
            
            // Fallback to official getContents() if iframes were not found or empty
            if (!textToRead) {
                try {
                    const contents = this.epubRendition.getContents();
                    if (contents && contents.length > 0) {
                        textToRead = contents.map(c => c.document ? c.document.body.innerText : "").join('\n');
                    }
                } catch (e) {
                    console.warn("EpubJS getContents failed:", e);
                }
            }
        } else if (this.currentBookType === 'pdf' && this.pdfDocument) {
            // Priority: Read directly from the rendered textLayer in #pdf-viewer to ensure translated text is read
            const textSpans = document.querySelectorAll("#pdf-viewer .textLayer span");
            if (textSpans && textSpans.length > 0) {
                textToRead = Array.from(textSpans).map(span => span.innerText || span.textContent).join(' ');
            }
            
            // Fallback to extraction from PDF page object if DOM is empty
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
        
        // Temizleme ve boşluk azaltma
        textToRead = textToRead.replace(/\s+/g, ' ').trim();
        
        if (textToRead) {
            try {
                window.speechSynthesis.cancel(); // Mevcut sesleri kes
            } catch (e) {
                console.warn("SpeechSynthesis cancel failed:", e);
            }
            
            // Speak synchronously to preserve the user gesture flow (fixes silent speech synthesis in WebView)
            try {
                const speedSelect = document.getElementById('tts-speed-select');
                const speed = speedSelect ? parseFloat(speedSelect.value) : 1.0;
                
                const utterance = new SpeechSynthesisUtterance(textToRead);
                utterance.rate = speed;
                
                // Voice selection logic (male, female, Google, etc.)
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
                    // Türkçe karakter testi ile dili belirleme
                    const hasTurkishChars = /[çğıöşüÇĞİÖŞÜ]/.test(textToRead.substring(0, Math.min(textToRead.length, 1000)));
                    const targetLang = hasTurkishChars ? 'tr' : 'en';
                    utterance.lang = hasTurkishChars ? 'tr-TR' : 'en-US';
                    
                    const matchingVoice = voices.find(v => {
                        const l = v.lang.toLowerCase();
                        return l.startsWith(targetLang);
                    });
                    if (matchingVoice) {
                        utterance.voice = matchingVoice;
                    }
                }
                
                // Okuma bittiğinde buton durumunu sıfırla
                utterance.onend = () => {
                    this.stopTTS();
                };
                
                utterance.onerror = (err) => {
                    console.error("TTS Speech Utterance Error:", err);
                    this.stopTTS();
                };
                
                window.speechSynthesis.speak(utterance);
            } catch (speechErr) {
                console.error("Failed to call speechSynthesis.speak:", speechErr);
                alert("Seslendirme başlatılamadı: " + speechErr.message);
                this.stopTTS();
            }
            
            // Oynat butonunu durdur ikonuna dönüştür
            const btn = document.getElementById('btn-tts-toggle');
            if (btn) {
                btn.innerHTML = '<i data-lucide="pause"></i> Duraklat';
                lucide.createIcons();
            }
        } else {
            alert("Okunacak metin bulunamadı.");
        }
    },
    
    stopTTS() {
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
    closeReader() {
        this.stopTTS();
        
        document.getElementById('view-reader').style.display = 'none';
        
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

        // Okuyucudan çıkıldığında son ilerlemeyi buluta yedekle
        if (typeof supabaseService !== 'undefined') {
            supabaseService.performBackup(true);
        }

        // Ekran butonuna basarak kapatıldıysa tarayıcı geçmişini temizle ve eşitle
        if (typeof navHistory !== 'undefined' && !navHistory.isNavigatingBack) {
            let popCount = 0;
            while (navHistory.stack.length > 1) {
                const top = navHistory.stack[navHistory.stack.length - 1];
                if (top.type === 'view') {
                    break;
                }
                navHistory.stack.pop();
                popCount++;
            }
            if (popCount > 0) {
                navHistory.isNavigatingBack = true;
                window.history.go(-popCount);
                setTimeout(() => {
                    navHistory.isNavigatingBack = false;
                }, 100);
            }
        }
    }
};
