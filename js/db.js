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
        try {
            let bytes = null;
            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
                const ab = await data.arrayBuffer();
                bytes = new Uint8Array(ab);
            } else if (typeof data === 'string') {
                return data;
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

    base64ToArrayBuffer(base64) {
        if (!base64 || typeof base64 !== 'string') return null;
        try {
            const binaryString = atob(base64);
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

    async exportDatabase(includeFiles = true, onProgress = null) {
        const result = {
            app: 'EndlessR',
            version: 1,
            exportedAt: Date.now(),
            includeFiles: !!includeFiles,
            books: [],
            words: [],
            replacements: [],
            settings: {},
            localStorageData: {}
        };

        // 1. Kitapları dışa aktar
        const bookKeys = await db.books.keys();
        for (let i = 0; i < bookKeys.length; i++) {
            const key = bookKeys[i];
            if (onProgress) {
                onProgress(`Kitaplar hazırlanıyor (${i + 1} / ${bookKeys.length})...`);
            }
            const book = await db.books.getItem(key);
            if (!book) continue;
            const { file, ...meta } = book;
            const exportedBook = { ...meta };
            if (includeFiles && file) {
                exportedBook.fileBase64 = await this.bufferToBase64(file);
            }
            result.books.push(exportedBook);
        }

        if (onProgress) onProgress("Sözlük, metin değişimleri ve klasörler hazırlanıyor...");

        // 2. Sözlük kelimelerini dışa aktar
        result.words = await wordsDb.getAllWords();

        // 3. Metin değişimlerini dışa aktar
        result.replacements = await replacementsDb.getAllReplacements();

        // 4. Ayarları ve manuel klasörleri dışa aktar
        const settingKeys = await db.settings.keys();
        for (const sKey of settingKeys) {
            result.settings[sKey] = await db.settings.getItem(sKey);
        }

        // 5. localStorage üzerindeki okuma konumlarını ve tema tercihlerini dışa aktar
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const lKey = localStorage.key(i);
                if (lKey && lKey.startsWith('endlessr_')) {
                    result.localStorageData[lKey] = localStorage.getItem(lKey);
                }
            }
        } catch (e) {}

        return result;
    },

    async importDatabase(backupData, onProgress = null) {
        if (!backupData || typeof backupData !== 'object') {
            throw new Error("Geçersiz yedek dosyası formatı.");
        }

        let restoredBooks = 0;
        let restoredWords = 0;
        let restoredReplacements = 0;
        let restoredFolders = 0;

        // 1. Ayarları ve Manuel Klasörleri Geri Yükle
        if (backupData.settings && typeof backupData.settings === 'object') {
            if (onProgress) onProgress("Ayarlar ve klasörler geri yükleniyor...");
            for (const [sKey, sVal] of Object.entries(backupData.settings)) {
                if (sKey === 'customFolders' && Array.isArray(sVal)) {
                    const existingFolders = (await db.settings.getItem('customFolders')) || [];
                    const folderMap = new Map();
                    existingFolders.forEach(f => { if (f && f.id) folderMap.set(f.id, f); });
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
            if (onProgress) onProgress(`Sözlük kelimeleri yükleniyor (${backupData.words.length})...`);
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
            if (onProgress) onProgress(`Metin değişimleri yükleniyor (${backupData.replacements.length})...`);
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
                if (onProgress) {
                    onProgress(`Kitaplar geri yükleniyor (${i + 1} / ${backupData.books.length})...`);
                }

                const { fileBase64, ...bookMeta } = b;
                if (fileBase64) {
                    const fileBuffer = this.base64ToArrayBuffer(fileBase64);
                    if (fileBuffer) {
                        await db.books.setItem(b.id, {
                            ...bookMeta,
                            file: fileBuffer
                        });
                        restoredBooks++;
                        continue;
                    }
                }

                // Dosya verisi içermeyen hızlı yedek ise mevcut kitabı ID veya Başlık+Yazar ile bulup güncelle
                let targetBook = await db.books.getItem(b.id);
                if (!targetBook && b.title) {
                    const matchedMeta = existingBooksMeta.find(eb =>
                        eb.title && eb.title.trim().toLowerCase() === b.title.trim().toLowerCase()
                    );
                    if (matchedMeta) {
                        targetBook = await db.books.getItem(matchedMeta.id);
                    }
                }

                if (targetBook) {
                    const targetId = targetBook.id;
                    const updatedBook = {
                        ...targetBook,
                        ...bookMeta,
                        id: targetId,
                        file: targetBook.file
                    };
                    await db.books.setItem(targetId, updatedBook);
                    // Eğer ID değişmişse okuma konumu kaydını yeni ID'ye de kopyala
                    if (targetId !== b.id && backupData.localStorageData) {
                        try {
                            const oldEpubPos = backupData.localStorageData['endlessr_pos_' + b.id];
                            if (oldEpubPos) localStorage.setItem('endlessr_pos_' + targetId, oldEpubPos);
                            const oldPdfPos = backupData.localStorageData['endlessr_pdf_pos_' + b.id];
                            if (oldPdfPos) localStorage.setItem('endlessr_pdf_pos_' + targetId, oldPdfPos);
                        } catch (e) {}
                    }
                    restoredBooks++;
                }
            }
        }

        return {
            restoredBooks,
            restoredWords,
            restoredReplacements,
            restoredFolders
        };
    }
};
