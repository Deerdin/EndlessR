// ================= ANA UYGULAMA KONTROLCÜSÜ (js/app.js) =================

// Donanımsal veya Uygulama İçi Sayfa Geri Geçmişi Takipçisi
const navHistory = {
    stack: [],
    isNavigatingBack: false,
    ignorePopStateCount: 0,
    storageKey: 'endlessr_nav_stack',

    saveToSession() {
        try {
            sessionStorage.setItem(this.storageKey, JSON.stringify(this.stack));
        } catch (e) {
            console.warn("NavHistory session save error:", e);
        }
    },

    initFromSession() {
        try {
            const raw = sessionStorage.getItem(this.storageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    this.stack = parsed;
                    if (typeof window !== 'undefined' && window.history) {
                        const currentHistIdx = (window.history.state && typeof window.history.state.stackIndex === 'number')
                            ? window.history.state.stackIndex
                            : -1;
                        if (currentHistIdx < this.stack.length - 1) {
                            window.history.replaceState({ stackIndex: 0 }, "");
                            for (let i = 1; i < this.stack.length; i++) {
                                window.history.pushState({ stackIndex: i }, "");
                            }
                        } else {
                            window.history.replaceState({ stackIndex: this.stack.length - 1 }, "");
                        }
                    }
                    return true;
                }
            }
        } catch (e) {
            console.warn("NavHistory session restore error:", e);
        }
        return false;
    },

    isSameAction(a, b) {
        if (!a || !b || a.type !== b.type) return false;
        if (a.type === 'view') {
            const viewA = a.viewId || a.value;
            const viewB = b.viewId || b.value;
            return viewA === viewB && (a.segmentId || 'segment-books') === (b.segmentId || 'segment-books');
        }
        if (a.type === 'reader') {
            if (a.bookId !== b.bookId || a.bookType !== b.bookType) return false;
            if (a.bookType === 'epub' && a.spineIndex !== undefined && b.spineIndex !== undefined) {
                if (typeof reader !== 'undefined' && reader.settings && reader.settings.readerType === 'old') {
                    return a.location === b.location;
                }
                return a.spineIndex === b.spineIndex;
            }
            return a.location === b.location;
        }
        return a.value === b.value;
    },
    
    push(action) {
        const isFirst = this.stack.length === 0;
        if (!isFirst) {
            const last = this.stack[this.stack.length - 1];
            if (this.isSameAction(last, action)) {
                if (action.type === 'reader' && action.location !== undefined) {
                    last.location = action.location;
                    if (action.spineIndex !== undefined) last.spineIndex = action.spineIndex;
                    this.saveToSession();
                }
                return; // Yinelenen kaydı önle
            }
        }
        this.stack.push(action);
        this.saveToSession();

        // Tarayıcı geçmişine de kaydet (popstate tetiklenmesi için)
        if (typeof window !== 'undefined' && window.history) {
            if (isFirst) {
                window.history.replaceState({ stackIndex: this.stack.length - 1 }, "");
            } else {
                window.history.pushState({ stackIndex: this.stack.length - 1 }, "");
            }
        }
    },

    updateTopReaderLocation(location, spineIndex) {
        if (this.stack.length === 0) return;
        const top = this.stack[this.stack.length - 1];
        if (top && top.type === 'reader') {
            if (location !== undefined && location !== null) top.location = location;
            if (spineIndex !== undefined && spineIndex !== null) top.spineIndex = spineIndex;
            this.saveToSession();
        }
    },
    
    pop() {
        if (this.stack.length > 1) {
            const current = this.stack.pop();
            const previous = this.stack[this.stack.length - 1];
            this.saveToSession();
            return { current, previous };
        }
        return null;
    },
    
    clear() {
        this.stack = [];
        this.saveToSession();
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
        
        // Capacitor Back Button Dinleyicisi
        if (window.Capacitor && typeof window.Capacitor.Plugins !== 'undefined') {
            const { App } = window.Capacitor.Plugins;
            if (App) {
                App.addListener('backButton', () => {
                    this.handleHardwareBack(false);
                });
            }
        }

        // 3. Olay Dinleyicilerini Kur
        this.setupEventListeners();

        // 4. Oturum / Sayfa Yenileme Durumunu Öncelikli Olarak Geri Yükle (Kitap açıksa anında aç)
        const hasRestoredSession = navHistory.initFromSession();
        if (!hasRestoredSession) {
            navHistory.push({ type: 'view', viewId: 'view-home', segmentId: 'segment-books' });
        } else {
            const topEntry = navHistory.stack[navHistory.stack.length - 1];
            const lastViewEntry = [...navHistory.stack].reverse().find(item => item.type === 'view') || {
                type: 'view',
                viewId: 'view-home',
                segmentId: 'segment-books'
            };

            navHistory.isNavigatingBack = true;
            this.switchView(lastViewEntry.viewId || lastViewEntry.value || 'view-home', lastViewEntry.segmentId || 'segment-books');
            navHistory.isNavigatingBack = false;

            if (topEntry && topEntry.type === 'reader' && topEntry.bookId) {
                await reader.openBook(topEntry.bookId, {
                    isRestore: true,
                    restoreLocation: topEntry.location
                });
            }
        }

        // 5. Arka Plan Ekranlarını Yükle
        await this.loadLibrary();
        await this.loadWords();
        await this.loadReplacements();
    },

    getActiveProfileSegment() {
        const activeBtn = document.querySelector('.segment-btn.active');
        return activeBtn ? activeBtn.getAttribute('data-segment') : 'segment-books';
    },

    activateProfileSegment(segmentId) {
        if (!segmentId) return;
        document.querySelectorAll('.segment-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-segment') === segmentId);
        });
        document.querySelectorAll('.segment-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === segmentId);
        });
    },

    // 1. Ekran Geçişlerini Yönet
    switchView(viewId, segmentId = null) {
        const targetView = document.getElementById(viewId);
        if (!targetView) return;

        // Tüm görünümleri pasif yap
        document.querySelectorAll('.app-view').forEach(view => {
            view.classList.remove('active');
        });
        // İlgili görünümü aktif yap
        targetView.classList.add('active');

        // Navigasyon barı düğmelerini güncelle
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-view') === viewId) {
                btn.classList.add('active');
            }
        });

        const currentSegment = segmentId || this.getActiveProfileSegment();
        if (viewId === 'view-profile' && segmentId) {
            this.activateProfileSegment(segmentId);
        }

        // Geçmişe kaydet (eğer geri gidilmiyorsa)
        if (!navHistory.isNavigatingBack) {
            navHistory.push({ type: 'view', viewId: viewId, segmentId: currentSegment });
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
        } else {
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
            });
        }

        // Profil -> Kitaplık sekmesine yalnızca favoriye eklenen kitapları ekle
        if (profileBookGrid) {
            const favoriteBooks = books.filter(b => b.isFavorite === true);
            if (favoriteBooks.length === 0) {
                profileBookGrid.innerHTML = `
                    <div class="empty-state" style="display: flex; grid-column: 1 / -1; padding: 30px 10px;">
                        <i data-lucide="star" class="empty-icon" style="width: 48px; height: 48px;"></i>
                        <p>Favori kitaplığınız henüz boş. Ana sayfadaki kitapların sağ üst köşesindeki yıldız ikonuna dokunarak buraya ekleyebilirsiniz.</p>
                    </div>
                `;
            } else {
                favoriteBooks.forEach(book => {
                    const profileCard = this.createBookCard(book);
                    profileBookGrid.appendChild(profileCard);
                });
            }
        }

        // Yeni eklenen ikonları çizdir
        lucide.createIcons();
    },

    // Kitap Silme İşlemi
    async deleteBook(id, title, force = false) {
        if (force || confirm(`"${title}" kitabını silmek istediğinize emin misiniz?`)) {
            const success = await booksDb.deleteBook(id);
            if (success) {
                // Kitap detay paneli açıksa kapat
                const panel = document.getElementById('book-details-panel');
                if (panel) panel.classList.remove('open');
                
                await this.loadLibrary();
            } else {
                alert("Kitap silinemedi.");
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

    // Uygulama Genel Temasını Değiştir (Kitap içi temadan bağımsız)
    async setAppTheme(themeName) {
        const isReaderActive = document.body.classList.contains('reader-active');
        document.body.className = '';
        document.body.classList.add(`theme-${themeName}`);
        if (isReaderActive) {
            document.body.classList.add('reader-active');
        }
        
        await settingsDb.set('appTheme', themeName);

        // Ana sayfadaki Ay / Güneş tema butonunun ikonunu güncelle
        const btnHomeTheme = document.getElementById('btn-home-theme-toggle');
        if (btnHomeTheme) {
            const iconName = themeName === 'dark' ? 'sun' : 'moon';
            btnHomeTheme.innerHTML = `<i data-lucide="${iconName}" style="width: 18px; height: 18px;"></i>`;
            btnHomeTheme.title = themeName === 'dark' ? 'Aydınlık Temaya Geç' : 'Karanlık Temaya Geç';
            if (typeof lucide !== 'undefined') {
                lucide.createIcons({ node: btnHomeTheme });
            }
        }

        // Ayarlar ekranındaki butonların aktifliğini güncelle
        const themeButtons = document.querySelectorAll('#view-settings .theme-btn');
        themeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(themeName)) {
                btn.classList.add('active');
            }
        });
    },

    async toggleAppTheme() {
        const currentTheme = await settingsDb.get('appTheme', 'dark');
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        await this.setAppTheme(nextTheme);
    },

    // 5. Dosya Yükleme ve İşleme Mekanizması
    async handleFileUpload(file) {
        if (!file) return;

        // Dosya türü kontrolü
        const fileExt = file.name.split('.').pop().toLowerCase();
        if (fileExt !== 'epub' && fileExt !== 'pdf') {
            alert("Sadece .epub veya .pdf dosyaları yüklenebilir.");
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
                alert("Kitap yüklendi.");
                await this.loadLibrary();
            };

            reader.onerror = () => {
                throw new Error("Dosya okunurken bir hata oluştu.");
            };

            reader.readAsArrayBuffer(file);

        } catch (err) {
            console.error("Yükleme Hatası:", err);
            alert("Dosya yüklenemedi.");
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
        // Pull-to-refresh dynamic indicator setup
        const pullIndicator = document.createElement('div');
        pullIndicator.id = 'pull-to-refresh-indicator';
        pullIndicator.style.cssText = `
            position: absolute;
            top: -60px;
            left: 50%;
            transform: translate(-50%, 0) scale(0.5);
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            z-index: 9999;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
        `;
        pullIndicator.innerHTML = '<i data-lucide="refresh-cw" style="width: 18px; height: 18px; color: var(--accent-color);"></i>';
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.appendChild(pullIndicator);
            if (typeof lucide !== 'undefined') lucide.createIcons({node: pullIndicator});
        }

        let startY = 0;
        let currentY = 0;
        let isPulling = false;
        let activeScrollEl = null;

        if (appContainer) {
            appContainer.addEventListener('touchstart', (e) => {
                // If reader is open, skip pull-to-refresh
                const readerView = document.getElementById('view-reader');
                if (readerView && (readerView.style.display === 'flex' || readerView.classList.contains('active'))) {
                    return;
                }

                const activeView = document.querySelector('.app-view.active');
                if (!activeView) return;
                
                // Only allow pull-to-refresh if the active view is scrolled to the top
                if (activeView.scrollTop === 0) {
                    startY = e.touches[0].clientY;
                    currentY = startY;
                    isPulling = true;
                    activeScrollEl = activeView;
                    pullIndicator.style.transition = 'none';
                }
            }, { passive: true });

            appContainer.addEventListener('touchmove', (e) => {
                if (!isPulling || !activeScrollEl) return;
                
                currentY = e.touches[0].clientY;
                const diff = currentY - startY;
                
                // Only pull down
                if (diff > 0) {
                    const pullDistance = Math.min(100, diff * 0.4);
                    
                    pullIndicator.style.opacity = Math.min(1, pullDistance / 60);
                    pullIndicator.style.transform = `translate(-50%, ${pullDistance}px) scale(${Math.min(1, pullDistance / 40)})`;
                    
                    const icon = pullIndicator.querySelector('i');
                    if (icon) {
                        icon.style.transform = `rotate(${pullDistance * 4}deg)`;
                    }

                    if (pullDistance >= 60) {
                        pullIndicator.style.borderColor = 'var(--accent-color)';
                    } else {
                        pullIndicator.style.borderColor = 'var(--border-color)';
                    }
                }
            }, { passive: true });

            appContainer.addEventListener('touchend', (e) => {
                if (!isPulling) return;
                isPulling = false;
                
                const diff = currentY - startY;
                const pullDistance = Math.min(100, diff * 0.4);
                
                pullIndicator.style.transition = 'opacity 0.25s ease, transform 0.25s ease, border-color 0.25s ease';
                
                if (diff > 0 && pullDistance >= 60) {
                    // Trigger refresh
                    pullIndicator.style.transform = `translate(-50%, 40px) scale(1.1)`;
                    const icon = pullIndicator.querySelector('i');
                    if (icon) icon.classList.add('spin-icon');
                    
                    setTimeout(() => {
                        window.location.reload();
                    }, 400);
                } else {
                    // Reset
                    pullIndicator.style.opacity = '0';
                    pullIndicator.style.transform = 'translate(-50%, 0) scale(0.5)';
                    activeScrollEl = null;
                }
            });
        }

        // Alt Navigasyon Bar Tıklamaları
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const viewId = e.currentTarget.getAttribute('data-view');
                this.switchView(viewId);
            });
        });

        // Ana Sayfa Tema Değiştirme Butonu Tıklaması (Ay / Güneş)
        const btnHomeTheme = document.getElementById('btn-home-theme-toggle');
        if (btnHomeTheme) {
            btnHomeTheme.addEventListener('click', () => {
                this.toggleAppTheme();
            });
        }

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
                this.activateProfileSegment(segmentId);
                if (!navHistory.isNavigatingBack) {
                    navHistory.push({ type: 'view', viewId: 'view-profile', segmentId: segmentId });
                }
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
                    alert("Lütfen alanları doldurun.");
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
                    alert("Kelime kaydedilemedi.");
                }
            });
        }

        // Kelime Arama Çubuğu
        const searchInput = document.getElementById('search-words');
        searchInput.addEventListener('input', (e) => {
            this.loadWords(e.target.value);
        });

        // OKUYUCU EYLEMLERİ
        // Sol Üst Geri Oku Butonu (Doğrudan Ana Sayfaya Gönderir)
        document.getElementById('btn-reader-back').addEventListener('click', () => {
            reader.closeReader();
            this.switchView('view-home');
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
                        alert("Kitap silinemedi.");
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

        // Manuel Boşluk Düzeltme Butonu (Görünüm Tabı)
        const btnFixSpacing = document.getElementById('btn-fix-spacing');
        if (btnFixSpacing) {
            btnFixSpacing.addEventListener('click', () => {
                reader.toggleFixSpacing();
            });
        }

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

        const btnWebThemeLight = document.getElementById('btn-webtheme-light');
        if (btnWebThemeLight) {
            btnWebThemeLight.addEventListener('click', () => {
                reader.setReaderColorMode('light');
            });
        }
        const btnWebThemeDark = document.getElementById('btn-webtheme-dark');
        if (btnWebThemeDark) {
            btnWebThemeDark.addEventListener('click', () => {
                reader.setReaderColorMode('dark');
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

        // Sesli Kitap (TTS) Butonları (Ses Tabı)
        document.getElementById('btn-tts-toggle').addEventListener('click', () => {
            if (reader.isSpeakingTTS || (window.speechSynthesis && window.speechSynthesis.speaking)) {
                reader.stopTTS();
            } else {
                reader.startTTS();
            }
        });
        document.getElementById('btn-tts-stop').addEventListener('click', () => {
            reader.stopTTS();
        });

        const ttsSpeedSelect = document.getElementById('tts-speed-select');
        if (ttsSpeedSelect) {
            ttsSpeedSelect.addEventListener('change', () => {
                if (reader.isSpeakingTTS) {
                    reader.restartTTSFromCurrentChunk();
                }
            });
        }

        const ttsVoiceSelect = document.getElementById('tts-voice-select');
        if (ttsVoiceSelect) {
            ttsVoiceSelect.addEventListener('change', () => {
                if (reader.isSpeakingTTS) {
                    reader.restartTTSFromCurrentChunk();
                }
            });
        }

        // Slider ile İlerleme Ayarı (EPUB ve PDF için)
        const progressSlider = document.getElementById('reader-progress-slider');
        if (progressSlider) {
            // Dragging: Update labels dynamically
            progressSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (reader.currentBookType === 'epub') {
                    const hasToc = reader.numberedChapters && reader.numberedChapters.length > 0;
                    const total = hasToc ? reader.numberedChapters.length : (reader.epubBook && reader.epubBook.spine ? reader.epubBook.spine.length : 1);
                    const idx = Math.min(total - 1, Math.max(0, val - 1));
                    const chapterLabel = hasToc ? reader.numberedChapters[idx].label : `Bölüm ${idx + 1}`;
                    const percent = Math.round(((idx + 1) / total) * 100);
                    
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = hasToc
                        ? `Bölüm ${idx + 1}: ${chapterLabel} (${idx + 1} / ${total})`
                        : `Bölüm ${idx + 1} / ${total}`;
                    const chIndicator = document.getElementById('panel-chapter-indicator');
                    if (chIndicator) {
                        chIndicator.textContent = `Bölüm ${idx + 1} / ${total} (${percent}%)`;
                    }
                } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                    const percent = Math.round((val / reader.pdfTotalPages) * 100);
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = `Sayfa ${val} / ${reader.pdfTotalPages}`;
                    const chIndicator = document.getElementById('panel-chapter-indicator');
                    if (chIndicator) {
                        chIndicator.textContent = `Sayfa ${val} / ${reader.pdfTotalPages} (${percent}%)`;
                    }
                }
            });

            // Released: Perform navigation
            progressSlider.addEventListener('change', (e) => {
                const val = parseInt(e.target.value);
                if (reader.currentBookType === 'epub' && reader.epubBook && reader.epubRendition) {
                    const hasToc = reader.numberedChapters && reader.numberedChapters.length > 0;
                    if (hasToc) {
                        const idx = Math.min(reader.numberedChapters.length - 1, Math.max(0, val - 1));
                        const href = reader.numberedChapters[idx].href;
                        if (href) reader.epubRendition.display(href);
                    } else if (reader.epubBook.spine) {
                        const total = reader.epubBook.spine.length;
                        const idx = Math.min(total - 1, Math.max(0, val - 1));
                        const spineItem = reader.epubBook.spine.get(idx);
                        if (spineItem && spineItem.href) {
                            reader.epubRendition.display(spineItem.href);
                        }
                    }
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
                    alert("Lütfen alanı doldurun.");
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
                    alert("Değişiklik kaydedilemedi.");
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

            // Çeviri popover'ı veya İçindekiler (TOC) paneli açıksa önce onları kapat
            const popover = document.getElementById('translate-popover');
            if (popover && popover.style.display === 'flex') {
                reader.hidePopover();
                return;
            }
            const tocPanel = document.getElementById('toc-panel');
            if (tocPanel && tocPanel.classList.contains('open')) {
                reader.closeTOCPanel();
                return;
            }
            
            const panel = document.getElementById('reader-options-panel');
            if (panel.classList.contains('open')) {
                reader.closeStylePanel();
            } else {
                reader.openStylePanel();
            }
        });

        // Tarayıcı geri tuşu (popstate) olayını dinle
        window.addEventListener('popstate', (e) => {
            if (navHistory.ignorePopStateCount > 0) {
                navHistory.ignorePopStateCount--;
                return;
            }
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

        const isFav = !!book.isFavorite;

        card.innerHTML = `
            <button class="btn-delete-book" title="Kitabı Sil">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn-favorite-book" title="Favorilere Ekle/Çıkar" style="position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 3; color: ${isFav ? '#f59e0b' : '#d1d5db'}; padding: 0;">
                <i data-lucide="star" style="width: 14px; height: 14px; ${isFav ? 'fill: #f59e0b;' : ''}"></i>
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

        const btnDelete = card.querySelector('.btn-delete-book');
        if (btnDelete) {
            btnDelete.onclick = (e) => {
                e.stopPropagation();
                this.deleteBook(book.id, book.title);
            };
        }

        const btnFav = card.querySelector('.btn-favorite-book');
        if (btnFav) {
            btnFav.onclick = async (e) => {
                e.stopPropagation(); // Kitap okuyucuyu açmasını engelle
                book.isFavorite = !book.isFavorite;
                
                // IndexedDB veritabanında güncelle (dosyasıyla birlikte)
                const fullBook = await db.books.getItem(book.id);
                if (fullBook) {
                    fullBook.isFavorite = book.isFavorite;
                    await db.books.setItem(book.id, fullBook);
                }
                
                // Arayüzü güncelle
                await this.loadLibrary();
            };
        }

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
                alert("Değişiklik silinemedi.");
            }
        }
    },

    // 9. Donanımsal ve Uygulama İçi Geri Tuşu Mantığı
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
            
            // Eğer tetikleyici popstate değilse, tarayıcı geçmişini 1 adım geri çek (çift tetiklemeyi önleyerek)
            if (!isPopState) {
                navHistory.ignorePopStateCount++;
                window.history.back();
                setTimeout(() => {
                    if (navHistory.ignorePopStateCount > 0) {
                        navHistory.ignorePopStateCount = 0;
                    }
                }, 250);
            }

            if (prev.type === 'view') {
                if (document.getElementById('view-reader').style.display === 'flex' || document.body.classList.contains('reader-active')) {
                    reader.closeReader(true);
                }
                this.switchView(prev.viewId || prev.value || 'view-home', prev.segmentId || 'segment-books');
                setTimeout(() => {
                    navHistory.isNavigatingBack = false;
                }, 100);
            } else if (prev.type === 'reader') {
                const isReaderOpen = document.getElementById('view-reader').style.display === 'flex' && reader.currentBookId === prev.bookId;
                if (!isReaderOpen) {
                    reader.openBook(prev.bookId, {
                        isRestore: true,
                        restoreLocation: prev.location
                    }).finally(() => {
                        setTimeout(() => {
                            navHistory.isNavigatingBack = false;
                        }, 150);
                    });
                } else if (prev.bookType === 'epub' && reader.epubRendition) {
                    if (prev.spineIndex !== undefined) reader.lastSpineIndex = prev.spineIndex;
                    if (prev.location !== undefined) reader.lastEpubCfi = prev.location;
                    reader.epubRendition.display(prev.location).then(() => {
                        window.scrollTo(0, 0);
                        setTimeout(() => {
                            navHistory.isNavigatingBack = false;
                        }, 150);
                    }).catch(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else if (prev.bookType === 'pdf' && reader.pdfDocument) {
                    reader.lastPdfPage = prev.location;
                    reader.pdfRendering = false;
                    reader.renderPdfPage(prev.location).then(() => {
                        window.scrollTo(0, 0);
                        setTimeout(() => {
                            navHistory.isNavigatingBack = false;
                        }, 150);
                    }).catch(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else {
                    navHistory.isNavigatingBack = false;
                }
            } else if (prev.type === 'book') {
                reader.closeReader(true);
                navHistory.isNavigatingBack = false;
            } else if (prev.type === 'chapter') {
                if (reader.epubRendition) {
                    reader.epubRendition.display(prev.value).then(() => {
                        window.scrollTo(0, 0);
                        setTimeout(() => {
                            navHistory.isNavigatingBack = false;
                        }, 150);
                    }).catch(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else {
                    navHistory.isNavigatingBack = false;
                }
            } else if (prev.type === 'page') {
                if (reader.pdfDocument) {
                    reader.pdfRendering = false;
                    reader.renderPdfPage(prev.value).then(() => {
                        window.scrollTo(0, 0);
                        setTimeout(() => {
                            navHistory.isNavigatingBack = false;
                        }, 150);
                    }).catch(() => {
                        navHistory.isNavigatingBack = false;
                    });
                } else {
                    navHistory.isNavigatingBack = false;
                }
            } else {
                navHistory.isNavigatingBack = false;
            }
        } else {
            // Stack'te tek eleman kaldıysa ve okuyucu açıksa ana ekrana dön
            if (document.getElementById('view-reader').style.display === 'flex' || document.body.classList.contains('reader-active')) {
                reader.closeReader(true);
                navHistory.isNavigatingBack = true;
                this.switchView('view-home', 'segment-books');
                navHistory.isNavigatingBack = false;
                return;
            }
            // Stack bitti. Uygulamadan çık
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
                window.Capacitor.Plugins.App.exitApp();
            }
        }
    }
};

window.app = app;

// Sayfa Yüklendiğinde Uygulamayı Başlat
window.addEventListener('DOMContentLoaded', () => {
    app.init();
});
