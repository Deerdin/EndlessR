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
    allLoadedBooks: [],
    customFolders: [],
    currentFolderGroups: new Map(),
    activeFolderKey: null,
    managingFolderKey: null,
    editingState: null, // { mode: 'book', book, targetFolderId }

    // Uygulama Başlangıcı
    async init() {
        console.log("EndlessR Kitap Okuma Uygulaması Başlatıldı.");

        if (typeof window !== 'undefined' && window.history && 'scrollRestoration' in window.history) {
            window.history.scrollRestoration = 'manual';
        }

        // 1. Service Worker Kaydı (Çevrimdışı PWA Desteği)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker Kaydedildi. Kapsam:', reg.scope))
                .catch(err => console.warn('Service Worker Kayıt Hatası:', err));
        }

        // Lucide İkonlarını Çiz
        lucide.createIcons();

        // 2. Temel Uygulama Ayarlarını Yükle
        let savedAppTheme = null;
        try { savedAppTheme = localStorage.getItem('endlessr_app_theme'); } catch (e) {}
        if (!savedAppTheme) {
            savedAppTheme = await settingsDb.get('appTheme', 'dark');
        }
        await this.setAppTheme(savedAppTheme, true);
        
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
        await this.updateDatabaseStatsUI();
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
        if (viewId === 'view-settings') {
            this.updateDatabaseStatsUI();
        }

        // Geçmişe kaydet (eğer geri gidilmiyorsa)
        if (!navHistory.isNavigatingBack) {
            navHistory.push({ type: 'view', viewId: viewId, segmentId: currentSegment });
        }

        // Çeviri Popover'ını gizle
        reader.hidePopover();
    },

    // Kitap Başlığı ve Yazarından Seri / Cilt Bilgisi Çözümleme Yardımcıları
    normalizeTextKey(str) {
        return (str || '')
            .trim()
            .toLocaleLowerCase('tr-TR')
            .replace(/\s+/g, ' ');
    },

    extractVolumeAndBaseTitle(book) {
        const rawTitle = (book.title || 'İsimsiz Kitap').trim();
        let explicitBaseTitle = rawTitle;
        let numericBaseTitle = rawTitle;
        let detectedVolNum = null;

        // 1. Açık cilt ifadeleri: "Cilt 1", "Vol. 2", "Volume 3", "Kitap 4", "Book 5", "(Cilt 1)", "[Vol 2]" vb.
        const explicitPatterns = [
            /^(.*?)\s*[-–—:|•,]\s*(?:cilt|volume|vol\.?|book|kitap|part|pt\.?|tome|sayı)\s*#?0*(\d+(?:[.,]\d+)?)\b.*$/i,
            /^(.*?)\s+(?:cilt|volume|vol\.?|book|kitap|part|pt\.?|tome|sayı)\s*#?0*(\d+(?:[.,]\d+)?)\b.*$/i,
            /^(.*?)\s*\(\s*(?:cilt|volume|vol\.?|book|kitap)?\s*#?0*(\d+(?:[.,]\d+)?)\s*\)\s*$/i,
            /^(.*?)\s*\[\s*(?:cilt|volume|vol\.?|book|kitap)?\s*#?0*(\d+(?:[.,]\d+)?)\s*\]\s*$/i,
            /^(.*?)\s*[-–—:|]\s*#?0*(\d{1,3})\s*$/i
        ];

        for (const regex of explicitPatterns) {
            const match = rawTitle.match(regex);
            if (match && match[1] && match[1].trim().length >= 2) {
                explicitBaseTitle = match[1].trim().replace(/[-–—:|•,\s]+$/, '');
                detectedVolNum = parseFloat(match[2].replace(',', '.'));
                numericBaseTitle = explicitBaseTitle;
                break;
            }
        }

        // 2. Sonda sadece sayı varsa ("Overlord 1", "Overlord #2")
        if (detectedVolNum === null) {
            const numMatch = rawTitle.match(/^(.*?)\s+#?0*(\d{1,3})\s*$/);
            if (numMatch && numMatch[1] && numMatch[1].trim().length >= 2) {
                numericBaseTitle = numMatch[1].trim().replace(/[-–—:|•,\s]+$/, '');
                detectedVolNum = parseFloat(numMatch[2]);
            }
        }

        // 3. Kullanıcının girdiği volumeLabel veya orijinal dosya adından cilt numarası yakalama
        let customVolNum = null;
        if (book.volumeLabel && book.volumeLabel.trim()) {
            const lblMatch = book.volumeLabel.match(/(\d+(?:[.,]\d+)?)/);
            if (lblMatch) customVolNum = parseFloat(lblMatch[1].replace(',', '.'));
        }
        if (customVolNum === null && detectedVolNum === null && book.originalFileName) {
            const fnMatch = book.originalFileName.match(/(?:cilt|volume|vol\.?|book|kitap|#|\b)\s*0*(\d{1,3})\b/i);
            if (fnMatch) detectedVolNum = parseFloat(fnMatch[1]);
        }

        return {
            rawTitle,
            explicitBaseTitle: explicitBaseTitle || rawTitle,
            numericBaseTitle: numericBaseTitle || rawTitle,
            volumeNumber: customVolNum !== null ? customVolNum : detectedVolNum
        };
    },

    sortAndDecorateFolderEntries(entries) {
        entries.sort((a, b) => {
            const vA = a.info.volumeNumber;
            const vB = b.info.volumeNumber;
            if (vA !== null && vB !== null && vA !== vB) {
                return vA - vB;
            }
            if (vA !== null && vB === null) return -1;
            if (vA === null && vB !== null) return 1;
            return (a.book.addedAt || 0) - (b.book.addedAt || 0);
        });

        return entries.map((entry, idx) => {
            const b = entry.book;
            let badgeText = '';
            if (b.volumeLabel && b.volumeLabel.trim()) {
                const rawLbl = b.volumeLabel.trim();
                badgeText = /^\d+$/.test(rawLbl) ? `Vol. ${rawLbl}` : rawLbl;
            } else if (entry.info.volumeNumber !== null) {
                badgeText = `Vol. ${entry.info.volumeNumber}`;
            } else {
                badgeText = `Vol. ${idx + 1}`;
            }
            return {
                ...b,
                _computedVolumeBadge: badgeText
            };
        });
    },

    groupBooksIntoLibraryItems(books, customFolders = []) {
        this.currentFolderGroups.clear();

        const analyzed = (books || []).map(book => {
            const info = this.extractVolumeAndBaseTitle(book);
            const normAuthor = this.normalizeTextKey(book.author || 'Unknown Author');
            const normExplicit = this.normalizeTextKey(info.explicitBaseTitle);
            const normNumeric = this.normalizeTextKey(info.numericBaseTitle);
            return {
                book,
                info,
                normAuthor,
                normExplicit,
                normNumeric
            };
        });

        // 1. Manuel oluşturulan klasörleri hazırla
        const customMap = new Map();
        for (const cf of customFolders) {
            if (!cf || !cf.id) continue;
            customMap.set(cf.id, {
                key: cf.id,
                isCustom: true,
                customFolderId: cf.id,
                title: (cf.title || 'Untitled Folder').trim(),
                author: (cf.author || 'Folder').trim(),
                coverUrl: cf.coverUrl || null,
                inBookshelf: !!cf.inBookshelf,
                entries: [],
                latestAddedAt: cf.createdAt || Date.now()
            });
        }

        const remainingAnalyzed = [];
        for (const item of analyzed) {
            const fId = item.book.folderId;
            if (fId && customMap.has(fId)) {
                const cGrp = customMap.get(fId);
                cGrp.entries.push(item);
                if ((item.book.addedAt || 0) > cGrp.latestAddedAt) {
                    cGrp.latestAddedAt = item.book.addedAt || 0;
                }
            } else {
                remainingAnalyzed.push(item);
            }
        }

        // 2. Klasörden manuel çıkarılmamış (!unfoldered) kitaplar için otomatik seri/yazar eşleşmesi
        const autoCandidates = remainingAnalyzed.filter(item => !item.book.unfoldered);
        const unfolderedSingles = remainingAnalyzed.filter(item => !!item.book.unfoldered);

        const numericCounts = new Map();
        for (const item of autoCandidates) {
            const nKey = `${item.normAuthor}::${item.normNumeric}`;
            numericCounts.set(nKey, (numericCounts.get(nKey) || 0) + 1);
        }

        const autoGroupsMap = new Map();
        for (const item of autoCandidates) {
            const nKey = `${item.normAuthor}::${item.normNumeric}`;
            const useNumeric = (numericCounts.get(nKey) || 0) >= 2;
            const groupNormTitle = useNumeric ? item.normNumeric : item.normExplicit;
            const displayBaseTitle = useNumeric ? item.info.numericBaseTitle : item.info.explicitBaseTitle;
            const groupKey = `auto::${item.normAuthor}::${groupNormTitle}`;

            // Eğer aynı başlık ve yazara sahip manuel bir klasör zaten varsa doğrudan oraya dahil et
            let matchedCustom = null;
            for (const cGrp of customMap.values()) {
                if (this.normalizeTextKey(cGrp.title) === groupNormTitle &&
                    (this.normalizeTextKey(cGrp.author) === item.normAuthor || cGrp.entries.length === 0)) {
                    matchedCustom = cGrp;
                    break;
                }
            }
            if (matchedCustom) {
                matchedCustom.entries.push(item);
                if ((item.book.addedAt || 0) > matchedCustom.latestAddedAt) {
                    matchedCustom.latestAddedAt = item.book.addedAt || 0;
                }
                continue;
            }

            if (!autoGroupsMap.has(groupKey)) {
                autoGroupsMap.set(groupKey, {
                    key: groupKey,
                    isCustom: false,
                    customFolderId: null,
                    title: displayBaseTitle,
                    author: (item.book.author || 'Unknown Author').trim(),
                    coverUrl: null,
                    inBookshelf: false,
                    entries: [],
                    latestAddedAt: 0
                });
            }
            const grp = autoGroupsMap.get(groupKey);
            grp.entries.push(item);
            if ((item.book.addedAt || 0) > grp.latestAddedAt) {
                grp.latestAddedAt = item.book.addedAt || 0;
            }
            if (displayBaseTitle.length > 0 && displayBaseTitle.length < grp.title.length) {
                grp.title = displayBaseTitle;
            }
        }

        const libraryItems = [];

        // Manuel klasörleri listeye ekle (0 veya 1 kitap olsa bile manuel oluşturulduğu için klasör olarak gözükür)
        for (const [cKey, cGrp] of customMap.entries()) {
            const sortedBooks = this.sortAndDecorateFolderEntries(cGrp.entries);
            const isAllFav = sortedBooks.length > 0 && sortedBooks.every(b => !!b.isFavorite);
            const folderGroup = {
                key: cKey,
                isCustom: true,
                customFolderId: cGrp.customFolderId,
                title: cGrp.title,
                author: cGrp.author,
                coverUrl: cGrp.coverUrl || null,
                inBookshelf: !!(cGrp.inBookshelf || isAllFav),
                books: sortedBooks,
                latestAddedAt: cGrp.latestAddedAt
            };
            this.currentFolderGroups.set(cKey, folderGroup);
            libraryItems.push({
                isFolder: true,
                latestAddedAt: cGrp.latestAddedAt,
                group: folderGroup
            });
        }

        // Otomatik grupları listeye ekle (2+ kitap varsa klasör, 1 kitap varsa tekil kart)
        for (const [groupKey, grp] of autoGroupsMap.entries()) {
            if (grp.entries.length >= 2) {
                const sortedBooks = this.sortAndDecorateFolderEntries(grp.entries);
                const isAllFav = sortedBooks.length > 0 && sortedBooks.every(b => !!b.isFavorite);
                const folderGroup = {
                    key: groupKey,
                    isCustom: false,
                    customFolderId: null,
                    title: grp.title,
                    author: grp.author,
                    coverUrl: null,
                    inBookshelf: isAllFav,
                    books: sortedBooks,
                    latestAddedAt: grp.latestAddedAt
                };
                this.currentFolderGroups.set(groupKey, folderGroup);
                libraryItems.push({
                    isFolder: true,
                    latestAddedAt: grp.latestAddedAt,
                    group: folderGroup
                });
            } else {
                const singleBook = grp.entries[0].book;
                if (singleBook.volumeLabel && singleBook.volumeLabel.trim()) {
                    const rawLbl = singleBook.volumeLabel.trim();
                    singleBook._computedVolumeBadge = /^\d+$/.test(rawLbl) ? `Vol. ${rawLbl}` : rawLbl;
                }
                libraryItems.push({
                    isFolder: false,
                    latestAddedAt: singleBook.addedAt || 0,
                    book: singleBook
                });
            }
        }

        // Klasörden manuel çıkarılmış tekil kitapları ekle
        for (const item of unfolderedSingles) {
            const singleBook = item.book;
            if (singleBook.volumeLabel && singleBook.volumeLabel.trim()) {
                const rawLbl = singleBook.volumeLabel.trim();
                singleBook._computedVolumeBadge = /^\d+$/.test(rawLbl) ? `Vol. ${rawLbl}` : rawLbl;
            }
            libraryItems.push({
                isFolder: false,
                latestAddedAt: singleBook.addedAt || 0,
                book: singleBook
            });
        }

        libraryItems.sort((a, b) => b.latestAddedAt - a.latestAddedAt);
        return libraryItems;
    },

    // Bir klasörün içindeki tüm kitapların toplam istatistiklerini (cilt, bölüm, sayfa, kelime) hesaplar
    computeGroupStats(group) {
        const books = (group && Array.isArray(group.books)) ? group.books : [];
        let totalChapters = 0;
        let totalPages = 0;
        let totalWords = 0;

        for (const b of books) {
            const bChapters = Number(b.chapterCount) || 0;
            const bPages = Number(b.pageCount) || Number(b.totalPages) || 0;
            const bWords = Number(b.wordCount) || 0;

            totalChapters += bChapters > 0 ? bChapters : 1;
            totalPages += bPages > 0 ? bPages : (bWords > 0 ? Math.max(1, Math.ceil(bWords / 250)) : 0);
            totalWords += bWords > 0 ? bWords : 0;
        }

        return {
            volumes: books.length,
            chapters: totalChapters,
            pages: totalPages,
            words: totalWords,
            volumeCount: books.length,
            chapterCount: totalChapters,
            pageCount: totalPages,
            wordCount: totalWords
        };
    },

    // Önceden yüklenmiş ve henüz kelime/sayfa/bölüm istatistiği hesaplanmamış kitapları arka planda analiz edip kaydeder
    async ensureMissingBooksStats() {
        if (this._isCalculatingMissingStats) return;
        this._attemptedStatsIds = this._attemptedStatsIds || new Set();
        const missing = (this.allLoadedBooks || []).filter(b =>
            b && b.id && !this._attemptedStatsIds.has(b.id) && !(Number(b.wordCount) > 0)
        );
        if (missing.length === 0) return;

        this._isCalculatingMissingStats = true;
        let anyUpdated = false;
        try {
            for (const b of missing) {
                this._attemptedStatsIds.add(b.id);
                const fullBook = await booksDb.getBook(b.id);
                if (fullBook && fullBook.file && typeof utils !== 'undefined' && utils.computeBookStats) {
                    const stats = await utils.computeBookStats(fullBook.file, fullBook.type);
                    const wCount = Number(stats.wordCount) || 0;
                    const pCount = Number(stats.pageCount) || (wCount > 0 ? Math.max(1, Math.ceil(wCount / 250)) : 0);
                    const cCount = Number(stats.chapterCount) || 1;
                    await booksDb.updateBookMetadata(b.id, {
                        wordCount: wCount,
                        pageCount: pCount,
                        chapterCount: cCount,
                        statsCalculated: wCount > 0
                    });
                    b.wordCount = wCount;
                    b.pageCount = pCount;
                    b.chapterCount = cCount;
                    b.statsCalculated = wCount > 0;
                    anyUpdated = true;
                }
            }
        } catch (e) {
            console.warn("Error calculating missing book stats:", e);
        } finally {
            this._isCalculatingMissingStats = false;
        }

        if (anyUpdated) {
            await this.loadLibrary();
        }
    },

    // Bir klasörün bir bütün olarak Kitaplık (Profil -> Kitaplık) sekmesine taşınıp taşınmadığını döndürür
    isFolderInBookshelf(group) {
        if (!group) return false;
        if (group.inBookshelf) return true;
        if (Array.isArray(group.books) && group.books.length > 0 && group.books.every(b => !!b.isFavorite)) {
            return true;
        }
        return false;
    },

    // Klasörü bir bütün olarak Kitaplık'a taşır veya Kitaplık'tan tekrar Ana Sayfaya geri alır
    async toggleFolderBookshelf(group) {
        if (!group) return;
        const currentlyInBookshelf = this.isFolderInBookshelf(group);
        const nextState = !currentlyInBookshelf;

        const folderId = await this.ensureCustomFolderForGroup(group);
        const targetFolder = this.customFolders.find(cf => cf.id === folderId);
        if (targetFolder) {
            targetFolder.inBookshelf = nextState;
            await settingsDb.set('customFolders', this.customFolders);
        }

        if (Array.isArray(group.books)) {
            for (const b of group.books) {
                await booksDb.updateBookMetadata(b.id, {
                    isFavorite: nextState,
                    folderId: folderId,
                    unfoldered: false
                });
            }
        }

        await this.loadLibrary();
    },

    // Ortak Kapak Fotoğrafı Seçiciyi Tetikler
    triggerCoverImagePicker(onImageReady) {
        const input = document.getElementById('cover-image-input');
        if (!input) return;
        this._onCoverImageSelected = onImageReady;
        input.value = '';
        input.click();
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
        const customFolders = await settingsDb.get('customFolders', []) || [];
        this.allLoadedBooks = books;
        this.customFolders = Array.isArray(customFolders) ? customFolders : [];

        if (books.length === 0 && this.customFolders.length === 0) {
            if (emptyState) {
                emptyState.style.display = 'flex';
                const pEl = emptyState.querySelector('p');
                if (pEl) pEl.textContent = 'Your library is empty. Upload your first EPUB or PDF book from here!';
            }
            if (statsSummary) statsSummary.textContent = "No books in library.";
            this.closeFolderModal();
        } else {
            // Okuma istatistikleri
            const totalBooks = books.length;
            const readBooks = books.filter(b => b.progressPercent >= 95).length;
            const readingBooks = books.filter(b => b.progressPercent > 0 && b.progressPercent < 95).length;
            
            if (statsSummary) {
                statsSummary.textContent = `${totalBooks} books loaded. (${readingBooks} reading, ${readBooks} finished)`;
            }

            const libraryItems = this.groupBooksIntoLibraryItems(books, this.customFolders);

            // Ana Sayfa (Kitaplık'a taşınmamış olanlar) ve Kitaplık (Profil -> Kitaplık'a taşınmış olanlar) ayrımı:
            // Kitaplık'a eklenen klasörler ve kitaplar Ana Sayfada durmaz, yalnızca Kitaplık'ta kalır!
            const homeItems = [];
            const bookshelfItems = [];

            libraryItems.forEach(item => {
                if (item.isFolder) {
                    if (this.isFolderInBookshelf(item.group)) {
                        bookshelfItems.push(item);
                    } else {
                        homeItems.push(item);
                    }
                } else {
                    if (item.book && item.book.isFavorite) {
                        bookshelfItems.push(item);
                    } else {
                        homeItems.push(item);
                    }
                }
            });

            if (homeItems.length === 0) {
                if (emptyState) {
                    emptyState.style.display = 'flex';
                    const pEl = emptyState.querySelector('p');
                    if (pEl) {
                        pEl.textContent = bookshelfItems.length > 0
                            ? 'All your folders and books have been moved to the Library (Profile) tab.'
                            : 'Your library is empty. Upload your first EPUB or PDF book from here!';
                    }
                }
            } else {
                if (emptyState) emptyState.style.display = 'none';
                homeItems.forEach(item => {
                    if (item.isFolder) {
                        const folderCard = this.createFolderCard(item.group);
                        if (bookGrid) bookGrid.appendChild(folderCard);
                    } else {
                        const card = this.createBookCard(item.book);
                        if (bookGrid) bookGrid.appendChild(card);
                    }
                });
            }

            // Profil -> Kitaplık sekmesine hem klasörlü serileri (bir bütün klasör olarak) hem de tekil kitapları ekle
            if (profileBookGrid) {
                if (bookshelfItems.length === 0) {
                    profileBookGrid.innerHTML = `
                        <div class="empty-state" style="display: flex; grid-column: 1 / -1; padding: 30px 10px;">
                            <i data-lucide="star" class="empty-icon" style="width: 48px; height: 48px;"></i>
                            <p>Your Library is empty. Tap the star icon on the top right of folders or books on the Home page to move them here.</p>
                        </div>
                    `;
                } else {
                    bookshelfItems.forEach(item => {
                        if (item.isFolder) {
                            const folderCard = this.createFolderCard(item.group);
                            profileBookGrid.appendChild(folderCard);
                        } else {
                            const profileCard = this.createBookCard(item.book);
                            profileBookGrid.appendChild(profileCard);
                        }
                    });
                }
            }

            // Açık bir klasör modalı varsa içeriğini canlı güncelle
            if (this.activeFolderKey) {
                const updatedGroup = this.currentFolderGroups.get(this.activeFolderKey);
                if (updatedGroup && (updatedGroup.isCustom || updatedGroup.books.length > 0)) {
                    this.renderFolderModalContent(updatedGroup);
                } else {
                    this.closeFolderModal();
                }
            }

            // Açık bir klasör yönetim modalı varsa onu da canlı güncelle
            if (this.managingFolderKey) {
                const updatedManageGroup = this.currentFolderGroups.get(this.managingFolderKey);
                if (updatedManageGroup && (updatedManageGroup.isCustom || updatedManageGroup.books.length > 0)) {
                    this.renderFolderManageModalContent(updatedManageGroup);
                } else {
                    this.closeFolderManageModal();
                }
            }
        }

        // Yeni eklenen ikonları çizdir
        lucide.createIcons();
        this.updateDatabaseStatsUI();

        // Eksik kelime/sayfa/bölüm istatistiği olan kitapları arka planda hesapla
        this.ensureMissingBooksStats();
    },

    // Kitap Silme İşlemi
    async deleteBook(id, title, force = false) {
        if (force || confirm(`Are you sure you want to delete "${title}"?`)) {
            const success = await booksDb.deleteBook(id);
            if (success) {
                const panel = document.getElementById('book-details-panel');
                if (panel) panel.classList.remove('open');
                
                await this.loadLibrary();
            } else {
                alert("Could not delete the book.");
            }
        }
    },

    // Klasörü ve İçindeki Ciltleri Silme İşlemi
    async deleteFolderGroup(group) {
        if (!group) return;
        const bookCount = group.books ? group.books.length : 0;
        const msg = bookCount > 0
            ? `Are you sure you want to delete the folder "${group.title}" and all ${bookCount} books inside it?`
            : `Are you sure you want to delete the folder "${group.title}"?`;

        if (confirm(msg)) {
            if (group.books && group.books.length > 0) {
                for (const b of group.books) {
                    await booksDb.deleteBook(b.id);
                }
            }
            if (group.isCustom && group.customFolderId) {
                this.customFolders = this.customFolders.filter(cf => cf.id !== group.customFolderId);
                await settingsDb.set('customFolders', this.customFolders);
            }
            if (this.activeFolderKey === group.key) {
                this.closeFolderModal();
            }
            if (this.managingFolderKey === group.key) {
                this.closeFolderManageModal();
            }
            await this.loadLibrary();
        }
    },

    // Manuel Klasör Oluşturma Modalını Aç / Kaydet
    openCreateFolderModal() {
        const modal = document.getElementById('create-folder-modal');
        const titleInput = document.getElementById('create-folder-title-input');
        const authorInput = document.getElementById('create-folder-author-input');
        const coverPreview = document.getElementById('create-folder-cover-preview');
        const listEl = document.getElementById('create-folder-books-list');

        this.pendingCreateFolderCover = null;
        if (titleInput) titleInput.value = '';
        if (authorInput) authorInput.value = '';
        if (coverPreview) {
            coverPreview.src = utils.generateGradientPlaceholder('Folder', 'EndlessR');
        }

        if (listEl) {
            listEl.innerHTML = '';
            if (this.allLoadedBooks.length === 0) {
                listEl.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 12px;">No books in library yet. You can create an empty folder and add books later.</p>`;
            } else {
                this.allLoadedBooks.forEach(book => {
                    const row = document.createElement('label');
                    row.className = 'folder-book-row';
                    row.style.cursor = 'pointer';

                    let thumbSrc = '';
                    if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                        thumbSrc = book.coverUrl;
                    } else {
                        thumbSrc = utils.generateGradientPlaceholder(book.title, book.author);
                    }

                    row.innerHTML = `
                        <div class="folder-book-row-main">
                            <input type="checkbox" class="create-folder-book-checkbox" value="${book.id}" style="width: 18px; height: 18px; accent-color: var(--accent-color); flex-shrink: 0;">
                            <img src="${thumbSrc}" alt="${book.title}" class="folder-book-thumb">
                            <div class="folder-book-row-info">
                                <span class="folder-book-row-title">${book.title}</span>
                                <span class="folder-book-row-sub">${book.author}</span>
                            </div>
                        </div>
                    `;

                    const cb = row.querySelector('.create-folder-book-checkbox');
                    if (cb) {
                        cb.addEventListener('change', () => {
                            if (cb.checked) {
                                if (titleInput && !titleInput.value.trim()) {
                                    const info = this.extractVolumeAndBaseTitle(book);
                                    titleInput.value = info.explicitBaseTitle || book.title;
                                }
                                if (authorInput && !authorInput.value.trim()) {
                                    authorInput.value = book.author || '';
                                }
                                if (!this.pendingCreateFolderCover && coverPreview && book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                                    coverPreview.src = book.coverUrl;
                                }
                            }
                        });
                    }

                    listEl.appendChild(row);
                });
            }
        }

        if (modal) {
            modal.style.display = 'flex';
            if (titleInput) titleInput.focus();
        }
        lucide.createIcons();
    },

    closeCreateFolderModal() {
        const modal = document.getElementById('create-folder-modal');
        if (modal) modal.style.display = 'none';
    },

    async saveCreateFolder() {
        const titleInput = document.getElementById('create-folder-title-input');
        const authorInput = document.getElementById('create-folder-author-input');
        const title = (titleInput ? titleInput.value : '').trim();
        const author = (authorInput ? authorInput.value : '').trim() || 'Folder';

        if (!title) {
            alert('Please enter a folder name.');
            return;
        }

        const newFolder = {
            id: 'folder_' + utils.generateId(),
            title,
            author,
            coverUrl: this.pendingCreateFolderCover || null,
            inBookshelf: false,
            createdAt: Date.now()
        };

        this.customFolders.push(newFolder);
        await settingsDb.set('customFolders', this.customFolders);

        const checkedBoxes = document.querySelectorAll('.create-folder-book-checkbox:checked');
        for (const cb of checkedBoxes) {
            const bookId = cb.value;
            await booksDb.updateBookMetadata(bookId, {
                folderId: newFolder.id,
                unfoldered: false
            });
        }

        this.closeCreateFolderModal();
        await this.loadLibrary();
    },

    // Klasör Görünümü Modalını Aç / Kapat
    openFolderModal(groupKey) {
        const group = this.currentFolderGroups.get(groupKey);
        if (!group) return;

        this.activeFolderKey = groupKey;
        this.renderFolderModalContent(group);

        const modal = document.getElementById('folder-view-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
        lucide.createIcons();
    },

    renderFolderModalContent(group) {
        const titleEl = document.getElementById('folder-modal-title');
        const subtitleEl = document.getElementById('folder-modal-subtitle');
        const gridEl = document.getElementById('folder-book-grid');
        const btnBookshelf = document.getElementById('btn-toggle-folder-bookshelf');
        const elStatVolumes = document.getElementById('folder-stat-volumes');
        const elStatChapters = document.getElementById('folder-stat-chapters');
        const elStatPages = document.getElementById('folder-stat-pages');
        const elStatWords = document.getElementById('folder-stat-words');

        const bookCount = Array.isArray(group.books) ? group.books.length : 0;
        const volWord = bookCount === 1 ? 'Volume' : 'Volumes';

        if (titleEl) titleEl.textContent = group.title;
        if (subtitleEl) subtitleEl.textContent = `${group.author} • ${bookCount} ${volWord}`;

        // Klasör İstatistiklerini Güncelle (Volumes her zaman klasör içerisindeki kitap adedi kadardır)
        const stats = this.computeGroupStats(group);
        if (elStatVolumes) elStatVolumes.textContent = utils.formatNumber(bookCount);
        if (elStatChapters) elStatChapters.textContent = utils.formatNumber(stats.chapters);
        if (elStatPages) elStatPages.textContent = utils.formatNumber(stats.pages);
        if (elStatWords) elStatWords.textContent = utils.formatNumber(stats.words);

        // Klasörü Kitaplığa Ekle/Çıkar Yıldız Butonu Görünümü
        if (btnBookshelf) {
            const inBookshelf = this.isFolderInBookshelf(group);
            btnBookshelf.style.color = inBookshelf ? '#f59e0b' : 'var(--text-secondary)';
            btnBookshelf.style.borderColor = inBookshelf ? 'rgba(245, 158, 11, 0.5)' : 'var(--border-color)';
            btnBookshelf.title = inBookshelf ? 'Remove from Library (Move to Home)' : 'Add Entire Folder to Library';
            btnBookshelf.innerHTML = `<i data-lucide="star" style="width: 15px; height: 15px; ${inBookshelf ? 'fill: #f59e0b;' : ''}"></i>`;
        }

        if (gridEl) {
            gridEl.innerHTML = '';
            if (group.books.length === 0) {
                gridEl.innerHTML = `
                    <div class="empty-state" style="display: flex; grid-column: 1 / -1; padding: 30px 10px;">
                        <i data-lucide="folder-open" class="empty-icon" style="width: 48px; height: 48px;"></i>
                        <p>There are no books in this folder yet. Tap the edit (pencil) button on the top right to add books.</p>
                    </div>
                `;
            } else {
                group.books.forEach(book => {
                    const card = this.createBookCard(book, { inFolder: true, seriesBaseTitle: group.title });
                    gridEl.appendChild(card);
                });
            }
        }
        lucide.createIcons();
    },

    closeFolderModal() {
        this.activeFolderKey = null;
        const modal = document.getElementById('folder-view-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    },

    // Klasör İçi Kitapları Yatay Barlarla Yönetme / Düzenleme Modalı
    openFolderManageModal(groupKey) {
        const group = this.currentFolderGroups.get(groupKey);
        if (!group) return;

        this.managingFolderKey = groupKey;
        this.renderFolderManageModalContent(group);

        const modal = document.getElementById('folder-manage-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
        lucide.createIcons();
    },

    closeFolderManageModal() {
        this.managingFolderKey = null;
        const modal = document.getElementById('folder-manage-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    },

    renderFolderManageModalContent(group) {
        const titleInput = document.getElementById('manage-folder-title-input');
        const authorInput = document.getElementById('manage-folder-author-input');
        const coverPreview = document.getElementById('manage-folder-cover-preview');
        const booksListEl = document.getElementById('folder-manage-books-list');
        const addSectionEl = document.getElementById('folder-manage-add-section');
        const availableListEl = document.getElementById('folder-manage-available-list');

        if (titleInput) titleInput.value = group.title || '';
        if (authorInput) authorInput.value = group.author || '';

        if (coverPreview) {
            if (group.coverUrl && !group.coverUrl.startsWith('blob:')) {
                coverPreview.src = group.coverUrl;
            } else {
                const coverBook = group.books.find(b => b.coverUrl && !b.coverUrl.startsWith('blob:')) || group.books[0];
                if (coverBook && coverBook.coverUrl && !coverBook.coverUrl.startsWith('blob:')) {
                    coverPreview.src = coverBook.coverUrl;
                } else {
                    coverPreview.src = utils.generateGradientPlaceholder(group.title, group.author);
                }
            }
        }

        if (booksListEl) {
            booksListEl.innerHTML = '';
            if (group.books.length === 0) {
                booksListEl.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 10px;">No books in this folder yet.</p>`;
            } else {
                group.books.forEach(book => {
                    const row = document.createElement('div');
                    row.className = 'folder-book-row';

                    let thumbSrc = '';
                    if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                        thumbSrc = book.coverUrl;
                    } else {
                        thumbSrc = utils.generateGradientPlaceholder(book.title, book.author);
                    }

                    const badgeLabel = book._computedVolumeBadge || '';
                    const bChapters = Number(book.chapterCount) || 1;
                    const bPages = Number(book.pageCount) || 0;
                    const bWords = Number(book.wordCount) || 0;
                    const statsSnippet = bWords > 0
                        ? ` • ${bChapters} Ch • ${utils.formatNumber(bPages)} Pages • ${utils.formatNumber(bWords)} Words`
                        : '';

                    row.innerHTML = `
                        <div class="folder-book-row-main">
                            <img src="${thumbSrc}" alt="${book.title}" class="folder-book-thumb" title="Click to change volume cover" style="cursor: pointer;">
                            <div class="folder-book-row-info">
                                <span class="folder-book-row-title">${book.title}</span>
                                <span class="folder-book-row-sub">${badgeLabel ? badgeLabel + ' • ' : ''}${book.author}${statsSnippet}</span>
                            </div>
                            <div class="folder-book-row-actions">
                                <button type="button" class="row-action-btn btn-row-cover" title="Change Volume Cover">
                                    <i data-lucide="image" style="width: 14px; height: 14px;"></i>
                                </button>
                                <button type="button" class="row-action-btn btn-row-edit" title="Edit Title / Author / Volume">
                                    <i data-lucide="edit-2" style="width: 14px; height: 14px;"></i>
                                </button>
                                <button type="button" class="row-action-btn btn-row-unfolder" title="Remove from Folder">
                                    <i data-lucide="folder-minus" style="width: 14px; height: 14px;"></i>
                                </button>
                                <button type="button" class="row-action-btn btn-row-delete" title="Delete Book">
                                    <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
                                </button>
                            </div>
                        </div>
                        <div class="folder-book-inline-edit">
                            <div class="input-group">
                                <label>Book Title</label>
                                <input type="text" class="inline-book-title" value="${(book.title || '').replace(/"/g, '&quot;')}" placeholder="Book title...">
                            </div>
                            <div class="folder-book-inline-grid">
                                <div class="input-group">
                                    <label>Author</label>
                                    <input type="text" class="inline-book-author" value="${(book.author || '').replace(/"/g, '&quot;')}" placeholder="Author...">
                                </div>
                                <div class="input-group">
                                    <label>Volume Label</label>
                                    <input type="text" class="inline-book-volume" value="${(book.volumeLabel || badgeLabel || '').replace(/"/g, '&quot;')}" placeholder="e.g. Vol. 1">
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button type="button" class="action-btn btn-inline-cover" style="padding: 8px; font-size: 12px; flex: 1; background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; gap: 6px;">
                                    <i data-lucide="image" style="width: 14px; height: 14px;"></i> Change Cover
                                </button>
                                <button type="button" class="action-btn btn-inline-save" style="padding: 8px; font-size: 12px; flex: 1;">
                                    Save Changes
                                </button>
                            </div>
                        </div>
                    `;

                    const handleVolumeCoverPick = () => {
                        this.triggerCoverImagePicker(async (dataUrl) => {
                            await booksDb.updateBookMetadata(book.id, { coverUrl: dataUrl });
                            await this.loadLibrary();
                        });
                    };

                    const thumbEl = row.querySelector('.folder-book-thumb');
                    if (thumbEl) thumbEl.onclick = handleVolumeCoverPick;
                    const btnRowCover = row.querySelector('.btn-row-cover');
                    if (btnRowCover) btnRowCover.onclick = handleVolumeCoverPick;
                    const btnInlineCover = row.querySelector('.btn-inline-cover');
                    if (btnInlineCover) btnInlineCover.onclick = handleVolumeCoverPick;

                    const btnRowEdit = row.querySelector('.btn-row-edit');
                    const inlineEditBox = row.querySelector('.folder-book-inline-edit');
                    if (btnRowEdit && inlineEditBox) {
                        btnRowEdit.onclick = () => {
                            const isOpen = inlineEditBox.classList.toggle('open');
                            btnRowEdit.classList.toggle('active', isOpen);
                        };
                    }

                    const btnInlineSave = row.querySelector('.btn-inline-save');
                    if (btnInlineSave) {
                        btnInlineSave.onclick = async () => {
                            const newBookTitle = row.querySelector('.inline-book-title').value.trim();
                            const newBookAuthor = row.querySelector('.inline-book-author').value.trim() || 'Unknown Author';
                            const newBookVolume = row.querySelector('.inline-book-volume').value.trim();
                            if (!newBookTitle) {
                                alert('Book title cannot be empty.');
                                return;
                            }
                            let targetFolderId = book.folderId;
                            if (group.isCustom && group.customFolderId) {
                                targetFolderId = group.customFolderId;
                            } else if (!group.isCustom) {
                                const ensuredId = await this.ensureCustomFolderForGroup(group);
                                targetFolderId = ensuredId;
                            }
                            await booksDb.updateBookMetadata(book.id, {
                                title: newBookTitle,
                                author: newBookAuthor,
                                volumeLabel: newBookVolume,
                                folderId: targetFolderId,
                                unfoldered: false
                            });
                            await this.loadLibrary();
                        };
                    }

                    const btnRowUnfolder = row.querySelector('.btn-row-unfolder');
                    if (btnRowUnfolder) {
                        btnRowUnfolder.onclick = async () => {
                            await booksDb.updateBookMetadata(book.id, {
                                folderId: null,
                                unfoldered: true,
                                isFavorite: false
                            });
                            await this.loadLibrary();
                        };
                    }

                    const btnRowDelete = row.querySelector('.btn-row-delete');
                    if (btnRowDelete) {
                        btnRowDelete.onclick = async () => {
                            if (confirm(`Are you sure you want to permanently delete "${book.title}"?`)) {
                                await booksDb.deleteBook(book.id);
                                await this.loadLibrary();
                            }
                        };
                    }

                    booksListEl.appendChild(row);
                });
            }
        }

        // Bu klasörde olmayan diğer kitapları "Klasöre Ekle" satırları olarak listele
        if (addSectionEl && availableListEl) {
            const inFolderIds = new Set(group.books.map(b => b.id));
            const outsideBooks = this.allLoadedBooks.filter(b => !inFolderIds.has(b.id));

            if (outsideBooks.length === 0) {
                addSectionEl.style.display = 'none';
            } else {
                addSectionEl.style.display = 'flex';
                availableListEl.innerHTML = '';

                outsideBooks.forEach(book => {
                    const row = document.createElement('div');
                    row.className = 'folder-book-row';

                    let thumbSrc = '';
                    if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                        thumbSrc = book.coverUrl;
                    } else {
                        thumbSrc = utils.generateGradientPlaceholder(book.title, book.author);
                    }

                    row.innerHTML = `
                        <div class="folder-book-row-main">
                            <img src="${thumbSrc}" alt="${book.title}" class="folder-book-thumb">
                            <div class="folder-book-row-info">
                                <span class="folder-book-row-title">${book.title}</span>
                                <span class="folder-book-row-sub">${book.author}</span>
                            </div>
                            <div class="folder-book-row-actions">
                                <button type="button" class="row-action-btn btn-row-add" title="Add to This Folder">
                                    <i data-lucide="plus" style="width: 13px; height: 13px;"></i> Add
                                </button>
                            </div>
                        </div>
                    `;

                    const btnAdd = row.querySelector('.btn-row-add');
                    if (btnAdd) {
                        btnAdd.onclick = async () => {
                            let targetFolderId = group.customFolderId;
                            if (!group.isCustom || !targetFolderId) {
                                targetFolderId = await this.ensureCustomFolderForGroup(group);
                            }
                            const folderInShelf = this.isFolderInBookshelf(group);
                            await booksDb.updateBookMetadata(book.id, {
                                folderId: targetFolderId,
                                unfoldered: false,
                                isFavorite: folderInShelf ? true : book.isFavorite
                            });
                            await this.loadLibrary();
                        };
                    }

                    availableListEl.appendChild(row);
                });
            }
        }

        lucide.createIcons();
    },

    // Otomatik oluşmuş bir klasörü kalıcı manuel klasöre dönüştürür (kitap ekleme / bağımsız isimlendirme için)
    async ensureCustomFolderForGroup(group) {
        if (group.isCustom && group.customFolderId) {
            return group.customFolderId;
        }
        const newFolder = {
            id: 'folder_' + utils.generateId(),
            title: group.title,
            author: group.author,
            coverUrl: group.coverUrl || null,
            inBookshelf: this.isFolderInBookshelf(group),
            createdAt: group.latestAddedAt || Date.now()
        };
        this.customFolders.push(newFolder);
        await settingsDb.set('customFolders', this.customFolders);

        for (const b of group.books) {
            await booksDb.updateBookMetadata(b.id, {
                folderId: newFolder.id,
                unfoldered: false
            });
        }

        if (this.activeFolderKey === group.key) {
            this.activeFolderKey = newFolder.id;
        }
        if (this.managingFolderKey === group.key) {
            this.managingFolderKey = newFolder.id;
        }
        group.isCustom = true;
        group.customFolderId = newFolder.id;
        group.key = newFolder.id;
        return newFolder.id;
    },

    async saveFolderMetaFromManageModal() {
        if (!this.managingFolderKey) return;
        const group = this.currentFolderGroups.get(this.managingFolderKey);
        if (!group) return;

        const titleInput = document.getElementById('manage-folder-title-input');
        const authorInput = document.getElementById('manage-folder-author-input');
        const newTitle = (titleInput ? titleInput.value : '').trim();
        const newAuthor = (authorInput ? authorInput.value : '').trim() || 'Unknown Author';

        if (!newTitle) {
            alert('Folder title cannot be empty.');
            return;
        }

        const folderId = await this.ensureCustomFolderForGroup(group);
        const targetFolder = this.customFolders.find(cf => cf.id === folderId);
        if (targetFolder) {
            targetFolder.title = newTitle;
            targetFolder.author = newAuthor;
            await settingsDb.set('customFolders', this.customFolders);
        }

        await this.loadLibrary();
    },

    // Tekil Kitap Düzenleme Modalını Aç (Ana Sayfadaki veya Klasördeki Kitaplar İçin)
    openEditBookModal(book) {
        if (!book) return;
        this.editingState = {
            mode: 'book',
            book,
            selectedFolderId: book.folderId || null,
            pendingCoverUrl: undefined
        };

        const modal = document.getElementById('edit-book-modal');
        const heading = document.getElementById('edit-book-modal-heading');
        const titleInput = document.getElementById('edit-book-title-input');
        const authorInput = document.getElementById('edit-book-author-input');
        const coverPreview = document.getElementById('edit-book-cover-preview');
        const volumeGroup = document.getElementById('edit-book-volume-group');
        const volumeInput = document.getElementById('edit-book-volume-input');
        const quickWrap = document.getElementById('edit-book-quick-series-wrap');
        const quickList = document.getElementById('edit-book-quick-series-list');

        if (heading) heading.textContent = 'Edit Book Details';
        if (titleInput) titleInput.value = book.title || '';
        if (authorInput) authorInput.value = book.author || '';
        if (coverPreview) {
            if (book.coverUrl && !book.coverUrl.startsWith('blob:')) {
                coverPreview.src = book.coverUrl;
            } else {
                coverPreview.src = utils.generateGradientPlaceholder(book.title, book.author);
            }
        }
        if (volumeGroup) volumeGroup.style.display = 'flex';
        if (volumeInput) {
            volumeInput.value = book.volumeLabel || '';
        }

        // Mevcut klasörleri hızlı klasöre dahil etme çipi olarak göster
        if (quickWrap && quickList) {
            quickList.innerHTML = '';
            const chipItems = [];

            for (const grp of this.currentFolderGroups.values()) {
                chipItems.push({
                    title: grp.title,
                    author: grp.author,
                    isFolder: true,
                    group: grp,
                    count: grp.books.length
                });
            }

            if (chipItems.length > 0) {
                quickWrap.style.display = 'block';
                for (const item of chipItems) {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'quick-series-chip';
                    chip.innerHTML = `<i data-lucide="folder" style="width: 12px; height: 12px;"></i><span>${item.title} (${item.author})</span>`;
                    chip.onclick = async () => {
                        let targetFolderId = item.group.customFolderId;
                        if (!item.group.isCustom || !targetFolderId) {
                            targetFolderId = await this.ensureCustomFolderForGroup(item.group);
                        }
                        const folderInShelf = this.isFolderInBookshelf(item.group);
                        await booksDb.updateBookMetadata(book.id, {
                            folderId: targetFolderId,
                            unfoldered: false,
                            isFavorite: folderInShelf ? true : book.isFavorite
                        });
                        this.closeEditBookModal();
                        await this.loadLibrary();
                    };
                    quickList.appendChild(chip);
                }
            } else {
                quickWrap.style.display = 'none';
            }
        }

        if (modal) {
            modal.style.display = 'flex';
            if (titleInput) titleInput.focus();
        }
        lucide.createIcons();
    },

    closeEditBookModal() {
        this.editingState = null;
        const modal = document.getElementById('edit-book-modal');
        if (modal) modal.style.display = 'none';
    },

    async saveBookEdit() {
        if (!this.editingState || this.editingState.mode !== 'book') return;

        const titleInput = document.getElementById('edit-book-title-input');
        const authorInput = document.getElementById('edit-book-author-input');
        const volumeInput = document.getElementById('edit-book-volume-input');

        const newTitle = (titleInput ? titleInput.value : '').trim();
        const newAuthor = (authorInput ? authorInput.value : '').trim() || 'Unknown Author';
        const newVolume = (volumeInput ? volumeInput.value : '').trim();

        if (!newTitle) {
            alert('Please enter a valid book title.');
            return;
        }

        const book = this.editingState.book;
        const titleOrAuthorChanged = (newTitle !== book.title) || (newAuthor !== book.author);

        const updates = {
            title: newTitle,
            author: newAuthor,
            volumeLabel: newVolume,
            // Başlık veya yazar manuel değiştirildiyse otomatik klasörlemeye tekrar izin ver
            unfoldered: titleOrAuthorChanged ? false : book.unfoldered
        };
        if (this.editingState.pendingCoverUrl !== undefined) {
            updates.coverUrl = this.editingState.pendingCoverUrl;
        }

        await booksDb.updateBookMetadata(book.id, updates);

        this.closeEditBookModal();
        await this.loadLibrary();
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
                recentWordsList.innerHTML = '<p style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 10px 0;">No saved words yet.</p>';
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
            const dateStr = new Date(item.addedAt).toLocaleDateString('en-US', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            });

            card.innerHTML = `
                <div class="word-header">
                    <span class="word-title">${item.word}</span>
                    <button class="btn-delete-word" title="Remove from Dictionary" onclick="app.deleteWord('${item.id}')">
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
        this.updateDatabaseStatsUI();
    },

    // Kelime Silme İşlemi
    async deleteWord(id) {
        const success = await wordsDb.deleteWord(id);
        if (success) {
            this.loadWords(document.getElementById('search-words').value);
        }
    },

    // Uygulama Genel Temasını Değiştir (Kitap içi temalarla senkronize)
    async setAppTheme(themeName, syncReader = true) {
        const normalized = themeName === 'light' ? 'light' : 'dark';
        this.currentTheme = normalized;
        try { localStorage.setItem('endlessr_app_theme', normalized); } catch (e) {}

        const isReaderActive = document.body.classList.contains('reader-active');
        document.body.className = '';
        document.body.classList.add(`theme-${normalized}`);
        if (isReaderActive) {
            document.body.classList.add('reader-active');
        }

        // Ana sayfadaki Ay / Güneş tema butonunun ikonunu anında güncelle
        const btnHomeTheme = document.getElementById('btn-home-theme-toggle');
        if (btnHomeTheme) {
            const iconName = normalized === 'dark' ? 'sun' : 'moon';
            btnHomeTheme.innerHTML = `<i data-lucide="${iconName}" style="width: 17px; height: 17px;"></i>`;
            btnHomeTheme.title = normalized === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
            if (typeof lucide !== 'undefined') {
                lucide.createIcons({ node: btnHomeTheme });
            }
        }

        // Ayarlar ekranındaki butonların aktifliğini güncelle
        const themeButtons = document.querySelectorAll('#view-settings .theme-btn');
        themeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(normalized)) {
                btn.classList.add('active');
            }
        });

        // Kitap içi tema ve renk moduyla senkronize et (Önce senkron bellek/localStorage, sonra IndexedDB)
        const lightThemes = ['light', 'sepia', 'warm', 'ocean', 'rose', 'forest'];
        if (syncReader) {
            let targetReaderTheme = normalized;
            try {
                const lastLocalKey = normalized === 'light' ? 'endlessr_last_light_theme' : 'endlessr_last_dark_theme';
                const rememberedLocal = localStorage.getItem(lastLocalKey);
                if (rememberedLocal) {
                    const isValid = normalized === 'light'
                        ? lightThemes.includes(rememberedLocal)
                        : !lightThemes.includes(rememberedLocal);
                    if (isValid) targetReaderTheme = rememberedLocal;
                }
                localStorage.setItem('endlessr_reader_color_mode', normalized);
                localStorage.setItem('endlessr_reader_theme', targetReaderTheme);
            } catch (e) {}

            if (typeof reader !== 'undefined') {
                reader.settings.colorMode = normalized;
                reader.settings.theme = targetReaderTheme;
                const colors = reader.getThemeColors(targetReaderTheme);
                try { sessionStorage.setItem('endlessr_reader_bg', colors.bg); } catch (e) {}

                const btnLight = document.getElementById('btn-webtheme-light');
                const btnDark = document.getElementById('btn-webtheme-dark');
                if (btnLight && btnDark) {
                    btnLight.classList.toggle('active', normalized === 'light');
                    btnDark.classList.toggle('active', normalized === 'dark');
                }
                reader.updateReaderThemeUI(normalized);

                const readerView = document.getElementById('view-reader');
                if (readerView && (readerView.style.display === 'flex' || document.body.classList.contains('reader-active'))) {
                    await reader.setReaderTheme(targetReaderTheme, false);
                }
            }

            await settingsDb.set('readerColorMode', normalized);
            await settingsDb.set('readerTheme', targetReaderTheme);
        }

        await settingsDb.set('appTheme', normalized);
    },

    async toggleAppTheme() {
        const isCurrentlyLight = document.body.classList.contains('theme-light');
        const nextTheme = isCurrentlyLight ? 'dark' : 'light';
        await this.setAppTheme(nextTheme, true);
    },

    // 5. Dosya Yükleme ve İşleme Mekanizması
    async handleFileUpload(file) {
        if (!file) return;

        // Dosya türü kontrolü
        const fileExt = file.name.split('.').pop().toLowerCase();
        if (fileExt !== 'epub' && fileExt !== 'pdf') {
            alert("Only .epub or .pdf files can be uploaded.");
            return;
        }

        // Yükleme ekranı simülasyonu
        const bookGrid = document.getElementById('book-grid');
        const emptyState = document.getElementById('library-empty');
        if (emptyState) emptyState.style.display = 'none';
        
        bookGrid.innerHTML = `
            <div class="loader-spinner" style="padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; grid-column: span 2;">
                <i data-lucide="loader-2" class="upload-icon spin-icon" style="width: 32px; height: 32px; color: var(--accent-color);"></i>
                <p style="font-size: 13px; color: var(--text-secondary); text-align: center;">Parsing book and saving to database, please wait...</p>
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

                const cleanFileName = file.name.replace(/\.[^/.]+$/, "");

                // Kitap veritabanı objesini oluştur
                const newBook = {
                    id: utils.generateId(),
                    title: metadata.title || cleanFileName,
                    originalFileName: cleanFileName,
                    author: metadata.author || "Unknown Author",
                    coverUrl: metadata.coverUrl,
                    type: fileExt,
                    file: arrayBuffer, // ArrayBuffer doğrudan IndexedDB'de binary saklanır
                    wordCount: Number(metadata.wordCount) || 0,
                    pageCount: Number(metadata.pageCount) || 0,
                    chapterCount: Number(metadata.chapterCount) || 1,
                    statsCalculated: true,
                    progressPercent: 0,
                    lastLocation: null,
                    addedAt: Date.now(),
                    lastReadAt: 0
                };

                await booksDb.saveBook(newBook);
                
                // Başarı mesajı ve yenileme
                alert("Book uploaded.");
                await this.loadLibrary();
            };

            reader.onerror = () => {
                throw new Error("An error occurred while reading the file.");
            };

            reader.readAsArrayBuffer(file);

        } catch (err) {
            console.error("Upload Error:", err);
            alert("Could not upload file.");
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
                const folderModal = document.getElementById('folder-view-modal');
                if (folderModal && folderModal.style.display === 'flex') {
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

        // Manuel Klasör Oluşturma Butonu Tıklaması
        const btnCreateFolder = document.getElementById('btn-home-create-folder');
        if (btnCreateFolder) {
            btnCreateFolder.addEventListener('click', () => {
                this.openCreateFolderModal();
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

        // Kapak Fotoğrafı Seçici Input Dinleyicisi
        const coverImageInput = document.getElementById('cover-image-input');
        if (coverImageInput) {
            coverImageInput.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const file = e.target.files[0];
                    const dataUrl = await utils.processUploadedCoverImage(file);
                    if (dataUrl && typeof this._onCoverImageSelected === 'function') {
                        await this._onCoverImageSelected(dataUrl);
                    }
                    this._onCoverImageSelected = null;
                    e.target.value = '';
                }
            });
        }

        // Tekil Kitap Başlığı Düzenleme Modalı Dinleyicileri
        const btnCloseEditBookModal = document.getElementById('btn-close-edit-book-modal');
        if (btnCloseEditBookModal) {
            btnCloseEditBookModal.addEventListener('click', () => {
                this.closeEditBookModal();
            });
        }
        const editBookModalOverlay = document.getElementById('edit-book-modal');
        if (editBookModalOverlay) {
            editBookModalOverlay.addEventListener('click', (e) => {
                if (e.target === editBookModalOverlay) {
                    this.closeEditBookModal();
                }
            });
        }
        const btnChangeBookCover = document.getElementById('btn-change-book-cover');
        if (btnChangeBookCover) {
            btnChangeBookCover.addEventListener('click', () => {
                this.triggerCoverImagePicker((dataUrl) => {
                    if (this.editingState) {
                        this.editingState.pendingCoverUrl = dataUrl;
                    }
                    const preview = document.getElementById('edit-book-cover-preview');
                    if (preview) preview.src = dataUrl;
                });
            });
        }
        const btnResetBookCover = document.getElementById('btn-reset-book-cover');
        if (btnResetBookCover) {
            btnResetBookCover.addEventListener('click', () => {
                if (this.editingState && this.editingState.book) {
                    this.editingState.pendingCoverUrl = null;
                    const preview = document.getElementById('edit-book-cover-preview');
                    if (preview) {
                        preview.src = utils.generateGradientPlaceholder(this.editingState.book.title, this.editingState.book.author);
                    }
                }
            });
        }
        const btnSaveBookEdit = document.getElementById('btn-save-book-edit');
        if (btnSaveBookEdit) {
            btnSaveBookEdit.addEventListener('click', () => {
                this.saveBookEdit();
            });
        }

        // Manuel Klasör Oluşturma Modalı Dinleyicileri
        const btnCloseCreateFolderModal = document.getElementById('btn-close-create-folder-modal');
        if (btnCloseCreateFolderModal) {
            btnCloseCreateFolderModal.addEventListener('click', () => {
                this.closeCreateFolderModal();
            });
        }
        const createFolderModalOverlay = document.getElementById('create-folder-modal');
        if (createFolderModalOverlay) {
            createFolderModalOverlay.addEventListener('click', (e) => {
                if (e.target === createFolderModalOverlay) {
                    this.closeCreateFolderModal();
                }
            });
        }
        const btnPickCreateFolderCover = document.getElementById('btn-pick-create-folder-cover');
        if (btnPickCreateFolderCover) {
            btnPickCreateFolderCover.addEventListener('click', () => {
                this.triggerCoverImagePicker((dataUrl) => {
                    this.pendingCreateFolderCover = dataUrl;
                    const preview = document.getElementById('create-folder-cover-preview');
                    if (preview) preview.src = dataUrl;
                });
            });
        }
        const btnSaveCreateFolder = document.getElementById('btn-save-create-folder');
        if (btnSaveCreateFolder) {
            btnSaveCreateFolder.addEventListener('click', () => {
                this.saveCreateFolder();
            });
        }

        // Klasör Görünümü Modalı Dinleyicileri
        const btnCloseFolderModal = document.getElementById('btn-close-folder-modal');
        if (btnCloseFolderModal) {
            btnCloseFolderModal.addEventListener('click', () => {
                this.closeFolderModal();
            });
        }
        const folderModalOverlay = document.getElementById('folder-view-modal');
        if (folderModalOverlay) {
            folderModalOverlay.addEventListener('click', (e) => {
                if (e.target === folderModalOverlay) {
                    this.closeFolderModal();
                }
            });
        }
        const btnToggleFolderBookshelf = document.getElementById('btn-toggle-folder-bookshelf');
        if (btnToggleFolderBookshelf) {
            btnToggleFolderBookshelf.addEventListener('click', async () => {
                if (this.activeFolderKey) {
                    const group = this.currentFolderGroups.get(this.activeFolderKey);
                    if (group) {
                        await this.toggleFolderBookshelf(group);
                    }
                }
            });
        }
        const btnEditFolderMeta = document.getElementById('btn-edit-folder-meta');
        if (btnEditFolderMeta) {
            btnEditFolderMeta.addEventListener('click', () => {
                if (this.activeFolderKey) {
                    this.openFolderManageModal(this.activeFolderKey);
                }
            });
        }

        // Klasör İçi Yatay Barlarla Kitap Yönetimi Modalı Dinleyicileri
        const btnCloseFolderManageModal = document.getElementById('btn-close-folder-manage-modal');
        if (btnCloseFolderManageModal) {
            btnCloseFolderManageModal.addEventListener('click', () => {
                this.closeFolderManageModal();
            });
        }
        const folderManageModalOverlay = document.getElementById('folder-manage-modal');
        if (folderManageModalOverlay) {
            folderManageModalOverlay.addEventListener('click', (e) => {
                if (e.target === folderManageModalOverlay) {
                    this.closeFolderManageModal();
                }
            });
        }
        const btnChangeFolderCover = document.getElementById('btn-change-folder-cover');
        if (btnChangeFolderCover) {
            btnChangeFolderCover.addEventListener('click', () => {
                if (!this.managingFolderKey) return;
                const group = this.currentFolderGroups.get(this.managingFolderKey);
                if (!group) return;
                this.triggerCoverImagePicker(async (dataUrl) => {
                    const folderId = await this.ensureCustomFolderForGroup(group);
                    const targetFolder = this.customFolders.find(cf => cf.id === folderId);
                    if (targetFolder) {
                        targetFolder.coverUrl = dataUrl;
                        await settingsDb.set('customFolders', this.customFolders);
                        await this.loadLibrary();
                    }
                });
            });
        }
        const btnResetFolderCover = document.getElementById('btn-reset-folder-cover');
        if (btnResetFolderCover) {
            btnResetFolderCover.addEventListener('click', async () => {
                if (!this.managingFolderKey) return;
                const group = this.currentFolderGroups.get(this.managingFolderKey);
                if (!group) return;
                const folderId = await this.ensureCustomFolderForGroup(group);
                const targetFolder = this.customFolders.find(cf => cf.id === folderId);
                if (targetFolder) {
                    targetFolder.coverUrl = null;
                    await settingsDb.set('customFolders', this.customFolders);
                    await this.loadLibrary();
                }
            });
        }
        const btnSaveFolderMeta = document.getElementById('btn-save-folder-meta');
        if (btnSaveFolderMeta) {
            btnSaveFolderMeta.addEventListener('click', () => {
                this.saveFolderMetaFromManageModal();
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
                    alert("Please fill in the required fields.");
                    return;
                }

                const newWord = {
                    word: word,
                    meaning: meaning,
                    context: context,
                    bookTitle: "Manually Added",
                    bookId: "manual",
                    addedAt: Date.now()
                };

                const success = await wordsDb.saveWord(newWord);
                if (success) {
                    const modal = document.getElementById('add-word-modal');
                    if (modal) modal.style.display = 'none';
                    await this.loadWords();
                } else {
                    alert("Could not save word.");
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
        
        // Sürükleme çizgisi (aşağı ok): açık sekme içeriğini daraltıp yalnızca sekme butonlarını bırakır
        document.getElementById('panel-drag-handle').addEventListener('click', () => {
            reader.collapsePanelTabs();
        });

        // Panel İçi Tab (Sekme) Geçişleri: seçilen sekme yukarı doğru genişler, aynı sekmeye tekrar basınca daralır
        document.querySelectorAll('.panel-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTabPaneId = e.currentTarget.getAttribute('data-tab');
                reader.togglePanelTab(targetTabPaneId);
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
                if (confirm(`Are you sure you want to permanently delete "${bookTitle}" from your library?`)) {
                    const success = await booksDb.deleteBook(bookId);
                    if (success) {
                        reader.closeReader();
                        app.loadLibrary();
                    } else {
                        alert("Could not delete the book.");
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

        // Sayfa Biçimlendirme (Smart Reformat) Butonu (Görünüm Tabı)
        const btnSmartReformat = document.getElementById('btn-smart-reformat');
        if (btnSmartReformat) {
            btnSmartReformat.addEventListener('click', () => {
                reader.toggleSmartReformat();
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
                    const chapterLabel = hasToc ? reader.numberedChapters[idx].label : `Chapter ${idx + 1}`;
                    const percent = Math.round(((idx + 1) / total) * 100);
                    
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = hasToc
                        ? `Chapter ${idx + 1}: ${chapterLabel} (${idx + 1} / ${total})`
                        : `Chapter ${idx + 1} / ${total}`;
                    const chIndicator = document.getElementById('panel-chapter-indicator');
                    if (chIndicator) {
                        chIndicator.textContent = `Chapter ${idx + 1} / ${total} (${percent}%)`;
                    }
                } else if (reader.currentBookType === 'pdf' && reader.pdfDocument) {
                    const percent = Math.round((val / reader.pdfTotalPages) * 100);
                    document.getElementById('reader-progress-percent').textContent = percent + '%';
                    document.getElementById('reader-progress-label').textContent = `Page ${val} / ${reader.pdfTotalPages}`;
                    const chIndicator = document.getElementById('panel-chapter-indicator');
                    if (chIndicator) {
                        chIndicator.textContent = `Page ${val} / ${reader.pdfTotalPages} (${percent}%)`;
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
        // Popover üzerine basıldığında kitaptaki aktif seçimin (ve 2 kenar noktasının) kaybolmasını önle
        const translatePopoverEl = document.getElementById('translate-popover');
        if (translatePopoverEl) {
            translatePopoverEl.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
        }

        // Kapat Düğmesi
        document.getElementById('btn-close-popover').addEventListener('click', () => {
            reader.hidePopover(true);
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

        // Web'de Arama Tuşu
        const btnWebSearch = document.getElementById('btn-web-search');
        if (btnWebSearch) {
            btnWebSearch.addEventListener('click', () => {
                reader.searchSelectedOnWeb();
            });
        }

        // Tümünü Seç Tuşu
        const btnSelectAll = document.getElementById('btn-select-all');
        if (btnSelectAll) {
            btnSelectAll.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                reader.selectAllFromPopover();
            });
        }

        // Ayarlar Ekranı Veritabanı Yedekleme / Geri Yükleme Dinleyicileri
        const btnExportFullBackup = document.getElementById('btn-export-full-backup');
        if (btnExportFullBackup) {
            btnExportFullBackup.addEventListener('click', () => {
                this.exportAppBackup(true);
            });
        }

        const btnExportLightBackup = document.getElementById('btn-export-light-backup');
        if (btnExportLightBackup) {
            btnExportLightBackup.addEventListener('click', () => {
                this.exportAppBackup(false);
            });
        }

        const btnImportBackup = document.getElementById('btn-import-backup');
        const inputImportBackup = document.getElementById('input-import-backup');
        if (btnImportBackup && inputImportBackup) {
            btnImportBackup.addEventListener('click', () => {
                inputImportBackup.value = '';
                inputImportBackup.click();
            });
            inputImportBackup.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) {
                    this.importAppBackup(file);
                }
            });
        }

        // Sayfada boş bir yere tıklandığında popover ve kontrol panelini kapat
        document.addEventListener('mousedown', (e) => {
            const popover = document.getElementById('translate-popover');
            const panel = document.getElementById('reader-options-panel');
            
            // Eğer tıklanan yer popover değilse ve seçim alanı değilse kapat
            if (popover.style.display === 'flex' && 
                !popover.contains(e.target) && 
                !e.target.closest('#btn-reader-toc') &&
                !e.target.closest('.side-panel')) {
                reader.hidePopover(false);
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
                    alert("Please fill in the fields.");
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
                    alert("Could not save replacement.");
                }
            });
        }

        // Okuyucu ekranında tarayıcının (Google Chrome) kendi "Kopyala / Tümünü Seç / Web Arama"
        // menüsünün çıkmasını engelle; yalnızca uygulamanın kendi çeviri penceresi görünsün
        window.addEventListener('contextmenu', (e) => {
            if (document.body.classList.contains('reader-active') ||
                (e.target && e.target.closest && (e.target.closest('#view-reader') || e.target.closest('#translate-popover')))) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }, { capture: true, passive: false });

        // PDF Seçimi için global seçim değişikliğini dinle (2 kenar noktasını koruyarak)
        document.addEventListener('selectionchange', () => {
            if (reader.currentBookType !== 'pdf') return;
            const selection = window.getSelection();
            const selectedText = selection ? selection.toString().trim() : '';
            if (selectedText.length > 0 && selectedText.length < 2000 && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const container = range.commonAncestorContainer;
                const pdfViewer = document.getElementById('pdf-viewer');
                if (pdfViewer && pdfViewer.contains(container)) {
                    reader.scheduleProcessSelection(window, document, 300);
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

    // 7A. Klasör Kartı Oluşturma (Çoklu Ciltli Seriler veya Manuel Klasörler İçin)
    createFolderCard(group) {
        const card = document.createElement('div');
        card.className = 'book-card folder-card glass';

        // Kapak için önce klasörün özel kapağını, yoksa ilk cildin kapağını kullan
        let coverHtml = '';
        if (group.coverUrl && !group.coverUrl.startsWith('blob:')) {
            coverHtml = `<img src="${group.coverUrl}" alt="${group.title}" class="book-cover" loading="lazy">`;
        } else {
            const coverBook = group.books.find(b => b.coverUrl && !b.coverUrl.startsWith('blob:')) || group.books[0];
            if (coverBook && coverBook.coverUrl && !coverBook.coverUrl.startsWith('blob:')) {
                coverHtml = `<img src="${coverBook.coverUrl}" alt="${group.title}" class="book-cover" loading="lazy">`;
            } else {
                const placeholder = utils.generateGradientPlaceholder(group.title, group.author);
                coverHtml = `<img src="${placeholder}" alt="${group.title}" class="book-cover" loading="lazy">`;
            }
        }

        const totalVolumes = group.books.length;
        const volWord = totalVolumes === 1 ? 'Volume' : 'Volumes';
        const avgProgress = totalVolumes > 0
            ? Math.round(group.books.reduce((acc, b) => acc + (b.progressPercent || 0), 0) / totalVolumes)
            : 0;
        const completedCount = group.books.filter(b => (b.progressPercent || 0) >= 95).length;
        const inBookshelf = this.isFolderInBookshelf(group);
        const stats = this.computeGroupStats(group);
        const statsText = stats.words > 0
            ? `${utils.formatNumber(stats.chapters)} Ch • ${utils.formatNumber(stats.pages)} Pages • ${utils.formatNumber(stats.words)} Words`
            : `${totalVolumes} ${volWord}`;

        card.innerHTML = `
            <button class="btn-delete-book" title="Delete Folder">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn-edit-book" title="Edit Folder, Covers & Books" style="right: 40px;">
                <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn-favorite-book" title="${inBookshelf ? 'Remove from Library (Move to Home)' : 'Add Entire Folder to Library'}" style="position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 3; color: ${inBookshelf ? '#f59e0b' : '#d1d5db'}; padding: 0;">
                <i data-lucide="star" style="width: 14px; height: 14px; ${inBookshelf ? 'fill: #f59e0b;' : ''}"></i>
            </button>
            <div class="folder-stack-wrapper">
                <div class="folder-stack-layer layer-back"></div>
                <div class="folder-stack-layer layer-mid"></div>
                <div class="book-cover-container">
                    ${coverHtml}
                    <div class="folder-count-badge">
                        <i data-lucide="folder"></i>
                        <span>${totalVolumes} ${volWord}</span>
                    </div>
                </div>
            </div>
            <div class="book-info">
                <h4 class="book-title" title="${group.title}">${group.title}</h4>
                <span class="book-author">${group.author}</span>
                <span class="folder-card-stats" style="font-size: 10px; color: var(--text-muted); display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${statsText}">${statsText}</span>
            </div>
            <div class="book-progress">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${avgProgress}%"></div>
                </div>
                <span class="progress-text">${completedCount}/${totalVolumes} volumes read (${avgProgress}%)</span>
            </div>
        `;

        const btnDelete = card.querySelector('.btn-delete-book');
        if (btnDelete) {
            btnDelete.onclick = (e) => {
                e.stopPropagation();
                this.deleteFolderGroup(group);
            };
        }

        const btnEdit = card.querySelector('.btn-edit-book');
        if (btnEdit) {
            btnEdit.onclick = (e) => {
                e.stopPropagation();
                this.openFolderManageModal(group.key);
            };
        }

        const btnFav = card.querySelector('.btn-favorite-book');
        if (btnFav) {
            btnFav.onclick = async (e) => {
                e.stopPropagation();
                await this.toggleFolderBookshelf(group);
            };
        }

        card.onclick = () => {
            if (this.isLibraryDeleteMode) {
                this.deleteFolderGroup(group);
                return;
            }
            this.openFolderModal(group.key);
        };

        return card;
    },

    // 7B. Tekil Kitap Kartı Oluşturma
    createBookCard(book, options = {}) {
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
        const volumeBadgeHtml = book._computedVolumeBadge
            ? `<span class="volume-badge">${book._computedVolumeBadge}</span>`
            : '';

        // Klasör içindeyken başlık seri adıyla birebir aynıysa "Cilt X • Başlık" şeklinde net göster
        let displayTitle = book.title;
        if (options.inFolder && book._computedVolumeBadge) {
            const normBookTitle = this.normalizeTextKey(book.title);
            const normSeriesTitle = this.normalizeTextKey(options.seriesBaseTitle || '');
            if (normBookTitle === normSeriesTitle) {
                displayTitle = `${book._computedVolumeBadge} • ${book.title}`;
            }
        }

        // Klasör içerisindeyken cilt kapağını/bilgisini tek tıkla değiştirebilmek için sağ üstte kalem butonu göster
        const topButtonsHtml = options.inFolder ? `
            <button class="btn-edit-book" title="Edit Volume Cover / Details" style="right: 6px;">
                <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
        ` : `
            <button class="btn-delete-book" title="Delete Book">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn-edit-book" title="Edit Book Cover / Title">
                <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn-favorite-book" title="${isFav ? 'Remove from Library (Move to Home)' : 'Add to Library'}" style="position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 3; color: ${isFav ? '#f59e0b' : '#d1d5db'}; padding: 0;">
                <i data-lucide="star" style="width: 14px; height: 14px; ${isFav ? 'fill: #f59e0b;' : ''}"></i>
            </button>
        `;

        const bWords = Number(book.wordCount) || 0;
        const bPages = Number(book.pageCount) || 0;
        const bookStatsHtml = bWords > 0
            ? `<span style="font-size: 10px; color: var(--text-muted); display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${utils.formatNumber(bPages)} Pages • ${utils.formatNumber(bWords)} Words</span>`
            : '';

        card.innerHTML = `
            ${topButtonsHtml}
            <div class="book-cover-container">
                ${coverHtml}
                <span class="book-badge badge-${book.type}">${book.type}</span>
                ${volumeBadgeHtml}
            </div>
            <div class="book-info">
                <h4 class="book-title" title="${displayTitle}">${displayTitle}</h4>
                <span class="book-author">${book.author}</span>
                ${bookStatsHtml}
            </div>
            <div class="book-progress">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${book.progressPercent}%"></div>
                </div>
                <span class="progress-text">${book.progressPercent}% completed</span>
            </div>
        `;

        const btnEdit = card.querySelector('.btn-edit-book');
        if (btnEdit) {
            btnEdit.onclick = (e) => {
                e.stopPropagation();
                this.openEditBookModal(book);
            };
        }

        if (!options.inFolder) {
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
                    e.stopPropagation();
                    book.isFavorite = !book.isFavorite;
                    await booksDb.updateBookMetadata(book.id, { isFavorite: book.isFavorite });
                    await this.loadLibrary();
                };
            }
        }

        card.onclick = () => {
            if (this.isLibraryDeleteMode && !options.inFolder) {
                if (confirm(`Do you want to delete "${book.title}"?`)) {
                    this.deleteBook(book.id, book.title, true);
                }
                return;
            }
            // Klasör içinden bir kitaba basıldığında klasör modalını kapat ve kitabı aç
            if (options.inFolder) {
                this.closeFolderModal();
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
                    <p>No replaced words or phrases yet.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        for (const item of list) {
            let bookTitle = "All Books (Global)";
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
                    <button class="btn-delete-word" title="Delete Replacement" onclick="event.stopPropagation(); app.deleteReplacement('${item.id}')" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; transition: color 0.2s;">
                        <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
                    </button>
                </div>
            `;
            listContainer.appendChild(card);
        }
        lucide.createIcons();
        this.updateDatabaseStatsUI();
    },

    async deleteReplacement(id) {
        if (confirm("Are you sure you want to delete this replacement? The text in the book will revert to its original form.")) {
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
                alert("Could not delete replacement.");
            }
        }
    },

    // 8.5 Veritabanı İstatistikleri ve Yedekleme / Geri Yükleme İşlemleri
    async updateDatabaseStatsUI() {
        try {
            const elBooks = document.getElementById('db-stat-books');
            const elFolders = document.getElementById('db-stat-folders');
            const elWords = document.getElementById('db-stat-words');
            const elReplacements = document.getElementById('db-stat-replacements');

            if (!elBooks && !elFolders && !elWords && !elReplacements) return;

            const books = await booksDb.getAllBooks();
            const customFolders = (await settingsDb.get('customFolders', [])) || [];
            const words = await wordsDb.getAllWords();
            const replacements = await replacementsDb.getAllReplacements();

            const libraryItems = this.groupBooksIntoLibraryItems(
                books,
                Array.isArray(customFolders) ? customFolders : []
            );
            const folderCount = libraryItems.filter(item => item.isFolder).length;

            if (elBooks) elBooks.textContent = `${books.length} Books`;
            if (elFolders) elFolders.textContent = `${folderCount} Folders`;
            if (elWords) elWords.textContent = `${words.length} Words`;
            if (elReplacements) elReplacements.textContent = `${replacements.length} Replacements`;
        } catch (err) {
            console.warn("Could not update database stats:", err);
        }
    },

    async exportAppBackup(includeFiles = true) {
        const statusBox = document.getElementById('backup-status-box');
        const statusText = document.getElementById('backup-status-text');
        const progressBar = document.getElementById('backup-progress-bar');

        if (statusBox) statusBox.style.display = 'block';
        if (statusText) statusText.textContent = 'Preparing backup...';
        if (progressBar) progressBar.style.width = '5%';

        try {
            const { blob, bookCount, wordCount, replacementCount } = await backupDb.exportDatabaseBlob(includeFiles, (percent, msg) => {
                if (statusText && msg) statusText.textContent = msg;
                if (progressBar && typeof percent === 'number') progressBar.style.width = `${percent}%`;
            });

            const url = URL.createObjectURL(blob);
            const dateStr = new Date().toISOString().slice(0, 10);
            const fileName = `endlessr-database-backup-${dateStr}.json`;

            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                if (a.parentNode) a.parentNode.removeChild(a);
            }, 1000);
            // Mobil tarayıcı indirme yöneticisinin dosyayı tamamlaması için URL'yi 60 saniye açık tut
            setTimeout(() => URL.revokeObjectURL(url), 60000);

            if (statusText) {
                statusText.textContent = `Backup downloaded (${bookCount} books, ${wordCount} words, ${replacementCount} replacements)`;
            }
            if (progressBar) progressBar.style.width = '100%';
            setTimeout(() => {
                if (statusBox) statusBox.style.display = 'none';
            }, 5000);
        } catch (err) {
            console.error("Backup error:", err);
            if (statusText) statusText.textContent = 'Error: ' + (err.message || 'Could not create backup.');
            alert("An error occurred while creating the database backup: " + (err.message || err));
        }
    },

    async importAppBackup(file) {
        if (!file) return;
        const confirmRestore = confirm(
            `Do you want to restore the database backup from "${file.name}"?\n\n` +
            `Books, reading progress, folders, dictionary words, text replacements, and settings will be restored.`
        );
        if (!confirmRestore) return;

        const statusBox = document.getElementById('backup-status-box');
        const statusText = document.getElementById('backup-status-text');
        const progressBar = document.getElementById('backup-progress-bar');

        if (statusBox) statusBox.style.display = 'block';
        if (statusText) statusText.textContent = 'Reading backup file...';
        if (progressBar) progressBar.style.width = '5%';

        try {
            const text = await file.text();
            const backupData = JSON.parse(text);

            const stats = await backupDb.importDatabase(backupData, (percent, msg) => {
                if (statusText && msg) statusText.textContent = msg;
                if (progressBar && typeof percent === 'number') progressBar.style.width = `${percent}%`;
            });

            // Temayı ve tüm ekranları gerçek veritabanı fonksiyonlarıyla tazele
            const savedAppTheme = await settingsDb.get('appTheme', 'dark');
            await this.setAppTheme(savedAppTheme, true);

            await this.loadLibrary();
            await this.loadWords();
            await this.loadReplacements();
            await this.updateDatabaseStatsUI();

            if (statusText) {
                statusText.textContent = `Restore complete! (${stats.restoredBooks} books, ${stats.restoredWords} words, ${stats.restoredReplacements} replacements)`;
            }
            if (progressBar) progressBar.style.width = '100%';

            let infoMsg =
                `Database successfully restored!\n\n` +
                `• Books / Progress: ${stats.restoredBooks}\n` +
                `• Dictionary Words: ${stats.restoredWords}\n` +
                `• Text Replacements: ${stats.restoredReplacements}`;

            if (stats.missingFileBooks > 0 && stats.restoredBooks === 0) {
                infoMsg += `\n\nNote: This backup was created without book files. Use "Download Database Backup" to include EPUB/PDF book files.`;
            }

            alert(infoMsg);

            setTimeout(() => {
                if (statusBox) statusBox.style.display = 'none';
            }, 5000);
        } catch (err) {
            console.error("Backup restore error:", err);
            if (statusText) statusText.textContent = 'Error: ' + (err.message || 'Restore failed.');
            alert("An error occurred while restoring the backup file: " + (err.message || err));
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

        const folderManageModal = document.getElementById('folder-manage-modal');
        if (folderManageModal && folderManageModal.style.display === 'flex') {
            this.closeFolderManageModal();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const createFolderModal = document.getElementById('create-folder-modal');
        if (createFolderModal && createFolderModal.style.display === 'flex') {
            this.closeCreateFolderModal();
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const editBookModal = document.getElementById('edit-book-modal');
        if (editBookModal && editBookModal.style.display === 'flex') {
            this.closeEditBookModal();
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
            if (optionsPanel.classList.contains('expanded')) {
                reader.collapsePanelTabs();
            } else {
                reader.closeStylePanel();
            }
            if (isPopState) {
                window.history.pushState({ stackIndex: navHistory.stack.length - 1 }, "");
            }
            return;
        }

        const isReaderCurrentlyOpen = document.getElementById('view-reader').style.display === 'flex' || document.body.classList.contains('reader-active');
        const folderModal = document.getElementById('folder-view-modal');
        if (!isReaderCurrentlyOpen && folderModal && folderModal.style.display === 'flex') {
            this.closeFolderModal();
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
