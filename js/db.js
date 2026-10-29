// ================= INDEXEDDB VERİTABANI YÖNETİMİ (localforage) =================

// localforage kütüphanesinin yüklenip yüklenmediğini kontrol et
if (typeof localforage === 'undefined') {
    console.error("localforage kütüphanesi yüklenemedi. Çevrimdışı veritabanı çalışmayacaktır.");
}

// 1. Ayrı Veritabanı Mağazaları (Store) Tanımla
const db = {
    // Kitapları saklayacağımız veritabanı (Büyük dosyaları saklayabilir)
    books: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "books"
    }),

    // Okurken kaydedilen bilinmeyen kelimeler sözlüğü
    words: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "words"
    }),

    // Uygulama ayarları ve temalar
    settings: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "settings"
    }),

    // Kitap içi metin değiştirme find-replace listesi
    replacements: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "replacements"
    })
};

// 2. Kütüphane Yardımcı Fonksiyonları
const booksDb = {
    // Tüm kitapları listele (Performans için file/blob alanlarını okumayıp sadece metadata alacağız)
    async getAllBooks() {
        try {
            const keys = await db.books.keys();
            const books = [];
            for (const key of keys) {
                const book = await db.books.getItem(key);
                if (book) {
                    // Dosya verisini (file) arayüzde taşımamak için kopyalayıp çıkarıyoruz
                    const { file, ...metadata } = book;
                    books.push(metadata);
                }
            }
            // Eklenme tarihine göre sırala (yeniden eskiye)
            return books.sort((a, b) => b.addedAt - a.addedAt);
        } catch (err) {
            console.error("Kitaplar listelenirken hata oluştu:", err);
            return [];
        }
    },

    // ID'ye göre tek bir kitabı (dosyasıyla birlikte) getir
    async getBook(id) {
        try {
            return await db.books.getItem(id);
        } catch (err) {
            console.error("Kitap getirilirken hata oluştu:", err);
            return null;
        }
    },

    // Yeni kitap kaydet veya güncelle
    async saveBook(book) {
        try {
            await db.books.setItem(book.id, book);
            return true;
        } catch (err) {
            console.error("Kitap kaydedilirken hata oluştu:", err);
            throw err;
        }
    },

    // Kitap sil
    async deleteBook(id) {
        try {
            await db.books.removeItem(id);
            return true;
        } catch (err) {
            console.error("Kitap silinirken hata oluştu:", err);
            return false;
        }
    },

    // Kitap ilerlemesini güncelle
    async updateProgress(id, progressPercent, lastLocation) {
        try {
            const book = await db.books.getItem(id);
            if (book) {
                book.progressPercent = progressPercent;
                book.lastLocation = lastLocation;
                await db.books.setItem(id, book);
                return true;
            }
            return false;
        } catch (err) {
            console.error("İlerleme güncellenirken hata oluştu:", err);
            return false;
        }
    },

    // Kitap başlık, yazar, cilt veya klasör bilgilerini (dosya verisini koruyarak) güncelle
    async updateBookMetadata(id, updates) {
        try {
            const book = await db.books.getItem(id);
            if (!book) return false;
            if (typeof updates.title === 'string') book.title = updates.title.trim();
            if (typeof updates.author === 'string') book.author = updates.author.trim();
            if (updates.volumeLabel !== undefined) book.volumeLabel = updates.volumeLabel.trim();
            if (updates.folderId !== undefined) book.folderId = updates.folderId;
            if (updates.unfoldered !== undefined) book.unfoldered = updates.unfoldered;
            if (updates.isFavorite !== undefined) book.isFavorite = updates.isFavorite;
            await db.books.setItem(id, book);
            return true;
        } catch (err) {
            console.error("Kitap bilgileri güncellenirken hata oluştu:", err);
            return false;
        }
    }
};

// 3. Kelime Sözlüğü (Words) Yardımcı Fonksiyonları
const wordsDb = {
    // Tüm kelimeleri getir
    async getAllWords() {
        try {
            const keys = await db.words.keys();
            const words = [];
            for (const key of keys) {
                const word = await db.words.getItem(key);
                if (word) words.push(word);
            }
            return words.sort((a, b) => b.addedAt - a.addedAt);
        } catch (err) {
            console.error("Kelimeler çekilirken hata oluştu:", err);
            return [];
        }
    },

    // Yeni kelime kaydet
    async saveWord(wordObj) {
        try {
            // Kelimeyi küçük harflere çevirip id olarak kullanalım (tekrarı önlemek için)
            const id = wordObj.word.trim().toLowerCase();
            const existing = await db.words.getItem(id);
            if (existing) {
                // Zaten varsa anlamı veya context'i güncellenebilir
                wordObj.addedAt = Date.now(); // Son eklenme tarihini güncelle
            }
            await db.words.setItem(id, {
                id,
                word: wordObj.word,
                meaning: wordObj.meaning,
                context: wordObj.context || "",
                bookTitle: wordObj.bookTitle || "Bilinmeyen Kaynak",
                bookId: wordObj.bookId || "",
                addedAt: Date.now()
            });
            return true;
        } catch (err) {
            console.error("Kelime kaydedilirken hata:", err);
            return false;
        }
    },

    // Kelime sil
    async deleteWord(id) {
        try {
            await db.words.removeItem(id);
            return true;
        } catch (err) {
            console.error("Kelime silinirken hata:", err);
            return false;
        }
    }
};

// 4. Ayarlar Yardımcı Fonksiyonları
const settingsDb = {
    // Belirli bir ayarı getir
    async get(key, defaultValue = null) {
        try {
            const val = await db.settings.getItem(key);
            return val !== null ? val : defaultValue;
        } catch (err) {
            console.error("Ayar okunurken hata:", err);
            return defaultValue;
        }
    },

    // Ayar kaydet
    async set(key, value) {
        try {
            await db.settings.setItem(key, value);
            return true;
        } catch (err) {
            console.error("Ayar kaydedilirken hata:", err);
            return false;
        }
    }
};

// 5. Kitap İçi Metin Değiştirme (Replacements) Yardımcı Fonksiyonları
const replacementsDb = {
    // Tüm değiştirilen kelime/cümle çiftlerini getir
    async getAllReplacements() {
        try {
            const keys = await db.replacements.keys();
            const list = [];
            for (const key of keys) {
                const item = await db.replacements.getItem(key);
                if (item) list.push(item);
            }
            return list.sort((a, b) => b.addedAt - a.addedAt);
        } catch (err) {
            console.error("Değişiklik listesi yüklenirken hata:", err);
            return [];
        }
    },

    // Yeni değişiklik çifti kaydet veya güncelle
    async saveReplacement(originalText, replacedText, bookId = "") {
        try {
            const id = originalText.trim().toLowerCase();
            await db.replacements.setItem(id, {
                id,
                originalText: originalText.trim(),
                replacedText: replacedText.trim(),
                bookId: bookId, // Belirli bir kitaba bağlı (boş ise global)
                addedAt: Date.now()
            });
            return true;
        } catch (err) {
            console.error("Değişiklik kaydedilirken hata:", err);
            return false;
        }
    },

    // Değişikliği sil
    async deleteReplacement(id) {
        try {
            await db.replacements.removeItem(id);
            return true;
        } catch (err) {
            console.error("Değişiklik silinirken hata:", err);
            return false;
        }
    }
};

// 6. Tam Veritabanı Yedekleme ve Geri Yükleme (Backup & Restore) Yardımcı Fonksiyonları
const backupDb = {
    async bufferToBase64(data) {
        if (!data) return null;
        if (typeof data === 'string') {
            return data.includes(',') ? data.split(',')[1].trim() : data.trim();
        }
        try {
            let blob = null;
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                blob = data;
            } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || (data && typeof data.byteLength === 'number')) {
                blob = new Blob([data], { type: 'application/octet-stream' });
            } else if (data && data.buffer && typeof data.buffer.byteLength === 'number') {
                blob = new Blob([data.buffer], { type: 'application/octet-stream' });
            }

            if (blob && typeof FileReader !== 'undefined') {
                const dataUrl = await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onloadend = () => resolve(fr.result);
                    fr.onerror = () => reject(fr.error);
                    fr.readAsDataURL(blob);
                });
                if (typeof dataUrl === 'string') {
                    const commaIdx = dataUrl.indexOf(',');
                    return commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
                }
            }

            let bytes = null;
            if (data instanceof Uint8Array) {
                bytes = data;
            } else if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            }
            if (!bytes) return null;

            const chunkSize = 0x8000;
            const chunks = [];
            for (let i = 0; i < bytes.length; i += chunkSize) {
                chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
            }
            return btoa(chunks.join(''));
        } catch (err) {
            console.error("Dosya Base64'e dönüştürülürken hata:", err);
            return null;
        }
    },

    async base64ToArrayBuffer(base64) {
        if (!base64 || typeof base64 !== 'string') return null;
        try {
            const cleanBase64 = base64.includes(',') ? base64.split(',')[1].trim() : base64.trim();
            if (!cleanBase64) return null;

            // Hızlı yerel C++ tabanlı data URL çözücü
            try {
                const res = await fetch('data:application/octet-stream;base64,' + cleanBase64);
                if (res.ok) {
                    const ab = await res.arrayBuffer();
                    if (ab && ab.byteLength > 0) return ab;
                }
            } catch (fetchErr) {}

            // Fallback: atob
            const binaryString = atob(cleanBase64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes.buffer;
        } catch (err) {
            console.error("Base64 ArrayBuffer'a dönüştürülürken hata:", err);
            return null;
        }
    },

    // Büyük kitap dosyalarında bellek / string sınırı aşımını önlemek için doğrudan parça parça JSON Blob üretir
    async exportDatabaseBlob(includeFiles = true, onProgress = null) {
        const report = (pct, msg) => {
            if (typeof onProgress === 'function') {
                onProgress(pct, msg);
            }
        };

        report(5, "Veritabanı okunuyor...");

        const blobParts = [];
        blobParts.push(
            `{"app":"EndlessR","version":1,"exportedAt":${Date.now()},"includeFiles":${!!includeFiles},"books":[`
        );

        // 1. Kitapları tek tek okuyup JSON parçası olarak Blob'a ekle
        const bookKeys = await db.books.keys();
        let exportedBookCount = 0;
        for (let i = 0; i < bookKeys.length; i++) {
            const key = bookKeys[i];
            const pct = Math.min(75, 10 + Math.round(((i + 1) / Math.max(1, bookKeys.length)) * 65));
            report(pct, `Kitaplar yedekleniyor (${i + 1} / ${bookKeys.length})...`);

            const book = await db.books.getItem(key);
            if (!book) continue;
            const { file, ...meta } = book;
            const exportedBook = { ...meta };
            if (includeFiles && file) {
                exportedBook.fileBase64 = await this.bufferToBase64(file);
            }
            if (exportedBookCount > 0) {
                blobParts.push(',');
            }
            blobParts.push(JSON.stringify(exportedBook));
            exportedBookCount++;
        }

        report(82, "Sözlük, metin değişimleri ve klasörler hazırlanıyor...");

        // 2. Sözlük kelimeleri
        const words = await wordsDb.getAllWords();

        // 3. Metin değişimleri
        const replacements = await replacementsDb.getAllReplacements();

        // 4. Ayarlar ve manuel klasörler
        const settings = {};
        const settingKeys = await db.settings.keys();
        for (const sKey of settingKeys) {
            settings[sKey] = await db.settings.getItem(sKey);
        }

        // 5. localStorage üzerindeki okuma konumları ve tema tercihleri
        const localStorageData = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const lKey = localStorage.key(i);
                if (lKey && lKey.startsWith('endlessr_')) {
                    localStorageData[lKey] = localStorage.getItem(lKey);
                }
            }
        } catch (e) {}

        blobParts.push(`],"words":${JSON.stringify(words)}`);
        blobParts.push(`,"replacements":${JSON.stringify(replacements)}`);
        blobParts.push(`,"settings":${JSON.stringify(settings)}`);
        blobParts.push(`,"localStorageData":${JSON.stringify(localStorageData)}}`);

        report(95, "Yedek dosyası paketleniyor...");
        const blob = new Blob(blobParts, { type: 'application/json;charset=utf-8' });
        return {
            blob,
            bookCount: exportedBookCount,
            wordCount: words.length,
            replacementCount: replacements.length
        };
    },

    async importDatabase(backupData, onProgress = null) {
        if (!backupData || typeof backupData !== 'object') {
            throw new Error("Geçersiz yedek dosyası formatı.");
        }

        const report = (pct, msg) => {
            if (typeof onProgress === 'function') {
                onProgress(pct, msg);
            }
        };

        let restoredBooks = 0;
        let restoredWords = 0;
        let restoredReplacements = 0;
        let restoredFolders = 0;
        let missingFileBooks = 0;

        // 1. Ayarları ve Manuel Klasörleri Geri Yükle
        if (backupData.settings && typeof backupData.settings === 'object') {
            report(15, "Ayarlar ve klasörler geri yükleniyor...");
            for (const [sKey, sVal] of Object.entries(backupData.settings)) {
                if (sKey === 'customFolders' && Array.isArray(sVal)) {
                    const existingFolders = (await db.settings.getItem('customFolders')) || [];
                    const folderMap = new Map();
                    if (Array.isArray(existingFolders)) {
                        existingFolders.forEach(f => { if (f && f.id) folderMap.set(f.id, f); });
                    }
                    sVal.forEach(f => { if (f && f.id) folderMap.set(f.id, f); });
                    const mergedFolders = Array.from(folderMap.values());
                    await db.settings.setItem('customFolders', mergedFolders);
                    restoredFolders = mergedFolders.length;
                } else {
                    await db.settings.setItem(sKey, sVal);
                }
            }
        }

        // 2. localStorage Verilerini Geri Yükle
        if (backupData.localStorageData && typeof backupData.localStorageData === 'object') {
            try {
                for (const [lKey, lVal] of Object.entries(backupData.localStorageData)) {
                    if (lKey && lKey.startsWith('endlessr_') && typeof lVal === 'string') {
                        localStorage.setItem(lKey, lVal);
                    }
                }
            } catch (e) {}
        }

        // 3. Sözlük Kelimelerini Geri Yükle
        if (Array.isArray(backupData.words)) {
            report(30, `Sözlük kelimeleri yükleniyor (${backupData.words.length})...`);
            for (const w of backupData.words) {
                if (w && w.word) {
                    const id = (w.id || w.word).trim().toLowerCase();
                    await db.words.setItem(id, {
                        ...w,
                        id
                    });
                    restoredWords++;
                }
            }
        }

        // 4. Metin Değişimlerini Geri Yükle
        if (Array.isArray(backupData.replacements)) {
            report(45, `Metin değişimleri yükleniyor (${backupData.replacements.length})...`);
            for (const r of backupData.replacements) {
                if (r && r.originalText && r.replacedText) {
                    const id = (r.id || r.originalText).trim().toLowerCase();
                    await db.replacements.setItem(id, {
                        ...r,
                        id
                    });
                    restoredReplacements++;
                }
            }
        }

        // 5. Kitapları ve İlerlemelerini Geri Yükle
        if (Array.isArray(backupData.books)) {
            const existingBooksMeta = await booksDb.getAllBooks();
            for (let i = 0; i < backupData.books.length; i++) {
                const b = backupData.books[i];
                if (!b || !b.id) continue;
                const pct = Math.min(95, 50 + Math.round(((i + 1) / Math.max(1, backupData.books.length)) * 45));
                report(pct, `Kitaplar geri yükleniyor (${i + 1} / ${backupData.books.length})...`);

                const { fileBase64, ...bookMeta } = b;
                if (fileBase64) {
                    const fileBuffer = await this.base64ToArrayBuffer(fileBase64);
                    if (fileBuffer && fileBuffer.byteLength > 0) {
                        await db.books.setItem(b.id, {
                            ...bookMeta,
                            file: fileBuffer
                        });
                        restoredBooks++;
                        continue;
                    }
                }

                // Eğer yedekte dosya verisi yoksa (eski hızlı yedek), mevcut kütüphanede ID, başlık veya dosya adıyla eşleşen kitabı bul
                let targetBook = await db.books.getItem(b.id);
                if (!targetBook) {
                    const normStr = (s) => (s || '').trim().toLowerCase();
                    const matchedMeta = existingBooksMeta.find(eb => {
                        if (b.originalFileName && eb.originalFileName && normStr(eb.originalFileName) === normStr(b.originalFileName)) {
                            return true;
                        }
                        if (b.title && eb.title && normStr(eb.title) === normStr(b.title)) {
                            return true;
                        }
                        return false;
                    });
                    if (matchedMeta) {
                        targetBook = await db.books.getItem(matchedMeta.id);
                    }
                }

                if (targetBook && targetBook.file) {
                    const targetId = targetBook.id;
                    const updatedBook = {
                        ...targetBook,
                        ...bookMeta,
                        id: targetId,
                        file: targetBook.file
                    };
                    await db.books.setItem(targetId, updatedBook);
                    if (targetId !== b.id && backupData.localStorageData) {
                        try {
                            const oldEpubPos = backupData.localStorageData['endlessr_pos_' + b.id];
                            if (oldEpubPos) localStorage.setItem('endlessr_pos_' + targetId, oldEpubPos);
                            const oldPdfPos = backupData.localStorageData['endlessr_pdf_pos_' + b.id];
                            if (oldPdfPos) localStorage.setItem('endlessr_pdf_pos_' + targetId, oldPdfPos);
                        } catch (e) {}
                    }
                    restoredBooks++;
                } else {
                    missingFileBooks++;
                }
            }
        }

        return {
            restoredBooks,
            restoredWords,
            restoredReplacements,
            restoredFolders,
            missingFileBooks
        };
    }
};
