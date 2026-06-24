// ================= YARDIMCI ARAÇLAR MODÜLÜ (js/utils.js) =================

const utils = {
    // Benzersiz ID oluştur
    generateId() {
        return 'book_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    },

    // Dosya boyutunu okunabilir formata dönüştür
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },

    // Rastgele şık bir gradyan arka planı oluştur (Kapak resmi olmayan kitaplar için)
    generateGradientPlaceholder(title, author) {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 450;
        const ctx = canvas.getContext('2d');

        // Şık gradyan renk çiftleri (Premium tonlar)
        const gradients = [
            ['#4f46e5', '#7c3aed'], // Indigo - Purple
            ['#3b82f6', '#1d4ed8'], // Blue - Deep Blue
            ['#ec4899', '#f43f5e'], // Pink - Rose
            ['#10b981', '#059669'], // Emerald - Green
            ['#f59e0b', '#d97706'], // Amber - Orange
            ['#84cc16', '#65a30d'], // Lime - Green
            ['#14b8a6', '#0f766e'], // Teal - Teal Dark
            ['#06b6d4', '#0891b2']  // Cyan - Cyan Dark
        ];

        // Kitap adına göre tutarlı bir gradyan seç
        const index = Math.abs(this.hashCode(title)) % gradients.length;
        const colorPair = gradients[index];

        const grad = ctx.createLinearGradient(0, 0, 0, 450);
        grad.addColorStop(0, colorPair[0]);
        grad.addColorStop(1, colorPair[1]);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 300, 450);

        // Geometrik süslemeler ekle
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.arc(300, 0, 180, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 450, 130, 0, Math.PI * 2);
        ctx.fill();

        // Kitap Başlığı Yazımı
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Uzun başlıkları bölerek yazdır
        ctx.font = 'bold 22px "Outfit", sans-serif';
        const words = title.split(' ');
        let lines = [];
        let currentLine = words[0] || '';

        for (let i = 1; i < words.length; i++) {
            const width = ctx.measureText(currentLine + " " + words[i]).width;
            if (width < 250) {
                currentLine += " " + words[i];
            } else {
                lines.push(currentLine);
                currentLine = words[i];
            }
        }
        lines.push(currentLine);
        
        // Maksimum 5 satır yazdır
        lines = lines.slice(0, 5);
        let startY = 200 - (lines.length - 1) * 15;
        lines.forEach((line, idx) => {
            ctx.fillText(line, 150, startY + idx * 32);
        });

        // Yazar Adı Yazımı
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = 'medium 14px "Inter", sans-serif';
        const cleanAuthor = author && author !== 'Bilinmeyen Yazar' ? author : 'Kitap Okuyucu';
        ctx.fillText(cleanAuthor.toUpperCase(), 150, 380);

        // Logo Süsü
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = 'bold 12px "Outfit", sans-serif';
        ctx.fillText('ENDLESS R', 150, 420);

        return canvas.toDataURL('image/jpeg');
    },

    // String için hash kodu üret (tutarlı gradyan seçimi için)
    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    },

    // PDF dosyasından metadata ve kapak resmi (İlk Sayfa) çıkarma
    async extractPdfMetadata(arrayBuffer, fileName) {
        try {
            // pdf.js worker yapılandırması
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;
            
            let title = fileName.replace(/\.[^/.]+$/, ""); // Uzantıyı sil
            let author = "Bilinmeyen Yazar";

            // PDF metadata çekmeyi dene
            try {
                const meta = await pdf.getMetadata();
                if (meta && meta.info) {
                    if (meta.info.Title && meta.info.Title.trim()) title = meta.info.Title;
                    if (meta.info.Author && meta.info.Author.trim()) author = meta.info.Author;
                }
            } catch (e) {
                console.warn("PDF metadata alınamadı:", e);
            }

            // İlk sayfayı kapak resmi olarak render et
            let coverUrl = null;
            try {
                const page = await pdf.getPage(1);
                const viewport = page.getViewport({ scale: 0.5 }); // Küçük ölçek yeterli
                
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d');
                
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;

                coverUrl = canvas.toDataURL('image/jpeg', 0.8);
            } catch (e) {
                console.error("PDF sayfa render hatası (Kapak oluşturulamadı):", e);
                coverUrl = this.generateGradientPlaceholder(title, author);
            }

            return {
                title,
                author,
                coverUrl,
                totalPages: pdf.numPages
            };
        } catch (err) {
            console.error("PDF yüklenirken kritik hata:", err);
            throw new Error("PDF dosyası çözümlenemedi.");
        }
    },

    // EPUB dosyasından metadata ve kapak resmi çıkarma
    async extractEpubMetadata(arrayBuffer, fileName) {
        return new Promise(async (resolve, reject) => {
            let book = null;
            try {
                // EpubJS ile kitabı geçici yükle
                book = ePub(arrayBuffer);
                
                await book.opened;
                const metadata = await book.loaded.metadata;
                
                let title = metadata.title || fileName.replace(/\.[^/.]+$/, "");
                let author = metadata.creator || "Bilinmeyen Yazar";
                
                // Kapak görseli alma
                let coverUrl = null;
                try {
                    const coverPath = await book.coverUrl();
                    if (coverPath) {
                        try {
                            const response = await fetch(coverPath);
                            const blob = await response.blob();
                            coverUrl = await new Promise((res, rej) => {
                                const reader = new FileReader();
                                reader.onloadend = () => res(reader.result);
                                reader.onerror = rej;
                                reader.readAsDataURL(blob);
                            });
                        } catch (fetchErr) {
                            console.error("Cover image fetch error, using fallback placeholder:", fetchErr);
                            coverUrl = this.generateGradientPlaceholder(title, author);
                        }
                    } else {
                        coverUrl = this.generateGradientPlaceholder(title, author);
                    }
                } catch (e) {
                    console.warn("EPUB kapak resmi çıkarılamadı:", e);
                    coverUrl = this.generateGradientPlaceholder(title, author);
                }

                // Kitap objesini bellekten boşaltmak için kapat
                if (book) {
                    try { book.destroy(); } catch(d) {}
                }

                resolve({
                    title,
                    author,
                    coverUrl
                });

            } catch (err) {
                console.error("EPUB metadata çıkarım hatası:", err);
                if (book) {
                    try { book.destroy(); } catch(d) {}
                }
                resolve({
                    title: fileName.replace(/\.[^/.]+$/, ""),
                    author: "Bilinmeyen Yazar",
                    coverUrl: this.generateGradientPlaceholder(fileName, "Bilinmeyen Yazar")
                });
            }
        });
    }
};
