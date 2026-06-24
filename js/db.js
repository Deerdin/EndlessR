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

    // Uygulama ayarları, temalar ve API anahtarları
    settings: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "settings"
    }),

    // Kitap içi metin değiştirme find-replace listesi
    replacements: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "replacements"
    }),

    // Çeviri önbelleği (İngilizce paragraf -> Türkçe çeviri)
    translations: localforage.createInstance({
        name: "EndlessR_DB",
        storeName: "translations"
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
                try {
                    const book = await db.books.getItem(key);
                    if (book) {
                        // Dosya verisini (file) arayüzde taşımamak için kopyalayıp çıkarıyoruz
                        const { file, ...metadata } = book;
                        books.push(metadata);
                    }
                } catch (singleBookErr) {
                    console.error(`Kitap (ID: ${key}) veritabanından okunurken hata oluştu, atlanıyor:`, singleBookErr);
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
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
            // Trigger auto-backup for settings (excluding gdrive configuration keys to avoid loops)
            const gdriveKeys = ['gdriveAccessToken', 'gdriveTokenExpiry', 'gdriveLastBackupTime', 'gdriveClientId', 'gdriveAutoSync'];
            if (!gdriveKeys.includes(key) && typeof gdriveService !== 'undefined') {
                gdriveService.scheduleAutoBackup();
            }
            return true;
        } catch (err) {
            console.error("Ayar kaydedilirken hata:", err);
            return false;
        }
    },

    // Tüm API Anahtarlarını getir
    async getApiKeys() {
        return {
            gemini: await this.get('geminiKey', ''),
            openai: await this.get('openaiKey', '')
        };
    },

    // API Anahtarlarını kaydet
    async saveApiKeys(geminiKey, openaiKey) {
        await this.set('geminiKey', geminiKey.trim());
        await this.set('openaiKey', openaiKey.trim());
        return true;
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
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
            if (typeof gdriveService !== 'undefined') gdriveService.scheduleAutoBackup();
            return true;
        } catch (err) {
            console.error("Değişiklik silinirken hata:", err);
            return false;
        }
    }
};

// 6. Çeviri Önbelleği Yardımcı Fonksiyonları
const translationsDb = {
    async getTranslation(originalText) {
        try {
            if (!originalText || !originalText.trim()) return null;
            return await db.translations.getItem(originalText.trim());
        } catch (err) {
            console.error("Önbellekten çeviri okunurken hata:", err);
            return null;
        }
    },
    async saveTranslation(originalText, translatedText) {
        try {
            if (!originalText || !originalText.trim() || !translatedText || !translatedText.trim()) return;
            await db.translations.setItem(originalText.trim(), translatedText.trim());
        } catch (err) {
            console.error("Çeviri önbelleğe kaydedilirken hata:", err);
        }
    }
};
