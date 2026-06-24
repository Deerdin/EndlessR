// ================= ANA UYGULAMA KONTROLCÜSÜ (js/app.js) =================

// Donanımsal veya Uygulama İçi Sayfa Geri Geçmişi Takipçisi
const navHistory = {
    stack: [],
    isNavigatingBack: false,
    
    push(action) {
        const isFirst = this.stack.length === 0;
        if (!isFirst) {
            const last = this.stack[this.stack.length - 1];
            if (last.type === action.type && last.value === action.value) {
                return; // Yinelenen kaydı önle
            }
        }
        this.stack.push(action);

        // Tarayıcı geçmişine de kaydet (popstate tetiklenmesi için)
        if (typeof window !== 'undefined' && window.history) {
            if (isFirst) {
                window.history.replaceState({ stackIndex: this.stack.length - 1 }, "");
            } else {
                window.history.pushState({ stackIndex: this.stack.length - 1 }, "");
            }
        }
    },
    
    pop() {
        if (this.stack.length > 1) {
            const current = this.stack.pop();
            const previous = this.stack[this.stack.length - 1];
            return { current, previous };
        }
        return null;
    },
    
    clear() {
        this.stack = [];
    }
};

const app = {
    // Uygulama Başlangıcı
    async init() {
        console.log("EndlessR Kitap Okuma Uygulaması Başlatıldı.");

        // 1. Service Worker Kaydı (Çevrimdışı PWA Desteği)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker Kaydedildi. Kapsam:', reg.scope))
                .catch(err => console.warn('Service Worker Kayıt Hatası:', err));
        }

        // Lucide İkonlarını Çiz
        lucide.createIcons();

        // 2. Temel Uygulama Ayarlarını Yükle
        const appTheme = await settingsDb.get('appTheme', 'dark');
        this.setAppTheme(appTheme);

        // Donanımsal geri tuşu ve ekran geçmişi takibi başlat (Root Home)
        navHistory.push({ type: 'view', value: 'view-home' });
        
        // Capacitor Back Button ve Durum Dinleyicileri
        if (window.Capacitor && typeof window.Capacitor.Plugins !== 'undefined') {
            const { App } = window.Capacitor.Plugins;
            if (App) {
                App.addListener('backButton', () => {
                    this.handleHardwareBack();
                });
                App.addListener('appStateChange', (state) => {
                    if (!state.isActive && typeof gdriveService !== 'undefined') {
                        console.log("Capacitor auto-sync: App moved to background, performing backup...");
                        gdriveService.performBackup(true);
                    }
                });
            }
        }

        // 3. Ekranları Yükle
        await this.loadLibrary();
        await this.loadWords();
        await this.loadSettings();
        await this.loadReplacements();

        // Google Drive Eşitleme Servisini Başlat
        if (typeof gdriveService !== 'undefined') {
            await gdriveService.init();
        }

        // 3. Olay Dinleyicilerini Kur
        this.setupEventListeners();
    },

    // 1. Ekran Geçişlerini Yönet
    switchView(viewId) {
        // Tüm görünümleri pasif yap
        document.querySelectorAll('.app-view').forEach(view => {
            view.classList.remove('active');
        });
        // İlgili görünümü aktif yap
        document.getElementById(viewId).classList.add('active');

        // Navigasyon barı düğmelerini güncelle
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-view') === viewId) {
                btn.classList.add('active');
            }
        });

        // Geçmişe kaydet (eğer geri gidilmiyorsa)
        if (!navHistory.isNavigatingBack) {
            navHistory.push({ type: 'view', value: viewId });
        }

        // Çeviri Popover'ını gizle
        reader.hidePopover();
    },

    // 2. Kütüphaneyi IndexedDB'den Yükle
    async loadLibrary() {
        const bookGrid = document.getElementById('book-grid');
        const profileBookGrid = document.getElementById('profile-book-grid');
        const emptyState = document.getElementById('library-empty');
        const statsSummary = document.getElementById('profile-stats-text');
        
        if (bookGrid) bookGrid.innerHTML = '';
        if (profileBookGrid) profileBookGrid.innerHTML = '';
        
        const books = await booksDb.getAllBooks();
        
        if (books.length === 0) {
            if (emptyState) emptyState.style.display = 'flex';
            if (statsSummary) statsSummary.textContent = "Kütüphanede kitap bulunmuyor.";
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        
        // Okuma istatistikleri
        const totalBooks = books.length;
        const readBooks = books.filter(b => b.progressPercent >= 95).length;
        const readingBooks = books.filter(b => b.progressPercent > 0 && b.progressPercent < 95).length;
        
        if (statsSummary) {
            statsSummary.textContent = `${totalBooks} kitap yüklü. (${readingBooks} okunuyor, ${readBooks} bitti)`;
        }

        books.forEach(book => {
            const card = this.createBookCard(book);
            if (bookGrid) bookGrid.appendChild(card);
            
            // Profil Kitaplık segmentine de ekle
            if (profileBookGrid) {
                const profileCard = this.createBookCard(book);
                profileBookGrid.appendChild(profileCard);
            }
        });

        // Yeni eklenen ikonları çizdir
        lucide.createIcons();
    },

    // Kitap Silme İşlemi
    async deleteBook(id, title, force = false) {
        if (force || confirm(`"${title}" kitabını kütüphanenizden tamamen silmek istediğinize emin misiniz?`)) {
            const success = await booksDb.deleteBook(id);
            if (success) {
                // Kitap detay paneli açıksa kapat
                const panel = document.getElementById('book-details-panel');
                if (panel) panel.classList.remove('open');
                
                await this.loadLibrary();
            } else {
                alert("Kitap silinirken bir hata oluştu.");
            }
        }
    },

    // 3. Kelimeleri (Sözlüğü) IndexedDB'den Yükle
    async loadWords(searchQuery = "") {
        const wordsList = document.getElementById('words-list');
        const emptyState = document.getElementById('words-empty');
        
        wordsList.innerHTML = '';
        
        let words = await wordsDb.getAllWords();

        // Profil son kelimeler önizlemesini güncelle
        const recentWordsList = document.getElementById('profile-recent-words-list');
        if (recentWordsList) {
            recentWordsList.innerHTML = '';
            const recentWords = words.slice(0, 5);
            if (recentWords.length === 0) {
                recentWordsList.innerHTML = '<p style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 10px 0;">Henüz kaydedilmiş kelime yok.</p>';
            } else {
                recentWords.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'word-card glass';
                    card.style.padding = '10px 14px';
                    card.style.margin = '0';
                    card.innerHTML = `
                        <div class="word-header" style="margin-bottom: 2px;">
                            <span class="word-title" style="font-size: 14px;">${item.word}</span>
                        </div>
                        <div class="word-meaning" style="font-size: 12px;">${item.meaning}</div>
                    `;
                    card.onclick = () => translateService.speak(item.word);
                    recentWordsList.appendChild(card);
                });
            }
        }

        // Arama filtresi uygula
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase().trim();
            words = words.filter(w => 
                w.word.toLowerCase().includes(query) || 
                w.meaning.toLowerCase().includes(query)
            );
        }

        if (words.length === 0) {
            emptyState.style.display = 'flex';
            return;
        }

        emptyState.style.display = 'none';

        words.forEach(item => {
            const card = document.createElement('div');
            card.className = 'word-card glass';
            
            // Tarih formatı
            const dateStr = new Date(item.addedAt).toLocaleDateString('tr-TR', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            });

            card.innerHTML = `
                <div class="word-header">
                    <span class="word-title">${item.word}</span>
                    <button class="btn-delete-word" title="Sözlükten Sil" onclick="app.deleteWord('${item.id}')">
                        <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
                    </button>
                </div>
                <div class="word-meaning">${item.meaning}</div>
                ${item.context ? `<div class="word-context">"${item.context}"</div>` : ''}
                <div class="word-footer">
                    <span>📚 ${item.bookTitle}</span>
                    <span>${dateStr}</span>
                </div>
            `;

            // Kartın üzerine tıklandığında kelimeyi seslendirsin (kolay dinleme)
            card.onclick = (e) => {
                // Silme butonuna basıldıysa seslendirme
                if (e.target.closest('.btn-delete-word')) return;
                translateService.speak(item.word);
            };

            wordsList.appendChild(card);
        });

        lucide.createIcons();
    },

    // Kelime Silme İşlemi
    async deleteWord(id) {
        const success = await wordsDb.deleteWord(id);
        if (success) {
            this.loadWords(document.getElementById('search-words').value);
        }
    },

    // 4. Ayarları Yükle
    async loadSettings() {
        // API Anahtarlarını yükle ve alanları doldur
        const keys = await settingsDb.getApiKeys();
        document.getElementById('gemini-key').value = keys.gemini;
        document.getElementById('openai-key').value = keys.openai;
    },

    // API Anahtarlarını Kaydet
    async saveApiKeys() {
        const geminiKey = document.getElementById('gemini-key').value;
        const openaiKey = document.getElementById('openai-key').value;

        await settingsDb.saveApiKeys(geminiKey, openaiKey);
        alert("API anahtarları güvenli şekilde kaydedildi!");
        
        if (typeof reader !== 'undefined' && reader.updateTranslationSettingsUI) {
            await reader.updateTranslationSettingsUI();
        }
    },

    // Uygulama Genel Temasını Değiştir
    async setAppTheme(themeName) {
        document.body.className = ''; // Tüm sınıfları sil
        document.body.classList.add(`theme-${themeName}`);
        
        await settingsDb.set('appTheme', themeName);

        // Ayarlar ekranındaki butonların aktifliğini güncelle
        const themeButtons = document.querySelectorAll('#view-settings .theme-btn');
        themeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(themeName)) {
                btn.classList.add('active');
            }
        });

        // WTR Settings Tabındaki Website Theme Butonlarını Güncelle
        const btnWebThemeLight = document.getElementById('btn-webtheme-light');
        const btnWebThemeDark = document.getElementById('btn-webtheme-dark');
        if (btnWebThemeLight && btnWebThemeDark) {
            btnWebThemeLight.classList.toggle('active', themeName === 'light');
            btnWebThemeDark.classList.toggle('active', themeName === 'dark');
        }

        // Reader Modülünün Temasını Güncelle
        if (typeof reader !== 'undefined') {
            const defaultReaderTheme = themeName === 'dark' ? 'dark' : 'light';
            await reader.setReaderTheme(defaultReaderTheme);
            reader.updateReaderThemeUI(themeName);
        }
    },

    // 5. Dosya Yükleme ve İşleme Mekanizması
    async handleFileUpload(file) {
        if (!file) return;

        // Dosya türü kontrolü
        const fileExt = file.name.split('.').pop().toLowerCase();
        if (fileExt !== 'epub' && fileExt !== 'pdf') {
            alert("Lütfen sadece .epub veya .pdf uzantılı dosyalar yükleyin.");
            return;
        }

        // Yükleme ekranı simülasyonu
        const bookGrid = document.getElementById('book-grid');
        const emptyState = document.getElementById('library-empty');
        if (emptyState) emptyState.style.display = 'none';
        
        bookGrid.innerHTML = `
            <div class="loader-spinner" style="padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; grid-column: span 2;">
                <i data-lucide="loader-2" class="upload-icon spin-icon" style="width: 32px; height: 32px; color: var(--accent-color);"></i>
                <p style="font-size: 13px; color: var(--text-secondary); text-align: center;">Kitap çözümleniyor ve IndexedDB'ye kaydediliyor, lütfen bekleyin...</p>
            </div>
        `;
        lucide.createIcons();

        try {
            const reader = new FileReader();
            
            reader.onload = async (e) => {
                const arrayBuffer = e.target.result;
                let metadata = {};

                if (fileExt === 'epub') {
                    metadata = await utils.extractEpubMetadata(arrayBuffer, file.name);
                } else if (fileExt === 'pdf') {
                    metadata = await utils.extractPdfMetadata(arrayBuffer, file.name);
                }

                // Kitap veritabanı objesini oluştur
                const newBook = {
                    id: utils.generateId(),
                    title: metadata.title || file.name.replace(/\.[^/.]+$/, ""),
                    author: metadata.author || "Bilinmeyen Yazar",
                    coverUrl: metadata.coverUrl,
                    type: fileExt,
                    file: arrayBuffer, // ArrayBuffer doğrudan IndexedDB'de binary saklanır
                    progressPercent: 0,
                    lastLocation: null,
                    addedAt: Date.now(),
                    lastReadAt: 0
                };

                await booksDb.saveBook(newBook);
                
                // Başarı mesajı ve yenileme
                alert(`"${newBook.title}" başarıyla yüklendi!`);
                await this.loadLibrary();
            };

            reader.onerror = () => {
                throw new Error("Dosya okunurken bir hata oluştu.");
            };

            reader.readAsArrayBuffer(file);

        } catch (err) {
            console.error("Yükleme Hatası:", err);
            alert("Dosya yüklenemedi: " + err.message);
            await this.loadLibrary();
        }
    },

    isLibraryDeleteMode: false,

    toggleLibraryDeleteMode() {
        this.isLibraryDeleteMode = !this.isLibraryDeleteMode;
        const btn = document.getElementById('btn-home-delete-mode');
        const grid = document.getElementById('book-grid');
        
        if (this.isLibraryDeleteMode) {
            if (btn) {
                btn.style.background = 'rgba(239, 68, 68, 0.9)';
                btn.style.color = 'white';
                btn.style.borderColor = 'rgba(239, 68, 68, 0.9)';
            }
            if (grid) {
                grid.classList.add('delete-mode-active');
            }
        } else {
            if (btn) {
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-secondary)';
                btn.style.borderColor = 'var(--border-color)';
            }
            if (grid) {
                grid.classList.remove('delete-mode-active');
            }
        }
    },

    // 6. Tüm Olay Dinleyicileri (Event Listeners)
    setupEventListeners() {
        // Alt Navigasyon Bar Tıklamaları
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const viewId = e.currentTarget.getAttribute('data-view');
                this.switchView(viewId);
            });
        });

        // Kitap Silme Modu Butonu Tıklaması
        const btnDeleteMode = document.getElementById('btn-home-delete-mode');
        if (btnDeleteMode) {
            btnDeleteMode.addEventListener('click', () => {
                this.toggleLibraryDeleteMode();
            });
        }

        // Dosya Yükleme Butonu
        const btnUploadTrigger = document.getElementById('btn-home-upload-trigger');
        const fileInput = document.getElementById('file-input');

        if (btnUploadTrigger) {
            btnUploadTrigger.addEventListener('click', () => fileInput.click());
        }
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.handleFileUpload(e.target.files[0]);
                    e.target.value = ""; // Inputu sıfırla
                }
            });
        }

        // Profil Segment Değiştirici Tıklamaları
        document.querySelectorAll('.segment-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const segmentId = e.currentTarget.getAttribute('data-segment');
                
                // Segment butonlarını güncelle
                document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                
                // Segment panellerini güncelle
                document.querySelectorAll('.segment-pane').forEach(pane => pane.classList.remove('active'));
                const targetPane = document.getElementById(segmentId);
                if (targetPane) targetPane.classList.add('active');
            });
        });

        // "Tüm Kelimelerimi Gör" Yönlendirme Butonu
        const btnGoToDict = document.getElementById('btn-go-to-dictionary');
        if (btnGoToDict) {
            btnGoToDict.addEventListener('click', () => {
                this.switchView('view-words');
            });
        }

        // Manuel Kelime Ekleme Modalı Kontrolleri
        const btnAddWordManual = document.getElementById('btn-add-word-manual');
        if (btnAddWordManual) {
            btnAddWordManual.addEventListener('click', () => {
                const modal = document.getElementById('add-word-modal');
                if (modal) {
                    modal.style.display = 'flex';
                    document.getElementById('manual-word').value = '';
                    document.getElementById('manual-meaning').value = '';
                    document.getElementById('manual-context').value = '';
                    document.getElementById('manual-word').focus();
                }
            });
        }

        const btnCloseWordModal = document.getElementById('btn-close-word-modal');
        if (btnCloseWordModal) {
            btnCloseWordModal.addEventListener('click', () => {
                const modal = document.getElementById('add-word-modal');
                if (modal) modal.style.display = 'none';
            });
        }

        const modalOverlay = document.getElementById('add-word-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) {
                    modalOverlay.style.display = 'none';
                }
            });
        }

        const btnSaveManualWord = document.getElementById('btn-save-manual-word');
        if (btnSaveManualWord) {
            btnSaveManualWord.addEventListener('click', async () => {
                const word = document.getElementById('manual-word').value.trim();
                const meaning = document.getElementById('manual-meaning').value.trim();
                const context = document.getElementById('manual-context').value.trim();

                if (!word || !meaning) {
                    alert("Lütfen en azından kelimeyi ve anlamını girin.");
                    return;
                }

                const newWord = {
                    word: word,
                    meaning: meaning,
                    context: context,
                    bookTitle: "Manuel Eklendi",
                    bookId: "manual",
                    addedAt: Date.now()
                };

                const success = await wordsDb.saveWord(newWord);
                if (success) {
                    const modal = document.getElementById('add-word-modal');
                    if (modal) modal.style.display = 'none';
                    await this.loadWords();
                } else {
                    alert("Kelime kaydedilirken bir hata oluştu.");
                }
            });
        }

        // Kelime Arama Çubuğu
        const searchInput = document.getElementById('search-words');
        searchInput.addEventListener('input', (e) => {
            this.loadWords(e.target.value);
        });

        // API Anahtarı Kaydetme Butonu
        document.getElementById('btn-save-keys').addEventListener('click', () => {
            this.saveApiKeys();
        });

        // OKUYUCU EYLEMLERİ
        // Geri Dön Butonu
        document.getElementById('btn-reader-back').addEventListener('click', () => {
            reader.closeReader();
        });

        // Yan Panel (TOC) Tetikleyici
        document.getElementById('btn-reader-toc').addEventListener('click', () => {
            reader.openTOCPanel();
        });
        document.getElementById('btn-close-toc').addEventListener('click', () => {
            reader.closeTOCPanel();
        });

        // BİRLEŞİK OKUMA AYARLARI KONTROL PANELİ EYLEMLERİ
        // Panel Aç/Kapat FAB Tetikleyici
        document.getElementById('btn-reader-panel-trigger').addEventListener('click', () => {
            const panel = document.getElementById('reader-options-panel');
            if (panel.classList.contains('open')) {
                reader.closeStylePanel();
            } else {
                reader.openStylePanel();
            }
        });
        
        // Sürükleme çizgisi / kapatma butonu ile kapatma
        document.getElementById('panel-drag-handle').addEventListener('click', () => {
            reader.closeStylePanel();
        });

        // Panel İçi Tab (Sekme) Geçişleri
        document.querySelectorAll('.panel-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTabPaneId = e.currentTarget.getAttribute('data-tab');
                
                // Tab butonlarını pasifleştir ve tıklanana aktiflik ver
                document.querySelectorAll('.panel-tab-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                
                // Tab içerik alanlarını gizle ve hedefleneni göster
                document.querySelectorAll('.reader-options-panel .tab-pane').forEach(pane => pane.classList.remove('active'));
                document.getElementById(targetTabPaneId).classList.add('active');
            });
        });

        // Panel Sayfa Geçiş Butonları (Bölüm Tabı)
        document.getElementById('btn-panel-prev').addEventListener('click', () => {
            reader.prevPage();
        });
        document.getElementById('btn-panel-next').addEventListener('click', () => {
            reader.nextPage();
        });
        document.getElementById('btn-panel-toc').addEventListener('click', () => {
            reader.openTOCPanel();
            reader.closeStylePanel();
        });
        document.getElementById('btn-panel-delete-book').addEventListener('click', async () => {
            if (reader.currentBookId) {
                const bookId = reader.currentBookId;
                const bookTitle = reader.currentBookTitle;
                if (confirm(`"${bookTitle}" kitabını kütüphanenizden tamamen silmek istediğinize emin misiniz?`)) {
                    const success = await booksDb.deleteBook(bookId);
                    if (success) {
                        reader.closeReader();
                        app.loadLibrary();
                    } else {
                        alert("Kitap silinirken bir hata oluştu.");
                    }
                }
            }
        });
        document.getElementById('btn-panel-close-reader').addEventListener('click', () => {
            reader.closeReader();
        });

        // Sayfa Değiştirme Butonları (EPUB & PDF)
        document.getElementById('btn-prev-page').addEventListener('click', () => {
            reader.prevPage();
        });
        document.getElementById('btn-next-page').addEventListener('click', () => {
            reader.nextPage();
        });

        // Klavye Yön Tuşları ile Sayfa Değiştirme (Eğer klavye varsa)
        document.addEventListener('keydown', (e) => {
            if (document.getElementById('view-reader').style.display === 'flex') {
                if (e.key === "ArrowLeft") reader.prevPage();
                if (e.key === "ArrowRight") reader.nextPage();
            }
        });

        // Yazı Boyutu Artırma/Azaltma
        document.getElementById('btn-font-dec').addEventListener('click', () => {
            reader.adjustFontSize(-10);
        });
        document.getElementById('btn-font-inc').addEventListener('click', () => {
            reader.adjustFontSize(10);
        });

        // Satır Aralığı Artırma/Azaltma
        document.getElementById('btn-lineheight-dec').addEventListener('click', () => {
            reader.adjustLineHeight(-0.1);
        });
        document.getElementById('btn-lineheight-inc').addEventListener('click', () => {
            reader.adjustLineHeight(0.1);
        });

        // Kenar Boşluğu Artırma/Azaltma
        document.getElementById('btn-padding-dec').addEventListener('click', () => {
            reader.adjustPadding(-4);
        });
        document.getElementById('btn-padding-inc').addEventListener('click', () => {
            reader.adjustPadding(4);
        });

        // Yazı Tipi Butonları (Görünüm Tabı)
        document.querySelectorAll('.font-family-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const font = e.currentTarget.getAttribute('data-font');
                reader.changeFontFamily(font);
            });
        });

        // Tema Grid Butonları (Görünüm Tabı)
        document.querySelectorAll('.theme-grid-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const theme = e.currentTarget.getAttribute('data-theme');
                reader.setReaderTheme(theme);
            });
        });

        // Dokunarak Çeviri (Tap to Translate) Geçişi (Ayarlar Tabı)
        const toggleTapToTranslate = document.getElementById('toggle-tap-to-translate');
        if (toggleTapToTranslate) {
            toggleTapToTranslate.addEventListener('change', (e) => {
                reader.toggleTapToTranslate(e.target.checked);
            });
        }

        // WTR-LAB Settings Event Listeners
        const webServiceSelect = document.getElementById('wtr-select-service');
        if (webServiceSelect) {
            webServiceSelect.addEventListener('change', (e) => {
                reader.changeWebService(e.target.value);
            });
        }

        const targetLangSelect = document.getElementById('wtr-select-target-lang');
        if (targetLangSelect) {
            targetLangSelect.addEventListener('change', (e) => {
                reader.changeTargetLang(e.target.value);
            });
        }

        const btnTransNone = document.getElementById('btn-trans-none');
        if (btnTransNone) btnTransNone.addEventListener('click', () => reader.changeTranslationService('none'));
        const btnTransWeb = document.getElementById('btn-trans-web');
        if (btnTransWeb) btnTransWeb.addEventListener('click', () => reader.changeTranslationService('web'));
        const btnTransAI = document.getElementById('btn-trans-ai');
        if (btnTransAI) btnTransAI.addEventListener('click', () => reader.changeTranslationService('ai'));

        const btnWebThemeLight = document.getElementById('btn-webtheme-light');
        if (btnWebThemeLight) {
            btnWebThemeLight.addEventListener('click', () => {
                app.setAppTheme('light');
            });
        }
        const btnWebThemeDark = document.getElementById('btn-webtheme-dark');
        if (btnWebThemeDark) {
            btnWebThemeDark.addEventListener('click', () => {
                app.setAppTheme('dark');
            });
        }

        const btnReaderTypeSingle = document.getElementById('btn-readertype-single');
        if (btnReaderTypeSingle) btnReaderTypeSingle.addEventListener('click', () => reader.changeReaderType('single'));
        const btnReaderTypeInfinite = document.getElementById('btn-readertype-infinite');
        if (btnReaderTypeInfinite) btnReaderTypeInfinite.addEventListener('click', () => reader.changeReaderType('infinite'));
        const btnReaderTypeOld = document.getElementById('btn-readertype-old');
        if (btnReaderTypeOld) btnReaderTypeOld.addEventListener('click', () => reader.changeReaderType('old'));

        const toggleAutoUnlock = document.getElementById('toggle-auto-unlock');
        if (toggleAutoUnlock) {
            toggleAutoUnlock.addEventListener('change', (e) => {
                reader.toggleAutoUnlock(e.target.checked);
            });
        }

        // Reader theme buttons (new Aa buttons)
        document.querySelectorAll('.wtr-theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const theme = e.currentTarget.getAttribute('data-theme');
                reader.setReaderTheme(theme);
                document.querySelectorAll('.wtr-theme-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });

        // Sesli Kitap (TTS) Butonları (Ayarlar Tabı)
        document.getElementById('btn-tts-toggle').addEventListener('click', () => {
            const isSpeaking = window.speechSynthesis.speaking;
            if (isSpeaking) {
                reader.stopTTS();
            } else {
                reader.startTTS();
            }
        });
        document.getElementById('btn-tts-stop').addEventListener('click', () => {
            reader.stopTTS();
        });

        // Slider ile İlerleme Ayarı (EPUB ve PDF için)
        const progressSlider = document.getElementById('reader-progress-slider');
        if (progressSlider) {
            // Dragging: Update labels dynamically
            progressSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (reader.currentBookType === 'epub' && reader.numberedChapters && reader.numberedChapters.length > 0) {
                    const idx = Math.min(reader.numberedChapters.length - 1, Math.max(0, val - 1));
                    const chapterLabel = reader.numberedChapters[idx].label;
                    const percent = Math.round(((idx + 1) / reader.numberedChapters.length) * 100);
                    
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = `Bölüm ${idx + 1}: ${chapterLabel} (${idx + 1} / ${reader.numberedChapters.length})`;
                } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                    const percent = Math.round((val / reader.pdfTotalPages) * 100);
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = `Sayfa ${val} / ${reader.pdfTotalPages}`;
                }
            });

            // Released: Perform navigation
            progressSlider.addEventListener('change', (e) => {
                const val = parseInt(e.target.value);
                if (reader.currentBookType === 'epub' && reader.epubBook && reader.epubRendition && reader.numberedChapters && reader.numberedChapters.length > 0) {
                    const idx = Math.min(reader.numberedChapters.length - 1, Math.max(0, val - 1));
                    const href = reader.numberedChapters[idx].href;
                    if (href) reader.epubRendition.display(href);
                } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                    reader.renderPdfPage(val);
                }
            });
        }

        // ÇEVİRİ POPOVER EYLEMLERİ
        // Kapat Düğmesi
        document.getElementById('btn-close-popover').addEventListener('click', () => {
            reader.hidePopover();
        });

        // Sesli Okuma TTS
        document.getElementById('btn-speak-text').addEventListener('click', () => {
            const popover = document.getElementById('translate-popover');
            const word = popover.getAttribute('data-selected-word');
            translateService.speak(word);
        });

        // AI ile Açıklama
        document.getElementById('btn-ai-explain').addEventListener('click', () => {
            reader.explainWithAI();
        });

        // Kelimeyi Kaydetme
        document.getElementById('btn-save-word').addEventListener('click', () => {
            reader.saveSelectedWord();
        });

        // Sayfada boş bir yere tıklandığında popover ve kontrol panelini kapat
        document.addEventListener('mousedown', (e) => {
            const popover = document.getElementById('translate-popover');
            const panel = document.getElementById('reader-options-panel');
            
            // Eğer tıklanan yer popover değilse ve seçim alanı değilse kapat
            if (popover.style.display === 'flex' && 
                !popover.contains(e.target) && 
                !e.target.closest('#btn-reader-toc') &&
                !e.target.closest('.side-panel')) {
                reader.hidePopover();
            }
            
            // Eğer tıklanan yer kontrol paneli veya tetikleyicisi değilse paneli kapat
            if (panel.classList.contains('open') &&
                !panel.contains(e.target) &&
                !e.target.closest('#btn-reader-panel-trigger') &&
                !e.target.closest('#btn-reader-toc') &&
                !e.target.closest('.side-panel') &&
                !e.target.closest('.reader-header')) {
                reader.closeStylePanel();
            }
        });

        // Metin Değiştirme Butonu (Popover "Değiştir" Butonu)
        const btnReplaceText = document.getElementById('btn-replace-text');
        if (btnReplaceText) {
            btnReplaceText.addEventListener('click', () => {
                const popover = document.getElementById('translate-popover');
                const word = popover.getAttribute('data-selected-word');
                if (word) {
                    // Popover'ı gizle (seçim işaretini henüz silme)
                    popover.style.display = 'none';
                    
                    const replaceModal = document.getElementById('replace-modal-overlay');
                    if (replaceModal) {
                        replaceModal.style.display = 'flex';
                        document.getElementById('replace-original-input').value = word;
                        document.getElementById('replace-new-input').value = '';
                        document.getElementById('replace-new-input').focus();
                    }
                }
            });
        }

        // Metin Değiştirme Modalı Kapatma
        const btnCloseReplaceModal = document.getElementById('btn-close-replace-modal');
        if (btnCloseReplaceModal) {
            btnCloseReplaceModal.addEventListener('click', () => {
                const replaceModal = document.getElementById('replace-modal-overlay');
                if (replaceModal) {
                    replaceModal.style.display = 'none';
                    reader.clearHighlight(); // Seçimi kapat
                }
            });
        }
        const replaceModalOverlay = document.getElementById('replace-modal-overlay');
        if (replaceModalOverlay) {
            replaceModalOverlay.addEventListener('click', (e) => {
                if (e.target === replaceModalOverlay) {
                    replaceModalOverlay.style.display = 'none';
                    reader.clearHighlight();
                }
            });
        }

        // Metin Değiştirme Modalı Değiştir ve Kaydet
        const btnSaveReplacement = document.getElementById('btn-save-replacement');
        if (btnSaveReplacement) {
            btnSaveReplacement.addEventListener('click', async () => {
                const originalText = document.getElementById('replace-original-input').value.trim();
                const replacedText = document.getElementById('replace-new-input').value.trim();
                
                if (!originalText || !replacedText) {
                    alert("Lütfen yeni metni girin.");
                    return;
                }
                
                const success = await replacementsDb.saveReplacement(originalText, replacedText, reader.currentBookId);
                if (success) {
                    // Modalı kapat
                    const replaceModal = document.getElementById('replace-modal-overlay');
                    if (replaceModal) replaceModal.style.display = 'none';
                    reader.clearHighlight();
                    
                    // Listeyi yenile
                    await this.loadReplacements();
                    
                    // Kitap metinlerini anlık güncelle (re-run hook)
                    if (document.getElementById('view-reader').style.display === 'flex') {
                        if (reader.currentBookType === 'epub' && reader.epubRendition) {
                            const iframes = document.querySelectorAll("#epub-viewer iframe");
                            iframes.forEach(iframe => {
                                if (iframe.contentDocument) {
                                    reader.applyReplacementsToDoc(iframe.contentDocument, reader.currentBookId);
                                }
                            });
                        } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                            reader.pdfRendering = false; // reset flag
                            reader.renderPdfPage(reader.pdfCurrentPage);
                        }
                    }
                } else {
                    alert("Değişiklik kaydedilirken hata oluştu.");
                }
            });
        }

        // Google Drive Eşitleme Butonları
        const btnGDriveConnect = document.getElementById('btn-gdrive-connect');
        if (btnGDriveConnect) {
            btnGDriveConnect.addEventListener('click', () => {
                gdriveService.connect();
            });
        }

        const btnGDriveDisconnect = document.getElementById('btn-gdrive-disconnect');
        if (btnGDriveDisconnect) {
            btnGDriveDisconnect.addEventListener('click', () => {
                gdriveService.disconnect();
            });
        }

        const btnGDriveBackup = document.getElementById('btn-gdrive-backup');
        if (btnGDriveBackup) {
            btnGDriveBackup.addEventListener('click', () => {
                gdriveService.performBackup();
            });
        }

        const btnGDriveRestore = document.getElementById('btn-gdrive-restore');
        if (btnGDriveRestore) {
            btnGDriveRestore.addEventListener('click', () => {
                gdriveService.performRestore();
            });
        }

        // Google Drive Otomatik Eşitleme Switch'i
        const toggleGDriveAutoSync = document.getElementById('gdrive-auto-sync');
        if (toggleGDriveAutoSync) {
            toggleGDriveAutoSync.addEventListener('change', async (e) => {
                await settingsDb.set('gdriveAutoSync', e.target.checked);
                if (e.target.checked) {
                    gdriveService.scheduleAutoBackup();
                }
            });
        }

        // PDF Seçimi için global seçim değişikliğini dinle
        document.addEventListener('selectionchange', async () => {
            if (reader.currentBookType !== 'pdf') return;
            if (reader.isProcessingSelection) return;
            
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();

            if (selectedText.length > 0 && selectedText.length < 500) {
                // Seçim pdf-viewer içinde mi kontrol et
                const range = selection.getRangeAt(0);
                const container = range.commonAncestorContainer;
                const isInsidePdf = document.getElementById('pdf-viewer').contains(container);

                if (isInsidePdf) {
                    reader.isProcessingSelection = true;
                    try {
                        const rect = range.getBoundingClientRect();
                        // Seçimin orta üst noktası
                        const posX = rect.left + (rect.width / 2);
                        const posY = rect.top;

                        // PDF içinde satır bağlamı çıkarmayı dene (veya doğrudan metnin kendisini al)
                        const fullSentence = selectedText; 
                        
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
                                
                                const originalWord = await reader.getOriginalWordForSelection(selectedText, range);
                                
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
                        
                        reader.showPopover(finalWord, posX, posY, finalSentence, selectedText);
                    } catch (err) {
                        console.error("PDF Selection change error:", err);
                    } finally {
                        setTimeout(() => {
                            reader.isProcessingSelection = false;
                        }, 300);
                    }
                }
            }
        });

        // PDF Tek Tıklama ile Seçenekler Panelini Açma/Kapatma
        document.getElementById('pdf-viewer').addEventListener('click', (e) => {
            // Tıklanan eleman buton veya link ise menüyü tetikleme
            if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input') || e.target.closest('select')) {
                return;
            }

            // Seçili metin varsa menüyü tetikleme
            const selection = window.getSelection();
            if (selection && selection.toString().trim().length > 0) {
                return;
            }
            
            const panel = document.getElementById('reader-options-panel');
            if (panel.classList.contains('open')) {
                reader.closeStylePanel();
            } else {
                reader.openStylePanel();
            }
        });

        // Tarayıcı sekmesi kapatıldığında veya gizlendiğinde verileri Drive'a yedekle
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && typeof gdriveService !== 'undefined') {
                console.log("Browser visibility auto-sync: Tab hidden, performing backup...");
                gdriveService.performBackup(true);
            }
        });

        // Tarayıcı geri tuşu (popstate) olayını dinle
        window.addEventListener('popstate', (e) => {
            if (!navHistory.isNavigatingBack) {
                this.handleHardwareBack(true);
            }
        });
    },

    // 7. Kitap Kartı Oluşturma ve Uzun Basma Algılama (Long Press)
    createBookCard(book) {
        const card = document.createElement('div');
        card.className = 'book-card glass';
        
        let coverHtml = '';
        if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
            coverHtml = `<img src="${book.coverUrl}" alt="${book.title}" class="book-cover" loading="lazy">`;
        } else {
            const placeholder = utils.generateGradientPlaceholder(book.title, book.author);
            coverHtml = `<img src="${placeholder}" alt="${book.title}" class="book-cover" loading="lazy">`;
        }

        card.innerHTML = `
            <button class="btn-delete-book" title="Kitabı Sil">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
            <div class="book-cover-container">
                ${coverHtml}
                <span class="book-badge badge-${book.type}">${book.type}</span>
            </div>
            <div class="book-info">
                <h4 class="book-title" title="${book.title}">${book.title}</h4>
                <span class="book-author">${book.author}</span>
            </div>
            <div class="book-progress">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${book.progressPercent}%"></div>
                </div>
                <span class="progress-text">%${book.progressPercent} tamamlandı</span>
            </div>
        `;

        card.onclick = (e) => {
            if (this.isLibraryDeleteMode) {
                if (confirm(`"${book.title}" kitabını silmek istiyor musunuz?`)) {
                    this.deleteBook(book.id, book.title, true);
                }
                return;
            }
            reader.openBook(book.id);
        };

        return card;
    },

    // 8. Kelime/Cümle Değişiklikleri Yönetimi (Dinamik UI Yükleme)
    async loadReplacements() {
        const listContainer = document.getElementById('replacements-list');
        if (!listContainer) return;
        
        listContainer.innerHTML = '';
        
        if (typeof replacementsDb === 'undefined') return;
        const list = await replacementsDb.getAllReplacements();
        
        if (list.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state" style="display: flex;">
                    <i data-lucide="edit-3" class="empty-icon"></i>
                    <p>Henüz değiştirilen kelime veya cümle bulunmuyor.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        for (const item of list) {
            let bookTitle = "Tüm Kitaplar (Global)";
            if (item.bookId) {
                const book = await booksDb.getBook(item.bookId);
                if (book) bookTitle = book.title;
            }

            const card = document.createElement('div');
            card.className = 'word-card glass';
            card.innerHTML = `
                <div class="word-header" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span class="word-text" style="font-weight: 600; text-decoration: line-through; color: var(--text-muted);">${item.originalText}</span>
                    <i data-lucide="arrow-right" style="width: 14px; height: 14px; color: var(--color-accent);"></i>
                    <span class="word-meaning" style="color: var(--color-accent); font-weight: 600;">${item.replacedText}</span>
                </div>
                <div class="word-body" style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                    <span><i data-lucide="book" style="width: 11px; height: 11px; vertical-align: middle; margin-right: 4px;"></i>${bookTitle}</span>
                    <button class="btn-delete-word" title="Değişikliği Sil" onclick="event.stopPropagation(); app.deleteReplacement('${item.id}')" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; transition: color 0.2s;">
                        <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
                    </button>
                </div>
            `;
            listContainer.appendChild(card);
        }
        lucide.createIcons();
    },

    async deleteReplacement(id) {
        if (confirm("Bu kelime/cümle değişikliğini silmek istediğinize emin misiniz? Kitaptaki metinler orijinal haline dönecektir.")) {
            const success = await replacementsDb.deleteReplacement(id);
            if (success) {
                await this.loadReplacements();
                
                // Kitap açıksa içeriği anlık olarak yeniden yükle
                if (document.getElementById('view-reader').style.display === 'flex') {
                    if (reader.currentBookType === 'epub' && reader.epubRendition && reader.epubLocation) {
                        reader.epubRendition.display(reader.epubLocation);
                    } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                        reader.pdfRendering = false; // reset flag
                        reader.renderPdfPage(reader.pdfCurrentPage);
                    }
                }
            } else {
                alert("Değişiklik silinirken bir hata oluştu.");
            }
        }
    },

    // 9. Donanımsal Geri Tuşu Mantığı
    handleHardwareBack(isPopState = false) {
        // A. Açık modalları ve popoverları kapat
        const popover = document.getElementById('translate-popover');
        if (popover && popover.style.display === 'flex') {
            reader.hidePopover();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const replaceModal = document.getElementById('replace-modal-overlay');
        if (replaceModal && replaceModal.style.display === 'flex') {
            replaceModal.style.display = 'none';
            reader.clearHighlight();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const addWordModal = document.getElementById('add-word-modal');
        if (addWordModal && addWordModal.style.display === 'flex') {
            addWordModal.style.display = 'none';
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const tocPanel = document.getElementById('toc-panel');
        if (tocPanel && tocPanel.classList.contains('open')) {
            reader.closeTOCPanel();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const optionsPanel = document.getElementById('reader-options-panel');
        if (optionsPanel && optionsPanel.classList.contains('open')) {
            reader.closeStylePanel();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        // B. Standart stack navigasyonunu işlet
        const popped = navHistory.pop();
        if (popped) {
            const prev = popped.previous;
            navHistory.isNavigatingBack = true;
            
            // Eğer tetikleyici popstate değilse, tarayıcı geçmişini 1 adım geri çek
            if (!isPopState) {
                window.history.back();
            }

            if (prev.type === 'view') {
                this.switchView(prev.value);
                navHistory.isNavigatingBack = false;
            } else if (prev.type === 'book') {
                reader.closeReader();
                navHistory.isNavigatingBack = false;
            } else if (prev.type === 'chapter') {
                if (reader.epubRendition) {
                    reader.epubRendition.display(prev.value).then(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else {
                    navHistory.isNavigatingBack = false;
                }
            } else if (prev.type === 'page') {
                if (reader.pdfDocument) {
                    reader.renderPdfPage(prev.value).then(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else {
                    navHistory.isNavigatingBack = false;
                }
            }
        } else {
            // Stack bitti. Uygulamadan çık
            if (window.Capacitor && window.Capacitor.Plugins.App) {
                window.Capacitor.Plugins.App.exitApp();
            }
        }
    }
};

// Sayfa Yüklendiğinde Uygulamayı Başlat
window.addEventListener('DOMContentLoaded', () => {
    app.init();
});
